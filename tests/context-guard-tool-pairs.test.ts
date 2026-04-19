import { describe, it, expect } from 'vitest';
import { safeCutEnd } from '../src/core/context-guard.js';
import type { AIMessage } from '../src/types.js';

/**
 * Regression: on 2026-04-18, trace dXhiA9b6 failed with HTTP 400 from
 * Anthropic — "messages.0.content.0: unexpected tool_use_id in tool_result
 * blocks". Root cause: maybeCompact and pruneHistory both sliced
 * `messages.length - N` off the tail with no awareness of tool_use/tool_result
 * pairing, orphaning tool_results whose matching assistant(tool_calls) was in
 * the dropped region.
 */

function user(text: string): AIMessage {
  return { role: 'user', content: text };
}
function asst(text: string, toolCalls?: AIMessage['tool_calls']): AIMessage {
  const msg: AIMessage = { role: 'assistant', content: text };
  if (toolCalls) msg.tool_calls = toolCalls;
  return msg;
}
function toolResult(id: string, result: string): AIMessage {
  return { role: 'tool', content: result, tool_call_id: id };
}
function asstWithTools(ids: string[]): AIMessage {
  return asst(
    '',
    ids.map((id) => ({
      id,
      type: 'function',
      function: { name: 'web_search', arguments: '{}' },
    })),
  );
}

describe('safeCutEnd', () => {
  it('returns keepEnd unchanged when no tool pair is split', () => {
    const msgs = [user('a'), asst('b'), user('c'), asst('d')];
    expect(safeCutEnd(msgs, 2, 0)).toBe(2);
  });

  it('shifts left when the tail starts with a tool message', () => {
    // [user, assistant(tool_calls), tool, tool, tool, tool]
    // keepEnd = 2 → would make tail = [tool,tool,tool,tool] (orphans).
    const msgs: AIMessage[] = [
      user('search BMW'),
      asstWithTools(['t1', 't2', 't3', 't4']),
      toolResult('t1', 'r1'),
      toolResult('t2', 'r2'),
      toolResult('t3', 'r3'),
      toolResult('t4', 'r4'),
    ];
    const adjusted = safeCutEnd(msgs, 2, 0);
    // Must land at index 1 so tail starts with the assistant(tool_calls)
    expect(adjusted).toBe(1);
    expect(msgs[adjusted]?.role).toBe('assistant');
  });

  it('shifts left when the dropped region would end with an assistant(tool_calls)', () => {
    // keepEnd = 2 here would put the tool_use at index 1 in the middle and
    // the first tool_result at the head of the tail. Same orphan pattern.
    const msgs: AIMessage[] = [
      user('q'),
      asstWithTools(['t1']),
      toolResult('t1', 'r1'),
      asst('answer'),
    ];
    // rawKeepEnd = 2 → middle = [user, assistant(tc)], tail = [tool, asst]
    // tailHead = tool (orphan). Helper must shift.
    expect(safeCutEnd(msgs, 2, 0)).toBe(1);
  });

  it('returns keepStart when the entire middle consists of tool-paired traffic', () => {
    // Pathological: middle is [assistant(tc), tool, tool]. Every cut splits.
    const msgs: AIMessage[] = [
      user('start'),
      asstWithTools(['t1', 't2']),
      toolResult('t1', 'r1'),
      toolResult('t2', 'r2'),
      user('next'),
    ];
    // rawKeepEnd = 4 → tail = [user('next')]. Safe.
    expect(safeCutEnd(msgs, 4, 1)).toBe(4);
    // rawKeepEnd = 3 → tail = [tool('t2'), user('next')] — orphan, shift.
    expect(safeCutEnd(msgs, 3, 1)).toBe(1);
  });

  it('does not shift below keepStart', () => {
    const msgs: AIMessage[] = [
      user('boot'),
      asstWithTools(['t1']),
      toolResult('t1', 'r'),
    ];
    // keepStart = 1, rawKeepEnd = 3 → tail empty, safe.
    expect(safeCutEnd(msgs, 3, 1)).toBe(3);
    // rawKeepEnd = 2 → tail = [tool] (orphan). Would want to shift but
    // keepStart=1 caps it. Result: 1 (caller treats as no-op).
    expect(safeCutEnd(msgs, 2, 1)).toBe(1);
  });

  it('handles the real BMW failure shape end-to-end', () => {
    // The exact shape that triggered trace dXhiA9b6: one user message
    // followed by a tool_use with 4 parallel calls, then 4 tool_results.
    const msgs: AIMessage[] = [
      user('can you do some research about the 2025 m440i bmw online ?'),
      asstWithTools(['a', 'b', 'c', 'd']),
      toolResult('a', 'edmunds.com data — 1871 words'),
      toolResult('b', 'bmwblog.com data — 1453 words'),
      toolResult('c', 'web_search result 1'),
      toolResult('d', 'web_search result 2'),
    ];
    // maybeCompact computes rawKeepEnd = max(1, 6-4) = 2. Before the fix, tail
    // would be [tool,tool,tool,tool] with its matching assistant(tool_calls) in
    // the summarized middle — Claude returns 400. After the fix, keepEnd
    // shifts to 1 so the assistant(tool_calls) rides along with the tail.
    const rawKeepEnd = Math.max(1, msgs.length - 4);
    const keepEnd = safeCutEnd(msgs, rawKeepEnd, 0);
    expect(keepEnd).toBe(1);
    const tail = msgs.slice(keepEnd);
    expect(tail[0]?.role).toBe('assistant');
    expect(tail[0]?.tool_calls?.length).toBe(4);
    // Every tool_result now has its tool_use in the same slice.
    const toolUseIds = new Set((tail[0]?.tool_calls ?? []).map((tc) => tc.id));
    for (const m of tail.slice(1)) {
      if (m.role === 'tool') {
        expect(toolUseIds.has(m.tool_call_id ?? '')).toBe(true);
      }
    }
  });
});
