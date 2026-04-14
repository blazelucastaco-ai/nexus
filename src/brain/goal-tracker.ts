// Nexus AI — Goal Tracker
//
// Scans each user message for goal statements ("I want to...", "I'm trying
// to...", "by next week I need to...") and stores them as high-importance
// episodic memories tagged 'goal'. Active goals are injected into the
// system prompt at high priority so NEXUS stays aligned with what the
// user is working toward across sessions.

import { createLogger } from '../utils/logger.js';
import { getDatabase } from '../memory/database.js';

const log = createLogger('GoalTracker');

// Patterns that indicate a goal statement in user messages
const GOAL_PATTERNS: RegExp[] = [
  /\b(?:i want to|i need to|i'd like to|i'm trying to|i plan to|i'm planning to)\s+(.{10,200})/i,
  /\b(?:my goal is|my objective is|i'm aiming to|i'm working on|i'm building)\s+(.{10,200})/i,
  /\b(?:by (?:next week|monday|tuesday|wednesday|thursday|friday|end of|tomorrow)|this week|this month)\b.{5,100}/i,
  /\b(?:finish|complete|ship|launch|deploy|release)\s+(.{10,150})\b(?:\s+(?:by|before|this|next))/i,
];

export class GoalTracker {
  /**
   * Scan a user message for goal statements and store any found.
   * Returns the list of detected goal strings.
   */
  async extractAndStore(
    message: string,
    store: (layer: string, type: string, content: string, opts: Record<string, unknown>) => unknown,
  ): Promise<string[]> {
    const found: string[] = [];

    for (const pattern of GOAL_PATTERNS) {
      const match = message.match(pattern);
      if (match) {
        const raw = (match[1] ?? match[0]).trim().replace(/[.!?]+$/, '');
        if (raw.length >= 10 && !found.some((f) => f === raw)) {
          found.push(raw);
        }
      }
    }

    if (found.length === 0) return [];

    for (const goal of found) {
      try {
        await store('episodic', 'task', goal, {
          importance: 0.85,
          tags: ['goal', 'user-goal', 'active'],
          source: 'goal-tracker',
        });
        log.info({ goal: goal.slice(0, 80) }, 'User goal stored');
      } catch (err) {
        log.debug({ err }, 'Goal store failed — skipping');
      }
    }

    return found;
  }

  /**
   * Retrieve active (unresolved) goals from the memory DB.
   */
  getActiveGoals(limit = 5): string[] {
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

      return rows.map((r) => r.content.slice(0, 200));
    } catch {
      return [];
    }
  }

  /**
   * Scan active goals and mark any with no related episodic activity in the
   * past 30 days as 'stale'. Returns the number of goals pruned.
   *
   * A goal is considered stale when:
   *   - It was created more than 30 days ago, AND
   *   - No episodic memory sharing keyword overlap with the goal content
   *     has been created since the goal was recorded.
   */
  pruneStaleGoals(): number {
    try {
      const db = getDatabase();
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      // Fetch goals older than 30 days that are still active
      const staleGoalRows = db
        .prepare(
          `SELECT id, content, tags, created_at FROM memories
           WHERE layer = 'episodic'
             AND tags LIKE '%"goal"%'
             AND tags LIKE '%"active"%'
             AND created_at < ?`,
        )
        .all(cutoff) as Array<{ id: string; content: string; tags: string; created_at: string }>;

      if (staleGoalRows.length === 0) return 0;

      // For each old goal, check if any episodic memories were created after it
      // that share keyword overlap with the goal content
      let pruned = 0;
      for (const goal of staleGoalRows) {
        const goalKeywords = extractKeywords(goal.content);
        if (goalKeywords.length === 0) continue;

        // Look for any episodic memory created after this goal
        const laterRows = db
          .prepare(
            `SELECT content FROM memories
             WHERE layer = 'episodic'
               AND created_at > ?
             ORDER BY created_at DESC
             LIMIT 100`,
          )
          .all(goal.created_at) as Array<{ content: string }>;

        const hasRelatedActivity = laterRows.some((row) => {
          const rowKeywords = extractKeywords(row.content);
          const overlap = computeOverlap(goalKeywords, rowKeywords);
          return overlap >= 0.2;
        });

        if (!hasRelatedActivity) {
          // Swap 'active' → 'stale' in the tags array
          const tags: string[] = JSON.parse(goal.tags);
          const updated = tags.filter((t) => t !== 'active').concat('stale');
          db.prepare('UPDATE memories SET tags = ? WHERE id = ?')
            .run(JSON.stringify(updated), goal.id);
          pruned++;
        }
      }

      if (pruned > 0) {
        log.info({ pruned }, 'Stale goals pruned');
      }
      return pruned;
    } catch (err) {
      log.warn({ err }, 'pruneStaleGoals failed');
      return 0;
    }
  }

  /**
   * Mark a goal as resolved by swapping 'active' tag → 'resolved'.
   */
  resolveGoal(goalId: string): void {
    try {
      const db = getDatabase();
      const row = db
        .prepare('SELECT tags FROM memories WHERE id = ?')
        .get(goalId) as { tags: string } | undefined;

      if (!row) return;

      const tags: string[] = JSON.parse(row.tags);
      const updated = tags.filter((t) => t !== 'active').concat('resolved');

      db.prepare('UPDATE memories SET tags = ? WHERE id = ?')
        .run(JSON.stringify(updated), goalId);
    } catch {
      // non-fatal
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 4);
  return [...new Set(words)];
}

function computeOverlap(a: string[], b: string[]): number {
  const setB = new Set(b);
  let matches = 0;
  for (const w of a) {
    if (setB.has(w)) matches++;
  }
  const union = new Set([...a, ...b]).size;
  return union > 0 ? matches / union : 0;
}
