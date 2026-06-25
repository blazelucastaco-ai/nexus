// Skill Extractor — trajectory → draft skill auto-promotion.
//
// Subscribes to `task.completed`. When NEXUS finishes a real, multi-step,
// successful task with concrete file artifacts, drafts a markdown skill
// capturing what worked (title, steps, duration, files touched) and writes
// it to ~/.nexus/skills/auto/ — a sub-directory the active-skills loader
// does NOT recurse into (see src/brain/skills.ts: loadSkills() reads only
// the top level of SKILLS_DIR). That keeps draft skills off the system
// prompt until the user reviews and promotes them up a level.
//
// Repeat runs of the same task slug bump an existing draft's `successes`
// counter and refresh `last_seen` instead of creating duplicates.
//
// Pure event subscriber. Fire-and-forget; failures are logged at debug
// level so a malformed disk write never blocks the main message flow.
//
// Inspired by the Hermes-Agent autonomous skill-creation loop, kept small
// and observable: no LLM call, no destructive moves, all writes scoped to
// a sub-directory of the existing skills tree.

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { events } from '../core/events.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SkillExtractor');

// ─── Configuration ──────────────────────────────────────────────────────────

/** Minimum completed steps for a task to count as a real trajectory. */
const MIN_STEPS = 3;
/** At least one concrete file produced — keeps chat-only tasks out. */
const MIN_FILES = 1;
/** Minimum title length so we don't create skills off "fix it"-style titles. */
const MIN_TITLE_LENGTH = 8;
/**
 * Don't draft more than one *new* skill per hour. Bumps to existing drafts
 * are not throttled — they're idempotent and cheap.
 */
const NEW_SKILL_COOLDOWN_MS = 60 * 60 * 1000;
/**
 * Successes count at which we fire a Telegram nudge inviting the user to
 * promote the draft. Three repeats of the same slug is "this is a real
 * pattern, not a one-off" — high enough to earn the nudge, low enough that
 * the user gets it before forgetting the work it came from.
 */
const PROMOTION_NUDGE_THRESHOLD = 3;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'the', 'of', 'to', 'for', 'from',
  'in', 'on', 'at', 'with', 'via', 'using', 'please', 'can', 'you',
  'i', 'my', 'our', 'your', 'it', 'this', 'that', 'is', 'be', 'do',
]);

// ─── Public types ───────────────────────────────────────────────────────────

export interface SkillExtractorOptions {
  /** Where draft skills live. Defaults to ~/.nexus/skills/auto. */
  autoSkillsDir?: string;
  /** Clock override for deterministic tests. */
  now?: () => number;
  /**
   * Optional notifier — called fire-and-forget when a slug first reaches
   * `PROMOTION_NUDGE_THRESHOLD` successes. The orchestrator wires this to
   * Telegram so the user sees a "promote this draft?" prompt at the right
   * moment. Errors are swallowed; a notify failure never blocks extraction.
   */
  notify?: (message: string) => Promise<void>;
}

const VALID_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * Is this string a well-formed skill slug — safe to use in a filesystem
 * path under ~/.nexus/skills/{auto/,}? Pure helper, exported so the
 * `/promote <slug>` Telegram command can validate user input against the
 * same shape `titleToSlug` produces. No path-traversal characters allowed.
 */
export function isValidSkillSlug(slug: string): boolean {
  return VALID_SLUG_RE.test(slug);
}

interface SkillExtractorState {
  /** Last time we wrote a NEW skill (vs. bumping an existing one). */
  lastNewSkillAt: number;
}

// ─── Pure helpers (exported for unit tests) ─────────────────────────────────

/**
 * Should this completed-task event qualify for skill extraction?
 * Real success + real work + real artifact + a meaningful title.
 */
export function isExtractable(e: {
  success: boolean;
  stepsCompleted: number;
  filesProduced: string[] | undefined;
  title: string;
}): boolean {
  if (!e.success) return false;
  if (e.stepsCompleted < MIN_STEPS) return false;
  if (!e.filesProduced || e.filesProduced.length < MIN_FILES) return false;
  if (!e.title || e.title.trim().length < MIN_TITLE_LENGTH) return false;
  return true;
}

/** Derive a stable kebab-case filename from the task title. */
export function titleToSlug(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  const slug = words.slice(0, 6).join('-').replace(/-+/g, '-').slice(0, 60);
  return slug || 'untitled-task';
}

/** Trigger keywords for skill matching at recall time. */
export function deriveTriggers(title: string): string[] {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 6) break;
  }
  return out;
}

interface ExistingDraft {
  successes: number;
  firstSeen: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Parse just the bits of an existing draft we need to roll forward. */
export function parseExistingDraft(raw: string): ExistingDraft | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const block = match[1] ?? '';
  let successes = 1;
  let firstSeen = '';
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === 'successes') {
      const n = parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) successes = n;
    } else if (key === 'first_seen') {
      firstSeen = value;
    }
  }
  return { successes, firstSeen };
}

export function renderSkillMarkdown(input: {
  title: string;
  triggers: string[];
  stepsCompleted: number;
  totalSteps: number;
  durationMs: number;
  filesProduced: string[];
  successes: number;
  firstSeen: string;
  lastSeen: string;
}): string {
  const seconds = Math.round(input.durationMs / 1000);
  const fileLines = input.filesProduced.length > 0
    ? input.filesProduced.map((f) => `  - ${f}`).join('\n')
    : '  - (none recorded)';
  return `---
name: ${input.title}
description: Auto-extracted from a successful ${input.stepsCompleted}-step task on ${input.lastSeen.slice(0, 10)}. Review before relying on it.
triggers: ${input.triggers.join(', ')}
source: auto-extracted
draft: true
successes: ${input.successes}
first_seen: ${input.firstSeen}
last_seen: ${input.lastSeen}
---

## Auto-extracted skill (draft)

This skill was generated automatically from a successful task. Treat it as a
pattern hint, not a tested recipe — review and refine before promoting it
out of \`auto/\`.

### What worked
- Task: "${input.title}"
- Steps completed: ${input.stepsCompleted}/${input.totalSteps}
- Duration: ${seconds}s
- Files touched:
${fileLines}

### Trajectory notes
- First seen: ${input.firstSeen}
- Last seen: ${input.lastSeen}
- Successful runs observed: ${input.successes}

> Promote this skill by moving it from \`~/.nexus/skills/auto/\` up to
> \`~/.nexus/skills/\` once you've reviewed the steps. Until then it stays
> invisible to the active-skills loader.
`;
}

// ─── Main worker ────────────────────────────────────────────────────────────

export type ExtractResult = 'created' | 'bumped' | 'skipped-cooldown';

/**
 * Process one extractable task event. Exported for unit testing — the
 * subscriber wraps this in fire-and-forget error handling.
 */
export async function extractOne(
  e: {
    title: string;
    stepsCompleted: number;
    totalSteps: number;
    durationMs: number;
    filesProduced: string[];
  },
  state: SkillExtractorState,
  options: { autoSkillsDir: string; now: () => number },
): Promise<ExtractResult> {
  const slug = titleToSlug(e.title);
  const filePath = join(options.autoSkillsDir, `${slug}.md`);
  const nowMs = options.now();
  const nowISO = new Date(nowMs).toISOString();

  let existing: ExistingDraft | null = null;
  try {
    if (existsSync(filePath)) {
      const raw = await readFile(filePath, 'utf-8');
      existing = parseExistingDraft(raw);
    }
  } catch (err) {
    log.debug({ err, filePath }, 'Failed to read existing draft, will overwrite');
  }

  // New-skill creation is rate-limited; bumps are not (idempotent + cheap).
  // `lastNewSkillAt === 0` is the "never written" sentinel — let the first new
  // skill through unconditionally; only later ones face the cooldown.
  if (
    !existing &&
    state.lastNewSkillAt > 0 &&
    nowMs - state.lastNewSkillAt < NEW_SKILL_COOLDOWN_MS
  ) {
    return 'skipped-cooldown';
  }

  const successes = (existing?.successes ?? 0) + 1;
  const firstSeen = existing?.firstSeen || nowISO;
  const triggers = deriveTriggers(e.title);

  const markdown = renderSkillMarkdown({
    title: e.title,
    triggers,
    stepsCompleted: e.stepsCompleted,
    totalSteps: e.totalSteps,
    durationMs: e.durationMs,
    filesProduced: e.filesProduced,
    successes,
    firstSeen,
    lastSeen: nowISO,
  });

  mkdirSync(options.autoSkillsDir, { recursive: true });
  await writeFile(filePath, markdown, 'utf-8');

  if (!existing) state.lastNewSkillAt = nowMs;

  return existing ? 'bumped' : 'created';
}

/**
 * Render the Telegram nudge sent when a draft first reaches the promotion
 * threshold. Pure — exported so the format can be unit-tested without
 * pulling in the Telegram client.
 */
export function formatPromotionNudge(slug: string, successes: number): string {
  return [
    `🌱 <b>Skill draft matured</b>`,
    ``,
    `I've extracted a pattern from doing <code>${slug}</code> ${successes} times. It's been sitting as a draft in <code>~/.nexus/skills/auto/</code>.`,
    ``,
    `If it's worth promoting to active skills (so I'll reference it on similar tasks), reply:`,
    `<code>/promote ${slug}</code>`,
    ``,
    `If not, ignore — drafts don't affect anything until promoted.`,
  ].join('\n');
}

// ─── Subscriber wiring ──────────────────────────────────────────────────────

/**
 * Start the skill-extractor subscriber. Mirrors the Time Capsule shape so
 * the orchestrator can stash and unsubscribe handles uniformly.
 */
export function startSkillExtractor(
  options: SkillExtractorOptions = {},
): { unsubscribe(): void }[] {
  const autoSkillsDir =
    options.autoSkillsDir ?? join(homedir(), '.nexus', 'skills', 'auto');
  const now = options.now ?? (() => Date.now());
  const state: SkillExtractorState = { lastNewSkillAt: 0 };

  const nudgedSlugs = new Set<string>(); // dedupe nudges within one process lifetime

  const sub = events.on('task.completed', (e) => {
    if (!isExtractable(e)) return;

    void (async () => {
      const slug = titleToSlug(e.title);
      try {
        const result = await extractOne(
          {
            title: e.title,
            stepsCompleted: e.stepsCompleted,
            totalSteps: e.totalSteps,
            durationMs: e.durationMs,
            filesProduced: e.filesProduced,
          },
          state,
          { autoSkillsDir, now },
        );
        if (result === 'skipped-cooldown') {
          log.debug({ title: e.title }, 'Skill extraction skipped (new-skill cooldown)');
        } else {
          log.info(
            { title: e.title, slug, result },
            'Skill extracted',
          );

          // Read the file we just wrote to find out the new successes count.
          // Cheaper than threading the count through the return shape and keeps
          // extractOne's signature small.
          if (options.notify && !nudgedSlugs.has(slug)) {
            try {
              const written = await readFile(join(autoSkillsDir, `${slug}.md`), 'utf-8');
              const parsed = parseExistingDraft(written);
              if (parsed && parsed.successes === PROMOTION_NUDGE_THRESHOLD) {
                nudgedSlugs.add(slug);
                await options.notify(formatPromotionNudge(slug, parsed.successes));
                log.info({ slug, successes: parsed.successes }, 'Promotion nudge sent');
              }
            } catch (err) {
              log.debug({ err, slug }, 'Promotion nudge skipped (read/notify failed)');
            }
          }
        }
      } catch (err) {
        log.debug({ err, title: e.title }, 'Skill extraction failed (non-fatal)');
      }
    })();
  });

  log.info({ autoSkillsDir }, 'Skill Extractor subscribed to task.completed');
  return [sub];
}
