// Context providers.
//
// The system prompt is assembled by a registry of ContextProvider
// implementations. Each provider declares a priority (ordering) and
// returns either a prompt section string or null (contribute nothing
// this turn). Replaces the 200-line buildFullSystemPrompt if-cascade
// with a composable, testable registry.
//
// Callers register providers once (during orchestrator init) and then
// call `builder.build(input)` on every turn. Providers are queried with
// a single `ProviderInput` object so they don't need positional args.

import { createLogger } from '../utils/logger.js';
import type { NexusContext } from '../types.js';

const log = createLogger('ContextProvider');

/**
 * Input visible to every provider. Providers may read any field but must
 * not mutate it. If a provider needs dynamic info (memories, reasoning
 * trace, etc.) it's passed here rather than grabbed from globals — keeps
 * providers testable in isolation.
 */
export interface ProviderInput {
  context: NexusContext;
  preventionWarning?: string;
  preferenceConflict?: string;
  injectionDetected?: { confidence: number; patterns: string[] };
  memorySynthesis?: string;
  reasoningTrace?: string;
  continuityBrief?: string;
  activeGoals?: string[];
  skillsPrompt?: string;
  learningInsights?: string[];
  learnedPreferences?: Array<{ category: string; value: string; confidence: number }>;
  /** Epoch ms when the request started — for uptime / time fields. */
  nowEpochMs: number;
  /** System uptime in ms (for self-awareness section). */
  uptimeMs: number;
  /** Free-form extras for rare providers. */
  extras?: Record<string, unknown>;
}

/**
 * A provider contributes one section to the system prompt.
 * `priority` controls ordering (lower = earlier). Providers with the
 * same priority are stable-ordered by registration order.
 */
export interface ContextProvider {
  name: string;
  priority: number;
  /**
   * Return the prompt section string, or null to skip this turn.
   * Should be idempotent and fast (no I/O).
   */
  contribute(input: ProviderInput): string | null;
}

/**
 * Registry + builder. Build the system prompt by running every registered
 * provider in priority order and concatenating the non-null results with
 * blank lines.
 */
export class ContextPromptBuilder {
  private providers: ContextProvider[] = [];

  register(provider: ContextProvider): void {
    this.providers.push(provider);
    // Keep list sorted by priority so build() is O(n) instead of O(n log n) per call.
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  unregister(name: string): boolean {
    const idx = this.providers.findIndex((p) => p.name === name);
    if (idx < 0) return false;
    this.providers.splice(idx, 1);
    return true;
  }

  /** Names in the current order — debug / inspection helper. */
  list(): Array<{ name: string; priority: number }> {
    return this.providers.map(({ name, priority }) => ({ name, priority }));
  }

  /**
   * Build the full system prompt by invoking every provider in order.
   * Skipped providers (null return) are excluded. Providers are joined
   * with a single blank line.
   */
  build(input: ProviderInput): string {
    const sections: string[] = [];
    for (const p of this.providers) {
      let section: string | null = null;
      try {
        section = p.contribute(input);
      } catch (err) {
        log.warn({ err, provider: p.name }, 'Context provider threw — skipping');
        continue;
      }
      if (section && section.trim().length > 0) {
        sections.push(section);
      }
    }
    return sections.join('\n');
  }
}

// Priority lanes — keeps the ordering consistent across providers.
// Lower = earlier in the prompt (more foundational).
export const PRIORITY = {
  IDENTITY: 0,
  SECURITY: 100,
  CAPABILITIES: 200,
  PERSONALITY: 300,
  STATE: 400,            // current emotion, mood
  MEMORY: 500,           // relevant memories, facts
  SYNTHESIS: 600,        // memory synthesis paragraph
  REASONING_TRACE: 700,
  LEARNING: 800,         // insights, preferences, warnings
  PLATFORM: 900,         // macOS, tool usage
  WORKSPACE: 1000,
  SYSTEM_INFO: 1100,     // date/time, uptime
  AGENTS: 1200,          // agent list
  BROWSER: 1300,
  GOALS: 1400,
  CONTINUITY: 1500,      // last-session brief (first turn only)
  SKILLS: 1600,          // runtime-loaded skills (end of prompt for recency bias)
} as const;
