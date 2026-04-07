import type {
  EmotionalState,
  EmotionLabel,
  NexusConfig,
  PersonalityState,
  PersonalityTraits,
} from '../types.js';
import { clamp, nowISO } from '../utils/helpers.js';
import { createLogger } from '../utils/logger.js';

import { EmotionalEngine, EVENT_FORCES, type EmotionForce } from './emotions.js';
import { OpinionEngine, type Evidence } from './opinions.js';
import { StyleEngine, type StyleContext } from './style.js';
import { HumorEngine, type HumorContext } from './humor.js';
import { loadBrainState, saveBrainState, createDebouncedSaver, type BrainStateFile } from '../brain/state-persistence.js';

const log = createLogger('PersonalityEngine');

export type PersonalityEvent = keyof typeof EVENT_FORCES | string;

export class PersonalityEngine {
  readonly emotions: EmotionalEngine;
  readonly opinions: OpinionEngine;
  readonly style: StyleEngine;
  readonly humor: HumorEngine;

  private readonly traits: PersonalityTraits;
  private mood: number; // -1 to 1 overall mood (slower moving than emotion)
  private relationshipWarmth: number;
  private firstInteraction: string;
  private messageCount = 0;

  private readonly debouncedSave: (state: BrainStateFile) => void;

  constructor(config: NexusConfig) {
    this.traits = config.personality.traits;

    this.emotions = new EmotionalEngine(this.traits);
    this.opinions = new OpinionEngine(config.personality.opinions.pushbackThreshold);
    this.style = new StyleEngine(this.traits);
    this.humor = new HumorEngine(this.traits);

    this.mood = 0.2; // slightly positive default
    this.relationshipWarmth = 0.3; // starts warm-ish, grows over time
    this.firstInteraction = nowISO();

    this.debouncedSave = createDebouncedSaver();

    // Restore persisted state if available
    this.loadState();

    log.info({ traits: this.traits }, 'Personality engine initialized');
  }

  /** Serialize current state and persist to disk immediately. */
  saveState(): void {
    saveBrainState({
      version: 1,
      savedAt: new Date().toISOString(),
      emotionalState: this.emotions.getState(),
      mood: this.mood,
      relationshipWarmth: this.relationshipWarmth,
      messageCount: this.messageCount,
      firstInteraction: this.firstInteraction,
      opinions: this.opinions.getAllOpinions(),
    });
  }

  /** Load persisted state from disk and restore it. */
  loadState(): void {
    const saved = loadBrainState();
    if (!saved) return;

    this.emotions.setState(saved.emotionalState);
    this.mood = saved.mood;
    this.relationshipWarmth = saved.relationshipWarmth;
    this.messageCount = saved.messageCount;
    this.firstInteraction = saved.firstInteraction;
    this.opinions.restoreOpinions(saved.opinions);

    log.info(
      { mood: this.mood, warmth: this.relationshipWarmth, messageCount: this.messageCount },
      'Personality state restored from disk',
    );
  }

  private scheduleSave(): void {
    this.debouncedSave({
      version: 1,
      savedAt: new Date().toISOString(),
      emotionalState: this.emotions.getState(),
      mood: this.mood,
      relationshipWarmth: this.relationshipWarmth,
      messageCount: this.messageCount,
      firstInteraction: this.firstInteraction,
      opinions: this.opinions.getAllOpinions(),
    });
  }

  /** Get the full personality state snapshot. */
  getPersonalityState(): PersonalityState {
    const now = new Date();
    const first = new Date(this.firstInteraction);
    const daysSince = Math.floor((now.getTime() - first.getTime()) / (1000 * 60 * 60 * 24));

    return {
      traits: { ...this.traits },
      emotion: this.emotions.getState(),
      emotionLabel: this.emotions.getLabel(),
      mood: this.mood,
      relationshipWarmth: this.relationshipWarmth,
      daysSinceFirstInteraction: daysSince,
    };
  }

  /** Process a named event, updating emotional state. */
  processEvent(event: PersonalityEvent, customForce?: EmotionForce): void {
    const force = customForce ?? EVENT_FORCES[event];
    if (!force) {
      log.warn({ event }, 'Unknown event with no custom force, ignoring');
      return;
    }

    this.emotions.update(force);
    this.messageCount++;

    // Mood is a slower-moving average influenced by valence
    const currentEmotion = this.emotions.getState();
    this.mood = clamp(
      this.mood * 0.9 + currentEmotion.valence * 0.1,
      -1,
      1,
    );

    log.debug({ event, mood: this.mood, label: this.emotions.getLabel() }, 'Event processed');
    this.scheduleSave();
  }

  /** Adjust overall mood based on interaction quality (-1 to 1). */
  updateMood(interactionQuality: number): void {
    const quality = clamp(interactionQuality, -1, 1);
    this.mood = clamp(this.mood * 0.85 + quality * 0.15, -1, 1);

    // Good interactions build warmth slowly
    if (quality > 0.3) {
      this.relationshipWarmth = clamp(this.relationshipWarmth + 0.02, 0, 1);
    } else if (quality < -0.3) {
      this.relationshipWarmth = clamp(this.relationshipWarmth - 0.01, 0, 1);
    }

    log.debug({ mood: this.mood, warmth: this.relationshipWarmth, quality }, 'Mood updated');
    this.scheduleSave();
  }

  /** Assemble all personality-driven system prompt additions for the LLM. */
  getSystemPromptAdditions(context: StyleContext): string {
    const sections: string[] = [];
    const emotion = this.emotions.getState();
    const label = this.emotions.getLabel();

    // 1. Emotional state instruction
    sections.push(
      `[Current emotional state: ${label}]`,
      `Mood: ${this.mood > 0.3 ? 'positive' : this.mood < -0.3 ? 'negative' : 'neutral'}. ` +
        `Relationship warmth: ${this.relationshipWarmth > 0.6 ? 'close' : this.relationshipWarmth > 0.3 ? 'familiar' : 'new'}.`,
    );

    // 2. Style prompt
    const stylePrompt = this.style.getStylePrompt(emotion, context);
    if (stylePrompt) {
      sections.push(stylePrompt);
    }

    // 3. Humor injection
    const humorContext: HumorContext = {
      rapport: this.relationshipWarmth,
      recentHumorCount: this.humor.getRecentHumorCount(),
      topicSeriousness: context.activity === 'debugging' ? 0.6 : context.activity === 'casual' ? 0.1 : 0.3,
      userReceptive: this.relationshipWarmth > 0.4,
      conversationLength: context.conversationLength ?? 0,
    };

    if (this.humor.shouldAddHumor(humorContext, emotion)) {
      const humorType = this.humor.selectHumorType(humorContext, emotion);
      const humorPrompt = this.humor.generateHumorPrompt(humorType);
      sections.push(`[Humor: ${humorType}]\n${humorPrompt}`);
      this.humor.recordHumorUsage(context.conversationLength ?? this.messageCount);
    }

    // 4. Opinion-based pushback notes
    const opinions = this.opinions.getAllOpinions();
    const pushbackOpinions = opinions.filter(
      (o) => this.opinions.shouldPushBack(o.topic),
    );

    if (pushbackOpinions.length > 0) {
      const notes = pushbackOpinions.map((o) => {
        const level = this.opinions.getDisagreementLevel(o.confidence);
        return `- ${o.topic}: ${level} (confidence: ${(o.confidence * 100).toFixed(0)}%)`;
      });
      sections.push(`[Active disagreements — express these naturally]\n${notes.join('\n')}`);
    }

    const result = sections.join('\n\n');
    log.debug({ sectionCount: sections.length }, 'System prompt additions assembled');
    return result;
  }

  /** Add evidence for an opinion. Convenience wrapper. */
  addOpinionEvidence(topic: string, evidence: Evidence): void {
    this.opinions.formOpinion(topic, evidence);
  }

  /** Tick decay on emotional state (call between messages or on idle). */
  tick(): void {
    this.emotions.decay();
  }
}

// Re-export sub-engines and types
export { EmotionalEngine, EVENT_FORCES, type EmotionForce } from './emotions.js';
export { OpinionEngine, type Evidence, type Opinion, type DisagreementLevel } from './opinions.js';
export { StyleEngine, type StyleContext, type StyleParameters } from './style.js';
export { HumorEngine, type HumorType, type HumorContext } from './humor.js';
