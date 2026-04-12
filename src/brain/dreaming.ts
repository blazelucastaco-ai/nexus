// Nexus AI — Dream Cycle: Memory Consolidation + Reflection + Ideation
//
// Runs every 6 hours (or manually via `nexus dream`).
//
// Phases:
//   1. Consolidate — episodic memories accessed 3+ times → LLM insight → semantic
//   2. Decay       — reduce importance of stale, rarely-touched memories
//   3. GC          — delete very old, unimportant, untouched episodic memories
//   4. Reflect     — LLM analyzes recent activity to surface patterns & observations
//   5. Ideate      — LLM generates 1-2 actionable ideas from those reflections
//   6. Notify      — send a Telegram message summarizing the dream (if sendFn provided)
//   7. Journal     — store the dream log as a high-importance semantic memory

import { createLogger } from '../utils/logger.js';
import { getDatabase } from '../memory/database.js';
import { storeEmbedding } from '../memory/embeddings.js';
import { generateId, nowISO } from '../utils/helpers.js';
import type { AIManager } from '../ai/index.js';

const log = createLogger('DreamCycle');

export type SendFn = (message: string) => Promise<void>;

export interface DreamReport {
  consolidated: number;      // episodic → semantic promotions
  decayed: number;           // importance-decayed memories
  garbageCollected: number;
  reflections: string[];     // observations about recent activity patterns
  ideas: string[];           // actionable ideas generated from reflections
  insights: string[];        // LLM-generated semantic facts from consolidation
  durationMs: number;
}

export class DreamingEngine {
  private aiManager: AIManager | null;
  private sendFn: SendFn | null;

  constructor(aiManager?: AIManager, sendFn?: SendFn) {
    this.aiManager = aiManager ?? null;
    this.sendFn = sendFn ?? null;
  }

  // ── Main entry point ────────────────────────────────────────────────────────

  async runDreamCycle(): Promise<DreamReport> {
    const start = Date.now();
    log.info('Dream cycle starting…');

    const insights: string[] = [];
    const consolidated = await this.consolidateEpisodic(insights);
    const decayed = this.decayStaleMemories();
    const garbageCollected = this.garbageCollect();

    // Reflection + ideation — only if we have an AI manager
    const reflections: string[] = [];
    const ideas: string[] = [];

    if (this.aiManager) {
      try {
        const recentContext = this.gatherRecentContext();
        if (recentContext.trim().length > 50) {
          await this.reflect(recentContext, reflections);
          if (reflections.length > 0) {
            await this.ideate(reflections, ideas);
          }
        }
      } catch (err) {
        log.warn({ err }, 'Reflection/ideation failed — skipping');
      }

      // Journal the dream as a semantic memory
      try {
        if (reflections.length > 0 || insights.length > 0) {
          this.journalDream(reflections, ideas, insights, consolidated, decayed, garbageCollected);
        }
      } catch (err) {
        log.warn({ err }, 'Dream journal write failed — skipping');
      }
    }

    const report: DreamReport = {
      consolidated,
      decayed,
      garbageCollected,
      reflections,
      ideas,
      insights,
      durationMs: Date.now() - start,
    };

    log.info(report, 'Dream cycle complete');

    // Notify via Telegram if there's anything interesting to share
    if (this.sendFn && (reflections.length > 0 || insights.length > 0 || ideas.length > 0)) {
      try {
        await this.sendFn(this.formatTelegramMessage(report));
      } catch (err) {
        log.warn({ err }, 'Dream cycle Telegram notification failed');
      }
    }

    return report;
  }

  // ── Phase 1+2+3: Consolidate high-access episodic → semantic ───────────────

  private async consolidateEpisodic(insights: string[]): Promise<number> {
    const db = getDatabase();

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
               AND metadata IS NOT NULL
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

  // ── Phase 4: Decay stale rarely-accessed episodic memories ────────────────

  private decayStaleMemories(): number {
    const db = getDatabase();
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
    if (count > 0) log.debug({ count }, 'Decayed stale episodic memories');
    return count;
  }

  // ── Phase 5: Garbage collect ───────────────────────────────────────────────

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
    if (deleted > 0) log.info({ deleted }, 'Garbage collected old episodic memories');
    return deleted;
  }

  // ── Phase 6: Gather recent context for reflection ─────────────────────────

  /**
   * Pull the last 48h of episodic memories + top user facts to give the LLM
   * something meaningful to reflect on.
   */
  private gatherRecentContext(): string {
    const db = getDatabase();

    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    // Recent episodic memories (last 48h, importance > 0.3)
    const episodes = db
      .prepare(
        `SELECT content, importance, created_at
         FROM memories
         WHERE layer = 'episodic'
           AND created_at > ?
           AND importance > 0.3
         ORDER BY importance DESC, created_at DESC
         LIMIT 30`,
      )
      .all(cutoff48h) as Array<{ content: string; importance: number; created_at: string }>;

    // Top user facts (preferences/habits)
    const facts = db
      .prepare(
        `SELECT category, key, value
         FROM user_facts
         ORDER BY confidence DESC
         LIMIT 10`,
      )
      .all() as Array<{ category: string; key: string; value: string }>;

    // Recent semantic memories tagged with 'dream-reflection' to avoid re-covering ground
    const pastReflections = db
      .prepare(
        `SELECT content
         FROM memories
         WHERE layer = 'semantic'
           AND tags LIKE '%dream-reflection%'
         ORDER BY created_at DESC
         LIMIT 5`,
      )
      .all() as Array<{ content: string }>;

    const parts: string[] = [];

    if (episodes.length > 0) {
      parts.push('=== Recent Activity (last 48h) ===');
      for (const ep of episodes) {
        const short = ep.content.length > 300 ? ep.content.slice(0, 300) + '…' : ep.content;
        parts.push(`• ${short}`);
      }
    }

    if (facts.length > 0) {
      parts.push('\n=== Known User Preferences ===');
      for (const f of facts) {
        parts.push(`• [${f.category}] ${f.key}: ${f.value}`);
      }
    }

    if (pastReflections.length > 0) {
      parts.push('\n=== Previous Dream Reflections (do not repeat) ===');
      for (const r of pastReflections) {
        parts.push(`• ${r.content}`);
      }
    }

    return parts.join('\n');
  }

  // ── Phase 7: Reflect ──────────────────────────────────────────────────────

  private async reflect(context: string, reflections: string[]): Promise<void> {
    if (!this.aiManager) return;

    const prompt =
      `You are NEXUS, an AI agent OS that lives on a Mac. You have just finished your ` +
      `background memory maintenance and are now reflecting on recent interactions.\n\n` +
      `Based on the context below, generate 2-3 concise observations about patterns in ` +
      `the user's recent activity, interests, or working style. Each observation should ` +
      `be a single sentence. Be specific and insightful — not generic. Focus on what ` +
      `you've genuinely noticed, not what you'd expect to see.\n\n` +
      `Reply with ONLY the observations, one per line, no numbering or bullets.\n\n` +
      `Context:\n${context}`;

    try {
      const response = await this.aiManager.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 300,
        temperature: 0.7,
      });

      const lines = response.content
        .trim()
        .split('\n')
        .map((l) => l.replace(/^[-•*\d.]+\s*/, '').trim())
        .filter((l) => l.length > 10);

      reflections.push(...lines.slice(0, 3));
      log.debug({ count: reflections.length }, 'Generated reflections');
    } catch (err) {
      log.warn({ err }, 'Reflection LLM call failed');
    }
  }

  // ── Phase 8: Ideate ───────────────────────────────────────────────────────

  private async ideate(reflections: string[], ideas: string[]): Promise<void> {
    if (!this.aiManager || reflections.length === 0) return;

    const reflectionText = reflections.map((r) => `• ${r}`).join('\n');

    const prompt =
      `You are NEXUS. Based on these observations about the user's recent activity:\n\n` +
      `${reflectionText}\n\n` +
      `Generate 1-2 specific, actionable ideas — things you could proactively do, ` +
      `build, or suggest to help the user. Ideas should be concrete, not vague. ` +
      `Examples: "Set up a Python project template", "Create a shortcut for your ` +
      `daily deploy workflow", "Build a script to auto-archive those logs".\n\n` +
      `Reply with ONLY the ideas, one per line, no numbering or bullets.`;

    try {
      const response = await this.aiManager.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 200,
        temperature: 0.8,
      });

      const lines = response.content
        .trim()
        .split('\n')
        .map((l) => l.replace(/^[-•*\d.]+\s*/, '').trim())
        .filter((l) => l.length > 10);

      ideas.push(...lines.slice(0, 2));
      log.debug({ count: ideas.length }, 'Generated ideas');
    } catch (err) {
      log.warn({ err }, 'Ideation LLM call failed');
    }
  }

  // ── Phase 9: Journal ──────────────────────────────────────────────────────

  private journalDream(
    reflections: string[],
    ideas: string[],
    insights: string[],
    consolidated: number,
    decayed: number,
    garbageCollected: number,
  ): void {
    const db = getDatabase();

    const parts: string[] = [`Dream cycle at ${new Date().toUTCString()}`];
    if (reflections.length > 0) parts.push(`Reflections: ${reflections.join(' | ')}`);
    if (ideas.length > 0) parts.push(`Ideas: ${ideas.join(' | ')}`);
    if (insights.length > 0) parts.push(`Insights: ${insights.join(' | ')}`);
    parts.push(`Stats: consolidated=${consolidated}, decayed=${decayed}, gc=${garbageCollected}`);

    const content = parts.join('\n');
    const id = generateId();
    const now = nowISO();

    db.prepare(
      `INSERT INTO memories
         (id, layer, type, content, importance, confidence, created_at, last_accessed,
          access_count, tags, related_memories, source, metadata)
       VALUES (?, 'semantic', 'fact', ?, 0.6, 0.9, ?, ?, 0,
               '["dream-journal","dream-reflection"]', '[]', 'dream-cycle', '{}')`,
    ).run(id, content, now, now);

    log.debug({ id }, 'Dream journal entry stored');
  }

  // ── Telegram message formatter ─────────────────────────────────────────────

  private formatTelegramMessage(report: DreamReport): string {
    const parts: string[] = ['🌙 <b>NEXUS dreamed…</b>\n'];

    if (report.reflections.length > 0) {
      for (const r of report.reflections) {
        parts.push(`💭 ${r}`);
      }
    }

    if (report.ideas.length > 0) {
      parts.push('');
      for (const idea of report.ideas) {
        parts.push(`💡 ${idea}`);
      }
    }

    if (report.insights.length > 0) {
      parts.push('');
      const noun = report.insights.length === 1 ? 'insight' : 'insights';
      parts.push(`🧠 Promoted ${report.insights.length} memory ${noun} to long-term storage`);
    }

    const memStats: string[] = [];
    if (report.decayed > 0) memStats.push(`${report.decayed} decayed`);
    if (report.garbageCollected > 0) memStats.push(`${report.garbageCollected} cleaned`);
    if (memStats.length > 0) {
      parts.push(`<i>${memStats.join(', ')}</i>`);
    }

    return parts.join('\n');
  }

  // ── LLM insight generation (consolidation step) ───────────────────────────

  private async generateInsight(
    content: string,
    summary: string | null,
  ): Promise<string | null> {
    const text = summary ?? content;
    const truncated = text.length > 800 ? text.slice(0, 800) + '…' : text;

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

  private extractiveSummary(text: string): string | null {
    const first = text.split(/[.!?]/)[0]?.trim();
    if (!first || first.length < 5) return null;
    return first.length > 200 ? first.slice(0, 200) + '…' : first;
  }
}
