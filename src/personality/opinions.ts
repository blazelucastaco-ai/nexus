import { createLogger } from '../utils/logger.js';
import { clamp, nowISO } from '../utils/helpers.js';

const log = createLogger('OpinionEngine');

export type DisagreementLevel = 'mention' | 'suggest' | 'recommend' | 'warn' | 'refuse';

export interface Evidence {
  content: string;
  weight: number; // -1 to 1: negative = against, positive = for
  source: string;
  timestamp: string;
}

export interface Opinion {
  topic: string;
  stance: number; // -1 to 1: disagree ↔ agree
  confidence: number; // 0 to 1
  evidence: Evidence[];
  formed: string;
  lastUpdated: string;
}

/** A point-in-time snapshot of an opinion, used to track drift over time. */
export interface OpinionSnapshot {
  stance: number;
  confidence: number;
  timestamp: Date;
  reason: string;
}

export class OpinionEngine {
  private opinions: Map<string, Opinion> = new Map();
  private opinionHistory: Map<string, OpinionSnapshot[]> = new Map();
  private readonly pushbackThreshold: number;

  constructor(pushbackThreshold = 0.6) {
    this.pushbackThreshold = clamp(pushbackThreshold, 0, 1);
    log.info({ pushbackThreshold: this.pushbackThreshold }, 'Opinion engine initialized');
  }

  /** Add evidence and update or form an opinion on a topic. */
  formOpinion(topic: string, evidence: Evidence): Opinion {
    const key = topic.toLowerCase().trim();
    const existing = this.opinions.get(key);

    if (existing) {
      existing.evidence.push(evidence);
      existing.lastUpdated = nowISO();
      this.recalculate(existing);
      this.logSnapshot(key, existing, evidence.content);
      log.debug({ topic: key, stance: existing.stance, confidence: existing.confidence }, 'Opinion updated');
      return { ...existing };
    }

    const opinion: Opinion = {
      topic: key,
      stance: clamp(evidence.weight, -1, 1),
      confidence: clamp(Math.abs(evidence.weight) * 0.5, 0, 1),
      evidence: [evidence],
      formed: nowISO(),
      lastUpdated: nowISO(),
    };

    this.opinions.set(key, opinion);
    this.logSnapshot(key, opinion, `Initial opinion: ${evidence.content}`);
    log.debug({ topic: key, stance: opinion.stance, confidence: opinion.confidence }, 'Opinion formed');
    return { ...opinion };
  }

  /**
   * Adjust an existing opinion based on new evidence. If the topic has no opinion
   * yet, a neutral one is created before the evolution is applied.
   */
  evolveOpinion(topic: string, newEvidence: string, direction: number): Opinion {
    const key = topic.toLowerCase().trim();
    // Ensure the opinion exists before evolving
    if (!this.opinions.has(key)) {
      this.formOpinion(key, {
        content: 'Baseline (no prior evidence)',
        weight: 0,
        source: 'system',
        timestamp: nowISO(),
      });
    }
    const evidence: Evidence = {
      content: newEvidence,
      weight: clamp(direction, -1, 1),
      source: 'evolution',
      timestamp: nowISO(),
    };
    const result = this.formOpinion(key, evidence);
    log.info(
      { topic: key, direction, stance: result.stance, confidence: result.confidence },
      'Opinion evolved',
    );
    return result;
  }

  /**
   * Returns a human-readable description of how an opinion on a topic has
   * shifted over time, oldest → newest.
   */
  getOpinionTrend(topic: string): string {
    const key = topic.toLowerCase().trim();
    const history = this.opinionHistory.get(key);
    const opinion = this.opinions.get(key);

    if (!history || history.length === 0) {
      return opinion
        ? `No shift recorded for "${topic}" yet — current stance: ${opinion.stance.toFixed(2)}.`
        : `No opinion on "${topic}" yet.`;
    }

    if (history.length === 1) {
      const snap = history[0]!;
      return `"${topic}": only one data point so far — stance ${snap.stance.toFixed(2)} (confidence ${(snap.confidence * 100).toFixed(0)}%).`;
    }

    const first = history[0]!;
    const last = history[history.length - 1]!;
    const delta = last.stance - first.stance;
    const direction = delta > 0.05 ? 'warmed up' : delta < -0.05 ? 'cooled down' : 'stayed roughly the same';
    const snapSummary = history
      .slice(-5) // show last 5 entries
      .map((s) => {
        const d = s.timestamp.toISOString().slice(0, 10);
        const stanceLabel = s.stance > 0.3 ? 'positive' : s.stance < -0.3 ? 'negative' : 'neutral';
        return `${d}: ${stanceLabel} (${s.stance.toFixed(2)}) — ${s.reason}`;
      })
      .join('\n  ');

    return (
      `"${topic}" opinion trend (${history.length} data points): ${direction} from ${first.stance.toFixed(2)} → ${last.stance.toFixed(2)}.\n` +
      `  Recent history:\n  ${snapSummary}`
    );
  }

  /**
   * Drift all opinions toward neutral over time. Call once per day (or pass
   * fractional days for finer granularity). Decay rate: 0.01 per day.
   */
  applyTimeDecay(days = 1): void {
    const DECAY_PER_DAY = 0.01;
    const decay = DECAY_PER_DAY * days;

    for (const [key, opinion] of this.opinions) {
      const prev = opinion.stance;
      // Nudge stance toward 0
      if (Math.abs(opinion.stance) > decay) {
        opinion.stance = opinion.stance > 0
          ? opinion.stance - decay
          : opinion.stance + decay;
      } else {
        opinion.stance = 0;
      }
      // Confidence also decays slightly when not reinforced
      opinion.confidence = clamp(opinion.confidence - decay * 0.5, 0, 1);
      opinion.lastUpdated = nowISO();

      if (Math.abs(opinion.stance - prev) > 0.001) {
        this.logSnapshot(key, opinion, `Time decay (${days.toFixed(1)}d)`);
      }
    }

    log.debug({ days, opinions: this.opinions.size }, 'Time decay applied');
  }

  /** Recalculate stance and confidence from all accumulated evidence. */
  private recalculate(opinion: Opinion): void {
    if (opinion.evidence.length === 0) {
      opinion.stance = 0;
      opinion.confidence = 0;
      return;
    }

    let totalWeight = 0;
    let weightedStance = 0;

    for (const e of opinion.evidence) {
      const absWeight = Math.abs(e.weight);
      totalWeight += absWeight;
      weightedStance += e.weight;
    }

    // Stance is the normalized average direction
    opinion.stance = clamp(
      totalWeight > 0 ? weightedStance / totalWeight : 0,
      -1,
      1,
    );

    // Confidence grows with more evidence and stronger agreement
    const agreementFactor = totalWeight > 0 ? Math.abs(weightedStance) / totalWeight : 0;
    const evidenceCount = Math.min(opinion.evidence.length / 10, 1); // saturates at 10 pieces
    opinion.confidence = clamp(agreementFactor * 0.6 + evidenceCount * 0.4, 0, 1);
  }

  /** Check whether NEXUS should push back on this topic. */
  shouldPushBack(topic: string, overrideConfidence?: number): boolean {
    const key = topic.toLowerCase().trim();
    const opinion = this.opinions.get(key);
    if (!opinion) return false;

    const effectiveConfidence = overrideConfidence ?? opinion.confidence;
    // Push back when confident enough AND stance is negative (disagrees)
    return effectiveConfidence >= this.pushbackThreshold && opinion.stance < -0.2;
  }

  /** Map a confidence level to a disagreement intensity. */
  getDisagreementLevel(confidence: number): DisagreementLevel {
    if (confidence >= 0.9) return 'refuse';
    if (confidence >= 0.75) return 'warn';
    if (confidence >= 0.6) return 'recommend';
    if (confidence >= 0.4) return 'suggest';
    return 'mention';
  }

  /** Retrieve an opinion, if one exists. */
  getOpinion(topic: string): Opinion | undefined {
    const key = topic.toLowerCase().trim();
    const opinion = this.opinions.get(key);
    return opinion ? { ...opinion, evidence: [...opinion.evidence] } : undefined;
  }

  /** List all held opinions. */
  getAllOpinions(): Opinion[] {
    return Array.from(this.opinions.values()).map((o) => ({
      ...o,
      evidence: [...o.evidence],
    }));
  }

  /** Restore opinions from a persisted snapshot (replaces current state). */
  restoreOpinions(opinions: Opinion[]): void {
    this.opinions.clear();
    for (const o of opinions) {
      this.opinions.set(o.topic, { ...o, evidence: [...o.evidence] });
    }
    log.debug({ count: opinions.length }, 'Opinions restored from state');
  }

  /** Restore opinion history from persistence. */
  restoreHistory(
    raw: Record<string, Array<{ stance: number; confidence: number; timestamp: string; reason: string }>>,
  ): void {
    this.opinionHistory.clear();
    for (const [key, snaps] of Object.entries(raw)) {
      this.opinionHistory.set(
        key,
        snaps.map((s) => ({ ...s, timestamp: new Date(s.timestamp) })),
      );
    }
    log.debug({ topics: this.opinionHistory.size }, 'Opinion history restored from state');
  }

  /** Serialize opinion history for persistence. */
  serializeHistory(): Record<string, Array<{ stance: number; confidence: number; timestamp: string; reason: string }>> {
    const out: Record<string, Array<{ stance: number; confidence: number; timestamp: string; reason: string }>> = {};
    for (const [key, snaps] of this.opinionHistory) {
      out[key] = snaps.map((s) => ({ ...s, timestamp: s.timestamp.toISOString() }));
    }
    return out;
  }

  /** Get raw history for a topic. */
  getHistory(topic: string): OpinionSnapshot[] {
    return this.opinionHistory.get(topic.toLowerCase().trim()) ?? [];
  }

  /** Record a snapshot of the current opinion state. */
  private logSnapshot(key: string, opinion: Opinion, reason: string): void {
    const snaps = this.opinionHistory.get(key) ?? [];
    snaps.push({
      stance: opinion.stance,
      confidence: opinion.confidence,
      timestamp: new Date(),
      reason,
    });
    // Keep at most 50 snapshots per topic
    if (snaps.length > 50) snaps.splice(0, snaps.length - 50);
    this.opinionHistory.set(key, snaps);
  }
}
