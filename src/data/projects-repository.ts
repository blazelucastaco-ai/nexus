// Projects repository.
//
// Persists per-project metadata and activity journal. Backs the /projects,
// /go, and /project-status commands and the per-project morning briefing.
//
// Projects are auto-created on first observation (from a task's filesWritten
// or projectDir) — no explicit setup needed. A project is just a durable
// handle that accumulates journal entries tagged with its name.

import { getDatabase } from '../memory/database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ProjectsRepo');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProjectRow {
  name: string;               // stable slug (e.g. "pufftracker")
  display_name: string;       // human-friendly (e.g. "PuffTracker")
  path: string | null;        // primary workspace path on disk
  description: string | null;
  first_seen_at: string;
  last_active_at: string;
  task_count: number;
  last_task_title: string | null;
  last_task_success: number | null; // 0, 1, or null
  archived: number;           // 0/1
  metadata: string;           // JSON
}

export interface JournalEntry {
  id: number;
  project_name: string;
  kind: 'task' | 'tool' | 'error' | 'note';
  summary: string;
  metadata: string;
  created_at: string;
}

// ─── Project CRUD ───────────────────────────────────────────────────────────

/**
 * Upsert a project. If the row already exists, `last_active_at` and optionally
 * provided fields are updated; immutable fields (first_seen_at) are preserved.
 */
export function upsertProject(params: {
  name: string;
  displayName?: string;
  path?: string;
  description?: string;
}): void {
  const db = getDatabase();
  const displayName = params.displayName ?? humanize(params.name);
  db.prepare(
    `INSERT INTO projects (name, display_name, path, description, first_seen_at, last_active_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(name) DO UPDATE SET
       display_name   = COALESCE(excluded.display_name, display_name),
       path           = COALESCE(excluded.path, path),
       description    = COALESCE(excluded.description, description),
       last_active_at = datetime('now')`,
  ).run(params.name, displayName, params.path ?? null, params.description ?? null);
}

/** Retrieve a project by slug. */
export function getProject(name: string): ProjectRow | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as ProjectRow | undefined;
  return row ?? null;
}

/** List projects — most recently active first, optionally excluding archived. */
export function listProjects(opts: { limit?: number; includeArchived?: boolean } = {}): ProjectRow[] {
  const db = getDatabase();
  const limit = opts.limit ?? 50;
  const where = opts.includeArchived ? '' : 'WHERE archived = 0';
  return db
    .prepare(`SELECT * FROM projects ${where} ORDER BY last_active_at DESC LIMIT ?`)
    .all(limit) as ProjectRow[];
}

/** Archive (soft-delete) a project. History remains queryable. */
export function archiveProject(name: string): boolean {
  const db = getDatabase();
  const result = db.prepare('UPDATE projects SET archived = 1 WHERE name = ?').run(name);
  return result.changes > 0;
}

/** Unarchive. */
export function unarchiveProject(name: string): boolean {
  const db = getDatabase();
  const result = db.prepare('UPDATE projects SET archived = 0 WHERE name = ?').run(name);
  return result.changes > 0;
}

/** Update last-task fields after a task completes for a project. */
export function recordProjectTask(params: {
  name: string;
  title: string;
  success: boolean;
}): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE projects
       SET task_count        = task_count + 1,
           last_task_title   = ?,
           last_task_success = ?,
           last_active_at    = datetime('now')
     WHERE name = ?`,
  ).run(params.title, params.success ? 1 : 0, params.name);
}

// ─── Journal ────────────────────────────────────────────────────────────────

/** Append a journal entry for a project. */
export function appendJournalEntry(params: {
  project: string;
  kind: JournalEntry['kind'];
  summary: string;
  metadata?: Record<string, unknown>;
}): void {
  const db = getDatabase();
  try {
    db.prepare(
      `INSERT INTO project_journal (project_name, kind, summary, metadata)
       VALUES (?, ?, ?, ?)`,
    ).run(
      params.project,
      params.kind,
      params.summary.slice(0, 500),
      JSON.stringify(params.metadata ?? {}),
    );
  } catch (err) {
    log.debug({ err, project: params.project }, 'Journal append failed (project may not exist)');
  }
}

/** Get recent journal entries for a project. Ordered by id DESC since
 *  created_at (SQLite datetime) is only second-resolution. */
export function listJournalEntries(project: string, limit = 20): JournalEntry[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM project_journal
       WHERE project_name = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(project, limit) as JournalEntry[];
}

// ─── Path → project inference ───────────────────────────────────────────────

/**
 * Given a workspace-style path like '~/nexus-workspace/pufftracker/src/index.ts'
 * or '/Users/foo/nexus-workspace/pufftracker/...', infer the project name.
 * Returns null if the path doesn't match a known project layout.
 */
export function inferProjectFromPath(path: string): { name: string; dir: string } | null {
  // Match: anywhere in the path a segment after 'nexus-workspace' or 'workspace' or a top-level project-named folder
  const WORKSPACE_SEGMENTS = /(?:nexus-workspace|nexusworkspace|Projects|projects|workspace)\/([^/]+)/;
  const match = path.match(WORKSPACE_SEGMENTS);
  if (match && match[1]) {
    const name = slugify(match[1]);
    const dirIdx = path.indexOf(match[0]) + match[0].length;
    const dir = path.slice(0, dirIdx);
    return { name, dir };
  }
  return null;
}

/** Convert a project name to a slug: lowercase, hyphens, strip unsafe chars. */
export function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')          // underscores → hyphens
    .replace(/[^a-z0-9-]/g, '-') // any remaining unsafe chars → hyphen
    .replace(/-+/g, '-')          // collapse runs
    .replace(/^-|-$/g, '') || 'project';
}

/** Convert a slug back to a display name: "jake-fitness" → "Jake Fitness". */
function humanize(slug: string): string {
  return slug
    .split(/[-_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
