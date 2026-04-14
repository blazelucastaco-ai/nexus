// Session Store — JSONL-backed per-chat session persistence
//
// Each chat gets its own file at ~/.nexus/sessions/{chatId}.jsonl
// Each line is a JSON array of messages for that turn: [{role, content}, ...]
// Sessions older than 30 days and larger than 500 KB are auto-archived.

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, openSync, readSync, closeSync } from 'fs';
import { appendFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SessionStore');

const SESSIONS_DIR = join(homedir(), '.nexus', 'sessions');
const ARCHIVE_DIR  = join(SESSIONS_DIR, 'archive');

const ARCHIVE_AGE_MS   = 30 * 24 * 60 * 60 * 1000; // 30 days
const ARCHIVE_SIZE_MIN = 500 * 1024;                 // 500 KB

function ensureDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * If the session file is both old (>30 days since last write) and large (>500 KB),
 * move it to the archive directory and let the caller start a fresh file.
 */
function maybeArchive(filePath: string, chatId: string): void {
  try {
    const st = statSync(filePath);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs < ARCHIVE_AGE_MS || st.size < ARCHIVE_SIZE_MIN) return;

    mkdirSync(ARCHIVE_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dest  = join(ARCHIVE_DIR, `${chatId}_${stamp}.jsonl`);
    renameSync(filePath, dest);
    log.info({ chatId, dest, ageDays: Math.round(ageMs / 86_400_000), sizeKB: Math.round(st.size / 1024) }, 'Session archived');
  } catch (err) {
    log.debug({ err }, 'Session archive check skipped');
  }
}

function sessionPath(chatId: string): string {
  // Sanitize chatId to be a safe filename
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(SESSIONS_DIR, `${safe}.jsonl`);
}

export interface SessionMessage {
  role: string;
  content: string;
}

/**
 * Append a turn (user message + assistant response) to the session file.
 */
export async function appendTurn(chatId: string, messages: SessionMessage[]): Promise<void> {
  try {
    ensureDir();
    const line = JSON.stringify(messages) + '\n';
    await appendFile(sessionPath(chatId), line, 'utf8');
  } catch (err) {
    log.warn({ err, chatId }, 'Failed to append session turn');
  }
}

/**
 * Load the last N turns from a session file.
 * Returns a flat array of messages (each turn is a pair or more).
 */
export function loadSession(chatId: string, lastN = 20): SessionMessage[] {
  try {
    const path = sessionPath(chatId);
    if (!existsSync(path)) return [];

    // Archive stale + large sessions before loading
    maybeArchive(path, chatId);

    // Read only the tail of the file to avoid loading huge session files into memory.
    // We read the last ~64KB which is enough for dozens of recent turns.
    const fileSize = statSync(path).size;
    const TAIL_BYTES = 64 * 1024;
    let raw: string;

    if (fileSize <= TAIL_BYTES) {
      raw = readFileSync(path, 'utf8');
    } else {
      const buf = Buffer.alloc(TAIL_BYTES);
      const fd = openSync(path, 'r');
      readSync(fd, buf, 0, TAIL_BYTES, fileSize - TAIL_BYTES);
      closeSync(fd);
      raw = buf.toString('utf8');
      // Drop the first (likely partial) line
      const firstNewline = raw.indexOf('\n');
      if (firstNewline >= 0) raw = raw.slice(firstNewline + 1);
    }

    const lines = raw.trim().split('\n').filter(Boolean);

    // Take last N turns
    const recentLines = lines.slice(-lastN);

    const messages: SessionMessage[] = [];
    for (const line of recentLines) {
      try {
        const turn = JSON.parse(line) as SessionMessage[];
        messages.push(...turn);
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  } catch (err) {
    log.warn({ err, chatId }, 'Failed to load session');
    return [];
  }
}

/**
 * List all session chatIds (filename without extension).
 */
export function listSessions(): string[] {
  try {
    ensureDir();
    const { readdirSync } = require('fs');
    return (readdirSync(SESSIONS_DIR) as string[])
      .filter((f: string) => f.endsWith('.jsonl'))
      .map((f: string) => f.replace(/\.jsonl$/, ''));
  } catch {
    return [];
  }
}
