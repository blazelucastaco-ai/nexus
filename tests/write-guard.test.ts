import { describe, it, expect, vi } from 'vitest';
import {
  claimsFileSaved,
  extractTargetPath,
  extractContent,
  runWriteGuard,
  type WriteGuardDeps,
} from '../src/core/write-guard.js';
import type { AIManager } from '../src/ai/index.js';
import type { ToolExecutor } from '../src/tools/executor.js';
import type { AIResponse, NexusConfig } from '../src/types.js';

function makeConfig(): NexusConfig {
  return {
    ai: { provider: 'anthropic', model: 'test', maxTokens: 4096, temperature: 0.7 },
  } as unknown as NexusConfig;
}

function makeDeps(overrides: Partial<WriteGuardDeps> = {}): WriteGuardDeps {
  const ai = { complete: vi.fn<[], Promise<AIResponse>>() } as unknown as AIManager;
  const toolExecutor = { execute: vi.fn<[], Promise<string>>() } as unknown as ToolExecutor;
  return { ai, toolExecutor, config: makeConfig(), ...overrides };
}

function mockResp(content: string, toolCalls?: unknown): AIResponse {
  return {
    content,
    provider: 'anthropic',
    model: 'test',
    tokensUsed: { input: 10, output: 5 },
    duration: 50,
    ...(toolCalls ? { toolCalls: toolCalls as any } : {}),
  };
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('claimsFileSaved', () => {
  it.each([
    ['I created the file at ~/test.ts', true],
    ['Saved it to /tmp/foo.txt for you', true],
    ['Here is the file content for ~/a.ts:', true],
    ['the file has been written to /tmp/x', true],
    ["I will think about it", false],
    ['the cat is on the mat', false],
    ['I wrote a poem for you', false], // no path → no false positive
  ])('%s → %s', (text, expected) => {
    expect(claimsFileSaved(text)).toBe(expected);
  });
});

describe('extractTargetPath', () => {
  it('extracts ~ paths', () => {
    expect(extractTargetPath('saved to ~/code/foo.ts')).toBe('~/code/foo.ts');
  });
  it('extracts absolute paths', () => {
    expect(extractTargetPath('wrote /tmp/a.txt')).toBe('/tmp/a.txt');
  });
  it('strips trailing punctuation', () => {
    expect(extractTargetPath('here is ~/x.ts.')).toBe('~/x.ts');
    expect(extractTargetPath('saved to /tmp/a.js,')).toBe('/tmp/a.js');
  });
  it('returns null if no path', () => {
    expect(extractTargetPath('no paths here')).toBeNull();
  });
});

describe('extractContent', () => {
  it('pulls content from a fenced code block', () => {
    const text = 'here is the file:\n```ts\nconst x = 1;\n```\nthanks';
    const r = extractContent(text);
    expect(r.strategy).toBe('fenced');
    expect(r.content).toContain('const x = 1;');
  });

  it('recognizes 3+ indented lines', () => {
    const text = 'the file content:\n    line one\n    line two\n    line three\n    line four\ndone';
    const r = extractContent(text);
    expect(r.strategy).toBe('indented');
    expect(r.content).toMatch(/line one[\s\S]*line four/);
  });

  it('uses the whole response when most lines look like code', () => {
    const text = [
      'const a = 1;',
      'const b = 2;',
      'function foo() { return a + b; }',
      'import bar from "bar";',
      'class Baz {}',
    ].join('\n');
    const r = extractContent(text);
    expect(r.strategy).toBe('whole-response');
    expect(r.content).toBe(text);
  });

  it('returns none when nothing looks like code', () => {
    const text = 'I have written the file. It is saved now. Let me know if you need anything else.';
    expect(extractContent(text)).toEqual({ content: null, strategy: 'none' });
  });
});

// ─── runWriteGuard (integration of the pure + deps) ─────────────────────────

describe('runWriteGuard', () => {
  it('is a no-op when response does not claim a save', async () => {
    const deps = makeDeps();
    const out = await runWriteGuard(deps, {
      finalContent: 'just answering your question',
      writeFileCallsMade: [],
      loopMessages: [],
      systemPrompt: 'sys',
    });
    expect(out.triggered).toBe(false);
    expect(out.finalContent).toBe('just answering your question');
    expect(deps.toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('is a no-op when write_file was actually called', async () => {
    const deps = makeDeps();
    const out = await runWriteGuard(deps, {
      finalContent: 'I saved it to ~/a.ts',
      writeFileCallsMade: [{ path: '~/a.ts' }],
      loopMessages: [],
      systemPrompt: 'sys',
    });
    expect(out.triggered).toBe(false);
    expect(deps.toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('auto-saves content from a fenced block when the LLM claimed a save but did not call write_file', async () => {
    const deps = makeDeps();
    (deps.toolExecutor.execute as any).mockResolvedValue('Wrote 40 bytes to ~/a.ts');

    const out = await runWriteGuard(deps, {
      finalContent: 'I saved it to ~/a.ts:\n```\nconst x = 1;\n```\nDone!',
      writeFileCallsMade: [],
      loopMessages: [],
      systemPrompt: 'sys',
    });

    expect(out.triggered).toBe(true);
    expect(out.strategy).toBe('fenced');
    expect(deps.toolExecutor.execute).toHaveBeenCalledWith('write_file', {
      path: '~/a.ts',
      content: 'const x = 1;\n',
    });
    expect(out.finalContent).toMatch(/Auto-saved by NEXUS write guard/);
  });

  it('appends an error note when auto-save throws', async () => {
    const deps = makeDeps();
    (deps.toolExecutor.execute as any).mockRejectedValue(new Error('EACCES'));

    const out = await runWriteGuard(deps, {
      finalContent: 'I saved it to ~/a.ts:\n```\nx\n```',
      writeFileCallsMade: [],
      loopMessages: [],
      systemPrompt: 'sys',
    });

    expect(out.triggered).toBe(true);
    expect(out.finalContent).toMatch(/failed to save it automatically/);
  });

  it('falls back to re-prompting the LLM when no content is extractable', async () => {
    const deps = makeDeps();
    // LLM complies on the re-prompt with a write_file tool call.
    (deps.ai.complete as any).mockResolvedValue(
      mockResp('', [
        {
          id: 're1',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: '~/a.ts', content: 'fixed' }) },
        },
      ]),
    );
    (deps.toolExecutor.execute as any).mockResolvedValue('Wrote 5 bytes to ~/a.ts');

    const out = await runWriteGuard(deps, {
      finalContent: 'I totally saved it to ~/a.ts, trust me.',
      writeFileCallsMade: [],
      loopMessages: [{ role: 'user', content: 'please save a file' }],
      systemPrompt: 'sys',
    });

    expect(out.triggered).toBe(true);
    expect(out.strategy).toBe('reprompt');
    expect(deps.ai.complete).toHaveBeenCalledTimes(1);
    expect(deps.toolExecutor.execute).toHaveBeenCalledWith(
      'write_file',
      expect.objectContaining({ path: '~/a.ts', content: 'fixed' }),
    );
    expect(out.finalContent).toMatch(/Write guard re-prompt/);
  });

  it('notes when the re-prompt fails to produce a write_file call', async () => {
    const deps = makeDeps();
    (deps.ai.complete as any).mockResolvedValue(mockResp('just text, no tool call'));

    const out = await runWriteGuard(deps, {
      finalContent: 'I saved it to ~/a.ts. (no code block)',
      writeFileCallsMade: [],
      loopMessages: [{ role: 'user', content: 'save it' }],
      systemPrompt: 'sys',
    });

    expect(out.strategy).toBe('reprompt');
    expect(out.finalContent).toMatch(/re-prompt did not produce a write_file call/);
  });
});
