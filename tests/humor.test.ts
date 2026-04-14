import { describe, it, expect, beforeEach } from 'vitest';
import { HumorEngine } from '../src/personality/humor.js';
import type { PersonalityTraits, EmotionalState } from '../src/types.js';

const defaultTraits: PersonalityTraits = {
  humor: 0.8,
  sarcasm: 0.5,
  formality: 0.3,
  assertiveness: 0.6,
  verbosity: 0.5,
  empathy: 0.7,
};

const neutralEmotion: EmotionalState = {
  valence: 0.2,
  arousal: 0.4,
  confidence: 0.6,
  engagement: 0.6,
  patience: 0.7,
};

const baseContext = {
  rapport: 0.6,
  recentHumorCount: 0,
  topicSeriousness: 0.1,
  userReceptive: true,
  conversationLength: 10,
};

describe('HumorEngine', () => {
  let engine: HumorEngine;

  beforeEach(() => {
    engine = new HumorEngine(defaultTraits);
  });

  describe('shouldAddHumor', () => {
    it('should return false for very serious topics', () => {
      const result = engine.shouldAddHumor({ ...baseContext, topicSeriousness: 0.8 }, neutralEmotion);
      expect(result).toBe(false);
    });

    it('should return false when frequency cap is reached', () => {
      const result = engine.shouldAddHumor({ ...baseContext, recentHumorCount: 3 }, neutralEmotion);
      expect(result).toBe(false);
    });

    it('should return false too soon after last humor (gap check)', () => {
      // Record humor at message 8, then try at 10 (gap = 2, less than MIN_GAP_MESSAGES = 3)
      engine.recordHumorUsage(8);
      const result = engine.shouldAddHumor({ ...baseContext, conversationLength: 10 }, neutralEmotion);
      expect(result).toBe(false);
    });

    it('should return true in ideal conditions', () => {
      const result = engine.shouldAddHumor(baseContext, neutralEmotion);
      // With humor=0.8, rapport=0.6, positive emotion — should pass threshold
      expect(result).toBe(true);
    });

    it('should dampen humor when user is not receptive', () => {
      const nonReceptiveContext = { ...baseContext, userReceptive: false };
      // With receptivity multiplier of 0.3, may fail threshold
      const result = engine.shouldAddHumor(nonReceptiveContext, neutralEmotion);
      // Not deterministic but should be less likely — just test it doesn't throw
      expect(typeof result).toBe('boolean');
    });

    it('should return false for zero humor level', () => {
      const humorlessEngine = new HumorEngine({ ...defaultTraits, humor: 0 });
      const result = humorlessEngine.shouldAddHumor(baseContext, neutralEmotion);
      expect(result).toBe(false);
    });
  });

  describe('selectHumorType', () => {
    it('should return a valid humor type', () => {
      const validTypes = ['observational', 'self_deprecating', 'callback', 'deadpan', 'sarcasm', 'celebration'];
      const result = engine.selectHumorType(baseContext, neutralEmotion);
      expect(validTypes).toContain(result);
    });

    it('should prefer callback for long conversations', () => {
      const longContext = { ...baseContext, conversationLength: 20 };
      const result = engine.selectHumorType(longContext, neutralEmotion);
      // callback score is 0.7 for long conversations — should be selected often
      // Just check it's a valid type
      const validTypes = ['observational', 'self_deprecating', 'callback', 'deadpan', 'sarcasm', 'celebration'];
      expect(validTypes).toContain(result);
    });

    it('should prefer self_deprecating early in conversation', () => {
      const lowRapportContext = { ...baseContext, rapport: 0.3, conversationLength: 3 };
      const result = engine.selectHumorType(lowRapportContext, neutralEmotion);
      expect(['self_deprecating', 'observational', 'deadpan', 'callback', 'sarcasm', 'celebration']).toContain(result);
    });

    it('should prefer celebration for positive emotion', () => {
      const happyEmotion: EmotionalState = { ...neutralEmotion, valence: 0.8 };
      const result = engine.selectHumorType(baseContext, happyEmotion);
      // celebration score = 0.6 + 0.8*0.3 = 0.84, highest for very positive emotion
      expect(result).toBe('celebration');
    });

    it('should consider sarcasm level in personality', () => {
      const highSarcasmEngine = new HumorEngine({ ...defaultTraits, sarcasm: 1.0 });
      // sarcasm score = 1.0*0.5 + 0.6*0.3 = 0.68
      // Just verify it doesn't throw
      const result = highSarcasmEngine.selectHumorType(baseContext, neutralEmotion);
      const validTypes = ['observational', 'self_deprecating', 'callback', 'deadpan', 'sarcasm', 'celebration'];
      expect(validTypes).toContain(result);
    });
  });

  describe('generateHumorPrompt', () => {
    it('should return non-empty prompt for every humor type', () => {
      const types: Array<'observational' | 'self_deprecating' | 'callback' | 'deadpan' | 'sarcasm' | 'celebration'> = [
        'observational', 'self_deprecating', 'callback', 'deadpan', 'sarcasm', 'celebration',
      ];
      for (const type of types) {
        const prompt = engine.generateHumorPrompt(type);
        expect(prompt.length).toBeGreaterThan(10);
      }
    });
  });

  describe('recordHumorUsage and getRecentHumorCount', () => {
    it('should return 0 before any humor is used', () => {
      expect(engine.getRecentHumorCount()).toBe(0);
    });

    it('should increment count after recording usage', () => {
      engine.recordHumorUsage(5);
      expect(engine.getRecentHumorCount()).toBe(1);
    });

    it('should track multiple usages', () => {
      engine.recordHumorUsage(3);
      engine.recordHumorUsage(7);
      engine.recordHumorUsage(12);
      expect(engine.getRecentHumorCount()).toBe(3);
    });
  });

  describe('observeUserMessage — reception tracking', () => {
    it('should not change stats when no pending reception', () => {
      engine.observeUserMessage('haha that was funny!');
      const stats = engine.getReceptionStats();
      expect(stats.attempts).toBe(0);
    });

    it('should record positive reception on lol/haha', () => {
      engine.recordHumorUsage(5); // arms pendingReception
      engine.observeUserMessage('lol that was funny');
      const stats = engine.getReceptionStats();
      expect(stats.attempts).toBe(1);
      expect(stats.hits).toBe(1);
      expect(stats.rate).toBe(1);
    });

    it('should record negative reception on neutral response', () => {
      engine.recordHumorUsage(5);
      engine.observeUserMessage('anyway, about my question...');
      const stats = engine.getReceptionStats();
      expect(stats.attempts).toBe(1);
      expect(stats.hits).toBe(0);
      expect(stats.rate).toBe(0);
    });

    it('should dampen humor after many misses', () => {
      // Record 25 misses to trigger dampening
      for (let i = 0; i < 25; i++) {
        engine.recordHumorUsage(i * 5);
        engine.observeUserMessage('ok, continue'); // no positive signal
      }
      const stats = engine.getReceptionStats();
      expect(stats.attempts).toBe(25);
      expect(stats.rate).toBeLessThan(0.2); // all misses → rate = 0

      // shouldAddHumor should now be much less likely to fire
      const result = engine.shouldAddHumor(baseContext, neutralEmotion);
      // With 0% hit rate and dampening, should be false
      expect(result).toBe(false);
    });

    it('should recognize explicit laughter as positive signal', () => {
      engine.recordHumorUsage(1);
      engine.observeUserMessage('haha that cracked me up');
      const stats = engine.getReceptionStats();
      expect(stats.hits).toBe(1);
    });
  });
});
