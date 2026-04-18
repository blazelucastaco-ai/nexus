// NEXUS — Daily Briefing Engine
//
// Sends one morning greeting per day at a configurable hour. Intentionally
// minimal — just "Good morning — <date>". Dreams, thoughts, scheduled tasks,
// patterns, and mistakes are all surfaced on demand via dedicated commands
// (/dreams, /thinking, /tasks, /patterns, /mistakes); duplicating them here
// would add noise without adding value.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import type { AIManager } from '../ai/index.js';

const STATE_PATH = join(homedir(), '.nexus', 'briefing-state.json');

const log = createLogger('BriefingEngine');

export type SendFn = (message: string) => Promise<void>;

export class BriefingEngine {
  private sendFn: SendFn;
  private briefingHour: number;       // 0-23, default 8
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBriefingDate: string;   // YYYY-MM-DD, persisted to disk

  // aiManager + model accepted for API backwards-compat with orchestrator
  // construction sites; no longer used since the "thought for today"
  // feature was removed. If re-introduced later, wire them here.
  constructor(sendFn: SendFn, _aiManager?: AIManager, briefingHour = 8, _model?: string) {
    this.sendFn = sendFn;
    this.briefingHour = briefingHour;
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
    // The morning briefing is intentionally minimal — just a warm greeting
    // and the date. Dreams, thoughts, scheduled tasks, patterns, and
    // recurring mistakes are all available on demand via dedicated commands
    // (/dreams, /thinking, /tasks, /patterns, /mistakes); duplicating any
    // of them here adds noise without adding value.
    const dateStr = new Date().toLocaleDateString('en-AU', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    return `☀️ <b>Good morning — ${dateStr}</b>`;
  }
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}
