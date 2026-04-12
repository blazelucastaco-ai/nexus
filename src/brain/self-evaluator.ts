// Nexus AI — Response Self-Evaluator
//
// Post-response completeness check (~80 tokens). After NEXUS generates a
// response, this module asks a quick LLM question: "Did that fully answer
// the question?" If not, it returns a short "Worth noting / I can also..."
// addendum that gets appended to the response.
//
// Runs asynchronously after the response is returned to the user — the
// appended note is sent as a follow-up Telegram message if non-null.
// This keeps the main response fast while still catching incomplete answers.

import { createLogger } from '../utils/logger.js';
import type { AIManager } from '../ai/index.js';

const log = createLogger('SelfEvaluator');

const MIN_RESPONSE_LENGTH = 60;
const MAX_QUERY_WORDS = 50; // Skip evaluation for very long queries

export class SelfEvaluator {
  private aiManager: AIManager;
  private enabled = true;

  constructor(aiManager: AIManager) {
    this.aiManager = aiManager;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    log.info({ enabled }, 'Self-evaluator toggled');
  }

  /**
   * Evaluates whether a response fully answered the question.
   * Returns an optional addendum string, or null if the response was complete.
   */
  async evaluate(query: string, response: string): Promise<string | null> {
    if (!this.enabled) return null;
    if (response.length < MIN_RESPONSE_LENGTH) return null;

    const wordCount = query.split(/\s+/).length;
    if (wordCount < 4 || wordCount > MAX_QUERY_WORDS) return null;

    // Skip trivial conversational exchanges
    const trivialPatterns = /^(hi|hey|hello|thanks|ok|okay|yes|no|sure|got it|cool|great|nice|wow)[\s!.?]*$/i;
    if (trivialPatterns.test(query.trim())) return null;

    try {
      const result = await this.aiManager.complete({
        messages: [
          {
            role: 'user',
            content:
              `Evaluate if this response fully answered the question.\n\n` +
              `Question: "${query.slice(0, 180)}"\n\n` +
              `Response: "${response.slice(0, 350)}"\n\n` +
              `Reply with ONLY one of:\n` +
              `COMPLETE\n` +
              `INCOMPLETE: [what was missed — start with "Worth noting:" or "I can also:"]`,
          },
        ],
        maxTokens: 80,
        temperature: 0.1,
      });

      const text = result.content.trim();

      if (text.startsWith('COMPLETE')) return null;

      if (text.startsWith('INCOMPLETE:')) {
        const note = text.replace('INCOMPLETE:', '').trim();
        if (note.length >= 15) {
          log.debug({ note: note.slice(0, 80) }, 'Self-evaluator found incomplete response');
          return note;
        }
      }

      return null;
    } catch (err) {
      log.debug({ err }, 'Self-evaluation skipped');
      return null;
    }
  }
}
