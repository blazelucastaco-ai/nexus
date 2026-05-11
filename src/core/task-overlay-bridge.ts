// Task Overlay Bridge — broadcasts task lifecycle events over a local
// WebSocket so the installer-app's overlay window can render orange-tint
// + pill-bar + confetti during tasks. Lucas asked for this on 2026-05-11.
//
// Subscribes to: task.planned, task.step.started, task.step.completed,
// task.completed. Pushes a thin JSON event to every connected client.
// No back-channel from client → daemon: pure outbound. Origin-restricted
// to loopback so non-localhost clients can't subscribe.

import { WebSocketServer, WebSocket } from 'ws';
import { events, type Subscription } from './events.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('TaskOverlayBridge');

export const TASK_OVERLAY_PORT = 9339;
const MAX_CLIENTS = 4; // Realistically just installer-app menubar + maybe a dev viewer

export interface OverlayEvent {
  /** ISO timestamp when the event was emitted */
  t: string;
  /** Event kind — maps to the orchestrator's internal event types */
  kind:
    | 'task.planned'    // task is starting; pill bar should appear
    | 'task.step'       // step text update
    | 'task.completed'; // task is done; pill bar slides out + confetti
  /** Human-readable status text for the pill bar */
  text: string;
  /** Optional structured payload */
  meta?: Record<string, unknown>;
}

export class TaskOverlayBridge {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private subs: Subscription[] = [];

  start(): void {
    if (this.wss) return;
    try {
      this.wss = new WebSocketServer({
        port: TASK_OVERLAY_PORT,
        host: '127.0.0.1',
        maxPayload: 64 * 1024,
      });
    } catch (err) {
      log.error({ err, port: TASK_OVERLAY_PORT }, 'Task overlay bridge failed to bind — overlay events will not be delivered');
      return;
    }
    log.info({ port: TASK_OVERLAY_PORT }, 'Task overlay bridge listening');

    this.wss.on('connection', (ws) => {
      if (this.clients.size >= MAX_CLIENTS) {
        log.warn('Too many overlay clients — rejecting');
        ws.close(1008, 'Too many clients');
        return;
      }
      this.clients.add(ws);
      log.info({ count: this.clients.size }, 'Overlay client connected');

      const keepalive = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try { ws.ping(); } catch { /* non-fatal */ }
      }, 25_000);

      ws.on('close', () => {
        clearInterval(keepalive);
        this.clients.delete(ws);
        log.info({ count: this.clients.size }, 'Overlay client disconnected');
      });
      ws.on('error', () => { /* tolerate quietly */ });
    });

    this.wss.on('error', (err) => log.error({ err }, 'Overlay bridge server error'));

    this.subs.push(
      events.on('task.planned', (e) => this.publish({
        t: new Date().toISOString(),
        kind: 'task.planned',
        text: `Starting: ${e.title}`,
        meta: { stepCount: e.stepCount },
      })),
      events.on('task.step.started', (e) => this.publish({
        t: new Date().toISOString(),
        kind: 'task.step',
        text: `${e.stepTitle}`,
        meta: { stepId: e.stepId, planTitle: e.planTitle },
      })),
      events.on('task.completed', (e) => this.publish({
        t: new Date().toISOString(),
        kind: 'task.completed',
        text: e.success ? `Done: ${e.title}` : `Partial: ${e.title}`,
        meta: { success: e.success, durationMs: e.durationMs, stepsCompleted: e.stepsCompleted, totalSteps: e.totalSteps },
      })),
    );
  }

  private publish(evt: OverlayEvent): void {
    const json = JSON.stringify(evt);
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(json); } catch (err) { log.debug({ err }, 'Overlay send failed (client drop)'); }
    }
  }

  stop(): void {
    for (const sub of this.subs) {
      try { sub.unsubscribe(); } catch { /* ignore */ }
    }
    this.subs = [];
    for (const ws of this.clients) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
    log.info('Task overlay bridge stopped');
  }
}

export const taskOverlayBridge = new TaskOverlayBridge();
