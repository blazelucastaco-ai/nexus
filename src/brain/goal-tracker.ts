// Nexus AI — Goal Tracker
//
// Scans each user message for goal statements ("I want to...", "I'm trying
// to...", "by next week I need to...") and stores them as high-importance
// episodic memories tagged 'goal'. Active goals are injected into the
// system prompt at high priority so NEXUS stays aligned with what the
// user is working toward across sessions.

import { createLogger } from '../utils/logger.js';
import {
  listActiveGoalContents,
  listStaleGoalCandidates,
  listActivityAfter,
  getMemoryTags,
  updateMemoryTags,
} from '../data/episodic-queries.js';

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
  extractAndStore(
    message: string,
    store: (layer: string, type: string, content: string, opts: Record<string, unknown>) => unknown,
  ): string[] {
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
        store('episodic', 'task', goal, {
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
    return listActiveGoalContents(limit).map((c) => c.slice(0, 200));
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
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const staleGoalRows = listStaleGoalCandidates(cutoff);
      if (staleGoalRows.length === 0) return 0;

      let pruned = 0;
      for (const goal of staleGoalRows) {
        const goalKeywords = extractKeywords(goal.content);
        if (goalKeywords.length === 0) continue;

        const laterRows = listActivityAfter(goal.created_at, 100);

        const hasRelatedActivity = laterRows.some((row) => {
          const rowKeywords = extractKeywords(row.content);
          const overlap = computeOverlap(goalKeywords, rowKeywords);
          return overlap >= 0.2;
        });

        if (!hasRelatedActivity) {
          // Swap 'active' → 'stale' in the tags array
          try {
            const tags: string[] = JSON.parse(goal.tags);
            const updated = tags.filter((t) => t !== 'active').concat('stale');
            updateMemoryTags(goal.id, JSON.stringify(updated));
            pruned++;
          } catch (e) {
            log.warn({ e, goalId: goal.id }, 'Malformed tags JSON — skipping');
          }
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
      const tagsJson = getMemoryTags(goalId);
      if (!tagsJson) return;

      const tags: string[] = JSON.parse(tagsJson);
      const updated = tags.filter((t) => t !== 'active').concat('resolved');
      updateMemoryTags(goalId, JSON.stringify(updated));
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
