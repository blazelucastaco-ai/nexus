// Nexus Event Bus
//
// In-process typed pub/sub. Subsystems emit events instead of calling each other
// directly. Multiple subscribers per event are fine. Errors in one subscriber
// never break others or the emitter.
//
// Design choices:
// - Sync-by-default: emit() returns after all handlers are invoked, not after they
//   settle. Async handlers fire concurrently and their rejections are caught and
//   logged, not awaited. This keeps emit() O(1) for the caller.
// - Typed events via discriminated union — catching typos at compile time.
// - Auto-enriches events with trace context so subscribers can correlate.

import { createLogger } from '../utils/logger.js';
import { currentTraceId } from './trace.js';

const log = createLogger('EventBus');

// ─── Event catalog ───────────────────────────────────────────────────────────
// Add new events by extending this union. The type field is the discriminator.

export type NexusEvent =
  // Message lifecycle
  | { type: 'message.received'; chatId: string; text: string; textLen: number }
  | { type: 'message.completed'; chatId: string; durationMs: number; responseLen: number; toolCalls: number }
  | { type: 'message.failed'; chatId: string; error: string; durationMs: number }

  // Tool execution
  | { type: 'tool.executed'; toolName: string; success: boolean; durationMs: number; resultLen: number; params?: Record<string, unknown> }
  | { type: 'tool.error'; toolName: string; error: string; params?: Record<string, unknown> }

  // Task engine
  | { type: 'task.planned'; title: string; stepCount: number; coordinatorMode: boolean }
  | { type: 'task.started'; title: string; planId?: string }
  | { type: 'task.step.started'; planTitle: string; stepId: number; stepTitle: string }
  | { type: 'task.step.completed'; planTitle: string; stepId: number; success: boolean; durationMs: number; filesWritten: string[] }
  | { type: 'task.step.failed'; planTitle: string; stepId: number; error: string; attempt: number }
  | { type: 'task.completed'; title: string; success: boolean; durationMs: number; stepsCompleted: number; totalSteps: number; filesProduced: string[] }
  | { type: 'task.cowork.consulted'; planTitle: string; stepId: number; attempt: number; diagnosis: string; suggestion: string; confidence: number }

  // Memory
  | { type: 'memory.stored'; layer: 'episodic' | 'semantic' | 'procedural' | 'buffer'; memoryType: string; importance: number; contentLen: number }
  | { type: 'memory.recalled'; query: string; resultCount: number; durationMs: number }

  // Personality & emotion
  | { type: 'personality.event'; eventType: string }
  | { type: 'personality.mood.shifted'; before: number; after: number; trigger: string }
  | { type: 'personality.frustration.detected'; score: number; severity: 'high' | 'low'; messagePreview: string }

  // Dream cycle
  | { type: 'dream.started' }
  | { type: 'dream.completed'; consolidated: number; decayed: number; gcd: number; reflections: number; ideas: number; durationMs: number }
  | { type: 'dream.reflection'; text: string }

  // Proactive
  | { type: 'proactive.alert'; category: 'disk' | 'cpu' | 'port' | 'task-failure' | 'other'; message: string }
  | { type: 'proactive.idle-idea'; ideaPreview: string }

  // System
  | { type: 'system.started'; version: string; uptime: number }
  | { type: 'system.shutdown'; graceful: boolean; reason?: string };

export type EventType = NexusEvent['type'];

// ─── Subscriber type helpers ────────────────────────────────────────────────

type EventOf<T extends EventType> = Extract<NexusEvent, { type: T }>;

export type EventHandler<T extends EventType> = (
  event: EventOf<T> & { traceId?: string; emittedAt: number },
) => void | Promise<void>;

export type AnyEventHandler = (
  event: NexusEvent & { traceId?: string; emittedAt: number },
) => void | Promise<void>;

export interface Subscription {
  /** Remove this handler from the bus. Idempotent. */
  unsubscribe(): void;
}

// ─── Bus implementation ─────────────────────────────────────────────────────

class EventBus {
  private handlers = new Map<EventType, Set<AnyEventHandler>>();
  private wildcardHandlers = new Set<AnyEventHandler>();

  /**
   * Subscribe to a specific event type.
   * Returns a Subscription; call .unsubscribe() to stop receiving.
   */
  on<T extends EventType>(type: T, handler: EventHandler<T>): Subscription {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const wrapped = handler as AnyEventHandler;
    set.add(wrapped);
    return {
      unsubscribe: () => {
        set?.delete(wrapped);
      },
    };
  }

  /** Subscribe to every event on the bus. Useful for audit/telemetry. */
  onAny(handler: AnyEventHandler): Subscription {
    this.wildcardHandlers.add(handler);
    return {
      unsubscribe: () => {
        this.wildcardHandlers.delete(handler);
      },
    };
  }

  /**
   * Emit an event. All matching handlers (specific + wildcard) are invoked.
   * - Sync handlers run in subscription order and any throw is caught + logged.
   * - Async handlers are fired but not awaited; their rejections are caught.
   * - Event is enriched with current traceId (if any) and emittedAt timestamp.
   */
  emit<E extends NexusEvent>(event: E): void {
    const enriched = {
      ...event,
      traceId: currentTraceId(),
      emittedAt: Date.now(),
    };

    const specific = this.handlers.get(event.type);
    if (specific) {
      for (const h of specific) {
        this.invoke(h, enriched, event.type);
      }
    }
    for (const h of this.wildcardHandlers) {
      this.invoke(h, enriched, event.type);
    }
  }

  private invoke(handler: AnyEventHandler, event: NexusEvent & { traceId?: string; emittedAt: number }, type: EventType): void {
    try {
      const result = handler(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => {
          log.warn({ err, eventType: type }, 'Async event handler rejected');
        });
      }
    } catch (err) {
      log.warn({ err, eventType: type }, 'Event handler threw');
    }
  }

  /** Remove all handlers. Mainly for tests. */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }

  /** Debug: how many handlers are registered for each type. */
  stats(): { type: EventType | '*'; handlerCount: number }[] {
    const out: { type: EventType | '*'; handlerCount: number }[] = [];
    for (const [type, set] of this.handlers) {
      out.push({ type, handlerCount: set.size });
    }
    out.push({ type: '*', handlerCount: this.wildcardHandlers.size });
    return out;
  }
}

// ─── Singleton instance ─────────────────────────────────────────────────────

export const events = new EventBus();

/** Alias for readability in emit sites: `events.emit({type: 'tool.executed', ...})` or `emit({...})`. */
export const emit = events.emit.bind(events);

/** Shortcut for tests / setup code to subscribe via events.on. */
export const on = events.on.bind(events);
