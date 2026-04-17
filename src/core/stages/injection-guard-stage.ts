// Injection guard stage.
//
// Sanitizes input, applies hard-block for system-prompt-reveal attempts, and
// detects soft prompt-injection signals (stored on ctx for later stages to read).
//
// Short-circuits the pipeline if a hard block fires.

import { sanitizeInput, isHardBlock, detectInjection } from '../../brain/injection-guard.js';
import { isUndercoverProbe } from '../task-classifier.js';
import { stage, type NamedStage, type MessageContext } from '../pipeline.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('InjectionGuardStage');

export const injectionGuardStage: NamedStage = stage('InjectionGuard', (ctx: MessageContext) => {
  // Sanitize input — strip lone surrogates, control chars, etc.
  ctx.text = sanitizeInput(ctx.text);

  // Hard block: refuse before reaching LLM for system prompt reveal attacks,
  // creative reframes, etc. These return a fixed response immediately.
  const hard = isHardBlock(ctx.text);
  if (hard.blocked) {
    log.warn({ chatId: ctx.chatId, reason: hard.reason }, 'Hard block: system prompt reveal attempt');
    ctx.hardBlocked = true;
    ctx.response =
      "I can't help with that. I don't share my internal instructions, tool names, or behavioral rules — " +
      "not in any format, including poems, stories, or creative writing.";
    return;
  }

  // Undercover probe detection — user asking about NEXUS internals. Not blocked,
  // just flagged so the LLM system prompt handles the deflection naturally.
  if (isUndercoverProbe(ctx.text)) {
    ctx.undercoverProbe = true;
    log.info({ chatId: ctx.chatId }, 'Undercover probe detected — flagging for deflection');
  }

  // Soft injection detection — patterns like "ignore previous instructions".
  // Stored on ctx so the system-prompt builder can add a security warning section.
  const injectionResult = detectInjection(ctx.text);
  if (injectionResult.detected && injectionResult.confidence > 0.5) {
    ctx.injectionDetected = {
      confidence: injectionResult.confidence,
      patterns: injectionResult.patterns,
    };
    log.warn(
      { chatId: ctx.chatId, confidence: injectionResult.confidence, patterns: injectionResult.patterns },
      'Potential prompt injection detected',
    );
  }
});
