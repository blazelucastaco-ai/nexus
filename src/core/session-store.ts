// Session Store — JSONL-backed per-chat session persistence
//
// Each chat gets its own file at ~/.nexus/sessions/{chatId}.jsonl
// Each line is a JSON array of messages for that turn: [{role, content}, ...]

import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'fs';
import { appendFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SessionStore');

const SESSIONS_DIR = join(homedir(), '.nexus', 'sessions');

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
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

    const raw = readFileSync(path, 'utf8');
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
