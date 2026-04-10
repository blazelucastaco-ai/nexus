import { describe, it, expect, beforeEach } from 'vitest';
import { PatternRecognizer } from '../src/learning/patterns.js';

describe('PatternRecognizer', () => {
  let recognizer: PatternRecognizer;

  beforeEach(() => {
    recognizer = new PatternRecognizer();
  });

  describe('recordEvent', () => {
    it('should accept events without errors', () => {
      expect(() => {
        recognizer.recordEvent('coding', { language: 'typescript' });
      }).not.toThrow();
    });

    it('should accept custom timestamps', () => {
      expect(() => {
        recognizer.recordEvent('coding', {}, new Date('2024-01-15T10:00:00'));
      }).not.toThrow();
    });
  });

  describe('detectTemporalPatterns', () => {
    it('should return empty array with too few events', () => {
      recognizer.recordEvent('coding', {});
      const patterns = recognizer.detectTemporalPatterns();
      expect(patterns).toEqual([]);
    });

    it('should detect time-of-day clustering', () => {
      // Record 5 events all at 2am (night)
      for (let i = 0; i < 5; i++) {
        recognizer.recordEvent('coding', {}, new Date(`2024-01-${10 + i}T02:00:00`));
      }
      const patterns = recognizer.detectTemporalPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      const nightPattern = patterns.find((p) => p.pattern.includes('night'));
      expect(nightPattern).toBeDefined();
    });

    it('should detect period clustering (morning)', () => {
      // Record 6 events all in the morning (6am-12pm)
      for (let i = 0; i < 6; i++) {
        recognizer.recordEvent('standup', {}, new Date(`2024-01-${10 + i}T09:${i}0:00`));
      }
      const patterns = recognizer.detectTemporalPatterns();
      const morningPattern = patterns.find((p) => p.pattern.includes('morning'));
      expect(morningPattern).toBeDefined();
      expect(morningPattern!.confidence).toBeGreaterThan(0.3);
    });

    it('should detect weekend patterns', () => {
      // Record events only on weekends (Saturday=6, Sunday=0)
      // Jan 2024: Sat 6, Sun 7, Sat 13, Sun 14, Sat 20, Sun 21
      const weekendDates = ['06', '07', '13', '14', '20', '21'];
      for (const day of weekendDates) {
        recognizer.recordEvent('gaming', {}, new Date(`2024-01-${day}T15:00:00`));
      }
      const patterns = recognizer.detectTemporalPatterns();
      const weekendPattern = patterns.find((p) => p.pattern.includes('weekend'));
      expect(weekendPattern).toBeDefined();
    });

    it('should have confidence scores between 0 and 1', () => {
      for (let i = 0; i < 10; i++) {
        recognizer.recordEvent('work', {}, new Date(`2024-01-${10 + i}T14:00:00`));
      }
      const patterns = recognizer.detectTemporalPatterns();
      for (const p of patterns) {
        expect(p.confidence).toBeGreaterThanOrEqual(0);
        expect(p.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('detectSequencePatterns', () => {
    it('should return empty array with too few events', () => {
      recognizer.recordEvent('a', {});
      expect(recognizer.detectSequencePatterns()).toEqual([]);
    });

    it('should detect repeated bigrams (A->B)', () => {
      // Create A->B pattern 4 times
      for (let i = 0; i < 4; i++) {
        recognizer.recordEvent('code', {});
        recognizer.recordEvent('test', {});
      }
      const patterns = recognizer.detectSequencePatterns();
      const codeThenTest = patterns.find(
        (p) => p.sequence[0] === 'code' && p.sequence[1] === 'test',
      );
      expect(codeThenTest).toBeDefined();
      expect(codeThenTest!.confidence).toBeGreaterThan(0.3);
    });

    it('should detect trigrams (A->B->C)', () => {
      // Create A->B->C pattern 3 times
      for (let i = 0; i < 3; i++) {
        recognizer.recordEvent('plan', {});
        recognizer.recordEvent('code', {});
        recognizer.recordEvent('deploy', {});
      }
      const patterns = recognizer.detectSequencePatterns();
      const trigram = patterns.find((p) => p.sequence.length === 3);
      expect(trigram).toBeDefined();
    });

    it('should skip self-loops in bigram detection', () => {
      // Same type repeated shouldn't count as a meaningful pair
      for (let i = 0; i < 10; i++) {
        recognizer.recordEvent('code', {});
      }
      const patterns = recognizer.detectSequencePatterns();
      const selfLoop = patterns.find(
        (p) => p.sequence.length === 2 && p.sequence[0] === 'code' && p.sequence[1] === 'code',
      );
      expect(selfLoop).toBeUndefined();
    });

    it('should sort results by confidence descending', () => {
      for (let i = 0; i < 6; i++) {
        recognizer.recordEvent('a', {});
        recognizer.recordEvent('b', {});
      }
      for (let i = 0; i < 3; i++) {
        recognizer.recordEvent('c', {});
        recognizer.recordEvent('d', {});
      }
      const patterns = recognizer.detectSequencePatterns();
      if (patterns.length >= 2) {
        expect(patterns[0]!.confidence).toBeGreaterThanOrEqual(patterns[1]!.confidence);
      }
    });
  });

  describe('detectPreferencePatterns', () => {
    it('should return empty with too few events', () => {
      recognizer.recordEvent('code', { language: 'python' });
      expect(recognizer.detectPreferencePatterns()).toEqual([]);
    });

    it('should detect dominant preferences', () => {
      // 4 out of 5 events use TypeScript
      for (let i = 0; i < 4; i++) {
        recognizer.recordEvent('code', { language: 'typescript' });
      }
      recognizer.recordEvent('code', { language: 'python' });

      const patterns = recognizer.detectPreferencePatterns();
      const langPref = patterns.find((p) => p.category === 'code.language');
      expect(langPref).toBeDefined();
      expect(langPref!.preference).toBe('typescript');
      expect(langPref!.confidence).toBeGreaterThan(0.3);
    });

    it('should not detect preference when values are evenly split', () => {
      // Equal split — no dominant preference
      for (let i = 0; i < 3; i++) {
        recognizer.recordEvent('editor', { tool: 'vim' });
        recognizer.recordEvent('editor', { tool: 'vscode' });
        recognizer.recordEvent('editor', { tool: 'emacs' });
      }
      const patterns = recognizer.detectPreferencePatterns();
      // Each at 33% — below 50% threshold
      const editorPref = patterns.find((p) => p.category === 'editor.tool');
      expect(editorPref).toBeUndefined();
    });

    it('should ignore null and object values in data', () => {
      for (let i = 0; i < 5; i++) {
        recognizer.recordEvent('test', { config: null, nested: { a: 1 }, name: 'hello' });
      }
      const patterns = recognizer.detectPreferencePatterns();
      // Should only detect 'name' preference, not config or nested
      const configPref = patterns.find((p) => p.category === 'test.config');
      expect(configPref).toBeUndefined();
      const nestedPref = patterns.find((p) => p.category === 'test.nested');
      expect(nestedPref).toBeUndefined();
    });
  });

  describe('event window management', () => {
    it('should handle large number of events without error', () => {
      // Record 6000 events — should trim to 4000
      for (let i = 0; i < 6000; i++) {
        recognizer.recordEvent('load_test', { i });
      }
      // Should still work without memory issues
      expect(() => recognizer.detectTemporalPatterns()).not.toThrow();
      expect(() => recognizer.detectSequencePatterns()).not.toThrow();
      expect(() => recognizer.detectPreferencePatterns()).not.toThrow();
    });
  });
});
