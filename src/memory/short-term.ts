// Nexus AI — Short-term memory (conversation ring buffer)

import type { AIMessage, Memory, MemoryType } from '../types.js';
import { generateId, nowISO } from '../utils/helpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ShortTermMemory');

export interface BufferEntry {
  id: string;
  message: AIMessage;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export class ShortTermMemory {
  private buffer: BufferEntry[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    log.info({ maxSize }, 'Short-term memory initialized');
  }

  /**
   * Add a message to the ring buffer. Oldest entries are evicted when full.
   */
  add(message: AIMessage, metadata: Record<string, unknown> = {}): BufferEntry {
    const entry: BufferEntry = {
      id: generateId(),
      message,
      timestamp: nowISO(),
      metadata,
    };

    if (this.buffer.length >= this.maxSize) {
      const evicted = this.buffer.shift();
      log.debug({ evictedId: evicted?.id }, 'Evicted oldest buffer entry');
    }

    this.buffer.push(entry);
    return entry;
  }

  /**
   * Retrieve the N most recent entries. Omit count to get all.
   */
  getRecent(count?: number): BufferEntry[] {
    if (count === undefined || count >= this.buffer.length) {
      return [...this.buffer];
    }
    return this.buffer.slice(-count);
  }

  /**
   * Get all entries as AIMessage array (for passing to LLM context).
   */
  getMessages(count?: number): AIMessage[] {
    return this.getRecent(count).map((e) => e.message);
  }

  /**
   * Format the buffer into a string for context injection.
   */
  getContextWindow(count?: number): string {
    const entries = this.getRecent(count);
    if (entries.length === 0) return '[No recent conversation]';

    return entries
      .map((e) => `[${e.timestamp}] ${e.message.role}: ${e.message.content}`)
      .join('\n');
  }

  /**
   * Simple keyword search across buffered messages.
   * Returns entries where any query term appears in the content.
   */
  search(query: string): BufferEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    return this.buffer.filter((entry) => {
      const content = (entry.message.content ?? '').toLowerCase();
      return terms.some((term) => content.includes(term));
    });
  }

  /**
   * Convert buffer entries to Memory objects for consolidation into long-term storage.
   */
  toMemories(type: MemoryType = 'conversation'): Memory[] {
    return this.buffer.map((entry) => ({
      id: entry.id,
      layer: 'buffer' as const,
      type,
      content: entry.message.content ?? '',
      summary: null,
      importance: 0.3,
      confidence: 1.0,
      emotionalValence: null,
      createdAt: entry.timestamp,
      lastAccessed: entry.timestamp,
      accessCount: 0,
      tags: [entry.message.role],
      relatedMemories: [],
      source: 'conversation',
      metadata: { role: entry.message.role, ...entry.metadata },
    }));
  }

  /**
   * Clear the entire buffer.
   */
  clear(): void {
    const count = this.buffer.length;
    this.buffer = [];
    log.info({ cleared: count }, 'Buffer cleared');
  }

  /**
   * Number of entries currently in the buffer.
   */
  get size(): number {
    return this.buffer.length;
  }

  /**
   * Whether the buffer is at capacity.
   */
  get isFull(): boolean {
    return this.buffer.length >= this.maxSize;
  }
}
