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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { getDatabase } from '../memory/database.js';
import { storeEmbedding } from '../memory/embeddings.js';
import { generateId, nowISO } from '../utils/helpers.js';
import type { AIManager } from '../ai/index.js';
import { GoalTracker } from './goal-tracker.js';
import { events } from '../core/events.js';

const log = createLogger('DreamCycle');

const STATE_PATH = join(homedir(), '.nexus', 'dream-state.json');

interface DreamState {
  lastDreamAt: number;       // epoch ms
  lastReflectedAt: number;   // epoch ms
}

export type SendFn = (message: string) => Promise<void>;

export interface DreamReport {
  consolidated: number;      // episodic → semantic promotions
  decayed: number;           // importance-decayed memories
  garbageCollected: number;
  contradictions: number;    // conflicting facts resolved
  staleGoalsPruned: number;  // goals with no activity in 30+ days
  reflections: string[];     // observations about recent activity patterns
  ideas: string[];           // actionable ideas generated from reflections
  insights: string[];        // LLM-generated semantic facts from consolidation
  // Advanced synthesis — produced by the second pass when an AI is wired
  themes: string[];          // clustered topics from the day's activity
  openLoops: string[];       // things started but not finished; surface tomorrow
  skillProposals: Array<{ name: string; rationale: string }>; // patterns worth codifying
  narrative: string;         // prose diary entry — feeds the morning briefing
  durationMs: number;
  skipped?: boolean;         // true if double-run guard fired
}

export class DreamingEngine {
  private aiManager: AIManager | null;
  private sendFn: SendFn | null;
  private goalTracker: GoalTracker;
  // In-process mutex to close the concurrent-entry race on the cooldown check.
  // Two callers hitting runDreamCycle before saveDreamState fires would each
  // see the stale timestamp and both proceed. This flag makes the entry CAS.
  private dreamRunning = false;

  constructor(aiManager?: AIManager, sendFn?: SendFn) {
    this.aiManager = aiManager ?? null;
    this.sendFn = sendFn ?? null;
    this.goalTracker = new GoalTracker();
  }

  // ── State persistence ──────────────────────────────────────────────

  private loadDreamState(): DreamState {
    try {
      if (existsSync(STATE_PATH)) {
        const raw = readFileSync(STATE_PATH, 'utf8');
        return JSON.parse(raw) as DreamState;
      }
    } catch (e) {
      log.debug({ e }, 'Could not load dream state — treating as fresh');
    }
    return { lastDreamAt: 0, lastReflectedAt: 0 };
  }

  private saveDreamState(state: DreamState): void {
    try {
      mkdirSync(join(homedir(), '.nexus'), { recursive: true });
      writeFileSync(STATE_PATH, JSON.stringify(state), 'utf8');
    } catch (err) {
      log.warn({ err }, 'Failed to save dream state');
    }
  }

  // ── Main entry point ────────────────────────────────────────────────────────

  async runDreamCycle(): Promise<DreamReport> {
    const start = Date.now();

    // In-process CAS: if a cycle is already running in this process, refuse.
    // This closes the race where two callers both read a stale lastDreamAt
    // and both pass the cooldown check.
    if (this.dreamRunning) {
      log.warn('Dream cycle already running in this process — rejecting concurrent call');
      return {
        consolidated: 0, decayed: 0, garbageCollected: 0, contradictions: 0,
        staleGoalsPruned: 0, reflections: [], ideas: [], insights: [],
        themes: [], openLoops: [], skillProposals: [], narrative: '',
        durationMs: 0, skipped: true,
      };
    }
    this.dreamRunning = true;

    try {
      // Double-run guard — reject runs within 30 minutes of the last one
      const state = this.loadDreamState();
      const THIRTY_MIN = 30 * 60 * 1000;
      if (state.lastDreamAt > 0 && start - state.lastDreamAt < THIRTY_MIN) {
        const waitSec = Math.ceil((THIRTY_MIN - (start - state.lastDreamAt)) / 1000);
        log.warn({ waitSec }, 'Dream cycle rejected — too soon since last run');
        return {
          consolidated: 0, decayed: 0, garbageCollected: 0, contradictions: 0,
          staleGoalsPruned: 0, reflections: [], ideas: [], insights: [],
          themes: [], openLoops: [], skillProposals: [], narrative: '',
          durationMs: Date.now() - start, skipped: true,
        };
      }

      // Stamp immediately so concurrent callers see it
      this.saveDreamState({ ...state, lastDreamAt: start });
    log.info('Dream cycle starting…');
    // Notify subscribers (Code Dreams, telemetry, etc.) — the bus is the only
    // mechanism for tying side cycles to the dream run.
    events.emit({ type: 'dream.started' });

    const insights: string[] = [];
    const consolidated = await this.consolidateEpisodic(insights);
    const decayed = this.decayStaleMemories();
    const garbageCollected = this.garbageCollect();
    const contradictions = this.detectAndResolveContradictions();
    const staleGoalsPruned = this.goalTracker.pruneStaleGoals();

    // Reflection + ideation — only if we have an AI manager
    const reflections: string[] = [];
    const ideas: string[] = [];
    let themes: string[] = [];
    let openLoops: string[] = [];
    let skillProposals: Array<{ name: string; rationale: string }> = [];
    let narrative = '';

    if (this.aiManager) {
      try {
        const recentContext = this.gatherRecentContext(state.lastReflectedAt);
        if (recentContext.trim().length > 20) {
          // Pass 1 — raw observations about what happened
          await this.reflect(recentContext, reflections);
          if (reflections.length > 0) {
            // Update reflection timestamp before ideation.
            // Spread the existing state so any future fields survive (FIND-BUG-03).
            this.saveDreamState({ ...state, lastDreamAt: start, lastReflectedAt: Date.now() });

            // Pass 2 — action ideas derived from the observations
            await this.ideate(reflections, ideas);
            this.storeIdeasAsMemories(ideas);

            // Pass 3 — structured synthesis: themes, open loops, skill
            // proposals, and a prose narrative. This is the "advanced"
            // layer on top of the older reflect + ideate flow.
            const synth = await this.synthesize(recentContext, reflections, ideas);
            themes = synth.themes;
            openLoops = synth.openLoops;
            skillProposals = synth.skillProposals;
            narrative = synth.narrative;
            this.storeOpenLoopsAsMemories(openLoops);
            this.storeSkillProposalsAsMemories(skillProposals);
          }
        }
      } catch (err) {
        log.warn({ err }, 'Reflection/synthesis failed — skipping');
      }

      // Journal the dream as a semantic memory
      try {
        if (reflections.length > 0 || insights.length > 0 || narrative) {
          this.journalDream(
            reflections, ideas, insights,
            consolidated, decayed, garbageCollected, contradictions,
            { themes, openLoops, skillProposals, narrative },
          );
        }
      } catch (err) {
        log.warn({ err }, 'Dream journal write failed — skipping');
      }
    }

    const report: DreamReport = {
      consolidated,
      decayed,
      garbageCollected,
      contradictions,
      staleGoalsPruned,
      reflections,
      ideas,
      insights,
      themes,
      openLoops,
      skillProposals,
      narrative,
      durationMs: Date.now() - start,
    };

    log.info(report, 'Dream cycle complete');
    events.emit({
      type: 'dream.completed',
      consolidated, decayed, gcd: garbageCollected,
      reflections: reflections.length, ideas: ideas.length,
      durationMs: report.durationMs,
    });

      // Notify via Telegram if there's anything interesting to share
      if (this.sendFn && (reflections.length > 0 || insights.length > 0 || ideas.length > 0)) {
        try {
          await this.sendFn(this.formatTelegramMessage(report));
        } catch (err) {
          log.warn({ err }, 'Dream cycle Telegram notification failed');
        }
      }

      return report;
    } finally {
      this.dreamRunning = false;
    }
  }

  // ── Phase 1: Consolidate high-access episodic → semantic (batched) ──────────

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

    log.info({ count: rows.length }, 'Consolidating episodic memories (batched)');
    let promoted = 0;

    // Process in batches of 5 to reduce LLM round-trips
    const BATCH_SIZE = 5;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const batchInsights = await this.generateInsightsBatch(batch);

      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const insight = batchInsights[j];
        if (!insight) continue;

        try {
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
          log.warn({ err, memoryId: row.id }, 'Failed to store consolidated memory — skipping');
        }
      }
    }

    return promoted;
  }

  // ── Phase 2: Decay stale rarely-accessed episodic memories ────────────────

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

  // ── Phase 3: Garbage collect ───────────────────────────────────────────────

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

  // ── Phase 4: Gather recent context for reflection ─────────────────────────

  /**
   * Pull activity since lastReflectedAt (or last 48h as fallback) + top user facts.
   */
  private gatherRecentContext(lastReflectedAt: number): string {
    const db = getDatabase();

    // Primary window: since last reflection (min 4h, max 48h)
    const minCutoff = Date.now() - 48 * 60 * 60 * 1000;
    const sinceMs = lastReflectedAt > 0
      ? Math.max(lastReflectedAt, minCutoff)
      : minCutoff;
    const cutoffISO = new Date(sinceMs).toISOString();

    // Recent episodic memories — lower threshold to capture more
    let episodes = db
      .prepare(
        `SELECT content, importance, created_at
         FROM memories
         WHERE layer = 'episodic'
           AND created_at > ?
           AND importance > 0.1
         ORDER BY importance DESC, created_at DESC
         LIMIT 30`,
      )
      .all(cutoffISO) as Array<{ content: string; importance: number; created_at: string }>;

    // If very few new episodic memories, expand window to 7 days to give the LLM something real to work with
    if (episodes.length < 5) {
      const fallbackCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      episodes = db
        .prepare(
          `SELECT content, importance, created_at
           FROM memories
           WHERE layer = 'episodic'
             AND created_at > ?
             AND importance > 0.1
           ORDER BY importance DESC, created_at DESC
           LIMIT 20`,
        )
        .all(fallbackCutoff) as Array<{ content: string; importance: number; created_at: string }>;
    }

    // Also pull recent semantic facts (cross-session patterns)
    const recentSemantic = db
      .prepare(
        `SELECT content, created_at
         FROM memories
         WHERE layer = 'semantic'
           AND created_at > ?
           AND tags NOT LIKE '%dream-reflection%'
           AND tags NOT LIKE '%dream-journal%'
         ORDER BY importance DESC, created_at DESC
         LIMIT 10`,
      )
      .all(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()) as Array<{ content: string; created_at: string }>;

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

    const now = new Date();
    const parts: string[] = [
      `=== Dream Cycle Context ===`,
      `Date: ${now.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
      `Time: ${now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`,
      '',
    ];

    if (episodes.length > 0) {
      parts.push('=== Recent Activity ===');
      for (const ep of episodes) {
        const short = ep.content.length > 300 ? ep.content.slice(0, 300) + '…' : ep.content;
        parts.push(`• ${short}`);
      }
    }

    if (recentSemantic.length > 0) {
      parts.push('\n=== Cross-Session Patterns (recent) ===');
      for (const s of recentSemantic) {
        const short = s.content.length > 200 ? s.content.slice(0, 200) + '…' : s.content;
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
      parts.push('\n=== Previous Dream Reflections (do not repeat these) ===');
      for (const r of pastReflections) {
        parts.push(`• ${r.content}`);
      }
    }

    return parts.join('\n');
  }

  // ── Phase 5: Reflect ──────────────────────────────────────────────────────

  private async reflect(context: string, reflections: string[]): Promise<void> {
    if (!this.aiManager) return;

    // Pull frustration events to enrich reflection
    const db = getDatabase();
    const frustrationRows = db
      .prepare(
        `SELECT content FROM memories
         WHERE layer = 'semantic'
           AND tags LIKE '%frustration%'
         ORDER BY created_at DESC
         LIMIT 5`,
      )
      .all() as Array<{ content: string }>;

    const frustrationContext = frustrationRows.length > 0
      ? `\n\n=== Recent User Frustration Events ===\n${frustrationRows.map((r) => `• ${r.content}`).join('\n')}`
      : '';

    const now = new Date();
    const dateLabel = now.toLocaleDateString('en-AU', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

    const prompt =
      `You are NEXUS, an AI agent OS that lives on a Mac. ` +
      `Today is ${dateLabel}. You have just finished your background memory maintenance.\n\n` +
      `Based on the context below, generate 2-4 fresh, specific observations. ` +
      `Each observation must be DIFFERENT from the "Previous Dream Reflections" listed in the context. ` +
      `Focus on what is NEW or CHANGED since last time. Cover:\n` +
      `1. What the user has been working on or focused on recently — be specific\n` +
      `2. Any new patterns or shifts in behaviour compared to before\n` +
      `3. Anything that caused friction or frustration and how to handle it differently\n` +
      `4. A skill, tool, or approach worth remembering for next time\n\n` +
      `Each observation must be one specific, concrete sentence — not generic advice. ` +
      `If context is sparse, make the observation about the absence of activity itself.\n` +
      `Reply with ONLY the observations, one per line, no numbering or bullets.\n\n` +
      `Context:\n${context}${frustrationContext}`;

    try {
      const response = await this.aiManager.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 400,
        temperature: 0.95,
      });

      const lines = response.content
        .trim()
        .split('\n')
        .map((l) => l.replace(/^[-•*\d.]+\s*/, '').trim())
        .filter((l) => l.length > 10);

      reflections.push(...lines.slice(0, 4));
      log.debug({ count: reflections.length }, 'Generated reflections');
    } catch (err) {
      log.warn({ err }, 'Reflection LLM call failed');
    }
  }

  // ── Contradiction detection (keyword Jaccard similarity) ─────────────────

  private detectAndResolveContradictions(): number {
    const db = getDatabase();

    const facts = db
      .prepare(
        `SELECT id, content, created_at, importance
         FROM memories
         WHERE layer = 'semantic'
           AND type = 'fact'
           AND source != 'dream-cycle'
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all() as Array<{ id: string; content: string; created_at: string; importance: number }>;

    // Generic sentence starters to skip — these contain no useful topic signal
    const SKIP_PREFIXES = [
      'the ', 'a ', 'an ', 'i ', 'it ', 'this ', 'that ', 'there ', 'these ', 'those ',
      'we ', 'you ', 'he ', 'she ', 'they ', 'is ', 'was ', 'are ', 'were ', 'be ',
    ];

    let resolved = 0;
    // Map from topic fingerprint → {id, created_at}
    const seen = new Map<string, { id: string; created_at: string }>();

    for (const fact of facts) {
      const topic = this.buildTopicFingerprint(fact.content, SKIP_PREFIXES);
      if (!topic) continue;

      const existing = seen.get(topic);
      if (existing) {
        // Older fact loses importance
        const olderDate = fact.created_at < existing.created_at ? fact.id : existing.id;
        db.prepare(`UPDATE memories SET importance = MAX(0.1, importance - 0.2) WHERE id = ?`).run(olderDate);
        resolved++;
      } else {
        seen.set(topic, { id: fact.id, created_at: fact.created_at });
      }
    }

    if (resolved > 0) log.debug({ resolved }, 'Resolved memory contradictions');
    return resolved;
  }

  /**
   * Build a topic fingerprint using the top-N keywords from the sentence,
   * ignoring stop words and generic prefixes. Two facts with ≥20% keyword
   * overlap in their top-8 keywords are considered about the same topic.
   */
  private buildTopicFingerprint(content: string, skipPrefixes: string[]): string | null {
    const STOP_WORDS = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'is', 'was', 'are', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'shall', 'can', 'it', 'this', 'that',
      'i', 'you', 'he', 'she', 'we', 'they', 'their', 'its', 'not', 'also',
    ]);

    const lower = content.toLowerCase().trim();

    // Skip if starts with a generic prefix
    for (const prefix of skipPrefixes) {
      if (lower.startsWith(prefix)) {
        const remainder = lower.slice(prefix.length);
        if (remainder.split(/\s+/).length < 3) return null;
        break;
      }
    }

    // Extract keywords: alpha tokens > 3 chars not in stop words
    const keywords = lower
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
      .slice(0, 8);

    if (keywords.length < 2) return null;

    // Sort so order doesn't matter — fingerprint is a bag-of-words key
    return keywords.sort().join(' ');
  }

  // ── Phase 6: Ideate ───────────────────────────────────────────────────────

  private async ideate(reflections: string[], ideas: string[]): Promise<void> {
    if (!this.aiManager || reflections.length === 0) return;

    const reflectionText = reflections.map((r) => `• ${r}`).join('\n');

    const now = new Date();
    const dateLabel = now.toLocaleDateString('en-AU', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

    const prompt =
      `You are NEXUS. Today is ${dateLabel}.\n\n` +
      `Based on these fresh observations about the user:\n\n` +
      `${reflectionText}\n\n` +
      `Generate 1-2 specific, actionable ideas that directly follow from these observations. ` +
      `Each idea must be tied to something concrete in the observations above — not generic advice. ` +
      `Ideas can be: something to build, automate, improve, investigate, or suggest to the user today.\n\n` +
      `Reply with ONLY the ideas, one per line, no numbering or bullets.`;

    try {
      const response = await this.aiManager.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 200,
        temperature: 0.95,
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

  // ── Advanced synthesis pass (Pass 3) ──────────────────────────────────────

  /**
   * Pass 3 of the dream cycle. Given the raw context, the Pass-1 reflections,
   * and the Pass-2 ideas, produce a structured synthesis:
   *   - themes: the 2-4 topic clusters the day broke into
   *   - openLoops: things started but not finished — surface tomorrow
   *   - skillProposals: patterns worth codifying as a NEXUS skill
   *   - narrative: prose diary entry (feeds the morning briefing)
   */
  private async synthesize(
    context: string,
    reflections: string[],
    ideas: string[],
  ): Promise<{
    themes: string[];
    openLoops: string[];
    skillProposals: Array<{ name: string; rationale: string }>;
    narrative: string;
  }> {
    const empty = { themes: [], openLoops: [], skillProposals: [], narrative: '' };
    if (!this.aiManager) return empty;

    const now = new Date();
    const dateLabel = now.toLocaleDateString('en-AU', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

    // Pull mistakes recorded today so the synthesis can learn from them.
    const db = getDatabase();
    const todayCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const mistakes = db
      .prepare(
        `SELECT content FROM memories
         WHERE tags LIKE '%mistake%'
           AND created_at > ?
         ORDER BY created_at DESC
         LIMIT 5`,
      )
      .all(todayCutoff) as Array<{ content: string }>;

    const mistakeLines = mistakes.length > 0
      ? '\n\n=== Mistakes logged in the last 24h (learn from these) ===\n' +
        mistakes.map((m) => `• ${m.content.slice(0, 220)}`).join('\n')
      : '';

    const prompt =
      `You are NEXUS running a late-night synthesis pass. Today is ${dateLabel}.\n\n` +
      `You've already produced raw observations and action ideas for the day. Now step\n` +
      `back and write a structured synthesis. Think slowly and integrate.\n\n` +
      `=== Raw observations (pass 1) ===\n${reflections.map((r) => `• ${r}`).join('\n')}\n\n` +
      `=== Action ideas (pass 2) ===\n${ideas.map((i) => `• ${i}`).join('\n')}\n\n` +
      `=== Full day context ===\n${context.slice(0, 12_000)}${mistakeLines}\n\n` +
      `Output EXACTLY this JSON — no prose before or after, no markdown fences:\n\n` +
      `{\n` +
      `  "themes": ["<2-4 one-line topic clusters the day broke into>"],\n` +
      `  "openLoops": ["<2-5 things started but not finished, each <= 120 chars>"],\n` +
      `  "skillProposals": [\n` +
      `    { "name": "<kebab-case>", "rationale": "<one sentence why this is worth codifying>" }\n` +
      `  ],\n` +
      `  "narrative": "<3-5 paragraph first-person diary entry in NEXUS's voice — what did the day look like, what mattered, what felt stuck, what felt like progress. Tight prose, no bullet points inside.>"\n` +
      `}\n\n` +
      `Rules:\n` +
      `- Skill proposals only when you see a repeated multi-step procedure in the day's activity. If nothing fits, return [].\n` +
      `- Open loops are for the morning briefing — be specific, not generic.\n` +
      `- Narrative should read like NEXUS wrote it to itself, not to the user. First person. Honest.\n`;

    try {
      const response = await this.aiManager.complete({
        messages: [{ role: 'user', content: prompt }],
        // Use Opus here — synthesis is the most nuanced step and it only
        // runs once per day, so the cost is negligible.
        model: 'claude-opus-4-7',
        maxTokens: 2000,
      });
      const parsed = this.parseSynthesisJson(response.content);
      if (!parsed) return empty;
      return parsed;
    } catch (err) {
      log.warn({ err }, 'Synthesis pass failed');
      return empty;
    }
  }

  private parseSynthesisJson(raw: string): {
    themes: string[];
    openLoops: string[];
    skillProposals: Array<{ name: string; rationale: string }>;
    narrative: string;
  } | null {
    if (!raw) return null;
    const stripped = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    const start = stripped.indexOf('{');
    if (start < 0) return null;
    const candidate = stripped.slice(start);
    try {
      return this.validateSynthesis(JSON.parse(candidate));
    } catch { /* try trimming */ }
    const end = stripped.lastIndexOf('}');
    if (end > start) {
      try { return this.validateSynthesis(JSON.parse(stripped.slice(start, end + 1))); }
      catch { return null; }
    }
    return null;
  }

  private validateSynthesis(obj: unknown): {
    themes: string[];
    openLoops: string[];
    skillProposals: Array<{ name: string; rationale: string }>;
    narrative: string;
  } | null {
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    const asStrArr = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string' && x.trim().length >= 4).map((x) => x.trim())
        : [];
    const skillProposals: Array<{ name: string; rationale: string }> = [];
    if (Array.isArray(o.skillProposals)) {
      for (const s of o.skillProposals) {
        if (!s || typeof s !== 'object') continue;
        const sp = s as Record<string, unknown>;
        const name = typeof sp.name === 'string'
          ? sp.name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 48)
          : '';
        const rationale = typeof sp.rationale === 'string' ? sp.rationale.trim() : '';
        if (name && rationale) skillProposals.push({ name, rationale });
      }
    }
    return {
      themes: asStrArr(o.themes).slice(0, 5),
      openLoops: asStrArr(o.openLoops).slice(0, 6),
      skillProposals: skillProposals.slice(0, 4),
      narrative: typeof o.narrative === 'string' ? o.narrative.trim() : '',
    };
  }

  private storeOpenLoopsAsMemories(openLoops: string[]): void {
    if (openLoops.length === 0) return;
    const db = getDatabase();
    const now = nowISO();
    for (const loop of openLoops) {
      try {
        const id = generateId();
        db.prepare(
          `INSERT INTO memories
             (id, layer, type, content, importance, confidence, created_at,
              last_accessed, access_count, tags, related_memories, source, metadata)
           VALUES (?, 'episodic', 'task', ?, 0.75, 0.7, ?, ?, 0,
                   '["dream-open-loop","proactive"]', '[]', 'dream-cycle', '{}')`,
        ).run(id, loop, now, now);
        try { storeEmbedding(id, loop); } catch { /* non-fatal */ }
      } catch (err) {
        log.warn({ err }, 'Failed to store open loop');
      }
    }
    log.debug({ count: openLoops.length }, 'Stored open loops');
  }

  private storeSkillProposalsAsMemories(proposals: Array<{ name: string; rationale: string }>): void {
    if (proposals.length === 0) return;
    const db = getDatabase();
    const now = nowISO();
    for (const p of proposals) {
      try {
        const id = generateId();
        const content = `Skill proposal: ${p.name}\n\n${p.rationale}`;
        db.prepare(
          `INSERT INTO memories
             (id, layer, type, content, importance, confidence, created_at,
              last_accessed, access_count, tags, related_memories, source, metadata)
           VALUES (?, 'procedural', 'procedure', ?, 0.7, 0.7, ?, ?, 0,
                   '["dream-skill-proposal"]', '[]', 'dream-cycle', ?)`,
        ).run(id, content, now, now, JSON.stringify({ proposedName: p.name }));
      } catch (err) {
        log.warn({ err }, 'Failed to store skill proposal');
      }
    }
    log.debug({ count: proposals.length }, 'Stored skill proposals');
  }

  /**
   * Store each generated idea as an episodic memory tagged 'dream-idea'
   * so it surfaces in future recall and the morning briefing.
   */
  private storeIdeasAsMemories(ideas: string[]): void {
    if (ideas.length === 0) return;
    const db = getDatabase();
    const now = nowISO();

    for (const idea of ideas) {
      try {
        const id = generateId();
        db.prepare(
          `INSERT INTO memories
             (id, layer, type, content, importance, confidence, created_at,
              last_accessed, access_count, tags, related_memories, source, metadata)
           VALUES (?, 'episodic', 'task', ?, 0.7, 0.8, ?, ?, 0,
                   '["dream-idea","proactive"]', '[]', 'dream-cycle', '{}')`,
        ).run(id, idea, now, now);

        try {
          storeEmbedding(id, idea);
        } catch {
          // non-fatal
        }

        log.debug({ id, idea: idea.slice(0, 60) }, 'Stored dream idea as memory');
      } catch (err) {
        log.warn({ err }, 'Failed to store idea as memory');
      }
    }
  }

  // ── Phase 7: Journal ──────────────────────────────────────────────────────

  private journalDream(
    reflections: string[],
    ideas: string[],
    insights: string[],
    consolidated: number,
    decayed: number,
    garbageCollected: number,
    contradictions = 0,
    synth: {
      themes: string[];
      openLoops: string[];
      skillProposals: Array<{ name: string; rationale: string }>;
      narrative: string;
    } = { themes: [], openLoops: [], skillProposals: [], narrative: '' },
  ): void {
    const db = getDatabase();

    const parts: string[] = [`Dream cycle at ${new Date().toUTCString()}`];
    if (synth.narrative) parts.push(`\n${synth.narrative}\n`);
    if (synth.themes.length > 0) parts.push(`Themes: ${synth.themes.join(' | ')}`);
    if (reflections.length > 0) parts.push(`Reflections: ${reflections.join(' | ')}`);
    if (ideas.length > 0) parts.push(`Ideas: ${ideas.join(' | ')}`);
    if (synth.openLoops.length > 0) parts.push(`Open loops: ${synth.openLoops.join(' | ')}`);
    if (synth.skillProposals.length > 0) {
      parts.push(`Skill proposals: ${synth.skillProposals.map((s) => `${s.name} — ${s.rationale}`).join(' | ')}`);
    }
    if (insights.length > 0) parts.push(`Insights: ${insights.join(' | ')}`);
    parts.push(`Stats: consolidated=${consolidated}, decayed=${decayed}, gc=${garbageCollected}, contradictions=${contradictions}`);

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

    if (report.narrative) {
      // Take the first paragraph of the narrative for the Telegram preview —
      // the full one is on the dream journal row in the memory table.
      const para = report.narrative.split(/\n\n+/)[0]?.trim() ?? '';
      if (para) parts.push(`<i>${escapeHtml(para)}</i>`);
      parts.push('');
    }

    if (report.themes.length > 0) {
      parts.push(`<b>Themes</b>`);
      for (const t of report.themes) parts.push(`· ${escapeHtml(t)}`);
      parts.push('');
    }

    if (report.reflections.length > 0) {
      for (const r of report.reflections) {
        parts.push(`💭 ${escapeHtml(r)}`);
      }
    }

    if (report.openLoops.length > 0) {
      parts.push('');
      parts.push(`<b>Open loops for today</b>`);
      for (const l of report.openLoops) parts.push(`↻ ${escapeHtml(l)}`);
    }

    if (report.ideas.length > 0) {
      parts.push('');
      for (const idea of report.ideas) {
        parts.push(`💡 ${escapeHtml(idea)}`);
      }
    }

    if (report.skillProposals.length > 0) {
      parts.push('');
      parts.push(`<b>Skill ideas</b>`);
      for (const s of report.skillProposals) {
        parts.push(`🛠 <code>${escapeHtml(s.name)}</code> — ${escapeHtml(s.rationale)}`);
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
    if ((report.contradictions ?? 0) > 0) memStats.push(`${report.contradictions} contradictions resolved`);
    if (memStats.length > 0) {
      parts.push(`<i>${memStats.join(', ')}</i>`);
    }

    return parts.join('\n');
  }

  // ── Batched LLM insight generation (consolidation step) ──────────────────

  /**
   * Generate insights for a batch of up to 5 memories in a single LLM call.
   * Returns an array of the same length as `batch` (null entries for failures).
   */
  private async generateInsightsBatch(
    batch: Array<{ id: string; content: string; summary: string | null }>,
  ): Promise<Array<string | null>> {
    if (batch.length === 0) return [];

    if (!this.aiManager) {
      return batch.map((row) => this.extractiveSummary(row.summary ?? row.content));
    }

    const numbered = batch.map((row, i) => {
      const text = row.summary ?? row.content;
      const truncated = text.length > 400 ? text.slice(0, 400) + '…' : text;
      return `[${i + 1}] ${truncated}`;
    });

    const prompt =
      `Summarize each of the following ${batch.length} memories into a single concise sentence ` +
      `capturing the key fact or insight. Reply with EXACTLY ${batch.length} lines, ` +
      `one sentence per line, numbered [1] through [${batch.length}]. ` +
      `No preamble, no extra lines.\n\n` +
      numbered.join('\n');

    try {
      const response = await this.aiManager.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 100 * batch.length,
        temperature: 0.3,
      });

      const lines = response.content
        .trim()
        .split('\n')
        .map((l) => l.replace(/^\[\d+\]\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter((l) => l.length >= 5);

      // Pad or trim to batch length
      const results: Array<string | null> = [];
      for (let i = 0; i < batch.length; i++) {
        results.push(lines[i] ?? this.extractiveSummary(batch[i].summary ?? batch[i].content));
      }
      return results;
    } catch (err) {
      log.warn({ err }, 'Batch insight generation failed — using extractive fallback');
      return batch.map((row) => this.extractiveSummary(row.summary ?? row.content));
    }
  }

  private extractiveSummary(text: string): string | null {
    const first = text.split(/[.!?]/)[0]?.trim();
    if (!first || first.length < 5) return null;
    return first.length > 200 ? first.slice(0, 200) + '…' : first;
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
