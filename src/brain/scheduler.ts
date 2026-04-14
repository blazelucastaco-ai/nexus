// NEXUS Cron Scheduler — run tasks on a schedule via SQLite-backed cron expressions
//
// Parses cron expressions (minute hour dom month dow) and fires tasks
// using setInterval checks every 60 seconds.

import { createLogger } from '../utils/logger.js';
import { getDatabase } from '../memory/database.js';
import { nowISO } from '../utils/helpers.js';

const log = createLogger('Scheduler');

export interface ScheduledTask {
  id: string;
  name: string;
  cron_expression: string;
  command: string;
  enabled: number; // 0 | 1
  last_run: string | null;
  next_run: string | null;
  created_at: string;
  last_exit_code: number | null;
  last_duration_ms: number | null;
  consecutive_failures: number;
}

const MAX_CONSECUTIVE_FAILURES = 5;

let tickInterval: ReturnType<typeof setInterval> | null = null;
/** Callback invoked when a task fires — wired to the tool executor at startup */
let taskRunner: ((command: string) => Promise<string>) | null = null;

/** Wire the scheduler to the tool executor's run_terminal_command */
export function setTaskRunner(fn: (command: string) => Promise<string>): void {
  taskRunner = fn;
}

// ── Schema ────────────────────────────────────────────────────────────────────

export function ensureSchedulerSchema(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL UNIQUE,
      cron_expression  TEXT NOT NULL,
      command          TEXT NOT NULL,
      enabled          INTEGER NOT NULL DEFAULT 1,
      last_run         TEXT,
      next_run         TEXT,
      created_at       TEXT NOT NULL
    );
  `);
  log.info('Scheduler schema ready');
}

// ── Cron Parsing ──────────────────────────────────────────────────────────────

/**
 * Minimal cron parser: "minute hour dom month dow"
 * Supports: * (any), numbers, /step, comma-separated lists.
 * Returns true if the given Date matches the expression.
 */
export function matchesCron(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minPart, hourPart, domPart, monthPart, dowPart] = parts as [
    string, string, string, string, string
  ];

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // 1-12
  const dow = date.getDay(); // 0=Sun

  return (
    matchField(minPart, minute, 0, 59) &&
    matchField(hourPart, hour, 0, 23) &&
    matchField(domPart, dom, 1, 31) &&
    matchField(monthPart, month, 1, 12) &&
    matchField(dowPart, dow, 0, 6)
  );
}

function matchField(field: string, value: number, _min: number, max: number): boolean {
  if (field === '*') return true;

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [base, stepStr] = part.split('/');
      const step = parseInt(stepStr ?? '1', 10);
      const start = base === '*' ? 0 : parseInt(base ?? '0', 10);
      for (let v = start; v <= max; v += step) {
        if (v === value) return true;
      }
    } else if (part.includes('-')) {
      const [from, to] = part.split('-').map(Number);
      if (value >= (from ?? 0) && value <= (to ?? max)) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

/** Compute approximate next run time for display purposes */
export function nextRunAfter(expr: string, after: Date): Date | null {
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (matchesCron(expr, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function createTask(
  name: string,
  cronExpr: string,
  command: string,
): ScheduledTask {
  const db = getDatabase();

  // Validate cron expression
  const testDate = new Date();
  matchesCron(cronExpr, testDate); // will silently return false for bad exprs

  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = nowISO();
  const nextRun = nextRunAfter(cronExpr, new Date());

  db.prepare(`
    INSERT INTO scheduled_tasks (id, name, cron_expression, command, enabled, last_run, next_run, created_at)
    VALUES (?, ?, ?, ?, 1, NULL, ?, ?)
  `).run(id, name, cronExpr, command, nextRun?.toISOString() ?? null, now);

  log.info({ id, name, cronExpr, command }, 'Scheduled task created');
  return getTask(id)!;
}

export function getTask(id: string): ScheduledTask | null {
  const db = getDatabase();
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | null;
}

export function getTaskByName(name: string): ScheduledTask | null {
  const db = getDatabase();
  return db.prepare('SELECT * FROM scheduled_tasks WHERE name = ?').get(name) as ScheduledTask | null;
}

export function listTasks(): ScheduledTask[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[];
}

export function cancelTask(idOrName: string): boolean {
  const db = getDatabase();
  const byId = db.prepare('UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?').run(idOrName);
  if (byId.changes > 0) {
    log.info({ id: idOrName }, 'Task disabled');
    return true;
  }
  const byName = db.prepare('UPDATE scheduled_tasks SET enabled = 0 WHERE name = ?').run(idOrName);
  if (byName.changes > 0) {
    log.info({ name: idOrName }, 'Task disabled by name');
    return true;
  }
  return false;
}

export function deleteTask(idOrName: string): boolean {
  const db = getDatabase();
  const byId = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(idOrName);
  if (byId.changes > 0) return true;
  const byName = db.prepare('DELETE FROM scheduled_tasks WHERE name = ?').run(idOrName);
  return byName.changes > 0;
}

// ── Tick Loop ─────────────────────────────────────────────────────────────────

export function startScheduler(): void {
  if (tickInterval) return;

  log.info('Starting cron scheduler (60s tick)');
  tickInterval = setInterval(tick, 60_000);
  // Run once immediately after a brief delay to pick up overdue tasks
  setTimeout(tick, 5_000);
}

export function stopScheduler(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
    log.info('Scheduler stopped');
  }
}

async function tick(): Promise<void> {
  const now = new Date();
  const tasks = listTasks().filter((t) => t.enabled === 1);

  for (const task of tasks) {
    if (!matchesCron(task.cron_expression, now)) continue;

    log.info({ name: task.name, command: task.command }, 'Running scheduled task');

    const db = getDatabase();
    const nextRun = nextRunAfter(task.cron_expression, now);
    const startMs = Date.now();

    // Update last_run and next_run immediately so re-entrant ticks don't double-fire
    db.prepare(`
      UPDATE scheduled_tasks SET last_run = ?, next_run = ? WHERE id = ?
    `).run(nowISO(), nextRun?.toISOString() ?? null, task.id);

    if (!taskRunner) {
      log.warn({ name: task.name }, 'No task runner configured — skipping execution');
      continue;
    }

    try {
      const result = await taskRunner(task.command);
      const durationMs = Date.now() - startMs;

      db.prepare(`
        UPDATE scheduled_tasks
        SET last_exit_code = 0, last_duration_ms = ?, consecutive_failures = 0
        WHERE id = ?
      `).run(durationMs, task.id);

      log.info({ name: task.name, durationMs, result: result.slice(0, 200) }, 'Task completed');
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const newFailures = (task.consecutive_failures ?? 0) + 1;

      if (newFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Auto-disable — too many consecutive failures
        db.prepare(`
          UPDATE scheduled_tasks
          SET last_exit_code = 1, last_duration_ms = ?, consecutive_failures = ?, enabled = 0
          WHERE id = ?
        `).run(durationMs, newFailures, task.id);

        log.error(
          { name: task.name, newFailures, err },
          `Task auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
        );
      } else {
        db.prepare(`
          UPDATE scheduled_tasks
          SET last_exit_code = 1, last_duration_ms = ?, consecutive_failures = ?
          WHERE id = ?
        `).run(durationMs, newFailures, task.id);

        log.error({ name: task.name, newFailures, err }, 'Task failed');
      }
    }
  }
}

// ── Tool Helpers ──────────────────────────────────────────────────────────────

export function scheduleTaskTool(args: Record<string, unknown>): string {
  const name = String(args.name ?? '');
  const cron = String(args.cron ?? args.cron_expression ?? '');
  const command = String(args.command ?? '');

  if (!name || !cron || !command) {
    return 'Error: schedule_task requires name, cron, and command';
  }

  // Check for duplicate name
  const existing = getTaskByName(name);
  if (existing) {
    return `Error: A task named "${name}" already exists (id: ${existing.id}). Use cancel_task first to replace it.`;
  }

  const task = createTask(name, cron, command);
  return `Task scheduled: "${task.name}" (${task.cron_expression})\nCommand: ${task.command}\nNext run: ${task.next_run ?? 'unknown'}\nID: ${task.id}`;
}

export function listTasksTool(): string {
  const tasks = listTasks();
  if (tasks.length === 0) {
    return 'No scheduled tasks. Use schedule_task to create one.';
  }

  const lines = [`Scheduled tasks (${tasks.length}):\n`];
  for (const t of tasks) {
    const status = t.enabled ? '✓ enabled' : '✗ disabled';
    lines.push(`  [${status}] ${t.name}`);
    lines.push(`    Cron: ${t.cron_expression}`);
    lines.push(`    Command: ${t.command}`);
    lines.push(`    Last run: ${t.last_run ?? 'never'}`);
    lines.push(`    Next run: ${t.next_run ?? 'unknown'}`);
    if (t.last_duration_ms != null) {
      const exitLabel = t.last_exit_code === 0 ? '✓' : `✗ (code ${t.last_exit_code})`;
      lines.push(`    Last result: ${exitLabel} in ${t.last_duration_ms}ms`);
    }
    if ((t.consecutive_failures ?? 0) > 0) {
      lines.push(`    Consecutive failures: ${t.consecutive_failures}`);
    }
    lines.push(`    ID: ${t.id}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function cancelTaskTool(args: Record<string, unknown>): string {
  const idOrName = String(args.id ?? args.name ?? '');
  if (!idOrName) return 'Error: cancel_task requires id or name';

  const ok = cancelTask(idOrName);
  if (ok) return `Task "${idOrName}" disabled successfully.`;
  return `Error: No task found with id or name "${idOrName}"`;
}
