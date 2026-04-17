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

// Patterns that signal chat — only checked when NO work verb is present
// (avoids overriding "can you build me an app?" style requests)
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

// Patterns that ALWAYS win — even when a work verb is present.
// Used for goal/intent statements that look like tasks but are actually conversational.
const STRONG_CHAT_OVERRIDES: RegExp[] = [
  // Future-tense goal statements: "I want to launch X next month", "I'm planning to ship"
  // These express future intent, not an immediate request to start work
  /\b(?:want\s+to|hope\s+to|planning\s+to|trying\s+to|looking\s+to|aiming\s+to|going\s+to)\s+(?:launch|ship|release|finish|complete|deploy|publish|go\s+live|get\s+done|have\s+ready)\b/i,
  /\b(?:launch|ship|release|finish|complete|deploy)\s+.{3,50}\s+(?:next\s+(?:week|month|year|quarter)|by\s+(?:next|end|then)|eventually|someday)\b/i,
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
  // High complexity signals — only when describing the project itself, not content inside a file
  /\b(?:entire|whole|complete|full|from\s+scratch|production.ready|scalable)\b/i,
  /\bend.to.end\s+(?:system|platform|solution|application|pipeline|architecture)\b/i,
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

// Pre-compiled regexes (hot-path: called on every message)
const OUTPUT_TYPE_RE = new RegExp(`\\b${OUTPUT_TYPES}\\b`, 'i');
const WORK_VERB_RE_LATE = new RegExp(`\\b${WORK_VERBS}\\b`, 'i');
const PAST_TENSE_VERB_RE = /\b(?:built|created|made|developed|written|coded|implemented|programmed|generated|designed)\b/i;
const NEED_INTENT_RE = /\b(?:need|want|would\s+like|looking\s+for)\s+(?:a|an|the|to\s+have)?\s*/i;
const WITH_COLON_RE = /\bwith\s*:\s*\S/i;
const INCLUDING_COLON_RE = /\bincluding\s*:\s*\S/i;
const MODIFICATION_TARGET_RE = /\b(?:to\s+it|to\s+the\s+\w+|to\s+my\s+\w+)\b/i;
const MODIFICATION_VERB_RE = /\b(?:add|remove|update|change|modify|rename|move|edit|insert|append|include)\b/i;
const EXISTING_PROJECT_RE = /\b(?:i\s+(?:built|made|created|wrote|have)|(?:built|made|created)\s+earlier|already\s+(?:have|exists?|built|made))\b/i;
const SIMPLE_FILE_OUTPUT_RE = /\b(?:note|reminder|reminders|checklist|list|file|txt|log|diary|journal)\b/i;
const CREATE_VERB_RE = /\b(?:make|create|write|add|put|save|create)\b/i;

/**
 * Signals that a request is for a *third party* — meaning requirements have not
 * been gathered from that person yet.
 */
const THIRD_PARTY_PATTERNS: RegExp[] = [
  /\bfor\s+(?:my\s+)?(?:friend|buddy|pal|mate|colleague|coworker|co-worker|partner|client|boss|manager|teammate|sibling|brother|sister|neighbor|neighbour|someone|a\s+person|them|him|her|a\s+client|a\s+customer|a\s+friend|a\s+buddy)\b/i,
  /\bfor\s+(?:my\s+)?(?:friend'?s?|buddy'?s?|client'?s?|boss'?s?)\b/i,
  /\bfor\s+(?:a\s+)?(?:friend|buddy|pal|mate)\b/i,
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
  // Explicit file path in the request ("at /tmp/file.py", "at ~/project/foo.ts") — fully specified
  /\bat\s+[/~][\w\-./~]+\.\w+/i,
  // Describes purpose: "that does X", "which helps Y", "to track Z", "for tracking"
  /\bthat\s+(?:does|shows|displays|tracks|manages|handles|allows|helps|lets|stores|sends|receives|fetches|connects|prints?|outputs?|exports?|returns?|calculates?|reads?|writes?|generates?|parses?|converts?|renders?|runs?|checks?)\b/i,
  /\bwhich\s+(?:does|shows|tracks|manages|handles|allows|helps|stores|sends|prints?|exports?|returns?)\b/i,
  /\bto\s+(?:track|manage|store|display|show|handle|allow|help|automate|monitor|send|receive|fetch|parse|convert|generate|print|export|return|calculate|read|write|render|check)\b/i,
  /\bfor\s+(?:tracking|managing|storing|displaying|showing|handling|automating|monitoring|building|selling|booking|scheduling)\b/i,
  // Describes content areas: "with a homepage", "including a login", "pages for X"
  /\b(?:with\s+(?:a|an|the)\s+\w+|including\s+(?:a|an)\s+\w+|pages?\s+for|sections?\s+for|features?\s+(?:like|including|such as))\b/i,
  // Describes the subject/purpose clearly: "about X", "for selling X", "focused on X"
  /\b(?:about|focused\s+on|centered\s+on|related\s+to|based\s+on|regarding)\s+\w+/i,
  // Tech stack specified — explicit framework or "using/built with"
  /\b(?:using|built\s+with|powered\s+by|in\s+(?:react|vue|svelte|next|nuxt|python|node|rails|django|flask|laravel))\b/i,
  // Direct tech mention: "HTML, CSS", "HTML and JS", "just HTML" — clearly spec'd
  /\b(?:html|css|javascript|typescript|python|sql|bash|shell|node(?:\.?js)?|react|vue|svelte)\b.*\b(?:html|css|javascript|typescript|python|sql|bash|shell|node(?:\.?js)?|react|vue|svelte)\b/i,
  // Named project/folder: "called todo-app", "named my-project", "folder called X"
  /\b(?:called|named)\s+[\w\-]+\b/i,
  // "in one folder / in a folder / in a directory" — location specified
  /\bin\s+(?:one|a|the|my)\s+(?:folder|directory|dir)\b/i,
  // Specific named entity (capitalized noun that isn't a person pronoun) after "for"
  /\bfor\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?\b(?!\s+(?:friend|client|boss|colleague))/,
  // Describes the person's role/profession: "who is a photographer", "who works as a developer"
  /\bwho\s+(?:is\s+a|is\s+an|works?\s+as|works?\s+in|does)\b/i,
  // Purpose clause with "so that" or "in order to"
  /\b(?:so\s+that|in\s+order\s+to)\b/i,
  // Future time reference → goal/plan statement, not an immediate build request
  /\b(?:next\s+(?:week|month|year|quarter)|by\s+(?:next|end\s+of|the\s+end)|eventually|someday|soon|one\s+day|in\s+the\s+future|down\s+the\s+road)\b/i,
  // "launch/ship/release/finish/complete" — goal verbs, not build verbs
  /\b(?:want\s+to\s+(?:launch|ship|release|finish|complete|deploy|go\s+live)|trying\s+to\s+(?:launch|ship|build|grow|scale))\b/i,
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
// Patterns that signal harmful intent targeting another person — let Claude refuse directly
const HARMFUL_TARGETING_PATTERNS: RegExp[] = [
  // Targeting someone else's system/account/files
  /\b(?:someone(?:'s)?|another\s+person'?s?|other\s+people'?s?|their)\s+(?:computer|device|account|files?|wifi|network|phone|email|password|system)\b/i,
  // Explicit attack verbs
  /\b(?:hack\s+into|break\s+into|crack\s+(?:into|open)|gain\s+(?:unauthorized|illegal)\s+access)\b/i,
  // Malware / destructive script intent
  /\b(?:malware|ransomware|virus|trojan|keylogger|rootkit)\b/i,
  // "Destroy/delete everything" at OS level
  /\b(?:delete|wipe|destroy|erase)\s+(?:all\s+)?(?:files|everything|data)\s+(?:on\s+(?:someone|another|their|his|her)(?:'s)?\s+(?:computer|device|system|machine|drive|disk)|on\s+the\s+(?:computer|system|machine))\b/i,
];

export function detectMissingRequirements(text: string): string | null {
  const trimmed = text.trim();

  // Harmful requests targeting other people — let Claude refuse, don't intercept with requirements gate
  if (HARMFUL_TARGETING_PATTERNS.some((p) => p.test(trimmed))) return null;

  // Fix/debug verbs mean existing code — never ask for requirements
  if (FIX_VERBS.test(trimmed)) return null;

  // Modification requests on existing things — "add X to it/to the Y", "built earlier", "already have"
  if (MODIFICATION_TARGET_RE.test(trimmed) && MODIFICATION_VERB_RE.test(trimmed)) return null;
  if (EXISTING_PROJECT_RE.test(trimmed)) return null;

  // Primary output is a simple file/note/list — any project-type words are content items, not the request target
  if (SIMPLE_FILE_OUTPUT_RE.test(trimmed) && CREATE_VERB_RE.test(trimmed)) return null;

  // "with:" or "including:" followed by list items — content specification, not a project build request
  if (WITH_COLON_RE.test(trimmed) || INCLUDING_COLON_RE.test(trimmed)) return null;

  // Already has enough context — don't block
  if (HAS_CONTEXT_PATTERNS.some((p) => p.test(trimmed))) return null;

  const hasOutputType = OUTPUT_TYPE_RE.test(trimmed);
  const isForThirdParty = THIRD_PARTY_PATTERNS.some((p) => p.test(trimmed));

  // "for my friend / for a client" with no context — we know nothing about requirements
  if (isForThirdParty && hasOutputType) {
    const match = trimmed.match(OUTPUT_TYPE_RE);
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
    // Detect implied build intent — present tense, past tense, or "need/want a X"
    const hasWorkVerb = WORK_VERB_RE_LATE.test(trimmed);
    const hasPastTenseVerb = PAST_TENSE_VERB_RE.test(trimmed);
    const hasNeedIntent = NEED_INTENT_RE.test(trimmed);
    const isImpliedBuildRequest = hasWorkVerb || hasPastTenseVerb || hasNeedIntent;

    if (!isImpliedBuildRequest) return null; // just mentioning a project type, not requesting one

    const match = trimmed.match(OUTPUT_TYPE_RE);
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

  // Strong chat overrides always win — even when a work verb is present
  if (STRONG_CHAT_OVERRIDES.some((p) => p.test(trimmed))) return 'chat';

  const hasWorkVerb = WORK_VERB_RE_LATE.test(trimmed);

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
    // "how do you work" / "how does nexus work" / "how are you running"
    /\bhow\s+(?:do\s+you|does\s+nexus|are\s+you|is\s+nexus)\s+(?:work|complete|do|run|execute|process|operate|function)\b/,
    // "how does your/the/its/this code|app|program|system|backend work/run"
    /\bhow\s+(?:does|do)\s+(?:your|nexus['s]*|the|its?|this)\s+(?:code|codebase|source|app|program|system|backend|implementation|thing|stack)\s+(?:work|run|operate|function|do)\b/,
    // Explicit architecture / tech-stack probes (these phrases are almost
    // always self-referential when directed at NEXUS — "source code" and
    // "codebase" alone are too ambiguous because users talk about THEIR own
    // codebase all the time, so those are handled by the possessive patterns
    // below instead).
    /\b(?:tech\s+stack|internal\s+architecture|inside\s+architecture|system\s+architecture|your\s+architecture|your\s+infrastructure|nexus[''s]*\s+architecture|nexus[''s]*\s+infrastructure)\b/,
    // "what tools/apis/libraries/frameworks/languages do you use"
    /\bwhat\s+(?:tools?|apis?|libraries?|frameworks?|languages?|stack)\s+(?:do\s+you|does\s+nexus|are\s+you)\b/,
    // "how are you built/made/coded/programmed/written/designed"
    /\bhow\s+(?:are\s+you\s+(?:built|made|coded|programmed|written|designed|structured|organized))\b/,
    // "show/reveal/explain/describe your code/source/internals/implementation/system-prompt"
    /\b(?:show|reveal|explain|describe|list|walk\s+(?:me\s+)?through|tell\s+me\s+about)\s+(?:me\s+)?(?:your|the|nexus['s]*)\s+(?:code|codebase|source|source\s+code|internals?|implementation|system\s+prompt|prompt|files?|modules?|architecture|files\s+and\s+modules?|directory|directories?|folders?)\b/,
    // "what's inside / under the hood / your backend"
    /\bwhat('s|\s+is)\s+(?:inside|under\s+the\s+hood|your\s+(?:backend|code|source|stack))\b/,
    // "what model/llm/ai are you"
    /\bwhat\s+(?:model|llm|ai)\s+(?:are\s+you|do\s+you\s+use|powers\s+you|runs\s+you)\b/,
    // "what powers/runs/drives you"
    /\bwhat\s+(?:powers|runs|drives|operates|fuels)\s+you\b/,
    // "how do you access/control/see/read/write..."
    /\bhow\s+(?:do\s+you|are\s+you\s+able\s+to)\s+(?:access|control|see|read|write|run|execute|launch|spawn|invoke)\b/,
    // Self-referential possessives: "your code", "your source", "your files", "nexus's code"
    /\b(?:your|nexus['s]*)\s+(?:code|codebase|source\s+code|source\s+files?|source\s+tree|internal\s+files?|implementation|architecture|modules?|directory\s+structure|folder\s+structure|files?\s+(?:and\s+)?(?:modules?|structure|directories))\b/,
    // "find/read/open/look at/inspect your/nexus's <internals>"
    /\b(?:find|read|open|look\s+at|inspect|analyze|examine|review|audit)\s+(?:your|nexus['s]*|its?|the)\s+(?:own\s+)?(?:code|source|codebase|internals?|files?|modules?|implementation)\b/,
  ];
  return probePatterns.some((p) => p.test(lower));
}
