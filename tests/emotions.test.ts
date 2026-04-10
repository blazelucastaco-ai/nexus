import { describe, it, expect, beforeEach } from 'vitest';
import { EmotionalEngine, EVENT_FORCES } from '../src/personality/emotions.js';
import type { PersonalityTraits } from '../src/types.js';

const defaultTraits: PersonalityTraits = {
  humor: 0.7,
  sarcasm: 0.4,
  formality: 0.3,
  assertiveness: 0.6,
  verbosity: 0.5,
  empathy: 0.8,
};

describe('EmotionalEngine', () => {
  let engine: EmotionalEngine;

  beforeEach(() => {
    engine = new EmotionalEngine(defaultTraits);
  });

  describe('initialization', () => {
    it('should initialize with baseline state from traits', () => {
      const state = engine.getState();
      expect(state.valence).toBeTypeOf('number');
      expect(state.arousal).toBeTypeOf('number');
      expect(state.confidence).toBeTypeOf('number');
      expect(state.engagement).toBeTypeOf('number');
      expect(state.patience).toBeTypeOf('number');
    });

    it('should have all values within valid ranges', () => {
      const state = engine.getState();
      expect(state.valence).toBeGreaterThanOrEqual(-1);
      expect(state.valence).toBeLessThanOrEqual(1);
      expect(state.arousal).toBeGreaterThanOrEqual(0);
      expect(state.arousal).toBeLessThanOrEqual(1);
      expect(state.confidence).toBeGreaterThanOrEqual(0);
      expect(state.confidence).toBeLessThanOrEqual(1);
      expect(state.engagement).toBeGreaterThanOrEqual(0);
      expect(state.engagement).toBeLessThanOrEqual(1);
      expect(state.patience).toBeGreaterThanOrEqual(0);
      expect(state.patience).toBeLessThanOrEqual(1);
    });
  });

  describe('getLabel', () => {
    it('should return a valid emotion label after initialization', () => {
      const label = engine.getLabel();
      const validLabels = [
        'neutral', 'enthusiastic', 'playful', 'amused', 'satisfied',
        'curious', 'focused', 'frustrated', 'impatient', 'concerned', 'skeptical',
      ];
      expect(validLabels).toContain(label);
    });

    it('should return "impatient" when patience is very low', () => {
      engine.setState({
        valence: 0, arousal: 0.5, confidence: 0.5, engagement: 0.5, patience: 0.1,
      });
      expect(engine.getLabel()).toBe('impatient');
    });

    it('should return "frustrated" when valence is very negative and patience is low', () => {
      engine.setState({
        valence: -0.5, arousal: 0.5, confidence: 0.5, engagement: 0.5, patience: 0.3,
      });
      expect(engine.getLabel()).toBe('frustrated');
    });

    it('should return "enthusiastic" when valence and arousal are high', () => {
      engine.setState({
        valence: 0.6, arousal: 0.6, confidence: 0.5, engagement: 0.5, patience: 0.5,
      });
      expect(engine.getLabel()).toBe('enthusiastic');
    });

    it('should return "curious" when engagement and arousal are elevated', () => {
      engine.setState({
        valence: 0.1, arousal: 0.4, confidence: 0.5, engagement: 0.7, patience: 0.5,
      });
      expect(engine.getLabel()).toBe('curious');
    });

    it('should return "focused" when engagement is high and arousal is low', () => {
      engine.setState({
        valence: 0.1, arousal: 0.2, confidence: 0.5, engagement: 0.7, patience: 0.5,
      });
      expect(engine.getLabel()).toBe('focused');
    });

    it('should return "concerned" when valence is negative and confidence is low', () => {
      engine.setState({
        valence: -0.3, arousal: 0.3, confidence: 0.3, engagement: 0.3, patience: 0.5,
      });
      expect(engine.getLabel()).toBe('concerned');
    });
  });

  describe('update', () => {
    it('should shift valence positively on userGreeting', () => {
      const before = engine.getState().valence;
      engine.update(EVENT_FORCES.userGreeting!);
      const after = engine.getState().valence;
      expect(after).toBeGreaterThan(before);
    });

    it('should shift valence positively on taskSuccess', () => {
      const before = engine.getState().valence;
      engine.update(EVENT_FORCES.taskSuccess!);
      const after = engine.getState().valence;
      expect(after).toBeGreaterThan(before);
    });

    it('should shift valence negatively on taskFailure', () => {
      const before = engine.getState().valence;
      engine.update(EVENT_FORCES.taskFailure!);
      const after = engine.getState().valence;
      expect(after).toBeLessThan(before);
    });

    it('should increase engagement on interestingTask', () => {
      const before = engine.getState().engagement;
      engine.update(EVENT_FORCES.interestingTask!);
      const after = engine.getState().engagement;
      expect(after).toBeGreaterThan(before);
    });

    it('should decrease confidence on userCorrection', () => {
      const before = engine.getState().confidence;
      engine.update(EVENT_FORCES.userCorrection!);
      const after = engine.getState().confidence;
      expect(after).toBeLessThan(before);
    });

    it('should keep all values clamped after extreme forces', () => {
      // Apply huge positive force many times
      for (let i = 0; i < 50; i++) {
        engine.update({ valence: 1, arousal: 1, confidence: 1, engagement: 1, patience: 1 });
      }
      const state = engine.getState();
      expect(state.valence).toBeLessThanOrEqual(1);
      expect(state.arousal).toBeLessThanOrEqual(1);
      expect(state.confidence).toBeLessThanOrEqual(1);
      expect(state.engagement).toBeLessThanOrEqual(1);
      expect(state.patience).toBeLessThanOrEqual(1);
    });

    it('should keep values clamped after extreme negative forces', () => {
      for (let i = 0; i < 50; i++) {
        engine.update({ valence: -1, arousal: -1, confidence: -1, engagement: -1, patience: -1 });
      }
      const state = engine.getState();
      expect(state.valence).toBeGreaterThanOrEqual(-1);
      expect(state.arousal).toBeGreaterThanOrEqual(0);
      expect(state.confidence).toBeGreaterThanOrEqual(0);
    });
  });

  describe('decay', () => {
    it('should gradually move state toward baseline', () => {
      // Push state far from baseline
      engine.setState({
        valence: 0.9, arousal: 0.9, confidence: 0.9, engagement: 0.9, patience: 0.9,
      });

      const before = engine.getState();
      // Decay many times
      for (let i = 0; i < 20; i++) {
        engine.decay();
      }
      const after = engine.getState();

      // State should have moved toward baseline (which is moderate, not extreme)
      // At least one dimension should have decreased from 0.9
      const decreased = (
        after.valence < before.valence ||
        after.arousal < before.arousal ||
        after.confidence < before.confidence ||
        after.engagement < before.engagement
      );
      expect(decreased).toBe(true);
    });
  });

  describe('setState / getState', () => {
    it('should return an immutable copy', () => {
      const state1 = engine.getState();
      state1.valence = 999;
      const state2 = engine.getState();
      expect(state2.valence).not.toBe(999);
    });

    it('should accept a manual state override', () => {
      engine.setState({
        valence: -0.5, arousal: 0.1, confidence: 0.2, engagement: 0.3, patience: 0.4,
      });
      const state = engine.getState();
      expect(state.valence).toBe(-0.5);
      expect(state.arousal).toBe(0.1);
    });
  });

  describe('getCircadianModifier', () => {
    it('should return a partial emotional state', () => {
      const mod = EmotionalEngine.getCircadianModifier();
      expect(typeof mod).toBe('object');
      // Should have at least one key
      expect(Object.keys(mod).length).toBeGreaterThan(0);
    });
  });
});
