import type { EmotionalState, PersonalityTraits } from '../types.js';
import { clamp } from '../utils/helpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('HumorEngine');

export type HumorType =
  | 'observational'
  | 'self_deprecating'
  | 'callback'
  | 'deadpan'
  | 'sarcasm'
  | 'celebration';

export interface HumorContext {
  rapport: number; // 0 to 1: how comfortable with the user
  recentHumorCount: number; // humor attempts in last N messages
  topicSeriousness: number; // 0 (casual) to 1 (serious/sensitive)
  userReceptive: boolean; // did user respond well to humor before
  conversationLength: number;
}

/** Minimum messages between humor attempts. */
const MIN_GAP_MESSAGES = 3;
/** Maximum humor attempts in a rolling window. */
const MAX_HUMOR_PER_WINDOW = 3;

const HUMOR_PROMPTS: Record<HumorType, string> = {
  observational:
    'Add a brief, clever observation about the situation — something the user might not have noticed but will appreciate.',
  self_deprecating:
    'Include a light self-deprecating remark about being an AI — keep it endearing, not cringy.',
  callback:
    'Reference something from earlier in the conversation in a humorous way — a callback that rewards the user for paying attention.',
  deadpan:
    'Deliver any humor completely deadpan — no emoji, no "haha", just a dry aside slipped into the response.',
  sarcasm:
    'Add a touch of dry sarcasm — playful, never mean. The kind where the user smirks.',
  celebration:
    'Celebrate the moment with some lighthearted enthusiasm — the user earned it.',
};

export class HumorEngine {
  private readonly humorLevel: number;
  private readonly sarcasmLevel: number;
  private lastHumorAt = 0; // message index of last humor
  private humorHistory: number[] = []; // timestamps of humor usage

  constructor(traits: PersonalityTraits) {
    this.humorLevel = traits.humor;
    this.sarcasmLevel = traits.sarcasm;
    log.info({ humorLevel: this.humorLevel, sarcasmLevel: this.sarcasmLevel }, 'Humor engine initialized');
  }

  /** Decide whether to inject humor into the current response. */
  shouldAddHumor(context: HumorContext, emotion: EmotionalState): boolean {
    // Never during serious topics
    if (context.topicSeriousness > 0.7) {
      log.debug('Skipping humor: topic too serious');
      return false;
    }

    // Frequency cap
    if (context.recentHumorCount >= MAX_HUMOR_PER_WINDOW) {
      log.debug('Skipping humor: frequency cap reached');
      return false;
    }

    // Gap check (need at least MIN_GAP_MESSAGES since last humor)
    if (context.conversationLength - this.lastHumorAt < MIN_GAP_MESSAGES && this.lastHumorAt > 0) {
      log.debug('Skipping humor: too soon since last humor');
      return false;
    }

    // If user didn't like previous humor, lower probability
    const receptivityMultiplier = context.userReceptive ? 1.0 : 0.3;

    // Score based on mood, rapport, and personality
    const moodBoost = clamp((emotion.valence + 1) / 2, 0, 1); // normalize valence to 0-1
    const score =
      this.humorLevel * 0.4 +
      context.rapport * 0.2 +
      moodBoost * 0.2 +
      emotion.engagement * 0.2;

    const threshold = 0.45;
    const shouldHumor = score * receptivityMultiplier > threshold;

    log.debug({ score, threshold, receptivityMultiplier, shouldHumor }, 'Humor decision');
    return shouldHumor;
  }

  /** Select the best humor type for the current state. */
  selectHumorType(context: HumorContext, emotion: EmotionalState): HumorType {
    const candidates: Array<{ type: HumorType; score: number }> = [];

    // Observational: good default, works when engaged
    candidates.push({ type: 'observational', score: 0.5 + emotion.engagement * 0.3 });

    // Self-deprecating: good for building rapport early
    candidates.push({
      type: 'self_deprecating',
      score: context.rapport < 0.5 ? 0.6 : 0.3,
    });

    // Callback: only if conversation is long enough
    candidates.push({
      type: 'callback',
      score: context.conversationLength > 8 ? 0.7 : 0.1,
    });

    // Deadpan: higher formality situations
    candidates.push({ type: 'deadpan', score: 0.4 + (1 - emotion.arousal) * 0.3 });

    // Sarcasm: gated by personality + rapport
    candidates.push({
      type: 'sarcasm',
      score: this.sarcasmLevel * 0.5 + context.rapport * 0.3,
    });

    // Celebration: when positive mood
    candidates.push({
      type: 'celebration',
      score: emotion.valence > 0.3 ? 0.6 + emotion.valence * 0.3 : 0.1,
    });

    // Pick highest scoring type
    candidates.sort((a, b) => b.score - a.score);
    const chosen = candidates[0].type;

    log.debug({ chosen, topCandidates: candidates.slice(0, 3) }, 'Humor type selected');
    return chosen;
  }

  /** Generate a prompt instruction for the chosen humor type. */
  generateHumorPrompt(type: HumorType): string {
    return HUMOR_PROMPTS[type];
  }

  /** Record that humor was used at the given message index. */
  recordHumorUsage(messageIndex: number): void {
    this.lastHumorAt = messageIndex;
    this.humorHistory.push(Date.now());

    // Trim history older than 30 minutes
    const cutoff = Date.now() - 30 * 60 * 1000;
    this.humorHistory = this.humorHistory.filter((t) => t > cutoff);
  }

  /** Get the count of humor uses in the recent window. */
  getRecentHumorCount(): number {
    const cutoff = Date.now() - 30 * 60 * 1000;
    return this.humorHistory.filter((t) => t > cutoff).length;
  }
}
