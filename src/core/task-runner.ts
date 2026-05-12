// ─── Task Runner ──────────────────────────────────────────────────────────────
// Executes a TaskPlan step-by-step, sending live Telegram progress updates.
// Each step runs its own focused agentic loop with tool calling.
// After each step, it verifies the output before moving on.

import { createLogger } from '../utils/logger.js';
import { toOpenAITools } from '../tools/definitions.js';
import { repairToolResult } from './transcript-repair.js';
import { formatPlanMessage } from './task-planner.js';
import type { AIManager } from '../ai/index.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { TelegramGateway } from '../telegram/index.js';
import type { TaskPlan, TaskStep } from './task-planner.js';
import type { AIMessage } from '../types.js';
import { escapeHtml } from '../telegram/messages.js';
import { CoWorkAgent, formatCoWorkHint } from '../agents/cowork.js';
import type { CoWorkEvent, CoWorkResponse } from '../agents/cowork.js';
import { events } from './events.js';

const log = createLogger('TaskRunner');

const MAX_STEP_ITERATIONS    = 25;       // Per-step tool loop limit
const MAX_STEP_RETRIES       = 1;        // Standard retries before Co Work activates
const MAX_COWORK_ATTEMPTS    = 3;        // Max Co Work consultations per step
const MAX_COWORK_TOTAL       = 3;        // Hard cap on Co Work calls for entire task
const TOOL_TIMEOUT_MS        = 120_000;  // Per-tool call timeout
const STEP_TIMEOUT_MS        = 5 * 60 * 1000;  // 5 min max per step
const TASK_TIMEOUT_MS        = 25 * 60 * 1000; // 25 min max per whole task
const TELEGRAM_EDIT_THROTTLE_MS = 1200;  // Telegram rate limit buffer
const HEARTBEAT_INTERVAL_MS = 120_000;   // Interim "still working" message every 2 min per step
const DEGENERATE_LOOP_LIMIT  = 3;        // Break if same malformed tool call repeats N times
const TOOL_TYPE_LOOP_LIMIT   = 8;        // Break if same tool type called > N times without progress

// ─── Types ────────────────────────────────────────────────────────────────────

interface StepContext {
  filesWritten: string[];
  fileContents: Record<string, string>;  // path → content snapshot for cross-step context
  commandsRun: string[];
  summary: string;
}

export interface TaskRunResult {
  success: boolean;
  completedSteps: number;
  totalSteps: number;
  projectDir: string;
  filesProduced: string[];
  summary: string;
  durationMs: number;
  timedOut?: boolean;
  coworkEvents?: CoWorkEvent[];
  /** Titles of steps that finished verified=true. Used by
   *  summarizeTaskForHistory so the chat-mode model can answer
   *  follow-ups like "where's the report?" without taking a screenshot. */
  successfulStepTitles?: string[];
  /** Titles of steps that failed (verified=false or crashed). Same use. */
  failedStepTitles?: string[];
}

// ─── Per-step model tier resolver ────────────────────────────────────────────
//
// 2026-05-08 per-step model selection. The planner can tag each step with a
// model tier ("haiku" | "sonnet" | "opus") based on actual difficulty.
// Trivial steps drop to Haiku (fast + cheap), hard reasoning bumps to Opus,
// everything else stays on Sonnet (the existing default).
//
// Falls back to defaultModel whenever a tier hint is missing OR the
// corresponding tier model isn't configured. Defense against partial config
// keeps tasks running even if fastModel/opusModel aren't set.
export function resolveStepModel(
  tier: TaskStep['model'],
  defaultModel: string,
  fastModel: string | undefined,
  opusModel: string | undefined,
): string {
  if (tier === 'haiku' && fastModel) return fastModel;
  if (tier === 'opus' && opusModel) return opusModel;
  return defaultModel;
}

// ─── Step System Prompt ───────────────────────────────────────────────────────

function buildStepSystemPrompt(
  originalRequest: string,
  plan: TaskPlan,
  step: TaskStep,
  previousContext: StepContext[],
  coworkHint?: CoWorkResponse | null,
  coworkAttemptNumber?: number,
  skillsContext?: string,
): string {
  const prevSummary = previousContext.length > 0
    ? previousContext.map((c, i) => `Step ${i + 1}: ${c.summary}${c.filesWritten.length > 0 ? ` [Files: ${c.filesWritten.join(', ')}]` : ''}`).join('\n')
    : 'None — this is the first step.';

  // Build a file content snapshot from prior steps so this step can reference them
  // without needing to call read_file. Cap total to ~12K chars to avoid bloating the prompt.
  // Previous implementation had an accounting bug (FIND-BUG-01): the truncation-notice
  // line was appended but not counted toward snapshotChars, so subsequent iterations
  // could push the buffer well past MAX_SNAPSHOT_CHARS. Fix: account for notice bytes
  // AND stop adding entries once the budget is spent.
  let fileSnapshot = '';
  const MAX_SNAPSHOT_CHARS = 12_000;
  let snapshotChars = 0;
  outer: for (const ctx of previousContext) {
    for (const [filePath, content] of Object.entries(ctx.fileContents)) {
      const entry = `\n--- ${filePath} ---\n${content}\n`;
      if (snapshotChars + entry.length > MAX_SNAPSHOT_CHARS) {
        const notice = `\n--- ${filePath} --- [truncated, use read_file to see full content]\n`;
        if (snapshotChars + notice.length > MAX_SNAPSHOT_CHARS) {
          // No room even for the notice — bail out of both loops.
          break outer;
        }
        fileSnapshot += notice;
        snapshotChars += notice.length;
        continue;
      }
      fileSnapshot += entry;
      snapshotChars += entry.length;
    }
  }
  const fileSnapshotSection = fileSnapshot
    ? `\nFILES FROM PREVIOUS STEPS (reference these — do NOT recreate them unless fixing issues):\n${fileSnapshot}\n`
    : '';

  const agentHint = step.agent
    ? `\nAGENT FOCUS: This step is best handled with ${step.agent} capabilities — prioritize those tools.`
    : '';

  const coworkSection = coworkHint
    ? formatCoWorkHint(coworkHint, coworkAttemptNumber ?? 1)
    : '';

  const skillsSection = skillsContext
    ? `\n━━━ RELEVANT SKILLS ━━━\n${skillsContext}\n━━━━━━━━━━━━━━━━━━━━━━━\n`
    : '';

  // Detect URLs in the original request so NEXUS knows to use browser tools
  const urlMatches = originalRequest.match(/https?:\/\/[^\s]+|(?:tiktok|instagram|twitter|github|youtube|linkedin)\.com\/[^\s]*/gi);
  const urlSection = urlMatches && urlMatches.length > 0
    ? `\nREFERENCE URLs — MUST use browser tools:\n${urlMatches.map((u) => `  • ${u}`).join('\n')}\nIMPORTANT: Use browser_navigate to open each URL. Do NOT use curl, fetch, or wget — social platforms (TikTok, Instagram, Twitter) block automated HTTP clients and will return bot-challenge pages. If the browser is unavailable or returns an error, write a placeholder note and proceed with whatever information you already have.\n`
    : '';

  return `You are NEXUS, a CLI-grade AI agent executing a task on macOS.

ORIGINAL REQUEST: ${originalRequest}
${urlSection}

FULL PLAN: "${plan.title}"
Project directory: ${plan.projectDir}
Total steps: ${plan.steps.length}

CURRENT STEP: ${step.id} of ${plan.steps.length}
STEP TITLE: ${step.title}
STEP GOAL: ${step.description}${agentHint}

PREVIOUS STEPS COMPLETED:
${prevSummary}
${fileSnapshotSection}${coworkSection}
━━━ RULES — READ EVERY ONE ━━━

1. TOOLS ONLY. Never put code or file content in your response text. If this step requires writing a file, call write_file. If it requires running a command, call run_terminal_command. Do NOT describe, explain, or show code in your message — just call the tool.

2. COMPLETE FILES. Every write_file call must contain the FULL, working file content. No stubs, no "// TODO", no placeholders, no truncation. If a file is 500 lines, write all 500 lines.

3. ABSOLUTE PATHS. Always use ~/... paths. Project files go in ${plan.projectDir}/

4. FIX ERRORS. If a tool returns an error, diagnose it and retry with a corrected approach. Never claim success after an error.

5. ONE STEP ONLY. Complete this step and stop. Do not do future steps.

6. BRIEF REPORT. After all tool calls, write 1-2 plain-text sentences saying what was done. The reply is shown in Telegram, which does NOT render Markdown — no headings (## / ###), no horizontal rules (---), no pipe tables, no code fences. Just a sentence or two of plain prose.

7. WHEN AMBIGUOUS, ASK. If the step description leaves a real decision unanswered (which file? which option? confirm before this destructive action?), call the ask_user tool with one short, specific question. Do NOT guess on ambiguous decisions and ship the wrong answer. Use ask_user only for genuine ambiguity — if you can decide it yourself with the context you have, decide it. Quick judgment > unnecessary user round-trip > wrong guess.

8. WEB SCRAPING — USE BROWSER TOOLS, NOT PYTHON SCRAPERS. For any work involving fetching, scraping, or interacting with a real website, use the browser_navigate / browser_extract / browser_click / browser_type / browser_get_text tools. Never write a Python/Node scraper using requests / urllib / Playwright / Puppeteer — modern sites (LoopNet, Zillow, LinkedIn, X, Amazon, basically any site worth scraping) use bot protection (Cloudflare, PerimeterX, HUMAN, Datadome) that detects those tools by fingerprint and either blocks them outright or serves a challenge that hangs forever. The browser bridge runs in the user's actual Chrome — it has cookies, has passed any bot checks, and looks like a real session. ALWAYS prefer it. If the browser extension is disconnected, ask_user to reconnect it — don't fall back to a Python scraper.

9. LARGE FILE GENERATION — WRITE A SCRIPT, DON'T EMIT INLINE. If a step is "generate a report" or "produce X output from Y data" and the output will be more than ~500 lines or ~10KB, do NOT try to emit the full content as the body of one write_file call — the LLM call generating that response will hit the 120s tool timeout. Instead: write a small templating script (Python or Node, 30-50 lines) that reads the source data and emits the output file. Then run_terminal_command to execute the script. Deterministic templating + structured data → output file: that's a 5-second script, not a 60-second LLM generation.

10. WHEN CO WORK GIVES A DIAGNOSIS, ACT ON IT — DON'T RETRY THE SAME APPROACH. If you see "Co Work diagnosed it" in the previous attempt's hint, that's a STRATEGY change, not a parameter tweak. If the diagnosis says "stop using ai.complete for this," that means STOP — pivot to a script. If the diagnosis says "use the open browser session, not a headless one," that means STOP using Playwright. Retrying the same shape after Co Work flagged it is a guaranteed waste of time and tokens.

11. NEVER SHIP A TEMPLATE AS THE FINAL OUTPUT. If a previous step produced a templating file with placeholders like {{NAME}}, \${VAR}, __X__, <FILL_ME>, or %VAR%, that file is the source-of-truth FOR the final output — it is NOT the final output itself. Before opening, displaying, or claiming completion on a "report"/"final"/"rendered" file, you MUST have run the templating substitution (script + data → new file with placeholders replaced) and produced a NEW file at a different path. Then open the NEW file. Never run \`open\` on a path that still contains unsubstituted placeholders — the user will see {{COUNT}} on screen and know the work wasn't done.

━━━ CODE QUALITY — MANDATORY ━━━

- Build the real thing, not a stub or skeleton. Complete, working, production-quality code.
- Proper project structure: separate concerns, real dependencies, setup instructions.
- Handle errors, validate inputs, use modern idioms for the language.
- Every generated file should be runnable as-is — no placeholder comments or TODOs.

For web/UI projects:
- Always use Tailwind CSS (CDN for single pages, npm for projects). Never ship unstyled HTML.
- Semantic HTML5, responsive viewport meta, mobile-first design.
- Cohesive color palette, proper typography (Google Fonts), generous spacing, hover states, transitions.
- Every page must look professional and production-ready — not a wireframe.

macOS notes:
- Shell: /bin/zsh. No GNU-only flags. No declare -A.
- Python paths: os.path.expanduser('~/...')
- Make scripts executable: chmod +x <script>${skillsSection}`;
}

// ─── Verification Prompt ──────────────────────────────────────────────────────

/**
 * Step titles that imply the step MUST produce an artifact (a file, a
 * populated database row, a rendered page, etc.). When such a step ends
 * with filesWritten=0, verifyStep should NOT auto-pass — it must probe
 * the workspace to confirm the expected output actually exists.
 *
 * The 2026-05-11 LoopNet incident: a step titled "Generate final report
 * and open in Chrome" ran a single `open ~/.../template.html` command
 * (zero files written) and was auto-passed. The "final report" the user
 * saw was the raw template with {{COUNT}}/{{TIMESTAMP}}/{{LISTINGS_JSON}}
 * placeholders unsubstituted.
 */
const OUTPUT_VERBS = /\b(?:generate|build|create|write|render|produce|compile|scaffold|extract|scrape|fetch|download|export|publish|assemble|populate|fill|substitute)\b/i;

export function stepImpliesOutput(title: string): boolean {
  return OUTPUT_VERBS.test(title);
}

function buildVerifyPrompt(step: TaskStep, filesWritten: string[]): string {
  // Branch A: no files written, but the step title says it should have
  // produced something. Make the verifier inspect the workspace and
  // confirm — don't take silence as success.
  if (filesWritten.length === 0) {
    return `Step "${step.title}" was just executed but wrote no new files.

Its title implies it should have produced an artifact (a populated file,
a rendered output, etc.). Use list_directory and read_file on the relevant
workspace directory to confirm the expected output exists AND contains real
content — not just template placeholders.

After checking, respond with EXACTLY one of these two lines (nothing else before it):
  VERIFIED: PASS — [one sentence summary of what was found]
  VERIFIED: FAIL — [specific reason: expected output missing / file contains only unsubstituted placeholders / etc.]

FAIL signals to watch for:
  - The expected artifact is missing from the workspace.
  - The "final" file still contains unsubstituted template variables: {{NAME}}, \${VAR}, __PLACEHOLDER__, <FILL_ME>, %VAR%.
  - A step that promised "open the report" actually opened a template, not a rendered report.`;
  }

  // Branch B: files were written — verify their content.
  const fileList = filesWritten.join(', ');
  return `Verify step "${step.title}" is complete.

Use read_file to check these files: ${fileList}

After checking, respond with EXACTLY one of these two lines (nothing else before it):
  VERIFIED: PASS — [one sentence summary of what was found]
  VERIFIED: FAIL — [specific reason: empty file / unsubstituted placeholders / only TODO stubs / critical syntax error]

FAIL the step if the file contains:
  - Unsubstituted template placeholders like {{NAME}}, \${VAR}, __PLACEHOLDER__, <FILL_ME>, or %VAR% in a file presented as a final/rendered output. (A template file that's MEANT to have placeholders is fine — judge by the step title.)
  - Only "// TODO", "Lorem ipsum", or other stub content where real data was expected.
  - A syntax error so severe the file cannot run at all.

Real content with minor issues = PASS. But a "final report" with unfilled {{...}} = FAIL.`;
}

// ─── Step Verification ────────────────────────────────────────────────────────

/**
 * Run a quick verification pass after a step completes.
 * Sends a single LLM call (with tools, max 5 iterations) asking it to read back
 * files and confirm they are complete and correct.
 * Returns the verification summary string.
 */
async function verifyStep(
  step: TaskStep,
  filesWritten: string[],
  ai: AIManager,
  toolExecutor: ToolExecutor,
  model: string,
): Promise<{ passed: boolean; summary: string }> {
  // Auto-pass only when the step truly had no expected output. If filesWritten=0
  // but the title says "generate/render/produce …", we must probe the workspace —
  // otherwise an `open template.html` no-op claims success.
  if (filesWritten.length === 0 && !stepImpliesOutput(step.title)) {
    return { passed: true, summary: 'No files to verify.' };
  }

  const tools = toOpenAITools();
  const verifyPrompt = buildVerifyPrompt(step, filesWritten);

  const verifyMessages: AIMessage[] = [
    { role: 'user', content: verifyPrompt },
  ];

  let lastContent = '';

  for (let i = 0; i < 5; i++) {
    let aiResponse;
    try {
      aiResponse = await withTimeout(
        ai.complete({ messages: verifyMessages, model, maxTokens: 8192, temperature: 0.1, tools, tool_choice: 'auto' }),
        TOOL_TIMEOUT_MS,
        `verify step ${step.id}`,
      );
    } catch {
      break;
    }

    if (!aiResponse.toolCalls?.length) {
      lastContent = aiResponse.content ?? '';
      break;
    }

    verifyMessages.push({ role: 'assistant', content: aiResponse.content || null, tool_calls: aiResponse.toolCalls });

    for (const toolCall of aiResponse.toolCalls) {
      let toolArgs: Record<string, unknown> = {};
      try { toolArgs = JSON.parse(toolCall.function.arguments); } catch { /* ignore */ }

      let result: string;
      try {
        result = await withTimeout(toolExecutor.execute(toolCall.function.name, toolArgs), TOOL_TIMEOUT_MS, toolCall.function.name);
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      verifyMessages.push({ role: 'tool', content: result, tool_call_id: toolCall.id });
    }
  }

  // Only fail if the LLM explicitly said VERIFIED: FAIL
  // Keyword scanning ("error", "missing") caused massive false positives — removed.
  const failed = lastContent.includes('VERIFIED: FAIL');
  const summary = (lastContent.match(/VERIFIED:\s*(?:PASS|FAIL)\s*[—-]\s*(.+)/)?.[1]?.trim())
    ?? (lastContent.slice(0, 200) || 'Verified.');

  return { passed: !failed, summary };
}

// ─── Progress Message Helpers ─────────────────────────────────────────────────

/**
 * Human-format a duration: under 1s shows one decimal ("0.8s"), 1–59s
 * shows whole seconds ("45s"), and 60s+ shows "X min" or "X min Ys".
 *
 * R2 (2026-05-06): the prior format ("Completed in 140.0s") read like
 * a CI status footer. "Took 2 min 20s" reads like a person answering.
 */
export function formatDuration(ms: number): string {
  const sec = ms / 1000;
  if (sec < 1) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const totalSec = Math.round(sec);
  const min = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (remSec === 0) return `${min} min`;
  return `${min} min ${remSec}s`;
}

function formatFinalSummary(
  plan: TaskPlan,
  allFiles: string[],
  durationMs: number,
  stepResults: Array<{ step: TaskStep; success: boolean; summary: string; rawOutput: string }>,
  allCoworkEvents: CoWorkEvent[],
): string {
  const overallSuccess = stepResults.every((r) => r.success);
  const titleIcon = overallSuccess ? '✅' : '⚠️';
  const lines: string[] = [
    `${titleIcon} <b>${escapeHtml(plan.title)}${overallSuccess ? '' : ' — partial'}</b>`,
  ];

  // ── Per-step checklist (R2: skip when noise) ─────────────────────────────
  // Skipping the checklist for a single-step task that succeeded — it just
  // restates the title. Always shown when there's >1 step or when anything
  // failed (debug context for the user).
  const showChecklist = stepResults.length > 1 || !overallSuccess;
  if (showChecklist) {
    lines.push('');
    for (const r of stepResults) {
      const icon = r.success ? '✅' : '⚠️';
      lines.push(`${icon} ${r.step.id}. ${escapeHtml(r.step.title)}`);
    }
  }

  // ── Answer section (R2: drop the "Result:" label) ────────────────────────
  // Surface the FINAL successful step's actual output as the visible answer.
  // Without this, NEXUS replies with just a checklist of completed steps and
  // the user has to ask "but what was the answer?" (Lucas's 2026-05-06 bug).
  // The label was redundant — the answer reads like prose without it.
  const lastSuccessful = [...stepResults].reverse().find((r) => r.success);
  if (lastSuccessful) {
    const answer = pickFinalAnswer(lastSuccessful.rawOutput, lastSuccessful.summary);
    if (answer) {
      lines.push('');
      lines.push(escapeHtml(answer));
    }
  }

  // ── Files (R2: inline when ≤3, block when ≥4) ────────────────────────────
  if (allFiles.length > 0) {
    lines.push('');
    if (allFiles.length <= 3) {
      const inline = allFiles.map((f) => `<code>${escapeHtml(f)}</code>`).join(', ');
      lines.push(`<b>Files:</b> ${inline}`);
    } else {
      lines.push('<b>Files:</b>');
      for (const f of allFiles) {
        lines.push(`  <code>${escapeHtml(f)}</code>`);
      }
    }
  }

  // ── Co Work section ──────────────────────────────────────────────────────
  if (allCoworkEvents.length > 0) {
    lines.push('');
    const resolved = allCoworkEvents.filter((e) => e.outcome === 'resolved');
    const failed   = allCoworkEvents.filter((e) => e.outcome === 'failed');

    if (resolved.length > 0 && failed.length === 0) {
      // All Co Work consultations led to a fix
      lines.push(`🧠 <b>I phoned a friend</b> — Co Work cracked it after ${allCoworkEvents.length} consultation${allCoworkEvents.length > 1 ? 's' : ''}.`);
      for (const e of resolved) {
        lines.push(`  <i>Step ${e.stepId}: ${escapeHtml(e.diagnosis)}</i>`);
        lines.push(`  → ${escapeHtml(e.suggestion)}`);
      }
    } else if (resolved.length > 0) {
      // Mixed — some resolved, some didn't
      lines.push(`🧠 <b>I phoned a friend</b> — Co Work helped on ${resolved.length} of ${allCoworkEvents.length} issue${allCoworkEvents.length > 1 ? 's' : ''}.`);
      for (const e of resolved) {
        lines.push(`  ✅ Step ${e.stepId}: ${escapeHtml(e.diagnosis)}`);
      }
      for (const e of failed) {
        lines.push(`  ❌ Step ${e.stepId}: still unresolved after 3 suggestions`);
      }
    } else {
      // Co Work tried but couldn't fix it — tell the user what was found
      const uniqueSteps = [...new Set(allCoworkEvents.map((e) => e.stepId))];
      lines.push(`🧠 <b>I phoned a friend</b> — consulted Co Work ${allCoworkEvents.length} time${allCoworkEvents.length > 1 ? 's' : ''} but couldn't fully resolve the issue.`);
      for (const stepId of uniqueSteps) {
        const last = allCoworkEvents.filter((e) => e.stepId === stepId).at(-1)!;
        lines.push(`  Step ${stepId} diagnosis: <i>${escapeHtml(last.diagnosis)}</i>`);
        lines.push(`  Last suggestion: ${escapeHtml(last.suggestion)}`);
      }
      lines.push('  <i>Recommend manual review of the steps marked ⚠️ above.</i>');
    }
  }

  lines.push('');
  lines.push(`<i>Took ${formatDuration(durationMs)}.</i>`);

  return lines.join('\n');
}

/**
 * Build a plain-text assistant turn that summarizes a completed task so
 * the orchestrator can write it back into conversationHistory.
 *
 * Without this, task-completion messages are delivered through Telegram
 * directly and never enter NEXUS's own memory of what it just said. On
 * a follow-up turn the LLM sees a user-only gap and re-reasons from
 * scratch — which is how NEXUS ended up refusing a Chrome-extension
 * follow-up at 8:58 PM after having shipped the extension at 8:48 PM,
 * and then denying the work entirely on the next turn (Lucas's
 * 2026-05-06 screenshot bug).
 *
 * The output is plain prose so the LLM reads it as a normal assistant
 * turn — `[Completed: ...]` brackets would have read like a system tag.
 */
export function summarizeTaskForHistory(
  plan: { title: string },
  result: TaskRunResult,
): string {
  const status = result.success
    ? 'all steps succeeded'
    : result.timedOut
      ? `timed out after ${result.completedSteps}/${result.totalSteps} steps`
      : `partial — ${result.completedSteps}/${result.totalSteps} steps completed`;

  const parts: string[] = [`I completed the task "${plan.title}" — ${status}.`];

  // Named successes + failures. Without this, a follow-up like "where is
  // the report?" lands on a vague "2/4 steps completed" message and the
  // chat-mode model can't tell what's missing — observed 2026-05-11
  // when NEXUS took a screenshot of the desktop instead of saying the
  // report step had failed three times.
  if (result.failedStepTitles && result.failedStepTitles.length > 0) {
    parts.push(`Failed steps: ${result.failedStepTitles.join('; ')}.`);
  }
  if (result.successfulStepTitles && result.successfulStepTitles.length > 0 && !result.success) {
    parts.push(`Completed steps: ${result.successfulStepTitles.join('; ')}.`);
  }
  if (result.filesProduced.length > 0) {
    parts.push(`Files created: ${result.filesProduced.join(', ')}.`);
  } else if (!result.success) {
    parts.push('No files were produced.');
  }

  return parts.join(' ');
}

/**
 * Strip Markdown that Telegram's HTML parse mode can't render, leaving
 * the plain text behind. Without this, model output containing `## headings`,
 * `---` rules, and `| pipe | tables |` shows up as literal noise in the
 * Result block (Lucas's bug screenshot from 2026-05-06).
 *
 * The output of this helper still goes through escapeHtml downstream, so we
 * deliberately produce plain text rather than HTML — emitting `<b>...</b>`
 * here would just get re-escaped.
 */
export function cleanMarkdownForTelegram(text: string): string {
  if (!text) return '';
  let out = text;

  // Remove fenced code blocks but preserve the inner content
  out = out.replace(/```[a-zA-Z0-9_+-]*\n?/g, '');
  out = out.replace(/```/g, '');

  // Drop horizontal-rule lines (---, ***, ___ on their own line)
  out = out.replace(/^\s*[-*_]{3,}\s*$/gm, '');

  // Drop pipe-table divider rows (|---|---|)
  out = out.replace(/^\s*\|[\s\-:|]+\|\s*$/gm, '');
  // Convert pipe-table data rows to plain space-separated text
  out = out.replace(/^\s*\|(.+)\|\s*$/gm, (_match, cells: string) =>
    cells.split('|').map((c) => c.trim()).filter(Boolean).join('  '),
  );

  // Strip Markdown heading markers (# … ######) but keep the heading text
  out = out.replace(/^#{1,6}\s+/gm, '');

  // Markdown images become alt text. Order matters: images BEFORE links,
  // because `![alt](url)` would otherwise match the link regex with a
  // leftover `!`.
  out = out.replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, '$1');

  // Markdown links become "text (url)" — preserves the URL for the user
  // (a click-target in Telegram) without rendering Markdown bracket syntax.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1 ($2)');

  // Blockquote markers — keep the quoted text, drop the `>` prefix.
  out = out.replace(/^>\s?/gm, '');

  // Strip emphasis markers, keeping the inner text
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  out = out.replace(/__([^_\n]+)__/g, '$1');
  out = out.replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, '$1');
  out = out.replace(/(?<!_)_(?!_)([^_\n]+?)_(?!_)/g, '$1');

  // Strip inline-code backticks (lose monospace, keep the text)
  out = out.replace(/`([^`\n]+)`/g, '$1');

  // Normalize Markdown bullets so the bullet still reads like a list
  out = out.replace(/^(\s*)[-*+]\s+/gm, '$1• ');

  // Collapse 3+ blank lines to a single paragraph break
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}

/**
 * Pick the user-facing answer text from a step's rawOutput / summary.
 * Returns "" when the content is just boilerplate (empty, "Step N completed",
 * "Task timed out") so the formatter can omit the Result block instead of
 * showing noise. Caps the result at 1500 chars so a runaway final step
 * doesn't blow Telegram's 4096-char message limit.
 */
export function pickFinalAnswer(rawOutput: string, summary: string): string {
  const candidate = (rawOutput || summary || '').trim();
  if (!candidate) return '';
  // Skip pure boilerplate that doesn't carry information.
  if (/^step \d+ completed\.?$/i.test(candidate)) return '';
  if (/^task timed out before this step could run\.?$/i.test(candidate)) return '';
  if (/^step failed after \d+ /i.test(candidate)) return '';
  // Strip Markdown so Telegram doesn't show literal `##` / `---` / `|...|`.
  // Fall back to the raw candidate if cleaning erases everything (e.g. the
  // whole answer was a horizontal rule).
  const cleaned = cleanMarkdownForTelegram(candidate) || candidate;
  // Cap for Telegram (4096 char message limit, the rest of the summary uses
  // a few hundred chars of overhead).
  const MAX = 1500;
  if (cleaned.length > MAX) {
    return cleaned.slice(0, MAX).trimEnd() + '…';
  }
  return cleaned;
}

// ─── Core Step Executor ───────────────────────────────────────────────────────

async function executeStep(
  step: TaskStep,
  plan: TaskPlan,
  originalRequest: string,
  previousContext: StepContext[],
  ai: AIManager,
  toolExecutor: ToolExecutor,
  model: string,
  maxTokens: number,
  chatId: string,
  onDetail?: (detail: string) => void,
  coworkHint?: CoWorkResponse | null,
  coworkAttemptNumber?: number,
  skillsContext?: string,
): Promise<{ success: boolean; context: StepContext; rawOutput: string; verified: boolean }> {
  const tools = toOpenAITools();
  const systemPrompt = buildStepSystemPrompt(originalRequest, plan, step, previousContext, coworkHint, coworkAttemptNumber, skillsContext);

  const loopMessages: AIMessage[] = [
    {
      role: 'user',
      content: `Execute step ${step.id}: ${step.title}\n\nGoal: ${step.description}`,
    },
  ];

  const filesWritten: string[] = [];
  const fileContents: Record<string, string> = {};
  const commandsRun: string[] = [];
  let finalContent = '';
  // Degenerate loop detection: track last N malformed call signatures
  const recentMalformedCalls: string[] = [];
  // Tool-type frequency: detect when same tool is called many times without writing any files
  const toolTypeCounts: Record<string, number> = {};

  for (let iteration = 0; iteration < MAX_STEP_ITERATIONS; iteration++) {
    let aiResponse = await withTimeout(
      ai.complete({
        messages: loopMessages,
        systemPrompt,
        model,
        maxTokens,
        temperature: 0.2,
        tools,
        tool_choice: 'auto',
      }),
      TOOL_TIMEOUT_MS,
      `ai.complete (step ${step.id}, iter ${iteration})`,
    );

    // Retry empty responses once
    if (!aiResponse.toolCalls?.length && !aiResponse.content?.trim()) {
      await delay(1500);
      aiResponse = await withTimeout(
        ai.complete({ messages: loopMessages, systemPrompt, model, maxTokens, temperature: 0.2, tools, tool_choice: 'auto' }),
        TOOL_TIMEOUT_MS,
        `ai.complete retry (step ${step.id})`,
      );
    }

    // No tool calls — step is done
    if (!aiResponse.toolCalls?.length) {
      finalContent = aiResponse.content ?? '';
      break;
    }

    // Track assistant message
    loopMessages.push({
      role: 'assistant',
      content: aiResponse.content || null,
      tool_calls: aiResponse.toolCalls,
    });

    // Execute all tool calls
    let degenerateBreak = false;
    for (const toolCall of aiResponse.toolCalls) {
      const toolName = toolCall.function.name;
      let toolArgs: Record<string, unknown> = {};

      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch (e) {
        log.debug({ e, toolName, args: toolCall.function.arguments?.slice(0, 100) }, 'Failed to parse tool arguments — using empty args');
        toolArgs = {};
      }

      // ── Detect malformed/incomplete tool calls (e.g. max_tokens truncation) ──
      let malformedError: string | null = null;
      if (toolName === 'write_file') {
        if (typeof toolArgs.path !== 'string' || !toolArgs.path) {
          malformedError = 'Error: write_file called without a "path" argument. You MUST provide both "path" and "content".';
        } else if (typeof toolArgs.content !== 'string' || toolArgs.content.length === 0) {
          malformedError = `Error: write_file called for "${toolArgs.path}" but "content" was empty or missing. This usually happens when the file content is very large. Break the content into sections and write one section at a time using multiple write_file calls. Always include the full content — never call write_file with an empty content field.`;
        }
      } else if (toolName === 'run_terminal_command') {
        if (typeof toolArgs.command !== 'string' || !toolArgs.command) {
          malformedError = 'Error: run_terminal_command called without a "command" argument. You MUST provide a "command" string.';
        }
      } else if (toolName === 'read_file') {
        if (typeof toolArgs.path !== 'string' || !toolArgs.path) {
          malformedError = 'Error: read_file called without a "path" argument.';
        }
      }

      if (malformedError) {
        // Track for degenerate loop detection
        const callSig = `${toolName}:${JSON.stringify(toolArgs)}`;
        recentMalformedCalls.push(callSig);
        // Keep only last N entries
        if (recentMalformedCalls.length > DEGENERATE_LOOP_LIMIT * 2) {
          recentMalformedCalls.shift();
        }
        // Check if same malformed call is repeating
        const repeatCount = recentMalformedCalls.filter((s) => s === callSig).length;
        if (repeatCount >= DEGENERATE_LOOP_LIMIT) {
          log.warn({ toolName, step: step.id, repeatCount }, 'Degenerate loop detected — breaking step');
          finalContent = `Step ${step.id} encountered a repeated tool error and could not complete. The file may need to be written manually or in smaller sections.`;
          loopMessages.push({
            role: 'tool',
            content: malformedError,
            tool_call_id: toolCall.id,
          });
          degenerateBreak = true;
          break;
        }

        log.warn({ toolName, step: step.id, toolArgs: Object.keys(toolArgs) }, 'Malformed tool call — missing required args');
        loopMessages.push({
          role: 'tool',
          content: malformedError + '\n\n[TOOL ERROR — do not claim success. Fix and retry with all required arguments.]',
          tool_call_id: toolCall.id,
        });
        continue;
      }

      // Track what's being done
      if (toolName === 'write_file' && typeof toolArgs.path === 'string') {
        onDetail?.(`Writing ${toolArgs.path}`);
      } else if (toolName === 'run_terminal_command' && typeof toolArgs.command === 'string') {
        onDetail?.(`Running: ${String(toolArgs.command).slice(0, 60)}`);
      } else if (toolName === 'read_file' && typeof toolArgs.path === 'string') {
        onDetail?.(`Reading ${toolArgs.path}`);
      }

      // Tool-type frequency check: if same tool called > TOOL_TYPE_LOOP_LIMIT times
      // without writing any new files, it's likely stuck in a non-productive loop
      toolTypeCounts[toolName] = (toolTypeCounts[toolName] ?? 0) + 1;
      if (
        toolTypeCounts[toolName]! > TOOL_TYPE_LOOP_LIMIT &&
        toolName !== 'write_file' &&
        filesWritten.length === 0
      ) {
        log.warn({ toolName, count: toolTypeCounts[toolName], step: step.id }, 'Tool type loop limit hit — breaking step');
        loopMessages.push({
          role: 'tool',
          content: `[LOOP GUARD] ${toolName} has been called ${toolTypeCounts[toolName]} times without producing any files. Stop and write the output files now.`,
          tool_call_id: toolCall.id,
        });
        continue;
      }

      let result: string;
      try {
        // ask_user blocks waiting for the user to reply via Telegram —
        // the standard 120s tool timeout would always kill it. Give that
        // tool a 10-minute window instead. Other tools keep the standard.
        // Per-tool wrapper timeout overrides. Same shape as the chat-mode
        // tool-call-loop overrides (kept in sync; see tool-call-loop.ts).
        // ask_user blocks on a real user reply, run_applescript can hit
        // iCloud-backed apps that lazy-load slowly.
        const toolTimeoutMs =
          toolName === 'ask_user' ? 10 * 60 * 1000 :
          toolName === 'run_applescript' ? 3 * 60 * 1000 :
          TOOL_TIMEOUT_MS;
        result = await withTimeout(
          toolExecutor.execute(toolName, toolArgs, { chatId }),
          toolTimeoutMs,
          toolName,
        );
        result = repairToolResult(result);
      } catch (err) {
        result = `Error executing ${toolName}: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Detect errors and annotate
      const isError =
        result.startsWith('Error:') ||
        /\b(ENOENT|EACCES|EPERM|ETIMEDOUT|ECONNREFUSED)\b/.test(result) ||
        result.includes('command not found') ||
        result.includes('No such file');

      if (isError) {
        result += '\n\n[TOOL ERROR — do not claim success. Diagnose and fix before continuing.]';
        log.warn({ toolName, step: step.id }, 'Tool returned error in step execution');
      }

      // Record what was done
      if (toolName === 'write_file' && typeof toolArgs.path === 'string' && !isError) {
        filesWritten.push(toolArgs.path as string);
        // Capture content snapshot for cross-step context (cap at 4K per file)
        if (typeof toolArgs.content === 'string') {
          const snap = toolArgs.content.length > 4000
            ? toolArgs.content.slice(0, 4000) + '\n// ... [truncated]'
            : toolArgs.content;
          fileContents[toolArgs.path as string] = snap;
        }
      }
      if (toolName === 'run_terminal_command' && typeof toolArgs.command === 'string' && !isError) {
        commandsRun.push(toolArgs.command as string);
      }

      loopMessages.push({
        role: 'tool',
        content: result,
        tool_call_id: toolCall.id,
      });
    }

    if (degenerateBreak) break;

    if (iteration === MAX_STEP_ITERATIONS - 1) {
      finalContent = aiResponse.content ?? `Step ${step.id} hit iteration limit.`;
    }
  }

  // ── Rescue pass: detect when model described code instead of calling write_file ──
  // If the final response contains fenced code blocks but no files were written,
  // extract and save them automatically.
  // Only enable when we can pair blocks 1:1 with paths — otherwise we risk
  // writing code to an unrelated path (e.g. `~/.bashrc` mentioned in prose).
  if (filesWritten.length === 0 && finalContent.length > 500) {
    const codeBlocks = [...finalContent.matchAll(/```(?:(\w+)\n)?([\s\S]*?)```/g)];
    // Look for a path mentioned near each code block — must be inside project dir
    const pathPattern = /[`'"]?(~\/[\w\-\/\.]+|\/[\w\-\/\.]+)/g;
    const allPaths = [...finalContent.matchAll(pathPattern)].map((m) => m[1]);
    // Filter to paths inside the project dir to prevent writing to unrelated locations
    const projectDirExpanded = plan.projectDir.replace(/^~/, process.env.HOME ?? '~');
    const mentionedPaths = allPaths.filter((p): p is string =>
      typeof p === 'string' && (p.startsWith(plan.projectDir) || p.startsWith(projectDirExpanded))
    );

    // Safety: only run rescue pass if we have one path per code block (or exactly one of each)
    const safeToRun = codeBlocks.length > 0 && mentionedPaths.length > 0 &&
      (codeBlocks.length === mentionedPaths.length || (codeBlocks.length === 1 && mentionedPaths.length === 1));

    if (safeToRun) {
      log.warn({ step: step.id, blocks: codeBlocks.length, paths: mentionedPaths.length }, 'Rescue pass: model described code without calling write_file — auto-saving');

      for (let i = 0; i < codeBlocks.length; i++) {
        const content = codeBlocks[i]?.[2];
        if (!content || content.trim().length < 50) continue;

        // Match code block to path by index, or use project dir with inferred name
        let targetPath = mentionedPaths[i] ?? mentionedPaths[0];
        if (!targetPath) continue;

        // Expand ~ properly
        targetPath = targetPath.replace(/[.,;:!?)]+$/, '');

        try {
          const writeResult = await toolExecutor.execute('write_file', { path: targetPath, content });
          if (!writeResult.startsWith('Error')) {
            filesWritten.push(targetPath);
            fileContents[targetPath] = content.length > 4000 ? content.slice(0, 4000) + '\n// ... [truncated]' : content;
            log.info({ path: targetPath }, 'Rescue pass: auto-saved code block');
          }
        } catch (err) {
          log.warn({ err, path: targetPath }, 'Rescue pass: auto-save failed');
        }
      }
    }
  }

  // ── Verification pass ────────────────────────────────────────────────────
  // Read back written files and confirm they are complete and correct.
  // Also fire when a step produced no files BUT its title implies output —
  // covers the "Generate final report and open in Chrome" case where the
  // model ran `open` on a template instead of producing a rendered file.
  let verified = true;
  let verifyNote = '';
  if (filesWritten.length > 0 || stepImpliesOutput(step.title)) {
    try {
      const vResult = await verifyStep(step, filesWritten, ai, toolExecutor, model);
      verified = vResult.passed;
      verifyNote = vResult.summary;
      if (!verified) {
        log.warn({ step: step.id, summary: vResult.summary }, 'Verification pass found problems');
      } else {
        log.debug({ step: step.id }, 'Verification pass: OK');
      }
    } catch (err) {
      log.debug({ err, step: step.id }, 'Verification pass failed — treating as passed');
    }
  }

  // Build step context for future steps. R3 (2026-05-06): bumped the cap
  // from 250 → 1500. Earlier 250-char window was clipping mid-sentence on
  // any step that produced a substantive answer, so step N+1 saw a
  // truncated brief instead of what step N actually found. 1500 is enough
  // to carry a typical step's reasoning + key findings without bloating
  // the next step's prompt — a 10-step plan still keeps prevSummary under
  // ~15K chars, well within token budget. Newlines are still collapsed so
  // each step renders on a single "Step N: ..." line in prevSummary.
  const STEP_SUMMARY_CAP = 1500;
  const context: StepContext = {
    filesWritten,
    fileContents,
    commandsRun,
    summary: (finalContent.slice(0, STEP_SUMMARY_CAP).replace(/\n+/g, ' ') || `${step.title} completed`) +
      (verifyNote ? ` [verify: ${verifyNote.slice(0, 80)}]` : ''),
  };

  return {
    success: verified,
    context,
    rawOutput: finalContent,
    verified,
  };
}

// ─── Main Task Runner ─────────────────────────────────────────────────────────

export async function runTask(opts: {
  plan: TaskPlan;
  originalRequest: string;
  chatId: string;
  ai: AIManager;
  toolExecutor: ToolExecutor;
  telegram: TelegramGateway;
  model: string;
  /** Optional: model strings used to resolve step.model tier hints. */
  fastModel?: string;
  opusModel?: string;
  maxTokens: number;
  coordinatorMode?: boolean;
  /** Pre-selected relevant skill bodies to inject into every step prompt */
  skillsContext?: string;
}): Promise<TaskRunResult> {
  const { plan, originalRequest, chatId, ai, toolExecutor, telegram, model, fastModel, opusModel, coordinatorMode, skillsContext } = opts;
  if (coordinatorMode) {
    log.info({ title: plan.title, steps: plan.steps.length }, 'Coordinator mode — parallel step execution');
  }
  // Task steps need more room than regular chat — large files can easily hit 16K tokens.
  // Use at least 32768 tokens per step so write_file content is never truncated.
  const maxTokens = Math.max(opts.maxTokens, 32768);
  const startTime = Date.now();
  let taskTimedOut = false;

  events.emit({ type: 'task.planned', title: plan.title, stepCount: plan.steps.length, coordinatorMode: !!coordinatorMode });
  events.emit({ type: 'task.started', title: plan.title });

  const completedIds = new Set<number>();
  const stepTimings = new Map<number, number>();
  const allFilesProduced: string[] = [];
  const stepResults: Array<{ step: TaskStep; success: boolean; summary: string; rawOutput: string }> = [];
  const previousContext: StepContext[] = [];
  const allCoworkEvents: CoWorkEvent[] = [];
  let coworkTotalUsed = 0; // Global Co Work budget — capped at MAX_COWORK_TOTAL for the whole task

  // Co Work agent — instantiated once per task, reused across steps
  const coworkAgent = new CoWorkAgent(ai);

  let progressMsgId: number | null = null;
  let lastEditTime = 0;

  // ── Send plan immediately ─────────────────────────────────────────────────
  const initialPlanMsg = formatPlanMessage(plan, completedIds, plan.steps[0]!.id, stepTimings);

  try {
    const msg = await telegram.sendStreamingMessage(chatId, initialPlanMsg);
    progressMsgId = msg;
    // Re-send with HTML formatting
    if (progressMsgId) {
      await telegram.finalizeStreamingMessage(chatId, progressMsgId, initialPlanMsg);
    }
  } catch (err) {
    log.warn({ err }, 'Failed to send initial plan message');
  }

  // Helper: edit progress message (throttled)
  const updateProgress = async (detail?: string, activeId?: number | null) => {
    if (!progressMsgId) return;

    const now = Date.now();
    if (now - lastEditTime < TELEGRAM_EDIT_THROTTLE_MS) return;
    lastEditTime = now;

    const msg = formatPlanMessage(
      plan,
      completedIds,
      activeId ?? null,
      stepTimings,
      detail,
    );

    try {
      await telegram.finalizeStreamingMessage(chatId, progressMsgId, msg);
    } catch {
      // Ignore rate limit errors on progress updates
    }
  };

  // ── Execute steps (parallel in coordinator mode, sequential otherwise) ───────
  if (coordinatorMode && plan.steps.length > 1) {
    // Coordinator: last step is always aggregation — run all others in parallel first
    const parallelSteps = plan.steps.slice(0, -1);
    const aggregateStep = plan.steps[plan.steps.length - 1]!;

    await updateProgress(`Running ${parallelSteps.length} agents in parallel...`, parallelSteps[0]!.id);

    const parallelResults = await Promise.allSettled(
      parallelSteps.map((step) =>
        executeStep(step, plan, originalRequest, [], ai, toolExecutor, resolveStepModel(step.model, model, fastModel, opusModel), maxTokens, chatId),
      ),
    );

    // Collect parallel results
    for (let i = 0; i < parallelSteps.length; i++) {
      const step = parallelSteps[i]!;
      const res = parallelResults[i]!;
      const stepDuration = 0;
      if (res.status === 'fulfilled') {
        previousContext.push(res.value.context);
        allFilesProduced.push(...res.value.context.filesWritten);
        completedIds.add(step.id);
        stepTimings.set(step.id, stepDuration);
        stepResults.push({ step, success: res.value.success, summary: res.value.context.summary, rawOutput: res.value.rawOutput });
      } else {
        completedIds.add(step.id);
        stepResults.push({ step, success: false, summary: String(res.reason), rawOutput: '' });
      }
    }

    await updateProgress('Combining results...', aggregateStep.id);

    // Run the aggregate/combine step sequentially with all prior context
    try {
      const aggResult = await executeStep(
        aggregateStep, plan, originalRequest, previousContext,
        ai, toolExecutor, resolveStepModel(aggregateStep.model, model, fastModel, opusModel), maxTokens, chatId,
      );
      previousContext.push(aggResult.context);
      allFilesProduced.push(...aggResult.context.filesWritten);
      completedIds.add(aggregateStep.id);
      stepTimings.set(aggregateStep.id, 0);
      stepResults.push({ step: aggregateStep, success: aggResult.success, summary: aggResult.context.summary, rawOutput: aggResult.rawOutput });
    } catch (err) {
      stepResults.push({ step: aggregateStep, success: false, summary: String(err), rawOutput: '' });
    }

    await updateProgress(undefined, null);

  } else {
    // Standard: sequential execution
    for (const step of plan.steps) {
      const stepStart = Date.now();
      log.info({ stepId: step.id, title: step.title }, 'Executing task step');

      await updateProgress(`Starting: ${step.title}`, step.id);

      // Emit task.step.started so Introspection + other subscribers can
      // observe per-step progress (FIND-CMP-01).
      events.emit({
        type: 'task.step.started',
        planTitle: plan.title,
        stepId: step.id,
        stepTitle: step.title,
      });

      let stepSuccess = false;
      let stepSummary = '';
      // Full LLM response for this step. Surfaces in the final summary as
      // the visible "Result" — without this, NEXUS replies only with the
      // step checklist and the user has to ask "but what was the answer?"
      let stepRawOutput = '';
      let stepAttempts = 0;
      let stepLastError = '';

      // Check per-task deadline
      if (Date.now() - startTime > TASK_TIMEOUT_MS) {
        log.warn({ taskTitle: plan.title, elapsed: Date.now() - startTime }, 'Task deadline exceeded — stopping');
        taskTimedOut = true;
        stepSummary = 'Task timed out before this step could run.';
        stepSuccess = false;
        completedIds.add(step.id);
        stepTimings.set(step.id, 0);
        stepResults.push({ step, success: false, summary: stepSummary, rawOutput: '' });
        break;
      }

      const onDetail = (detail: string) => {
        const now = Date.now();
        if (now - lastEditTime >= TELEGRAM_EDIT_THROTTLE_MS && progressMsgId) {
          lastEditTime = now;
          telegram.finalizeStreamingMessage(
            chatId,
            progressMsgId,
            formatPlanMessage(plan, completedIds, step.id, stepTimings, detail),
          ).catch((e) => log.debug({ e }, 'Failed to update progress message'));
        }
      };

      // Heartbeat: if a step runs longer than 2 minutes, send an interim
      // "still working" message so the user knows we're not hung.
      let heartbeatCount = 0;
      const heartbeatTimer = setInterval(() => {
        heartbeatCount++;
        const minutes = Math.round((heartbeatCount * HEARTBEAT_INTERVAL_MS) / 60_000);
        telegram.sendMessage(
          chatId,
          `⏳ Still working on step ${step.id} (${escapeHtml(step.title)}) — ${minutes}m elapsed`,
          { parseMode: 'HTML' },
        ).catch((e) => log.debug({ e }, 'Failed to send heartbeat'));
      }, HEARTBEAT_INTERVAL_MS);

      // ── Phase 1: Standard retries ────────────────────────────────────────
      let lastErrorContext = '';
      let lastFilesWritten: string[] = [];
      let lastCommandsRun: string[] = [];

      try {
      for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
        stepAttempts = attempt + 1;
        try {
          const result = await withTimeout(
            executeStep(step, plan, originalRequest, previousContext, ai, toolExecutor, resolveStepModel(step.model, model, fastModel, opusModel), maxTokens, chatId, onDetail, undefined, undefined, skillsContext),
            STEP_TIMEOUT_MS, `step ${step.id}: ${step.title}`,
          );

          previousContext.push(result.context);
          allFilesProduced.push(...result.context.filesWritten);
          stepSummary = result.context.summary;
          stepRawOutput = result.rawOutput;
          stepSuccess = result.success;
          lastFilesWritten = result.context.filesWritten;
          lastCommandsRun = result.context.commandsRun;

          if (stepSuccess) break;

          // Completed but verification failed — record for Co Work
          lastErrorContext = result.rawOutput.slice(0, 800) || 'Step completed but verification failed — output was empty, incomplete, or contained errors.';
          stepLastError = lastErrorContext;

          // Emit a task.step.failed for this attempt so observers see retries.
          events.emit({
            type: 'task.step.failed',
            planTitle: plan.title,
            stepId: step.id,
            error: lastErrorContext,
            attempt: stepAttempts,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ err: msg, stepId: step.id, attempt }, 'Step execution error');
          lastErrorContext = msg;
          stepLastError = msg;

          events.emit({
            type: 'task.step.failed',
            planTitle: plan.title,
            stepId: step.id,
            error: msg,
            attempt: stepAttempts,
          });

          if (attempt < MAX_STEP_RETRIES) {
            await updateProgress(`Retrying step ${step.id} (attempt ${attempt + 2})...`, step.id);
            await delay(2000);
          } else {
            stepSummary = `Step failed after ${MAX_STEP_RETRIES + 1} attempts: ${msg}`;
          }
        }
      }

      // ── Phase 2: Co Work (if phase 1 failed) ────────────────────────────
      if (!stepSuccess && coworkTotalUsed < MAX_COWORK_TOTAL) {
        const stepCoworkEvents: CoWorkEvent[] = [];
        const previousSuggestions: string[] = [];

        for (let cwAttempt = 1; cwAttempt <= MAX_COWORK_ATTEMPTS && coworkTotalUsed < MAX_COWORK_TOTAL; cwAttempt++) {
          log.info({ stepId: step.id, cwAttempt }, 'Activating Co Work');
          await updateProgress(`🧠 Phoning a friend... (Co Work ${cwAttempt}/${MAX_COWORK_ATTEMPTS})`, step.id);

          // Notify user that Co Work is active
          try {
            await telegram.sendMessage(
              chatId,
              `🧠 <i>Step ${step.id} hit a wall — consulting Co Work (${cwAttempt}/${MAX_COWORK_ATTEMPTS})…</i>`,
              { parseMode: 'HTML' },
            );
          } catch (e) { log.debug({ e }, 'Failed to send Co Work notification'); }

          // Consult Co Work
          let hint: import('../agents/cowork.js').CoWorkResponse;
          try {
            hint = await coworkAgent.consult({
              taskTitle: plan.title,
              stepTitle: step.title,
              stepGoal: step.description,
              originalRequest,
              errorContext: lastErrorContext,
              filesWritten: lastFilesWritten,
              commandsRun: lastCommandsRun,
              previousSuggestions,
              attemptNumber: cwAttempt,
            });
          } catch (coworkErr) {
            log.warn({ coworkErr, stepId: step.id }, 'Co Work consultation failed — skipping');
            break;
          }

          previousSuggestions.push(hint.suggestion);

          // Surface the diagnosis + suggestion to the user — previously internal-only.
          // This makes CoWork feel transparent instead of a silent "magic recovery".
          try {
            const confidencePct = Math.round((hint.confidence ?? 0.5) * 100);
            await telegram.sendMessage(
              chatId,
              `🧠 <b>Co Work diagnosed it</b> (${confidencePct}% confidence):\n` +
                `<i>${escapeHtml(hint.diagnosis)}</i>\n\n` +
                `💡 ${escapeHtml(hint.suggestion)}\n\n` +
                `<i>Retrying step ${step.id} with this approach…</i>`,
              { parseMode: 'HTML' },
            );
          } catch (e) { log.debug({ e }, 'Failed to send Co Work diagnosis'); }

          // Try the step again with Co Work hint injected
          try {
            const result = await withTimeout(
              executeStep(step, plan, originalRequest, previousContext, ai, toolExecutor, resolveStepModel(step.model, model, fastModel, opusModel), maxTokens, chatId, onDetail, hint, cwAttempt, skillsContext),
              STEP_TIMEOUT_MS, `step ${step.id} cowork-${cwAttempt}`,
            );

            previousContext.push(result.context);
            allFilesProduced.push(...result.context.filesWritten);
            stepSummary = result.context.summary;
            stepSuccess = result.success;
            lastFilesWritten = result.context.filesWritten;
            lastCommandsRun = result.context.commandsRun;

            const outcome = stepSuccess ? 'resolved' : 'failed';
            const event: CoWorkEvent = {
              stepId: step.id,
              attemptNumber: cwAttempt,
              diagnosis: hint.diagnosis,
              suggestion: hint.suggestion,
              outcome,
            };
            stepCoworkEvents.push(event);
            coworkTotalUsed++;

            if (stepSuccess) {
              log.info({ stepId: step.id, cwAttempt }, 'Co Work resolved the step');
              try {
                await telegram.sendMessage(
                  chatId,
                  `✅ <i>Co Work suggestion worked — step ${step.id} resolved.</i>`,
                  { parseMode: 'HTML' },
                );
              } catch (e) { log.debug({ e }, 'Failed to send Co Work success notification'); }
              break;
            }

            // Still failing — update error context for next Co Work round
            lastErrorContext = result.rawOutput.slice(0, 800) || `Co Work suggestion applied but step still failed.`;

          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            lastErrorContext = msg;
            stepCoworkEvents.push({
              stepId: step.id,
              attemptNumber: cwAttempt,
              diagnosis: hint.diagnosis,
              suggestion: hint.suggestion,
              outcome: 'failed',
            });
            coworkTotalUsed++;
            log.warn({ err: msg, stepId: step.id, cwAttempt }, 'Step still failed after Co Work suggestion');
          }

          if (!stepSuccess && cwAttempt === MAX_COWORK_ATTEMPTS) {
            // All Co Work attempts exhausted
            log.warn({ stepId: step.id }, 'Co Work exhausted all attempts — step marked as failed');
            try {
              await telegram.sendMessage(
                chatId,
                `⚠️ <i>I phoned a friend ${MAX_COWORK_ATTEMPTS} times for step ${step.id} — we couldn't crack it. Moving on and flagging for your review.</i>`,
                { parseMode: 'HTML' },
              );
            } catch (e) { log.debug({ e }, 'Failed to send Co Work exhausted notification'); }
            stepSummary = `Step failed after ${MAX_COWORK_ATTEMPTS} Co Work consultations. Last diagnosis: ${hint.diagnosis}`;
          }
        }

        allCoworkEvents.push(...stepCoworkEvents);
      }
      } finally {
        // Always clear the heartbeat timer, even if the step threw
        clearInterval(heartbeatTimer);
      }

      const stepDuration = Date.now() - stepStart;
      completedIds.add(step.id);
      stepTimings.set(step.id, stepDuration);
      stepResults.push({ step, success: stepSuccess, summary: stepSummary, rawOutput: stepRawOutput });

      // Emit completion event. (task.step.failed may have already fired for
      // individual retry attempts above — this event signals the STEP-level
      // outcome, regardless of attempts.)
      if (stepSuccess) {
        events.emit({
          type: 'task.step.completed',
          planTitle: plan.title,
          stepId: step.id,
          success: true,
          durationMs: stepDuration,
          filesWritten: lastFilesWritten,
        });
      }
      // Mark variable as used — silences strict lint; kept for observability plumbing.
      void stepLastError;

      log.info({ stepId: step.id, durationMs: stepDuration, success: stepSuccess }, 'Step complete');

      const nextStep = plan.steps.find((s) => !completedIds.has(s.id));
      await updateProgress(undefined, nextStep?.id ?? null);
    }
  }

  // ── Final progress update ─────────────────────────────────────────────────
  if (progressMsgId) {
    const doneMsg = formatPlanMessage(plan, completedIds, null, stepTimings);
    try {
      await telegram.finalizeStreamingMessage(chatId, progressMsgId, doneMsg);
    } catch { /* ignore */ }
  }

  // ── Send final summary as a separate message ──────────────────────────────
  const totalDuration = Date.now() - startTime;
  const uniqueFiles = [...new Set(allFilesProduced)];
  const summaryMsg = formatFinalSummary(plan, uniqueFiles, totalDuration, stepResults, allCoworkEvents);

  try {
    await telegram.sendMessage(chatId, summaryMsg, { parseMode: 'HTML' });
  } catch (err) {
    log.warn({ err }, 'Failed to send final summary message');
  }

  const finalSuccess = !taskTimedOut && stepResults.every((r) => r.success);
  const stepsCompleted = stepResults.filter((r) => r.success).length;
  events.emit({
    type: 'task.completed',
    title: plan.title,
    success: finalSuccess,
    durationMs: totalDuration,
    stepsCompleted,
    totalSteps: plan.steps.length,
    filesProduced: uniqueFiles,
  });

  // Split step titles by outcome so the chat-mode model can answer
  // follow-ups about what succeeded vs failed without re-checking files.
  const successfulStepTitles = stepResults.filter((r) => r.success).map((r) => r.step.title);
  const failedStepTitles = stepResults.filter((r) => !r.success).map((r) => r.step.title);

  return {
    success: finalSuccess,
    completedSteps: stepsCompleted,
    totalSteps: plan.steps.length,
    projectDir: plan.projectDir,
    filesProduced: uniqueFiles,
    summary: summaryMsg,
    durationMs: totalDuration,
    timedOut: taskTimedOut,
    coworkEvents: allCoworkEvents,
    successfulStepTitles,
    failedStepTitles,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`"${label}" timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
