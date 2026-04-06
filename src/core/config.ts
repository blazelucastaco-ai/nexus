import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { createLogger } from '../utils/logger.js';

const log = createLogger('config');

// ─── Constants ────────────────────────────────────────────────────────
export const NEXUS_HOME = join(homedir(), '.nexus');
const CONFIG_PATH = join(NEXUS_HOME, 'config.json');

// ─── Schema ───────────────────────────────────────────────────────────
const PersonalitySchema = z
  .object({
    name: z.string().default('NEXUS'),
    traits: z
      .object({
        humor: z.number().min(0).max(1).default(0.7),
        sarcasm: z.number().min(0).max(1).default(0.4),
        formality: z.number().min(0).max(1).default(0.3),
        assertiveness: z.number().min(0).max(1).default(0.6),
        verbosity: z.number().min(0).max(1).default(0.5),
        empathy: z.number().min(0).max(1).default(0.8),
      })
      .default({}),
    opinions: z
      .object({
        enabled: z.boolean().default(true),
        pushbackThreshold: z.number().min(0).max(1).default(0.6),
      })
      .default({}),
  })
  .default({});

const MemorySchema = z
  .object({
    consolidationSchedule: z.string().default('0 3 * * *'),
    maxShortTerm: z.number().default(50),
    retrievalTopK: z.number().default(20),
    importanceThreshold: z.number().default(0.3),
  })
  .default({});

const AISchema = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'ollama']).default('anthropic'),
    model: z.string().default('claude-sonnet-4-20250514'),
    fallbackModel: z.string().default('claude-haiku-4-5-20251001'),
    maxTokens: z.number().default(8192),
    temperature: z.number().default(0.7),
  })
  .default({});

const TelegramSchema = z
  .object({
    botToken: z.string().default(''),
    chatId: z.string().default(''),
    allowedUsers: z.array(z.string()).default([]),
  })
  .default({});

const MacOSSchema = z
  .object({
    screenshotQuality: z.number().min(0).max(1).default(0.8),
    accessibilityEnabled: z.boolean().default(true),
  })
  .default({});

const AgentsSchema = z
  .object({
    autoDelegate: z.boolean().default(true),
    maxConcurrent: z.number().default(5),
    timeoutSeconds: z.number().default(300),
  })
  .default({});

export const NexusConfigSchema = z.object({
  personality: PersonalitySchema,
  memory: MemorySchema,
  ai: AISchema,
  telegram: TelegramSchema,
  macos: MacOSSchema,
  agents: AgentsSchema,
});

export type NexusConfig = z.infer<typeof NexusConfigSchema>;

// ─── Singleton ────────────────────────────────────────────────────────
let _config: NexusConfig | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────

function ensureNexusHome(): void {
  if (!existsSync(NEXUS_HOME)) {
    mkdirSync(NEXUS_HOME, { recursive: true });
    log.info(`Created NEXUS_HOME at ${NEXUS_HOME}`);
  }
}

function readConfigFile(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) {
    log.info('No config file found, creating default config');
    ensureNexusHome();
    const defaults = NexusConfigSchema.parse({});
    writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2), 'utf-8');
    return defaults as unknown as Record<string, unknown>;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    log.warn({ err }, 'Failed to read config file, using defaults');
    return {};
  }
}

/**
 * Merge environment variables into the raw config object.
 * Env vars take precedence over file values.
 */
function applyEnvOverrides(cfg: Record<string, unknown>): Record<string, unknown> {
  const env = process.env;

  // Telegram
  const telegram = (cfg.telegram ?? {}) as Record<string, unknown>;
  if (env.NEXUS_TELEGRAM_TOKEN) telegram.botToken = env.NEXUS_TELEGRAM_TOKEN;
  if (env.NEXUS_CHAT_ID) telegram.chatId = env.NEXUS_CHAT_ID;
  cfg.telegram = telegram;

  // AI — provider-level keys are set on the provider clients themselves,
  // but we still support overriding the provider/model via env.
  const ai = (cfg.ai ?? {}) as Record<string, unknown>;
  if (env.NEXUS_AI_PROVIDER) ai.provider = env.NEXUS_AI_PROVIDER;
  if (env.NEXUS_AI_MODEL) ai.model = env.NEXUS_AI_MODEL;
  if (env.NEXUS_AI_FALLBACK_MODEL) ai.fallbackModel = env.NEXUS_AI_FALLBACK_MODEL;
  if (env.NEXUS_AI_MAX_TOKENS) ai.maxTokens = Number(env.NEXUS_AI_MAX_TOKENS);
  if (env.NEXUS_AI_TEMPERATURE) ai.temperature = Number(env.NEXUS_AI_TEMPERATURE);
  cfg.ai = ai;

  return cfg;
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Load configuration from disk, merge with env vars, validate via zod, and cache.
 * Safe to call multiple times; subsequent calls return the cached config.
 */
export function loadConfig(): NexusConfig {
  // Load .env file (no-op if it doesn't exist)
  loadDotenv();

  ensureNexusHome();

  let raw = readConfigFile();
  raw = applyEnvOverrides(raw);

  const result = NexusConfigSchema.safeParse(raw);
  if (!result.success) {
    log.error({ issues: result.error.issues }, 'Config validation failed — falling back to defaults');
    _config = NexusConfigSchema.parse({});
  } else {
    _config = result.data;
  }

  log.info(
    { provider: _config.ai.provider, model: _config.ai.model },
    'Configuration loaded',
  );

  return _config;
}

/**
 * Return the current cached config. Throws if `loadConfig()` has not been called.
 */
export function getConfig(): NexusConfig {
  if (!_config) {
    throw new Error('Config not loaded — call loadConfig() first');
  }
  return _config;
}
