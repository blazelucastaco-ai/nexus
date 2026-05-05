import { describe, it, expect } from 'vitest';
import { pickMoodBreakthrough } from '../src/personality/index.js';
import type { EmotionLabel } from '../src/types.js';

// Deterministic RNG for tests — picks the first template every time so we
// can assert exact strings.
const rngFirst = (): number => 0;
// RNG that picks the LAST template (rng() = 0.99 → last index).
const rngLast = (): number => 0.99;

function state(opts: Partial<{
  emotionLabel: EmotionLabel;
  mood: number;
  phase: string;
}> = {}): { emotionLabel: EmotionLabel; mood: number; phase: string } {
  return {
    emotionLabel: opts.emotionLabel ?? 'neutral',
    mood: opts.mood ?? 0,
    phase: opts.phase ?? 'peak',
  };
}

describe('pickMoodBreakthrough', () => {
  it('returns null for steady-state (neutral emotion, mid mood, daytime phase)', () => {
    expect(pickMoodBreakthrough(state(), rngFirst)).toBeNull();
    expect(pickMoodBreakthrough(state({ phase: 'morning' }), rngFirst)).toBeNull();
    expect(pickMoodBreakthrough(state({ phase: 'evening' }), rngFirst)).toBeNull();
  });

  it('returns null for mid mood and good emotions', () => {
    expect(pickMoodBreakthrough(state({ emotionLabel: 'curious' }), rngFirst)).toBeNull();
    expect(pickMoodBreakthrough(state({ emotionLabel: 'satisfied', mood: 0.4 }), rngFirst)).toBeNull();
  });

  it('fires for frustrated emotion (highest precedence)', () => {
    const out = pickMoodBreakthrough(state({ emotionLabel: 'frustrated' }), rngFirst);
    expect(out).toBe('shaking off the last failure first');
  });

  it('fires for impatient emotion', () => {
    const out = pickMoodBreakthrough(state({ emotionLabel: 'impatient' }), rngFirst);
    expect(out).toBe("let's just get this done");
  });

  it('fires for late-night phase (no other trigger)', () => {
    const out = pickMoodBreakthrough(
      state({ emotionLabel: 'neutral', phase: 'late-night' }),
      rngFirst,
    );
    expect(out).toBe("late-night brain, but i'm here");
  });

  it('fires for low mood when nothing stronger is present', () => {
    const out = pickMoodBreakthrough(
      state({ emotionLabel: 'neutral', mood: -0.5, phase: 'peak' }),
      rngFirst,
    );
    expect(out).toBe('a touch off-kilter today — bear with me');
  });

  it('emotion takes precedence over late-night phase', () => {
    const out = pickMoodBreakthrough(
      state({ emotionLabel: 'frustrated', phase: 'late-night' }),
      rngFirst,
    );
    // Should pick from the `frustrated` pool, not the `late-night` pool.
    expect(out).toBe('shaking off the last failure first');
  });

  it('late-night takes precedence over low mood', () => {
    const out = pickMoodBreakthrough(
      state({ emotionLabel: 'neutral', mood: -0.5, phase: 'late-night' }),
      rngFirst,
    );
    expect(out).toBe("late-night brain, but i'm here");
  });

  it('uses the RNG to vary template selection within a pool', () => {
    const first = pickMoodBreakthrough(state({ phase: 'late-night' }), rngFirst);
    const last = pickMoodBreakthrough(state({ phase: 'late-night' }), rngLast);
    // Both must be valid late-night strings, but with different rngs they
    // should differ (the late-night pool has 4 templates).
    expect(first).not.toBeNull();
    expect(last).not.toBeNull();
    expect(first).not.toBe(last);
  });

  it('low-mood threshold is exclusive — exactly -0.3 does NOT fire', () => {
    expect(pickMoodBreakthrough(state({ mood: -0.3 }), rngFirst)).toBeNull();
    expect(pickMoodBreakthrough(state({ mood: -0.31 }), rngFirst)).not.toBeNull();
  });

  it('output has no leading/trailing whitespace and no markdown wrapping (orchestrator italicises)', () => {
    const out = pickMoodBreakthrough(state({ emotionLabel: 'frustrated' }), rngFirst);
    expect(out).not.toBeNull();
    expect(out!.trim()).toBe(out);
    expect(out).not.toMatch(/^[*_"]/);
    expect(out).not.toMatch(/[*_"]$/);
  });
});
