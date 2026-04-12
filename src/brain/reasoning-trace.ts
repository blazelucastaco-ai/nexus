// Nexus AI — Pre-Response Reasoning Trace
//
// Runs a lightweight (~150 token) LLM reasoning step before every
// substantive response. Output shapes the final response but is NEVER
// shown to the user — it's a cognitive "pause and think" layer.
//
// The trace asks: what is being asked, what context matters most,
// and what approach should I take? The answers are injected into the
// system prompt so the main LLM call starts from an already-reasoned
// starting point.
//
// Only fires for messages above a minimum length threshold (to skip
// trivial greetings and one-liners).

import { createLogger } from '../utils/logger.js';
import type { AIManager } from '../ai/index.js';

const log = createLogger('ReasoningTrace');

const MIN_QUERY_LENGTH = 25;

export interface TraceOutput {
  approach: string;     // How to approach the response
  keyContext: string;   // What context/memory is most relevant
  caveats: string;      // Anything to watch out for
  traced: boolean;      // Whether a trace was actually run
}

const EMPTY_TRACE: TraceOutput = {
  approach: '',
  keyContext: '',
  caveats: '',
  traced: false,
};

export class ReasoningTrace {
  private aiManager: AIManager;
  private enabled = true;

  constructor(aiManager: AIManager) {
    this.aiManager = aiManager;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    log.info({ enabled }, 'Reasoning trace toggled');
  }

  async think(params: {
    query: string;
    synthesizedMemory: string;
    recentHistory: string;
    activeGoals: string[];
  }): Promise<TraceOutput> {
    if (!this.enabled || params.query.length < MIN_QUERY_LENGTH) return EMPTY_TRACE;

    const goalBlock = params.activeGoals.length > 0
      ? `\nUser's active goals: ${params.activeGoals.slice(0, 3).join('; ')}`
      : '';

    const memoryBlock = params.synthesizedMemory
      ? `\nRelevant memory: ${params.synthesizedMemory.slice(0, 250)}`
      : '';

    try {
      const response = await this.aiManager.complete({
        messages: [
          {
            role: 'user',
            content:
              `You are NEXUS's internal reasoning layer. Think through the best way to respond.\n\n` +
              `User message: "${params.query.slice(0, 200)}"` +
              memoryBlock +
              goalBlock +
              `\n\nOutput EXACTLY this format (one line each, no other text):\n` +
              `APPROACH: [how to respond — tone, depth, format — in 1 sentence]\n` +
              `CONTEXT: [which part of memory/history matters most — in 1 sentence]\n` +
              `WATCH: [any pitfall, edge case, or preference to honor — in 1 sentence]`,
          },
        ],
        maxTokens: 160,
        temperature: 0.2,
      });

      const text = response.content.trim();
      const approach = text.match(/^APPROACH:\s*(.+)/m)?.[1]?.trim() ?? '';
      const keyContext = text.match(/^CONTEXT:\s*(.+)/m)?.[1]?.trim() ?? '';
      const caveats = text.match(/^WATCH:\s*(.+)/m)?.[1]?.trim() ?? '';

      if (!approach && !keyContext) return EMPTY_TRACE;

      log.debug({ approach: approach.slice(0, 60) }, 'Reasoning trace complete');

      return { approach, keyContext, caveats, traced: true };
    } catch (err) {
      log.debug({ err }, 'Reasoning trace skipped');
      return EMPTY_TRACE;
    }
  }

  /** Format trace output as a system prompt injection block. */
  formatForPrompt(trace: TraceOutput): string {
    if (!trace.traced) return '';

    const lines = ['## Internal Reasoning (pre-response)'];
    if (trace.approach) lines.push(`- Approach: ${trace.approach}`);
    if (trace.keyContext) lines.push(`- Key context: ${trace.keyContext}`);
    if (trace.caveats) lines.push(`- Watch for: ${trace.caveats}`);
    return lines.join('\n');
  }
}
