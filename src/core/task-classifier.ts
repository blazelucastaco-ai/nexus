// ─── Task Classifier ─────────────────────────────────────────────────────────
// Determines whether an incoming message is a "do-work" task (build, fix,
// install, diagnose) or a "chat" message (question, conversation).
// Fast, zero-LLM pattern matching.

export type MessageType = 'task' | 'chat';

// Patterns that strongly signal the user wants NEXUS to *do something*
const TASK_TRIGGERS: RegExp[] = [
  // Build / create
  /\b(?:build|create|make|develop|generate|scaffold|set\s*up|setup|initialize|init)\s+(?:me\s+)?(?:a|an|the|my)?\s*\w+/i,
  // Write / code
  /\b(?:write|code|implement|program)\s+(?:me\s+)?(?:a|an|the|my)?\s*\w+/i,
  // Fix / debug / diagnose
  /\b(?:fix|debug|repair|troubleshoot|diagnose|solve|investigate|figure\s+out)\b/i,
  // Install / deploy / configure
  /\b(?:install|deploy|configure|integrate|add\s+to|connect)\b/i,
  // Project types
  /\b(?:website|web\s*site|app(?:lication)?|script|program|bot|api|server|cli|tool|plugin|dashboard|portfolio|game|service|library|package|module)\b/i,
  // Multi-step signal
  /\b(?:and\s+(?:then|also)|then\s+(?:run|test|deploy)|with\s+(?:a|an|the)\s+\w+\s+and)\b/i,
  // Refactor / improve
  /\b(?:refactor|optimize|improve|upgrade|migrate|convert|automate)\b/i,
];

// Patterns that override task detection — these are clearly just chat
const CHAT_OVERRIDES: RegExp[] = [
  /\?$/,                                                        // ends with question mark
  /^(?:hi|hey|hello|yo|sup)\b/i,                              // greeting
  /^(?:yes|no|ok|okay|sure|nope|yep|yup|nah)\b/i,             // one-word answer
  /^(?:thanks|thank you|thx|ty|cheers|nice|good|cool|great|perfect|awesome|wow)\b/i, // acknowledgement
  /^(?:what|how|why|when|where|who|which|can you explain|tell me|what is|what are|what does|what do)\b/i, // info question
  /^(?:do you|are you|is it|can it|will it|should i|would you)\b/i, // yes/no question
];

const MIN_TASK_LENGTH = 20; // messages shorter than this are always chat

/**
 * Classifies a message as a background task (build/fix/install/diagnose)
 * or a conversational chat message.
 */
export function classifyMessage(text: string): MessageType {
  const trimmed = text.trim();

  if (trimmed.length < MIN_TASK_LENGTH) return 'chat';
  if (CHAT_OVERRIDES.some((p) => p.test(trimmed))) return 'chat';
  if (TASK_TRIGGERS.some((p) => p.test(trimmed))) return 'task';

  return 'chat';
}
