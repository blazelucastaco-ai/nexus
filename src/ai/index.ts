import type { AICompletionOptions, AIProvider, AIResponse } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';
import { CustomProvider, buildCustomProvider, PROVIDER_PRESETS } from './custom.js';

const log = createLogger('AIManager');

const PROVIDER_PRIORITY: AIProvider[] = ['anthropic', 'openai', 'ollama'];

export class AIManager {
  private claude: ClaudeProvider;
  private openai: OpenAIProvider;
  private ollama: OllamaProvider;
  private primaryProvider: AIProvider;
  /** Optional custom provider (LiteLLM, OpenRouter, Groq, etc.) */
  private custom: CustomProvider | null = null;

  constructor(primaryProvider: AIProvider = 'anthropic') {
    this.claude = new ClaudeProvider();
    this.openai = new OpenAIProvider();
    this.ollama = new OllamaProvider();
    this.primaryProvider = primaryProvider;

    // Auto-detect custom provider from environment
    this.custom = this.detectCustomProvider();

    log.info(
      { primary: primaryProvider, available: this.getAvailableProviders() },
      'AIManager initialized',
    );
  }

  /** Detect a custom provider from NEXUS_AI_PROVIDER_PRESET env var or OPENAI_BASE_URL */
  private detectCustomProvider(): CustomProvider | null {
    const preset = process.env.NEXUS_AI_PROVIDER_PRESET ?? '';
    if (preset && PROVIDER_PRESETS[preset]) {
      const p = buildCustomProvider(preset);
      if (p?.isAvailable()) {
        log.info({ preset }, 'Custom provider preset detected');
        return p;
      }
    }

    // If OPENAI_BASE_URL is set and points to a non-OpenAI endpoint, wrap it as custom
    const baseURL = process.env.OPENAI_BASE_URL ?? '';
    if (baseURL && !baseURL.includes('api.openai.com')) {
      const p = buildCustomProvider('custom', undefined, baseURL);
      if (p?.isAvailable()) {
        log.info({ baseURL }, 'Custom OpenAI-compat base URL detected');
        return p;
      }
    }

    return null;
  }

  /** Register a custom provider by preset name */
  usePreset(preset: string, apiKey?: string, baseURL?: string, model?: string): boolean {
    const p = buildCustomProvider(preset, apiKey, baseURL, model);
    if (!p) {
      log.warn({ preset }, 'Could not build custom provider');
      return false;
    }
    this.custom = p;
    log.info({ preset }, 'Custom provider registered');
    return true;
  }

  listPresets(): string[] {
    return Object.keys(PROVIDER_PRESETS);
  }

  /**
   * Returns a list of providers that are currently configured / reachable.
   * Note: Ollama availability is async, so this returns a sync snapshot
   * (Ollama is included if the provider object exists — use isOllamaAvailable() for a live check).
   */
  getAvailableProviders(): string[] {
    const available: string[] = [];
    if (this.claude.isAvailable()) available.push('anthropic');
    if (this.openai.isAvailable()) available.push('openai');
    if (this.custom?.isAvailable()) available.push(this.custom.getName());
    // Ollama is always listed; actual reachability is checked at call time
    available.push('ollama');
    return available;
  }

  switchProvider(provider: AIProvider): void {
    log.info({ from: this.primaryProvider, to: provider }, 'Switching primary AI provider');
    this.primaryProvider = provider;
  }

  async complete(options: AICompletionOptions): Promise<AIResponse> {
    // Build an ordered list: primary first, then remaining in priority order
    // Custom provider is added before ollama if configured
    const customName = this.custom?.getName();
    const baseOrder: string[] = [
      this.primaryProvider,
      ...PROVIDER_PRIORITY.filter((p) => p !== this.primaryProvider),
    ];
    const providerOrder = customName && !baseOrder.includes(customName)
      ? [...baseOrder.slice(0, -1), customName, ...baseOrder.slice(-1)]
      : baseOrder;

    let lastError: Error | undefined;

    for (const providerName of providerOrder) {
      try {
        const available = await this.isProviderAvailable(providerName);
        if (!available) {
          log.debug({ provider: providerName }, 'Provider not available, skipping');
          continue;
        }

        log.info({ provider: providerName }, 'Attempting completion');
        const result = await this.callProvider(providerName, options);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.error(
          { provider: providerName, error: lastError.message },
          'Provider failed, trying fallback',
        );
      }
    }

    throw new Error(
      `All AI providers failed. Last error: ${lastError?.message ?? 'unknown'}`,
    );
  }

  private async isProviderAvailable(provider: string): Promise<boolean> {
    switch (provider) {
      case 'anthropic':
        return this.claude.isAvailable();
      case 'openai':
        return this.openai.isAvailable();
      case 'ollama':
        return this.ollama.isAvailable();
      default:
        // Custom provider
        if (this.custom?.getName() === provider) return this.custom.isAvailable();
        return false;
    }
  }

  private async callProvider(
    provider: string,
    options: AICompletionOptions,
  ): Promise<AIResponse> {
    switch (provider) {
      case 'anthropic':
        return this.claude.complete(options);
      case 'openai':
        return this.openai.complete(options);
      case 'ollama':
        return this.ollama.complete(options);
      default:
        if (this.custom) return this.custom.complete(options);
        throw new Error(`Unknown provider: ${provider}`);
    }
  }
}

export { ClaudeProvider } from './claude.js';
export { OpenAIProvider } from './openai.js';
export { OllamaProvider } from './ollama.js';
