import { describe, it, expect } from 'vitest';
import { ContextPromptBuilder, PRIORITY, type ContextProvider, type ProviderInput } from '../src/core/context-provider.js';
import type { NexusContext } from '../src/types.js';

function makeInput(overrides: Partial<ProviderInput> = {}): ProviderInput {
  const ctx: NexusContext = {
    personality: {} as any,
    recentMemories: [],
    relevantFacts: [],
    activeTasks: [],
    conversationHistory: [],
    systemState: { uptime: 0, activeAgents: [], pendingTasks: 0 },
  };
  return {
    context: ctx,
    nowEpochMs: Date.now(),
    uptimeMs: 0,
    ...overrides,
  };
}

describe('ContextPromptBuilder', () => {
  it('runs providers in priority order', () => {
    const builder = new ContextPromptBuilder();
    const p1: ContextProvider = { name: 'p1', priority: PRIORITY.IDENTITY, contribute: () => 'SECTION-A' };
    const p2: ContextProvider = { name: 'p2', priority: PRIORITY.PLATFORM, contribute: () => 'SECTION-B' };
    const p3: ContextProvider = { name: 'p3', priority: PRIORITY.MEMORY, contribute: () => 'SECTION-C' };

    // Register out of order
    builder.register(p2);
    builder.register(p1);
    builder.register(p3);

    const out = builder.build(makeInput());
    expect(out.indexOf('SECTION-A')).toBeLessThan(out.indexOf('SECTION-C'));
    expect(out.indexOf('SECTION-C')).toBeLessThan(out.indexOf('SECTION-B'));
  });

  it('skips providers that return null', () => {
    const builder = new ContextPromptBuilder();
    builder.register({ name: 'always', priority: 1, contribute: () => 'ALWAYS' });
    builder.register({ name: 'conditional', priority: 2, contribute: () => null });
    builder.register({ name: 'also', priority: 3, contribute: () => 'ALSO' });

    const out = builder.build(makeInput());
    expect(out).toContain('ALWAYS');
    expect(out).toContain('ALSO');
    expect(out).not.toContain('null');
  });

  it('skips providers that return empty/whitespace strings', () => {
    const builder = new ContextPromptBuilder();
    builder.register({ name: 'empty', priority: 1, contribute: () => '   ' });
    builder.register({ name: 'real', priority: 2, contribute: () => 'REAL' });

    const out = builder.build(makeInput());
    expect(out.trim()).toBe('REAL');
  });

  it('does not let a thrown provider crash build', () => {
    const builder = new ContextPromptBuilder();
    builder.register({
      name: 'bad',
      priority: 1,
      contribute: () => { throw new Error('boom'); },
    });
    builder.register({ name: 'good', priority: 2, contribute: () => 'GOOD' });

    const out = builder.build(makeInput());
    expect(out.trim()).toBe('GOOD');
  });

  it('unregister removes by name', () => {
    const builder = new ContextPromptBuilder();
    builder.register({ name: 'a', priority: 1, contribute: () => 'A' });
    builder.register({ name: 'b', priority: 2, contribute: () => 'B' });

    expect(builder.unregister('a')).toBe(true);
    expect(builder.unregister('c')).toBe(false);

    const out = builder.build(makeInput());
    expect(out).not.toContain('A');
    expect(out).toContain('B');
  });

  it('list returns providers in priority order', () => {
    const builder = new ContextPromptBuilder();
    builder.register({ name: 'late', priority: 100, contribute: () => null });
    builder.register({ name: 'early', priority: 1, contribute: () => null });
    builder.register({ name: 'mid', priority: 50, contribute: () => null });

    const list = builder.list();
    expect(list.map((p) => p.name)).toEqual(['early', 'mid', 'late']);
  });

  it('passes provider input to contribute', () => {
    const builder = new ContextPromptBuilder();
    let received: ProviderInput | null = null;
    builder.register({
      name: 'spy',
      priority: 1,
      contribute: (input) => { received = input; return null; },
    });

    const input = makeInput({ memorySynthesis: 'SYNTHESIS' });
    builder.build(input);
    expect(received).not.toBeNull();
    expect(received!.memorySynthesis).toBe('SYNTHESIS');
  });

  it('PRIORITY constants are monotonic', () => {
    const values = Object.values(PRIORITY);
    const sorted = [...values].sort((a, b) => a - b);
    expect(values).toEqual(sorted);
  });
});
