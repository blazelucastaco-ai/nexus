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
  /** When set, this task runs the natural-language prompt through NEXUS's
   *  message handler at the scheduled time and sends the response back
   *  via Telegram. Mutually exclusive with `command` (only one fires). */
  prompt: string | null;
  /** Telegram chat ID the response is delivered to. Required for prompt
   *  tasks. Schema added in migration v11 (2026-05-11). */
  chat_id: string | null;
}

const MAX_CONSECUTIVE_FAILURES = 5;

let tickInterval: ReturnType<typeof setInterval> | null = null;
let initialTickTimeout: ReturnType<typeof setTimeout> | null = null;
/** Callback invoked when a SHELL task fires — wired to run_terminal_command */
let taskRunner: ((command: string) => Promise<string>) | null = null;
/** Callback invoked when a PROMPT task fires — wired to the orchestrator's
 *  message handler so NEXUS processes the prompt as if the user had typed
 *  it, and the response is sent back via Telegram to chat_id. */
let promptRunner: ((prompt: string, chatId: string) => Promise<void>) | null = null;

/** Wire the scheduler to the tool executor's run_terminal_command */
export function setTaskRunner(fn: (command: string) => Promise<string>): void {
  taskRunner = fn;
}

/** Wire the scheduler to the orchestrator's message handler for prompt tasks. */
export function setPromptRunner(fn: (prompt: string, chatId: string) => Promise<void>): void {
  promptRunner = fn;
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

  log.info({ id, name, cronExpr, command }, 'Scheduled task created (shell)');
  return getTask(id)!;
}

/**
 * Create a PROMPT-based scheduled task. At trigger time the orchestrator
 * processes the prompt as if the user had typed it, and the response is
 * sent back via Telegram to chatId. Example: "every day at 6am, check my
 * calendar and tell me my schedule" — prompt="Check my calendar and tell
 * me my schedule for today", cron="0 6 * * *", chatId=Lucas's chat.
 */
export function createPromptTask(
  name: string,
  cronExpr: string,
  prompt: string,
  chatId: string,
): ScheduledTask {
  const db = getDatabase();
  matchesCron(cronExpr, new Date()); // validate shape

  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = nowISO();
  const nextRun = nextRunAfter(cronExpr, new Date());

  // command stores empty string because the column was NOT NULL in the
  // original schema and SQLite can't drop NOT NULL via ALTER. We
  // distinguish by checking which of (prompt, command) is non-empty.
  db.prepare(`
    INSERT INTO scheduled_tasks (id, name, cron_expression, command, prompt, chat_id, enabled, last_run, next_run, created_at)
    VALUES (?, ?, ?, '', ?, ?, 1, NULL, ?, ?)
  `).run(id, name, cronExpr, prompt, chatId, nextRun?.toISOString() ?? null, now);

  log.info({ id, name, cronExpr, prompt: prompt.slice(0, 80), chatId }, 'Scheduled task created (prompt)');
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

// ── Tick Loop ─────────────────────────────────────────────────────────────────

export function startScheduler(): void {
  if (tickInterval) return;

  log.info('Starting cron scheduler (60s tick)');
  tickInterval = setInterval(tick, 60_000);
  // Run once immediately after a brief delay to pick up overdue tasks
  initialTickTimeout = setTimeout(tick, 5_000);
}

export function stopScheduler(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  if (initialTickTimeout) {
    clearTimeout(initialTickTimeout);
    initialTickTimeout = null;
  }
  log.info('Scheduler stopped');
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

    // Decide which runner to use: prompt-based tasks route through the
    // orchestrator's message handler so NEXUS processes them with full
    // context, memory, and Telegram delivery. Shell tasks use the legacy
    // run_terminal_command path.
    const isPromptTask = !!(task.prompt && task.prompt.trim());

    if (isPromptTask) {
      if (!promptRunner) {
        log.warn({ name: task.name }, 'Prompt task fired but no prompt runner configured — skipping');
        continue;
      }
      if (!task.chat_id) {
        log.warn({ name: task.name }, 'Prompt task missing chat_id — skipping');
        continue;
      }
    } else if (!taskRunner) {
      log.warn({ name: task.name }, 'No task runner configured — skipping execution');
      continue;
    }

    try {
      let resultPreview = '';
      if (isPromptTask) {
        await promptRunner!(task.prompt!, task.chat_id!);
        resultPreview = `(prompt) ${task.prompt!.slice(0, 80)}`;
      } else {
        const result = await taskRunner!(task.command);
        resultPreview = result.slice(0, 200);
      }
      const durationMs = Date.now() - startMs;

      db.prepare(`
        UPDATE scheduled_tasks
        SET last_exit_code = 0, last_duration_ms = ?, consecutive_failures = 0
        WHERE id = ?
      `).run(durationMs, task.id);

      log.info({ name: task.name, durationMs, kind: isPromptTask ? 'prompt' : 'command', result: resultPreview }, 'Task completed');
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
    return 'No scheduled tasks. Use schedule_task (shell) or schedule_prompt (natural-language) to create one.';
  }

  const lines = [`Scheduled tasks (${tasks.length}):\n`];
  for (const t of tasks) {
    const status = t.enabled ? '✓ enabled' : '✗ disabled';
    const isPrompt = !!(t.prompt && t.prompt.trim());
    const kind = isPrompt ? 'prompt' : 'shell';
    lines.push(`  [${status}] ${t.name}  (${kind})`);
    lines.push(`    Cron: ${t.cron_expression}`);
    if (isPrompt) {
      lines.push(`    Prompt: ${t.prompt}`);
    } else {
      lines.push(`    Command: ${t.command}`);
    }
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

/**
 * Schedule a NEXUS natural-language prompt to run on a cron schedule.
 * At each firing the prompt is processed through the orchestrator's
 * message handler exactly as if the user had typed it; the response is
 * delivered to chatId via Telegram. Example: "every day at 6am, check
 * my calendar and tell me my schedule" — prompt = "Check my calendar
 * and tell me my schedule for today", cron = "0 6 * * *", chatId =
 * Lucas's chat ID.
 */
export function schedulePromptTool(args: Record<string, unknown>, contextChatId?: string): string {
  const name = String(args.name ?? '');
  const cron = String(args.cron ?? args.cron_expression ?? '');
  const prompt = String(args.prompt ?? '');
  const chatId = String(args.chat_id ?? args.chatId ?? contextChatId ?? '');

  if (!name || !cron || !prompt) {
    return 'Error: schedule_prompt requires name, cron, and prompt';
  }
  if (!chatId) {
    return 'Error: schedule_prompt requires chat_id (the user\'s Telegram chat ID). The chat-mode tool context normally supplies it; if you see this error it means the tool was called outside a chat context.';
  }

  const existing = getTaskByName(name);
  if (existing) {
    return `Error: A task named "${name}" already exists (id: ${existing.id}). Use cancel_task first to replace it.`;
  }

  const task = createPromptTask(name, cron, prompt, chatId);
  return `Prompt scheduled: "${task.name}" (${task.cron_expression})\nPrompt: ${task.prompt}\nNext run: ${task.next_run ?? 'unknown'}\nID: ${task.id}`;
}

export function cancelTaskTool(args: Record<string, unknown>): string {
  const idOrName = String(args.id ?? args.name ?? '');
  if (!idOrName) return 'Error: cancel_task requires id or name';

  const ok = cancelTask(idOrName);
  if (ok) return `Task "${idOrName}" disabled successfully.`;
  return `Error: No task found with id or name "${idOrName}"`;
}
