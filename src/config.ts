import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { type NexusConfig, NexusConfigSchema } from './types.js';

const NEXUS_DIR = process.env.NEXUS_DATA_DIR?.replace('~', homedir()) ?? join(homedir(), '.nexus');
const CONFIG_PATH = join(NEXUS_DIR, 'config.yaml');

export function ensureDataDir(): string {
  if (!existsSync(NEXUS_DIR)) {
    mkdirSync(NEXUS_DIR, { recursive: true });
  }
  return NEXUS_DIR;
}

export function getDataDir(): string {
  return NEXUS_DIR;
}

export function loadConfig(): NexusConfig {
  ensureDataDir();

  if (!existsSync(CONFIG_PATH)) {
    const defaults = NexusConfigSchema.parse({});
    saveConfig(defaults);
    return defaults;
  }

  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = parseYaml(raw) ?? {};

  // Merge env vars into config
  if (process.env.TELEGRAM_BOT_TOKEN) {
    parsed.telegram = { ...parsed.telegram, botToken: process.env.TELEGRAM_BOT_TOKEN };
  }
  if (process.env.TELEGRAM_CHAT_ID) {
    parsed.telegram = {
      ...parsed.telegram,
      allowedUsers: [process.env.TELEGRAM_CHAT_ID],
    };
  }

  return NexusConfigSchema.parse(parsed);
}

export function saveConfig(config: NexusConfig): void {
  ensureDataDir();
  writeFileSync(CONFIG_PATH, stringifyYaml(config), 'utf-8');
}

export function getDbPath(): string {
  return join(ensureDataDir(), 'nexus.db');
}
