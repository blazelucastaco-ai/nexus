import { describe, it, expect } from 'vitest';
import { pieceLabels, computeRevealTimes, revealedCount } from '../web-ui/src/lib/reveal';

// "nexus connects to telegram and the phone" with each character 0.1s apart, so the
// start time of any word == its character index × 0.1 (e.g. "telegram" at index 18 → 1.8s).
const text = 'nexus connects to telegram and the phone';
const times = Array.from({ length: text.length }, (_, i) => i * 0.1);
const align = { text, times };

describe('pieceLabels', () => {
  it('extracts labels in narration order (sorted by `order`)', () => {
    const spec = {
      nodes: [
        { id: 'tg', label: 'Telegram', order: 1 },
        { id: 'core', label: 'NEXUS', order: 0 },
        { id: 'ph', label: 'Phone', order: 2 },
      ],
    };
    expect(pieceLabels(spec)).toEqual(['NEXUS', 'Telegram', 'Phone']);
  });
  it('falls back to index order when `order` is absent', () => {
    expect(pieceLabels({ steps: [{ label: 'A' }, { label: 'B' }] })).toEqual(['A', 'B']);
  });
});

describe('computeRevealTimes — each node lands on its spoken word', () => {
  it('maps each label to the audio time its word starts', () => {
    const t = computeRevealTimes(['NEXUS', 'Telegram', 'Phone'], align);
    expect(t[0]).toBeCloseTo(0, 5); // "nexus" at index 0
    expect(t[1]).toBeCloseTo(1.8, 5); // "telegram" at index 18
    expect(t[2]).toBeCloseTo(3.5, 5); // "phone" at index 35
  });
  it('searches forward so a repeated word matches the later occurrence', () => {
    const a = { text: 'core core', times: Array.from({ length: 9 }, (_, i) => i * 0.5) };
    const t = computeRevealTimes(['core', 'core'], a);
    expect(t[0]).toBeCloseTo(0, 5); // first "core" at index 0
    expect(t[1]).toBeCloseTo(2.5, 5); // second "core" at index 5
  });
  it('approximates an unspoken label by position instead of failing', () => {
    const t = computeRevealTimes(['NEXUS', 'Ghost', 'Phone'], align);
    expect(t[0]).toBeCloseTo(0, 5);
    expect(t[2]).toBeCloseTo(3.5, 5);
    expect(t[1] ?? -1).toBeGreaterThan(0); // "Ghost" absent → proportional, not a crash
    expect(t[1] ?? 0).toBeLessThan(t[2] ?? 0);
  });
});

describe('revealedCount — playback drives the reveal', () => {
  it('reveals each piece as its time is reached, never before', () => {
    const t = [0, 1.8, 3.5];
    expect(revealedCount(t, 0)).toBe(1); // NEXUS
    expect(revealedCount(t, 0.5)).toBe(1);
    expect(revealedCount(t, 1.8)).toBe(2); // + Telegram, exactly on its word
    expect(revealedCount(t, 3.4)).toBe(2);
    expect(revealedCount(t, 3.5)).toBe(3); // + Phone
  });
});
