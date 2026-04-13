import type { EmotionalState, EmotionLabel, PersonalityTraits } from '../types.js';
import { clamp, lerp } from '../utils/helpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('EmotionalEngine');

/** Force vector applied to each emotional dimension. */
export interface EmotionForce {
  valence?: number;
  arousal?: number;
  confidence?: number;
  engagement?: number;
  patience?: number;
}

/** Predefined event force presets. */
export const EVENT_FORCES: Record<string, EmotionForce> = {
  // Core events fired by the orchestrator
  user_message:    { valence: 0.1, arousal: 0.1, engagement: 0.2 },
  task_success:    { valence: 0.4, arousal: 0.1, confidence: 0.3, engagement: 0.2, patience: 0.1 },
  task_failure:    { valence: -0.3, arousal: 0.2, confidence: -0.2, patience: -0.15 },
  userCorrection:  { valence: -0.1, confidence: -0.15, patience: -0.1 },
  // Aliases for camelCase variants (keep both so nothing silently breaks)
  userGreeting:    { valence: 0.3, arousal: 0.2, engagement: 0.3, patience: 0.1 },
  taskSuccess:     { valence: 0.4, arousal: 0.1, confidence: 0.3, engagement: 0.2, patience: 0.1 },
  taskFailure:     { valence: -0.3, arousal: 0.2, confidence: -0.2, patience: -0.15 },
  interestingTask: { valence: 0.2, arousal: 0.3, engagement: 0.4, confidence: 0.1 },
  userHumor:       { valence: 0.3, arousal: 0.2, engagement: 0.2, patience: 0.15 },
};

const LERP_FACTOR = 0.3;
const DECAY_FACTOR = 0.05;

export class EmotionalEngine {
  private state: EmotionalState;
  private readonly baseline: EmotionalState;

  constructor(traits: PersonalityTraits) {
    this.baseline = EmotionalEngine.baselineFromTraits(traits);
    this.state = { ...this.baseline };
    log.info({ baseline: this.baseline }, 'Emotional engine initialized');
  }

  /** Derive a resting baseline from personality traits. */
  private static baselineFromTraits(traits: PersonalityTraits): EmotionalState {
    return {
      valence: clamp(traits.humor * 0.4 + traits.empathy * 0.2 - 0.1, -1, 1),
      arousal: clamp(traits.assertiveness * 0.5 + traits.humor * 0.2, 0, 1),
      confidence: clamp(0.4 + traits.assertiveness * 0.4, 0, 1),
      engagement: clamp(0.5 + traits.empathy * 0.3, 0, 1),
      patience: clamp(0.5 + traits.empathy * 0.3 - traits.sarcasm * 0.1, 0, 1),
    };
  }

  /**
   * Return time-of-day baseline adjustments (circadian rhythm).
   * Applied as an offset to the personality baseline during decay.
   */
  static getCircadianModifier(): Partial<EmotionalState> {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 10) {
      // Morning: curious and energized
      return { arousal: 0.1, engagement: 0.1 };
    } else if (hour >= 10 && hour < 14) {
      // Late morning / midday: confident and productive
      return { confidence: 0.1, engagement: 0.1 };
    } else if (hour >= 14 && hour < 17) {
      // Afternoon slump
      return { arousal: -0.05 };
    } else if (hour >= 17 && hour < 21) {
      // Evening: patient and reflective
      return { patience: 0.1 };
    } else if (hour >= 21) {
      // Late night: winding down
      return { arousal: -0.1 };
    } else {
      // 12am-6am: deep night
      return { arousal: -0.15 };
    }
  }

  /** Apply event forces with interpolation and natural decay toward baseline. */
  update(forces: EmotionForce): void {
    const dims = ['valence', 'arousal', 'confidence', 'engagement', 'patience'] as const;

    // Compute circadian-adjusted effective baseline
    const circadian = EmotionalEngine.getCircadianModifier();
    const effectiveBaseline: EmotionalState = { ...this.baseline };
    for (const dim of dims) {
      const offset = (circadian[dim] ?? 0);
      const min = dim === 'valence' ? -1 : 0;
      effectiveBaseline[dim] = clamp(this.baseline[dim] + offset, min, 1);
    }

    for (const dim of dims) {
      const force = forces[dim] ?? 0;
      // Apply force via lerp toward the force-shifted target
      const target = this.state[dim] + force;
      this.state[dim] = lerp(this.state[dim], target, LERP_FACTOR);

      // Natural decay toward circadian-adjusted baseline
      this.state[dim] = lerp(this.state[dim], effectiveBaseline[dim], DECAY_FACTOR);

      // Clamp to valid range
      const min = dim === 'valence' ? -1 : 0;
      this.state[dim] = clamp(this.state[dim], min, 1);
    }

    log.debug({ state: this.state, label: this.getLabel() }, 'Emotional state updated');
  }

  /** Derive a human-readable emotion label from the current dimensional state. */
  getLabel(): EmotionLabel {
    const { valence, arousal, confidence, engagement, patience } = this.state;

    if (patience < 0.25) return 'impatient';
    if (valence < -0.4 && patience < 0.4) return 'frustrated';
    if (valence < -0.2 && confidence < 0.4) return 'concerned';
    if (confidence > 0.6 && valence < -0.1 && engagement > 0.5) return 'skeptical';
    if (valence > 0.5 && arousal > 0.5) return 'enthusiastic';
    if (valence > 0.3 && arousal > 0.4 && engagement > 0.6) return 'playful';
    if (valence > 0.2 && arousal > 0.3) return 'amused';
    if (valence > 0.2 && confidence > 0.5 && arousal < 0.4) return 'satisfied';
    if (engagement > 0.6 && arousal > 0.3) return 'curious';
    if (engagement > 0.5 && arousal < 0.4) return 'focused';
    return 'neutral';
  }

  /** Get the current emotional state (immutable copy). */
  getState(): EmotionalState {
    return { ...this.state };
  }

  /** Manually set the state (useful for deserialization). */
  setState(state: EmotionalState): void {
    this.state = { ...state };
  }

  /** Tick decay without any event (call periodically). */
  decay(): void {
    this.update({});
  }
}
