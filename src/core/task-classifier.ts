// ─── Task Classifier ─────────────────────────────────────────────────────────
// Determines whether an incoming message is a "do-work" task (build, fix,
// install, diagnose) or a "chat" message (question, conversation).
// Fast, zero-LLM pattern matching.

export type MessageType = 'task' | 'chat';

// Work verbs — used in both trigger and "can you [verb]" patterns
const WORK_VERBS = '(?:build|create|make|develop|generate|scaffold|set\\s*up|setup|initialize|init|write|code|implement|program|fix|debug|repair|troubleshoot|diagnose|solve|investigate|install|deploy|configure|integrate|refactor|optimize|improve|upgrade|migrate|convert|automate|run|execute|launch|start|test|analyse|analyze)';

// Patterns that strongly signal the user wants NEXUS to *do something*
const TASK_TRIGGERS: RegExp[] = [
  // Direct work verb: "build me a...", "create a...", "fix the..."
  new RegExp(`\\b${WORK_VERBS}\\s+(?:me\\s+)?(?:a|an|the|my|this|that)?\\s*\\w+`, 'i'),

  // "can you / could you / please / would you [work verb]..."
  new RegExp(`\\b(?:can you|could you|please|would you)\\s+${WORK_VERBS}\\b`, 'i'),

  // "help me [work verb]..."
  new RegExp(`\\bhelp\\s+me\\s+(?:to\\s+)?${WORK_VERBS}\\b`, 'i'),

  // Project type keywords (strong signal even without explicit verb)
  /\b(?:website|web\s*site|landing\s*page|app(?:lication)?|script|program|bot|api|server|cli|tool|plugin|dashboard|portfolio|game|service|library|package|module)\b/i,

  // Multi-step signal
  /\b(?:and\s+(?:then|also)|then\s+(?:run|test|deploy)|with\s+(?:a|an|the)\s+\w+\s+and)\b/i,
];

// Patterns that strongly signal the user wants to CHAT (not do work)
const CHAT_OVERRIDES: RegExp[] = [
  // Pure greetings
  /^(?:hi|hey|hello|yo|sup|howdy)\b/i,
  // One-word confirmations / reactions
  /^(?:yes|no|ok|okay|sure|nope|yep|yup|nah|thanks|thank you|thx|ty|cheers|nice|good|cool|great|perfect|awesome|wow|lol|haha)\s*[!.]*$/i,
  // Short pure info questions (start with question word, no work verb inside)
  /^(?:what is|what are|what does|what do|who is|when is|where is|why is|why does|how does|how do|what's|who's)\b/i,
  // "are you / is it / do you / will it" — capability/status questions
  /^(?:do you|are you|is it|can it|will it|should i|would you)\b/i,
  // Very short question (under 40 chars) ending in ?
  /^.{1,40}\?$/,
];

const MIN_TASK_LENGTH = 15; // messages shorter than this are always chat

/**
 * Classifies a message as a background task (build/fix/install/diagnose)
 * or a conversational chat message.
 *
 * Order of precedence:
 *   1. Too short → chat
 *   2. Strong chat override → chat
 *   3. Task trigger match → task
 *   4. Default → chat
 */
export function classifyMessage(text: string): MessageType {
  const trimmed = text.trim();

  if (trimmed.length < MIN_TASK_LENGTH) return 'chat';

  // Chat overrides checked first — but only when no work verb is present.
  // This prevents "can you fix my broken Python script?" from being classified
  // as chat just because it ends with a question mark.
  const hasWorkVerb = new RegExp(`\\b${WORK_VERBS}\\b`, 'i').test(trimmed);

  if (!hasWorkVerb && CHAT_OVERRIDES.some((p) => p.test(trimmed))) return 'chat';

  if (TASK_TRIGGERS.some((p) => p.test(trimmed))) return 'task';

  return 'chat';
}
