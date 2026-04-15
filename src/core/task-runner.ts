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

const log = createLogger('TaskRunner');

const MAX_STEP_ITERATIONS    = 25;       // Per-step tool loop limit
const MAX_STEP_RETRIES       = 1;        // Standard retries before Co Work activates
const MAX_COWORK_ATTEMPTS    = 3;        // Max Co Work consultations per step
const TOOL_TIMEOUT_MS        = 120_000;  // Per-tool call timeout
const STEP_TIMEOUT_MS        = 5 * 60 * 1000;  // 5 min max per step
const TASK_TIMEOUT_MS        = 25 * 60 * 1000; // 25 min max per whole task
const TELEGRAM_EDIT_THROTTLE_MS = 1200;  // Telegram rate limit buffer
const DEGENERATE_LOOP_LIMIT  = 3;        // Break if same malformed tool call repeats N times
const TOOL_TYPE_LOOP_LIMIT   = 8;        // Break if same tool type called > N times without progress

// ─── Types ────────────────────────────────────────────────────────────────────

interface StepContext {
  filesWritten: string[];
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
}

// ─── Step System Prompt ───────────────────────────────────────────────────────

function buildStepSystemPrompt(
  originalRequest: string,
  plan: TaskPlan,
  step: TaskStep,
  previousContext: StepContext[],
  coworkHint?: CoWorkResponse | null,
  coworkAttemptNumber?: number,
): string {
  const prevSummary = previousContext.length > 0
    ? previousContext.map((c, i) => `Step ${i + 1}: ${c.summary}${c.filesWritten.length > 0 ? ` [Files: ${c.filesWritten.join(', ')}]` : ''}`).join('\n')
    : 'None — this is the first step.';

  const agentHint = step.agent
    ? `\nAGENT FOCUS: This step is best handled with ${step.agent} capabilities — prioritize those tools.`
    : '';

  const coworkSection = coworkHint
    ? formatCoWorkHint(coworkHint, coworkAttemptNumber ?? 1)
    : '';

  return `You are NEXUS, a CLI-grade AI agent executing a task on macOS.

ORIGINAL REQUEST: ${originalRequest}

FULL PLAN: "${plan.title}"
Project directory: ${plan.projectDir}
Total steps: ${plan.steps.length}

CURRENT STEP: ${step.id} of ${plan.steps.length}
STEP TITLE: ${step.title}
STEP GOAL: ${step.description}${agentHint}

PREVIOUS STEPS COMPLETED:
${prevSummary}
${coworkSection}
━━━ RULES — READ EVERY ONE ━━━

1. TOOLS ONLY. Never put code or file content in your response text. If this step requires writing a file, call write_file. If it requires running a command, call run_terminal_command. Do NOT describe, explain, or show code in your message — just call the tool.

2. COMPLETE FILES. Every write_file call must contain the FULL, working file content. No stubs, no "// TODO", no placeholders, no truncation. If a file is 500 lines, write all 500 lines.

3. ABSOLUTE PATHS. Always use ~/... paths. Project files go in ${plan.projectDir}/

4. VERIFY WRITES. After every write_file call, immediately call read_file on the same path to confirm it was saved.

5. FIX ERRORS. If a tool returns an error, diagnose it and retry with a corrected approach. Never claim success after an error.

6. ONE STEP ONLY. Complete this step and stop. Do not do future steps.

7. BRIEF REPORT. After all tool calls, write 1-2 sentences saying what was done. Do not include code.

macOS notes:
- Shell: /bin/zsh. No GNU-only flags. No declare -A.
- Python paths: os.path.expanduser('~/...')
- Make scripts executable: chmod +x <script>`;
}

// ─── Verification Prompt ──────────────────────────────────────────────────────

function buildVerifyPrompt(step: TaskStep, filesWritten: string[]): string {
  if (filesWritten.length === 0) {
    return `Verify that step "${step.title}" was completed successfully. Check for any output or side effects.`;
  }
  return `Verify step "${step.title}" is complete. Use read_file to read back these files and confirm they have proper, complete content (not empty, not placeholder): ${filesWritten.join(', ')}. Report what you found.`;
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
  if (filesWritten.length === 0) return { passed: true, summary: 'No files to verify.' };

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

  // Verification passes if the LLM didn't flag problems
  const lowerContent = lastContent.toLowerCase();
  const failed = lowerContent.includes('empty') || lowerContent.includes('placeholder') ||
    lowerContent.includes('incomplete') || lowerContent.includes('missing') ||
    lowerContent.includes('error') || lowerContent.includes('not found');

  return { passed: !failed, summary: lastContent.slice(0, 300) || 'Verified.' };
}

// ─── Progress Message Helpers ─────────────────────────────────────────────────

function formatFinalSummary(
  plan: TaskPlan,
  allFiles: string[],
  durationMs: number,
  stepResults: Array<{ step: TaskStep; success: boolean; summary: string }>,
  allCoworkEvents: CoWorkEvent[],
): string {
  const overallSuccess = stepResults.every((r) => r.success);
  const titleIcon = overallSuccess ? '✅' : '⚠️';
  const lines: string[] = [
    `${titleIcon} <b>${escapeHtml(plan.title)} — ${overallSuccess ? 'Done' : 'Partial'}</b>`,
    '',
  ];

  for (const r of stepResults) {
    const icon = r.success ? '✅' : '⚠️';
    lines.push(`${icon} ${r.step.id}. ${escapeHtml(r.step.title)}`);
  }

  if (allFiles.length > 0) {
    lines.push('');
    lines.push('<b>Files created:</b>');
    for (const f of allFiles) {
      lines.push(`  <code>${escapeHtml(f)}</code>`);
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
  lines.push(`<i>Completed in ${(durationMs / 1000).toFixed(1)}s</i>`);

  return lines.join('\n');
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
  onDetail?: (detail: string) => void,
  coworkHint?: CoWorkResponse | null,
  coworkAttemptNumber?: number,
): Promise<{ success: boolean; context: StepContext; rawOutput: string; verified: boolean }> {
  const tools = toOpenAITools();
  const systemPrompt = buildStepSystemPrompt(originalRequest, plan, step, previousContext, coworkHint, coworkAttemptNumber);

  const loopMessages: AIMessage[] = [
    {
      role: 'user',
      content: `Execute step ${step.id}: ${step.title}\n\nGoal: ${step.description}`,
    },
  ];

  const filesWritten: string[] = [];
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
        result = await withTimeout(
          toolExecutor.execute(toolName, toolArgs),
          TOOL_TIMEOUT_MS,
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
  if (filesWritten.length === 0 && finalContent.length > 500) {
    const codeBlocks = [...finalContent.matchAll(/```(?:(\w+)\n)?([\s\S]*?)```/g)];
    // Look for a path mentioned near each code block
    const pathPattern = /[`'"]?(~\/[\w\-\/\.]+|\/[\w\-\/\.]+)/g;
    const mentionedPaths = [...finalContent.matchAll(pathPattern)].map((m) => m[1]);

    if (codeBlocks.length > 0 && mentionedPaths.length > 0) {
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
  let verified = true;
  let verifyNote = '';
  if (filesWritten.length > 0) {
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

  // Build step context for future steps
  const context: StepContext = {
    filesWritten,
    commandsRun,
    summary: (finalContent.slice(0, 250).replace(/\n+/g, ' ') || `${step.title} completed`) +
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
  maxTokens: number;
  coordinatorMode?: boolean;
}): Promise<TaskRunResult> {
  const { plan, originalRequest, chatId, ai, toolExecutor, telegram, model, coordinatorMode } = opts;
  if (coordinatorMode) {
    log.info({ title: plan.title, steps: plan.steps.length }, 'Coordinator mode — parallel step execution');
  }
  // Task steps need more room than regular chat — large files can easily hit 16K tokens.
  // Use at least 32768 tokens per step so write_file content is never truncated.
  const maxTokens = Math.max(opts.maxTokens, 32768);
  const startTime = Date.now();
  let taskTimedOut = false;

  const completedIds = new Set<number>();
  const stepTimings = new Map<number, number>();
  const allFilesProduced: string[] = [];
  const stepResults: Array<{ step: TaskStep; success: boolean; summary: string }> = [];
  const previousContext: StepContext[] = [];
  const allCoworkEvents: CoWorkEvent[] = [];

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
        executeStep(step, plan, originalRequest, [], ai, toolExecutor, model, maxTokens),
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
        stepResults.push({ step, success: res.value.success, summary: res.value.context.summary });
      } else {
        completedIds.add(step.id);
        stepResults.push({ step, success: false, summary: String(res.reason) });
      }
    }

    await updateProgress('Combining results...', aggregateStep.id);

    // Run the aggregate/combine step sequentially with all prior context
    try {
      const aggResult = await executeStep(
        aggregateStep, plan, originalRequest, previousContext,
        ai, toolExecutor, model, maxTokens,
      );
      previousContext.push(aggResult.context);
      allFilesProduced.push(...aggResult.context.filesWritten);
      completedIds.add(aggregateStep.id);
      stepTimings.set(aggregateStep.id, 0);
      stepResults.push({ step: aggregateStep, success: aggResult.success, summary: aggResult.context.summary });
    } catch (err) {
      stepResults.push({ step: aggregateStep, success: false, summary: String(err) });
    }

    await updateProgress(undefined, null);

  } else {
    // Standard: sequential execution
    for (const step of plan.steps) {
      const stepStart = Date.now();
      log.info({ stepId: step.id, title: step.title }, 'Executing task step');

      await updateProgress(`Starting: ${step.title}`, step.id);

      let stepSuccess = false;
      let stepSummary = '';

      // Check per-task deadline
      if (Date.now() - startTime > TASK_TIMEOUT_MS) {
        log.warn({ taskTitle: plan.title, elapsed: Date.now() - startTime }, 'Task deadline exceeded — stopping');
        taskTimedOut = true;
        stepSummary = 'Task timed out before this step could run.';
        stepSuccess = false;
        completedIds.add(step.id);
        stepTimings.set(step.id, 0);
        stepResults.push({ step, success: false, summary: stepSummary });
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

      // ── Phase 1: Standard retries ────────────────────────────────────────
      let lastErrorContext = '';
      let lastFilesWritten: string[] = [];
      let lastCommandsRun: string[] = [];

      for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
        try {
          const result = await withTimeout(
            executeStep(step, plan, originalRequest, previousContext, ai, toolExecutor, model, maxTokens, onDetail),
            STEP_TIMEOUT_MS, `step ${step.id}: ${step.title}`,
          );

          previousContext.push(result.context);
          allFilesProduced.push(...result.context.filesWritten);
          stepSummary = result.context.summary;
          stepSuccess = result.success;
          lastFilesWritten = result.context.filesWritten;
          lastCommandsRun = result.context.commandsRun;

          if (stepSuccess) break;

          // Completed but verification failed — record for Co Work
          lastErrorContext = result.rawOutput.slice(0, 800) || 'Step completed but verification failed — output was empty, incomplete, or contained errors.';
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ err: msg, stepId: step.id, attempt }, 'Step execution error');
          lastErrorContext = msg;

          if (attempt < MAX_STEP_RETRIES) {
            await updateProgress(`Retrying step ${step.id} (attempt ${attempt + 2})...`, step.id);
            await delay(2000);
          } else {
            stepSummary = `Step failed after ${MAX_STEP_RETRIES + 1} attempts: ${msg}`;
          }
        }
      }

      // ── Phase 2: Co Work (if phase 1 failed) ────────────────────────────
      if (!stepSuccess) {
        const stepCoworkEvents: CoWorkEvent[] = [];
        const previousSuggestions: string[] = [];

        for (let cwAttempt = 1; cwAttempt <= MAX_COWORK_ATTEMPTS; cwAttempt++) {
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

          // Try the step again with Co Work hint injected
          try {
            const result = await withTimeout(
              executeStep(step, plan, originalRequest, previousContext, ai, toolExecutor, model, maxTokens, onDetail, hint, cwAttempt),
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

      const stepDuration = Date.now() - stepStart;
      completedIds.add(step.id);
      stepTimings.set(step.id, stepDuration);
      stepResults.push({ step, success: stepSuccess, summary: stepSummary });

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
  const summaryMsg = formatFinalSummary(plan, uniqueFiles, totalDuration, stepResults);

  try {
    await telegram.sendMessage(chatId, summaryMsg, { parseMode: 'HTML' });
  } catch (err) {
    log.warn({ err }, 'Failed to send final summary message');
  }

  return {
    success: !taskTimedOut && stepResults.every((r) => r.success),
    completedSteps: stepResults.filter((r) => r.success).length,
    totalSteps: plan.steps.length,
    projectDir: plan.projectDir,
    filesProduced: uniqueFiles,
    summary: summaryMsg,
    durationMs: totalDuration,
    timedOut: taskTimedOut,
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
