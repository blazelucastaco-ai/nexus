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

export class OpinionEngine {
  private opinions: Map<string, Opinion> = new Map();
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
    log.debug({ topic: key, stance: opinion.stance, confidence: opinion.confidence }, 'Opinion formed');
    return { ...opinion };
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
}
