// Write-Guard — catches hallucinated file saves.
//
// After the tool-call loop finishes, the assistant's response text sometimes
// claims a file was created/saved/written but no `write_file` tool was ever
// actually invoked. The LLM confidently describes the work, yet the file
// doesn't exist. This is a classic hallucination pattern.
//
// The guard runs AFTER the tool-call loop and BEFORE the response is sent
// back to the user. It inspects `finalContent` for claim phrases + a plausible
// path, and if a claim is detected without a real write_file invocation:
//
//   1. Try to extract content from a fenced code block
//   2. Try an indented block (≥3 consecutive 4-space or tab-indented lines)
//   3. Try the whole response if >50% of lines look like code
//   4. Re-prompt the LLM with a terse "you must call write_file NOW" message
//      and execute whatever write_file calls come back
//
// If any of 1–3 succeed, the content is saved via the executor and a marker
// is appended to finalContent. If none succeed, the 4-step re-prompt is the
// last resort. If that fails too, a user-facing "couldn't save" note is appended.
//
// Extracted from Orchestrator._handleMessage — see ToolCallLoop for the
// earlier sibling extraction. Both exist to shrink the god-method and make
// this logic testable without spinning up an orchestrator.

import { createLogger } from '../utils/logger.js';
import { toOpenAITools } from '../tools/definitions.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { AIManager } from '../ai/index.js';
import type { AIMessage, NexusConfig } from '../types.js';

const log = createLogger('WriteGuard');

// ─── Regexes ────────────────────────────────────────────────────────────────
// Module-scope so they compile once.

const FILE_CLAIM_PATTERN =
  /\b(?:created?|saved?|written?|done[,.]?\s*(?:created?|saved?|written?)|i'?(?:ve|'m)?\s+(?:created?|saved?|written?|done\s+(?:creating|saving|writing))|file\s+(?:is|has\s+been)\s+(?:created?|saved?|written?|ready)|saved?\s+(?:it\s+)?to|here'?s?\s+(?:the\s+)?(?:file|content|code|script)|file\s+(?:content|saved|created))\b/i;

const FILE_PATH_PATTERN = /[`'"]?(~\/[\w\-\/\.]+|\/[\w\-\/\.]+)/;

const FENCED_CODE_PATTERN = /```(?:\w+)?\n([\s\S]*?)```/;

const INDENT_LINE_PATTERN = /^(?:    |\t)/;

const CODE_LOOKING_LINE_PATTERN =
  /^(?:\s*(?:def |class |import |from |if |for |while |return |const |let |var |function |\/\/|\/\*|\*|echo |#!))/;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WriteGuardDeps {
  ai: AIManager;
  toolExecutor: ToolExecutor;
  config: NexusConfig;
}

export interface WriteGuardInput {
  /** The assistant's proposed response text (before the user sees it). */
  finalContent: string;
  /** Whether `write_file` was actually invoked during this turn. */
  writeFileCallsMade: Array<{ path: string }>;
  /** Loop message history — used to build the re-prompt context. */
  loopMessages: AIMessage[];
  /** The system prompt the loop used (carried into the re-prompt). */
  systemPrompt: string;
}

export interface WriteGuardOutput {
  /** Potentially-updated finalContent. */
  finalContent: string;
  /** True if the guard took any action. */
  triggered: boolean;
  /** Which strategy (if any) produced the save. */
  strategy: 'fenced' | 'indented' | 'whole-response' | 'reprompt' | 'none';
}

// ─── Detection helpers (pure, testable) ─────────────────────────────────────

/** True if `text` looks like "I wrote the file to X" without an actual tool call. */
export function claimsFileSaved(text: string): boolean {
  return FILE_CLAIM_PATTERN.test(text) && FILE_PATH_PATTERN.test(text);
}

/** Extract the first path-like token from `text`, stripped of trailing punctuation. */
export function extractTargetPath(text: string): string | null {
  const m = text.match(FILE_PATH_PATTERN);
  if (!m) return null;
  return m[1]!.replace(/[.,;:!?)]+$/, '');
}

/** Try strategies 1-3 to find file content embedded in the response text. */
export function extractContent(text: string): { content: string | null; strategy: 'fenced' | 'indented' | 'whole-response' | 'none' } {
  const fenced = text.match(FENCED_CODE_PATTERN);
  if (fenced?.[1]) return { content: fenced[1], strategy: 'fenced' };

  const indentedLines = text.split('\n').filter((l) => INDENT_LINE_PATTERN.test(l));
  if (indentedLines.length >= 3) return { content: indentedLines.join('\n'), strategy: 'indented' };

  const nonEmpty = text.split('\n').filter((l) => l.trim().length > 0);
  const codeLineCount = nonEmpty.filter((l) => CODE_LOOKING_LINE_PATTERN.test(l)).length;
  if (nonEmpty.length > 0 && codeLineCount / nonEmpty.length > 0.5) {
    return { content: text, strategy: 'whole-response' };
  }

  return { content: null, strategy: 'none' };
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Run the write guard. If the guard fires, returns a new `finalContent` with
 * an appended marker (or a re-prompt result). If the guard doesn't fire,
 * returns `finalContent` unchanged.
 */
export async function runWriteGuard(
  deps: WriteGuardDeps,
  input: WriteGuardInput,
): Promise<WriteGuardOutput> {
  const { ai, toolExecutor, config } = deps;
  let { finalContent, writeFileCallsMade, loopMessages, systemPrompt } = input;

  const didCallWriteFile = writeFileCallsMade.length > 0;
  if (!claimsFileSaved(finalContent) || didCallWriteFile) {
    return { finalContent, triggered: false, strategy: 'none' };
  }

  const targetPath = extractTargetPath(finalContent);
  const { content: extractedContent, strategy: extractStrategy } = extractContent(finalContent);

  log.warn(
    { targetPath, strategy: extractStrategy },
    'Write guard triggered: response claims file saved but write_file was not called',
  );

  // Strategies 1-3: content was embedded; save it directly.
  if (targetPath && extractedContent) {
    try {
      await toolExecutor.execute('write_file', { path: targetPath, content: extractedContent });
      finalContent += '\n\n[Auto-saved by NEXUS write guard]';
      log.info({ targetPath }, 'Write guard: auto-saved extracted content');
      return { finalContent, triggered: true, strategy: extractStrategy };
    } catch (err) {
      log.warn({ err, targetPath }, 'Write guard: auto-save failed');
      finalContent += '\n\n[Note: I described the content but failed to save it automatically. Please ask me to try again.]';
      return { finalContent, triggered: true, strategy: extractStrategy };
    }
  }

  // Strategy 4: re-prompt the LLM. Use only the current-turn context to avoid
  // polluting the re-prompt with stale "[Write guard re-prompt:]" entries.
  log.warn({ targetPath }, 'Write guard: no extractable content — re-prompting LLM to generate and call write_file');
  const lastUserIdx = [...loopMessages].reverse().findIndex((m) => m.role === 'user');
  const currentTurnMessages = lastUserIdx >= 0
    ? loopMessages.slice(loopMessages.length - 1 - lastUserIdx)
    : loopMessages.slice(-6);

  const forceWriteMessages: AIMessage[] = [
    ...currentTurnMessages,
    { role: 'assistant', content: finalContent },
    {
      role: 'user',
      content:
        `CRITICAL ERROR: You claimed to create/save a file but you NEVER called the write_file tool. ` +
        `The file does NOT exist. You MUST call write_file RIGHT NOW to actually create it. ` +
        `Do not describe the file or say you will do it — call write_file immediately. ` +
        `Path: ${targetPath ?? 'the path you mentioned above'}`,
    },
  ];

  try {
    const forceResponse = await ai.complete({
      messages: forceWriteMessages,
      systemPrompt,
      model: config.ai.model,
      maxTokens: config.ai.maxTokens,
      temperature: config.ai.temperature,
      tools: toOpenAITools(),
      tool_choice: 'auto',
    });

    let wroteFile = false;
    if (forceResponse.toolCalls && forceResponse.toolCalls.length > 0) {
      for (const tc of forceResponse.toolCalls) {
        if (tc.function.name !== 'write_file') continue;
        let tcArgs: Record<string, unknown> = {};
        try { tcArgs = JSON.parse(tc.function.arguments); }
        catch (e) { log.debug({ e }, 'Failed to parse forced write_file args'); }
        if (typeof tcArgs.path === 'string') writeFileCallsMade.push({ path: tcArgs.path as string });
        const writeResult = await toolExecutor.execute('write_file', tcArgs);
        finalContent += `\n\n[Write guard re-prompt: ${writeResult}]`;
        log.info({ path: tcArgs.path }, 'Write guard: re-prompt write_file succeeded');
        wroteFile = true;
      }
    }

    if (!wroteFile) {
      finalContent += '\n\n[Note: Could not auto-save — re-prompt did not produce a write_file call. Please ask me to create the file(s) again.]';
    }
  } catch (err) {
    log.warn({ err }, 'Write guard: re-prompt failed');
    finalContent += '\n\n[Note: Could not auto-save — re-prompt failed. Please ask me to create the file(s) again.]';
  }

  return { finalContent, triggered: true, strategy: 'reprompt' };
}
