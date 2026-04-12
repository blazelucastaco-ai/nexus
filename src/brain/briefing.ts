// NEXUS — Daily Briefing Engine
//
// Sends one morning message per day at a configurable hour.
// Content: last dream summary, today's scheduled tasks,
//          most confident pattern detected, and an LLM-generated
//          "thought for the day" based on recent memory context.

import { createLogger } from '../utils/logger.js';
import { getDatabase } from '../memory/database.js';
import type { AIManager } from '../ai/index.js';

const log = createLogger('BriefingEngine');

export type SendFn = (message: string) => Promise<void>;

export class BriefingEngine {
  private sendFn: SendFn;
  private aiManager: AIManager | null;
  private briefingHour: number;       // 0-23, default 8
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBriefingDate: string = ''; // YYYY-MM-DD

  constructor(sendFn: SendFn, aiManager?: AIManager, briefingHour = 8) {
    this.sendFn = sendFn;
    this.aiManager = aiManager ?? null;
    this.briefingHour = briefingHour;
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
    this.lastBriefingDate = todayString();
  }

  // ── Internal ───────────────────────────────────────────────────────

  private async maybeSendBriefing(): Promise<void> {
    const now = new Date();
    const today = todayString();

    if (now.getHours() !== this.briefingHour) return;
    if (this.lastBriefingDate === today) return;  // already sent today

    this.lastBriefingDate = today;
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
    try {
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
    } catch {
      return null;
    }
  }

  private getScheduledTasksForToday(): string[] {
    try {
      const db = getDatabase();
      const rows = db
        .prepare(
          `SELECT name, schedule FROM scheduled_tasks
           WHERE enabled = 1
           ORDER BY next_run ASC
           LIMIT 5`,
        )
        .all() as Array<{ name: string; schedule: string }>;

      return rows.map((r) => `${r.name} <i>(${r.schedule})</i>`);
    } catch {
      return [];
    }
  }

  private getTopPattern(): string | null {
    try {
      const db = getDatabase();
      // Pull recent semantic memories tagged as dream-reflection to look for patterns
      const rows = db
        .prepare(
          `SELECT content FROM memories
           WHERE layer = 'semantic'
             AND tags LIKE '%consolidated%'
           ORDER BY importance DESC, created_at DESC
           LIMIT 1`,
        )
        .get() as { content: string } | undefined;

      if (!rows) return null;
      const text = rows.content.length > 200
        ? rows.content.slice(0, 200) + '…'
        : rows.content;
      return text;
    } catch {
      return null;
    }
  }

  private async generateThought(): Promise<string | null> {
    if (!this.aiManager) return null;

    try {
      // Gather a tiny slice of recent memory for context
      const db = getDatabase();
      const recentRows = db
        .prepare(
          `SELECT content FROM memories
           WHERE layer = 'episodic'
             AND importance > 0.5
           ORDER BY created_at DESC
           LIMIT 5`,
        )
        .all() as Array<{ content: string }>;

      const context = recentRows
        .map((r) => r.content.slice(0, 200))
        .join('\n');

      const response = await this.aiManager.complete({
        messages: [
          {
            role: 'user',
            content:
              `You are NEXUS, an AI that lives on a Mac and helps its owner. ` +
              `Based on recent context, generate one short, useful, or interesting ` +
              `thought for today — could be a reminder, an observation, a suggestion, ` +
              `or something to consider. Keep it to 1-2 sentences. No preamble.\n\n` +
              `Recent context:\n${context || 'No recent context available.'}`,
          },
        ],
        maxTokens: 150,
        temperature: 0.9,
      });

      const thought = response.content.trim();
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
