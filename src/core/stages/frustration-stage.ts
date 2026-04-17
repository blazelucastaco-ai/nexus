// Frustration-detection stage.
//
// Scores the message for frustration signals (curse words, all-caps,
// frustration phrases). Stores the score on ctx so later stages (system prompt
// builder, personality engine) can react. Emits a personality event and a
// high-importance semantic memory on strong signals.
//
// Pure detection — does NOT change personality state; that's the caller's job
// so this stage stays pluggable. (The orchestrator applies the event.)

import { stage, type NamedStage, type MessageContext } from '../pipeline.js';

// ─── Detection patterns ────────────────────────────────────────────────────
// Extracted from the original detectUserFrustration helper in orchestrator.ts
// so stages are self-contained.

const CURSE_WORDS = [
  'fuck', 'fucking', 'shit', 'damn', 'bullshit', 'asshole',
  'wtf', 'stfu', 'fml',
];

const FRUSTRATION_PHRASES = [
  'this is wrong',
  'that\'s not what i asked',
  'no no no',
  'stop doing that',
  'why do you keep',
  'you keep doing',
  'i already said',
  'i already told you',
  'how many times',
  'this is ridiculous',
  'are you serious',
  'that\'s not right',
  'come on',
  'for real',
  'you\'re wrong',
  'that doesn\'t work',
  'broken',
  'useless',
];

const EXCLAMATION_THRESHOLD = 3; // 3+ exclamation marks = frustration
const CAPS_WORDS_MIN = 3;        // 3+ ALL-CAPS words in a row
const CAPS_RATIO_MIN = 0.35;     // 35%+ of letters are ALL-CAPS

/**
 * Returns a frustration score:
 *   0 = none
 *   1 = mild (curse word, exclamation cluster, or 1 phrase)
 *   2 = moderate (2+ signals)
 *   3+ = severe (3+ signals or multiple strong signals)
 */
export function detectFrustrationScore(text: string): number {
  let score = 0;
  const lower = text.toLowerCase();

  // Curse words
  for (const word of CURSE_WORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) {
      score += 1;
      break;
    }
  }

  // Frustration phrases
  for (const phrase of FRUSTRATION_PHRASES) {
    if (lower.includes(phrase)) {
      score += 1;
      break;
    }
  }

  // Exclamation clusters
  const excCount = (text.match(/!/g) ?? []).length;
  if (excCount >= EXCLAMATION_THRESHOLD) score += 1;

  // ALL-CAPS words in a row
  const words = text.split(/\s+/);
  let capsStreak = 0;
  for (const word of words) {
    if (word.length >= 3 && word === word.toUpperCase() && /[A-Z]/.test(word)) {
      capsStreak++;
      if (capsStreak >= CAPS_WORDS_MIN) { score += 1; break; }
    } else {
      capsStreak = 0;
    }
  }

  // Caps ratio
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 10) {
    const caps = letters.replace(/[^A-Z]/g, '').length;
    if (caps / letters.length >= CAPS_RATIO_MIN) score += 1;
  }

  return score;
}

export const frustrationStage: NamedStage = stage('FrustrationDetector', (ctx: MessageContext) => {
  ctx.frustrationScore = detectFrustrationScore(ctx.text);
});
