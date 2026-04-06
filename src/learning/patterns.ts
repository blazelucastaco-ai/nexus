// Nexus AI — Pattern recognition and behavioral analysis

import { createLogger } from '../utils/logger.js';

const log = createLogger('PatternRecognizer');

/** Minimum events before a pattern can be detected. */
const MIN_EVENTS_FOR_PATTERN = 3;
/** Sliding window size for sequence detection. */
const SEQUENCE_WINDOW = 50;

interface RecordedEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

interface StoredPattern {
  description: string;
  confidence: number;
  detectedAt: Date;
  lastSeen: Date;
  hitCount: number;
}

export class PatternRecognizer {
  private events: RecordedEvent[] = [];
  private patterns: Map<string, StoredPattern> = new Map();

  constructor() {
    log.info('PatternRecognizer initialized');
  }

  /**
   * Record an event for pattern analysis.
   */
  recordEvent(type: string, data: Record<string, unknown>, timestamp?: Date): void {
    const ts = timestamp ?? new Date();
    this.events.push({ type, data, timestamp: ts });

    // Keep memory bounded — trim oldest events beyond a reasonable window
    if (this.events.length > 5000) {
      this.events = this.events.slice(-4000);
    }

    log.debug({ type, timestamp: ts.toISOString() }, 'Event recorded');
  }

  /**
   * Detect time-based patterns by bucketing events into time-of-day and day-of-week groups.
   * Returns patterns like "user codes at night" with confidence scores.
   */
  detectTemporalPatterns(): Array<{ pattern: string; confidence: number; schedule?: string }> {
    if (this.events.length < MIN_EVENTS_FOR_PATTERN) return [];

    const results: Array<{ pattern: string; confidence: number; schedule?: string }> = [];

    // Group events by type
    const byType = new Map<string, RecordedEvent[]>();
    for (const evt of this.events) {
      if (!byType.has(evt.type)) byType.set(evt.type, []);
      byType.get(evt.type)!.push(evt);
    }

    for (const [type, events] of byType) {
      if (events.length < MIN_EVENTS_FOR_PATTERN) continue;

      // ── Time-of-day analysis ──
      const hourBuckets = new Array(24).fill(0) as number[];
      for (const evt of events) {
        hourBuckets[evt.timestamp.getHours()]++;
      }

      const total = events.length;
      const peakHour = hourBuckets.indexOf(Math.max(...hourBuckets));
      const peakCount = hourBuckets[peakHour];
      const peakRatio = peakCount / total;

      if (peakRatio >= 0.35) {
        const label = getTimeOfDayLabel(peakHour);
        const confidence = Math.min(peakRatio + 0.1, 0.95);
        results.push({
          pattern: `"${type}" mostly happens ${label}`,
          confidence,
          schedule: `peak at ${peakHour}:00`,
        });
      }

      // ── Period clustering (morning/afternoon/evening/night) ──
      const periods = { morning: 0, afternoon: 0, evening: 0, night: 0 };
      for (const evt of events) {
        const h = evt.timestamp.getHours();
        if (h >= 6 && h < 12) periods.morning++;
        else if (h >= 12 && h < 18) periods.afternoon++;
        else if (h >= 18 && h < 22) periods.evening++;
        else periods.night++;
      }

      for (const [period, count] of Object.entries(periods)) {
        const ratio = count / total;
        if (ratio >= 0.5 && total >= 5) {
          results.push({
            pattern: `"${type}" tends to happen in the ${period}`,
            confidence: Math.min(ratio, 0.95),
            schedule: period,
          });
        }
      }

      // ── Day-of-week analysis ──
      const dayBuckets = new Array(7).fill(0) as number[];
      for (const evt of events) {
        dayBuckets[evt.timestamp.getDay()]++;
      }

      const weekendCount = dayBuckets[0] + dayBuckets[6];
      const weekendRatio = weekendCount / total;

      if (weekendRatio >= 0.6 && total >= 5) {
        results.push({
          pattern: `"${type}" happens mostly on weekends`,
          confidence: Math.min(weekendRatio, 0.95),
          schedule: 'weekends',
        });
      } else if (weekendRatio <= 0.15 && total >= 7) {
        results.push({
          pattern: `"${type}" happens mostly on weekdays`,
          confidence: Math.min(1 - weekendRatio, 0.95),
          schedule: 'weekdays',
        });
      }

      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const peakDay = dayBuckets.indexOf(Math.max(...dayBuckets));
      const peakDayRatio = dayBuckets[peakDay] / total;
      if (peakDayRatio >= 0.35 && total >= 5) {
        results.push({
          pattern: `"${type}" peaks on ${dayNames[peakDay]}s`,
          confidence: Math.min(peakDayRatio + 0.1, 0.95),
          schedule: dayNames[peakDay],
        });
      }
    }

    // Store detected patterns
    for (const r of results) {
      this.storePattern(r.pattern, r.confidence);
    }

    log.debug({ count: results.length }, 'Temporal patterns detected');
    return results;
  }

  /**
   * Detect action sequences that repeat — e.g., "user always does A then B then C".
   * Uses a sliding window over the event stream and counts n-gram frequencies.
   */
  detectSequencePatterns(): Array<{ sequence: string[]; confidence: number }> {
    const recentEvents = this.events.slice(-SEQUENCE_WINDOW);
    if (recentEvents.length < 2) return [];

    const types = recentEvents.map((e) => e.type);
    const results: Array<{ sequence: string[]; confidence: number }> = [];

    // Count bigrams
    const pairCounts = new Map<string, number>();
    for (let i = 0; i < types.length - 1; i++) {
      // Skip self-loops (same type repeated)
      if (types[i] === types[i + 1]) continue;
      const key = `${types[i]}|${types[i + 1]}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }

    for (const [pair, count] of pairCounts) {
      if (count >= 3) {
        const sequence = pair.split('|');
        const confidence = Math.min(0.3 + count * 0.1, 0.95);
        results.push({ sequence, confidence });
      }
    }

    // Count trigrams
    const triCounts = new Map<string, number>();
    for (let i = 0; i < types.length - 2; i++) {
      const key = `${types[i]}|${types[i + 1]}|${types[i + 2]}`;
      triCounts.set(key, (triCounts.get(key) ?? 0) + 1);
    }

    for (const [triplet, count] of triCounts) {
      if (count >= 2) {
        const sequence = triplet.split('|');
        const confidence = Math.min(0.4 + count * 0.12, 0.95);
        results.push({ sequence, confidence });
      }
    }

    // Sort by confidence descending
    results.sort((a, b) => b.confidence - a.confidence);

    // Store detected patterns
    for (const r of results) {
      this.storePattern(`Sequence: ${r.sequence.join(' -> ')}`, r.confidence);
    }

    log.debug({ count: results.length }, 'Sequence patterns detected');
    return results;
  }

  /**
   * Detect preference patterns from event data fields.
   * Looks for repeated values in event data across the same event type.
   */
  detectPreferencePatterns(): Array<{ category: string; preference: string; confidence: number }> {
    if (this.events.length < MIN_EVENTS_FOR_PATTERN) return [];

    const results: Array<{ category: string; preference: string; confidence: number }> = [];

    // Group events by type and analyze data field values
    const byType = new Map<string, RecordedEvent[]>();
    for (const evt of this.events) {
      if (!byType.has(evt.type)) byType.set(evt.type, []);
      byType.get(evt.type)!.push(evt);
    }

    for (const [type, events] of byType) {
      if (events.length < MIN_EVENTS_FOR_PATTERN) continue;

      // Count values per data key
      const keyCounts = new Map<string, Map<string, number>>();

      for (const evt of events) {
        for (const [key, value] of Object.entries(evt.data)) {
          if (value == null || typeof value === 'object') continue;
          const strVal = String(value);
          if (!keyCounts.has(key)) keyCounts.set(key, new Map());
          const valMap = keyCounts.get(key)!;
          valMap.set(strVal, (valMap.get(strVal) ?? 0) + 1);
        }
      }

      // Find dominant values
      for (const [key, valMap] of keyCounts) {
        const total = Array.from(valMap.values()).reduce((a, b) => a + b, 0);
        if (total < MIN_EVENTS_FOR_PATTERN) continue;

        let topVal = '';
        let topCount = 0;
        for (const [val, count] of valMap) {
          if (count > topCount) {
            topVal = val;
            topCount = count;
          }
        }

        const ratio = topCount / total;
        if (ratio >= 0.5) {
          const confidence = Math.min(ratio * 0.8 + Math.log2(total) / 20, 0.95);
          results.push({
            category: `${type}.${key}`,
            preference: topVal,
            confidence,
          });
        }
      }
    }

    results.sort((a, b) => b.confidence - a.confidence);

    log.debug({ count: results.length }, 'Preference patterns detected');
    return results;
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Store or update a detected pattern with its confidence.
   */
  private storePattern(description: string, confidence: number): void {
    const existing = this.patterns.get(description);
    const now = new Date();

    if (existing) {
      existing.confidence = Math.max(existing.confidence, confidence);
      existing.lastSeen = now;
      existing.hitCount++;
    } else {
      this.patterns.set(description, {
        description,
        confidence,
        detectedAt: now,
        lastSeen: now,
        hitCount: 1,
      });
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function getTimeOfDayLabel(hour: number): string {
  if (hour >= 5 && hour < 9) return 'in the early morning';
  if (hour >= 9 && hour < 12) return 'in the morning';
  if (hour >= 12 && hour < 14) return 'around midday';
  if (hour >= 14 && hour < 17) return 'in the afternoon';
  if (hour >= 17 && hour < 20) return 'in the evening';
  if (hour >= 20 && hour < 23) return 'at night';
  return 'late at night';
}
