import { describe, it, expect, vi } from 'vitest';
import { ToolExecutor, type TaskLauncher, type AskUserCallback } from '../src/tools/executor.js';
import type { AgentManager } from '../src/agents/index.js';
import type { MemoryManager } from '../src/memory/index.js';

// New 2026-05-07: start_task and start_ultra_task are tools the chat-mode
// model can call to escalate from a one-shot tool call into a full
// multi-step plan. Replaces the regex classifier so the model itself
// judges when planning is warranted (Lucas's "intelligence over keyword
// triggers" directive).
//
// The dispatch logic lives in ToolExecutor.startTask (private). These
// tests go through the public execute() surface and verify the boundaries:
// - launcher must be configured
// - chatId must be in the context
// - request must be non-empty
// - both ultra and coordinator flags propagate

function makeExecutor() {
  const agents = {} as AgentManager;
  const memory = {} as MemoryManager;
  return new ToolExecutor(agents, memory);
}

describe('start_task tool', () => {
  it('returns an error when no launcher is configured', async () => {
    const exec = makeExecutor();
    const result = await exec.execute('start_task', { request: 'build x' }, { chatId: 'c1' });
    expect(result).toMatch(/task launcher is not configured/i);
  });

  it('returns an error when chatId is missing from context', async () => {
    const exec = makeExecutor();
    exec.setTaskLauncher(vi.fn() as unknown as TaskLauncher);
    const result = await exec.execute('start_task', { request: 'build x' });
    expect(result).toMatch(/requires a chat context/i);
  });

  it('returns an error when request is empty or missing', async () => {
    const exec = makeExecutor();
    exec.setTaskLauncher(vi.fn() as unknown as TaskLauncher);
    expect(await exec.execute('start_task', {}, { chatId: 'c1' })).toMatch(/non-empty.*request/i);
    expect(await exec.execute('start_task', { request: '' }, { chatId: 'c1' })).toMatch(/non-empty.*request/i);
    expect(await exec.execute('start_task', { request: '   ' }, { chatId: 'c1' })).toMatch(/non-empty.*request/i);
  });

  it('forwards request, chatId, ultra=false, coordinator=false to the launcher', async () => {
    const exec = makeExecutor();
    const launcher = vi.fn(async () => 'Task X started.') as unknown as TaskLauncher;
    exec.setTaskLauncher(launcher);

    const result = await exec.execute(
      'start_task',
      { request: 'build a chrome extension' },
      { chatId: 'chat-42' },
    );

    expect(result).toBe('Task X started.');
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(launcher).toHaveBeenCalledWith({
      request: 'build a chrome extension',
      chatId: 'chat-42',
      ultra: false,
      coordinator: false,
    });
  });

  it('start_ultra_task sets ultra=true', async () => {
    const exec = makeExecutor();
    const launcher = vi.fn(async () => 'Ultra plan generated.') as unknown as TaskLauncher;
    exec.setTaskLauncher(launcher);

    await exec.execute(
      'start_ultra_task',
      { request: 'deploy to prod' },
      { chatId: 'chat-1' },
    );

    expect(launcher).toHaveBeenCalledWith(
      expect.objectContaining({ request: 'deploy to prod', ultra: true, coordinator: false }),
    );
  });

  it('coordinator flag propagates when set', async () => {
    const exec = makeExecutor();
    const launcher = vi.fn(async () => 'Started.') as unknown as TaskLauncher;
    exec.setTaskLauncher(launcher);

    await exec.execute(
      'start_task',
      { request: 'research X and write Y simultaneously', coordinator: true },
      { chatId: 'c' },
    );

    expect(launcher).toHaveBeenCalledWith(
      expect.objectContaining({ coordinator: true, ultra: false }),
    );
  });

  it('trims surrounding whitespace from the request', async () => {
    const exec = makeExecutor();
    const launcher = vi.fn(async () => 'Started.') as unknown as TaskLauncher;
    exec.setTaskLauncher(launcher);

    await exec.execute(
      'start_task',
      { request: '   build me a CLI   ' },
      { chatId: 'c' },
    );

    expect(launcher).toHaveBeenCalledWith(
      expect.objectContaining({ request: 'build me a CLI' }),
    );
  });
});

// ask_user — mid-task interactivity (2026-05-07). Lets a step pause and
// receive a user reply via Telegram instead of guessing under ambiguity.
describe('ask_user tool', () => {
  it('returns an error when no callback is configured', async () => {
    const exec = makeExecutor();
    const result = await exec.execute('ask_user', { question: 'Which file?' }, { chatId: 'c1' });
    expect(result).toMatch(/ask_user is not configured/i);
  });

  it('returns an error when chatId is missing from context', async () => {
    const exec = makeExecutor();
    exec.setAskUserCallback(vi.fn() as unknown as AskUserCallback);
    const result = await exec.execute('ask_user', { question: 'Which file?' });
    expect(result).toMatch(/requires a chat context/i);
  });

  it('returns an error when question is missing or empty', async () => {
    const exec = makeExecutor();
    exec.setAskUserCallback(vi.fn() as unknown as AskUserCallback);
    expect(await exec.execute('ask_user', {}, { chatId: 'c1' })).toMatch(/non-empty.*question/i);
    expect(await exec.execute('ask_user', { question: '' }, { chatId: 'c1' })).toMatch(/non-empty.*question/i);
    expect(await exec.execute('ask_user', { question: '   ' }, { chatId: 'c1' })).toMatch(/non-empty.*question/i);
  });

  it('forwards question + chatId to the callback and returns its reply verbatim', async () => {
    const exec = makeExecutor();
    const cb = vi.fn(async () => 'use foo.config') as unknown as AskUserCallback;
    exec.setAskUserCallback(cb);

    const result = await exec.execute(
      'ask_user',
      { question: 'Which config — foo.config or bar.config?' },
      { chatId: 'chat-7' },
    );

    expect(result).toBe('use foo.config');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({
      question: 'Which config — foo.config or bar.config?',
      chatId: 'chat-7',
    });
  });

  it('trims surrounding whitespace from the question', async () => {
    const exec = makeExecutor();
    const cb = vi.fn(async () => 'ok') as unknown as AskUserCallback;
    exec.setAskUserCallback(cb);

    await exec.execute(
      'ask_user',
      { question: '   Should I overwrite?   ' },
      { chatId: 'c' },
    );

    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Should I overwrite?' }),
    );
  });
});
