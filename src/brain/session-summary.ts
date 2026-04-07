// NEXUS Brain — Session Auto-Summary (Phase 1.4)
//
// Summarizes conversation sessions and stores them as episodic memories
// so NEXUS remembers what happened across restarts.

import { createLogger } from '../utils/logger.js';
import type { AIMessage } from '../types.js';
import type { AIManager } from '../ai/index.js';
import type { MemoryManager } from '../memory/index.js';

const log = createLogger('SessionSummary');

/**
 * Call the LLM to produce a 1-2 sentence summary of the conversation.
 * Falls back to a simple truncation if the LLM call fails.
 */
export async function summarizeSession(
  messages: Array<{ role: string; content: string }>,
  ai: AIManager,
  config: { model: string; temperature: number },
): Promise<string> {
  if (messages.length === 0) return '';

  // Build a compact transcript (last 20 messages max)
  const transcript = messages
    .slice(-20)
    .map((m) => `${m.role === 'user' ? 'User' : 'NEXUS'}: ${(m.content ?? '').slice(0, 300)}`)
    .join('\n');

  try {
    const response = await ai.complete({
      messages: [{ role: 'user', content: transcript }],
      systemPrompt:
        'You are a memory summarizer. Summarize the following conversation in 1-2 sentences, focusing on what was discussed and what was accomplished. Be specific and concrete. Output only the summary, nothing else.',
      model: config.model,
      maxTokens: 150,
      temperature: 0.3,
    });

    const summary = response.content?.trim();
    if (summary && summary.length > 10) {
      return summary;
    }
  } catch (err) {
    log.warn({ err }, 'LLM summarization failed, using fallback');
  }

  // Fallback: extract the first user message and last assistant message
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';
  return `Discussed: "${firstUser.slice(0, 100)}". Last response: "${lastAssistant.slice(0, 100)}".`;
}

/**
 * Store a session summary as an episodic memory.
 */
export async function storeSessionSummary(
  summary: string,
  memory: MemoryManager,
  source: string,
  turnCount: number,
): Promise<void> {
  if (!summary || summary.length < 5) return;

  try {
    memory.store(
      'episodic',
      'conversation',
      `[Session Summary] ${summary}`,
      {
        importance: 0.75,
        tags: ['session-summary', 'auto-generated'],
        source,
        metadata: { turnCount, generatedAt: new Date().toISOString() },
      },
    );
    log.info({ turnCount, summaryLen: summary.length }, 'Session summary stored');
  } catch (err) {
    log.error({ err }, 'Failed to store session summary');
  }
}
