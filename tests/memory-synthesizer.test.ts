import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemorySynthesizer } from '../src/brain/memory-synthesizer.js';
import type { AIManager } from '../src/ai/index.js';
import type { Memory, UserFact } from '../src/types.js';

function makeMockAI(responseContent = 'The user prefers TypeScript and has been working on Node.js projects.'): AIManager {
  return {
    complete: vi.fn().mockResolvedValue({ content: responseContent, usage: { inputTokens: 50, outputTokens: 100 } }),
  } as unknown as AIManager;
}

function makeMemory(id: string, content: string, type = 'fact' as const): Memory {
  return {
    id,
    type,
    layer: 'episodic' as any,
    content,
    summary: `Summary of ${content.slice(0, 30)}`,
    importance: 0.7,
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    accessCount: 1,
    tags: [],
    source: 'test',
  } as Memory;
}

function makeFact(key: string, value: string): UserFact {
  return {
    id: `fact-${key}`,
    category: 'preference' as any,
    key,
    value,
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'test',
  };
}

describe('MemorySynthesizer', () => {
  describe('empty input', () => {
    it('should return empty synthesis when no memories, facts, or goals', async () => {
      const ai = makeMockAI();
      const synth = new MemorySynthesizer(ai);

      const result = await synth.synthesize('test query', [], [], []);
      expect(result.synthesis).toBe('');
      expect(result.usedMemoryIds).toEqual([]);
      expect((ai as any).complete).not.toHaveBeenCalled();
    });
  });

  describe('memory count gate', () => {
    it('should skip LLM for 0 memories (only facts)', async () => {
      const ai = makeMockAI();
      const synth = new MemorySynthesizer(ai);

      const result = await synth.synthesize('test query', [], [makeFact('theme', 'dark')], []);
      expect((ai as any).complete).not.toHaveBeenCalled();
    });

    it('should skip LLM for 1 memory', async () => {
      const ai = makeMockAI();
      const synth = new MemorySynthesizer(ai);

      const result = await synth.synthesize('test query', [makeMemory('m1', 'User likes TypeScript')], [], []);
      expect((ai as any).complete).not.toHaveBeenCalled();
      // Should return inline fragment
      expect(result.synthesis).toContain('Summary of');
    });

    it('should skip LLM for 2 memories', async () => {
      const ai = makeMockAI();
      const synth = new MemorySynthesizer(ai);

      const memories = [
        makeMemory('m1', 'User likes TypeScript'),
        makeMemory('m2', 'User prefers dark mode'),
      ];
      await synth.synthesize('test query', memories, [], []);
      expect((ai as any).complete).not.toHaveBeenCalled();
    });

    it('should call LLM for 3 or more memories', async () => {
      const ai = makeMockAI('User likes TypeScript, dark mode, and works on Node.js projects.');
      const synth = new MemorySynthesizer(ai);

      const memories = [
        makeMemory('m1', 'User likes TypeScript'),
        makeMemory('m2', 'User prefers dark mode'),
        makeMemory('m3', 'User works on Node.js projects'),
      ];
      const result = await synth.synthesize('coding preferences', memories, [], []);
      expect((ai as any).complete).toHaveBeenCalledTimes(1);
      expect(result.synthesis.length).toBeGreaterThan(10);
    });
  });

  describe('query cache', () => {
    it('should return cached result on second identical call within TTL', async () => {
      const ai = makeMockAI('Cached synthesis result.');
      const synth = new MemorySynthesizer(ai);

      const memories = [
        makeMemory('m1', 'User likes TypeScript'),
        makeMemory('m2', 'User prefers dark mode'),
        makeMemory('m3', 'User works on Node.js'),
      ];

      const result1 = await synth.synthesize('same query', memories, [], []);
      const result2 = await synth.synthesize('same query', memories, [], []);

      // Should only call the AI once
      expect((ai as any).complete).toHaveBeenCalledTimes(1);
      expect(result1.synthesis).toBe(result2.synthesis);
    });

    it('should not use cache for different queries', async () => {
      const ai = makeMockAI('Synthesis result.');
      const synth = new MemorySynthesizer(ai);

      const memories = [
        makeMemory('m1', 'User likes TypeScript'),
        makeMemory('m2', 'User prefers dark mode'),
        makeMemory('m3', 'User works on Node.js'),
      ];

      await synth.synthesize('query one', memories, [], []);
      await synth.synthesize('query two', memories, [], []);

      expect((ai as any).complete).toHaveBeenCalledTimes(2);
    });

    it('should not use cache for different memory sets', async () => {
      const ai = makeMockAI('Synthesis result.');
      const synth = new MemorySynthesizer(ai);

      const memories1 = [
        makeMemory('m1', 'Content 1'),
        makeMemory('m2', 'Content 2'),
        makeMemory('m3', 'Content 3'),
      ];
      const memories2 = [
        makeMemory('m4', 'Content 4'),
        makeMemory('m5', 'Content 5'),
        makeMemory('m6', 'Content 6'),
      ];

      await synth.synthesize('same query', memories1, [], []);
      await synth.synthesize('same query', memories2, [], []);

      expect((ai as any).complete).toHaveBeenCalledTimes(2);
    });
  });

  describe('error fallback', () => {
    it('should fall back to text joining when AI throws', async () => {
      const ai = {
        complete: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      } as unknown as AIManager;
      const synth = new MemorySynthesizer(ai);

      const memories = [
        makeMemory('m1', 'User likes TypeScript'),
        makeMemory('m2', 'User prefers dark mode'),
        makeMemory('m3', 'User works on Node.js'),
      ];

      const result = await synth.synthesize('query', memories, [], []);
      // Should have a fallback synthesis
      expect(typeof result.synthesis).toBe('string');
      expect(result.usedMemoryIds).toEqual(['m1', 'm2', 'm3']);
    });
  });

  describe('usedMemoryIds', () => {
    it('should return IDs of memories used in synthesis', async () => {
      const ai = makeMockAI('Synthesis.');
      const synth = new MemorySynthesizer(ai);

      const memories = [
        makeMemory('mem-a', 'Content A'),
        makeMemory('mem-b', 'Content B'),
        makeMemory('mem-c', 'Content C'),
      ];

      const result = await synth.synthesize('query', memories, [], []);
      expect(result.usedMemoryIds).toContain('mem-a');
      expect(result.usedMemoryIds).toContain('mem-b');
      expect(result.usedMemoryIds).toContain('mem-c');
    });

    it('should cap memories to 8 when more provided', async () => {
      const ai = makeMockAI('Synthesis result with many memories.');
      const synth = new MemorySynthesizer(ai);

      const memories = Array.from({ length: 12 }, (_, i) => makeMemory(`m${i}`, `Content ${i}`));
      const result = await synth.synthesize('query', memories, [], []);
      expect(result.usedMemoryIds.length).toBeLessThanOrEqual(8);
    });
  });

  describe('active goals', () => {
    it('should include active goals in the synthesis prompt', async () => {
      const ai = makeMockAI('User is working on a React project.');
      const synth = new MemorySynthesizer(ai);

      const memories = [
        makeMemory('m1', 'Content 1'),
        makeMemory('m2', 'Content 2'),
        makeMemory('m3', 'Content 3'),
      ];

      await synth.synthesize('query', memories, [], ['Build a React dashboard for sales data']);
      const callArgs = (ai as any).complete.mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('React dashboard');
    });
  });
});
