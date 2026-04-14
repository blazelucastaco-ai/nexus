import { describe, it, expect, vi } from 'vitest';
import { InnerMonologue } from '../src/brain/inner-monologue.js';
import type { AIManager } from '../src/ai/index.js';
import type { ThoughtContext } from '../src/brain/inner-monologue.js';

function makeMockAI(responseContent = 'Let me think about this carefully.'): AIManager {
  return {
    complete: vi.fn().mockResolvedValue({ content: responseContent, usage: { inputTokens: 10, outputTokens: 30 } }),
  } as unknown as AIManager;
}

const fullContext: ThoughtContext = {
  task: 'How do I implement a binary search tree in TypeScript with generics?',
  emotion: 'curious',
  memories: ['User worked on algorithms last week', 'User prefers TypeScript'],
  recentHistory: 'User: Can you help me with data structures? Assistant: Of course!',
};

describe('InnerMonologue', () => {
  describe('toggleThinkMode', () => {
    it('should be disabled by default', () => {
      const ai = makeMockAI();
      const monologue = new InnerMonologue(ai);
      expect(monologue.isEnabled()).toBe(false);
    });

    it('should toggle think mode on', () => {
      const ai = makeMockAI();
      const monologue = new InnerMonologue(ai);
      const result = monologue.toggleThinkMode();
      expect(result).toBe(true);
      expect(monologue.isEnabled()).toBe(true);
    });

    it('should toggle think mode off again', () => {
      const ai = makeMockAI();
      const monologue = new InnerMonologue(ai);
      monologue.toggleThinkMode(); // on
      monologue.toggleThinkMode(); // off
      expect(monologue.isEnabled()).toBe(false);
    });

    it('should accept a forced value', () => {
      const ai = makeMockAI();
      const monologue = new InnerMonologue(ai);
      monologue.toggleThinkMode(true);
      expect(monologue.isEnabled()).toBe(true);
      monologue.toggleThinkMode(false);
      expect(monologue.isEnabled()).toBe(false);
    });
  });

  describe('generateThought — complexity threshold', () => {
    it('should return empty string for messages shorter than 15 chars', async () => {
      const ai = makeMockAI();
      const monologue = new InnerMonologue(ai);

      const result = await monologue.generateThought({ ...fullContext, task: 'help me' });
      expect(result).toBe('');
      const mockAI = ai as any;
      expect(mockAI.complete).not.toHaveBeenCalled();
    });

    it('should return empty string for trivial "hi" messages', async () => {
      const ai = makeMockAI();
      const monologue = new InnerMonologue(ai);

      const result = await monologue.generateThought({ ...fullContext, task: 'hi' });
      expect(result).toBe('');
      expect((ai as any).complete).not.toHaveBeenCalled();
    });

    it('should return empty string for "thanks" message', async () => {
      const ai = makeMockAI();
      const monologue = new InnerMonologue(ai);

      const result = await monologue.generateThought({ ...fullContext, task: 'thanks!' });
      expect(result).toBe('');
    });

    it('should return empty string for "yes" message', async () => {
      const ai = makeMockAI();
      const monologue = new InnerMonologue(ai);

      const result = await monologue.generateThought({ ...fullContext, task: 'yes' });
      expect(result).toBe('');
    });

    it('should return empty string for "ok" message', async () => {
      const ai = makeMockAI();
      const monologue = new InnerMonologue(ai);

      const result = await monologue.generateThought({ ...fullContext, task: 'ok' });
      expect(result).toBe('');
    });

    it('should call AI for substantive messages', async () => {
      const ai = makeMockAI('Hmm, this is a complex TypeScript question about generics.');
      const monologue = new InnerMonologue(ai);

      const result = await monologue.generateThought(fullContext);
      expect(result).toBe('Hmm, this is a complex TypeScript question about generics.');
      expect((ai as any).complete).toHaveBeenCalledTimes(1);
    });

    it('should return empty string on AI failure', async () => {
      const ai = {
        complete: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      } as unknown as AIManager;
      const monologue = new InnerMonologue(ai);

      const result = await monologue.generateThought(fullContext);
      expect(result).toBe('');
    });

    it('should pass emotion and memories to the AI system prompt', async () => {
      const ai = makeMockAI('Some thought.');
      const monologue = new InnerMonologue(ai);

      await monologue.generateThought({
        task: 'Can you explain how recursive algorithms work in detail?',
        emotion: 'enthusiastic',
        memories: ['User loves algorithms', 'User is a CS student'],
        recentHistory: 'Previous discussion about sorting.',
      });

      const callArgs = (ai as any).complete.mock.calls[0][0];
      expect(callArgs.systemPrompt).toContain('enthusiastic');
      expect(callArgs.systemPrompt).toContain('User loves algorithms');
    });
  });
});
