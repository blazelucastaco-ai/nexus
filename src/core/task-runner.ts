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

  return `You are NEXUS, a CLI-grade AI agent executing a task on macOS.

ORIGINAL REQUEST: ${originalRequest}

FULL PLAN: "${plan.title}"
Project directory: ${plan.projectDir}
Total steps: ${plan.steps.length}

CURRENT STEP: ${step.id} of ${plan.steps.length}
STEP TITLE: ${step.title}
STEP GOAL: ${step.description}

PREVIOUS STEPS COMPLETED:
${prevSummary}

━━━ CRITICAL EXECUTION RULES ━━━

1. FOCUS: Execute ONLY this step. Do not attempt future steps.
2. REAL WORK: Use tools to do actual work. Call write_file to write files. Call run_terminal_command to run commands. Do NOT describe what you would do — do it.
3. COMPLETE FILES: When writing code, write COMPLETE files. No stubs, no placeholders, no "add your code here" comments. Every file must be fully functional.
4. PATHS: Always use absolute paths. Save project files to ${plan.projectDir}/.
5. VERIFY WRITES: After calling write_file, immediately call read_file on the same path to confirm it was saved correctly.
6. TERMINAL OUTPUT: After running commands, show the actual output. If a command fails, fix it and retry.
7. REPORT: When done with this step, briefly state what was accomplished and what files/outputs were produced.

macOS shell rules:
- Use /bin/zsh for shell commands
- No GNU-only flags (no --sort, no declare -A)
- Use os.path.expanduser() in Python for ~ paths
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
    for (const toolCall of aiResponse.toolCalls) {
      const toolName = toolCall.function.name;
      let toolArgs: Record<string, unknown> = {};

      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        toolArgs = {};
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

    if (iteration === MAX_STEP_ITERATIONS - 1) {
      finalContent = aiResponse.content ?? `Step ${step.id} hit iteration limit.`;
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
}): Promise<TaskRunResult> {
  const { plan, originalRequest, chatId, ai, toolExecutor, telegram, model, maxTokens } = opts;
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

  // ── Execute each step ─────────────────────────────────────────────────────
  for (const step of plan.steps) {
    const stepStart = Date.now();
    log.info({ stepId: step.id, title: step.title }, 'Executing task step');

    await updateProgress(`Starting: ${step.title}`, step.id);

    let stepSuccess = false;
    let stepSummary = '';

    // Retry loop for a failing step
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
            // Fire-and-forget progress detail updates
            const now = Date.now();
            if (now - lastEditTime >= TELEGRAM_EDIT_THROTTLE_MS && progressMsgId) {
              lastEditTime = now;
              formatPlanMessage(plan, completedIds, step.id, stepTimings, detail);
              telegram.finalizeStreamingMessage(
                chatId,
                progressMsgId,
                formatPlanMessage(plan, completedIds, step.id, stepTimings, detail),
              ).catch(() => {});
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

    // Determine next active step
    const nextStep = plan.steps.find((s) => !completedIds.has(s.id));
    await updateProgress(undefined, nextStep?.id ?? null);
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
