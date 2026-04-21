// Heartbeat — periodic "I'm alive" signal from the main orchestrator.
//
// Every HEARTBEAT_INTERVAL_MS the main agent emits:
//   - a log line (for `tail -f ~/.nexus/nexus.log`)
//   - a `heartbeat` event on the bus (for subscribers — dashboard, menubar, …)
//
// The heartbeat is paused during the dream window (2am–5am local). The dream
// cycle is already a "something is happening" signal, and a heartbeat on top
// would just add noise.
//
// Only the main orchestrator emits heartbeats. Sub-agents don't — they
// complete a single turn and exit.

import { getDatabase } from '../memory/database.js';
import { events } from '../core/events.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Heartbeat');

export interface HeartbeatOptions {
  intervalMs?: number;
  nightWindow?: { startHour: number; endHour: number };
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_NIGHT_WINDOW = { startHour: 2, endHour: 5 }; // 2am inclusive → 5am exclusive

export class Heartbeat {
  private readonly intervalMs: number;
  private readonly nightWindow: { startHour: number; endHour: number };
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private getMood: () => number = () => 0;
  private getLastMessageAt: () => string | undefined = () => undefined;

  constructor(opts: HeartbeatOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.nightWindow = opts.nightWindow ?? DEFAULT_NIGHT_WINDOW;
  }

  /** Wire up accessors for live state the orchestrator has but we don't. */
  setStateAccessors(opts: {
    mood?: () => number;
    lastMessageAt?: () => string | undefined;
  }): void {
    if (opts.mood) this.getMood = opts.mood;
    if (opts.lastMessageAt) this.getLastMessageAt = opts.lastMessageAt;
  }

  start(): void {
    if (this.timer) return;
    // Fire a first beat ~30s after start so logs have a clear "I'm up" marker,
    // then settle into the regular cadence.
    const kick = setTimeout(() => this.tick(), 30_000);
    kick.unref?.();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    log.info(
      { intervalMs: this.intervalMs, nightWindow: this.nightWindow },
      'Heartbeat started',
    );
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    log.info('Heartbeat stopped');
  }

  /**
   * True when the current local time is inside the dream window — the
   * heartbeat should stay quiet there so the dream pass owns the airwaves.
   */
  private isInDreamWindow(): boolean {
    const h = new Date().getHours();
    return h >= this.nightWindow.startHour && h < this.nightWindow.endHour;
  }

  private tick(): void {
    if (this.isInDreamWindow()) {
      log.debug('Heartbeat skipped — inside dream window');
      return;
    }

    let memoryCount = 0;
    let sessionCount = 0;
    try {
      const db = getDatabase();
      memoryCount =
        (db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number } | undefined)?.n ?? 0;
      sessionCount =
        (db.prepare('SELECT COUNT(DISTINCT chat_id) as n FROM sessions').get() as { n: number } | undefined)?.n ?? 0;
    } catch {
      // DB not open yet or schema missing — just emit uptime.
    }

    const uptimeSec = Math.floor((Date.now() - this.startedAt) / 1000);
    const mood = clamp(this.getMood(), -1, 1);
    const lastMessageAt = this.getLastMessageAt();

    log.info(
      { uptimeSec, memoryCount, sessionCount, mood: mood.toFixed(2), lastMessageAt },
      'heartbeat',
    );
    events.emit({
      type: 'heartbeat',
      uptimeSec,
      memoryCount,
      sessionCount,
      mood,
      lastMessageAt,
    });
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(hi, Math.max(lo, n));
}
