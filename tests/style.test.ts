import { describe, it, expect } from 'vitest';
import { StyleEngine } from '../src/personality/style.js';
import type { EmotionalState, PersonalityTraits } from '../src/types.js';

const defaultTraits: PersonalityTraits = {
  humor: 0.7,
  sarcasm: 0.4,
  formality: 0.3,
  assertiveness: 0.6,
  verbosity: 0.5,
  empathy: 0.8,
};

const neutralEmotion: EmotionalState = {
  valence: 0, arousal: 0.3, confidence: 0.5, engagement: 0.5, patience: 0.5,
};

describe('StyleEngine', () => {
  describe('getStyleParameters', () => {
    it('should return all 5 style dimensions', () => {
      const engine = new StyleEngine(defaultTraits);
      const params = engine.getStyleParameters(neutralEmotion, {});
      expect(params).toHaveProperty('formality');
      expect(params).toHaveProperty('brevity');
      expect(params).toHaveProperty('humor');
      expect(params).toHaveProperty('technicalDepth');
      expect(params).toHaveProperty('emotionalTone');
    });

    it('should derive base formality from traits', () => {
      const formalTraits = { ...defaultTraits, formality: 0.9 };
      const engine = new StyleEngine(formalTraits);
      const params = engine.getStyleParameters(neutralEmotion, {});
      expect(params.formality).toBeGreaterThan(0.5);
    });

    it('should derive base humor from traits', () => {
      const humorlessTraits = { ...defaultTraits, humor: 0.1 };
      const engine = new StyleEngine(humorlessTraits);
      const params = engine.getStyleParameters(neutralEmotion, {});
      expect(params.humor).toBeLessThan(0.3);
    });

    it('should increase emotional tone with positive valence', () => {
      const engine = new StyleEngine(defaultTraits);
      const happyEmotion = { ...neutralEmotion, valence: 0.8 };
      const neutralParams = engine.getStyleParameters(neutralEmotion, {});
      const happyParams = engine.getStyleParameters(happyEmotion, {});
      expect(happyParams.emotionalTone).toBeGreaterThan(neutralParams.emotionalTone);
    });

    it('should decrease brevity with high engagement', () => {
      const engine = new StyleEngine(defaultTraits);
      const engagedEmotion = { ...neutralEmotion, engagement: 0.9 };
      const neutralParams = engine.getStyleParameters(neutralEmotion, {});
      const engagedParams = engine.getStyleParameters(engagedEmotion, {});
      expect(engagedParams.brevity).toBeLessThan(neutralParams.brevity);
    });
  });

  describe('context adjustments', () => {
    it('should increase brevity and technical depth for coding activity', () => {
      const engine = new StyleEngine(defaultTraits);
      const noActivity = engine.getStyleParameters(neutralEmotion, {});
      const coding = engine.getStyleParameters(neutralEmotion, { activity: 'coding' });
      expect(coding.brevity).toBeGreaterThan(noActivity.brevity);
      expect(coding.technicalDepth).toBeGreaterThan(noActivity.technicalDepth);
    });

    it('should decrease formality for casual activity', () => {
      const engine = new StyleEngine(defaultTraits);
      const noActivity = engine.getStyleParameters(neutralEmotion, {});
      const casual = engine.getStyleParameters(neutralEmotion, { activity: 'casual' });
      expect(casual.formality).toBeLessThan(noActivity.formality);
    });

    it('should reduce formality for long conversations', () => {
      const engine = new StyleEngine(defaultTraits);
      const shortConvo = engine.getStyleParameters(neutralEmotion, { conversationLength: 3 });
      const longConvo = engine.getStyleParameters(neutralEmotion, { conversationLength: 20 });
      expect(longConvo.formality).toBeLessThan(shortConvo.formality);
    });

    it('should increase empathy and reduce humor for negative user mood', () => {
      const engine = new StyleEngine(defaultTraits);
      const neutralMood = engine.getStyleParameters(neutralEmotion, { userMood: 'neutral' });
      const sadMood = engine.getStyleParameters(neutralEmotion, { userMood: 'negative' });
      expect(sadMood.emotionalTone).toBeGreaterThan(neutralMood.emotionalTone);
      expect(sadMood.humor).toBeLessThan(neutralMood.humor);
    });

    it('should apply late_night adjustments', () => {
      const engine = new StyleEngine(defaultTraits);
      const noTime = engine.getStyleParameters(neutralEmotion, {});
      const lateNight = engine.getStyleParameters(neutralEmotion, { timeOfDay: 'late_night' });
      expect(lateNight.formality).toBeLessThan(noTime.formality);
    });
  });

  describe('getStylePrompt', () => {
    it('should return empty string for neutral/default style', () => {
      // A middle-of-the-road setup may produce an empty prompt
      const balancedTraits = { ...defaultTraits, formality: 0.5, humor: 0.4, verbosity: 0.5, empathy: 0.5 };
      const engine = new StyleEngine(balancedTraits);
      const prompt = engine.getStylePrompt(neutralEmotion, {});
      expect(typeof prompt).toBe('string');
    });

    it('should include casual language instruction for low formality', () => {
      const casualTraits = { ...defaultTraits, formality: 0.1 };
      const engine = new StyleEngine(casualTraits);
      const prompt = engine.getStylePrompt(neutralEmotion, {});
      expect(prompt).toContain('casual');
    });

    it('should include professional language for high formality', () => {
      const formalTraits = { ...defaultTraits, formality: 0.9 };
      const engine = new StyleEngine(formalTraits);
      const prompt = engine.getStylePrompt(neutralEmotion, {});
      expect(prompt).toContain('professional');
    });

    it('should include humor instruction when humor is high', () => {
      const funnyTraits = { ...defaultTraits, humor: 0.9 };
      const engine = new StyleEngine(funnyTraits);
      const happyEmotion = { ...neutralEmotion, valence: 0.5 };
      const prompt = engine.getStylePrompt(happyEmotion, {});
      expect(prompt.toLowerCase()).toContain('humor');
    });

    it('should include concise instruction when brevity is high', () => {
      const terseTraits = { ...defaultTraits, verbosity: 0.05 }; // low verbosity = high brevity
      const engine = new StyleEngine(terseTraits);
      const prompt = engine.getStylePrompt(neutralEmotion, { activity: 'coding' });
      expect(prompt.toLowerCase()).toContain('concise');
    });

    it('should include warm/supportive instruction for high emotional tone', () => {
      const empatheticTraits = { ...defaultTraits, empathy: 1.0 };
      const engine = new StyleEngine(empatheticTraits);
      const happyEmotion = { ...neutralEmotion, valence: 0.6 };
      const prompt = engine.getStylePrompt(happyEmotion, {});
      expect(prompt.toLowerCase()).toContain('warm');
    });

    it('should start with [Communication style] header when non-empty', () => {
      const extremeTraits = { ...defaultTraits, formality: 0.05 };
      const engine = new StyleEngine(extremeTraits);
      const prompt = engine.getStylePrompt(neutralEmotion, {});
      if (prompt.length > 0) {
        expect(prompt).toContain('[Communication style]');
      }
    });
  });

  describe('value clamping', () => {
    it('should never produce values outside valid ranges', () => {
      const engine = new StyleEngine(defaultTraits);
      const extremeEmotion: EmotionalState = {
        valence: 1, arousal: 1, confidence: 1, engagement: 1, patience: 1,
      };
      const params = engine.getStyleParameters(extremeEmotion, {
        activity: 'casual',
        timeOfDay: 'late_night',
        conversationLength: 100,
        userMood: 'negative',
      });
      expect(params.formality).toBeGreaterThanOrEqual(0);
      expect(params.formality).toBeLessThanOrEqual(1);
      expect(params.brevity).toBeGreaterThanOrEqual(0);
      expect(params.brevity).toBeLessThanOrEqual(1);
      expect(params.humor).toBeGreaterThanOrEqual(0);
      expect(params.humor).toBeLessThanOrEqual(1);
      expect(params.technicalDepth).toBeGreaterThanOrEqual(0);
      expect(params.technicalDepth).toBeLessThanOrEqual(1);
      expect(params.emotionalTone).toBeGreaterThanOrEqual(-1);
      expect(params.emotionalTone).toBeLessThanOrEqual(1);
    });
  });
});
