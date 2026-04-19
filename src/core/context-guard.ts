// Context Guard — monitors token usage and triggers compaction before overflow
// Uses rough char/4 estimate for Claude's ~200K token context window.

import { createLogger } from '../utils/logger.js';
import type { AIMessage } from '../types.js';

const log = createLogger('ContextGuard');

const CONTEXT_WINDOW = 200_000; // tokens — Claude Sonnet/Opus context window
const WARN_THRESHOLD = 0.6;  // warn at 60%
const COMPACT_THRESHOLD = 0.8; // compact at 80%
const CHARS_PER_TOKEN = 4;

export interface ContextGuardStatus {
  estimatedTokens: number;
  percentUsed: number;
  shouldWarn: boolean;
  shouldCompact: boolean;
}

/**
 * Estimate token count from character count (rough: 4 chars = 1 token).
 */
export function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

/**
 * Estimate total tokens for a conversation (system prompt + messages).
 */
export function estimateConversationTokens(
  systemPrompt: string,
  messages: AIMessage[],
): number {
  let totalChars = systemPrompt.length;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ text?: string }>) {
        totalChars += part.text?.length ?? 0;
      }
    }
    if (msg.tool_calls) {
      totalChars += JSON.stringify(msg.tool_calls).length;
    }
  }
  return estimateTokens(totalChars);
}

/**
 * Check context window usage and return status + recommendations.
 */
export function checkContextUsage(
  systemPrompt: string,
  messages: AIMessage[],
): ContextGuardStatus {
  const estimatedTokens = estimateConversationTokens(systemPrompt, messages);
  const percentUsed = estimatedTokens / CONTEXT_WINDOW;

  if (percentUsed >= COMPACT_THRESHOLD) {
    log.warn(
      { estimatedTokens, percentUsed: (percentUsed * 100).toFixed(1) },
      'Context window >80% full — triggering compaction',
    );
  } else if (percentUsed >= WARN_THRESHOLD) {
    log.warn(
      { estimatedTokens, percentUsed: (percentUsed * 100).toFixed(1) },
      'Context window >60% full — approaching limit',
    );
  }

  return {
    estimatedTokens,
    percentUsed,
    shouldWarn: percentUsed >= WARN_THRESHOLD,
    shouldCompact: percentUsed >= COMPACT_THRESHOLD,
  };
}

/**
 * Shift a cut point left until splitting at that index cannot orphan a
 * tool_use/tool_result pair.
 *
 * Semantics: `messages.slice(keepStart, cutEnd)` is the region that callers
 * will drop/summarize; `messages.slice(cutEnd)` is the region they keep.
 *
 * A split is "unsafe" if either:
 *   - the kept tail starts with a `role:'tool'` message whose matching
 *     assistant(tool_calls) is inside the dropped region, OR
 *   - the dropped region ends with an assistant(tool_calls) whose
 *     tool results are at the head of the kept tail.
 *
 * Both forms produce an orphan tool_result once converted to Anthropic's
 * API shape, which returns HTTP 400. This helper shifts cutEnd left until
 * neither condition holds, returning keepStart in the worst case (meaning
 * there is nothing safe to compact — callers should treat that as a no-op).
 */
export function safeCutEnd(messages: AIMessage[], cutEnd: number, keepStart = 0): number {
  let adjusted = Math.min(cutEnd, messages.length);
  while (adjusted > keepStart) {
    const tailHead = messages[adjusted];
    const middleTail = messages[adjusted - 1];
    const tailStartsWithTool = tailHead?.role === 'tool';
    const middleEndsWithToolUse =
      middleTail?.role === 'assistant' &&
      Array.isArray(middleTail.tool_calls) &&
      middleTail.tool_calls.length > 0;
    if (tailStartsWithTool || middleEndsWithToolUse) {
      adjusted--;
      continue;
    }
    break;
  }
  return adjusted;
}

/**
 * Aggressively prune messages to reduce context size.
 * Strategy: compress tool results first (keep only summaries), then drop oldest.
 * Preserves tool call/result pairs to avoid orphaned messages.
 */
export function aggressiveCompact(messages: AIMessage[], targetTokenBudget: number): AIMessage[] {
  const targetChars = targetTokenBudget * CHARS_PER_TOKEN;
  let result = [...messages];
  const getChars = () => result.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 100), 0);

  // Phase 1: Compress large tool results (keep first 200 chars + error lines)
  result = result.map((msg) => {
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 300) {
      const content = msg.content;
      // Keep first line (usually shows what happened) + any error lines
      const lines = content.split('\n');
      const summary = lines[0]?.slice(0, 150) ?? '';
      const errorLines = lines
        .filter(l => /error|Error|failed|Failed|ENOENT|EACCES|exit code/i.test(l))
        .slice(0, 3)
        .map(l => l.slice(0, 150));
      const compressed = errorLines.length > 0
        ? `${summary}\n${errorLines.join('\n')}\n[compacted from ${content.length} chars]`
        : `${summary} [compacted from ${content.length} chars]`;
      return { ...msg, content: compressed };
    }
    return msg;
  });

  if (getChars() <= targetChars) return result;

  // Phase 2: Drop oldest messages, but never orphan tool_call/result pairs
  // Protect: first user message + last 8 messages
  const protectedTail = Math.min(8, result.length - 1);

  while (result.length > protectedTail + 1 && getChars() > targetChars) {
    // Find the oldest non-protected message to remove
    // Skip index 0 (first user message) if it's a user message
    const removeIdx = result[0]?.role === 'user' ? 1 : 0;
    if (removeIdx >= result.length - protectedTail) break;

    // Never orphan tool results: if we'd remove an assistant with tool_calls
    // followed by tool results, remove them together (or stop).
    const toRemove = result[removeIdx];
    if (toRemove?.role === 'assistant' && toRemove.tool_calls && toRemove.tool_calls.length > 0) {
      // Count how many consecutive tool messages follow
      let toolCount = 0;
      while (result[removeIdx + 1 + toolCount]?.role === 'tool') toolCount++;
      if (removeIdx + 1 + toolCount >= result.length - protectedTail) break;
      result.splice(removeIdx, 1 + toolCount);
    } else if (toRemove?.role === 'tool') {
      // Orphan tool result at the head — drop it (the matching assistant msg is already gone)
      result.splice(removeIdx, 1);
    } else {
      result.splice(removeIdx, 1);
    }
  }

  log.info({ retained: result.length, chars: getChars() }, 'Aggressive compaction applied');
  return result;
}
