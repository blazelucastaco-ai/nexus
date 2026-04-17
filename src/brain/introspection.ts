// Introspection — NEXUS's awareness of its own current activity.
//
// The existing SelfAwareness class answers "what are my stats" (version, RAM,
// memory counts). This module answers "what am I doing *right now*, and what
// have I been doing in the last hour?" — the stream-of-consciousness layer.
//
// It's a pure event subscriber: no orchestrator method calls. We watch
// message/tool/task/dream events as they fly past and keep a rolling window.
// Queries are synchronous reads of in-memory state.
//
// Output is consumed in three places:
// 1. System prompt (compact one-liner: "currently: responding to user, 3m into session")
// 2. /whoami Telegram command (full snapshot)
// 3. /thinking Telegram command (LLM-authored self-reflection)

import { events, type Subscription } from '../core/events.js';
import { createLogger } from '../utils/logger.js';
import { inferProjectFromPath } from '../data/projects-repository.js';

const log = createLogger('Introspection');

// ─── Window sizes ────────────────────────────────────────────────────────────

const MAX_RECENT_TOOLS = 20;
const MAX_RECENT_TASKS = 10;
const MAX_RECENT_ERRORS = 5;
const PROJECT_WINDOW_MS = 60 * 60 * 1000; // "Touched in the last hour"

// ─── Types ───────────────────────────────────────────────────────────────────

export type ActivityStatus =
  | 'idle'         // No recent activity
  | 'responding'   // Message in-flight
  | 'task'         // Running a multi-step task
  | 'tool'         // Executing a tool (outside task context)
  | 'dreaming';    // Dream cycle in progress

export interface CurrentActivity {
  status: ActivityStatus;
  /** If `status==='task'`, the title of the currently-running task */
  currentTaskTitle?: string;
  /** If `status==='tool'`, the name of the tool currently executing */
  currentToolName?: string;
  /** Most recently inferred project being worked on */
  currentProject?: string;
  lastEventAt: number;
  /** Seconds since last event — "how idle am I right now?" */
  idleSeconds: number;
}

export interface RecentTool {
  name: string;
  at: number;
  success: boolean;
  durationMs: number;
}

export interface RecentTask {
  title: string;
  at: number;
  success: boolean;
  stepsCompleted: number;
  totalSteps: number;
}

export interface RecentError {
  source: 'tool' | 'task' | 'message';
  message: string;
  at: number;
}

export interface IntrospectionSnapshot {
  activity: CurrentActivity;
  recentTools: RecentTool[];
  recentTasks: RecentTask[];
  recentErrors: RecentError[];
  projectsTouched: string[];
  messagesLastHour: number;
  toolsLastHour: number;
  sessionStartedAt: number;
}

export interface IntrospectionHandle {
  subs: Subscription[];
  getActivity(): CurrentActivity;
  getSnapshot(): IntrospectionSnapshot;
  /** One-line status suitable for system prompt injection */
  getCompactLine(): string;
  /** Multi-line human narrative suitable for /thinking or /whoami */
  getNarrative(): string;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Subscribe Introspection to the event bus. Returns a handle with query
 * methods and subscription handles for clean shutdown.
 */
export function startIntrospection(): IntrospectionHandle {
  const state = {
    status: 'idle' as ActivityStatus,
    currentTaskTitle: undefined as string | undefined,
    currentToolName: undefined as string | undefined,
    currentProject: undefined as string | undefined,
    lastEventAt: Date.now(),
    sessionStartedAt: Date.now(),
    recentTools: [] as RecentTool[],
    recentTasks: [] as RecentTask[],
    recentErrors: [] as RecentError[],
    projectTouches: [] as { project: string; at: number }[],
  };

  const touch = (): void => {
    state.lastEventAt = Date.now();
  };

  const subs: Subscription[] = [];

  // ── Messages ─────────────────────────────────────────────────────────────
  subs.push(events.on('message.received', () => {
    state.status = 'responding';
    touch();
  }));

  subs.push(events.on('message.completed', () => {
    // Only return to idle if we're not mid-task/tool
    if (state.status === 'responding') state.status = 'idle';
    touch();
  }));

  subs.push(events.on('message.failed', (e) => {
    state.recentErrors.unshift({ source: 'message', message: e.error.slice(0, 200), at: Date.now() });
    state.recentErrors = state.recentErrors.slice(0, MAX_RECENT_ERRORS);
    if (state.status === 'responding') state.status = 'idle';
    touch();
  }));

  // ── Tools ────────────────────────────────────────────────────────────────
  subs.push(events.on('tool.executed', (e) => {
    state.recentTools.unshift({
      name: e.toolName,
      at: Date.now(),
      success: e.success,
      durationMs: e.durationMs,
    });
    state.recentTools = state.recentTools.slice(0, MAX_RECENT_TOOLS);

    // Infer project from path-bearing tool params
    const pathArg = (e.params?.path ?? e.params?.cwd ?? e.params?.file_path) as string | undefined;
    if (typeof pathArg === 'string') {
      const inferred = inferProjectFromPath(pathArg);
      if (inferred) {
        state.currentProject = inferred.name;
        state.projectTouches.unshift({ project: inferred.name, at: Date.now() });
      }
    }
    touch();
  }));

  subs.push(events.on('tool.error', (e) => {
    state.recentErrors.unshift({
      source: 'tool',
      message: `${e.toolName}: ${e.error.slice(0, 150)}`,
      at: Date.now(),
    });
    state.recentErrors = state.recentErrors.slice(0, MAX_RECENT_ERRORS);
    touch();
  }));

  // ── Tasks ────────────────────────────────────────────────────────────────
  subs.push(events.on('task.started', (e) => {
    state.status = 'task';
    state.currentTaskTitle = e.title;
    touch();
  }));

  subs.push(events.on('task.completed', (e) => {
    state.recentTasks.unshift({
      title: e.title,
      at: Date.now(),
      success: e.success,
      stepsCompleted: e.stepsCompleted,
      totalSteps: e.totalSteps,
    });
    state.recentTasks = state.recentTasks.slice(0, MAX_RECENT_TASKS);
    state.currentTaskTitle = undefined;
    // After task completion, fall back to responding (message is still being built)
    // or idle if we never saw a message.received for this session.
    state.status = state.status === 'task' ? 'idle' : state.status;
    touch();
  }));

  subs.push(events.on('task.step.failed', (e) => {
    state.recentErrors.unshift({
      source: 'task',
      message: `${e.planTitle} step ${e.stepId}: ${e.error.slice(0, 150)}`,
      at: Date.now(),
    });
    state.recentErrors = state.recentErrors.slice(0, MAX_RECENT_ERRORS);
    touch();
  }));

  // ── Dream cycle ──────────────────────────────────────────────────────────
  subs.push(events.on('dream.started', () => {
    state.status = 'dreaming';
    touch();
  }));

  subs.push(events.on('dream.completed', () => {
    if (state.status === 'dreaming') state.status = 'idle';
    touch();
  }));

  log.info('Introspection subscribed to event bus');

  // ── Query API ────────────────────────────────────────────────────────────

  const getActivity = (): CurrentActivity => ({
    status: state.status,
    currentTaskTitle: state.currentTaskTitle,
    currentToolName: state.currentToolName,
    currentProject: state.currentProject,
    lastEventAt: state.lastEventAt,
    idleSeconds: Math.floor((Date.now() - state.lastEventAt) / 1000),
  });

  const getSnapshot = (): IntrospectionSnapshot => {
    const now = Date.now();
    const oneHourAgo = now - PROJECT_WINDOW_MS;

    // Unique recent projects (most-recent-first)
    const seenProjects = new Set<string>();
    const projectsTouched: string[] = [];
    for (const t of state.projectTouches) {
      if (t.at < oneHourAgo) break;
      if (!seenProjects.has(t.project)) {
        seenProjects.add(t.project);
        projectsTouched.push(t.project);
      }
    }

    const messagesLastHour = state.recentTasks.filter((t) => t.at >= oneHourAgo).length;
    const toolsLastHour = state.recentTools.filter((t) => t.at >= oneHourAgo).length;

    return {
      activity: getActivity(),
      recentTools: state.recentTools.slice(0, MAX_RECENT_TOOLS),
      recentTasks: state.recentTasks.slice(0, MAX_RECENT_TASKS),
      recentErrors: state.recentErrors.slice(0, MAX_RECENT_ERRORS),
      projectsTouched,
      messagesLastHour,
      toolsLastHour,
      sessionStartedAt: state.sessionStartedAt,
    };
  };

  const getCompactLine = (): string => {
    const a = getActivity();
    const parts: string[] = [];
    parts.push(`status=${a.status}`);
    if (a.currentTaskTitle) parts.push(`task="${truncate(a.currentTaskTitle, 40)}"`);
    if (a.currentProject) parts.push(`project=${a.currentProject}`);
    parts.push(`idle=${a.idleSeconds}s`);
    const recentToolNames = state.recentTools.slice(0, 3).map((t) => t.name);
    if (recentToolNames.length > 0) parts.push(`recentTools=[${recentToolNames.join(',')}]`);
    return `[currentActivity: ${parts.join(' ')}]`;
  };

  const getNarrative = (): string => {
    const snap = getSnapshot();
    const a = snap.activity;
    const lines: string[] = [];

    // Current state sentence
    switch (a.status) {
      case 'idle':
        lines.push(`I'm idle — last activity was ${a.idleSeconds}s ago.`);
        break;
      case 'responding':
        lines.push(`I'm currently responding to a message.`);
        break;
      case 'task':
        lines.push(`I'm running a task: "${a.currentTaskTitle ?? 'unknown'}".`);
        break;
      case 'tool':
        lines.push(`I'm executing a tool: ${a.currentToolName ?? 'unknown'}.`);
        break;
      case 'dreaming':
        lines.push(`I'm dreaming — running the nightly consolidation cycle.`);
        break;
    }

    if (a.currentProject) {
      lines.push(`Current project focus: ${a.currentProject}.`);
    }

    // Recent activity roll-up
    if (snap.recentTools.length > 0) {
      const toolSummary = summarizeTools(snap.recentTools);
      lines.push(`Recent tool usage: ${toolSummary}.`);
    }
    if (snap.recentTasks.length > 0) {
      const lastTask = snap.recentTasks[0]!;
      lines.push(
        `Last task: "${lastTask.title}" — ${lastTask.success ? 'completed' : 'failed'} ` +
        `(${lastTask.stepsCompleted}/${lastTask.totalSteps} steps).`,
      );
    }
    if (snap.projectsTouched.length > 0) {
      lines.push(`Projects I've touched in the last hour: ${snap.projectsTouched.join(', ')}.`);
    }
    if (snap.recentErrors.length > 0) {
      lines.push(`Recent errors (${snap.recentErrors.length}): "${truncate(snap.recentErrors[0]!.message, 100)}".`);
    }

    // Session uptime
    const sessionSeconds = Math.floor((Date.now() - snap.sessionStartedAt) / 1000);
    lines.push(`Session uptime: ${formatDuration(sessionSeconds)}.`);

    return lines.join(' ');
  };

  return {
    subs,
    getActivity,
    getSnapshot,
    getCompactLine,
    getNarrative,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function summarizeTools(tools: RecentTool[]): string {
  const counts = new Map<string, { total: number; failed: number }>();
  for (const t of tools) {
    const entry = counts.get(t.name) ?? { total: 0, failed: 0 };
    entry.total += 1;
    if (!t.success) entry.failed += 1;
    counts.set(t.name, entry);
  }
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 4);
  return sorted
    .map(([name, { total, failed }]) => (failed > 0 ? `${name} ×${total} (${failed} failed)` : `${name} ×${total}`))
    .join(', ');
}
