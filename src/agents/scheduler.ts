import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { generateId, nowISO } from '../utils/helpers.js';

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
    super('scheduler', 'Creates, lists, and manages reminders and recurring tasks with in-memory scheduling', [
      { name: 'create_reminder', description: 'Create a one-time reminder at a specific time' },
      { name: 'list_reminders', description: 'List all active reminders' },
      { name: 'cancel_reminder', description: 'Cancel a reminder by ID' },
      { name: 'create_recurring', description: 'Create a recurring reminder at a fixed interval' },
    ]);
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
      id,
      title,
      message,
      triggerAt,
      recurring: false,
      intervalMs: null,
      status: 'active',
      createdAt: nowISO(),
      firedAt: null,
      firedCount: 0,
      timer: null,
    };

    reminder.timer = setTimeout(() => {
      this.fireReminder(id);
    }, delayMs);

    this.reminders.set(id, reminder);
    this.log.info({ id, title, triggerAt, delayMs }, 'Reminder created');

    return this.createResult(
      true,
      {
        id,
        title,
        message,
        triggerAt,
        delayMinutes: (delayMs / 60_000).toFixed(1),
        status: 'active',
        createdAt: reminder.createdAt,
      },
      undefined,
      start,
    );
  }

  private listReminders(start: number): AgentResult {
    const reminders = Array.from(this.reminders.values()).map((r) => ({
      id: r.id,
      title: r.title,
      message: r.message,
      triggerAt: r.triggerAt,
      recurring: r.recurring,
      intervalMs: r.intervalMs,
      status: r.status,
      firedCount: r.firedCount,
      firedAt: r.firedAt,
      createdAt: r.createdAt,
    }));

    const active = reminders.filter((r) => r.status === 'active');
    const fired = reminders.filter((r) => r.status === 'fired');
    const cancelled = reminders.filter((r) => r.status === 'cancelled');

    return this.createResult(
      true,
      {
        total: reminders.length,
        active: active.length,
        fired: fired.length,
        cancelled: cancelled.length,
        reminders,
      },
      undefined,
      start,
    );
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
      if (reminder.recurring) {
        clearInterval(reminder.timer as ReturnType<typeof setInterval>);
      } else {
        clearTimeout(reminder.timer as ReturnType<typeof setTimeout>);
      }
    }

    reminder.status = 'cancelled';
    reminder.timer = null;

    this.log.info({ id, title: reminder.title }, 'Reminder cancelled');
    return this.createResult(
      true,
      { id, title: reminder.title, status: 'cancelled', cancelledAt: nowISO() },
      undefined,
      start,
    );
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
      id,
      title,
      message,
      triggerAt: startAt ?? nowISO(),
      recurring: true,
      intervalMs,
      status: 'active',
      createdAt: nowISO(),
      firedAt: null,
      firedCount: 0,
      timer: null,
    };

    const startTimer = (): void => {
      reminder.timer = setInterval(() => {
        this.fireReminder(id);
      }, intervalMs);
    };

    if (startAt) {
      const delayMs = new Date(startAt).getTime() - Date.now();
      if (delayMs > 0) {
        // Delay the first firing, then start the interval
        reminder.timer = setTimeout(() => {
          this.fireReminder(id);
          startTimer();
        }, delayMs);
      } else {
        // Start immediately
        this.fireReminder(id);
        startTimer();
      }
    } else {
      startTimer();
    }

    this.reminders.set(id, reminder);
    this.log.info({ id, title, intervalMinutes }, 'Recurring reminder created');

    return this.createResult(
      true,
      {
        id,
        title,
        message,
        recurring: true,
        intervalMinutes,
        status: 'active',
        createdAt: reminder.createdAt,
      },
      undefined,
      start,
    );
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

    this.log.info({ id, title: reminder.title, firedCount: reminder.firedCount }, 'Reminder fired');

    if (this.onReminderFired) {
      this.onReminderFired(reminder);
    }

    if (reminder.callback) {
      reminder.callback();
    }
  }

  /** Clean up all timers (for graceful shutdown) */
  destroy(): void {
    for (const reminder of this.reminders.values()) {
      if (reminder.timer) {
        if (reminder.recurring) {
          clearInterval(reminder.timer as ReturnType<typeof setInterval>);
        } else {
          clearTimeout(reminder.timer as ReturnType<typeof setTimeout>);
        }
        reminder.timer = null;
      }
    }
    this.reminders.clear();
  }
}
