import { describe, it, expect, vi } from 'vitest';
import {
  InnerMonologue,
  shouldSurfaceMicroThought,
} from '../src/brain/inner-monologue.js';
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

// ─── Micro-thought gate (pure helper) ───────────────────────────────────────

describe('shouldSurfaceMicroThought', () => {
  it('rejects short messages so trivial chatter never triggers an LLM call', () => {
    expect(shouldSurfaceMicroThought('hi')).toBe(false);
    expect(shouldSurfaceMicroThought('thanks!')).toBe(false);
    expect(shouldSurfaceMicroThought("yeah that's good")).toBe(false);
  });

  it('rejects normal-length non-uncertain messages', () => {
    expect(shouldSurfaceMicroThought(
      'Please rebuild the chrome extension with a new manifest.',
    )).toBe(false);
    expect(shouldSurfaceMicroThought(
      'Tell me about the architecture of the memory system.',
    )).toBe(false);
  });

  it('fires on direct distress signals', () => {
    expect(shouldSurfaceMicroThought("this is weird, the build isn't working again")).toBe(true);
    expect(shouldSurfaceMicroThought("the typing simulation doesn't work the way i expected")).toBe(true);
    expect(shouldSurfaceMicroThought("i'm not sure why the manifest is being rejected")).toBe(true);
    expect(shouldSurfaceMicroThought("something is off — my popup keeps freezing")).toBe(true);
  });

  it('fires on long technical "why" questions', () => {
    expect(shouldSurfaceMicroThought(
      "why does the popup freeze whenever the background script tries to read storage but only on the second invocation?",
    )).toBe(true);
  });

  it('skips short messages even when an uncertainty word appears (length gate is conservative)', () => {
    // "why is it broken?" — 17 chars — under MIN_MICRO_LENGTH; we'd rather
    // under-fire than chirp on every short distress message.
    expect(shouldSurfaceMicroThought('why is it broken?')).toBe(false);
    expect(shouldSurfaceMicroThought('why latex?')).toBe(false);
    // Same uncertainty word, but with enough surrounding context, fires.
    expect(shouldSurfaceMicroThought('why is the popup view broken on every reload?')).toBe(true);
  });
});

// ─── generateMicroPrefix — bounded LLM-driven prefix ────────────────────────

describe('InnerMonologue.generateMicroPrefix', () => {
  const ctx: ThoughtContext = {
    task: "the typing simulation isn't working the way i expected, can you re-check?",
    emotion: 'focused',
    memories: ['Worked on human-typer extension last hour'],
    recentHistory: 'User: build a chrome extension. Assistant: done.',
  };

  it('returns a short, stripped string when the LLM returns one', async () => {
    const ai = makeMockAI("hmm, that's the same shape as the issue we patched in March");
    const monologue = new InnerMonologue(ai);

    const out = await monologue.generateMicroPrefix(ctx);
    expect(out).toBe("hmm, that's the same shape as the issue we patched in March");
  });

  it('strips wrapping quotes/asterisks/underscores so the orchestrator can re-italicise cleanly', async () => {
    const ai = makeMockAI('"*let me re-read the manifest first*"');
    const monologue = new InnerMonologue(ai);

    const out = await monologue.generateMicroPrefix(ctx);
    expect(out).toBe('let me re-read the manifest first');
    expect(out).not.toMatch(/^[*_"]/);
  });

  it('returns null when the model declines with SKIP', async () => {
    const ai = makeMockAI('SKIP');
    const monologue = new InnerMonologue(ai);

    expect(await monologue.generateMicroPrefix(ctx)).toBeNull();
  });

  it('returns null when the LLM returns blank or near-blank content', async () => {
    expect(
      await new InnerMonologue(makeMockAI('')).generateMicroPrefix(ctx),
    ).toBeNull();
    expect(
      await new InnerMonologue(makeMockAI('  ')).generateMicroPrefix(ctx),
    ).toBeNull();
    expect(
      await new InnerMonologue(makeMockAI('ok')).generateMicroPrefix(ctx),
    ).toBeNull();
  });

  it('returns null on AI failure', async () => {
    const ai = {
      complete: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    } as unknown as AIManager;
    const monologue = new InnerMonologue(ai);

    expect(await monologue.generateMicroPrefix(ctx)).toBeNull();
  });

  it('caps very long responses with an ellipsis so a runaway line never bleeds into the answer', async () => {
    const ai = makeMockAI('hmm, ' + 'x'.repeat(200));
    const monologue = new InnerMonologue(ai);

    const out = await monologue.generateMicroPrefix(ctx);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(102); // 100 + "…" allowance
    expect(out!.endsWith('…')).toBe(true);
  });

  it('returns null without an LLM call on too-short tasks', async () => {
    const ai = makeMockAI('whatever');
    const monologue = new InnerMonologue(ai);

    const out = await monologue.generateMicroPrefix({ ...ctx, task: 'hi' });
    expect(out).toBeNull();
    expect((ai as any).complete).not.toHaveBeenCalled();
  });
});
