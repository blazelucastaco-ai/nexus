import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { generateId, nowISO } from '../utils/helpers.js';
import { getDatabase } from '../memory/database.js';

interface Reminder {
  id: string;
  title: string;
  message: string;
  triggerAt: string;
  recurring: boolean;
  intervalMs: number | null;
  status: 'active' | 'fired' | 'cancelled';
  createdAt: string;
  firedAt: string | null;
  firedCount: number;
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null;
  callback?: () => void;
}

export class SchedulerAgent extends BaseAgent {
  private reminders: Map<string, Reminder> = new Map();
  private onReminderFired?: (reminder: Reminder) => void;

  constructor() {
    super('scheduler', 'Creates, lists, and manages reminders and recurring tasks with persistent scheduling', [
      { name: 'create_reminder', description: 'Create a one-time reminder at a specific time' },
      { name: 'list_reminders', description: 'List all active reminders' },
      { name: 'cancel_reminder', description: 'Cancel a reminder by ID' },
      { name: 'create_recurring', description: 'Create a recurring reminder at a fixed interval' },
    ]);

    this.restoreFromDb();
  }

  /** Register a callback to be invoked whenever a reminder fires */
  setReminderCallback(cb: (reminder: Reminder) => void): void {
    this.onReminderFired = cb;
  }

  async execute(action: string, params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    this.log.info({ action, params }, 'SchedulerAgent executing');

    try {
      switch (action) {
        case 'create_reminder':
          return this.createReminder(params, start);
        case 'list_reminders':
          return this.listReminders(start);
        case 'cancel_reminder':
          return this.cancelReminder(params, start);
        case 'create_recurring':
          return this.createRecurring(params, start);
        default:
          return this.createResult(false, null, `Unknown action: ${action}`, start);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ action, error: msg }, 'SchedulerAgent failed');
      return this.createResult(false, null, msg, start);
    }
  }

  // ── Persistence ────────────────────────────────────────────────────

  /** On startup, reload active reminders from SQLite and re-arm their timers. */
  private restoreFromDb(): void {
    try {
      const db = getDatabase();
      const rows = db
        .prepare(`SELECT * FROM reminders WHERE status = 'active' ORDER BY created_at ASC`)
        .all() as Array<{
          id: string; title: string; message: string; trigger_at: string;
          recurring: number; interval_ms: number | null; status: string;
          fired_count: number; fired_at: string | null; created_at: string;
        }>;

      let restored = 0;
      for (const row of rows) {
        const reminder: Reminder = {
          id: row.id,
          title: row.title,
          message: row.message,
          triggerAt: row.trigger_at,
          recurring: row.recurring === 1,
          intervalMs: row.interval_ms,
          status: 'active',
          createdAt: row.created_at,
          firedAt: row.fired_at,
          firedCount: row.fired_count,
          timer: null,
        };

        this.reminders.set(reminder.id, reminder);
        this.armTimer(reminder);
        restored++;
      }

      if (restored > 0) {
        this.log.info({ restored }, 'Reminders restored from DB');
      }
    } catch (err) {
      this.log.warn({ err }, 'Could not restore reminders from DB');
    }
  }

  private persistReminder(r: Reminder): void {
    try {
      const db = getDatabase();
      db.prepare(`
        INSERT OR REPLACE INTO reminders
          (id, title, message, trigger_at, recurring, interval_ms, status, fired_count, fired_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        r.id, r.title, r.message, r.triggerAt,
        r.recurring ? 1 : 0, r.intervalMs ?? null,
        r.status, r.firedCount, r.firedAt, r.createdAt,
      );
    } catch (err) {
      this.log.warn({ err }, 'Failed to persist reminder');
    }
  }

  private updateDbStatus(id: string, status: string, firedAt?: string, firedCount?: number): void {
    try {
      const db = getDatabase();
      db.prepare(`
        UPDATE reminders SET status = ?, fired_at = COALESCE(?, fired_at), fired_count = COALESCE(?, fired_count)
        WHERE id = ?
      `).run(status, firedAt ?? null, firedCount ?? null, id);
    } catch (err) {
      this.log.warn({ err }, 'Failed to update reminder status in DB');
    }
  }

  // ── Timer logic ────────────────────────────────────────────────────

  /** Arms the correct timer type for a reminder. */
  private armTimer(reminder: Reminder): void {
    if (reminder.recurring && reminder.intervalMs) {
      const now = Date.now();
      const triggerTime = new Date(reminder.triggerAt).getTime();

      if (triggerTime > now) {
        // Delay first fire, then start interval
        reminder.timer = setTimeout(() => {
          this.fireReminder(reminder.id);
          reminder.timer = setInterval(() => this.fireReminder(reminder.id), reminder.intervalMs!);
        }, triggerTime - now);
      } else {
        // Already past start — fire immediately and set interval
        this.fireReminder(reminder.id);
        reminder.timer = setInterval(() => this.fireReminder(reminder.id), reminder.intervalMs);
      }
    } else {
      // One-time
      const delayMs = new Date(reminder.triggerAt).getTime() - Date.now();
      if (delayMs <= 0) {
        // Overdue — fire immediately
        setTimeout(() => this.fireReminder(reminder.id), 0);
      } else {
        reminder.timer = setTimeout(() => this.fireReminder(reminder.id), delayMs);
      }
    }
  }

  // ── Actions ────────────────────────────────────────────────────────

  private createReminder(params: Record<string, unknown>, start: number): AgentResult {
    const title = String(params.title ?? 'Reminder');
    const message = String(params.message ?? '');
    const triggerAt = String(params.triggerAt ?? params.time ?? '');

    if (!triggerAt) {
      return this.createResult(false, null, 'triggerAt time is required', start);
    }

    const triggerDate = new Date(triggerAt);
    const delayMs = triggerDate.getTime() - Date.now();

    if (delayMs < 0) {
      return this.createResult(false, null, 'Trigger time is in the past', start);
    }

    const id = generateId();
    const reminder: Reminder = {
      id, title, message, triggerAt,
      recurring: false, intervalMs: null,
      status: 'active', createdAt: nowISO(),
      firedAt: null, firedCount: 0, timer: null,
    };

    this.reminders.set(id, reminder);
    this.persistReminder(reminder);
    this.armTimer(reminder);

    this.log.info({ id, title, triggerAt, delayMs }, 'Reminder created');
    return this.createResult(true, {
      id, title, message, triggerAt,
      delayMinutes: (delayMs / 60_000).toFixed(1),
      status: 'active', createdAt: reminder.createdAt,
    }, undefined, start);
  }

  private listReminders(start: number): AgentResult {
    const reminders = Array.from(this.reminders.values()).map((r) => ({
      id: r.id, title: r.title, message: r.message, triggerAt: r.triggerAt,
      recurring: r.recurring, intervalMs: r.intervalMs, status: r.status,
      firedCount: r.firedCount, firedAt: r.firedAt, createdAt: r.createdAt,
    }));

    const active = reminders.filter((r) => r.status === 'active');
    const fired = reminders.filter((r) => r.status === 'fired');
    const cancelled = reminders.filter((r) => r.status === 'cancelled');

    return this.createResult(true, {
      total: reminders.length, active: active.length,
      fired: fired.length, cancelled: cancelled.length, reminders,
    }, undefined, start);
  }

  private cancelReminder(params: Record<string, unknown>, start: number): AgentResult {
    const id = String(params.id);
    const reminder = this.reminders.get(id);

    if (!reminder) {
      return this.createResult(false, null, `Reminder not found: ${id}`, start);
    }
    if (reminder.status !== 'active') {
      return this.createResult(false, null, `Reminder is already ${reminder.status}`, start);
    }

    if (reminder.timer) {
      if (reminder.recurring) clearInterval(reminder.timer as ReturnType<typeof setInterval>);
      else clearTimeout(reminder.timer as ReturnType<typeof setTimeout>);
    }

    reminder.status = 'cancelled';
    reminder.timer = null;
    this.updateDbStatus(id, 'cancelled');

    this.log.info({ id, title: reminder.title }, 'Reminder cancelled');
    return this.createResult(true, { id, title: reminder.title, status: 'cancelled', cancelledAt: nowISO() }, undefined, start);
  }

  private createRecurring(params: Record<string, unknown>, start: number): AgentResult {
    const title = String(params.title ?? 'Recurring Reminder');
    const message = String(params.message ?? '');
    const intervalMinutes = Number(params.intervalMinutes ?? params.interval ?? 60);
    const startAt = params.startAt ? String(params.startAt) : undefined;

    if (intervalMinutes < 1) {
      return this.createResult(false, null, 'Interval must be at least 1 minute', start);
    }

    const intervalMs = intervalMinutes * 60_000;
    const id = generateId();
    const reminder: Reminder = {
      id, title, message,
      triggerAt: startAt ?? nowISO(),
      recurring: true, intervalMs,
      status: 'active', createdAt: nowISO(),
      firedAt: null, firedCount: 0, timer: null,
    };

    this.reminders.set(id, reminder);
    this.persistReminder(reminder);
    this.armTimer(reminder);

    this.log.info({ id, title, intervalMinutes }, 'Recurring reminder created');
    return this.createResult(true, {
      id, title, message, recurring: true, intervalMinutes,
      status: 'active', createdAt: reminder.createdAt,
    }, undefined, start);
  }

  private fireReminder(id: string): void {
    const reminder = this.reminders.get(id);
    if (!reminder || reminder.status !== 'active') return;

    reminder.firedAt = nowISO();
    reminder.firedCount += 1;

    if (!reminder.recurring) {
      reminder.status = 'fired';
      reminder.timer = null;
    }

    this.updateDbStatus(id, reminder.status, reminder.firedAt, reminder.firedCount);

    this.log.info({ id, title: reminder.title, firedCount: reminder.firedCount }, 'Reminder fired');

    if (this.onReminderFired) this.onReminderFired(reminder);
    if (reminder.callback) reminder.callback();
  }

  /** Clean up all timers on graceful shutdown */
  destroy(): void {
    for (const reminder of this.reminders.values()) {
      if (reminder.timer) {
        if (reminder.recurring) clearInterval(reminder.timer as ReturnType<typeof setInterval>);
        else clearTimeout(reminder.timer as ReturnType<typeof setTimeout>);
        reminder.timer = null;
      }
    }
    this.reminders.clear();
  }
}
