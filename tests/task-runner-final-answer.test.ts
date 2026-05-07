import { describe, it, expect } from 'vitest';
import { pickFinalAnswer } from '../src/core/task-runner.js';

// Bug Lucas reported on 2026-05-06: NEXUS replied to a task with just
// "task finished" + a step checklist, never including the actual answer.
// Root cause was that the per-step rawOutput existed in memory but the
// final-summary formatter never surfaced it. pickFinalAnswer is the helper
// that decides whether the final step's content is worth showing.

describe('pickFinalAnswer', () => {
  it('returns the rawOutput verbatim when it carries real content', () => {
    expect(pickFinalAnswer('Node version: v22.14.0', '')).toBe('Node version: v22.14.0');
  });

  it('falls back to summary when rawOutput is empty', () => {
    expect(pickFinalAnswer('', 'partial summary text')).toBe('partial summary text');
  });

  it('returns "" when both inputs are empty (formatter then omits the Result block)', () => {
    expect(pickFinalAnswer('', '')).toBe('');
    expect(pickFinalAnswer('   ', '   ')).toBe('');
  });

  it('skips boilerplate "Step N completed" so we don\'t broadcast noise', () => {
    expect(pickFinalAnswer('Step 1 completed', '')).toBe('');
    expect(pickFinalAnswer('Step 7 completed.', '')).toBe('');
    expect(pickFinalAnswer('step 3 COMPLETED', '')).toBe('');
  });

  it('skips the timeout sentinel', () => {
    expect(pickFinalAnswer('Task timed out before this step could run', '')).toBe('');
    expect(pickFinalAnswer('Task timed out before this step could run.', '')).toBe('');
  });

  it('skips the "step failed after N attempts" template', () => {
    expect(pickFinalAnswer('Step failed after 4 attempts: connection refused', '')).toBe('');
    expect(pickFinalAnswer('Step failed after 3 Co Work consultations.', '')).toBe('');
  });

  it('truncates very long output with an ellipsis to fit Telegram', () => {
    const long = 'x'.repeat(2000);
    const out = pickFinalAnswer(long, '');
    expect(out.length).toBeLessThanOrEqual(1501); // 1500 + ellipsis char
    expect(out.endsWith('…')).toBe(true);
  });

  it('preserves multi-line content (no whitespace collapse)', () => {
    const out = pickFinalAnswer('Line 1\nLine 2\nLine 3', '');
    expect(out).toContain('\n');
    expect(out.split('\n').length).toBe(3);
  });

  it('trims leading/trailing whitespace before deciding', () => {
    expect(pickFinalAnswer('   \n  v22.14.0  \n  ', '')).toBe('v22.14.0');
  });
});
