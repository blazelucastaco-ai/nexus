// Task Journal — append-only JSONL log of every tool call + result.
// Subscribes to the NEXUS event bus ('tool.executed', 'tool.error') to capture
// all tool activity. Backward-compat afterHook factory still exported.
// View with: cat ~/.nexus/task-journal.jsonl | tail -20

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { events } from '../core/events.js';

const log = createLogger('TaskJournal');

const JOURNAL_DIR = join(homedir(), '.nexus');
const JOURNAL_FILE = join(JOURNAL_DIR, 'task-journal.jsonl');
const MAX_RESULT_CHARS = 500;

export interface JournalEntry {
  timestamp: string;
  toolName: string;
  params: Record<string, unknown>;
  result: string;
  success: boolean;
}

/** Sanitize params — redact obvious secrets */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    const key = k.toLowerCase();
    if (key.includes('token') || key.includes('secret') || key.includes('password') || key.includes('key') || key.includes('auth') || key.includes('bearer')) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

let dirEnsured = false;

async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  await mkdir(JOURNAL_DIR, { recursive: true });
  dirEnsured = true;
}

export async function appendJournalEntry(
  toolName: string,
  params: Record<string, unknown>,
  result: string,
): Promise<void> {
  try {
    await ensureDir();

    const truncatedResult = result.length > MAX_RESULT_CHARS
      ? result.slice(0, MAX_RESULT_CHARS) + '…'
      : result;

    const entry: JournalEntry = {
      timestamp: new Date().toISOString(),
      toolName,
      params: sanitizeParams(params),
      result: truncatedResult,
      success: !result.startsWith('Error:') && !result.startsWith('Command rejected'),
    };

    await appendFile(JOURNAL_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    // Never let journal failures crash tool execution
    log.warn({ err, toolName }, 'Failed to append journal entry');
  }
}

/**
 * Journal health tracking — if writes fail repeatedly (e.g. disk full,
 * permission loss), we stop attempting and surface the failure once.
 */
let journalHealthy = true;
let journalFailureCount = 0;
const JOURNAL_FAILURE_THRESHOLD = 5;

/**
 * [DEPRECATED — kept for backward compat] Returns the afterHook function.
 * Prefer subscribing via `subscribeJournalToEvents()` in subsystem init.
 * This hook style required explicit wiring in orchestrator.init; the event
 * bus version is declarative.
 */
export function makeJournalHook() {
  return (toolName: string, params: Record<string, unknown>, result?: string) => {
    writeJournalEntryWithHealthTracking(toolName, params, result ?? '');
  };
}

/**
 * Subscribe the journal to tool execution events on the NEXUS event bus.
 * Call this once during system init — no need to wire afterHooks.
 * Returns the subscription so it can be cleanly stopped on shutdown.
 */
export function subscribeJournalToEvents(): { unsubscribe(): void }[] {
  const subs: { unsubscribe(): void }[] = [];

  subs.push(events.on('tool.executed', (e) => {
    writeJournalEntryWithHealthTracking(e.toolName, e.params ?? {}, `(ok, ${e.durationMs}ms, ${e.resultLen} chars)`);
  }));
  subs.push(events.on('tool.error', (e) => {
    writeJournalEntryWithHealthTracking(e.toolName, e.params ?? {}, `Error: ${e.error}`);
  }));

  return subs;
}

function writeJournalEntryWithHealthTracking(toolName: string, params: Record<string, unknown>, result: string): void {
  if (!journalHealthy) return;
  appendJournalEntry(toolName, params, result).catch((err) => {
    journalFailureCount++;
    if (journalFailureCount === 1) {
      log.error({ err, toolName }, 'Journal write failed — audit trail at risk');
    }
    if (journalFailureCount >= JOURNAL_FAILURE_THRESHOLD) {
      journalHealthy = false;
      log.error({ failureCount: journalFailureCount }, 'JOURNAL DISABLED — too many consecutive failures. Tool execution will no longer be audited until restart.');
    }
  });
}

/** Reset journal health tracking — for tests or manual recovery. */
export function resetJournalHealth(): void {
  journalHealthy = true;
  journalFailureCount = 0;
}

/** Print recent journal entries to stdout (for `nexus journal` CLI). */
export async function printRecentJournal(n = 20): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await readFile(JOURNAL_FILE, 'utf-8');
  } catch {
    console.log('No journal entries yet. Run some commands first.');
    return;
  }

  const lines = raw.trim().split('\n').filter(Boolean);
  const recent = lines.slice(-n);

  console.log(`\nTask Journal — last ${recent.length} entries (${JOURNAL_FILE})\n`);
  console.log('─'.repeat(80));

  for (const line of recent) {
    try {
      const entry: JournalEntry = JSON.parse(line);
      const ts = new Date(entry.timestamp).toLocaleTimeString();
      const status = entry.success ? '✓' : '✗';
      const shortResult = entry.result.replace(/\n/g, ' ').slice(0, 80);
      console.log(`${ts} [${status}] ${entry.toolName.padEnd(22)} ${shortResult}`);
    } catch {
      // Skip malformed lines
    }
  }

  console.log('─'.repeat(80));
  console.log('');
}
