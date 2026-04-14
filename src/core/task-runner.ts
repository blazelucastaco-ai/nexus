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

const log = createLogger('TaskRunner');

const MAX_STEP_ITERATIONS = 25;  // Per-step tool loop limit
const MAX_STEP_RETRIES    = 2;   // Retry a failing step up to N times
const TOOL_TIMEOUT_MS     = 120_000;
const TELEGRAM_EDIT_THROTTLE_MS = 1200; // Telegram rate limit buffer
const DEGENERATE_LOOP_LIMIT = 3; // Break if same malformed tool call repeats N times

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
}

// ─── Step System Prompt ───────────────────────────────────────────────────────

function buildStepSystemPrompt(
  originalRequest: string,
  plan: TaskPlan,
  step: TaskStep,
  previousContext: StepContext[],
): string {
  const prevSummary = previousContext.length > 0
    ? previousContext.map((c, i) => `Step ${i + 1}: ${c.summary}${c.filesWritten.length > 0 ? ` [Files: ${c.filesWritten.join(', ')}]` : ''}`).join('\n')
    : 'None — this is the first step.';

  const agentHint = step.agent
    ? `\nAGENT FOCUS: This step is best handled with ${step.agent} capabilities — prioritize those tools.`
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

// ─── Progress Message Helpers ─────────────────────────────────────────────────

function formatFinalSummary(
  plan: TaskPlan,
  allFiles: string[],
  durationMs: number,
  stepResults: Array<{ step: TaskStep; success: boolean; summary: string }>,
): string {
  const lines: string[] = [
    `✅ <b>${escapeHtml(plan.title)} — Done</b>`,
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
): Promise<{ success: boolean; context: StepContext; rawOutput: string }> {
  const tools = toOpenAITools();
  const systemPrompt = buildStepSystemPrompt(originalRequest, plan, step, previousContext);

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

  // Build step context for future steps
  const context: StepContext = {
    filesWritten,
    commandsRun,
    summary: finalContent.slice(0, 300).replace(/\n+/g, ' ') || `${step.title} completed`,
  };

  return {
    success: true,
    context,
    rawOutput: finalContent,
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

  const completedIds = new Set<number>();
  const stepTimings = new Map<number, number>();
  const allFilesProduced: string[] = [];
  const stepResults: Array<{ step: TaskStep; success: boolean; summary: string }> = [];
  const previousContext: StepContext[] = [];

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

      for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
        try {
          const result = await executeStep(
            step,
            plan,
            originalRequest,
            previousContext,
            ai,
            toolExecutor,
            model,
            maxTokens,
            (detail) => {
              const now = Date.now();
              if (now - lastEditTime >= TELEGRAM_EDIT_THROTTLE_MS && progressMsgId) {
                lastEditTime = now;
                telegram.finalizeStreamingMessage(
                  chatId,
                  progressMsgId,
                  formatPlanMessage(plan, completedIds, step.id, stepTimings, detail),
                ).catch((e) => log.debug({ e }, 'Failed to update progress message'));
              }
            },
          );

          previousContext.push(result.context);
          allFilesProduced.push(...result.context.filesWritten);
          stepSummary = result.context.summary;
          stepSuccess = result.success;
          break;
        } catch (err) {
          log.warn({ err, stepId: step.id, attempt }, 'Step execution error');
          if (attempt < MAX_STEP_RETRIES) {
            await updateProgress(`Retrying step ${step.id} (attempt ${attempt + 2})...`, step.id);
            await delay(2000);
          } else {
            stepSummary = `Step failed after ${MAX_STEP_RETRIES + 1} attempts: ${err instanceof Error ? err.message : String(err)}`;
            stepSuccess = false;
          }
        }
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
    success: stepResults.every((r) => r.success),
    completedSteps: stepResults.filter((r) => r.success).length,
    totalSteps: plan.steps.length,
    projectDir: plan.projectDir,
    filesProduced: uniqueFiles,
    summary: summaryMsg,
    durationMs: totalDuration,
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
