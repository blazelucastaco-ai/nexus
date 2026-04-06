import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryManager } from '../src/memory/index.js';

describe('MemoryManager', () => {
  let memory: MemoryManager;

  beforeEach(() => {
    memory = new MemoryManager(10);
  });

  afterEach(() => {
    memory.close();
  });

  it('should initialize without errors', () => {
    expect(memory).toBeDefined();
  });

  it('should store and recall episodic memories', () => {
    memory.store('episodic', 'conversation', 'User asked about the weather in Tokyo', {
      importance: 0.7,
      tags: ['weather', 'tokyo'],
      source: 'telegram',
    });

    const results = memory.recall('weather Tokyo', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain('weather');
  });

  it('should store and recall semantic facts', () => {
    memory.storeFact('preference', 'theme', 'dark mode', 0.9);

    const results = memory.recall('dark mode preference', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('should manage short-term buffer', () => {
    memory.addToBuffer('user', 'Hello NEXUS');
    memory.addToBuffer('assistant', 'Hello! How can I help?');

    const recent = memory.getBufferMessages();
    expect(recent.length).toBe(2);
    expect(recent[0]!.role).toBe('user');
  });

  it('should respect buffer size limit', () => {
    for (let i = 0; i < 15; i++) {
      memory.addToBuffer('user', `Message ${i}`);
    }

    const recent = memory.getBufferMessages();
    expect(recent.length).toBeLessThanOrEqual(10);
  });

  it('should return stats', () => {
    const stats = memory.getStats();
    expect(stats).toHaveProperty('bufferSize');
    expect(stats).toHaveProperty('bufferFull');
  });
});
