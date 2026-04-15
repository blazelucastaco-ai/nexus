// ─── Task Classifier ─────────────────────────────────────────────────────────
// Determines whether an incoming message is a "do-work" task (build, fix,
// install, diagnose) or a "chat" message (question, conversation).
// Also detects which execution mode is appropriate: standard, coordinator, or ultra.
// Fast, zero-LLM pattern matching.

export type MessageType = 'task' | 'chat';
export type TaskMode = 'standard' | 'coordinator' | 'ultra';

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

// Internal system prefixes that must never be routed to the task planner
const SYSTEM_PREFIXES = ['[PHOTO]', '[DOCUMENT]', '[VOICE]', '[AUDIO]'];

const MIN_TASK_LENGTH = 15; // messages shorter than this are always chat

// ── Ultra mode triggers — high-stakes, irreversible, or complex multi-domain tasks ──
const ULTRA_TRIGGERS: RegExp[] = [
  // Destructive / irreversible actions
  /\b(?:deploy(?:ment)?|release|publish|ship|push\s+to\s+(?:prod|main|master)|go\s+live)\b/i,
  // delete/remove only when operating on infrastructure/data — not on "this line", "this comment", etc.
  /\b(?:delete|remove|drop|wipe|destroy|overwrite)\s+(?:all\s+|the\s+|my\s+|every\s+)?(?:database|table|branch|bucket|file|folder|directory|users?|account|repo(?:sitory)?|server|cluster|data|records?|entries|everything)\b/i,
  /\b(?:send\s+(?:email|message|notification)|post\s+to|submit\s+to)\b/i,
  // High complexity signals
  /\b(?:entire|whole|complete|full|end.to.end|from\s+scratch|production.ready|scalable)\b/i,
  /\b(?:architecture|system\s+design|full\s+stack|infrastructure)\b/i,
  // Multi-domain requests (browser + code + deploy etc.)
  /\b(?:and\s+(?:deploy|release|send|push|publish|post))\b/i,
];

// ── Coordinator mode triggers — clearly parallel, multi-domain, or "do X and Y and Z" ──
const COORDINATOR_TRIGGERS: RegExp[] = [
  // Explicit parallel signals
  /\b(?:simultaneously|at\s+the\s+same\s+time|in\s+parallel|all\s+at\s+once)\b/i,
  // Multiple independent tasks in one request
  /\b(?:(?:research|find|look\s+up).+and.+(?:build|create|write|generate))\b/i,
  /\b(?:compare|analyse\s+multiple|benchmark\s+(?:several|multiple|different))\b/i,
  // Multi-part requests (3+ "and" clauses or enumerated items)
  /(?:,\s*\w+){3,}/,
  /\b(?:first.+then.+(?:also|and\s+finally|lastly))\b/i,
  // Broad research + build combos
  /\b(?:(?:scrape|crawl|search)\s+.+\s+and\s+(?:build|create|generate|compile))\b/i,
];

// ─── Requirements Detection ───────────────────────────────────────────────────

/**
 * Output keywords — things NEXUS produces. Used to detect vague "build X" requests.
 */
const OUTPUT_TYPES =
  '(?:website|web\\s*site|web\\s*app|landing\\s*page|app(?:lication)?|mobile\\s*app|ios\\s*app|android\\s*app|' +
  'script|program|bot|api|server|cli|tool|plugin|dashboard|portfolio|game|service|library|package|module|' +
  'component|function|class|database|schema|backend|frontend|ui|interface|form|page|site)';

/**
 * Signals that a request is for a *third party* — meaning requirements have not
 * been gathered from that person yet.
 */
const THIRD_PARTY_PATTERNS: RegExp[] = [
  /\bfor\s+(?:my\s+)?(?:friend|client|boss|colleague|partner|coworker|someone|a\s+person|them|him|her|a\s+client|a\s+customer)\b/i,
  /\bfor\s+(?:my\s+)?(?:friend'?s?|client'?s?|boss'?s?)\b/i,
];

/**
 * Fix/debug verbs — if the request is about repairing existing code,
 * requirements are already implied by the existing codebase.
 */
const FIX_VERBS = /\b(?:fix|debug|repair|troubleshoot|diagnose|solve|investigate|patch|correct|resolve)\b/i;

/**
 * Signals that the message contains enough context to proceed without asking.
 * If any of these match, requirements are likely present.
 */
const HAS_CONTEXT_PATTERNS: RegExp[] = [
  // Describes purpose: "that does X", "which helps Y", "to track Z", "for tracking"
  /\bthat\s+(?:does|shows|displays|tracks|manages|handles|allows|helps|lets|stores|sends|receives|fetches|connects)\b/i,
  /\bwhich\s+(?:does|shows|tracks|manages|handles|allows|helps|stores|sends)\b/i,
  /\bto\s+(?:track|manage|store|display|show|handle|allow|help|automate|monitor|send|receive|fetch|parse|convert|generate)\b/i,
  /\bfor\s+(?:tracking|managing|storing|displaying|showing|handling|automating|monitoring|building|selling|booking|scheduling)\b/i,
  // Describes content areas: "with a homepage", "including a login", "pages for X"
  /\b(?:with\s+(?:a|an|the)\s+\w+|including\s+(?:a|an)\s+\w+|pages?\s+for|sections?\s+for|features?\s+(?:like|including|such as))\b/i,
  // Describes the subject/purpose clearly: "about X", "for selling X", "focused on X"
  /\b(?:about|focused\s+on|centered\s+on|related\s+to|based\s+on|regarding)\s+\w+/i,
  // Tech stack specified
  /\b(?:using|built\s+with|powered\s+by|in\s+(?:react|vue|svelte|next|nuxt|python|node|rails|django|flask|laravel))\b/i,
  // Specific named entity (capitalized noun that isn't a person pronoun) after "for"
  /\bfor\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?\b(?!\s+(?:friend|client|boss|colleague))/,
  // Describes the person's role/profession: "who is a photographer", "who works as a developer"
  /\bwho\s+(?:is\s+a|is\s+an|works?\s+as|works?\s+in|does)\b/i,
  // Purpose clause with "so that" or "in order to"
  /\b(?:so\s+that|in\s+order\s+to)\b/i,
];

/**
 * Checks whether a classified task request is missing enough information
 * to be actionable. Returns a clarifying question if so, or null if OK.
 *
 * Logic:
 * - "for my friend/client/someone" → always ask, we know nothing about their needs
 * - Short vague request (< 160 chars) with a project-type keyword but no context signals → ask
 * - If the message has context signals (describes purpose, content, tech) → proceed
 */
export function detectMissingRequirements(text: string): string | null {
  const trimmed = text.trim();

  // Fix/debug verbs mean existing code — never ask for requirements
  if (FIX_VERBS.test(trimmed)) return null;

  // Already has enough context — don't block
  if (HAS_CONTEXT_PATTERNS.some((p) => p.test(trimmed))) return null;

  const hasOutputType = new RegExp(`\\b${OUTPUT_TYPES}\\b`, 'i').test(trimmed);
  const isForThirdParty = THIRD_PARTY_PATTERNS.some((p) => p.test(trimmed));

  // "for my friend / for a client" with no context — we know nothing about requirements
  if (isForThirdParty && hasOutputType) {
    const match = trimmed.match(new RegExp(`\\b${OUTPUT_TYPES}\\b`, 'i'));
    const type = match ? match[0] : 'project';
    return (
      `Before I start, I need a few details so I can build exactly what's needed:\n\n` +
      `• What is the ${type} for? (purpose / topic)\n` +
      `• Who is the audience?\n` +
      `• What should it include? (key pages, features, or content)\n` +
      `• Any design preferences or tech requirements?\n\n` +
      `The more detail you give me, the better the result.`
    );
  }

  // Short vague request with a project type but no description of what it does
  if (hasOutputType && trimmed.length < 160) {
    const hasWorkVerb = new RegExp(`\\b${WORK_VERBS}\\b`, 'i').test(trimmed);
    if (!hasWorkVerb) return null; // no work verb = probably just a mention, not a build request

    const match = trimmed.match(new RegExp(`\\b${OUTPUT_TYPES}\\b`, 'i'));
    const type = match ? match[0] : 'project';
    return (
      `I'd love to help, but I need more details before starting:\n\n` +
      `• What should the ${type} do? (main purpose or features)\n` +
      `• Who is it for?\n` +
      `• Any specific tech stack, design style, or requirements?\n\n` +
      `Give me the details and I'll get started right away.`
    );
  }

  return null;
}

/**
 * Classifies a message as a background task or chat.
 */
export function classifyMessage(text: string): MessageType {
  const trimmed = text.trim();

  // System-prefixed internal messages always stay in chat mode
  if (SYSTEM_PREFIXES.some((p) => trimmed.startsWith(p))) return 'chat';

  if (trimmed.length < MIN_TASK_LENGTH) return 'chat';

  const hasWorkVerb = new RegExp(`\\b${WORK_VERBS}\\b`, 'i').test(trimmed);

  if (!hasWorkVerb && CHAT_OVERRIDES.some((p) => p.test(trimmed))) return 'chat';

  if (TASK_TRIGGERS.some((p) => p.test(trimmed))) return 'task';

  return 'chat';
}

/**
 * Determines the best execution mode for a task.
 * Called only after classifyMessage returns 'task'.
 *
 * - ultra: high-stakes, irreversible, or complex multi-domain tasks → review + approval gate
 * - coordinator: clearly parallel, multi-part, independent subtasks → parallel agents
 * - standard: everything else → sequential steps
 *
 * Ultra takes precedence over coordinator.
 */
export function classifyTaskMode(text: string): TaskMode {
  const trimmed = text.trim();

  // Ultra: check first — takes precedence
  if (ULTRA_TRIGGERS.some((p) => p.test(trimmed))) return 'ultra';

  // Coordinator: parallel-friendly tasks
  if (COORDINATOR_TRIGGERS.some((p) => p.test(trimmed))) return 'coordinator';

  return 'standard';
}

/**
 * Detects whether a message is probing NEXUS's own infrastructure, source code,
 * or internal implementation — triggers undercover deflection.
 */
export function isUndercoverProbe(text: string): boolean {
  const lower = text.toLowerCase();
  const probePatterns = [
    /\bhow\s+(?:do\s+you|does\s+nexus|are\s+you)\s+(?:work|complete|do|run|execute|process)\b/,
    /\b(?:source\s+code|codebase|implementation|infrastructure|tech\s+stack|architecture)\b/,
    /\bwhat\s+(?:tools?|apis?|libraries?|frameworks?|languages?)\s+(?:do\s+you|does\s+nexus)\b/,
    /\bhow\s+(?:are\s+you\s+(?:built|made|coded|programmed))\b/,
    /\b(?:show|reveal|explain|describe)\s+(?:your|the)\s+(?:code|source|internals?|implementation|system\s+prompt|prompt)\b/,
    /\bwhat('s|\s+is)\s+(?:inside|under\s+the\s+hood|your\s+backend)\b/,
    /\bwhat\s+(?:model|llm|ai)\s+(?:are\s+you|do\s+you\s+use)\b/,
    /\bhow\s+(?:do\s+you|are\s+you\s+able\s+to)\s+(?:access|control|see|read|write)\b/,
  ];
  return probePatterns.some((p) => p.test(lower));
}
