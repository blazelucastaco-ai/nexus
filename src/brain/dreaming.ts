// Nexus AI — Dream Cycle: Memory Consolidation via LLM
//
// Runs every 6 hours (or manually via `nexus dream`).
// Steps:
//   1. Find episodic memories accessed 3+ times (proxy for "multi-context recall")
//   2. Use LLM to generate a 1-sentence insight/summary for each
//   3. Promote to semantic memory (long-term fact)
//   4. Decay importance of old, rarely-accessed episodic memories
//   5. Garbage collect: delete episodic > 90 days, importance < 0.1, access_count = 0

import { createLogger } from '../utils/logger.js';
import { getDatabase } from '../memory/database.js';
import { storeEmbedding } from '../memory/embeddings.js';
import { generateId, nowISO } from '../utils/helpers.js';
import type { AIManager } from '../ai/index.js';

const log = createLogger('DreamCycle');

export interface DreamReport {
  consolidated: number;   // episodic → semantic promotions
  decayed: number;        // importance-decayed memories
  garbageCollected: number;
  durationMs: number;
  insights: string[];     // the LLM-generated semantic facts
}

export class DreamingEngine {
  private aiManager: AIManager | null;

  constructor(aiManager?: AIManager) {
    this.aiManager = aiManager ?? null;
  }

  // ── Main entry point ────────────────────────────────────────────────────────

  async runDreamCycle(): Promise<DreamReport> {
    const start = Date.now();
    log.info('Dream cycle starting…');

    const insights: string[] = [];
    const consolidated = await this.consolidateEpisodic(insights);
    const decayed = this.decayStaleMemories();
    const garbageCollected = this.garbageCollect();

    const report: DreamReport = {
      consolidated,
      decayed,
      garbageCollected,
      durationMs: Date.now() - start,
      insights,
    };

    log.info(report, 'Dream cycle complete');
    return report;
  }

  // ── Step 1+2+3: Consolidate high-access episodic → semantic ────────────────

  private async consolidateEpisodic(insights: string[]): Promise<number> {
    const db = getDatabase();

    // Find episodic memories accessed 3+ times, older than 3 days
    // (3 days ensures the memory isn't just repeat access in a single session)
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const rows = db
      .prepare(
        `SELECT id, content, summary, tags, source
         FROM memories
         WHERE layer = 'episodic'
           AND access_count >= 3
           AND created_at < ?
           AND id NOT IN (
             SELECT CAST(json_extract(metadata, '$.sourceEpisodicId') AS TEXT)
             FROM memories
             WHERE layer = 'semantic'
               AND json_extract(metadata, '$.sourceEpisodicId') IS NOT NULL
           )
         ORDER BY access_count DESC
         LIMIT 20`,
      )
      .all(cutoff) as Array<{
        id: string;
        content: string;
        summary: string | null;
        tags: string;
        source: string;
      }>;

    if (rows.length === 0) {
      log.debug('No episodic memories to consolidate');
      return 0;
    }

    log.info({ count: rows.length }, 'Consolidating episodic memories');
    let promoted = 0;

    for (const row of rows) {
      try {
        const insight = await this.generateInsight(row.content, row.summary);
        if (!insight) continue;

        // Promote to semantic memory
        const factId = generateId();
        const now = nowISO();
        db.prepare(
          `INSERT INTO memories
             (id, layer, type, content, summary, importance, confidence,
              emotional_valence, created_at, last_accessed, access_count,
              tags, related_memories, source, metadata)
           VALUES (?, 'semantic', 'fact', ?, ?, 0.8, 0.85,
                   NULL, ?, ?, 0, '["consolidated","dream-cycle"]',
                   '[]', 'dream-cycle', ?)`,
        ).run(
          factId,
          insight,
          `Consolidated from episodic memory ${row.id}`,
          now,
          now,
          JSON.stringify({ sourceEpisodicId: row.id, dreamedAt: now }),
        );

        // Also store an embedding for the new semantic fact
        try {
          storeEmbedding(factId, insight);
        } catch {
          // non-fatal
        }

        insights.push(insight);
        promoted++;

        log.debug({ factId, sourceId: row.id }, 'Promoted episodic → semantic');
      } catch (err) {
        log.warn({ err, memoryId: row.id }, 'Failed to consolidate memory — skipping');
      }
    }

    return promoted;
  }

  // ── Step 4: Decay stale rarely-accessed episodic memories ─────────────────

  private decayStaleMemories(): number {
    const db = getDatabase();

    // Memories older than 14 days with low access count lose importance
    const cutoff14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const result = db
      .prepare(
        `UPDATE memories
         SET importance = MAX(0.0, importance - 0.08)
         WHERE layer = 'episodic'
           AND access_count < 2
           AND created_at < ?
           AND importance > 0.05`,
      )
      .run(cutoff14);

    const count = result.changes ?? 0;
    if (count > 0) {
      log.debug({ count }, 'Decayed stale episodic memories');
    }
    return count;
  }

  // ── Step 5: Garbage collect ────────────────────────────────────────────────

  private garbageCollect(): number {
    const db = getDatabase();

    const cutoff90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const result = db
      .prepare(
        `DELETE FROM memories
         WHERE layer = 'episodic'
           AND created_at < ?
           AND importance < 0.1
           AND access_count = 0`,
      )
      .run(cutoff90);

    const deleted = result.changes ?? 0;
    if (deleted > 0) {
      log.info({ deleted }, 'Garbage collected old episodic memories');
    }
    return deleted;
  }

  // ── LLM insight generation ─────────────────────────────────────────────────

  private async generateInsight(
    content: string,
    summary: string | null,
  ): Promise<string | null> {
    const text = summary ?? content;
    const truncated = text.length > 800 ? text.slice(0, 800) + '…' : text;

    // Without an AI manager, fall back to an extractive summary
    if (!this.aiManager) {
      return this.extractiveSummary(truncated);
    }

    try {
      const response = await this.aiManager.complete({
        messages: [
          {
            role: 'user',
            content:
              `Summarize the following memory into a single concise sentence ` +
              `capturing the key fact or insight. Reply with ONLY the sentence, ` +
              `no preamble.\n\nMemory:\n${truncated}`,
          },
        ],
        maxTokens: 150,
        temperature: 0.3,
      });

      const sentence = response.content.trim().replace(/^["']|["']$/g, '');
      if (!sentence || sentence.length < 5) return null;
      return sentence;
    } catch (err) {
      log.warn({ err }, 'LLM insight generation failed — using extractive fallback');
      return this.extractiveSummary(truncated);
    }
  }

  /** Extractive fallback: take first sentence or first 200 chars. */
  private extractiveSummary(text: string): string | null {
    const first = text.split(/[.!?]/)[0]?.trim();
    if (!first || first.length < 5) return null;
    return first.length > 200 ? first.slice(0, 200) + '…' : first;
  }
}
