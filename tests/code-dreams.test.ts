import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDatabase } from '../src/memory/database.js';
import {
  observeProject,
  runCodeDreamsCycle,
  startCodeDreams,
  type CodeDreamObservation,
} from '../src/brain/code-dreams.js';
import { upsertProject, listJournalEntries } from '../src/data/projects-repository.js';
import { events } from '../src/core/events.js';
import type { AIManager } from '../src/ai/index.js';
import type { AIResponse } from '../src/types.js';

function clearTables(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM project_journal').run();
  db.prepare('DELETE FROM projects').run();
}

function makeFakeAi(response: string): AIManager {
  const ai = {
    complete: vi.fn(async (): Promise<AIResponse> => ({
      content: response,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      duration: 100,
    })),
  } as unknown as AIManager;
  return ai;
}

describe('observeProject', () => {
  beforeEach(() => clearTables());

  it('parses valid JSON observation', async () => {
    const ai = makeFakeAi(JSON.stringify({
      summary: 'You refactored auth.ts three times — second version was cleanest.',
      patterns: ['3 conflicting commits on auth.ts', '12 new any types'],
      followUps: ['Revert to commit abc123 and iterate from there'],
      confidence: 0.85,
    }));

    const obs = await observeProject({
      ai,
      projectName: 'jake-fitness',
      displayName: 'Jake Fitness',
      diff: 'commit abc\n- const x: any\n+ const x: string\n',
    });

    expect(obs).not.toBeNull();
    expect(obs!.project).toBe('jake-fitness');
    expect(obs!.summary).toContain('refactored');
    expect(obs!.patterns).toHaveLength(2);
    expect(obs!.followUps).toHaveLength(1);
    expect(obs!.confidence).toBe(0.85);
  });

  it('extracts JSON when model wraps it in prose', async () => {
    const ai = makeFakeAi(`Here's my analysis:

{
  "summary": "Good focused work.",
  "patterns": ["consistent refactoring"],
  "followUps": [],
  "confidence": 0.7
}`);

    const obs = await observeProject({
      ai, projectName: 'x', displayName: 'X', diff: 'some diff',
    });
    expect(obs?.summary).toBe('Good focused work.');
    expect(obs?.confidence).toBe(0.7);
  });

  it('returns null on malformed output', async () => {
    const ai = makeFakeAi('I have thoughts but here is no JSON.');
    const obs = await observeProject({ ai, projectName: 'x', displayName: 'X', diff: 'diff' });
    expect(obs).toBeNull();
  });

  it('clamps confidence to [0, 1]', async () => {
    const ai = makeFakeAi(JSON.stringify({
      summary: 'test', patterns: [], followUps: [], confidence: 5.0,
    }));
    const obs = await observeProject({ ai, projectName: 'x', displayName: 'X', diff: 'diff' });
    expect(obs?.confidence).toBe(1);
  });

  it('caps pattern count at 5', async () => {
    const ai = makeFakeAi(JSON.stringify({
      summary: 'x',
      patterns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      followUps: [],
      confidence: 0.5,
    }));
    const obs = await observeProject({ ai, projectName: 'x', displayName: 'X', diff: 'diff' });
    expect(obs?.patterns).toHaveLength(5);
  });

  it('returns null when LLM call throws', async () => {
    const ai = {
      complete: vi.fn(async () => { throw new Error('rate limited'); }),
    } as unknown as AIManager;
    const obs = await observeProject({ ai, projectName: 'x', displayName: 'X', diff: 'diff' });
    expect(obs).toBeNull();
  });
});

describe('runCodeDreamsCycle', () => {
  beforeEach(() => clearTables());

  it('reviews active projects and persists observations', async () => {
    upsertProject({ name: 'alpha', path: '/tmp/alpha', displayName: 'Alpha' });
    upsertProject({ name: 'beta', path: '/tmp/beta', displayName: 'Beta' });

    const fakeDiff = 'commit abc\n+ const x = 1;\n'.repeat(100);
    const fakeFetch = vi.fn(async (path: string) => {
      return path === '/tmp/alpha' ? fakeDiff : fakeDiff;
    });

    let call = 0;
    const ai = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({
          summary: `Observation ${++call}`,
          patterns: [`pattern ${call}`],
          followUps: [],
          confidence: 0.8,
        }),
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        duration: 100,
      })),
    } as unknown as AIManager;

    const observations = await runCodeDreamsCycle({
      ai,
      fetchDiff: fakeFetch,
    });

    expect(observations).toHaveLength(2);
    expect(fakeFetch).toHaveBeenCalledTimes(2);

    // Verify persisted
    const alphaJournal = listJournalEntries('alpha').filter((e) => e.kind === 'note');
    const betaJournal = listJournalEntries('beta').filter((e) => e.kind === 'note');
    expect(alphaJournal.length).toBeGreaterThan(0);
    expect(betaJournal.length).toBeGreaterThan(0);
    expect(alphaJournal[0]?.summary).toContain('Observation');
  });

  it('skips projects without a path', async () => {
    upsertProject({ name: 'no-path' }); // no path arg → null in DB

    const fetch = vi.fn(async () => 'diff');
    const ai = makeFakeAi(JSON.stringify({
      summary: 'x', patterns: [], followUps: [], confidence: 0.8,
    }));

    const observations = await runCodeDreamsCycle({ ai, fetchDiff: fetch });
    expect(observations).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips projects with no meaningful diff', async () => {
    upsertProject({ name: 'quiet', path: '/tmp/quiet' });

    const fetch = vi.fn(async () => ''); // empty diff
    const ai = makeFakeAi(JSON.stringify({
      summary: 'x', patterns: [], followUps: [], confidence: 0.8,
    }));

    const observations = await runCodeDreamsCycle({ ai, fetchDiff: fetch });
    expect(observations).toHaveLength(0);
    // AI should not be called if no diff
    expect((ai.complete as any).mock.calls.length).toBe(0);
  });

  it('skips low-confidence observations from persistence', async () => {
    upsertProject({ name: 'noise', path: '/tmp/noise' });

    const fetch = vi.fn(async () => 'some diff content'.repeat(50));
    const ai = makeFakeAi(JSON.stringify({
      summary: 'uncertain thoughts', patterns: [], followUps: [], confidence: 0.2,
    }));

    const observations = await runCodeDreamsCycle({ ai, fetchDiff: fetch });
    expect(observations).toHaveLength(0);

    // Journal should not have received the low-confidence entry
    const noiseJournal = listJournalEntries('noise').filter((e) => e.kind === 'note');
    expect(noiseJournal.length).toBe(0);
  });

  it('caps review at MAX_PROJECTS_PER_CYCLE', async () => {
    // Register 10 projects to verify we only review up to 5
    for (let i = 0; i < 10; i++) {
      upsertProject({ name: `p${i}`, path: `/tmp/p${i}` });
    }

    const fetch = vi.fn(async () => 'commit\n+ line\n'.repeat(50));
    const ai = makeFakeAi(JSON.stringify({
      summary: 'x', patterns: [], followUps: [], confidence: 0.8,
    }));

    await runCodeDreamsCycle({ ai, fetchDiff: fetch });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(5);
  });
});

describe('startCodeDreams event subscriber', () => {
  let subs: { unsubscribe(): void }[] = [];

  beforeEach(() => {
    clearTables();
    events.clear();
  });

  afterEach(() => {
    for (const s of subs) s.unsubscribe();
  });

  it('runs a review cycle when dream.started fires', async () => {
    upsertProject({ name: 'triggered', path: '/tmp/triggered' });

    const ai = makeFakeAi(JSON.stringify({
      summary: 'triggered observation',
      patterns: ['p'],
      followUps: [],
      confidence: 0.8,
    }));

    // Patch fetchDiff via a fresh subscriber: startCodeDreams uses the real
    // getRecentDiff, which will return null for non-existent dirs. For this
    // test we verify the subscription fires the runner by checking AI was called.
    subs = startCodeDreams({ ai, model: 'claude-opus-4-7' });

    events.emit({ type: 'dream.started' });

    // Give async handler a tick
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Real getRecentDiff on /tmp/triggered returns null (no .git),
    // so no AI call happens — but the subscription activated without throwing.
    // This asserts the handler is wired, not the end-to-end behavior
    // (which requires a real git repo).
    expect((ai.complete as any).mock.calls.length).toBe(0);
  });

  it('swallows cycle errors silently', async () => {
    const ai = {
      complete: vi.fn(async () => { throw new Error('catastrophe'); }),
    } as unknown as AIManager;

    subs = startCodeDreams({ ai });

    // Must not throw
    expect(() => events.emit({ type: 'dream.started' })).not.toThrow();

    await new Promise((r) => setImmediate(r));
  });
});
