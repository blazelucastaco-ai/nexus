import { describe, it, expect } from 'vitest';
import {
  cleanMarkdownForTelegram,
  formatDuration,
  pickFinalAnswer,
  resolveStepModel,
  summarizeTaskForHistory,
} from '../src/core/task-runner.js';
import type { TaskRunResult } from '../src/core/task-runner.js';

// Bug Lucas reported on 2026-05-06: NEXUS replied to a task with just
// "task finished" + a step checklist, never including the actual answer.
// Root cause was that the per-step rawOutput existed in memory but the
// final-summary formatter never surfaced it. pickFinalAnswer is the helper
// that decides whether the final step's content is worth showing.

describe('pickFinalAnswer', () => {
  it('returns the rawOutput verbatim when it carries real content', () => {
    expect(pickFinalAnswer('Node version: v22.14.0', '')).toBe('Node version: v22.14.0');
  });

  it('falls back to summary when rawOutput is empty', () => {
    expect(pickFinalAnswer('', 'partial summary text')).toBe('partial summary text');
  });

  it('returns "" when both inputs are empty (formatter then omits the Result block)', () => {
    expect(pickFinalAnswer('', '')).toBe('');
    expect(pickFinalAnswer('   ', '   ')).toBe('');
  });

  it('skips boilerplate "Step N completed" so we don\'t broadcast noise', () => {
    expect(pickFinalAnswer('Step 1 completed', '')).toBe('');
    expect(pickFinalAnswer('Step 7 completed.', '')).toBe('');
    expect(pickFinalAnswer('step 3 COMPLETED', '')).toBe('');
  });

  it('skips the timeout sentinel', () => {
    expect(pickFinalAnswer('Task timed out before this step could run', '')).toBe('');
    expect(pickFinalAnswer('Task timed out before this step could run.', '')).toBe('');
  });

  it('skips the "step failed after N attempts" template', () => {
    expect(pickFinalAnswer('Step failed after 4 attempts: connection refused', '')).toBe('');
    expect(pickFinalAnswer('Step failed after 3 Co Work consultations.', '')).toBe('');
  });

  it('truncates very long output with an ellipsis to fit Telegram', () => {
    const long = 'x'.repeat(2000);
    const out = pickFinalAnswer(long, '');
    expect(out.length).toBeLessThanOrEqual(1501); // 1500 + ellipsis char
    expect(out.endsWith('…')).toBe(true);
  });

  it('preserves multi-line content (no whitespace collapse)', () => {
    const out = pickFinalAnswer('Line 1\nLine 2\nLine 3', '');
    expect(out).toContain('\n');
    expect(out.split('\n').length).toBe(3);
  });

  it('trims leading/trailing whitespace before deciding', () => {
    expect(pickFinalAnswer('   \n  v22.14.0  \n  ', '')).toBe('v22.14.0');
  });

  it('strips Markdown from rawOutput so Telegram does not show literal `##` / `---` / pipes', () => {
    // Lucas's screenshot bug from 2026-05-06: model produced a Markdown
    // report that Telegram rendered as raw text.
    const md = [
      '## ✅ Step 2 Complete — Verified',
      '---',
      '### 📁 Files',
      '| Path | Status |',
      '|------|--------|',
      '| `~/foo.json` | ✅ Valid |',
    ].join('\n');
    const out = pickFinalAnswer(md, '');
    expect(out).not.toContain('##');
    expect(out).not.toContain('---');
    expect(out).not.toMatch(/\|[-:]+\|/);
    expect(out).not.toContain('`~/foo.json`');
    expect(out).toContain('Step 2 Complete');
    expect(out).toContain('~/foo.json');
  });
});

describe('cleanMarkdownForTelegram', () => {
  it('returns empty string for empty input', () => {
    expect(cleanMarkdownForTelegram('')).toBe('');
  });

  it('passes plain text through unchanged', () => {
    expect(cleanMarkdownForTelegram('Just a sentence.')).toBe('Just a sentence.');
  });

  it('strips heading markers but keeps the heading text', () => {
    expect(cleanMarkdownForTelegram('## Hello\n### World')).toBe('Hello\nWorld');
  });

  it('drops horizontal rules', () => {
    expect(cleanMarkdownForTelegram('above\n---\nbelow')).toBe('above\n\nbelow');
    expect(cleanMarkdownForTelegram('above\n***\nbelow')).toBe('above\n\nbelow');
  });

  it('flattens pipe tables into space-separated rows', () => {
    const out = cleanMarkdownForTelegram('| Path | Status |\n|------|--------|\n| a.txt | ok |');
    expect(out).toContain('Path');
    expect(out).toContain('Status');
    expect(out).toContain('a.txt');
    expect(out).toContain('ok');
    expect(out).not.toMatch(/\|/);
  });

  it('strips fenced code blocks but keeps content', () => {
    const out = cleanMarkdownForTelegram('```js\nconst x = 1;\n```');
    expect(out).toBe('const x = 1;');
  });

  it('strips bold/italic markers', () => {
    expect(cleanMarkdownForTelegram('**bold** and *italic* and __also__ and _it_')).toBe(
      'bold and italic and also and it',
    );
  });

  it('strips inline-code backticks', () => {
    expect(cleanMarkdownForTelegram('the `foo.json` file')).toBe('the foo.json file');
  });

  it('converts dash bullets to • bullets', () => {
    const out = cleanMarkdownForTelegram('- one\n- two\n- three');
    expect(out).toBe('• one\n• two\n• three');
  });

  it('collapses 3+ blank lines to a single paragraph break', () => {
    expect(cleanMarkdownForTelegram('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('converts Markdown links to "text (url)" so the URL stays clickable', () => {
    expect(cleanMarkdownForTelegram('see [the docs](https://example.com/foo)')).toBe(
      'see the docs (https://example.com/foo)',
    );
  });

  it('strips Markdown images down to alt text', () => {
    expect(cleanMarkdownForTelegram('![chart](https://i.imgur.com/x.png)')).toBe('chart');
    // Image with empty alt drops to nothing
    expect(cleanMarkdownForTelegram('before ![](u) after')).toBe('before  after');
  });

  it('handles image-then-link in the same line without leaking `!`', () => {
    const out = cleanMarkdownForTelegram('![logo](a.png) [Link](https://b.com)');
    expect(out).toBe('logo Link (https://b.com)');
    expect(out).not.toContain('!');
    expect(out).not.toContain('[');
  });

  it('strips blockquote `>` markers but keeps the quoted text', () => {
    expect(cleanMarkdownForTelegram('> a quote\n> continued')).toBe('a quote\ncontinued');
  });
});

describe('summarizeTaskForHistory', () => {
  // Bug Lucas reported on 2026-05-06: NEXUS shipped a Chrome extension at
  // 8:48 PM, then refused at 8:58 PM as if it had never built it, then
  // denied building it at 9:00 PM ("no record of building it"). Root
  // cause: task-runner sent the completion message via Telegram but
  // bypassed conversationHistory, so the LLM's next-turn view had a gap.
  // summarizeTaskForHistory generates the plain-text assistant turn the
  // orchestrator now writes back into history so the next chat turn
  // sees what NEXUS just did.
  const baseResult = (overrides: Partial<TaskRunResult> = {}): TaskRunResult => ({
    success: true,
    completedSteps: 2,
    totalSteps: 2,
    projectDir: '~/nexus-workspace/foo',
    filesProduced: [],
    summary: '',
    durationMs: 1000,
    ...overrides,
  });

  it('summarizes a successful task with file list', () => {
    const out = summarizeTaskForHistory(
      { title: 'Form Tab Unlocker' },
      baseResult({
        filesProduced: [
          '~/nexus-workspace/form-tab-unlocker/manifest.json',
          '~/nexus-workspace/form-tab-unlocker/content.js',
        ],
      }),
    );
    expect(out).toBe(
      'I completed the task "Form Tab Unlocker" — all steps succeeded.' +
      ' Files created: ~/nexus-workspace/form-tab-unlocker/manifest.json,' +
      ' ~/nexus-workspace/form-tab-unlocker/content.js.',
    );
  });

  it('omits the Files line when no files were produced', () => {
    const out = summarizeTaskForHistory({ title: 'Battery check' }, baseResult());
    expect(out).toBe('I completed the task "Battery check" — all steps succeeded.');
    expect(out).not.toContain('Files');
  });

  it('reports partial completion with the n/m count', () => {
    const out = summarizeTaskForHistory(
      { title: 'Big build' },
      baseResult({ success: false, completedSteps: 3, totalSteps: 5 }),
    );
    expect(out).toContain('partial');
    expect(out).toContain('3/5');
  });

  it('reports timeout distinctly from generic partial', () => {
    const out = summarizeTaskForHistory(
      { title: 'Slow task' },
      baseResult({ success: false, completedSteps: 1, totalSteps: 3, timedOut: true }),
    );
    expect(out).toContain('timed out');
    expect(out).toContain('1/3');
    expect(out).not.toContain('partial');
  });

  it('reads as a normal assistant turn (not a system tag)', () => {
    // The string is fed straight into the LLM as an assistant message —
    // brackets like "[Completed: ...]" would have read like metadata.
    const out = summarizeTaskForHistory({ title: 'Anything' }, baseResult());
    expect(out.startsWith('I completed the task')).toBe(true);
    expect(out.startsWith('[')).toBe(false);
  });

  // 2026-05-11: enriched with per-step success/failure titles so the
  // chat-mode model can answer "where is the report?" with specifics
  // instead of grabbing a screenshot. Observed bug: NEXUS finished a
  // LoopNet scrape task where step 3 (generate report) failed; user asked
  // "where is the report?" and NEXUS took a screenshot of the desktop
  // because the history summary just said "2/4 steps completed" with no
  // detail on WHICH step failed.
  it('names the failed steps when the task was partial', () => {
    const out = summarizeTaskForHistory(
      { title: 'Scrape LoopNet Cell Towers' },
      baseResult({
        success: false,
        completedSteps: 2,
        totalSteps: 4,
        filesProduced: ['~/Desktop/loopnet_scrape_v2.py'],
        failedStepTitles: ['Generate dark-mode HTML report', 'Verify report opens correctly'],
        successfulStepTitles: ['Scrape all 8 pages', 'Identify cell towers'],
      }),
    );
    expect(out).toContain('Failed steps: Generate dark-mode HTML report; Verify report opens correctly.');
    expect(out).toContain('Completed steps: Scrape all 8 pages; Identify cell towers.');
    expect(out).toContain('Files created: ~/Desktop/loopnet_scrape_v2.py.');
  });

  it('does not name completed steps on a fully successful task (would be redundant)', () => {
    const out = summarizeTaskForHistory(
      { title: 'All good' },
      baseResult({
        success: true,
        successfulStepTitles: ['Step A', 'Step B'],
        failedStepTitles: [],
      }),
    );
    expect(out).not.toContain('Completed steps:');
    expect(out).not.toContain('Failed steps:');
  });

  it('explicitly says no files were produced on a partial failure with no files', () => {
    const out = summarizeTaskForHistory(
      { title: 'All failed' },
      baseResult({
        success: false,
        completedSteps: 0,
        totalSteps: 2,
        filesProduced: [],
        failedStepTitles: ['Step 1', 'Step 2'],
      }),
    );
    expect(out).toContain('No files were produced.');
  });
});

describe('formatDuration', () => {
  // R2 (2026-05-06): turn the CI-status-footer "Completed in 140.0s"
  // into something that reads like a person answering — "Took 2 min 20s."
  it('shows 1 decimal for sub-second durations', () => {
    expect(formatDuration(800)).toBe('0.8s');
    expect(formatDuration(200)).toBe('0.2s');
  });

  it('rounds to whole seconds in the 1–59s range', () => {
    expect(formatDuration(1500)).toBe('2s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(59_400)).toBe('59s');
  });

  it('formats whole minutes as "X min"', () => {
    expect(formatDuration(60_000)).toBe('1 min');
    expect(formatDuration(180_000)).toBe('3 min');
  });

  it('formats minutes-with-seconds as "X min Ys"', () => {
    expect(formatDuration(140_000)).toBe('2 min 20s');
    expect(formatDuration(305_000)).toBe('5 min 5s');
  });

  it('handles zero duration without crashing', () => {
    expect(formatDuration(0)).toBe('0.0s');
  });
});

// resolveStepModel — 2026-05-08 per-step model tier selection. The planner
// can tag each step with "haiku" | "sonnet" | "opus"; the resolver maps
// to actual config-supplied model strings, with graceful fallback when
// a tier model isn't configured.
describe('resolveStepModel', () => {
  const def = 'claude-sonnet';
  const fast = 'claude-haiku';
  const opus = 'claude-opus';

  it('returns fastModel for tier "haiku"', () => {
    expect(resolveStepModel('haiku', def, fast, opus)).toBe('claude-haiku');
  });

  it('returns opusModel for tier "opus"', () => {
    expect(resolveStepModel('opus', def, fast, opus)).toBe('claude-opus');
  });

  it('returns defaultModel for tier "sonnet" (the standard tier)', () => {
    expect(resolveStepModel('sonnet', def, fast, opus)).toBe('claude-sonnet');
  });

  it('returns defaultModel when tier is undefined (planner omitted it)', () => {
    expect(resolveStepModel(undefined, def, fast, opus)).toBe('claude-sonnet');
  });

  it('falls back to defaultModel when haiku tier requested but fastModel missing', () => {
    expect(resolveStepModel('haiku', def, undefined, opus)).toBe('claude-sonnet');
  });

  it('falls back to defaultModel when opus tier requested but opusModel missing', () => {
    expect(resolveStepModel('opus', def, fast, undefined)).toBe('claude-sonnet');
  });

  it('keeps tasks running even if both tier models are unconfigured', () => {
    expect(resolveStepModel('haiku', def, undefined, undefined)).toBe('claude-sonnet');
    expect(resolveStepModel('opus', def, undefined, undefined)).toBe('claude-sonnet');
  });
});
