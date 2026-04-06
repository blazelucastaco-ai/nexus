import { createLogger } from '../utils/logger.js';
import { generateId, nowISO } from '../utils/helpers.js';
import type { EventPriority, NexusEvent } from '../types.js';

type EventHandler = (event: NexusEvent) => Promise<void>;

const log = createLogger('EventLoop');

const PRIORITY_ORDER: Record<EventPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  background: 4,
};

export class EventLoop {
  private queue: NexusEvent[] = [];
  private handlers = new Map<string, EventHandler[]>();
  private running = false;
  private processing = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Register a handler for a specific event type, or '*' for all events.
   */
  on(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  /**
   * Emit an event into the queue.
   */
  emit(type: string, data: unknown, priority: EventPriority = 'medium', source = 'system'): void {
    const event: NexusEvent = {
      id: generateId(),
      type,
      priority,
      source,
      data,
      timestamp: nowISO(),
    };

    this.queue.push(event);
    this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

    log.debug({ type, priority }, 'Event queued');
  }

  /**
   * Start the event loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    log.info('Event loop started');

    this.pollInterval = setInterval(() => {
      this.processQueue().catch((err) => {
        log.error({ err }, 'Error processing event queue');
      });
    }, 50); // Process queue every 50ms
  }

  /**
   * Stop the event loop.
   */
  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    log.info('Event loop stopped');
  }

  /**
   * Process all queued events.
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift();
        if (!event) break;
        await this.dispatch(event);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Dispatch an event to all matching handlers.
   */
  private async dispatch(event: NexusEvent): Promise<void> {
    const handlers = [
      ...(this.handlers.get(event.type) ?? []),
      ...(this.handlers.get('*') ?? []),
    ];

    if (handlers.length === 0) {
      log.debug({ type: event.type }, 'No handlers for event');
      return;
    }

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err) {
        log.error({ err, eventType: event.type }, 'Event handler error');
      }
    }
  }

  /**
   * Get queue size.
   */
  get queueSize(): number {
    return this.queue.length;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
