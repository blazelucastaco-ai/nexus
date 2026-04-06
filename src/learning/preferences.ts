// Nexus AI — Preference learning from observed user behavior

import type { MemoryCortex } from '../memory/cortex.js';
import type { UserFact } from '../types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('PreferenceLearner');

const INITIAL_CONFIDENCE = 0.3;
const CONFIDENCE_INCREMENT = 0.12;
const MAX_CONFIDENCE = 0.95;
const MIN_OBSERVATIONS_FOR_PATTERN = 3;

interface Observation {
  choice: string;
  context?: string;
  timestamp: Date;
}

interface CategoryData {
  observations: Observation[];
  counts: Map<string, number>;
}

export class PreferenceLearner {
  private cortex: MemoryCortex;
  private categories: Map<string, CategoryData> = new Map();

  constructor(cortex: MemoryCortex) {
    this.cortex = cortex;
    this.loadExistingPreferences();
    log.info('PreferenceLearner initialized');
  }

  /**
   * Load existing preference facts from the cortex to seed in-memory state.
   */
  private loadExistingPreferences(): void {
    try {
      const facts = this.cortex.getFacts('preference');
      for (const fact of facts) {
        const category = fact.key.split(':')[0] ?? fact.key;
        if (!this.categories.has(category)) {
          this.categories.set(category, { observations: [], counts: new Map() });
        }
        const data = this.categories.get(category)!;
        // Reconstruct approximate observation count from confidence
        const approxCount = Math.max(
          1,
          Math.round((fact.confidence - INITIAL_CONFIDENCE) / CONFIDENCE_INCREMENT) + 1,
        );
        data.counts.set(fact.value, (data.counts.get(fact.value) ?? 0) + approxCount);
      }
      log.debug({ loaded: facts.length }, 'Loaded existing preferences from cortex');
    } catch {
      log.debug('No existing preferences found — starting fresh');
    }
  }

  /**
   * Record a user choice within a category, with optional context describing the situation.
   */
  observeChoice(category: string, choice: string, context?: string): void {
    if (!this.categories.has(category)) {
      this.categories.set(category, { observations: [], counts: new Map() });
    }

    const data = this.categories.get(category)!;

    data.observations.push({ choice, context, timestamp: new Date() });
    data.counts.set(choice, (data.counts.get(choice) ?? 0) + 1);

    // Persist to cortex when confidence is meaningful
    const totalObs = Array.from(data.counts.values()).reduce((a, b) => a + b, 0);
    const choiceCount = data.counts.get(choice)!;
    const confidence = this.computeConfidence(choiceCount, totalObs);

    if (totalObs >= MIN_OBSERVATIONS_FOR_PATTERN && confidence >= INITIAL_CONFIDENCE) {
      this.persistPreference(category, choice, confidence);
    }

    log.debug({ category, choice, count: choiceCount, total: totalObs }, 'Choice observed');
  }

  /**
   * Analyze choices within a category and detect repeating patterns.
   * Returns the dominant pattern and its confidence, or null if insufficient data.
   */
  detectPattern(category: string): { pattern: string; confidence: number } | null {
    const data = this.categories.get(category);
    if (!data || data.counts.size === 0) return null;

    const totalObs = Array.from(data.counts.values()).reduce((a, b) => a + b, 0);
    if (totalObs < MIN_OBSERVATIONS_FOR_PATTERN) return null;

    // Find the most frequent choice
    let topChoice = '';
    let topCount = 0;
    for (const [choice, count] of data.counts) {
      if (count > topCount) {
        topChoice = choice;
        topCount = count;
      }
    }

    const confidence = this.computeConfidence(topCount, totalObs);

    // Check for time-based patterns in observations
    const recentObs = data.observations.slice(-20);
    const contextPattern = this.detectContextPattern(recentObs);

    if (contextPattern) {
      return {
        pattern: `Prefers "${topChoice}" for ${category}${contextPattern}`,
        confidence,
      };
    }

    return {
      pattern: `Prefers "${topChoice}" for ${category} (${topCount}/${totalObs} observations)`,
      confidence,
    };
  }

  /**
   * Get the highest-confidence learned preference for a category.
   * Returns null if no preference is established or confidence is too low.
   */
  getPreference(category: string): { value: string; confidence: number } | null {
    const data = this.categories.get(category);
    if (!data || data.counts.size === 0) return null;

    const totalObs = Array.from(data.counts.values()).reduce((a, b) => a + b, 0);
    if (totalObs < 2) return null;

    let topChoice = '';
    let topCount = 0;
    for (const [choice, count] of data.counts) {
      if (count > topCount) {
        topChoice = choice;
        topCount = count;
      }
    }

    const confidence = this.computeConfidence(topCount, totalObs);
    if (confidence < INITIAL_CONFIDENCE) return null;

    return { value: topChoice, confidence };
  }

  /**
   * Get all learned preferences across every category.
   */
  getAllPreferences(): Array<{ category: string; value: string; confidence: number }> {
    const results: Array<{ category: string; value: string; confidence: number }> = [];

    for (const [category] of this.categories) {
      const pref = this.getPreference(category);
      if (pref) {
        results.push({ category, value: pref.value, confidence: pref.confidence });
      }
    }

    // Sort by confidence descending
    results.sort((a, b) => b.confidence - a.confidence);
    return results;
  }

  /**
   * Suggest a preference value for a category given the current context.
   * Uses learned patterns to recommend the most likely preferred choice.
   * Returns null if there is not enough data to make a suggestion.
   */
  suggestPreference(category: string, context: string): string | null {
    const data = this.categories.get(category);
    if (!data || data.counts.size === 0) return null;

    // Look for context-specific patterns first
    const contextLower = context.toLowerCase();
    const contextMatches = new Map<string, number>();

    for (const obs of data.observations) {
      if (obs.context && contextLower.includes(obs.context.toLowerCase())) {
        contextMatches.set(obs.choice, (contextMatches.get(obs.choice) ?? 0) + 1);
      }
    }

    // If we have context-specific data, use it
    if (contextMatches.size > 0) {
      let bestChoice = '';
      let bestCount = 0;
      for (const [choice, count] of contextMatches) {
        if (count > bestCount) {
          bestChoice = choice;
          bestCount = count;
        }
      }
      if (bestCount >= 2) {
        log.debug({ category, context, suggestion: bestChoice }, 'Context-based suggestion');
        return bestChoice;
      }
    }

    // Fall back to overall preference
    const pref = this.getPreference(category);
    if (pref && pref.confidence >= 0.4) {
      log.debug({ category, suggestion: pref.value, confidence: pref.confidence }, 'General suggestion');
      return pref.value;
    }

    return null;
  }

  /**
   * Compute a confidence score from observation frequency.
   * Uses a logarithmic curve so early observations move the needle quickly,
   * but later observations have diminishing returns.
   */
  private computeConfidence(choiceCount: number, totalObs: number): number {
    if (totalObs === 0) return 0;

    const frequency = choiceCount / totalObs;
    // Boost confidence with more data points (log curve)
    const dataBoost = Math.min(Math.log2(totalObs + 1) / 10, 0.3);
    const raw = frequency * 0.7 + dataBoost;

    return Math.min(Math.max(raw, 0), MAX_CONFIDENCE);
  }

  /**
   * Look for contextual patterns in recent observations (e.g., same context repeatedly).
   */
  private detectContextPattern(observations: Observation[]): string | null {
    if (observations.length < 3) return null;

    const contextCounts = new Map<string, number>();
    for (const obs of observations) {
      if (obs.context) {
        contextCounts.set(obs.context, (contextCounts.get(obs.context) ?? 0) + 1);
      }
    }

    for (const [ctx, count] of contextCounts) {
      if (count >= 3) {
        return ` (especially when ${ctx})`;
      }
    }

    return null;
  }

  /**
   * Persist a learned preference as a UserFact in the memory cortex.
   */
  private persistPreference(category: string, value: string, confidence: number): void {
    try {
      this.cortex.storeFact({
        category: 'preference',
        key: `${category}:learned`,
        value,
        confidence,
      });
      log.debug({ category, value, confidence }, 'Preference persisted to cortex');
    } catch (err) {
      // storeFact may fail on duplicate key — update instead by re-storing
      log.debug({ category, err }, 'Preference persist failed (may already exist), skipping');
    }
  }
}
