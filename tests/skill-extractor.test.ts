import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { events } from '../src/core/events.js';
import {
  isExtractable,
  titleToSlug,
  deriveTriggers,
  parseExistingDraft,
  renderSkillMarkdown,
  extractOne,
  startSkillExtractor,
  isValidSkillSlug,
  formatPromotionNudge,
} from '../src/brain/skill-extractor.js';

// ─── Pure-function tests ─────────────────────────────────────────────────────

describe('isExtractable', () => {
  const base = {
    success: true,
    stepsCompleted: 5,
    filesProduced: ['a.ts', 'b.ts'],
    title: 'Build a small chrome extension',
  };

  it('accepts a real, multi-step, successful task with files', () => {
    expect(isExtractable(base)).toBe(true);
  });

  it('rejects failed tasks', () => {
    expect(isExtractable({ ...base, success: false })).toBe(false);
  });

  it('rejects trivial-step tasks', () => {
    expect(isExtractable({ ...base, stepsCompleted: 1 })).toBe(false);
  });

  it('rejects chat-only tasks (no files)', () => {
    expect(isExtractable({ ...base, filesProduced: [] })).toBe(false);
    expect(isExtractable({ ...base, filesProduced: undefined })).toBe(false);
  });

  it('rejects too-short / empty titles', () => {
    expect(isExtractable({ ...base, title: 'fix' })).toBe(false);
    expect(isExtractable({ ...base, title: '' })).toBe(false);
    expect(isExtractable({ ...base, title: '   ' })).toBe(false);
  });
});

describe('titleToSlug', () => {
  it('produces a kebab-case slug, stopwords stripped', () => {
    // 'a', 'for', 'the' are stopwords; everything else survives in order.
    expect(titleToSlug('Build a small chrome extension for the user'))
      .toBe('build-small-chrome-extension-user');
  });

  it('caps at 6 words and 60 chars', () => {
    const slug = titleToSlug(
      'one two three four five six seven eight nine ten eleven twelve',
    );
    expect(slug.split('-').length).toBeLessThanOrEqual(6);
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it('returns a stable fallback for empty / punctuation-only titles', () => {
    expect(titleToSlug('!!!')).toBe('untitled-task');
    expect(titleToSlug('')).toBe('untitled-task');
  });
});

describe('deriveTriggers', () => {
  it('keeps long, non-stopword tokens, deduped, capped at 6', () => {
    const triggers = deriveTriggers(
      'Build chrome extension extension extension manifest popup background',
    );
    expect(triggers).toContain('chrome');
    expect(triggers).toContain('extension');
    expect(triggers.filter((t) => t === 'extension').length).toBe(1);
    expect(triggers.length).toBeLessThanOrEqual(6);
  });
});

describe('parseExistingDraft', () => {
  it('reads successes + first_seen out of frontmatter', () => {
    const raw = `---
name: Foo
successes: 3
first_seen: 2026-05-01T10:00:00.000Z
---

body`;
    expect(parseExistingDraft(raw)).toEqual({
      successes: 3,
      firstSeen: '2026-05-01T10:00:00.000Z',
    });
  });

  it('returns null when frontmatter is absent', () => {
    expect(parseExistingDraft('no frontmatter here')).toBeNull();
  });

  it('falls back to successes=1 when value is malformed', () => {
    const raw = `---\nsuccesses: not-a-number\n---\nbody`;
    expect(parseExistingDraft(raw)?.successes).toBe(1);
  });
});

describe('renderSkillMarkdown', () => {
  it('emits valid frontmatter the active-skills loader can read', () => {
    const md = renderSkillMarkdown({
      title: 'Build small extension',
      triggers: ['chrome', 'extension'],
      stepsCompleted: 4,
      totalSteps: 4,
      durationMs: 503_900,
      filesProduced: ['manifest.json', 'popup.html'],
      successes: 2,
      firstSeen: '2026-05-01T10:00:00.000Z',
      lastSeen: '2026-05-04T20:30:00.000Z',
    });
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('name: Build small extension');
    expect(md).toContain('successes: 2');
    expect(md).toContain('draft: true');
    expect(md).toContain('Duration: 504s');
    expect(md).toContain('  - manifest.json');
  });
});

// ─── extractOne — direct, deterministic ────────────────────────────────────
//
// Subscriber-side I/O is fire-and-forget; awaiting it in tests is racy.
// We test the actual extraction logic against extractOne() directly (it's
// already async/awaitable) and reserve the subscriber block below for
// registration sanity-checks only.

describe('extractOne', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nexus-skill-extractor-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseTask = {
    title: 'Build small chrome extension',
    stepsCompleted: 5,
    totalSteps: 5,
    durationMs: 60_000,
    filesProduced: ['out.ts'],
  };

  it('creates a draft on the first call', async () => {
    const state = { lastNewSkillAt: 0 };
    const result = await extractOne(baseTask, state, {
      autoSkillsDir: tmpDir,
      now: () => 1_000,
    });
    expect(result).toBe('created');
    const body = readFileSync(
      join(tmpDir, 'build-small-chrome-extension.md'),
      'utf-8',
    );
    expect(body).toContain('successes: 1');
    expect(body).toContain('draft: true');
    expect(body).toContain('source: auto-extracted');
  });

  it('bumps successes + last_seen on repeat with same slug', async () => {
    const state = { lastNewSkillAt: 0 };
    await extractOne(baseTask, state, {
      autoSkillsDir: tmpDir,
      now: () => 1_000,
    });
    const result = await extractOne(baseTask, state, {
      autoSkillsDir: tmpDir,
      now: () => 2_000,
    });
    expect(result).toBe('bumped');
    const body = readFileSync(
      join(tmpDir, 'build-small-chrome-extension.md'),
      'utf-8',
    );
    expect(body).toContain('successes: 2');
    expect(body).toContain('first_seen: 1970-01-01T00:00:01.000Z');
    expect(body).toContain('last_seen: 1970-01-01T00:00:02.000Z');
  });

  it('rate-limits a SECOND distinct new draft inside the cooldown window', async () => {
    const state = { lastNewSkillAt: 0 };
    const a = await extractOne(baseTask, state, {
      autoSkillsDir: tmpDir,
      now: () => 1_000,
    });
    const b = await extractOne(
      { ...baseTask, title: 'Configure Stripe webhook validation' },
      state,
      { autoSkillsDir: tmpDir, now: () => 1_500 }, // same hour
    );
    expect(a).toBe('created');
    expect(b).toBe('skipped-cooldown');
    expect(existsSync(join(tmpDir, 'build-small-chrome-extension.md'))).toBe(true);
    expect(
      existsSync(join(tmpDir, 'configure-stripe-webhook-validation.md')),
    ).toBe(false);
  });

  it('allows a second distinct new draft once the cooldown has expired', async () => {
    const state = { lastNewSkillAt: 0 };
    await extractOne(baseTask, state, {
      autoSkillsDir: tmpDir,
      now: () => 1_000,
    });
    const result = await extractOne(
      { ...baseTask, title: 'Configure Stripe webhook validation' },
      state,
      { autoSkillsDir: tmpDir, now: () => 1_000 + 60 * 60 * 1000 + 1 },
    );
    expect(result).toBe('created');
    expect(
      existsSync(join(tmpDir, 'configure-stripe-webhook-validation.md')),
    ).toBe(true);
  });

  it('always allows a bump even when cooldown is active (idempotent + cheap)', async () => {
    // Seed an initial create at t=1000.
    const state = { lastNewSkillAt: 0 };
    const created = await extractOne(baseTask, state, {
      autoSkillsDir: tmpDir,
      now: () => 1_000,
    });
    expect(created).toBe('created');
    expect(state.lastNewSkillAt).toBe(1_000);

    // 500ms later — well inside the 1h cooldown — the same slug should still
    // bump (existing file path bypasses the cooldown check entirely).
    const bump = await extractOne(baseTask, state, {
      autoSkillsDir: tmpDir,
      now: () => 1_500,
    });
    expect(bump).toBe('bumped');
  });
});

// ─── Subscriber wiring sanity ────────────────────────────────────────────────

describe('startSkillExtractor (subscriber registration)', () => {
  it('registers exactly one task.completed handler and unsubscribes cleanly', () => {
    const before = events.stats().find((s) => s.type === 'task.completed')?.handlerCount ?? 0;
    const subs = startSkillExtractor({ autoSkillsDir: tmpdir() });
    const after = events.stats().find((s) => s.type === 'task.completed')?.handlerCount ?? 0;
    expect(after - before).toBe(1);
    for (const s of subs) s.unsubscribe();
    const cleaned = events.stats().find((s) => s.type === 'task.completed')?.handlerCount ?? 0;
    expect(cleaned).toBe(before);
  });

  it('does not throw on a non-extractable event', () => {
    const subs = startSkillExtractor({ autoSkillsDir: tmpdir() });
    // Should be a no-op (gates fail) and not raise.
    expect(() =>
      events.emit({
        type: 'task.completed',
        title: 'short',
        success: false,
        durationMs: 0,
        stepsCompleted: 1,
        totalSteps: 1,
        filesProduced: [],
      }),
    ).not.toThrow();
    for (const s of subs) s.unsubscribe();
  });
});

// ─── Slug validation (path-traversal safety + symmetry with titleToSlug) ──

describe('isValidSkillSlug', () => {
  it('accepts slugs that titleToSlug actually produces', () => {
    expect(isValidSkillSlug('build-small-chrome-extension')).toBe(true);
    expect(isValidSkillSlug('configure-stripe-webhook-validation')).toBe(true);
    expect(isValidSkillSlug('a')).toBe(true);
    expect(isValidSkillSlug('a-1')).toBe(true);
    expect(isValidSkillSlug('untitled-task')).toBe(true);
  });

  it('rejects path-traversal attempts and any non-slug characters', () => {
    expect(isValidSkillSlug('../etc/passwd')).toBe(false);
    expect(isValidSkillSlug('foo/bar')).toBe(false);
    expect(isValidSkillSlug('foo bar')).toBe(false);
    expect(isValidSkillSlug('Foo')).toBe(false); // uppercase
    expect(isValidSkillSlug('-leading-dash')).toBe(false);
    expect(isValidSkillSlug('')).toBe(false);
    expect(isValidSkillSlug('foo.md')).toBe(false); // dot
    expect(isValidSkillSlug('foo_bar')).toBe(false); // underscore
  });
});

// ─── formatPromotionNudge — Telegram-bound HTML nudge string ──────────────

describe('formatPromotionNudge', () => {
  it('includes the slug in HTML <code> blocks twice (callout + paste-able command)', () => {
    const out = formatPromotionNudge('build-small-chrome-extension', 3);
    expect(out).toContain('<code>build-small-chrome-extension</code>');
    expect(out).toContain('<code>/promote build-small-chrome-extension</code>');
    expect(out).toContain('3 times');
  });

  it('mentions the auto/ directory and is non-coercive ("ignore — drafts don\'t affect anything")', () => {
    const out = formatPromotionNudge('foo', 5);
    expect(out).toContain('~/.nexus/skills/auto/');
    expect(out.toLowerCase()).toMatch(/ignore/);
  });
});
