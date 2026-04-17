import type { AICompletionOptions, AIProvider, AIResponse } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { ClaudeProvider } from './claude.js';

const log = createLogger('AIManager');

/**
 * Detect rate-limit / overload errors that warrant falling back to a cheaper model.
 * Anthropic returns 429 for rate limits and 529 for overloaded_error.
 */
function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const obj = err as Record<string, unknown>;
  const status = obj.status ?? obj.statusCode;
  if (typeof status === 'number' && (status === 429 || status === 529 || status === 503)) {
    return true;
  }
  const msg = String(obj.message ?? '').toLowerCase();
  return msg.includes('rate limit') ||
         msg.includes('overloaded') ||
         msg.includes('too many requests') ||
         msg.includes('quota exceeded');
}

export class AIManager {
  private claude: ClaudeProvider;
  /** Fallback model used when the primary hits a rate limit / overload */
  fallbackModel: string | null = null;

  constructor(_primaryProvider: AIProvider = 'anthropic') {
    this.claude = new ClaudeProvider();
    log.info({ provider: 'anthropic', model: process.env.NEXUS_AI_MODEL ?? 'claude-sonnet-4-6' }, 'AIManager initialized (Claude only)');
  }

  getAvailableProviders(): string[] {
    return this.claude.isAvailable() ? ['anthropic'] : [];
  }

  /** No-op — NEXUS is Claude-only */
  switchProvider(_provider: AIProvider): void {
    log.debug('switchProvider called but NEXUS is Claude-only — ignoring');
  }

  /**
   * Configure the fallback model used on rate-limit errors.
   * Typically Haiku 4.5 — cheaper and usually has headroom when Sonnet/Opus are throttled.
   */
  setFallbackModel(model: string | null): void {
    this.fallbackModel = model;
    log.info({ fallbackModel: model }, 'Fallback model configured');
  }

  async complete(options: AICompletionOptions): Promise<AIResponse> {
    if (!this.claude.isAvailable()) {
      throw new Error('Anthropic API key not configured. Set ANTHROPIC_API_KEY in your environment.');
    }

    try {
      return await this.claude.complete(options);
    } catch (err) {
      // If primary model is rate-limited and we have a fallback configured,
      // retry once with the fallback model. This preserves user experience
      // when Sonnet/Opus are overloaded — Haiku handles the request instead.
      if (this.fallbackModel && this.fallbackModel !== options.model && isRateLimitError(err)) {
        log.warn({
          primaryModel: options.model,
          fallbackModel: this.fallbackModel,
          error: err instanceof Error ? err.message : String(err),
        }, 'Primary model rate-limited — falling back to cheaper model');
        try {
          return await this.claude.complete({ ...options, model: this.fallbackModel });
        } catch (fallbackErr) {
          log.error({ err: fallbackErr }, 'Fallback model also failed');
          throw fallbackErr;
        }
      }
      throw err;
    }
  }
}

export { ClaudeProvider } from './claude.js';
