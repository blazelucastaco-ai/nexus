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
  private model?: string;

  constructor(private ai: AIManager, model?: string) {
    this.model = model;
  }

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
   * Returns an empty string on failure or for trivial/short messages.
   */
  async generateThought(context: ThoughtContext): Promise<string> {
    // Skip the LLM call for very short or trivially simple messages
    if (context.task.length < 15) return '';

    const TRIVIAL_PATTERNS = /^(hi|hey|hello|thanks|ok|okay|yes|no|sure|got it|cool|great|nice|wow|lol|👍|👋|🙏|nope|yep|yup|nah|k|thx|ty)[\s!.?]*$/i;
    if (TRIVIAL_PATTERNS.test(context.task.trim())) return '';

    try {
      const memorySummary = context.memories.length > 0
        ? `Relevant memories surfacing: ${context.memories.slice(0, 3).join('; ')}.`
        : 'No specific memories triggered.';

      const historySnippet = context.recentHistory.length > 0
        ? context.recentHistory.slice(0, 400)
        : 'No prior context.';

      const response = await this.ai.complete({
        model: this.model,
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
