// Execution Approval Framework — configurable allowlist at ~/.nexus/allowlist.json
// Users can whitelist specific commands that bypass the dangerous tier check.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../utils/logger.js';
import { getArea } from './recommended-approvals.js';

const log = createLogger('CommandAllowlist');

const ALLOWLIST_PATH = join(homedir(), '.nexus', 'allowlist.json');

interface AllowlistConfig {
  commands: string[];       // Exact command strings (or prefixes ending in *)
  patterns: string[];       // Regex patterns (as strings)
  approvedAreas: string[];  // IDs of recommended areas the user has opted into
  updatedAt: string;
}

const DEFAULT_CONFIG: AllowlistConfig = {
  commands: [],
  patterns: [],
  approvedAreas: [],
  updatedAt: new Date().toISOString(),
};

let cachedAllowlist: AllowlistConfig | null = null;

async function loadAllowlist(): Promise<AllowlistConfig> {
  if (cachedAllowlist) return cachedAllowlist;

  try {
    const raw = await readFile(ALLOWLIST_PATH, 'utf-8');
    cachedAllowlist = JSON.parse(raw) as AllowlistConfig;
    log.info({ path: ALLOWLIST_PATH, commands: cachedAllowlist.commands.length }, 'Allowlist loaded');
    return cachedAllowlist;
  } catch {
    // File doesn't exist — use defaults
    return DEFAULT_CONFIG;
  }
}

/**
 * Check if a command is in the user-configured allowlist.
 * Also checks approved recommended areas.
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

  // Check regex patterns
  for (const pattern of config.patterns) {
    try {
      if (new RegExp(pattern).test(cmd)) return true;
    } catch {
      // Invalid regex — skip
    }
  }

  // Check approved recommended areas
  for (const areaId of config.approvedAreas ?? []) {
    const area = getArea(areaId);
    if (!area) continue;

    for (const allowed of area.commands) {
      if (allowed.endsWith('*')) {
        if (cmd.startsWith(allowed.slice(0, -1))) return true;
      } else if (cmd === allowed) {
        return true;
      }
    }

    for (const pattern of area.patterns) {
      try {
        if (new RegExp(pattern).test(cmd)) return true;
      } catch {
        // Invalid regex — skip
      }
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

/**
 * Approve a recommended area by ID.
 * All commands/patterns in that area will bypass the DANGEROUS tier check.
 */
export async function approveArea(areaId: string): Promise<boolean> {
  const area = getArea(areaId);
  if (!area) {
    log.warn({ areaId }, 'Unknown recommended area');
    return false;
  }

  const config = await loadAllowlist();
  const areas = config.approvedAreas ?? [];
  if (areas.includes(areaId)) {
    log.info({ areaId }, 'Area already approved');
    return true;
  }

  areas.push(areaId);
  config.approvedAreas = areas;
  config.updatedAt = new Date().toISOString();
  await mkdir(join(homedir(), '.nexus'), { recursive: true });
  await writeFile(ALLOWLIST_PATH, JSON.stringify(config, null, 2), 'utf-8');
  cachedAllowlist = config;
  log.info({ areaId, name: area.name }, 'Recommended area approved');
  return true;
}

/**
 * Revoke a previously approved recommended area.
 */
export async function revokeArea(areaId: string): Promise<boolean> {
  const config = await loadAllowlist();
  const areas = config.approvedAreas ?? [];
  const idx = areas.indexOf(areaId);
  if (idx === -1) return false;

  areas.splice(idx, 1);
  config.approvedAreas = areas;
  config.updatedAt = new Date().toISOString();
  await mkdir(join(homedir(), '.nexus'), { recursive: true });
  await writeFile(ALLOWLIST_PATH, JSON.stringify(config, null, 2), 'utf-8');
  cachedAllowlist = config;
  log.info({ areaId }, 'Recommended area revoked');
  return true;
}

/**
 * Get the list of currently approved area IDs.
 */
export async function getApprovedAreas(): Promise<string[]> {
  const config = await loadAllowlist();
  return config.approvedAreas ?? [];
}

/** Invalidate cache (e.g. after external edit) */
export function invalidateAllowlistCache(): void {
  cachedAllowlist = null;
}
