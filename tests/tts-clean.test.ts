import { describe, expect, it } from 'vitest';
import { cleanForSpeech } from '../src/web/tts.js';

describe('cleanForSpeech (local TTS normalization)', () => {
  it('fixes the reported reply: no digit-spelling, no spoken emoji, no markdown', () => {
    const out = cleanForSpeech("It's **9:03 PM EDT** — game should be well underway right now 🏀");
    expect(out).toContain('nine oh three PM');
    expect(out).not.toMatch(/nine zero three/);
    expect(out.toLowerCase()).not.toContain('basketball');
    expect(out).not.toContain('🏀');
    expect(out).not.toContain('*');
    expect(out).toContain('EDT');
  });

  it('speaks clock times as words', () => {
    expect(cleanForSpeech('at 3:00 PM')).toContain("three o'clock PM");
    expect(cleanForSpeech('at 11:15')).toContain('eleven fifteen');
    expect(cleanForSpeech('at 12:05 am')).toContain('twelve oh five AM');
  });

  it('strips emoji and pictographs entirely', () => {
    const out = cleanForSpeech('Nice work 🎉🏀✅ done');
    expect(out).toBe('Nice work done');
  });

  it('replaces URLs and number ranges with speakable text', () => {
    expect(cleanForSpeech('see https://example.com/x now')).toBe('see link now');
    expect(cleanForSpeech('Lakers won 100-98')).toContain('100 to 98');
  });

  it('drops markdown emphasis and collapses whitespace', () => {
    expect(cleanForSpeech('**bold** _italic_ `code`\n\nnext')).toBe('bold italic code next');
  });
});
