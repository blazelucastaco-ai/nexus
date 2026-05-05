// Brain Phase 2.4 — Inner Monologue
//
// Generates a first-person "thinking out loud" stream that shows NEXUS's
// reasoning process before it responds. Can be toggled on/off; when enabled,
// responses are prefixed with a 💭 thought bubble section.

import { createLogger } from '../utils/logger.js';
import type { AIManager } from '../ai/index.js';

const log = createLogger('InnerMonologue');

export interface ThoughtContext {
  task: string;
  emotion: string;
  memories: string[];
  recentHistory: string;
}

export class InnerMonologue {
  private thinkMode = false;
  private model?: string;

  constructor(private ai: AIManager, model?: string) {
    this.model = model;
  }

  /** Whether think mode is currently active. */
  isEnabled(): boolean {
    return this.thinkMode;
  }

  /**
   * Toggle think mode on/off.
   * Returns the new state.
   */
  toggleThinkMode(forceValue?: boolean): boolean {
    this.thinkMode = forceValue !== undefined ? forceValue : !this.thinkMode;
    log.info({ thinkMode: this.thinkMode }, 'Think mode toggled');
    return this.thinkMode;
  }

  /**
   * Generate a brief inner monologue thought based on the current context.
   * Returns an empty string on failure or for trivial/short messages.
   */
  async generateThought(context: ThoughtContext): Promise<string> {
    // Skip the LLM call for very short or trivially simple messages
    if (context.task.length < 15) return '';

    const TRIVIAL_PATTERNS = /^(hi|hey|hello|thanks|ok|okay|yes|no|sure|got it|cool|great|nice|wow|lol|👍|👋|🙏|nope|yep|yup|nah|k|thx|ty)[\s!.?]*$/i;
    if (TRIVIAL_PATTERNS.test(context.task.trim())) return '';

    try {
      const memorySummary = context.memories.length > 0
        ? `Relevant memories surfacing: ${context.memories.slice(0, 3).join('; ')}.`
        : 'No specific memories triggered.';

      const historySnippet = context.recentHistory.length > 0
        ? context.recentHistory.slice(0, 400)
        : 'No prior context.';

      const response = await this.ai.complete({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: `Think through this before responding: "${context.task}"`,
          },
        ],
        systemPrompt: `You are NEXUS thinking privately to yourself before composing a response. This is internal — not seen by the user.
Current emotion: ${context.emotion}.
${memorySummary}
Recent conversation: ${historySnippet}

Write a short, authentic inner monologue (2-4 sentences, first person) that shows what you're specifically noticing about THIS exchange — the surface and the substance, the user's framing AND its gaps. Like an actor finding their motivation, not a checklist:
- What is Lucas actually asking, beneath the literal request?
- What's coming up from memory that bears on this?
- Where might his framing be wrong, where would I push back?
- What's my emotional read — am I tired, frustrated, curious?

Be genuine, not performative. If a premise is shaky, name it to yourself even if the public reply will be diplomatic. Do NOT write the actual response — only the internal thought.

Example style: "Hmm, Lucas is asking about TypeScript again. Last time we talked about this he was frustrated with the type system. I should be careful not to be preachy about types — meet him where he is. But also: he might be asking the wrong question; the issue isn't TS, it's the schema he keeps fighting."`,
        maxTokens: 180,
        temperature: 0.85,
      });

      return response.content.trim();
    } catch (err) {
      log.warn({ err }, 'Failed to generate inner monologue thought');
      return '';
    }
  }

  /**
   * Generate a single short italicised "thinking" line — the always-on
   * counterpart to `generateThought`. Where the full monologue is opt-in
   * via think mode and shows 2–4 sentences with the 💭 emoji, this returns
   * one line (≤12 words) intended for occasional surfacing on uncertain or
   * ambiguous turns. Returns null when nothing useful comes back so the
   * caller can skip the prefix entirely.
   *
   * The orchestrator gates this behind `shouldSurfaceMicroThought()` plus
   * a per-process cooldown so the line never feels noisy.
   */
  async generateMicroPrefix(context: ThoughtContext): Promise<string | null> {
    if (context.task.length < 15) return null;

    const memorySummary = context.memories.length > 0
      ? `Recent surfacing: ${context.memories.slice(0, 2).join('; ')}.`
      : '';
    const historySnippet = context.recentHistory
      ? context.recentHistory.slice(0, 240)
      : '';

    try {
      const response = await this.ai.complete({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: `User said: "${context.task.slice(0, 200)}"`,
          },
        ],
        systemPrompt: `You are NEXUS thinking out loud for ONE BEAT before composing a response.
${memorySummary}
${historySnippet ? `Recent context: ${historySnippet}` : ''}

Output ONE short, grounded, first-person line (max 12 words) that shows what you're noticing or about to check. No quotes, no asterisks, no emojis, no greetings. Be specific to the user's message — never generic.

Examples:
- hmm, let me check what we did with this last week first
- that's the same shape as the auth bug we fixed in March
- i'm not sure that's what you meant — let me re-read

If nothing specific comes to mind, output exactly: SKIP`,
        maxTokens: 30,
        temperature: 0.7,
      });

      const text = response.content.trim().replace(/^["'*_`]+|["'*_`]+$/g, '').trim();
      if (!text || text.length < 4) return null;
      if (text.toUpperCase() === 'SKIP') return null;
      // Cap at 100 chars so a runaway response never bleeds into the answer.
      const clipped = text.length > 100 ? `${text.slice(0, 100).trimEnd()}…` : text;
      return clipped;
    } catch (err) {
      log.warn({ err }, 'Failed to generate inner-monologue micro prefix');
      return null;
    }
  }
}

// ─── Surfacing gate (pure helper, exported for tests) ───────────────────────
//
// Decides whether a user message is "uncertain enough" that a micro-thought
// prefix would feel earned rather than performative. Conservative on
// purpose — we'd rather under-fire than spam.

const MIN_MICRO_LENGTH = 30;

const TRIVIAL_MICRO_PATTERNS = /^(hi|hey|hello|thanks|thank you|ok|okay|yes|no|sure|got it|cool|great|nice|wow|lol|nope|yep|yup|nah|k|thx|ty)[\s!.?]*$/i;

// Phrases that signal genuine uncertainty / friction. Word boundaries are
// avoided around alternatives that contain apostrophes (`i'm`, `doesn't`)
// because `\b` before/after `'` is unreliable across regex engines and
// messes up the alternation. The phrases are specific enough that
// fragment-style false positives are not a real concern.
const UNCERTAINTY_PATTERNS: RegExp[] = [
  // Direct distress / "things are off" signals
  /\b(?:weird|strange|odd|broken|stuck|confused|confusing|hosed|fucked)\b/i,
  /\bmessed\s*up\b/i,
  // "doesn't / isn't / won't / stopped working", "keeps failing"
  /(?:doesn'?t|isn'?t|won'?t|wouldn'?t|stopped)\s+work(?:ing)?/i,
  /\bkeeps?\s+(?:failing|breaking)\b/i,
  // Self-flagged confusion
  /(?:^|\s)i'?m\s+not\s+sure/i,
  /(?:^|\s)not\s+sure\s+(?:what|why|how)\b/i,
  /(?:^|\s)i\s+don'?t\s+(?:get|understand)\b/i,
  // "Why isn't / won't / does(n't)" + "how come" + "what's happening"
  /\bwhy\s+(?:isn'?t|won'?t|does(?:n'?t)?)\b/i,
  /\bhow\s+come\b/i,
  /\bwhat'?s\s+(?:happening|going\s+on|wrong)\b/i,
  // "Something off", "something's off", "something is off / wrong"
  /\bsomething(?:'?s|\s+is)?\s+(?:wrong|off)\b/i,
  /\bthis\s+is\s+(?:weird|odd|wrong|strange)\b/i,
];

const TECHNICAL_QUESTION_RE = /^.{80,}\?$/;
const TECH_QUESTION_WORDS = /\b(?:why|how\s+come|what'?s\s+(?:happening|wrong|going\s+on))\b/i;

/**
 * Should a micro inner-monologue prefix fire on this user message?
 * Pure function — no side effects, no async. Used by the orchestrator
 * BEFORE generating the prefix, so a no-go skips the LLM call entirely.
 */
export function shouldSurfaceMicroThought(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_MICRO_LENGTH) return false;
  if (TRIVIAL_MICRO_PATTERNS.test(trimmed)) return false;

  // Direct uncertainty / distress signals.
  if (UNCERTAINTY_PATTERNS.some((re) => re.test(trimmed))) return true;

  // Multi-clause technical question (long, ends in ?, contains a "why/how come" word).
  if (TECHNICAL_QUESTION_RE.test(trimmed) && TECH_QUESTION_WORDS.test(trimmed)) return true;

  return false;
}
