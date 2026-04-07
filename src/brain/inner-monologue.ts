// Brain Phase 2.4 — Inner Monologue
//
// Generates a first-person "thinking out loud" stream that shows NEXUS's
// reasoning process before it responds. Can be toggled on/off; when enabled,
// responses are prefixed with a 💭 thought bubble section.

import { createLogger } from '../utils/logger.js';
import type { AIManager } from '../ai/index.js';

const log = createLogger('InnerMonologue');

export interface ThoughtContext {
  task: string;
  emotion: string;
  memories: string[];
  recentHistory: string;
}

export class InnerMonologue {
  private thinkMode = false;

  constructor(private ai: AIManager) {}

  /** Whether think mode is currently active. */
  isEnabled(): boolean {
    return this.thinkMode;
  }

  /**
   * Toggle think mode on/off.
   * Returns the new state.
   */
  toggleThinkMode(forceValue?: boolean): boolean {
    this.thinkMode = forceValue !== undefined ? forceValue : !this.thinkMode;
    log.info({ thinkMode: this.thinkMode }, 'Think mode toggled');
    return this.thinkMode;
  }

  /**
   * Generate a brief inner monologue thought based on the current context.
   * Returns an empty string on failure so callers can safely ignore errors.
   */
  async generateThought(context: ThoughtContext): Promise<string> {
    try {
      const memorySummary = context.memories.length > 0
        ? `Relevant memories surfacing: ${context.memories.slice(0, 3).join('; ')}.`
        : 'No specific memories triggered.';

      const historySnippet = context.recentHistory.length > 0
        ? context.recentHistory.slice(0, 400)
        : 'No prior context.';

      const response = await this.ai.complete({
        messages: [
          {
            role: 'user',
            content: `Think through this before responding: "${context.task}"`,
          },
        ],
        systemPrompt: `You are NEXUS thinking privately to yourself before composing a response.
Current emotion: ${context.emotion}.
${memorySummary}
Recent conversation: ${historySnippet}

Write a short, authentic inner monologue (2-4 sentences, first person) that shows your reasoning process, any relevant memories surfacing, and emotional context — like an actor finding their motivation. Be genuine, not performative. Do NOT write the actual response — only the internal thought leading up to it.

Example style: "Hmm, Lucas is asking about TypeScript again. Last time we talked about this he was frustrated with the type system. I should be careful not to be preachy about types — meet him where he is."`,
        maxTokens: 180,
        temperature: 0.85,
      });

      return response.content.trim();
    } catch (err) {
      log.warn({ err }, 'Failed to generate inner monologue thought');
      return '';
    }
  }
}
