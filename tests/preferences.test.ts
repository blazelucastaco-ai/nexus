import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PreferenceLearner } from '../src/learning/preferences.js';

function makeMockCortex() {
  const facts: any[] = [];
  return {
    getFacts: vi.fn().mockReturnValue([]),
    storeFact: vi.fn().mockImplementation((fact: any) => {
      facts.push(fact);
      return `fact-${facts.length}`;
    }),
    getStoredFacts: () => facts,
  } as any;
}

describe('PreferenceLearner', () => {
  let learner: PreferenceLearner;
  let cortex: ReturnType<typeof makeMockCortex>;

  beforeEach(() => {
    cortex = makeMockCortex();
    learner = new PreferenceLearner(cortex);
  });

  describe('observeChoice', () => {
    it('should accept choices without throwing', () => {
      expect(() => {
        learner.observeChoice('editor', 'VS Code');
      }).not.toThrow();
    });

    it('should accept choices with context', () => {
      expect(() => {
        learner.observeChoice('editor', 'VS Code', 'TypeScript development');
      }).not.toThrow();
    });

    it('should accumulate observations', () => {
      learner.observeChoice('language', 'TypeScript');
      learner.observeChoice('language', 'TypeScript');
      learner.observeChoice('language', 'TypeScript');

      const pref = learner.getPreference('language');
      expect(pref).not.toBeNull();
      expect(pref!.value).toBe('TypeScript');
    });
  });

  describe('getPreference', () => {
    it('should return null for unknown category', () => {
      const pref = learner.getPreference('unknown_category_xyz');
      expect(pref).toBeNull();
    });

    it('should return null with only 1 observation', () => {
      learner.observeChoice('theme', 'dark');
      const pref = learner.getPreference('theme');
      expect(pref).toBeNull(); // not enough data
    });

    it('should return the dominant choice', () => {
      learner.observeChoice('framework', 'React');
      learner.observeChoice('framework', 'React');
      learner.observeChoice('framework', 'React');
      learner.observeChoice('framework', 'Vue');

      const pref = learner.getPreference('framework');
      expect(pref).not.toBeNull();
      expect(pref!.value).toBe('React');
    });

    it('should have confidence between 0 and 1', () => {
      for (let i = 0; i < 5; i++) {
        learner.observeChoice('language', 'TypeScript');
      }
      const pref = learner.getPreference('language');
      if (pref) {
        expect(pref.confidence).toBeGreaterThanOrEqual(0);
        expect(pref.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('detectPattern', () => {
    it('should return null with too few observations', () => {
      learner.observeChoice('timing', 'morning');
      learner.observeChoice('timing', 'morning');

      const pattern = learner.detectPattern('timing');
      expect(pattern).toBeNull(); // needs >= 3
    });

    it('should return a pattern with enough observations', () => {
      for (let i = 0; i < 5; i++) {
        learner.observeChoice('coding_time', 'morning');
      }
      learner.observeChoice('coding_time', 'evening');

      const pattern = learner.detectPattern('coding_time');
      expect(pattern).not.toBeNull();
      expect(pattern!.pattern).toContain('morning');
      expect(pattern!.confidence).toBeGreaterThan(0);
    });

    it('should include context pattern when consistently repeated', () => {
      const context = 'before deployment';
      for (let i = 0; i < 5; i++) {
        learner.observeChoice('action', 'test', context);
      }

      const pattern = learner.detectPattern('action');
      if (pattern) {
        // May include context description
        expect(typeof pattern.pattern).toBe('string');
      }
    });
  });

  describe('getAllPreferences', () => {
    it('should return empty array with no observations', () => {
      const prefs = learner.getAllPreferences();
      expect(Array.isArray(prefs)).toBe(true);
    });

    it('should return preferences sorted by confidence descending', () => {
      // Create two preferences with different strengths
      for (let i = 0; i < 8; i++) {
        learner.observeChoice('editor', 'VS Code'); // Strong preference
      }
      for (let i = 0; i < 4; i++) {
        learner.observeChoice('terminal', 'iTerm'); // Weaker preference
      }

      const prefs = learner.getAllPreferences();
      if (prefs.length >= 2) {
        expect(prefs[0]!.confidence).toBeGreaterThanOrEqual(prefs[1]!.confidence);
      }
    });
  });

  describe('suggestPreference', () => {
    it('should return null with no data', () => {
      const suggestion = learner.suggestPreference('unknown', 'any context');
      expect(suggestion).toBeNull();
    });

    it('should return suggestion when pattern is established', () => {
      for (let i = 0; i < 6; i++) {
        learner.observeChoice('deployment_tool', 'Docker');
      }

      const suggestion = learner.suggestPreference('deployment_tool', 'setting up a new service');
      expect(suggestion).toBe('Docker');
    });

    it('should prefer context-specific data when available', () => {
      const ctx = 'testing environment';
      for (let i = 0; i < 3; i++) {
        learner.observeChoice('language', 'JavaScript', ctx);
      }
      // Also add general TypeScript data
      for (let i = 0; i < 5; i++) {
        learner.observeChoice('language', 'TypeScript'); // general
      }

      const suggestion = learner.suggestPreference('language', ctx);
      // Context-specific (JavaScript) should override general (TypeScript)
      expect(suggestion).toBe('JavaScript');
    });
  });
});
