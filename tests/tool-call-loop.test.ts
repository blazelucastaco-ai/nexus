import { describe, it, expect, vi } from 'vitest';
import { ToolCallLoop, type ToolCallLoopDeps } from '../src/core/tool-call-loop.js';
import type { AIManager } from '../src/ai/index.js';
import type { ToolExecutor } from '../src/tools/executor.js';
import type { EventLoop } from '../src/core/event-loop.js';
import type { AIMessage, AIResponse, AIToolCall, NexusConfig } from '../src/types.js';

/**
 * These tests exercise ToolCallLoop in isolation — the reason the refactor
 * exists. Previously the same behavior lived inside the 895-line
 * _handleMessage and needed the entire orchestrator + DB + telegram mock
 * to test.
 *
 * We stub AIManager.complete() to return canned responses, stub the
 * executor to return canned strings, and assert on the resulting
 * finalContent / toolCallCount / loopMessages shape.
 */

function makeToolCall(id: string, name: string, args: Record<string, unknown> = {}): AIToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function makeConfig(): NexusConfig {
  // Minimal shape — only the fields ToolCallLoop reads.
  return {
    ai: {
      provider: 'anthropic',
      model: 'claude-test',
      fastModel: 'claude-fast',
      opusModel: 'claude-opus',
      fallbackModel: 'gemini-fallback',
      maxTokens: 4096,
      temperature: 0.7,
      chatTemperature: 0.8,
    },
  } as unknown as NexusConfig;
}

function makeDeps(overrides: Partial<ToolCallLoopDeps> = {}): ToolCallLoopDeps {
  const ai = {
    complete: vi.fn<[], Promise<AIResponse>>(),
  } as unknown as AIManager;
  const toolExecutor = {
    execute: vi.fn<[], Promise<string>>(),
  } as unknown as ToolExecutor;
  const eventLoop = {
    emit: vi.fn(),
  } as unknown as EventLoop;

  return {
    ai,
    toolExecutor,
    eventLoop,
    config: makeConfig(),
    pruneHistory: (m) => m,
    maybeCompact: vi.fn(async () => {}),
    isToolError: (r) => r.startsWith('Error:') || r.startsWith('STDERR'),
    maybeSendScreenshot: vi.fn(async () => false),
    onTokenUsage: vi.fn(),
    ...overrides,
  };
}

function response(content: string, toolCalls?: AIToolCall[]): AIResponse {
  return {
    content,
    provider: 'anthropic',
    model: 'claude-test',
    tokensUsed: { input: 10, output: 5 },
    duration: 100,
    ...(toolCalls ? { toolCalls } : {}),
  };
}

describe('ToolCallLoop.run', () => {
  it('exits with the final content when the LLM returns no tool calls', async () => {
    const deps = makeDeps();
    (deps.ai.complete as any).mockResolvedValue(response('hello, world'));

    const loop = new ToolCallLoop(deps);
    const out = await loop.run({
      chatId: 'c1',
      systemPrompt: 'sys',
      startingHistory: [],
      isTaskMessage: false,
    });

    expect(out.finalContent).toBe('hello, world');
    expect(out.toolCallCount).toBe(0);
    expect(out.writeFileCallsMade).toEqual([]);
    expect(deps.ai.complete).toHaveBeenCalledTimes(1);
  });

  it('dispatches a single tool call, then exits on the follow-up text response', async () => {
    const deps = makeDeps();
    (deps.ai.complete as any)
      .mockResolvedValueOnce(response('', [makeToolCall('t1', 'read_file', { path: '/tmp/x' })]))
      .mockResolvedValueOnce(response('done reading'));
    (deps.toolExecutor.execute as any).mockResolvedValue('file contents: ...');

    const loop = new ToolCallLoop(deps);
    const out = await loop.run({
      chatId: 'c1',
      systemPrompt: 'sys',
      startingHistory: [],
      isTaskMessage: false,
    });

    expect(out.finalContent).toBe('done reading');
    expect(out.toolCallCount).toBe(1);
    expect(deps.toolExecutor.execute).toHaveBeenCalledWith('read_file', { path: '/tmp/x' });
    // The tool result should land in the loop history for the next LLM call.
    const toolMsg = out.loopMessages.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('t1');
  });

  it('detects a tool+args repetition loop after 3 identical calls', async () => {
    const deps = makeDeps();
    const call = makeToolCall('t1', 'read_file', { path: '/tmp/a' });
    (deps.ai.complete as any)
      .mockResolvedValueOnce(response('', [makeToolCall('tA', 'read_file', { path: '/tmp/a' })]))
      .mockResolvedValueOnce(response('', [makeToolCall('tB', 'read_file', { path: '/tmp/a' })]))
      .mockResolvedValueOnce(response('', [makeToolCall('tC', 'read_file', { path: '/tmp/a' })]))
      .mockResolvedValue(response('not reached'));
    (deps.toolExecutor.execute as any).mockResolvedValue('contents');

    const loop = new ToolCallLoop(deps);
    const out = await loop.run({
      chatId: 'c1',
      systemPrompt: 'sys',
      startingHistory: [],
      isTaskMessage: false,
    });

    // Loop detection kicks in on the 3rd identical call.
    expect(out.finalContent.toLowerCase()).toMatch(/loop|repeat/);
    expect(deps.toolExecutor.execute).toHaveBeenCalledTimes(2); // executed on iterations 0 and 1; blocked on 2
    void call;
  });

  it('hands malformed-JSON tool args back to the LLM as a tool error', async () => {
    const deps = makeDeps();
    // First iteration: return a bad tool call with un-parseable JSON.
    const badCall: AIToolCall = {
      id: 't-bad',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path": "/tmp/unclosed' },
    };
    (deps.ai.complete as any)
      .mockResolvedValueOnce(response('', [badCall]))
      .mockResolvedValueOnce(response('ok, recovered'));

    const loop = new ToolCallLoop(deps);
    const out = await loop.run({
      chatId: 'c1',
      systemPrompt: 'sys',
      startingHistory: [],
      isTaskMessage: false,
    });

    expect(out.finalContent).toBe('ok, recovered');
    // Executor was never called because the arg parse failed.
    expect(deps.toolExecutor.execute).not.toHaveBeenCalled();
    // A tool-role message with an Error: should be in the loop history.
    const errMsg = out.loopMessages.find(
      (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('malformed JSON'),
    );
    expect(errMsg).toBeTruthy();
  });

  it('tracks write_file calls for the downstream write-guard', async () => {
    const deps = makeDeps();
    (deps.ai.complete as any)
      .mockResolvedValueOnce(response('', [makeToolCall('w1', 'write_file', { path: '~/test.ts', content: 'x' })]))
      .mockResolvedValueOnce(response('wrote it'));
    (deps.toolExecutor.execute as any).mockResolvedValue('ok');

    const loop = new ToolCallLoop(deps);
    const out = await loop.run({
      chatId: 'c1',
      systemPrompt: 'sys',
      startingHistory: [],
      isTaskMessage: false,
    });

    expect(out.writeFileCallsMade).toEqual([{ path: '~/test.ts' }]);
  });

  it('forwards token usage via onTokenUsage callback', async () => {
    const onTokenUsage = vi.fn();
    const deps = makeDeps({ onTokenUsage });
    (deps.ai.complete as any).mockResolvedValue(response('hi'));

    const loop = new ToolCallLoop(deps);
    await loop.run({
      chatId: 'c1',
      systemPrompt: 'sys',
      startingHistory: [],
      isTaskMessage: false,
    });

    expect(onTokenUsage).toHaveBeenCalledWith(10, 5);
  });

  it('short-circuits on successful screenshot — screenshot is always the last action of a turn', async () => {
    const deps = makeDeps();
    (deps.maybeSendScreenshot as any).mockResolvedValue(true);
    (deps.ai.complete as any)
      .mockResolvedValueOnce(response('here is your screenshot', [makeToolCall('s1', 'take_screenshot')]))
      .mockResolvedValue(response('should not be reached'));
    (deps.toolExecutor.execute as any).mockResolvedValue('data:image/png;base64,...');

    const loop = new ToolCallLoop(deps);
    const out = await loop.run({
      chatId: 'c1',
      systemPrompt: 'sys',
      startingHistory: [],
      isTaskMessage: false,
    });

    // Screenshot short-circuits: we use the LLM's content from the iteration that fired it.
    expect(out.finalContent).toMatch(/screenshot/i);
    // Only one LLM call — the loop broke out after the screenshot tool.
    expect(deps.ai.complete).toHaveBeenCalledTimes(1);
  });

  it('seeds the loop with the pruned startingHistory', async () => {
    const pruneHistory = vi.fn((msgs: AIMessage[]) => msgs.slice(-2));
    const deps = makeDeps({ pruneHistory });
    (deps.ai.complete as any).mockResolvedValue(response('ok'));

    const history: AIMessage[] = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'turn 3' },
    ];
    const loop = new ToolCallLoop(deps);
    const out = await loop.run({
      chatId: 'c1',
      systemPrompt: 'sys',
      startingHistory: history,
      isTaskMessage: false,
    });

    expect(pruneHistory).toHaveBeenCalledTimes(1);
    // Pruned + empty assistant (no tool-call → no push); history in output is the pruned set.
    expect(out.loopMessages.length).toBe(2);
  });
});
