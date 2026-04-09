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

  // Extract tool calls and file operations from transcript for context
  const toolMentions = transcript.match(/\b(write_file|read_file|run_terminal_command|web_search|web_fetch|crawl_url|recall|list_directory)\b/g) ?? [];
  const uniqueTools = [...new Set(toolMentions)];
  const filesMentioned = [...new Set(transcript.match(/[`'"]?(~\/[\w\-\/\.]+\.\w+)/g) ?? [])].slice(0, 5);

  const contextHint = [
    uniqueTools.length > 0 ? `Tools used: ${uniqueTools.join(', ')}.` : '',
    filesMentioned.length > 0 ? `Files referenced: ${filesMentioned.join(', ')}.` : '',
  ].filter(Boolean).join(' ');

  try {
    const response = await ai.complete({
      messages: [{ role: 'user', content: transcript }],
      systemPrompt:
        `You are a memory summarizer. Summarize the following conversation in 2-4 sentences covering: (1) main topics discussed, (2) tasks accomplished, (3) files created or modified, (4) any key decisions or findings. ${contextHint} Be specific and concrete. Output only the summary, nothing else.`,
      model: config.model,
      maxTokens: 250,
      temperature: 0.3,
    });

    const summary = response.content?.trim();
    if (summary && summary.length > 10) {
      return summary;
    }
  } catch (err) {
    log.warn({ err }, 'LLM summarization failed, using fallback');
  }

  // Fallback: extract key info from messages
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';
  const toolSummary = uniqueTools.length > 0 ? ` Tools used: ${uniqueTools.join(', ')}.` : '';
  const fileSummary = filesMentioned.length > 0 ? ` Files: ${filesMentioned.join(', ')}.` : '';
  return `Discussed: "${firstUser.slice(0, 100)}". Last response: "${lastAssistant.slice(0, 100)}".${toolSummary}${fileSummary}`;
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
