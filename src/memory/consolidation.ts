// Nexus AI — Memory consolidation ("dream cycle")

import type Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';
import { getDatabase } from './database.js';
import type { SemanticMemory } from './semantic.js';

const log = createLogger('MemoryConsolidation');

export interface ConsolidationReport {
  summarised: number;
  factsExtracted: number;
  importanceAdjusted: number;
  deduplicated: number;
  garbageCollected: number;
  durationMs: number;
}

export interface ConsolidationStats {
  totalMemories: number;
  byLayer: Record<string, number>;
  avgImportance: number;
  totalFacts: number;
  totalMistakes: number;
  oldestMemory: string | null;
  newestMemory: string | null;
}

export class MemoryConsolidation {
  private db: Database.Database;
  private semanticMemory: SemanticMemory | null;

  constructor(semanticMemory?: SemanticMemory) {
    this.db = getDatabase();
    this.semanticMemory = semanticMemory ?? null;
    log.info('Memory consolidation engine initialized');
  }

  /**
   * Run the full consolidation dream cycle. Caller handles scheduling.
   */
  runConsolidation(): ConsolidationReport {
    const start = Date.now();
    log.info('Starting consolidation dream cycle');

    const summarised = this.summariseOldEpisodes();
    const factsExtracted = this.extractFacts();
    const importanceAdjusted = this.adjustImportance();
    const deduplicated = this.deduplicateMemories();
    const garbageCollected = this.garbageCollect();

    const report: ConsolidationReport = {
      summarised,
      factsExtracted,
      importanceAdjusted,
      deduplicated,
      garbageCollected,
      durationMs: Date.now() - start,
    };

    log.info(report, 'Consolidation dream cycle complete');
    return report;
  }

  /**
   * Get statistics about the current memory state.
   */
  getStats(): ConsolidationStats {
    const totalRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM memories')
      .get() as { cnt: number };

    const layerRows = this.db
      .prepare(
        'SELECT layer, COUNT(*) as cnt FROM memories GROUP BY layer',
      )
      .all() as { layer: string; cnt: number }[];
    const byLayer: Record<string, number> = {};
    for (const row of layerRows) {
      byLayer[row.layer] = row.cnt;
    }

    const avgRow = this.db
      .prepare('SELECT AVG(importance) as avg FROM memories')
      .get() as { avg: number | null };

    const factsRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM user_facts')
      .get() as { cnt: number };

    const mistakesRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM mistakes')
      .get() as { cnt: number };

    const oldestRow = this.db
      .prepare(
        'SELECT MIN(created_at) as ts FROM memories',
      )
      .get() as { ts: string | null };

    const newestRow = this.db
      .prepare(
        'SELECT MAX(created_at) as ts FROM memories',
      )
      .get() as { ts: string | null };

    return {
      totalMemories: totalRow.cnt,
      byLayer,
      avgImportance: avgRow.avg ?? 0,
      totalFacts: factsRow.cnt,
      totalMistakes: mistakesRow.cnt,
      oldestMemory: oldestRow.ts,
      newestMemory: newestRow.ts,
    };
  }

  /**
   * Step 1: Summarise old episodic memories that lack summaries.
   * Memories older than 7 days without a summary get a truncated extractive summary.
   */
  private summariseOldEpisodes(): number {
    const cutoff = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const rows = this.db
      .prepare(
        `SELECT id, content FROM memories
        WHERE layer = 'episodic'
          AND summary IS NULL
          AND created_at < ?
        LIMIT 50`,
      )
      .all(cutoff) as { id: string; content: string }[];

    if (rows.length === 0) return 0;

    const update = this.db.prepare(
      'UPDATE memories SET summary = ? WHERE id = ?',
    );

    const batchUpdate = this.db.transaction(() => {
      for (const row of rows) {
        const summary =
          row.content.length > 200
            ? `${row.content.slice(0, 200).trim()}...`
            : row.content;
        update.run(summary, row.id);
      }
    });
    batchUpdate();

    log.debug({ count: rows.length }, 'Summarised old episodes');
    return rows.length;
  }

  /**
   * Step 2: Extract facts from high-importance episodic memories.
   * Looks for memories containing preference/fact indicators not yet extracted.
   */
  private extractFacts(): number {
    const rows = this.db
      .prepare(
        `SELECT id, content, tags FROM memories
        WHERE layer = 'episodic'
          AND importance >= 0.7
          AND (tags LIKE '%preference%' OR tags LIKE '%fact%')
          AND id NOT IN (SELECT source_memory_id FROM user_facts WHERE source_memory_id IS NOT NULL)
        LIMIT 30`,
      )
      .all() as { id: string; content: string; tags: string }[];

    let count = 0;

    if (this.semanticMemory && rows.length > 0) {
      for (const row of rows) {
        const lines = row.content
          .split('\n')
          .filter((l) => l.trim().length > 0);
        for (const line of lines) {
          const lower = line.toLowerCase();
          if (
            lower.includes('prefers') ||
            lower.includes('likes') ||
            lower.includes('uses') ||
            lower.includes('always') ||
            lower.includes('never')
          ) {
            this.semanticMemory.storeFact({
              category: 'preference',
              key: `extracted_${row.id}_${count}`,
              value: line.trim(),
              confidence: 0.6,
              sourceMemoryId: row.id,
            });
            count++;
          }
        }
      }
    }

    if (count > 0) {
      log.debug({ count }, 'Extracted facts from episodes');
    }
    return count;
  }

  /**
   * Step 3: Adjust importance scores based on access patterns.
   * Frequently accessed memories get strengthened; stale ones decay.
   */
  private adjustImportance(): number {
    // Strengthen: memories accessed more than 3 times get a boost
    const strengthened = this.db
      .prepare(
        `UPDATE memories
        SET importance = MIN(1.0, importance + 0.05)
        WHERE access_count > 3
          AND importance < 1.0`,
      )
      .run();

    // Weaken: memories not accessed in 30 days with low importance decay
    const cutoff30 = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const weakened = this.db
      .prepare(
        `UPDATE memories
        SET importance = MAX(0.0, importance - 0.05)
        WHERE last_accessed < ?
          AND importance > 0.1
          AND layer != 'procedural'`,
      )
      .run(cutoff30);

    const total =
      (strengthened.changes ?? 0) + (weakened.changes ?? 0);
    if (total > 0) {
      log.debug(
        {
          strengthened: strengthened.changes,
          weakened: weakened.changes,
        },
        'Adjusted importance scores',
      );
    }
    return total;
  }

  /**
   * Step 4: Deduplicate memories with very similar content.
   * Keeps the one with higher importance and merges access counts.
   */
  private deduplicateMemories(): number {
    const rows = this.db
      .prepare(
        `SELECT m1.id AS id1, m2.id AS id2,
              m1.importance AS imp1, m2.importance AS imp2,
              m1.access_count AS ac1, m2.access_count AS ac2
        FROM memories m1
        JOIN memories m2
          ON m1.layer = m2.layer
          AND m1.id < m2.id
          AND SUBSTR(m1.content, 1, 100) = SUBSTR(m2.content, 1, 100)
        LIMIT 50`,
      )
      .all() as {
      id1: string;
      id2: string;
      imp1: number;
      imp2: number;
      ac1: number;
      ac2: number;
    }[];

    if (rows.length === 0) return 0;

    const deleteStmt = this.db.prepare(
      'DELETE FROM memories WHERE id = ?',
    );
    const updateStmt = this.db.prepare(
      'UPDATE memories SET access_count = ?, importance = ? WHERE id = ?',
    );

    let count = 0;
    const batchDedup = this.db.transaction(() => {
      for (const row of rows) {
        const [keepId, removeId] =
          row.imp1 >= row.imp2
            ? [row.id1, row.id2]
            : [row.id2, row.id1];
        const mergedAccess = row.ac1 + row.ac2;
        const mergedImportance = Math.max(row.imp1, row.imp2);

        updateStmt.run(mergedAccess, mergedImportance, keepId);
        deleteStmt.run(removeId);
        count++;
      }
    });
    batchDedup();

    if (count > 0) {
      log.debug({ count }, 'Deduplicated memories');
    }
    return count;
  }

  /**
   * Step 5: Garbage collect very old, low-importance, never-accessed memories.
   * Removes memories older than 90 days with importance below 0.1 and access_count of 0.
   * Never removes procedural or semantic layer memories.
   */
  private garbageCollect(): number {
    const cutoff90 = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const result = this.db
      .prepare(
        `DELETE FROM memories
        WHERE created_at < ?
          AND importance < 0.1
          AND access_count = 0
          AND layer NOT IN ('procedural', 'semantic')`,
      )
      .run(cutoff90);

    const deleted = result.changes ?? 0;
    if (deleted > 0) {
      log.info({ deleted }, 'Garbage collected old memories');
    }
    return deleted;
  }
}
