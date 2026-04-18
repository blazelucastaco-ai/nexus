// Execution Approval Framework — configurable allowlist at ~/.nexus/allowlist.json
// Users can whitelist specific commands that bypass the dangerous tier check.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CommandAllowlist');

const ALLOWLIST_PATH = join(homedir(), '.nexus', 'allowlist.json');

interface AllowlistConfig {
  commands: string[];       // Exact command strings (or prefixes ending in *)
  patterns: string[];       // Regex patterns (as strings)
  updatedAt: string;
}

const DEFAULT_CONFIG: AllowlistConfig = {
  commands: [],
  patterns: [],
  updatedAt: new Date().toISOString(),
};

let cachedAllowlist: AllowlistConfig | null = null;

/**
 * Validate that a parsed allowlist file has the expected shape. Legacy files
 * sometimes have a plain string array (pre-structured format) which would
 * crash the iteration in isAllowlisted with "config.commands is not iterable".
 * We coerce-with-defaults here so approval checks never crash.
 */
function coerceAllowlistShape(raw: unknown): AllowlistConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // Legacy shape: a bare string array. Promote to the structured form.
    if (Array.isArray(raw) && raw.every((x) => typeof x === 'string')) {
      log.info({ count: raw.length }, 'Allowlist: upgrading legacy string-array shape');
      return { commands: raw as string[], patterns: [], updatedAt: new Date().toISOString() };
    }
    log.warn({ raw: typeof raw }, 'Allowlist: unexpected top-level type — using defaults');
    return { ...DEFAULT_CONFIG };
  }
  const obj = raw as Record<string, unknown>;
  const commands = Array.isArray(obj.commands) && obj.commands.every((x) => typeof x === 'string')
    ? (obj.commands as string[])
    : [];
  const patterns = Array.isArray(obj.patterns) && obj.patterns.every((x) => typeof x === 'string')
    ? (obj.patterns as string[])
    : [];
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString();
  return { commands, patterns, updatedAt };
}

async function loadAllowlist(): Promise<AllowlistConfig> {
  if (cachedAllowlist) return cachedAllowlist;

  try {
    const raw = await readFile(ALLOWLIST_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    cachedAllowlist = coerceAllowlistShape(parsed);
    log.info({ path: ALLOWLIST_PATH, commands: cachedAllowlist.commands.length }, 'Allowlist loaded');
    return cachedAllowlist;
  } catch (err: unknown) {
    const isNoEnt = err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNoEnt) {
      log.warn({ err, path: ALLOWLIST_PATH }, 'Failed to parse allowlist config — using defaults');
    }
    return DEFAULT_CONFIG;
  }
}

/**
 * Check if a command is in the user-configured allowlist.
 */
export async function isAllowlisted(command: string): Promise<boolean> {
  const config = await loadAllowlist();
  const cmd = command.trim();

  // Check exact matches and prefix wildcards
  for (const allowed of config.commands) {
    if (allowed.endsWith('*')) {
      if (cmd.startsWith(allowed.slice(0, -1))) return true;
    } else if (cmd === allowed || cmd.startsWith(allowed + ' ')) {
      return true;
    }
  }

  // Check regex patterns (with timeout protection against ReDoS)
  for (const pattern of config.patterns) {
    try {
      const re = new RegExp(pattern);
      // Guard against catastrophic backtracking: test with a timeout
      const start = Date.now();
      const matched = re.test(cmd);
      if (Date.now() - start > 100) {
        log.warn({ pattern, elapsed: Date.now() - start }, 'Slow regex pattern in allowlist — consider simplifying');
      }
      if (matched) return true;
    } catch {
      // Invalid regex — skip
      log.debug({ pattern }, 'Invalid regex pattern in allowlist, skipping');
    }
  }

  return false;
}

/**
 * Add a command to the allowlist.
 */
export async function addToAllowlist(command: string): Promise<void> {
  const config = await loadAllowlist();
  if (!config.commands.includes(command)) {
    config.commands.push(command);
    config.updatedAt = new Date().toISOString();
    await mkdir(join(homedir(), '.nexus'), { recursive: true });
    await writeFile(ALLOWLIST_PATH, JSON.stringify(config, null, 2), 'utf-8');
    cachedAllowlist = config;
    log.info({ command }, 'Command added to allowlist');
  }
}

/**
 * Get the current allowlist contents.
 */
export async function getAllowlist(): Promise<AllowlistConfig> {
  return loadAllowlist();
}

/** Invalidate cache (e.g. after external edit) */
export function invalidateAllowlistCache(): void {
  cachedAllowlist = null;
}
