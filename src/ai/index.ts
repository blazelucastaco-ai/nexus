import type { AICompletionOptions, AIProvider, AIResponse } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { ClaudeProvider } from './claude.js';

const log = createLogger('AIManager');

export class AIManager {
  private claude: ClaudeProvider;

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

  async complete(options: AICompletionOptions): Promise<AIResponse> {
    if (!this.claude.isAvailable()) {
      throw new Error('Anthropic API key not configured. Set ANTHROPIC_API_KEY in your environment.');
    }
    return this.claude.complete(options);
  }
}

export { ClaudeProvider } from './claude.js';
