// Project Tracker — subscribes to the event bus and maintains per-project
// metadata and activity journal. No direct orchestrator wiring required.
//
// How it works:
// - On task.planned/task.completed, infer project from plan.projectDir (if present).
// - On tool.executed for write_file, infer project from the file path.
// - On task.step.failed, journal the error against the inferred project.
//
// Projects are auto-created on first observation — no explicit setup.

import { events } from '../core/events.js';
import { createLogger } from '../utils/logger.js';
import {
  upsertProject,
  appendJournalEntry,
  recordProjectTask,
  inferProjectFromPath,
} from '../data/projects-repository.js';

const log = createLogger('ProjectTracker');

export interface ProjectTrackerSubscriptions {
  unsubscribe(): void;
}

/**
 * Subscribe the project tracker to the event bus. Returns subscription handles
 * so the orchestrator can cleanly tear them down on shutdown.
 */
export function startProjectTracker(): ProjectTrackerSubscriptions[] {
  const subs: ProjectTrackerSubscriptions[] = [];

  // ── task.planned ────────────────────────────────────────────────────────
  // We don't have the project dir directly on this event — task.started also
  // omits it. So we piggyback on task.step.completed (which gets filesWritten)
  // and task.completed (which gets filesProduced) for inference.

  // ── task.completed ──────────────────────────────────────────────────────
  subs.push(events.on('task.completed', (e) => {
    const projectName = inferProjectFromFiles(e.filesProduced);
    if (!projectName) {
      log.debug({ title: e.title }, 'task.completed — no project inferred from files');
      return;
    }
    upsertProject({ name: projectName });
    recordProjectTask({ name: projectName, title: e.title, success: e.success });
    appendJournalEntry({
      project: projectName,
      kind: 'task',
      summary: `${e.success ? '✓' : '✗'} ${e.title} — ${e.stepsCompleted}/${e.totalSteps} steps, ${Math.round(e.durationMs / 1000)}s`,
      metadata: { filesProduced: e.filesProduced.slice(0, 10), durationMs: e.durationMs },
    });
    log.info({ project: projectName, title: e.title, success: e.success }, 'Recorded project task');
  }));

  // ── task.step.failed ────────────────────────────────────────────────────
  subs.push(events.on('task.step.failed', (e) => {
    // We don't have file paths here — best effort: tag against the most recent
    // active project. Skip if none. Non-critical so we don't block on this.
    appendJournalEntry({
      project: 'unknown',
      kind: 'error',
      summary: `Step ${e.stepId} failed in "${e.planTitle}" (attempt ${e.attempt}): ${e.error.slice(0, 200)}`,
      metadata: { planTitle: e.planTitle, stepId: e.stepId, attempt: e.attempt },
    });
  }));

  // ── task.step.completed ─────────────────────────────────────────────────
  // Use this to infer the project from filesWritten early in the task so
  // subsequent events have a known project to tag against.
  subs.push(events.on('task.step.completed', (e) => {
    const projectName = inferProjectFromFiles(e.filesWritten);
    if (!projectName) return;
    upsertProject({ name: projectName });
    appendJournalEntry({
      project: projectName,
      kind: 'task',
      summary: `Step ${e.stepId} ${e.success ? 'done' : 'failed'} — ${e.filesWritten.length} file${e.filesWritten.length === 1 ? '' : 's'}`,
      metadata: { files: e.filesWritten.slice(0, 5) },
    });
  }));

  // ── tool.executed for write_file / read_file ────────────────────────────
  // These reveal which project the user is actively touching even outside task runs.
  subs.push(events.on('tool.executed', (e) => {
    if (e.toolName !== 'write_file' && e.toolName !== 'run_terminal_command') return;
    const pathArg = (e.params?.path ?? e.params?.cwd) as string | undefined;
    if (!pathArg || typeof pathArg !== 'string') return;
    const inferred = inferProjectFromPath(pathArg);
    if (!inferred) return;
    upsertProject({ name: inferred.name, path: inferred.dir });
  }));

  return subs;
}

/**
 * Given a list of written file paths, find the most common project among them.
 * Returns null if no path matches a known workspace pattern.
 */
function inferProjectFromFiles(paths: string[]): string | null {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const inferred = inferProjectFromPath(p);
    if (inferred) {
      counts.set(inferred.name, (counts.get(inferred.name) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  // Return the project name with the highest file count
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) { best = name; bestCount = count; }
  }
  return best;
}
