// ─── Task Classifier ─────────────────────────────────────────────────────────
// Two pattern-matching helpers that survive the 2026-05-07 model-driven
// routing migration:
//
//   1. classifyTaskMode  — safety floor inside the task launcher; escalates
//                          plain start_task → ultra when the request matches
//                          destructive / production-impacting patterns.
//   2. isUndercoverProbe — security gate against prompts that try to extract
//                          NEXUS's own architecture, source, or tooling.
//
// These are the only acceptable use of regex in NEXUS routing per Lucas's
// directive: "extremely smart with executing everything and anything …
// no specific keywords that trigger anything (other than for security
// purposes)." classifyMessage / detectMissingRequirements / TASK_TRIGGERS
// all lived here once. They were dropped when the chat-mode model became
// the sole router via start_task / start_ultra_task tools.

export type TaskMode = 'standard' | 'coordinator' | 'ultra';

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

/**
 * Determines the safety-floor execution mode for a task request.
 *
 * Used by the task launcher to escalate plain start_task → ultra when the
 * request looks destructive / production-impacting, even if the chat-mode
 * model didn't pick start_ultra_task. This is the sole place keyword
 * detection survives in the routing path — a security-grade gate, not a
 * routing decision.
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
    // "find/read/open/look at/inspect your/nexus's <internals>". The possessive
    // is split: `your`/`nexus's` are unambiguously self-referential so `own` is
    // optional, but `its`/`the` are ambiguous in normal use (the user routinely
    // says "open the file" meaning a file we just produced together) — require
    // `own` there. Without this split, "can you open the file?" trips the
    // probe and refuses legitimate workspace access.
    /\b(?:find|read|open|look\s+at|inspect|analyze|examine|review|audit)\s+(?:(?:your|nexus['s]*)\s+(?:own\s+)?|(?:its?|the)\s+own\s+)(?:code|source|codebase|internals?|files?|modules?|implementation)\b/,
  ];
  return probePatterns.some((p) => p.test(lower));
}
