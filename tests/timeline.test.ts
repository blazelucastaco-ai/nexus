import { describe, it, expect } from 'vitest';
import { parseTimelineDays, formatTimelineDay } from '../src/telegram/commands.js';

// ─── parseTimelineDays — input handling for /timeline [days] ──────────────

describe('parseTimelineDays', () => {
  it('defaults to 7 days when no arg provided', () => {
    expect(parseTimelineDays(undefined)).toBe(7);
    expect(parseTimelineDays('')).toBe(7);
    expect(parseTimelineDays('   ')).toBe(7);
  });

  it('parses well-formed integer input', () => {
    expect(parseTimelineDays('1')).toBe(1);
    expect(parseTimelineDays('14')).toBe(14);
    expect(parseTimelineDays('  3  ')).toBe(3);
  });

  it('caps at 30 days (longer windows blow Telegram message limits)', () => {
    expect(parseTimelineDays('31')).toBe(30);
    expect(parseTimelineDays('365')).toBe(30);
    expect(parseTimelineDays('999999')).toBe(30);
  });

  it('falls back to default for non-positive or non-numeric input', () => {
    expect(parseTimelineDays('0')).toBe(7);
    expect(parseTimelineDays('-5')).toBe(7);
    expect(parseTimelineDays('abc')).toBe(7);
    expect(parseTimelineDays('1d')).toBe(1); // parseInt picks up the leading "1" — acceptable
    expect(parseTimelineDays('not a number')).toBe(7);
  });
});

// ─── formatTimelineDay — day-group label ─────────────────────────────────

describe('formatTimelineDay', () => {
  // Build NOW from a fresh "today at noon LOCAL" so calendar-day boundaries
  // are stable regardless of the test runner's timezone. Using UTC dates
  // would put us on the wrong side of midnight in negative-offset zones.
  function buildNow(): number {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    return d.getTime();
  }

  it('returns "Today" for timestamps on the same calendar day as `now`', () => {
    const now = buildNow();
    const sameDay = now - 60 * 60 * 1000; // 11:00 local — same day
    expect(formatTimelineDay(sameDay, now)).toBe('Today');
  });

  it('returns "Yesterday" for timestamps on the prior calendar day', () => {
    const now = buildNow();
    const yesterday = now - 26 * 60 * 60 * 1000; // 26h back from noon = prior day
    expect(formatTimelineDay(yesterday, now)).toBe('Yesterday');
  });

  it('returns a "Mon, May 3" style label for older days', () => {
    const now = buildNow();
    const older = now - 5 * 24 * 60 * 60 * 1000;
    const out = formatTimelineDay(older, now);
    // Don't lock exact weekday/locale-spelling, but assert shape.
    expect(out).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/);
  });

  it('handles a timestamp from a week ago without crashing', () => {
    const now = buildNow();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const out = formatTimelineDay(weekAgo, now);
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe('Today');
    expect(out).not.toBe('Yesterday');
  });
});
