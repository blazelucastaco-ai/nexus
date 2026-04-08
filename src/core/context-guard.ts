// Context Guard — monitors token usage and triggers compaction before overflow
// Uses rough char/4 estimate for Gemini's 1M token context window.

import { createLogger } from '../utils/logger.js';
import type { AIMessage } from '../types.js';

const log = createLogger('ContextGuard');

const GEMINI_CONTEXT_WINDOW = 1_000_000; // tokens
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
  const percentUsed = estimatedTokens / GEMINI_CONTEXT_WINDOW;

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
 * Aggressively prune messages to reduce context size.
 * Keeps system prompt intact, drops oldest tool call results first,
 * then trims oldest messages.
 */
export function aggressiveCompact(messages: AIMessage[], targetTokenBudget: number): AIMessage[] {
  const targetChars = targetTokenBudget * CHARS_PER_TOKEN;
  let result = [...messages];

  // First pass: shorten tool result messages
  result = result.map((msg) => {
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 500) {
      return { ...msg, content: msg.content.slice(0, 500) + '\n[compacted]' };
    }
    return msg;
  });

  // Second pass: drop oldest messages until we fit
  const currentChars = result.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 100), 0);
  if (currentChars <= targetChars) return result;

  // Keep the last N messages that fit
  while (result.length > 4) {
    result.splice(0, 1); // drop oldest
    const chars = result.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 100), 0);
    if (chars <= targetChars) break;
  }

  log.info({ retained: result.length }, 'Aggressive compaction applied');
  return result;
}
