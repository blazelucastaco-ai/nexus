// Task Journal — append-only JSONL log of every tool call + result.
// Wired as an afterHook on the ToolExecutor so it captures all tool activity.
// View with: cat ~/.nexus/task-journal.jsonl | tail -20

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';

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
    if (key.includes('token') || key.includes('secret') || key.includes('password') || key.includes('key')) {
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
 * Returns the afterHook function to pass to executor.addAfterHook().
 * Usage: executor.addAfterHook(makeJournalHook());
 */
export function makeJournalHook() {
  return (toolName: string, params: Record<string, unknown>, result?: string) => {
    appendJournalEntry(toolName, params, result ?? '').catch(() => {});
  };
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
