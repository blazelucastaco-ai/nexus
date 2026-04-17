// Trace context — correlates every operation across subsystems for a single
// user message. Propagates automatically through async boundaries via
// AsyncLocalStorage so any code can ask "what trace am I in right now?"
// without explicit threading.

import { AsyncLocalStorage } from 'node:async_hooks';
import { nanoid } from 'nanoid';
import { registerTraceAccessor } from '../utils/logger.js';

export interface TraceContext {
  /** 8-char id correlating all operations for one user message. */
  traceId: string;
  /** Chat / user scope if applicable. */
  chatId?: string;
  /** Epoch ms when the trace started. */
  startedAt: number;
  /** Free-form attributes contributed by subsystems as work happens. */
  attrs: Record<string, string | number | boolean>;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** Generate a short (8-char) trace id — enough for uniqueness within a session window. */
export function newTraceId(): string {
  return nanoid(8);
}

/**
 * Run `fn` inside a new trace context. The context propagates through every
 * awaited Promise and every async callback without manual threading.
 */
export function traced<T>(
  ctx: Omit<TraceContext, 'startedAt' | 'attrs'> & { attrs?: Record<string, string | number | boolean> },
  fn: () => T,
): T {
  const fullCtx: TraceContext = {
    ...ctx,
    startedAt: Date.now(),
    attrs: ctx.attrs ?? {},
  };
  return storage.run(fullCtx, fn);
}

/** Current trace context, or undefined if no trace is active. */
export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

/** Current trace id, or undefined. */
export function currentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/**
 * Add attributes to the current trace (e.g. "messageType: task" after classification).
 * No-op if no trace is active.
 */
export function setTraceAttrs(attrs: Record<string, string | number | boolean>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current.attrs, attrs);
}

/** Elapsed ms since the current trace started, or 0 if no trace. */
export function traceElapsedMs(): number {
  const current = storage.getStore();
  return current ? Date.now() - current.startedAt : 0;
}

// On module load, register the accessor so the logger can pick up trace context
// automatically on every log line. This is the only cross-module wiring needed.
registerTraceAccessor(currentTrace);
