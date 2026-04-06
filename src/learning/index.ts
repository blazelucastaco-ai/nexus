// Nexus AI — Unified learning system

import type { MemoryCortex } from '../memory/cortex.js';
import { createLogger } from '../utils/logger.js';
import { PreferenceLearner } from './preferences.js';
import { MistakeTracker } from './mistakes.js';
import { PatternRecognizer } from './patterns.js';
import { FeedbackProcessor } from './feedback.js';

const log = createLogger('LearningSystem');

export class LearningSystem {
  public readonly preferences: PreferenceLearner;
  public readonly mistakes: MistakeTracker;
  public readonly patterns: PatternRecognizer;
  public readonly feedback: FeedbackProcessor;

  constructor(cortex: MemoryCortex) {
    this.preferences = new PreferenceLearner(cortex);
    this.mistakes = new MistakeTracker(cortex);
    this.patterns = new PatternRecognizer();
    this.feedback = new FeedbackProcessor(cortex, this.preferences);
    log.info('LearningSystem initialized with all subsystems');
  }
}

export { PreferenceLearner } from './preferences.js';
export { MistakeTracker } from './mistakes.js';
export { PatternRecognizer } from './patterns.js';
export { FeedbackProcessor } from './feedback.js';
