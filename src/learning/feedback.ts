// Nexus AI — Feedback integration and sentiment analysis

import type { MemoryCortex } from '../memory/cortex.js';
import type { EmotionalState } from '../types.js';
import type { PreferenceLearner } from './preferences.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('FeedbackProcessor');

/** Rolling window size for trend calculation. */
const TREND_WINDOW = 20;

interface FeedbackEntry {
  signal: 'positive' | 'negative' | 'neutral';
  context: string;
  timestamp: Date;
  explicit: boolean;
}

export class FeedbackProcessor {
  private cortex: MemoryCortex;
  private preferenceLearner: PreferenceLearner;
  private history: FeedbackEntry[] = [];

  constructor(cortex: MemoryCortex, preferenceLearner: PreferenceLearner) {
    this.cortex = cortex;
    this.preferenceLearner = preferenceLearner;
    log.info('FeedbackProcessor initialized');
  }

  /**
   * Process explicit user feedback like "that was wrong", "perfect", "not what I wanted".
   * Classifies the sentiment and routes learning signals to the preference system.
   */
  processExplicitFeedback(feedback: string, context: string): void {
    const signal = classifyFeedback(feedback);

    this.history.push({
      signal,
      context,
      timestamp: new Date(),
      explicit: true,
    });

    // Trim history to prevent unbounded growth
    if (this.history.length > 1000) {
      this.history = this.history.slice(-800);
    }

    // Route to preference learner based on signal
    if (signal === 'positive') {
      this.preferenceLearner.observeChoice('feedback_response', 'approved', context);
    } else if (signal === 'negative') {
      this.preferenceLearner.observeChoice('feedback_response', 'rejected', context);
    }

    // Store significant feedback in memory
    if (signal !== 'neutral') {
      try {
        this.cortex.store({
          layer: 'episodic',
          type: 'fact',
          content: `User feedback (${signal}): "${feedback}" — Context: ${context}`,
          importance: signal === 'negative' ? 0.8 : 0.5,
          tags: ['feedback', signal],
          source: 'FeedbackProcessor',
          metadata: { signal, explicit: true },
        });
      } catch (err) {
        log.warn({ err }, 'Failed to store feedback in cortex');
      }
    }

    log.info({ signal, explicit: true, feedbackLength: feedback.length }, 'Explicit feedback processed');
  }

  /**
   * Process implicit feedback signals derived from user behavior.
   *   - positive: user said thanks, continued naturally
   *   - negative: user re-asked the question, corrected the AI
   *   - neutral: no clear signal
   */
  processImplicitFeedback(signal: 'positive' | 'negative' | 'neutral', context: string): void {
    this.history.push({
      signal,
      context,
      timestamp: new Date(),
      explicit: false,
    });

    if (this.history.length > 1000) {
      this.history = this.history.slice(-800);
    }

    // Implicit negative feedback has lower weight but still matters
    if (signal === 'negative') {
      this.preferenceLearner.observeChoice('implicit_feedback', 'negative', context);
    } else if (signal === 'positive') {
      this.preferenceLearner.observeChoice('implicit_feedback', 'positive', context);
    }

    log.debug({ signal, explicit: false }, 'Implicit feedback processed');
  }

  /**
   * Detect frustration from a series of user messages.
   * Signals: short messages, repeated questions, ALL CAPS, excessive punctuation,
   * negative keywords.
   */
  detectFrustration(messages: string[]): boolean {
    if (messages.length === 0) return false;

    let frustrationScore = 0;

    for (const msg of messages) {
      const trimmed = msg.trim();

      // Short terse messages (likely impatient)
      if (trimmed.length > 0 && trimmed.length < 15 && !trimmed.includes(' ')) {
        frustrationScore += 0.5;
      }

      // ALL CAPS (3+ words)
      if (trimmed.length > 5 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
        frustrationScore += 1.5;
      }

      // Excessive punctuation (!!!, ???, ...)
      if (/[!?]{2,}/.test(trimmed)) {
        frustrationScore += 1.0;
      }

      // Frustration keywords
      if (FRUSTRATION_PATTERNS.some((p) => p.test(trimmed.toLowerCase()))) {
        frustrationScore += 1.5;
      }

      // Repeated question (same message appears multiple times)
      const repeatCount = messages.filter((m) => m.trim().toLowerCase() === trimmed.toLowerCase()).length;
      if (repeatCount >= 2) {
        frustrationScore += 1.0;
      }
    }

    // Normalize by message count
    const normalizedScore = frustrationScore / Math.max(messages.length, 1);
    const frustrated = normalizedScore >= 0.8;

    if (frustrated) {
      log.info({ score: normalizedScore.toFixed(2), messageCount: messages.length }, 'Frustration detected');
    }

    return frustrated;
  }

  /**
   * Detect satisfaction / positive signals from a series of user messages.
   * Signals: thanks, great, perfect, positive emoji, longer appreciative messages.
   */
  detectSatisfaction(messages: string[]): boolean {
    if (messages.length === 0) return false;

    let satisfactionScore = 0;

    for (const msg of messages) {
      const lower = msg.trim().toLowerCase();

      // Gratitude keywords
      if (SATISFACTION_PATTERNS.some((p) => p.test(lower))) {
        satisfactionScore += 1.5;
      }

      // Positive emoji
      if (POSITIVE_EMOJI_PATTERN.test(msg)) {
        satisfactionScore += 1.0;
      }

      // Exclamation with positive context (not frustration)
      if (/!$/.test(msg.trim()) && SATISFACTION_PATTERNS.some((p) => p.test(lower))) {
        satisfactionScore += 0.5;
      }
    }

    const normalizedScore = satisfactionScore / Math.max(messages.length, 1);
    const satisfied = normalizedScore >= 0.7;

    if (satisfied) {
      log.debug({ score: normalizedScore.toFixed(2), messageCount: messages.length }, 'Satisfaction detected');
    }

    return satisfied;
  }

  /**
   * Get a summary of recent feedback with a trend indicator.
   */
  getRecentFeedbackSummary(): {
    positive: number;
    negative: number;
    neutral: number;
    trend: 'improving' | 'declining' | 'stable';
  } {
    const recent = this.history.slice(-TREND_WINDOW);

    let positive = 0;
    let negative = 0;
    let neutral = 0;

    for (const entry of recent) {
      if (entry.signal === 'positive') positive++;
      else if (entry.signal === 'negative') negative++;
      else neutral++;
    }

    // Calculate trend by comparing first half vs second half
    const trend = this.calculateTrend(recent);

    return { positive, negative, neutral, trend };
  }

  /**
   * Return emotional state adjustments based on recent feedback.
   * Called by the emotion engine to modulate the AI's emotional response.
   */
  applyFeedback(emotionalState: EmotionalState): Partial<EmotionalState> {
    const summary = this.getRecentFeedbackSummary();
    const adjustments: Partial<EmotionalState> = {};

    const total = summary.positive + summary.negative + summary.neutral;
    if (total === 0) return adjustments;

    const positiveRatio = summary.positive / total;
    const negativeRatio = summary.negative / total;

    // Valence adjustment: shift toward positive/negative based on feedback
    if (positiveRatio > 0.6) {
      adjustments.valence = Math.min(emotionalState.valence + 0.1, 1.0);
    } else if (negativeRatio > 0.5) {
      adjustments.valence = Math.max(emotionalState.valence - 0.15, -1.0);
    }

    // Confidence: boost when feedback is mostly positive, reduce on negative
    if (positiveRatio > 0.7) {
      adjustments.confidence = Math.min(emotionalState.confidence + 0.08, 1.0);
    } else if (negativeRatio > 0.5) {
      adjustments.confidence = Math.max(emotionalState.confidence - 0.12, 0.1);
    }

    // Engagement: increase when getting any feedback, decrease on prolonged negative
    if (total > 3) {
      if (negativeRatio > 0.6) {
        adjustments.engagement = Math.max(emotionalState.engagement - 0.05, 0.2);
      } else {
        adjustments.engagement = Math.min(emotionalState.engagement + 0.03, 1.0);
      }
    }

    // Patience: eroded by negative feedback, restored by positive
    if (summary.trend === 'declining') {
      adjustments.patience = Math.max(emotionalState.patience - 0.1, 0.1);
    } else if (summary.trend === 'improving') {
      adjustments.patience = Math.min(emotionalState.patience + 0.05, 1.0);
    }

    // Arousal: spike on negative streaks (heightened alertness)
    if (negativeRatio > 0.6 && total >= 3) {
      adjustments.arousal = Math.min(emotionalState.arousal + 0.1, 1.0);
    }

    log.debug(
      { adjustments, trend: summary.trend, positiveRatio: positiveRatio.toFixed(2) },
      'Feedback adjustments computed',
    );

    return adjustments;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Determine trend by comparing the first and second halves of a feedback window.
   */
  private calculateTrend(
    entries: FeedbackEntry[],
  ): 'improving' | 'declining' | 'stable' {
    if (entries.length < 4) return 'stable';

    const mid = Math.floor(entries.length / 2);
    const firstHalf = entries.slice(0, mid);
    const secondHalf = entries.slice(mid);

    const scoreHalf = (half: FeedbackEntry[]): number => {
      let score = 0;
      for (const e of half) {
        if (e.signal === 'positive') score += 1;
        else if (e.signal === 'negative') score -= 1;
      }
      return half.length > 0 ? score / half.length : 0;
    };

    const firstScore = scoreHalf(firstHalf);
    const secondScore = scoreHalf(secondHalf);
    const delta = secondScore - firstScore;

    if (delta > 0.2) return 'improving';
    if (delta < -0.2) return 'declining';
    return 'stable';
  }
}

// ── Sentiment classification ─────────────────────────────────────

const POSITIVE_KEYWORDS = [
  'perfect', 'great', 'awesome', 'excellent', 'love it', 'exactly',
  'that\'s right', 'correct', 'nice', 'thanks', 'thank you', 'good job',
  'well done', 'wonderful', 'brilliant', 'spot on', 'nailed it', 'yes',
];

const NEGATIVE_KEYWORDS = [
  'wrong', 'incorrect', 'no', 'not what i', 'that\'s not', 'bad',
  'terrible', 'awful', 'useless', 'broken', 'doesn\'t work', 'failed',
  'try again', 'redo', 'fix this', 'not right', 'nope', 'stop',
];

function classifyFeedback(feedback: string): 'positive' | 'negative' | 'neutral' {
  const lower = feedback.toLowerCase().trim();

  let positiveHits = 0;
  let negativeHits = 0;

  for (const kw of POSITIVE_KEYWORDS) {
    if (lower.includes(kw)) positiveHits++;
  }

  for (const kw of NEGATIVE_KEYWORDS) {
    if (lower.includes(kw)) negativeHits++;
  }

  if (positiveHits > negativeHits) return 'positive';
  if (negativeHits > positiveHits) return 'negative';
  if (positiveHits > 0 && negativeHits > 0) return 'neutral';

  // Default heuristic: very short messages with no clear keywords
  return 'neutral';
}

// ── Pattern regexes ──────────────────────────────────────────────

const FRUSTRATION_PATTERNS = [
  /\bwrong\b/,
  /\bnot what i/,
  /\bi (already|just) (said|told|asked)/,
  /\bstop\b/,
  /\bforget it\b/,
  /\bnevermind\b/,
  /\bno+\b/,
  /\bagain\??$/,
  /\bwhy (can't|won't|don't)/,
  /\bthis (is|isn't) (wrong|broken|bad)/,
  /\bugh\b/,
  /\bffs\b/,
  /\bomg\b/,
];

const SATISFACTION_PATTERNS = [
  /\bthanks?\b/,
  /\bthank you\b/,
  /\bgreat\b/,
  /\bperfect\b/,
  /\bawesome\b/,
  /\bexcellent\b/,
  /\blove it\b/,
  /\bexactly\b/,
  /\bnice\b/,
  /\bbrilliant\b/,
  /\bspot on\b/,
  /\bnailed it\b/,
  /\bwell done\b/,
  /\bgood (job|work)\b/,
];

const POSITIVE_EMOJI_PATTERN = /[\u{1F600}-\u{1F64F}\u{1F44D}\u{2764}\u{2705}\u{1F389}\u{1F38A}\u{1F60D}\u{1F929}]/u;
