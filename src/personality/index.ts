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
  private relationshipScore: number; // 0-1, grows 0.01 per positive interaction
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
    this.relationshipScore = 0; // starts at 0, grows with positive interactions
    this.firstInteraction = nowISO();

    this.debouncedSave = createDebouncedSaver();

    // Restore persisted state if available
    this.loadState();

    log.info({ traits: this.traits }, 'Personality engine initialized');
  }

  /** Serialize current state and persist to disk immediately. */
  saveState(): void {
    saveBrainState({
      version: 2,
      savedAt: new Date().toISOString(),
      emotionalState: this.emotions.getState(),
      mood: this.mood,
      relationshipWarmth: this.relationshipWarmth,
      relationshipScore: this.relationshipScore,
      messageCount: this.messageCount,
      totalInteractionCount: this.messageCount,
      firstInteraction: this.firstInteraction,
      firstSeenTimestamp: this.firstInteraction,
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
    this.relationshipScore = saved.relationshipScore ?? 0;
    this.messageCount = saved.totalInteractionCount ?? saved.messageCount;
    this.firstInteraction = saved.firstSeenTimestamp ?? saved.firstInteraction;
    this.opinions.restoreOpinions(saved.opinions);

    log.info(
      {
        mood: this.mood,
        warmth: this.relationshipWarmth,
        relationshipScore: this.relationshipScore,
        messageCount: this.messageCount,
      },
      'Personality state restored from disk',
    );
  }

  private scheduleSave(): void {
    this.debouncedSave({
      version: 2,
      savedAt: new Date().toISOString(),
      emotionalState: this.emotions.getState(),
      mood: this.mood,
      relationshipWarmth: this.relationshipWarmth,
      relationshipScore: this.relationshipScore,
      messageCount: this.messageCount,
      totalInteractionCount: this.messageCount,
      firstInteraction: this.firstInteraction,
      firstSeenTimestamp: this.firstInteraction,
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

    // Good interactions build warmth and relationship score
    if (quality > 0.3) {
      this.relationshipWarmth = clamp(this.relationshipWarmth + 0.02, 0, 1);
      this.relationshipScore = clamp(this.relationshipScore + 0.01, 0, 1);
    } else if (quality < -0.3) {
      this.relationshipWarmth = clamp(this.relationshipWarmth - 0.01, 0, 1);
    }

    log.debug(
      { mood: this.mood, warmth: this.relationshipWarmth, relationshipScore: this.relationshipScore, quality },
      'Mood updated',
    );
    this.scheduleSave();
  }

  /**
   * Return a human-readable relationship level based on the accumulated
   * relationshipScore (0–1).
   */
  getRelationshipLevel(): 'stranger' | 'acquaintance' | 'familiar' | 'trusted' | 'close' {
    if (this.relationshipScore < 0.1) return 'stranger';
    if (this.relationshipScore < 0.3) return 'acquaintance';
    if (this.relationshipScore < 0.6) return 'familiar';
    if (this.relationshipScore < 0.85) return 'trusted';
    return 'close';
  }

  /** Return the current relationship score (0-1). */
  getRelationshipScore(): number {
    return this.relationshipScore;
  }

  /** Assemble all personality-driven system prompt additions for the LLM. */
  getSystemPromptAdditions(context: StyleContext): string {
    const sections: string[] = [];
    const emotion = this.emotions.getState();
    const label = this.emotions.getLabel();

    // 1. Emotional state instruction
    const relLevel = this.getRelationshipLevel();
    const circadian = EmotionalEngine.getCircadianModifier();
    const circadianNote = Object.entries(circadian).map(([k, v]) => `${k} ${(v as number) > 0 ? '+' : ''}${v}`).join(', ');

    sections.push(
      `[Current emotional state: ${label}]`,
      `Mood: ${this.mood > 0.3 ? 'positive' : this.mood < -0.3 ? 'negative' : 'neutral'}. ` +
        `Relationship: ${relLevel} (score: ${this.relationshipScore.toFixed(2)}, warmth: ${this.relationshipWarmth.toFixed(2)}). ` +
        `Circadian baseline shift: ${circadianNote || 'none'}.`,
    );

    // Relationship-level tone guidance
    const relTone: Record<ReturnType<typeof this.getRelationshipLevel>, string> = {
      stranger: 'You are meeting this person for the first time. Be friendly and helpful, but do not assume familiarity.',
      acquaintance: 'You have had a few exchanges. You can be a bit warmer and more proactive with suggestions.',
      familiar: 'You know this person reasonably well. Be direct, use a relaxed tone, and reference prior context naturally.',
      trusted: 'You have built real trust. Be candid, push back when warranted, and show genuine care. You can be more personal.',
      close: 'This is a close, established relationship. Be fully yourself — direct, honest, occasionally irreverent. Treat them as a peer.',
    };
    sections.push(`[Relationship tone — ${relLevel}] ${relTone[relLevel]}`);

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
