// Tool-Call Loop — the LLM-driven "call tools until done" phase of message handling.
//
// Extracted from Orchestrator._handleMessage to make it testable in isolation.
// The class runs the assistant's tool-use loop up to MAX_TOOL_ITERATIONS times:
// each iteration calls the model, handles any tool_calls it returned (with
// parallel/sequential dispatch, loop detection, and argument-parse recovery),
// appends the results to the message history, and continues. It exits as soon
// as the model returns no tool calls (i.e., a final text response), hits the
// iteration cap, detects a repetitive-call loop, or successfully sends a
// screenshot (screenshots are always the last action in a turn).
//
// The loop is a pure compute unit given its deps. It does NOT read or write
// orchestrator state beyond the explicit inputs/outputs below. Token-usage
// accumulation is delegated via the onTokenUsage callback so the orchestrator
// can aggregate into `sessionTokens` without this file knowing that shape.

import { createHash } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import { toOpenAITools } from '../tools/definitions.js';
import { repairToolResult } from './transcript-repair.js';
import { wrapUntrustedContent } from '../brain/injection-guard.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { EventLoop } from './event-loop.js';
import type { AIManager } from '../ai/index.js';
import type { NexusConfig } from '../types.js';
import type { AIMessage, AIToolCall } from '../types.js';

const log = createLogger('ToolCallLoop');

const MAX_TOOL_ITERATIONS = 50;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_SCREENSHOTS_PER_TURN = 1;

// Per-tool timeout overrides. Tools that legitimately need longer than
// the standard 120s wrapper get a bigger budget here. ask_user blocks
// on a real user reply (10 min). run_applescript can hit iCloud-backed
// apps (Calendar, Mail) that lazy-load slowly — same 120s collision
// caused a Calendar query to fail mid-flight on 2026-05-11.
const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
  ask_user: 10 * 60 * 1000,         // 10 min — user reply
  run_applescript: 3 * 60 * 1000,   // 3 min — iCloud-backed app queries
};

function getToolTimeout(toolName: string): number {
  return TOOL_TIMEOUT_OVERRIDES[toolName] ?? TOOL_TIMEOUT_MS;
}

// Tools that can safely run in parallel within a single iteration.
// Reads + queries only — anything that mutates state must be sequential.
const PARALLEL_SAFE_TOOLS = new Set([
  'read_file', 'recall', 'web_search', 'web_fetch', 'crawl_url', 'get_weather',
  'read_calendar', 'check_email',
  'get_system_info', 'list_directory', 'introspect', 'check_injection',
  'check_command_risk', 'understand_image', 'read_pdf', 'transcribe_audio',
  'list_tasks', 'list_sessions',
]);

// Tools whose output may contain attacker-controlled text (web fetches,
// terminal output, file contents). Results get wrapped in a
// system-prompt-style block so the LLM treats them as data, not instructions.
const UNTRUSTED_TOOLS = new Set([
  'web_search', 'read_file', 'run_terminal_command', 'web_fetch', 'crawl_url',
  'check_email', 'read_calendar', // email/event content is attacker-controllable
]);

// Tools that count toward the per-turn screenshot cap. Preventing the LLM
// from spamming screenshots is a UX concern, not a security one.
const SCREENSHOT_TOOLS = new Set([
  'browser_screenshot', 'take_screenshot', 'understand_image',
]);

// Browser read tools whose result depends on the *current page*. After a
// browser_navigate, prior calls to these no longer represent "the same
// action" even if the args hash matches — the underlying state has changed.
// Without this reset, navigate→extract→navigate→extract trips the 3-calls-
// with-identical-args loop guard on the 3rd extract({}) even though it's
// inspecting a different page.
const BROWSER_STATEFUL_READS = new Set([
  'browser_extract', 'browser_screenshot', 'browser_get_info',
  'browser_get_tabs', 'browser_evaluate',
]);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolCallLoopDeps {
  ai: AIManager;
  toolExecutor: ToolExecutor;
  eventLoop: EventLoop;
  config: NexusConfig;
  /** Prune a history array (e.g., drop tool-result-heavy middle sections). */
  pruneHistory: (messages: AIMessage[]) => AIMessage[];
  /** Best-effort context compaction before each LLM call. */
  maybeCompact: (messages: AIMessage[], systemPrompt: string) => Promise<void>;
  /** Classify a tool result string as an error. */
  isToolError: (result: string) => boolean;
  /**
   * Send a screenshot image to Telegram directly (not via LLM response).
   * Returns true if a screenshot was sent — in that case we stop looping
   * because screenshots are always the last action of a turn.
   */
  maybeSendScreenshot: (toolName: string, result: string, chatId: string) => Promise<boolean>;
  /** Optional token-usage accumulator. */
  onTokenUsage?: (input: number, output: number) => void;
}

export interface ToolCallLoopInput {
  chatId: string;
  systemPrompt: string;
  /** Starting conversation history (usually last ~20 messages). */
  startingHistory: AIMessage[];
  /** Task-mode messages use a different temperature profile. */
  isTaskMessage: boolean;
  onToken?: (chunk: string) => void;
  /** `toolName` (when present) marks that the status is for a tool about to run —
   * the voice channel uses it to speak a fitting acknowledgment. */
  onStatus?: (status: string, toolName?: string) => void;
}

export interface ToolCallLoopOutput {
  finalContent: string;
  toolCallCount: number;
  /** write_file invocations made during the loop — consumed by the write-guard. */
  writeFileCallsMade: Array<{ path: string }>;
  /** The full loop message history at exit — useful for downstream recovery. */
  loopMessages: AIMessage[];
}

interface ToolCallJob {
  toolCall: AIToolCall;
  toolName: string;
  toolArgs: Record<string, unknown>;
  loopBlocked: boolean;
}

// ─── Helpers (previously orchestrator module-level) ─────────────────────────

/** Short user-facing status string for a given tool invocation. */
/** Basename of a path, for casual status lines ("…that config file"). */
function shortName(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p.trim()) return undefined;
  return p.split('/').filter(Boolean).pop() || p;
}

/**
 * A casual, FIRST-PERSON "thought" for the live status line — what NEXUS is doing
 * right now, in its own voice ("let me grab the weather…"), NOT a stiff label like
 * "Processing". Drives the Jarvis thinking bubble and the Telegram status message,
 * so the same personality shows on every channel.
 */
export function getToolStatus(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_file': return `let me take a look at ${shortName(args.path) ?? 'that'}…`;
    case 'write_file': return `okay, writing ${shortName(args.path) ?? 'that out'}…`;
    case 'list_directory': return `let me see what's in ${shortName(args.path) ?? 'there'}…`;
    case 'run_terminal_command': return `running that…`;
    case 'run_background_command': return `kicking that off in the background…`;
    case 'recall': return `let me think back on that…`;
    case 'remember': return `noting that down…`;
    case 'web_search': return args.query ? `let me look up "${String(args.query).slice(0, 48)}"…` : `let me look that up…`;
    case 'web_fetch': return `pulling that page up…`;
    case 'crawl_url': return `digging through that site…`;
    case 'get_weather': return `let me grab the weather…`;
    case 'read_calendar': return `let me check the calendar…`;
    case 'check_email': return `let me check the email…`;
    case 'take_screenshot':
    case 'browser_screenshot': return `grabbing a screenshot…`;
    case 'understand_image': return `let me look at that image…`;
    case 'read_pdf': return `reading through that PDF…`;
    case 'transcribe_audio': return `listening to that audio…`;
    case 'generate_image': return `putting that image together…`;
    case 'speak': return `…`;
    case 'get_system_info': return `let me check the system…`;
    case 'introspect': return `taking stock of where I'm at…`;
    case 'check_updates': return `checking for updates…`;
    case 'export_session': return `exporting that…`;
    default: {
      if (toolName.startsWith('browser_')) return `on the browser — ${toolName.replace('browser_', '').replace(/_/g, ' ')}…`;
      return `working on it…`;
    }
  }
}

/**
 * Build a transparent "here's what I actually tried" summary from a halted
 * tool-call loop. Last-resort fallback when the recovery LLM call returns
 * empty content. Names the distinct tools called and their first/most
 * salient argument so the user can redirect ("oh you searched wrong term,
 * try X") instead of getting a generic "I hit a loop" message.
 *
 * The 2026-05-12 AP×Swatch incident motivated this — the user asked for
 * collab launch details, the model burned three web_search calls on
 * variations of the query, recovery returned empty, and the user got a
 * canned apology with zero information. Now they'll see the actual tools
 * and queries instead, so they can guide the next step.
 */
export function summarizeAttempt(loopMessages: AIMessage[]): string {
  const calls: Array<{ tool: string; hint: string }> = [];
  for (const m of loopMessages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const name = tc.function?.name ?? 'unknown';
      let hint = '';
      try {
        const args = JSON.parse(tc.function?.arguments ?? '{}');
        // Pick the most salient arg by tool — query for searches, path/url
        // for navigation/reads, command for shells.
        const candidate = args.query ?? args.url ?? args.path ?? args.command ?? args.text ?? '';
        hint = typeof candidate === 'string' ? candidate.slice(0, 80) : '';
      } catch { /* ignore malformed args */ }
      calls.push({ tool: name, hint });
    }
  }
  if (calls.length === 0) {
    return 'I hit a repeated action and stopped to avoid a loop. Let me know how you\'d like me to proceed.';
  }
  // Group by tool so 3x web_search shows as one line with the queries listed.
  const byTool = new Map<string, string[]>();
  for (const c of calls) {
    const list = byTool.get(c.tool) ?? [];
    if (c.hint && !list.includes(c.hint)) list.push(c.hint);
    byTool.set(c.tool, list);
  }
  const lines = ['I got stuck before reaching a complete answer. Here\'s what I actually tried:'];
  for (const [tool, hints] of byTool) {
    const count = calls.filter((c) => c.tool === tool).length;
    const hintsStr = hints.length > 0 ? ` → ${hints.map((h) => `"${h}"`).join(', ')}` : '';
    lines.push(`  • ${tool} ×${count}${hintsStr}`);
  }
  lines.push('');
  lines.push('Let me know what to try differently — a more specific search term, a direct URL, or a different angle.');
  return lines.join('\n');
}

/** Wrap a promise in a timeout; rejects with a labelled error if exceeded. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms: ${label}`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ─── The class ──────────────────────────────────────────────────────────────

export class ToolCallLoop {
  constructor(private deps: ToolCallLoopDeps) {}

  async run(input: ToolCallLoopInput): Promise<ToolCallLoopOutput> {
    const { ai, toolExecutor, eventLoop, config, pruneHistory, maybeCompact, isToolError, maybeSendScreenshot, onTokenUsage } = this.deps;
    const { chatId, systemPrompt, startingHistory, isTaskMessage, onToken, onStatus } = input;

    const tools = toOpenAITools();
    const maxTokens = config.ai.maxTokens;

    const loopMessages: AIMessage[] = pruneHistory([...startingHistory]);
    let finalContent = '';
    let toolCallCount = 0;
    const writeFileCallsMade: Array<{ path: string }> = [];

    // Per-turn loop detection state
    const toolCallCounts = new Map<string, number>();  // tool+args → count
    const toolNameCounts = new Map<string, number>();  // tool name only → count
    const recentToolSequence: string[] = [];

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      await maybeCompact(loopMessages, systemPrompt);

      // Tool-calling loops prefer precision — use the lower chat temperature
      // only on the first iteration of a non-task turn (which is a chat-style
      // first response). All other calls use the standard tool temperature.
      const loopTemp = isTaskMessage
        ? config.ai.temperature
        : (iteration === 0 ? config.ai.chatTemperature : config.ai.temperature);

      let aiResponse = await ai.complete({
        messages: loopMessages,
        systemPrompt,
        model: config.ai.model,
        maxTokens,
        temperature: loopTemp,
        tools,
        tool_choice: 'auto',
        onToken,
      });

      if (aiResponse.tokensUsed && onTokenUsage) {
        onTokenUsage(aiResponse.tokensUsed.input, aiResponse.tokensUsed.output);
      }

      // Empty-response retry — occasionally the model returns blank content
      // with no tool calls. Wait 1.5s and try once more with the standard temp.
      const isEmpty =
        (!aiResponse.toolCalls || aiResponse.toolCalls.length === 0) &&
        (!aiResponse.content || aiResponse.content.trim().length === 0);
      if (isEmpty) {
        log.warn({ iteration }, '[Empty response from LLM, retrying...]');
        await new Promise((r) => setTimeout(r, 1500));
        aiResponse = await ai.complete({
          messages: loopMessages,
          systemPrompt,
          model: config.ai.model,
          maxTokens,
          temperature: config.ai.temperature,
          tools,
          tool_choice: 'auto',
        });
        log.info({ iteration }, 'Empty response retry complete');
      }

      log.info(
        {
          provider: aiResponse.provider,
          model: aiResponse.model,
          iteration,
          toolCalls: aiResponse.toolCalls?.length ?? 0,
          contentLen: aiResponse.content?.length ?? 0,
        },
        'AI response received',
      );

      // No tool calls → final response. Exit loop.
      if (!aiResponse.toolCalls || aiResponse.toolCalls.length === 0) {
        if (toolCallCount > 0) onStatus?.('alright, putting this together…');
        finalContent = aiResponse.content;
        break;
      }

      // Commit the assistant turn + tool calls to the loop history.
      loopMessages.push({
        role: 'assistant',
        content: aiResponse.content || null,
        tool_calls: aiResponse.toolCalls,
      });

      // Alternating-pattern loop detection (A→B→A→B)
      let loopDetected = false;
      let screenshotWasSent = false;
      if (recentToolSequence.length >= 4) {
        const len = recentToolSequence.length;
        if (
          recentToolSequence[len - 4] === recentToolSequence[len - 2] &&
          recentToolSequence[len - 3] === recentToolSequence[len - 1]
        ) {
          log.warn({ sequence: recentToolSequence.slice(-4) }, 'Alternating tool pattern detected');
          loopDetected = true;
        }
      }
      if (loopDetected) {
        finalContent = "I noticed I was repeating the same actions in a loop. Let me try a different approach.";
        break;
      }

      // Phase 1: pre-process every tool call (parse args, loop-detection counters,
      // write-guard bookkeeping). Errors during arg-parse are reported back to
      // the LLM as tool results so it can retry without breaking the loop.
      const jobs: ToolCallJob[] = [];
      for (const toolCall of aiResponse.toolCalls) {
        toolCallCount++;
        const toolName = toolCall.function.name;
        let toolArgs: Record<string, unknown> = {};
        let argsParseFailed = false;

        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          argsParseFailed = true;
          log.warn({ toolName, raw: toolCall.function.arguments?.slice(0, 200) }, 'Failed to parse tool arguments — returning error to LLM');
        }

        if (argsParseFailed) {
          loopMessages.push({ role: 'assistant', content: aiResponse.content || null, tool_calls: [toolCall] });
          loopMessages.push({
            role: 'tool',
            content: `Error: Tool arguments for "${toolName}" are malformed JSON. This usually means max_tokens was exceeded and arguments were truncated. Retry with simpler/shorter arguments.`,
            tool_call_id: toolCall.id,
          });
          continue;
        }

        // A successful navigate invalidates prior page-dependent reads —
        // counting browser_extract({}) on page-A against the same call on
        // page-B is a false positive. Reset those counters now so the model
        // can legitimately re-inspect the new page.
        if (toolName === 'browser_navigate') {
          for (const key of Array.from(toolCallCounts.keys())) {
            const keyTool = key.slice(0, key.indexOf(':'));
            if (BROWSER_STATEFUL_READS.has(keyTool)) toolCallCounts.delete(key);
          }
        }

        // Tool+args combo-frequency counter (for loop detection)
        const argsHash = createHash('sha256').update(toolCall.function.arguments).digest('hex').slice(0, 8);
        const comboKey = `${toolName}:${argsHash}`;
        const comboCount = (toolCallCounts.get(comboKey) ?? 0) + 1;
        toolCallCounts.set(comboKey, comboCount);
        const nameCount = (toolNameCounts.get(toolName) ?? 0) + 1;
        toolNameCounts.set(toolName, nameCount);
        recentToolSequence.push(comboKey);

        // Screenshot cap: prevent the LLM from spamming screenshots.
        if (SCREENSHOT_TOOLS.has(toolName) && nameCount > MAX_SCREENSHOTS_PER_TURN) {
          log.warn({ toolName, nameCount }, 'Screenshot cap reached — blocking further screenshot calls this turn');
          jobs.push({ toolCall, toolName, toolArgs, loopBlocked: true });
          loopDetected = true;
          break;
        }

        // Same tool+args 3+ times in a turn: block and break.
        if (comboCount >= 3) {
          log.warn({ toolName, comboKey, count: comboCount }, 'Tool loop detected — same tool+args called 3+ times');
          jobs.push({ toolCall, toolName, toolArgs, loopBlocked: true });
          loopDetected = true;
          break;
        }

        // Write-guard bookkeeping — downstream write-guard uses this to decide
        // whether a claimed-save without a write_file call is a hallucination.
        if (toolName === 'write_file' && typeof toolArgs.path === 'string') {
          writeFileCallsMade.push({ path: toolArgs.path as string });
        }

        jobs.push({ toolCall, toolName, toolArgs, loopBlocked: false });
      }

      // Phase 2: dispatch — parallel-safe reads concurrently, state-mutating
      // tools (writes, commands, screenshots) sequentially. Results land in a
      // by-id map so we can re-assemble them in the original call order when
      // feeding them back to the LLM.
      if (!loopDetected) {
        const parallelJobs = jobs.filter((j) => PARALLEL_SAFE_TOOLS.has(j.toolName) && !j.loopBlocked);
        const sequentialJobs = jobs.filter((j) => !PARALLEL_SAFE_TOOLS.has(j.toolName) || j.loopBlocked);

        log.info(
          { total: jobs.length, parallel: parallelJobs.length, sequential: sequentialJobs.length },
          jobs.length > 1 ? 'Executing tool calls (parallel + sequential split)' : 'Executing tool call',
        );

        const resultMap = new Map<string, string>();

        if (parallelJobs.length > 0) {
          if (parallelJobs.length === 1) {
            onStatus?.(getToolStatus(parallelJobs[0]!.toolName, parallelJobs[0]!.toolArgs), parallelJobs[0]!.toolName);
          } else {
            onStatus?.(`okay, working through it…`, parallelJobs[0]!.toolName);
          }
          const parallelResults = await Promise.all(
            parallelJobs.map(async (job) => {
              log.info({ toolName: job.toolName, toolCallId: job.toolCall.id, iteration }, 'Executing tool call (parallel)');
              let result = await withTimeout(toolExecutor.execute(job.toolName, job.toolArgs, { chatId }), getToolTimeout(job.toolName), job.toolName);
              result = repairToolResult(result);
              if (isToolError(result)) {
                result += '\n\n[TOOL RETURNED AN ERROR — do not claim success. Report the error to the user.]';
                log.warn({ toolName: job.toolName }, 'Tool returned an error result');
              }
              if (UNTRUSTED_TOOLS.has(job.toolName)) result = wrapUntrustedContent(result, job.toolName);
              eventLoop.emit('agent:completed', { tool: job.toolName, resultLen: result.length }, 'medium', 'orchestrator');
              maybeSendScreenshot(job.toolName, result, chatId).catch((e) => log.debug({ e }, 'Failed to send screenshot'));
              return { id: job.toolCall.id, result };
            }),
          );
          for (const { id, result } of parallelResults) resultMap.set(id, result);
        }

        let screenshotSent = false;
        for (const job of sequentialJobs) {
          if (job.loopBlocked) {
            resultMap.set(job.toolCall.id, '[Loop detected: this exact action was already tried twice. Try a different approach.]');
            continue;
          }
          onStatus?.(getToolStatus(job.toolName, job.toolArgs), job.toolName);
          log.info({ toolName: job.toolName, toolCallId: job.toolCall.id, iteration }, 'Executing tool call (sequential)');
          let result = await withTimeout(toolExecutor.execute(job.toolName, job.toolArgs, { chatId }), getToolTimeout(job.toolName), job.toolName);
          result = repairToolResult(result);
          if (isToolError(result)) {
            result += '\n\n[TOOL RETURNED AN ERROR — do not claim success. Report the error to the user.]';
            log.warn({ toolName: job.toolName }, 'Tool returned an error result');
          }
          if (UNTRUSTED_TOOLS.has(job.toolName)) result = wrapUntrustedContent(result, job.toolName);
          eventLoop.emit('agent:completed', { tool: job.toolName, resultLen: result.length }, 'medium', 'orchestrator');
          const sent = await maybeSendScreenshot(job.toolName, result, chatId);
          if (sent) screenshotSent = true;
          resultMap.set(job.toolCall.id, result);
          if (screenshotSent) break; // screenshot is always the last action of a turn
        }
        if (screenshotSent) {
          loopDetected = true;         // reuse the flag to exit the outer iteration loop
          screenshotWasSent = true;
        }

        // Feed tool results back to the LLM in the original call order.
        for (const job of jobs) {
          loopMessages.push({
            role: 'tool',
            content: resultMap.get(job.toolCall.id) ?? '(no result)',
            tool_call_id: job.toolCall.id,
          });
        }
      }

      if (loopDetected) {
        if (!finalContent) {
          if (screenshotWasSent) {
            finalContent = aiResponse.content?.trim() || 'Done — screenshot sent.';
          } else {
            // Always run the no-tool recovery completion. The mid-loop
            // assistant text is usually a forward-looking promise ("Let me
            // extract the listings...") issued alongside the offending tool
            // call — handing that to the user as a final reply leaves them
            // staring at a broken promise. The recovery completion has the
            // full loopMessages history and can write a real "here's what
            // I tried, here's where it stuck" answer. We pass the mid-loop
            // text as a hint so a genuinely complete answer ("Found 5 files:
            // …") gets preserved rather than rewritten.
            const lastMidLoopText = aiResponse.content?.trim() || '';
            const hint = lastMidLoopText
              ? `\n\nYour last text before the halt was: """${lastMidLoopText}""". If that was a complete answer, you may reuse it. If it was a forward-looking promise (e.g. starts with "Let me…", "I'll…", "Now I'll…"), DO NOT repeat the promise — instead write what was actually accomplished, what was tried, and what's still needed.`
              : '';
            // The 2026-05-12 AP×Swatch incident: the previous prompt told
            // the model "do NOT mention the loop, just give a concise direct
            // answer" — when the tool work had produced no usable info, the
            // model couldn't honestly say "I tried but got stuck", couldn't
            // fabricate an answer, and went silent (empty content) instead.
            // The user got the canned "I hit a repeated action" fallback.
            // New prompt: encourage honesty. Either deliver real findings
            // OR name what was tried + the wall hit + a concrete next step.
            try {
              const recovery = await ai.complete({
                messages: loopMessages,
                systemPrompt: `${systemPrompt}\n\n[RECOVERY MODE: The previous tool-calling attempt was halted to prevent a loop. Write a real answer to the user from the conversation context — DO NOT call any tools.\n\nPick ONE of these two modes:\n  (a) USEFUL RESULTS — your tool calls did surface real information. Synthesize it into a direct answer to the user's question.\n  (b) DEAD END — your tool calls did not produce a usable answer. Be honest and specific: name what you tried (e.g. "I searched the web for X and Y but the results didn't include Z"), what the wall was (e.g. "the site is gated", "the search returned generic listicles", "the data isn't on this page"), and a concrete next step the user could take or you could try with their guidance.\n\nNever go silent. An honest "I tried X and Y, hit Z, here's what to try next" is always better than nothing. Avoid generic apologies like "I hit a loop" — name what was actually attempted.${hint}]`,
                model: config.ai.model,
                maxTokens,
                temperature: config.ai.chatTemperature,
                tools: [],
                tool_choice: 'none',
              });
              if (recovery.tokensUsed && onTokenUsage) {
                onTokenUsage(recovery.tokensUsed.input, recovery.tokensUsed.output);
              }
              const recovered = recovery.content?.trim();
              if (recovered) {
                log.info({ contentLen: recovered.length, hadMidLoopText: lastMidLoopText.length > 0 }, 'Loop bail recovered via no-tool completion');
                finalContent = recovered;
              }
            } catch (err) {
              log.warn({ err }, 'Loop bail recovery completion failed');
            }
            if (!finalContent) {
              // Recovery dropped out empty AND no mid-loop text. Synthesize
              // a transparent "here's what I actually tried" summary from
              // the loopMessages history so the user gets concrete signal
              // instead of the generic canned apology. This is the final
              // fallback — strictly better than "I hit a loop" because it
              // names the actual tool calls so the user can redirect.
              finalContent = lastMidLoopText || summarizeAttempt(loopMessages);
            }
          }
        }
        break;
      }

      if (iteration === MAX_TOOL_ITERATIONS - 1) {
        finalContent = aiResponse.content || 'I completed the tasks but ran out of processing turns.';
      }
    }

    return { finalContent, toolCallCount, writeFileCallsMade, loopMessages };
  }
}
