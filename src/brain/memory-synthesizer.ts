// Nexus AI — Memory Synthesizer
//
// Before each response, synthesizes raw memory fragments into a coherent
// paragraph via one fast LLM call. Feeds the synthesis into the system
// prompt instead of (or alongside) raw fragments, giving the LLM a much
// better understanding of relevant context.
//
// Also tracks which memory IDs were deemed relevant so the feedback loop
// can bump their importance after use.

import { createLogger } from '../utils/logger.js';
import type { AIManager } from '../ai/index.js';
import type { Memory, UserFact } from '../types.js';

const log = createLogger('MemorySynthesizer');

export interface SynthesisResult {
  synthesis: string;        // Coherent paragraph for the system prompt
  usedMemoryIds: string[];  // Memory IDs included (for feedback loop)
}

export class MemorySynthesizer {
  private aiManager: AIManager;

  constructor(aiManager: AIManager) {
    this.aiManager = aiManager;
  }

  async synthesize(
    query: string,
    memories: Memory[],
    facts: UserFact[],
    activeGoals: string[],
  ): Promise<SynthesisResult> {
    // Cap to avoid token bloat
    const topMemories = memories.slice(0, 8);
    const topFacts = facts.slice(0, 5);
    const usedMemoryIds = topMemories.map((m) => m.id);

    if (topMemories.length === 0 && topFacts.length === 0 && activeGoals.length === 0) {
      return { synthesis: '', usedMemoryIds: [] };
    }

    const memoryLines = topMemories
      .map((m) => `[${m.type}] ${m.summary ?? m.content.slice(0, 150)}`)
      .join('\n');

    const factLines = topFacts
      .map((f) => `${f.key}: ${f.value}`)
      .join('\n');

    const goalBlock = activeGoals.length > 0
      ? `\nUser's active goals:\n${activeGoals.slice(0, 3).map((g) => `- ${g.slice(0, 150)}`).join('\n')}`
      : '';

    try {
      const response = await this.aiManager.complete({
        messages: [
          {
            role: 'user',
            content:
              `You are NEXUS's memory cortex. Given raw memory fragments and the current query, ` +
              `write ONE short paragraph (3-4 sentences max) summarizing what NEXUS knows that is ` +
              `relevant to answering this query. Be specific. Reference the user's preferences and ` +
              `history where relevant. Output ONLY the paragraph — no preamble.\n\n` +
              `Query: "${query.slice(0, 200)}"\n\n` +
              `Memory fragments:\n${memoryLines || '(none)'}\n\n` +
              `Known facts:\n${factLines || '(none)'}` +
              goalBlock,
          },
        ],
        maxTokens: 250,
        temperature: 0.25,
      });

      const synthesis = response.content.trim();
      log.debug({ chars: synthesis.length, memoryCount: topMemories.length }, 'Memory synthesized');

      return {
        synthesis: synthesis.length > 20 ? synthesis : '',
        usedMemoryIds,
      };
    } catch (err) {
      log.debug({ err }, 'Memory synthesis LLM call failed — using text fallback');

      // Fallback: join summaries without LLM
      const fallback = topMemories
        .map((m) => m.summary ?? m.content.slice(0, 100))
        .filter(Boolean)
        .join(' | ');

      return { synthesis: fallback, usedMemoryIds };
    }
  }
}
