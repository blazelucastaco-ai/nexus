// NEXUS — Daily Briefing Engine
//
// Sends one morning message per day at a configurable hour.
// Content: last dream summary, today's scheduled tasks,
//          most confident pattern detected, and an LLM-generated
//          "thought for the day" based on recent memory context.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { getDatabase } from '../memory/database.js';
import { listRecentDreamIdeas, getLatestDreamJournal } from '../data/episodic-queries.js';
import { filterSystemPromptLeak, sanitizeEnvVars } from './injection-guard.js';
import { redactSelfDisclosure } from '../core/self-protection.js';
import type { AIManager } from '../ai/index.js';

const STATE_PATH = join(homedir(), '.nexus', 'briefing-state.json');

const log = createLogger('BriefingEngine');

export type SendFn = (message: string) => Promise<void>;

export class BriefingEngine {
  private sendFn: SendFn;
  private aiManager: AIManager | null;
  private briefingHour: number;       // 0-23, default 8
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBriefingDate: string;   // YYYY-MM-DD, persisted to disk
  private model?: string;             // lightweight model for the "thought for today"

  constructor(sendFn: SendFn, aiManager?: AIManager, briefingHour = 8, model?: string) {
    this.sendFn = sendFn;
    this.aiManager = aiManager ?? null;
    this.briefingHour = briefingHour;
    this.model = model;
    this.lastBriefingDate = this.loadLastBriefingDate();
  }

  // ── State persistence ──────────────────────────────────────────────

  private loadLastBriefingDate(): string {
    try {
      if (existsSync(STATE_PATH)) {
        const raw = readFileSync(STATE_PATH, 'utf8');
        const state = JSON.parse(raw) as { lastBriefingDate?: string };
        return state.lastBriefingDate ?? '';
      }
    } catch {
      // ignore — treat as no briefing sent yet
    }
    return '';
  }

  private saveLastBriefingDate(date: string): void {
    try {
      mkdirSync(join(homedir(), '.nexus'), { recursive: true });
      writeFileSync(STATE_PATH, JSON.stringify({ lastBriefingDate: date }), 'utf8');
    } catch (err) {
      log.warn({ err }, 'Failed to save briefing state');
    }
  }

  start(): void {
    if (this.timer) return;

    // Check every minute whether it's briefing time
    this.timer = setInterval(() => {
      this.maybeSendBriefing().catch((err) =>
        log.warn({ err }, 'Briefing check failed'),
      );
    }, 60_000);

    log.info({ hour: this.briefingHour }, 'Briefing engine started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Trigger manually (e.g. from a Telegram command or for testing). */
  async sendBriefingNow(): Promise<void> {
    const briefing = await this.composeBriefing();
    await this.sendFn(briefing);
    const today = todayString();
    this.lastBriefingDate = today;
    this.saveLastBriefingDate(today);
  }

  // ── Internal ───────────────────────────────────────────────────────

  private async maybeSendBriefing(): Promise<void> {
    const now = new Date();
    const today = todayString();

    if (now.getHours() !== this.briefingHour) return;
    if (this.lastBriefingDate === today) return;  // already sent today

    this.lastBriefingDate = today;
    this.saveLastBriefingDate(today);
    log.info({ date: today }, 'Sending daily briefing');

    try {
      const briefing = await this.composeBriefing();
      await this.sendFn(briefing);
    } catch (err) {
      log.error({ err }, 'Daily briefing failed');
    }
  }

  private async composeBriefing(): Promise<string> {
    const parts: string[] = [];
    const dateStr = new Date().toLocaleDateString('en-AU', {
      weekday: 'long', day: 'numeric', month: 'long',
    });

    parts.push(`☀️ <b>Good morning — ${dateStr}</b>\n`);

    // Last dream summary
    const dreamSummary = this.getLastDreamSummary();
    if (dreamSummary) {
      parts.push(`🌙 <b>Last night I was thinking…</b>`);
      parts.push(dreamSummary);
      parts.push('');
    }

    // Dream-generated ideas from the last cycle (if any)
    const dreamIdeas = this.getRecentDreamIdeas(3);
    if (dreamIdeas.length > 0) {
      parts.push(`✨ <b>Ideas from my last dream:</b>`);
      for (const idea of dreamIdeas) {
        parts.push(`  • ${idea}`);
      }
      parts.push('');
    }

    // Scheduled tasks for today
    const scheduledTasks = this.getScheduledTasksForToday();
    if (scheduledTasks.length > 0) {
      parts.push(`📋 <b>Scheduled today:</b>`);
      for (const t of scheduledTasks) {
        parts.push(`  • ${t}`);
      }
      parts.push('');
    }

    // Top pattern (most confident)
    const topPattern = this.getTopPattern();
    if (topPattern) {
      parts.push(`📊 <b>Pattern I've noticed:</b>`);
      parts.push(topPattern);
      parts.push('');
    }

    // Recurring mistakes worth watching for today
    const recurringMistakes = this.getRecurringMistakes();
    if (recurringMistakes.length > 0) {
      parts.push(`⚠️ <b>Watch out for:</b>`);
      for (const m of recurringMistakes) {
        parts.push(`  • ${m.description} <i>(${m.recurrenceCount}x, ${m.severity})</i>`);
      }
      parts.push('');
    }

    // LLM-generated thought for the day
    if (this.aiManager) {
      const thought = await this.generateThought();
      if (thought) {
        parts.push(`💭 <b>Thought for today:</b>`);
        parts.push(thought);
      }
    }

    return parts.join('\n');
  }

  private getLastDreamSummary(): string | null {
    const row = getLatestDreamJournal();
    if (!row) return null;

    // Extract reflections from the journal content
    const lines = row.content.split('\n');
    const reflectionLine = lines.find((l) => l.startsWith('Reflections:'));
    if (reflectionLine) {
      const reflections = reflectionLine.replace('Reflections:', '').trim();
      // Take first reflection only
      const first = reflections.split('|')[0]?.trim();
      return first ? first : null;
    }

    return null;
  }

  /**
   * Fetch the most recent dream-generated ideas (from last cycle).
   * Returns up to `limit` ideas, trimmed to reasonable briefing length.
   */
  private getRecentDreamIdeas(limit = 3): string[] {
    return listRecentDreamIdeas(limit, 2)
      .map((r) => (r.content ?? '').trim())
      .filter(Boolean)
      .map((s) => s.length > 180 ? s.slice(0, 180) + '…' : s);
  }

  private getScheduledTasksForToday(): string[] {
    try {
      const db = getDatabase();
      const rows = db
        .prepare(
          `SELECT name, cron_expression FROM scheduled_tasks
           WHERE enabled = 1
           ORDER BY next_run ASC
           LIMIT 5`,
        )
        .all() as Array<{ name: string; cron_expression: string }>;

      return rows.map((r) => `${r.name} <i>(${r.cron_expression})</i>`);
    } catch {
      return [];
    }
  }

  private getTopPattern(): string | null {
    try {
      const db = getDatabase();
      // Rotate through top-10 consolidated memories using day-of-month as offset
      // so the pattern shown changes every day instead of always being the same one
      const dayOffset = new Date().getDate() % 10;
      const rows = db
        .prepare(
          `SELECT content FROM memories
           WHERE layer = 'semantic'
             AND tags LIKE '%consolidated%'
           ORDER BY importance DESC, created_at DESC
           LIMIT 10`,
        )
        .all() as Array<{ content: string }>;

      if (rows.length === 0) return null;
      const row = rows[dayOffset % rows.length];
      const text = row.content.length > 200
        ? row.content.slice(0, 200) + '…'
        : row.content;
      return text;
    } catch {
      return null;
    }
  }

  private getRecurringMistakes(): Array<{ description: string; recurrenceCount: number; severity: string }> {
    try {
      const db = getDatabase();
      const rows = db
        .prepare(
          `SELECT description, recurrence_count, severity
           FROM mistakes
           WHERE resolved = 0
             AND recurrence_count > 0
           ORDER BY recurrence_count DESC, severity DESC
           LIMIT 2`,
        )
        .all() as Array<{ description: string; recurrence_count: number; severity: string }>;

      return rows.map((r) => ({
        description: r.description.slice(0, 120),
        recurrenceCount: r.recurrence_count,
        severity: r.severity,
      }));
    } catch {
      return [];
    }
  }

  private async generateThought(): Promise<string | null> {
    if (!this.aiManager) return null;

    try {
      const db = getDatabase();
      const now = new Date();
      const dateLabel = now.toLocaleDateString('en-AU', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      });
      const timeLabel = now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });

      // Pull memories created since the last briefing (or last 24h as fallback)
      const since = this.lastBriefingDate
        ? new Date(this.lastBriefingDate + 'T00:00:00').toISOString()
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const recentRows = db
        .prepare(
          `SELECT content FROM memories
           WHERE layer IN ('episodic', 'semantic')
             AND created_at > ?
             AND importance > 0.3
           ORDER BY created_at DESC
           LIMIT 8`,
        )
        .all(since) as Array<{ content: string }>;

      // Fallback: grab most recent regardless of time window if none found
      const fallbackRows = recentRows.length === 0
        ? (db.prepare(
            `SELECT content FROM memories
             WHERE layer = 'episodic'
             ORDER BY created_at DESC
             LIMIT 5`,
          ).all() as Array<{ content: string }>)
        : [];

      const allRows = [...recentRows, ...fallbackRows];

      // Also include recent dream ideas
      const dreamIdeas = db
        .prepare(
          `SELECT content FROM memories
           WHERE tags LIKE '%dream-idea%'
           ORDER BY created_at DESC
           LIMIT 3`,
        )
        .all() as Array<{ content: string }>;

      // Pending goals
      const goals = db
        .prepare(
          `SELECT content FROM memories
           WHERE layer = 'semantic'
             AND tags LIKE '%goal%'
             AND importance > 0.6
           ORDER BY created_at DESC
           LIMIT 3`,
        )
        .all() as Array<{ content: string }>;

      const contextParts: string[] = [];
      if (allRows.length > 0) {
        contextParts.push('Recent activity:\n' + allRows.map((r) => `• ${r.content.slice(0, 180)}`).join('\n'));
      }
      if (dreamIdeas.length > 0) {
        contextParts.push('Ideas from last dream:\n' + dreamIdeas.map((r) => `• ${r.content.slice(0, 150)}`).join('\n'));
      }
      if (goals.length > 0) {
        contextParts.push('Active goals:\n' + goals.map((r) => `• ${r.content.slice(0, 150)}`).join('\n'));
      }

      const context = contextParts.join('\n\n') || 'No recent context available.';

      const response = await this.aiManager.complete({
        model: this.model,
        messages: [
          {
            role: 'user',
            content:
              `You are NEXUS, an AI agent OS running on a Mac. ` +
              `Today is ${dateLabel} at ${timeLabel}.\n\n` +
              `Based on the context below, generate ONE fresh thought for today. ` +
              `It must be specific to the context — not generic. ` +
              `Could be: a timely reminder, a useful observation, something to try today, ` +
              `or a connection between recent events. 1-2 sentences only. No preamble.\n\n` +
              `${context}`,
          },
        ],
        maxTokens: 150,
        temperature: 1.0,
      });

      // Filter: LLM-generated text that embeds raw memory content can
      // inadvertently (a) echo a prompt-injection payload the user's memory
      // stored, or (b) leak NEXUS self-disclosure (commit hashes, paths) if
      // the LLM picked those up from context. Sanitize before surfacing.
      const raw = response.content.trim();
      const promptLeakSafe = filterSystemPromptLeak(raw) ?? raw;
      const thought = redactSelfDisclosure(sanitizeEnvVars(promptLeakSafe));
      return thought.length > 10 ? thought : null;
    } catch (err) {
      log.warn({ err }, 'Failed to generate daily thought');
      return null;
    }
  }
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}
