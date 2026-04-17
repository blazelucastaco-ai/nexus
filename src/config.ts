import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { type NexusConfig, NexusConfigSchema } from './types.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('Config');

const NEXUS_DIR = process.env.NEXUS_DATA_DIR?.replace(/^~(?=\/|$)/, homedir()) ?? join(homedir(), '.nexus');
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
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(raw) ?? {};
  } catch (err) {
    log.error({ err, path: CONFIG_PATH }, 'Failed to parse config.yaml — using defaults. Please fix or delete the file.');
    parsed = {};
  }

  // Merge env vars into config
  if (process.env.TELEGRAM_BOT_TOKEN) {
    parsed.telegram = { ...parsed.telegram, botToken: process.env.TELEGRAM_BOT_TOKEN };
  }
  const chatIdFromEnv = process.env.NEXUS_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID ?? '';
  if (chatIdFromEnv) {
    parsed.telegram = {
      ...parsed.telegram,
      chatId: chatIdFromEnv,
      allowedUsers: [chatIdFromEnv],
    };
  }
  if (process.env.NEXUS_AI_PROVIDER) {
    parsed.ai = { ...parsed.ai, provider: process.env.NEXUS_AI_PROVIDER };
  }
  if (process.env.NEXUS_AI_MODEL) {
    parsed.ai = { ...parsed.ai, model: process.env.NEXUS_AI_MODEL };
  }
  if (process.env.NEXUS_AI_OPUS_MODEL) {
    parsed.ai = { ...parsed.ai, opusModel: process.env.NEXUS_AI_OPUS_MODEL };
  }
  if (process.env.NEXUS_AI_FAST_MODEL) {
    parsed.ai = { ...parsed.ai, fastModel: process.env.NEXUS_AI_FAST_MODEL };
  }
  if (process.env.NEXUS_AI_FALLBACK_MODEL) {
    parsed.ai = { ...parsed.ai, fallbackModel: process.env.NEXUS_AI_FALLBACK_MODEL };
  }

  const config = NexusConfigSchema.parse(parsed);

  if (!config.telegram.botToken) {
    log.warn('TELEGRAM_BOT_TOKEN is not set — bot will not start');
  }
  if (!config.telegram.chatId) {
    log.warn('No chatId configured — bot is open to ALL users (development mode only)');
  }

  return config;
}

export function saveConfig(config: NexusConfig): void {
  ensureDataDir();
  writeFileSync(CONFIG_PATH, stringifyYaml(config), 'utf-8');
}

export function getDbPath(): string {
  return join(ensureDataDir(), 'memory.db');
}
