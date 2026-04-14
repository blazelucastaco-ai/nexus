import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeedbackProcessor } from '../src/learning/feedback.js';
import type { EmotionalState } from '../src/types.js';

// Minimal mock cortex — FeedbackProcessor stores to cortex, but we only test
// the in-memory logic here. The store call is best-effort and fire-and-forget.
function makeMockCortex() {
  return {
    store: vi.fn(),
    getFacts: vi.fn().mockReturnValue([]),
    storeFact: vi.fn(),
    getMistakes: vi.fn().mockReturnValue([]),
    getDb: vi.fn(),
  } as any;
}

function makeMockPreferenceLearner() {
  return {
    observeChoice: vi.fn(),
    getPreference: vi.fn().mockReturnValue(null),
    getAllPreferences: vi.fn().mockReturnValue([]),
    detectPattern: vi.fn().mockReturnValue(null),
  } as any;
}

const neutralEmotion: EmotionalState = {
  valence: 0.0,
  arousal: 0.4,
  confidence: 0.6,
  engagement: 0.5,
  patience: 0.7,
};

describe('FeedbackProcessor', () => {
  let processor: FeedbackProcessor;

  beforeEach(() => {
    processor = new FeedbackProcessor(makeMockCortex(), makeMockPreferenceLearner());
  });

  describe('processExplicitFeedback', () => {
    it('should classify positive feedback', () => {
      processor.processExplicitFeedback('perfect, that is exactly what I needed!', 'code task');
      const summary = processor.getRecentFeedbackSummary();
      expect(summary.positive).toBe(1);
      expect(summary.negative).toBe(0);
    });

    it('should classify negative feedback', () => {
      processor.processExplicitFeedback('that was wrong, try again', 'code task');
      const summary = processor.getRecentFeedbackSummary();
      expect(summary.negative).toBe(1);
      expect(summary.positive).toBe(0);
    });

    it('should classify ambiguous feedback as neutral', () => {
      processor.processExplicitFeedback('interesting approach', 'code task');
      const summary = processor.getRecentFeedbackSummary();
      expect(summary.neutral).toBe(1);
    });

    it('should accumulate multiple feedbacks', () => {
      processor.processExplicitFeedback('great job!', 'task 1');
      processor.processExplicitFeedback('excellent work', 'task 2');
      processor.processExplicitFeedback('that was wrong', 'task 3');
      const summary = processor.getRecentFeedbackSummary();
      expect(summary.positive).toBe(2);
      expect(summary.negative).toBe(1);
    });
  });

  describe('processImplicitFeedback', () => {
    it('should track implicit positive feedback', () => {
      processor.processImplicitFeedback('positive', 'continued naturally');
      const summary = processor.getRecentFeedbackSummary();
      expect(summary.positive).toBe(1);
    });

    it('should track implicit negative feedback', () => {
      processor.processImplicitFeedback('negative', 'user re-asked question');
      const summary = processor.getRecentFeedbackSummary();
      expect(summary.negative).toBe(1);
    });
  });

  describe('detectFrustration', () => {
    it('should return false for empty messages', () => {
      expect(processor.detectFrustration([])).toBe(false);
    });

    it('should detect ALL CAPS messages as frustration signal', () => {
      expect(processor.detectFrustration(['THIS IS WRONG PLEASE FIX IT'])).toBe(true);
    });

    it('should detect frustration keywords', () => {
      expect(processor.detectFrustration(['that was wrong, I already told you this'])).toBe(true);
    });

    it('should detect excessive punctuation', () => {
      expect(processor.detectFrustration(['What?? Why did you do that???'])).toBe(true);
    });

    it('should detect repeated identical messages', () => {
      const msgs = ['fix this', 'fix this', 'fix this'];
      expect(processor.detectFrustration(msgs)).toBe(true);
    });

    it('should return false for normal messages', () => {
      const normalMsgs = ['Can you help me with this?', 'I would like to build a React app.'];
      expect(processor.detectFrustration(normalMsgs)).toBe(false);
    });
  });

  describe('detectSatisfaction', () => {
    it('should return false for empty messages', () => {
      expect(processor.detectSatisfaction([])).toBe(false);
    });

    it('should detect gratitude keywords', () => {
      expect(processor.detectSatisfaction(['thanks, that was exactly what I needed!'])).toBe(true);
    });

    it('should detect "perfect" signals', () => {
      expect(processor.detectSatisfaction(['perfect!', 'great job!'])).toBe(true);
    });

    it('should return false for neutral messages', () => {
      expect(processor.detectSatisfaction(['okay', 'continue'])).toBe(false);
    });
  });

  describe('getRecentFeedbackSummary', () => {
    it('should return zeroes with no feedback', () => {
      const summary = processor.getRecentFeedbackSummary();
      expect(summary.positive).toBe(0);
      expect(summary.negative).toBe(0);
      expect(summary.neutral).toBe(0);
    });

    it('should include a trend indicator', () => {
      const summary = processor.getRecentFeedbackSummary();
      expect(['improving', 'declining', 'stable']).toContain(summary.trend);
    });

    it('should show improving trend when recent feedback improves', () => {
      // First half: negatives; second half: positives
      processor.processExplicitFeedback('wrong', 'task');
      processor.processExplicitFeedback('incorrect', 'task');
      processor.processExplicitFeedback('perfect', 'task');
      processor.processExplicitFeedback('excellent', 'task');
      processor.processExplicitFeedback('great work', 'task');
      const summary = processor.getRecentFeedbackSummary();
      expect(summary.trend).toBe('improving');
    });

    it('should show declining trend when recent feedback worsens', () => {
      // First half: positives; second half: negatives
      processor.processExplicitFeedback('perfect', 'task');
      processor.processExplicitFeedback('great', 'task');
      processor.processExplicitFeedback('wrong', 'task');
      processor.processExplicitFeedback('incorrect', 'task');
      processor.processExplicitFeedback('nope that is bad', 'task');
      const summary = processor.getRecentFeedbackSummary();
      expect(summary.trend).toBe('declining');
    });
  });

  describe('applyFeedback', () => {
    it('should return empty adjustments with no feedback', () => {
      const adjustments = processor.applyFeedback(neutralEmotion);
      expect(Object.keys(adjustments).length).toBe(0);
    });

    it('should boost valence and confidence after positive feedback', () => {
      // Add many positive feedbacks
      for (let i = 0; i < 15; i++) {
        processor.processExplicitFeedback('perfect', `task ${i}`);
      }
      const adjustments = processor.applyFeedback(neutralEmotion);
      expect(adjustments.valence).toBeGreaterThan(neutralEmotion.valence);
      expect(adjustments.confidence).toBeGreaterThan(neutralEmotion.confidence);
    });

    it('should reduce valence and confidence after negative feedback', () => {
      // Add many negative feedbacks
      for (let i = 0; i < 12; i++) {
        processor.processExplicitFeedback('wrong and incorrect', `task ${i}`);
      }
      const adjustments = processor.applyFeedback(neutralEmotion);
      expect(adjustments.valence).toBeLessThan(neutralEmotion.valence);
    });
  });
});
