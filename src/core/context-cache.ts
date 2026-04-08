// Context Cache — caches system prompt and tool definitions to avoid re-tokenizing
// Uses a hash to detect changes. Only rebuilds when content changes.

import { createHash } from 'node:crypto';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ContextCache');

interface CacheEntry {
  hash: string;
  value: string;
  hits: number;
  createdAt: number;
}

export class ContextCache {
  private systemPromptCache: CacheEntry | null = null;
  private toolsCache: CacheEntry | null = null;

  private hash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Get or cache the system prompt.
   * Returns the same object reference if content hasn't changed (cache hit).
   */
  getSystemPrompt(prompt: string): string {
    const h = this.hash(prompt);
    if (this.systemPromptCache?.hash === h) {
      this.systemPromptCache.hits++;
      log.debug({ hits: this.systemPromptCache.hits }, 'System prompt cache hit');
      return this.systemPromptCache.value;
    }
    this.systemPromptCache = { hash: h, value: prompt, hits: 0, createdAt: Date.now() };
    log.debug('System prompt cache miss — stored new prompt');
    return prompt;
  }

  /**
   * Get or cache the serialized tools array.
   */
  getTools(toolsJson: string): string {
    const h = this.hash(toolsJson);
    if (this.toolsCache?.hash === h) {
      this.toolsCache.hits++;
      return this.toolsCache.value;
    }
    this.toolsCache = { hash: h, value: toolsJson, hits: 0, createdAt: Date.now() };
    return toolsJson;
  }

  getStats(): { systemPromptHits: number; toolsHits: number } {
    return {
      systemPromptHits: this.systemPromptCache?.hits ?? 0,
      toolsHits: this.toolsCache?.hits ?? 0,
    };
  }

  invalidate(): void {
    this.systemPromptCache = null;
    this.toolsCache = null;
    log.info('Context cache invalidated');
  }
}

// Singleton instance
export const contextCache = new ContextCache();
