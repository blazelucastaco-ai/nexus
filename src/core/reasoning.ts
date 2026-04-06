import type { NexusConfig } from './config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('reasoning');

// ─── Types ────────────────────────────────────────────────────────────

export interface ThinkOptions {
  maxTokens?: number;
  temperature?: number;
  tools?: unknown[];
}

export interface ThinkResult {
  content: string;
  toolCalls?: unknown[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMProvider {
  complete(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    options?: ThinkOptions,
  ): Promise<ThinkResult>;

  embed(text: string): Promise<number[]>;
}

// ─── Token tracking ───────────────────────────────────────────────────

interface TokenStats {
  totalInput: number;
  totalOutput: number;
  requestCount: number;
}

// ─── ReasoningEngine ──────────────────────────────────────────────────

export class ReasoningEngine {
  private provider: LLMProvider | null = null;
  private fallbackProvider: LLMProvider | null = null;
  private config: NexusConfig;
  private stats: TokenStats = { totalInput: 0, totalOutput: 0, requestCount: 0 };

  constructor(config: NexusConfig) {
    this.config = config;
    this.initProviders();
  }

  // ── Initialization ────────────────────────────────────────────────

  private async loadAnthropicProvider(): Promise<LLMProvider> {
    const mod = await import('../providers/anthropic.js');
    const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    const provider = new mod.AnthropicProvider(apiKey, this.config.ai.model);
    return this.wrapProvider(provider);
  }

  private async loadOpenAIProvider(): Promise<LLMProvider> {
    const mod = await import('../providers/openai.js');
    const apiKey = process.env.OPENAI_API_KEY ?? '';
    const provider = new mod.OpenAIProvider(apiKey, this.config.ai.model);
    return this.wrapProvider(provider);
  }

  /**
   * Wrap an AnthropicProvider or OpenAIProvider (which have `chat()`) into
   * the LLMProvider interface (which expects `complete()` and `embed()`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wrapProvider(provider: { chat: (...args: any[]) => Promise<any> }): LLMProvider {
    return {
      async complete(systemPrompt, messages, options) {
        const chatMessages = messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
        const result = await provider.chat(systemPrompt, chatMessages, {
          maxTokens: options?.maxTokens,
          temperature: options?.temperature,
          tools: options?.tools as any[],
        });
        return {
          content: result.content,
          toolCalls: result.toolCalls,
          usage: result.usage,
        };
      },
      async embed(_text: string): Promise<number[]> {
        // Embedding not supported by chat-only providers
        return [];
      },
    };
  }

  private initProviders(): void {
    // Providers are lazily loaded on first use to keep constructor sync
    log.info(
      { provider: this.config.ai.provider, model: this.config.ai.model },
      'ReasoningEngine initialized (providers load lazily)',
    );
  }

  private async getProvider(): Promise<LLMProvider> {
    if (!this.provider) {
      this.provider = await this.createProvider(this.config.ai.provider, this.config.ai.model);
    }
    return this.provider;
  }

  private async getFallbackProvider(): Promise<LLMProvider> {
    if (!this.fallbackProvider) {
      this.fallbackProvider = await this.createProvider(
        this.config.ai.provider,
        this.config.ai.fallbackModel,
      );
    }
    return this.fallbackProvider;
  }

  private async createProvider(providerName: string, _model: string): Promise<LLMProvider> {
    switch (providerName) {
      case 'anthropic':
        return this.loadAnthropicProvider();
      case 'openai':
        return this.loadOpenAIProvider();
      default:
        throw new Error(`Unsupported AI provider: ${providerName}`);
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Send a prompt to the configured LLM and return the response.
   * Falls back to the fallback model if the primary provider fails.
   */
  async think(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    options?: ThinkOptions,
  ): Promise<ThinkResult> {
    const mergedOptions: ThinkOptions = {
      maxTokens: options?.maxTokens ?? this.config.ai.maxTokens,
      temperature: options?.temperature ?? this.config.ai.temperature,
      tools: options?.tools,
    };

    try {
      const provider = await this.getProvider();
      const result = await provider.complete(systemPrompt, messages, mergedOptions);
      this.trackUsage(result.usage);
      return result;
    } catch (primaryErr) {
      log.warn(
        { err: primaryErr, model: this.config.ai.model },
        'Primary model failed, attempting fallback',
      );

      try {
        const fallback = await this.getFallbackProvider();
        const result = await fallback.complete(systemPrompt, messages, mergedOptions);
        this.trackUsage(result.usage);
        return result;
      } catch (fallbackErr) {
        log.error({ err: fallbackErr }, 'Fallback model also failed');
        throw new Error(
          `All AI providers failed. Primary: ${(primaryErr as Error).message}. Fallback: ${(fallbackErr as Error).message}`,
        );
      }
    }
  }

  /**
   * Generate an embedding vector for the given text.
   * Useful for memory similarity search.
   */
  async embed(text: string): Promise<number[]> {
    const provider = await this.getProvider();
    return provider.embed(text);
  }

  // ── Token tracking ────────────────────────────────────────────────

  private trackUsage(usage?: { inputTokens: number; outputTokens: number }): void {
    if (!usage) return;
    this.stats.totalInput += usage.inputTokens;
    this.stats.totalOutput += usage.outputTokens;
    this.stats.requestCount += 1;

    if (this.stats.requestCount % 10 === 0) {
      log.info(
        {
          requests: this.stats.requestCount,
          inputTokens: this.stats.totalInput,
          outputTokens: this.stats.totalOutput,
        },
        'Token usage checkpoint',
      );
    }
  }

  /** Return cumulative token usage stats. */
  getStats(): Readonly<TokenStats> {
    return { ...this.stats };
  }

  /** Reset token counters. */
  resetStats(): void {
    this.stats = { totalInput: 0, totalOutput: 0, requestCount: 0 };
  }
}
