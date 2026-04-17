// Message processing pipeline.
//
// Replaces the 2,000-line straight-line _handleMessage with composable stages.
// Each stage receives a shared MessageContext and may mutate it, short-circuit
// (return early with a ready response), or pass through to the next stage.
//
// Key properties:
// - Stages are plain functions with typed IO — trivial to test in isolation.
// - A stage can short-circuit by setting `ctx.response` — remaining stages skip.
// - A stage can add a "skip reason" if it wants to emit a response before the
//   normal LLM path runs (e.g. hard block, pending project answer).
// - Stages run sequentially; if a stage throws, the pipeline stops and the
//   orchestrator's outer catch handles it.

import type { AIMessage } from '../types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Pipeline');

/**
 * Shared state threaded through every pipeline stage for a single user message.
 * Stages read from and mutate this object; no other cross-stage communication.
 */
export interface MessageContext {
  // Input
  chatId: string;
  text: string;        // may be mutated by sanitization stages
  startTime: number;

  // Classification (set by early stages)
  messageType?: 'task' | 'chat';
  taskMode?: 'standard' | 'coordinator' | 'ultra';
  injectionDetected?: { confidence: number; patterns: string[] };

  // Recalled context (set by ContextRecallStage)
  recentMemories?: unknown[];
  relevantFacts?: unknown[];
  activeGoals?: string[];

  // Optional flags for downstream behavior
  hardBlocked?: boolean;
  undercoverProbe?: boolean;
  frustrationScore?: number;

  // Short-circuit response — if set by any stage, pipeline halts and returns it
  response?: string;

  // Callbacks from caller (token streaming, status updates)
  onToken?: (chunk: string) => void;
  onStatus?: (status: string) => void;

  // Free slot for stages to stash state for other stages (e.g. 'synthesis')
  scratchpad: Record<string, unknown>;
}

/**
 * A pipeline stage — receives the context, may mutate, may set response.
 * Stages are async to accommodate I/O (memory recall, LLM prep calls).
 */
export type PipelineStage = (ctx: MessageContext) => Promise<void> | void;

/** Convenience helper to build a stage with a name for logging. */
export function stage(name: string, fn: PipelineStage): NamedStage {
  return { name, run: fn };
}

export interface NamedStage {
  name: string;
  run: PipelineStage;
}

/**
 * Run a pipeline of stages over a context. Halts if any stage sets ctx.response.
 * Individual stage errors propagate — caller handles them.
 * Returns the final context (regardless of short-circuit).
 */
export async function runPipeline(
  stages: NamedStage[],
  ctx: MessageContext,
): Promise<MessageContext> {
  for (const s of stages) {
    const stageStart = Date.now();
    try {
      await s.run(ctx);
    } catch (err) {
      log.error({ err, stage: s.name }, 'Pipeline stage threw');
      throw err;
    }
    const stageDuration = Date.now() - stageStart;
    if (stageDuration > 500) {
      log.debug({ stage: s.name, durationMs: stageDuration }, 'Slow pipeline stage');
    }
    if (ctx.response !== undefined) {
      log.debug({ stage: s.name, reason: 'short-circuit' }, 'Pipeline halted early');
      return ctx;
    }
  }
  return ctx;
}

/** Create a fresh MessageContext for a new user message. */
export function makeContext(params: {
  chatId: string;
  text: string;
  onToken?: (chunk: string) => void;
  onStatus?: (status: string) => void;
}): MessageContext {
  return {
    chatId: params.chatId,
    text: params.text,
    startTime: Date.now(),
    onToken: params.onToken,
    onStatus: params.onStatus,
    scratchpad: {},
  };
}
