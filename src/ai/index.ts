import type { AICompletionOptions, AIProvider, AIResponse } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';

const log = createLogger('AIManager');

const PROVIDER_PRIORITY: AIProvider[] = ['anthropic', 'openai', 'ollama'];

export class AIManager {
  private claude: ClaudeProvider;
  private openai: OpenAIProvider;
  private ollama: OllamaProvider;
  private primaryProvider: AIProvider;

  constructor(primaryProvider: AIProvider = 'anthropic') {
    this.claude = new ClaudeProvider();
    this.openai = new OpenAIProvider();
    this.ollama = new OllamaProvider();
    this.primaryProvider = primaryProvider;

    log.info(
      { primary: primaryProvider, available: this.getAvailableProviders() },
      'AIManager initialized',
    );
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
    const providerOrder = [
      this.primaryProvider,
      ...PROVIDER_PRIORITY.filter((p) => p !== this.primaryProvider),
    ];

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

  private async isProviderAvailable(provider: AIProvider): Promise<boolean> {
    switch (provider) {
      case 'anthropic':
        return this.claude.isAvailable();
      case 'openai':
        return this.openai.isAvailable();
      case 'ollama':
        return this.ollama.isAvailable();
    }
  }

  private async callProvider(
    provider: AIProvider,
    options: AICompletionOptions,
  ): Promise<AIResponse> {
    switch (provider) {
      case 'anthropic':
        return this.claude.complete(options);
      case 'openai':
        return this.openai.complete(options);
      case 'ollama':
        return this.ollama.complete(options);
    }
  }
}

export { ClaudeProvider } from './claude.js';
export { OpenAIProvider } from './openai.js';
export { OllamaProvider } from './ollama.js';
