// Code Dreams — nightly meta-review of recent commits per active project.
//
// Signature feature: when the dream cycle fires, NEXUS reads the last N hours
// of git activity in each active project and asks Opus 4.7 for *meta-level*
// observations. Not line-by-line code review — pattern recognition:
//
//   "You refactored auth.ts three times this week. Second version was cleanest."
//   "12 `any` types added this sprint — that's unusual for you."
//   "You've been thrashing on the payment flow — 4 conflicting commits."
//
// Observations are stored as project_journal entries with kind='note' and
// surface in the morning briefing per-project.
//
// Pure event subscriber — no orchestrator coupling beyond the startup call.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { createLogger } from '../utils/logger.js';
import { events } from '../core/events.js';
import { listProjects, appendJournalEntry } from '../data/projects-repository.js';
import type { AIManager } from '../ai/index.js';

const execFileAsync = promisify(execFile);
const log = createLogger('CodeDreams');

// ─── Configuration ──────────────────────────────────────────────────────────

/** How far back to look for commits per review. */
const DEFAULT_SINCE_HOURS = 24;

/** Max diff characters passed to the LLM per project. Diffs beyond this are head-truncated. */
const MAX_DIFF_CHARS = 30_000;

/** Skip projects whose `last_active_at` is older than this. */
const STALE_PROJECT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Max projects reviewed per dream cycle — protects against runaway LLM cost. */
const MAX_PROJECTS_PER_CYCLE = 5;

// ─── Git interaction ────────────────────────────────────────────────────────

/**
 * Fetch recent git log with patches for a project directory.
 * Returns null if the directory is not a git repo or the command fails.
 */
export async function getRecentDiff(
  projectPath: string,
  sinceHours = DEFAULT_SINCE_HOURS,
): Promise<string | null> {
  try {
    // Verify the path exists and is a directory
    const st = await stat(projectPath);
    if (!st.isDirectory()) return null;

    // Verify it's a git repo by checking for .git
    try {
      await stat(`${projectPath}/.git`);
    } catch {
      return null;
    }

    // Get the log with patches. --oneline for headers, then -p for full diffs.
    const { stdout } = await execFileAsync(
      'git',
      ['log', `--since=${sinceHours} hours ago`, '--no-color', '-p', '--stat', '--first-parent'],
      { cwd: projectPath, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
    );

    if (!stdout.trim()) return null;

    // Head-truncate if over budget — keep the most recent commits (top of log output)
    if (stdout.length > MAX_DIFF_CHARS) {
      return stdout.slice(0, MAX_DIFF_CHARS) + '\n\n[…diff truncated for context budget]';
    }
    return stdout;
  } catch (err) {
    log.debug({ err, projectPath }, 'getRecentDiff failed');
    return null;
  }
}

// ─── LLM observation ────────────────────────────────────────────────────────

export interface CodeDreamObservation {
  project: string;
  summary: string;          // one-paragraph meta-observation
  patterns: string[];       // 0-5 distinct pattern/tech-debt notes
  followUps: string[];      // 0-3 suggested follow-up actions
  confidence: number;       // 0.0-1.0
}

const SYSTEM_PROMPT = `You are NEXUS, reviewing a developer's recent work at the META level.
You are NOT writing a code review — no line-by-line nitpicks, no style critiques.

Instead, surface patterns the developer probably can't see themselves:
- Are they thrashing on the same module (multiple conflicting commits)?
- Is technical debt accumulating (many 'any', TODO, ad-hoc patches)?
- Are they deep-focused (consistent refactoring in one area) or scattered?
- Is there architectural drift (e.g. adding network calls inside UI components)?
- Are they in a flow state or fighting the code?

Output STRICT JSON (no markdown, no prose outside the JSON):
{
  "summary": "one clear paragraph, 2-3 sentences max",
  "patterns": ["short observation 1", "short observation 2"],
  "followUps": ["optional concrete suggestion", ...],
  "confidence": 0.0-1.0
}

- summary: what stands out about this work (positive OR negative). Be specific.
- patterns: 0-5 distinct observations. Skip if nothing notable.
- followUps: 0-3 actionable suggestions. Skip if none useful.
- confidence: how sure you are. Low (<0.4) if the diff is small/unclear.

Be honest and direct. The developer can take it.`;

/**
 * Call the LLM to observe one project's recent diff.
 * Returns null if the LLM call fails — caller should move on gracefully.
 */
export async function observeProject(params: {
  ai: AIManager;
  projectName: string;
  displayName: string;
  diff: string;
  model?: string;
}): Promise<CodeDreamObservation | null> {
  const { ai, projectName, displayName, diff, model } = params;

  const userPrompt = `Project: ${displayName}
Recent git activity (last 24h):

${diff}`;

  try {
    const response = await ai.complete({
      model,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 800,
      temperature: 0.4,
    });

    const content = response.content?.trim() ?? '';
    const parsed = parseObservation(content);
    if (!parsed) {
      log.debug({ project: projectName, contentPreview: content.slice(0, 200) }, 'Failed to parse observation');
      return null;
    }
    return { project: projectName, ...parsed };
  } catch (err) {
    log.warn({ err, project: projectName }, 'observeProject LLM call failed');
    return null;
  }
}

/** Extract + validate the JSON observation from the model output. */
function parseObservation(raw: string): Omit<CodeDreamObservation, 'project'> | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      summary?: unknown;
      patterns?: unknown;
      followUps?: unknown;
      confidence?: unknown;
    };
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 500) : '',
      patterns: Array.isArray(parsed.patterns)
        ? parsed.patterns.filter((p): p is string => typeof p === 'string').slice(0, 5)
        : [],
      followUps: Array.isArray(parsed.followUps)
        ? parsed.followUps.filter((f): f is string => typeof f === 'string').slice(0, 3)
        : [],
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
    };
  } catch {
    return null;
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * Pick the active projects worth reviewing. Criteria:
 * - Project has a `path` on disk
 * - last_active_at within STALE_PROJECT_THRESHOLD_MS
 * - Not archived
 * Caps at MAX_PROJECTS_PER_CYCLE (most recently active first).
 */
function pickProjectsToReview(): Array<{ name: string; displayName: string; path: string }> {
  const all = listProjects({ limit: 50 });
  const cutoff = Date.now() - STALE_PROJECT_THRESHOLD_MS;
  const active = all
    .filter((p) => p.path && new Date(p.last_active_at).getTime() >= cutoff)
    .slice(0, MAX_PROJECTS_PER_CYCLE);
  return active.map((p) => ({ name: p.name, displayName: p.display_name, path: p.path! }));
}

/**
 * Run a full Code Dreams cycle: pick projects, fetch diffs, ask LLM, persist.
 * Returns the observations it recorded — useful for tests and for the caller
 * to summarize in the briefing.
 */
export async function runCodeDreamsCycle(params: {
  ai: AIManager;
  model?: string;
  fetchDiff?: (projectPath: string) => Promise<string | null>;
  sinceHours?: number;
}): Promise<CodeDreamObservation[]> {
  const { ai, model } = params;
  const fetch = params.fetchDiff ?? ((path) => getRecentDiff(path, params.sinceHours));

  const projects = pickProjectsToReview();
  if (projects.length === 0) {
    log.debug('No active projects to review this cycle');
    return [];
  }

  const observations: CodeDreamObservation[] = [];
  for (const proj of projects) {
    const diff = await fetch(proj.path);
    if (!diff || diff.length < 100) {
      log.debug({ project: proj.name }, 'Skipping — no meaningful diff');
      continue;
    }

    const obs = await observeProject({
      ai,
      projectName: proj.name,
      displayName: proj.displayName,
      diff,
      model,
    });
    if (!obs) continue;

    // Skip writing low-confidence noise to the journal
    if (obs.confidence < 0.35) {
      log.debug({ project: proj.name, confidence: obs.confidence }, 'Skipping low-confidence observation');
      continue;
    }

    persistObservation(obs);
    observations.push(obs);
  }

  log.info({ reviewed: observations.length, total: projects.length }, 'Code Dreams cycle complete');
  return observations;
}

/** Write an observation to the project journal as a note entry. */
function persistObservation(obs: CodeDreamObservation): void {
  const lines: string[] = [obs.summary];
  if (obs.patterns.length > 0) {
    lines.push('');
    for (const p of obs.patterns) lines.push(`• ${p}`);
  }
  if (obs.followUps.length > 0) {
    lines.push('');
    lines.push('Follow-ups:');
    for (const f of obs.followUps) lines.push(`→ ${f}`);
  }
  appendJournalEntry({
    project: obs.project,
    kind: 'note',
    summary: lines.join('\n').slice(0, 500),
    metadata: {
      source: 'code-dreams',
      confidence: obs.confidence,
      patternCount: obs.patterns.length,
      followUpCount: obs.followUps.length,
    },
  });
}

// ─── Event subscriber ──────────────────────────────────────────────────────

/**
 * Subscribe Code Dreams to the event bus. When the dream cycle fires,
 * we run a review pass. Returns subscription handles for shutdown.
 *
 * The caller owns the AIManager; we take it at subscribe time so we don't
 * have a stale reference after restart.
 */
export function startCodeDreams(params: {
  ai: AIManager;
  model?: string;
}): { unsubscribe(): void }[] {
  const subs: { unsubscribe(): void }[] = [];

  subs.push(events.on('dream.started', async () => {
    try {
      await runCodeDreamsCycle({ ai: params.ai, model: params.model });
    } catch (err) {
      log.warn({ err }, 'Code Dreams cycle threw — swallowing');
    }
  }));

  log.info('Code Dreams subscribed to dream.started');
  return subs;
}
