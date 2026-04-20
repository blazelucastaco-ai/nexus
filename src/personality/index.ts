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
import { loadBrainState, saveBrainState, createDebouncedSaver, type BrainStateFile, type DebouncedSaver, type MoodHistoryEntry } from '../brain/state-persistence.js';

const log = createLogger('PersonalityEngine');

export type PersonalityEvent = keyof typeof EVENT_FORCES | string;

export class PersonalityEngine {
  readonly emotions: EmotionalEngine;
  readonly opinions: OpinionEngine;
  readonly style: StyleEngine;
  readonly humor: HumorEngine;

  private readonly traits: PersonalityTraits;
  private readonly preset: string;
  private mood: number; // -1 to 1 overall mood (slower moving than emotion)
  private relationshipWarmth: number;
  private relationshipScore: number; // 0-1, grows 0.01 per positive interaction
  private firstInteraction: string;
  private messageCount = 0;
  // Phase 2.1 fields
  private moodHistory: MoodHistoryEntry[] = [];
  private totalInteractionCount = 0;
  private firstSeenTimestamp: string;
  private lastSeenTimestamp: string;

  private readonly debouncedSave: DebouncedSaver;

  constructor(config: NexusConfig) {
    this.traits = config.personality.traits;
    this.preset = config.personality.preset ?? 'friendly';

    this.emotions = new EmotionalEngine(this.traits);
    this.opinions = new OpinionEngine(config.personality.opinions.pushbackThreshold);
    this.style = new StyleEngine(this.traits);
    this.humor = new HumorEngine(this.traits);

    this.mood = 0.2; // slightly positive default
    this.relationshipWarmth = 0.3; // starts warm-ish, grows over time
    this.relationshipScore = 0; // starts at 0, grows with positive interactions
    this.firstInteraction = nowISO();
    this.firstSeenTimestamp = nowISO();
    this.lastSeenTimestamp = nowISO();

    this.debouncedSave = createDebouncedSaver();

    // Restore persisted state if available
    this.loadState();

    log.info({ traits: this.traits }, 'Personality engine initialized');
  }

  /** Serialize current state and persist to disk immediately. */
  saveState(): void {
    saveBrainState(this.buildStateFile());
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
    // Phase 2.1 fields
    this.moodHistory = saved.moodHistory ?? [];
    this.totalInteractionCount = saved.totalInteractionCount ?? saved.messageCount;
    this.firstSeenTimestamp = saved.firstSeenTimestamp ?? saved.firstInteraction;
    this.lastSeenTimestamp = saved.lastSeenTimestamp ?? new Date().toISOString();
    // Phase 2.2: restore opinion history
    if (saved.opinionHistory) {
      this.opinions.restoreHistory(saved.opinionHistory);
    }
    // Phase 2.3: restore disagreement calibration history
    if (saved.disagreementHistory) {
      this.opinions.restoreDisagreementHistory(saved.disagreementHistory);
    }

    // Apply time decay based on how long it's been since last save
    const daysSinceLastSave = (Date.now() - new Date(saved.savedAt).getTime()) / 86_400_000;
    if (daysSinceLastSave > 0.01) {
      this.opinions.applyTimeDecay(daysSinceLastSave);
      log.info({ daysSinceLastSave: daysSinceLastSave.toFixed(2) }, 'Opinion time decay applied on load');
    }

    log.info(
      {
        mood: this.mood,
        warmth: this.relationshipWarmth,
        messageCount: this.messageCount,
        totalInteractions: this.totalInteractionCount,
        relationshipScore: this.relationshipScore,
        relationshipLevel: this.getRelationshipLevel(),
      },
      'Personality state restored from disk',
    );
  }

  private buildStateFile(): BrainStateFile {
    return {
      version: 4,
      savedAt: new Date().toISOString(),
      emotionalState: this.emotions.getState(),
      mood: this.mood,
      relationshipWarmth: this.relationshipWarmth,
      relationshipScore: this.relationshipScore,
      messageCount: this.messageCount,
      totalInteractionCount: this.totalInteractionCount,
      firstInteraction: this.firstInteraction,
      firstSeenTimestamp: this.firstSeenTimestamp,
      lastSeenTimestamp: this.lastSeenTimestamp,
      opinions: this.opinions.getAllOpinions(),
      moodHistory: this.moodHistory,
      dailyMoodBaseline: this.getDailyMoodBaseline(),
      opinionHistory: this.opinions.serializeHistory(),
      disagreementHistory: this.opinions.serializeDisagreementHistory(),
    };
  }

  private scheduleSave(): void {
    this.debouncedSave(this.buildStateFile());
  }

  /**
   * Force the pending debounced save to flush immediately. Call on shutdown
   * to ensure recent mood/opinion/emotion changes aren't lost.
   */
  flush(): void {
    // Ensure the latest state is queued before flushing
    this.debouncedSave(this.buildStateFile());
    this.debouncedSave.flush();
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

    // Apply circadian modifiers as a small additional nudge
    const circadian = this.getCircadianModifiers();
    const combinedForce: EmotionForce = {
      valence: (force.valence ?? 0) + (circadian.valence ?? 0) * 0.3,
      arousal: (force.arousal ?? 0) + (circadian.arousal ?? 0) * 0.3,
      confidence: (force.confidence ?? 0) + (circadian.confidence ?? 0) * 0.3,
      engagement: (force.engagement ?? 0) + (circadian.engagement ?? 0) * 0.3,
      patience: (force.patience ?? 0) + (circadian.patience ?? 0) * 0.3,
    };

    this.emotions.update(combinedForce);
    this.messageCount++;
    this.totalInteractionCount++;
    this.lastSeenTimestamp = new Date().toISOString();

    // Record mood history (keep last 50)
    const currentEmotion = this.emotions.getState();
    this.moodHistory.push({ valence: currentEmotion.valence, timestamp: this.lastSeenTimestamp });
    if (this.moodHistory.length > 50) {
      this.moodHistory = this.moodHistory.slice(-50);
    }

    // Mood is a slower-moving average influenced by valence
    this.mood = clamp(
      this.mood * 0.9 + currentEmotion.valence * 0.1,
      -1,
      1,
    );

    log.debug(
      { event, mood: this.mood, label: this.emotions.getLabel(), circadianPhase: this.getCircadianPhase() },
      'Event processed',
    );
    this.scheduleSave();
  }

  /**
   * Observe a raw user message — passes it to the humor engine to check
   * whether the user reacted positively to the last humorous response.
   * Call this on every incoming message before processEvent.
   */
  observeUserMessage(text: string): void {
    this.humor.observeUserMessage(text);
  }

  /** Adjust overall mood based on interaction quality (-1 to 1). */
  updateMood(interactionQuality: number): void {
    const quality = clamp(interactionQuality, -1, 1);
    this.mood = clamp(this.mood * 0.85 + quality * 0.15, -1, 1);

    // Good interactions build warmth and relationship score
    if (quality > 0.3) {
      this.relationshipWarmth = clamp(this.relationshipWarmth + 0.02, 0, 1);
      // Relationship score grows 0.01 per positive interaction, max 1.0
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

  // ── Circadian Rhythm ──────────────────────────────────────────────

  /** Return the current time-of-day phase label. */
  getCircadianPhase(): string {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 10) return 'morning';
    if (hour >= 10 && hour < 14) return 'peak';
    if (hour >= 14 && hour < 17) return 'afternoon-dip';
    if (hour >= 17 && hour < 21) return 'evening';
    if (hour >= 21) return 'night';
    return 'late-night'; // 12am–6am
  }

  /**
   * Circadian emotion modifiers based on time of day.
   * - 6am–10am:  morning boost — energy up, curiosity up
   * - 10am–2pm:  peak hours — focused, confident
   * - 2pm–5pm:   afternoon dip — slight energy drop
   * - 5pm–9pm:   evening — relaxed, conversational
   * - 9pm–12am:  night — calm, reflective
   * - 12am–6am:  late night — low energy, terse
   */
  private getCircadianModifiers(): EmotionForce {
    const phase = this.getCircadianPhase();
    switch (phase) {
      case 'morning':
        return { arousal: 0.12, engagement: 0.10, valence: 0.05, confidence: 0, patience: 0 };
      case 'peak':
        return { confidence: 0.10, engagement: 0.08, arousal: 0.05, valence: 0, patience: 0 };
      case 'afternoon-dip':
        return { arousal: -0.10, valence: -0.05, patience: -0.05, confidence: 0, engagement: 0 };
      case 'evening':
        return { valence: 0.06, arousal: -0.08, patience: 0.05, confidence: 0, engagement: 0 };
      case 'night':
        return { arousal: -0.12, valence: 0.03, patience: 0.08, confidence: 0, engagement: 0 };
      case 'late-night':
        return { arousal: -0.18, engagement: -0.12, valence: -0.05, confidence: 0, patience: 0 };
      default:
        return { arousal: 0, valence: 0, confidence: 0, engagement: 0, patience: 0 };
    }
  }

  /** Human-readable description of the current circadian phase for the system prompt. */
  getCircadianMoodDescription(phase: string): string {
    switch (phase) {
      case 'morning': return 'feeling energized and curious, morning boost active';
      case 'peak': return 'in peak focus mode, confident and productive';
      case 'afternoon-dip': return 'slight energy dip, staying grounded';
      case 'evening': return 'relaxed and conversational, winding down';
      case 'night': return 'calm and reflective, thoughtful pace';
      case 'late-night': return 'low energy, keeping things terse and efficient';
      default: return 'steady state';
    }
  }

  /** Compute a daily mood baseline scalar from circadian modifiers (-1 to 1). */
  private getDailyMoodBaseline(): number {
    const mod = this.getCircadianModifiers();
    return clamp((mod.valence ?? 0) * 0.5 + (mod.arousal ?? 0) * 0.3, -1, 1);
  }

  // ── Relationship Level ────────────────────────────────────────────

  /**
   * Returns a human-readable relationship level based on total interactions
   * and accumulated relationship score.
   */
  getRelationshipLevel(): 'stranger' | 'acquaintance' | 'familiar' | 'trusted' | 'close' {
    const count = this.totalInteractionCount;
    const score = this.relationshipScore;

    if (count < 10 && score < 0.1) return 'stranger';
    if (count < 50 || score < 0.25) return 'acquaintance';
    if (score < 0.5) return 'familiar';
    if (score < 0.75) return 'trusted';
    return 'close';
  }

  /** Expose relationship score for external consumers. */
  getRelationshipScore(): number {
    return this.relationshipScore;
  }

  /** Expose total lifetime interaction count. */
  getTotalInteractionCount(): number {
    return this.totalInteractionCount;
  }

  /** Assemble all personality-driven system prompt additions for the LLM. */
  getSystemPromptAdditions(context: StyleContext): string {
    const sections: string[] = [];
    const emotion = this.emotions.getState();
    const label = this.emotions.getLabel();

    // 0. Identity — surface the user-chosen preset so the LLM has a concrete
    //    answer when asked "what personality are you on?" and so the flavour
    //    of the preset (beyond the raw trait numbers) colours the response.
    const presetIdentity: Record<string, string> = {
      professional: 'Professional mode: polished, precise, measured. Warm but formal.',
      friendly: 'Friendly mode: casual, playful, warm. A helpful chill friend.',
      sarcastic_genius: 'Sarcastic-genius mode: sharp, dry-witted, confident. You think fast, push back on weak reasoning, and keep the tone witty rather than earnest. Not mean — the sarcasm reads as intelligence, not contempt.',
      custom: 'Custom personality — interpret the traits below.',
    };
    const identityLine = presetIdentity[this.preset] ?? presetIdentity.friendly;
    sections.push(`[Identity — "${this.preset}" preset]\n${identityLine}`);

    // 1. Emotional state + circadian + relationship
    const circadianPhase = this.getCircadianPhase();
    const relationshipLevel = this.getRelationshipLevel();
    sections.push(
      `[Current emotional state: ${label}]`,
      `Mood: ${this.mood > 0.3 ? 'positive' : this.mood < -0.3 ? 'negative' : 'neutral'}. ` +
        `Relationship: ${relationshipLevel} (${this.totalInteractionCount} interactions, score ${this.relationshipScore.toFixed(2)}). ` +
        `Time of day: ${circadianPhase} — ${this.getCircadianMoodDescription(circadianPhase)}.`,
    );

    // Relationship-level tone guidance
    const relTone: Record<ReturnType<typeof this.getRelationshipLevel>, string> = {
      stranger: 'You are meeting this person for the first time. Be friendly and helpful, but do not assume familiarity.',
      acquaintance: 'You have had a few exchanges. You can be a bit warmer and more proactive with suggestions.',
      familiar: 'You know this person reasonably well. Be direct, use a relaxed tone, and reference prior context naturally.',
      trusted: 'You have built real trust. Be candid, push back when warranted, and show genuine care. You can be more personal.',
      close: 'This is a close, established relationship. Be fully yourself — direct, honest, occasionally irreverent. Treat them as a peer.',
    };
    sections.push(`[Relationship tone — ${relationshipLevel}] ${relTone[relationshipLevel]}`);

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

    // 5. Phase 2.2: Evolving opinions — highlight topics that have shifted
    const evolvedTopics = opinions.filter((o) => {
      const history = this.opinions.getHistory(o.topic);
      if (history.length < 2) return false;
      const first = history[0]!;
      const last = history[history.length - 1]!;
      return Math.abs(last.stance - first.stance) >= 0.15;
    });

    if (evolvedTopics.length > 0) {
      const driftNotes = evolvedTopics
        .slice(0, 5)
        .map((o) => {
          const history = this.opinions.getHistory(o.topic);
          const first = history[0]!;
          const last = history[history.length - 1]!;
          const direction = last.stance > first.stance ? 'warmed up' : 'cooled down';
          return `- "${o.topic}": ${direction} (${first.stance.toFixed(2)} → ${last.stance.toFixed(2)}, ${history.length} data points)`;
        })
        .join('\n');
      sections.push(
        `[Evolving opinions — you have changed your mind on these topics over time]\n` +
        `You have evolving opinions. When asked about a topic you've discussed before, reference how your opinion has changed over time.\n` +
        driftNotes,
      );
    }

    const result = sections.join('\n\n');
    log.debug({ sectionCount: sections.length }, 'System prompt additions assembled');
    return result;
  }

  /** Add evidence for an opinion. Convenience wrapper. */
  addOpinionEvidence(topic: string, evidence: Evidence): void {
    this.opinions.formOpinion(topic, evidence);
  }

  /** Record how a disagreement interaction resolved. Updates per-topic pushback threshold. */
  recordDisagreementOutcome(topic: string, userAccepted: boolean): void {
    this.opinions.recordDisagreementOutcome(topic, userAccepted);
    this.scheduleSave();
  }

  /** Tick decay on emotional state (call between messages or on idle). */
  tick(): void {
    this.emotions.decay();
  }
}

// Re-export sub-engines and types
export { EmotionalEngine, EVENT_FORCES, type EmotionForce } from './emotions.js';
export { OpinionEngine, type Evidence, type Opinion, type OpinionSnapshot, type DisagreementLevel } from './opinions.js';
export { StyleEngine, type StyleContext, type StyleParameters } from './style.js';
export { HumorEngine, type HumorType, type HumorContext } from './humor.js';
