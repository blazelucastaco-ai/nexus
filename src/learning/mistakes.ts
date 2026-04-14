// Nexus AI — Mistake tracking, analysis, and prevention

import type { MemoryCortex } from '../memory/cortex.js';
import type { Mistake } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';

const log = createLogger('MistakeTracker');

/** Keyword overlap threshold for similarity detection (0-1). */
const SIMILARITY_THRESHOLD = 0.3;

export class MistakeTracker {
  private cortex: MemoryCortex;

  constructor(cortex: MemoryCortex) {
    this.cortex = cortex;
    log.info('MistakeTracker initialized');
  }

  /**
   * Record a new mistake. If a similar mistake already exists, increments its
   * recurrence count instead of creating a duplicate. Returns the mistake ID.
   */
  recordMistake(
    description: string,
    category: Mistake['category'],
    details: {
      whatHappened: string;
      whatShouldHaveHappened: string;
      rootCause?: string;
    },
  ): string {
    // Check for a similar existing mistake first
    const existing = this.findSimilarMistake(description);
    if (existing) {
      const newCount = existing.recurrenceCount + 1;
      const db = this.cortex.getDb();

      // Escalate severity every 2 recurrences (minor→moderate→major→critical)
      const escalated = this.maybeEscalateSeverity(existing.severity, newCount);
      db.prepare(
        'UPDATE mistakes SET recurrence_count = ?, severity = ? WHERE id = ?',
      ).run(newCount, escalated, existing.id);

      if (escalated !== existing.severity) {
        log.warn(
          { id: existing.id, newCount, oldSeverity: existing.severity, newSeverity: escalated },
          'Recurring mistake — severity escalated',
        );
      } else {
        log.info(
          { id: existing.id, recurrenceCount: newCount },
          'Recurring mistake detected — incremented count',
        );
      }
      return existing.id;
    }

    // Derive a prevention strategy from the root cause
    const preventionStrategy = details.rootCause
      ? `Before acting, verify: ${details.rootCause} — ensure ${details.whatShouldHaveHappened}`
      : `Double-check: ${details.whatShouldHaveHappened}`;

    const id = this.cortex.recordMistake({
      id: generateId(),
      description,
      category,
      whatHappened: details.whatHappened,
      whatShouldHaveHappened: details.whatShouldHaveHappened,
      rootCause: details.rootCause ?? 'unknown',
      preventionStrategy,
      severity: this.inferSeverity(description, details),
      resolved: false,
      recurrenceCount: 0,
    });

    log.info({ id, category, description }, 'New mistake recorded');
    return id;
  }

  /**
   * Search for a previously recorded mistake that is similar to the given description.
   * Uses keyword overlap scoring. Returns the best match or null.
   */
  findSimilarMistake(description: string): Mistake | null {
    const allMistakes = this.cortex.getMistakes();
    if (allMistakes.length === 0) return null;

    const descWords = this.extractKeywords(description);
    if (descWords.length === 0) return null;

    let bestMatch: Mistake | null = null;
    let bestScore = 0;

    for (const mistake of allMistakes) {
      const mistakeWords = this.extractKeywords(
        `${mistake.description} ${mistake.whatHappened} ${mistake.rootCause}`,
      );
      if (mistakeWords.length === 0) continue;

      const overlap = this.computeOverlap(descWords, mistakeWords);
      if (overlap > bestScore && overlap >= SIMILARITY_THRESHOLD) {
        bestScore = overlap;
        bestMatch = mistake;
      }
    }

    if (bestMatch) {
      log.debug(
        { matchId: bestMatch.id, score: bestScore.toFixed(2) },
        'Similar mistake found',
      );
    }

    return bestMatch;
  }

  /**
   * Get the prevention strategy for mistakes in a given category.
   * Aggregates strategies from all unresolved mistakes in that category.
   */
  getPreventionStrategy(category: string): string | null {
    const mistakes = this.cortex.getMistakes(false); // unresolved only
    const inCategory = mistakes.filter((m) => m.category === category);

    if (inCategory.length === 0) return null;

    // Prioritize by recurrence count, then severity
    const sorted = [...inCategory].sort((a, b) => {
      if (b.recurrenceCount !== a.recurrenceCount) return b.recurrenceCount - a.recurrenceCount;
      return severityRank(b.severity) - severityRank(a.severity);
    });

    // Combine top strategies
    const strategies = sorted
      .slice(0, 3)
      .map((m) => m.preventionStrategy)
      .filter(Boolean);

    return strategies.length > 0 ? strategies.join('; ') : null;
  }

  /**
   * Mark a mistake as resolved.
   */
  markResolved(id: string): void {
    const db = this.cortex.getDb();
    const result = db.prepare('UPDATE mistakes SET resolved = 1 WHERE id = ?').run(id);

    if (result.changes > 0) {
      log.info({ id }, 'Mistake marked as resolved');
    } else {
      log.warn({ id }, 'Mistake not found for resolution');
    }
  }

  /**
   * Get all mistakes that have occurred more than once (recurrence_count > 0).
   */
  getRecurringMistakes(): Mistake[] {
    const db = this.cortex.getDb();
    const rows = db
      .prepare(
        `SELECT id, description, category, what_happened, what_should_have_happened,
                root_cause, prevention_strategy, severity, resolved, recurrence_count, created_at
         FROM mistakes
         WHERE recurrence_count > 0
         ORDER BY recurrence_count DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map(rowToMistake);
  }

  /**
   * Get aggregate statistics about tracked mistakes.
   */
  getMistakeStats(): {
    total: number;
    resolved: number;
    recurring: number;
    byCategory: Record<string, number>;
  } {
    const all = this.cortex.getMistakes();
    const resolved = all.filter((m) => m.resolved).length;
    const recurring = all.filter((m) => m.recurrenceCount > 0).length;

    const byCategory: Record<string, number> = {};
    for (const m of all) {
      byCategory[m.category] = (byCategory[m.category] ?? 0) + 1;
    }

    return { total: all.length, resolved, recurring, byCategory };
  }

  /**
   * Check whether a proposed action matches any known mistake patterns.
   * Returns a safety assessment with an optional warning.
   */
  checkAgainstHistory(proposedAction: string): { safe: boolean; warning?: string } {
    const unresolved = this.cortex.getMistakes(false);
    if (unresolved.length === 0) return { safe: true };

    const actionWords = this.extractKeywords(proposedAction);
    if (actionWords.length === 0) return { safe: true };

    for (const mistake of unresolved) {
      const mistakeWords = this.extractKeywords(
        `${mistake.description} ${mistake.whatHappened} ${mistake.rootCause}`,
      );
      const overlap = this.computeOverlap(actionWords, mistakeWords);

      if (overlap >= SIMILARITY_THRESHOLD) {
        const warning = `This action resembles a past mistake: "${mistake.description}". Prevention: ${mistake.preventionStrategy}`;
        log.warn({ proposedAction, matchId: mistake.id, overlap: overlap.toFixed(2) }, 'Action matches mistake pattern');
        return { safe: false, warning };
      }
    }

    return { safe: true };
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Extract significant keywords (3+ chars, lowercased, de-duped) from text.
   */
  private extractKeywords(text: string): string[] {
    const words = text
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/g, ''))
      .filter((w) => w.length >= 3);
    return [...new Set(words)];
  }

  /**
   * Compute Jaccard-like overlap between two keyword sets.
   */
  private computeOverlap(wordsA: string[], wordsB: string[]): number {
    const setB = new Set(wordsB);
    let matches = 0;
    for (const w of wordsA) {
      if (setB.has(w)) matches++;
    }
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 ? matches / union : 0;
  }

  /**
   * Bump severity one level for every 2 recurrences, capped at 'critical'.
   * minor(0) → moderate(2) → major(4) → critical(6+)
   */
  private maybeEscalateSeverity(
    current: Mistake['severity'],
    recurrenceCount: number,
  ): Mistake['severity'] {
    const ladder: Mistake['severity'][] = ['minor', 'moderate', 'major', 'critical'];
    const currentIdx = ladder.indexOf(current);
    // Each pair of recurrences earns one escalation step
    const escalationSteps = Math.floor(recurrenceCount / 2);
    const newIdx = Math.min(currentIdx + escalationSteps, ladder.length - 1);
    return ladder[newIdx]!;
  }

  /**
   * Infer severity from description keywords and details.
   */
  private inferSeverity(
    description: string,
    details: { whatHappened: string; whatShouldHaveHappened: string; rootCause?: string },
  ): 'minor' | 'moderate' | 'major' | 'critical' {
    const text = `${description} ${details.whatHappened} ${details.rootCause ?? ''}`.toLowerCase();

    if (/data\s*loss|corrupt|security|credential|secret|production\s*down/.test(text)) {
      return 'critical';
    }
    if (/broke|crash|fail|error|wrong\s*data|incorrect\s*result/.test(text)) {
      return 'major';
    }
    if (/slow|inefficient|suboptimal|confus/.test(text)) {
      return 'moderate';
    }
    return 'minor';
  }
}

// ── Row mapping ──────────────────────────────────────────────────

function severityRank(severity: string): number {
  const ranks: Record<string, number> = { critical: 4, major: 3, moderate: 2, minor: 1 };
  return ranks[severity] ?? 0;
}

function rowToMistake(row: Record<string, unknown>): Mistake {
  return {
    id: row.id as string,
    description: row.description as string,
    category: row.category as Mistake['category'],
    whatHappened: row.what_happened as string,
    whatShouldHaveHappened: row.what_should_have_happened as string,
    rootCause: row.root_cause as string,
    preventionStrategy: row.prevention_strategy as string,
    severity: row.severity as Mistake['severity'],
    resolved: Boolean(row.resolved),
    recurrenceCount: row.recurrence_count as number,
    createdAt: row.created_at as string,
  };
}
