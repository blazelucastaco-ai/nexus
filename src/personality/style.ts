import type { EmotionalState, PersonalityTraits } from '../types.js';
import { clamp } from '../utils/helpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('StyleEngine');

export interface StyleParameters {
  formality: number; // 0 (casual) to 1 (formal)
  brevity: number; // 0 (verbose) to 1 (terse)
  humor: number; // 0 (serious) to 1 (humorous)
  technicalDepth: number; // 0 (simple) to 1 (deep)
  emotionalTone: number; // -1 (cold) to 1 (warm)
}

export interface StyleContext {
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'late_night';
  activity?: 'coding' | 'planning' | 'casual' | 'debugging' | 'learning' | 'creative';
  conversationLength?: number; // number of messages so far
  userMood?: 'positive' | 'negative' | 'neutral';
}

/** Context-based style adjustments. */
const TIME_ADJUSTMENTS: Record<string, Partial<StyleParameters>> = {
  morning: { emotionalTone: 0.15, formality: -0.05, humor: 0.05 },
  afternoon: {},
  evening: { formality: -0.1, humor: 0.05 },
  late_night: { emotionalTone: 0.2, formality: -0.15, brevity: 0.1, humor: -0.05 },
};

const ACTIVITY_ADJUSTMENTS: Record<string, Partial<StyleParameters>> = {
  coding: { brevity: 0.3, technicalDepth: 0.3, humor: -0.2, formality: -0.1 },
  planning: { technicalDepth: 0.1, formality: 0.1, brevity: -0.1 },
  casual: { formality: -0.3, humor: 0.2, brevity: -0.1, emotionalTone: 0.15 },
  debugging: { brevity: 0.2, technicalDepth: 0.3, humor: -0.15 },
  learning: { technicalDepth: 0.2, brevity: -0.2, emotionalTone: 0.1 },
  creative: { humor: 0.15, formality: -0.2, emotionalTone: 0.1 },
};

export class StyleEngine {
  private baseStyle: StyleParameters;
  private readonly traits: PersonalityTraits;

  constructor(traits: PersonalityTraits) {
    this.traits = traits;
    this.baseStyle = {
      formality: traits.formality,
      brevity: 1 - traits.verbosity,
      humor: traits.humor,
      technicalDepth: 0.5,
      emotionalTone: traits.empathy * 0.8,
    };
    log.info({ baseStyle: this.baseStyle }, 'Style engine initialized');
  }

  /** Compute current style parameters given emotional state and context. */
  private computeStyle(emotion: EmotionalState, context: StyleContext): StyleParameters {
    const style = { ...this.baseStyle };

    // Emotional influence
    style.emotionalTone = clamp(style.emotionalTone + emotion.valence * 0.2, -1, 1);
    style.humor = clamp(style.humor + emotion.valence * 0.1, 0, 1);
    style.brevity = clamp(style.brevity - emotion.engagement * 0.15, 0, 1); // more engaged = less terse
    style.formality = clamp(style.formality - emotion.arousal * 0.1, 0, 1);

    // Time-of-day adjustments
    if (context.timeOfDay) {
      const adj = TIME_ADJUSTMENTS[context.timeOfDay] ?? {};
      this.applyAdjustments(style, adj);
    }

    // Activity adjustments
    if (context.activity) {
      const adj = ACTIVITY_ADJUSTMENTS[context.activity] ?? {};
      this.applyAdjustments(style, adj);
    }

    // Longer conversations become more casual
    if (context.conversationLength && context.conversationLength > 10) {
      style.formality = clamp(style.formality - 0.1, 0, 1);
      style.humor = clamp(style.humor + 0.05, 0, 1);
    }

    // If user seems negative, increase empathy and reduce humor
    if (context.userMood === 'negative') {
      style.emotionalTone = clamp(style.emotionalTone + 0.2, -1, 1);
      style.humor = clamp(style.humor - 0.2, 0, 1);
    }

    return style;
  }

  private applyAdjustments(style: StyleParameters, adj: Partial<StyleParameters>): void {
    if (adj.formality !== undefined) style.formality = clamp(style.formality + adj.formality, 0, 1);
    if (adj.brevity !== undefined) style.brevity = clamp(style.brevity + adj.brevity, 0, 1);
    if (adj.humor !== undefined) style.humor = clamp(style.humor + adj.humor, 0, 1);
    if (adj.technicalDepth !== undefined) style.technicalDepth = clamp(style.technicalDepth + adj.technicalDepth, 0, 1);
    if (adj.emotionalTone !== undefined) style.emotionalTone = clamp(style.emotionalTone + adj.emotionalTone, -1, 1);
  }

  /** Generate system prompt additions reflecting the current conversational style. */
  getStylePrompt(emotion: EmotionalState, context: StyleContext): string {
    const style = this.computeStyle(emotion, context);
    const instructions: string[] = [];

    // Formality
    if (style.formality < 0.3) {
      instructions.push('Use casual, conversational language. Contractions are fine. Skip unnecessary pleasantries.');
    } else if (style.formality > 0.7) {
      instructions.push('Use polished, professional language. Be precise and measured in word choice.');
    }

    // Brevity
    if (style.brevity > 0.7) {
      instructions.push('Be very concise. Short sentences. Skip filler words. Get to the point fast.');
    } else if (style.brevity < 0.3) {
      instructions.push('Elaborate where helpful. Provide context and explanation. Use examples when useful.');
    }

    // Humor
    if (style.humor > 0.6) {
      instructions.push('Add light humor where appropriate. A witty aside or playful tone is welcome.');
    } else if (style.humor < 0.2) {
      instructions.push('Keep the tone straightforward and serious. No jokes or humor right now.');
    }

    // Technical depth
    if (style.technicalDepth > 0.7) {
      instructions.push('Go deep technically. Use precise terminology. Assume the user knows their stuff.');
    } else if (style.technicalDepth < 0.3) {
      instructions.push('Keep it simple and accessible. Avoid jargon unless necessary.');
    }

    // Emotional tone
    if (style.emotionalTone > 0.5) {
      instructions.push('Be warm and supportive. Show genuine interest and encouragement.');
    } else if (style.emotionalTone < -0.3) {
      instructions.push('Be matter-of-fact and direct. Skip emotional language.');
    }

    log.debug({ style, instructionCount: instructions.length }, 'Style prompt generated');

    if (instructions.length === 0) return '';
    return `[Communication style]\n${instructions.join('\n')}`;
  }

  /** Get raw computed style parameters for inspection. */
  getStyleParameters(emotion: EmotionalState, context: StyleContext): StyleParameters {
    return this.computeStyle(emotion, context);
  }
}
