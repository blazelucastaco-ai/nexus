// Episodic memory query repository.
//
// All queries brain / proactive / learning subsystems need to read episodic
// memories should go through here. This centralizes the schema knowledge so
// a column rename is a one-file change, not a 15-file grep-and-pray.
//
// This does NOT replace `src/memory/*` — those own write paths and domain
// logic. This is a read-only query surface for consumers OUTSIDE the memory
// layer who previously reached into getDatabase() directly.

import { getDatabase } from '../memory/database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('EpisodicQueryRepo');

// ─── Row shapes ─────────────────────────────────────────────────────────────

export interface EpisodicRow {
  id: string;
  layer: string;
  type: string;
  content: string;
  tags: string; // JSON array
  importance: number;
  confidence: number;
  source: string | null;
  metadata: string; // JSON object
  created_at: string;
  last_accessed: string | null;
  access_count: number;
  summary?: string | null;
}

export interface DreamIdeaRow {
  content: string;
  created_at: string;
}

// ─── Query functions ────────────────────────────────────────────────────────

/**
 * Count failed tasks in the last N milliseconds.
 * Used by proactive engine to detect task-failure cascades.
 */
export function countRecentTaskFailures(windowMs: number): { count: number; titles: string[] } {
  try {
    const db = getDatabase();
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const rows = db
      .prepare(
        `SELECT content FROM memories
         WHERE type = 'task'
           AND tags LIKE '%failure%'
           AND created_at > ?
         ORDER BY created_at DESC`,
      )
      .all(cutoff) as Array<{ content: string }>;

    const titles = rows
      .map((r) => r.content.match(/Task: (.+)/)?.[1]?.slice(0, 60))
      .filter((t): t is string => Boolean(t))
      .slice(0, 5);

    return { count: rows.length, titles };
  } catch (err) {
    log.debug({ err }, 'countRecentTaskFailures failed');
    return { count: 0, titles: [] };
  }
}

/**
 * Fetch the content of active goals (tags include both 'goal' and 'active').
 * Ordered by importance then recency. Truncate content to reasonable length upstream.
 */
export function listActiveGoalContents(limit = 5): string[] {
  try {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT content FROM memories
         WHERE layer = 'episodic'
           AND tags LIKE '%"goal"%'
           AND tags LIKE '%"active"%'
         ORDER BY importance DESC, created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  } catch {
    return [];
  }
}

/**
 * Fetch active goals that are older than a cutoff (stale candidates).
 * Used by the dream cycle / goal tracker to prune goals with no activity.
 */
export function listStaleGoalCandidates(olderThanISO: string): Array<{
  id: string;
  content: string;
  tags: string;
  created_at: string;
}> {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT id, content, tags, created_at FROM memories
       WHERE layer = 'episodic'
         AND tags LIKE '%"goal"%'
         AND tags LIKE '%"active"%'
         AND created_at < ?`,
    )
    .all(olderThanISO) as Array<{ id: string; content: string; tags: string; created_at: string }>;
}

/**
 * Fetch most recent episodic memories created AFTER a given goal timestamp.
 * Used by goal-tracker to detect whether a goal has related activity.
 */
export function listActivityAfter(afterISO: string, limit = 100): Array<{ content: string }> {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT content FROM memories
       WHERE layer = 'episodic'
         AND created_at > ?
         AND type IN ('conversation', 'task', 'fact')
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(afterISO, limit) as Array<{ content: string }>;
}

/**
 * Fetch a single memory's tags (JSON-encoded).
 * Returns null if the memory doesn't exist.
 */
export function getMemoryTags(id: string): string | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT tags FROM memories WHERE id = ?')
    .get(id) as { tags: string } | undefined;
  return row?.tags ?? null;
}

/**
 * Update a memory's tags (caller supplies the new JSON-encoded tags string).
 * Returns true if a row was updated.
 */
export function updateMemoryTags(id: string, jsonTags: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare('UPDATE memories SET tags = ? WHERE id = ?')
    .run(jsonTags, id);
  return result.changes > 0;
}

/**
 * Fetch the most recent dream-generated ideas (tagged 'dream-idea').
 * Used by briefing and /dreams command.
 */
export function listRecentDreamIdeas(limit = 5, withinDays = 2): DreamIdeaRow[] {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      `SELECT content, created_at FROM memories
       WHERE layer = 'episodic'
         AND tags LIKE '%dream-idea%'
         AND created_at > ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(cutoff, limit) as DreamIdeaRow[];
}

/**
 * Fetch the latest dream journal summary (tagged 'dream-journal').
 * Returns the raw content or null.
 */
export function getLatestDreamJournal(): { content: string } | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT content FROM memories
       WHERE layer = 'semantic'
         AND tags LIKE '%dream-journal%'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get() as { content: string } | undefined;
  return row ?? null;
}

/**
 * Fetch session-summary memories for the /history command.
 */
export function listRecentSessionSummaries(limit = 10): Array<{ content: string; created_at: string }> {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT content, created_at FROM memories
       WHERE layer = 'episodic'
         AND (tags LIKE '%session-summary%' OR tags LIKE '%task%')
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ content: string; created_at: string }>;
}

/**
 * Count memories matching a tag within a time window.
 * Generic utility for quick metrics (e.g. "how many frustration events this week?").
 */
export function countByTag(tag: string, sinceISO?: string): number {
  const db = getDatabase();
  const escaped = tag.replace(/[%_\\]/g, '\\$&');
  if (sinceISO) {
    const row = db
      .prepare(`SELECT COUNT(*) as c FROM memories WHERE tags LIKE ? ESCAPE '\\' AND created_at > ?`)
      .get(`%${escaped}%`, sinceISO) as { c: number };
    return row?.c ?? 0;
  }
  const row = db
    .prepare(`SELECT COUNT(*) as c FROM memories WHERE tags LIKE ? ESCAPE '\\'`)
    .get(`%${escaped}%`) as { c: number };
  return row?.c ?? 0;
}
