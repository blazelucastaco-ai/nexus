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
    | 'task.step'       // step text update (tool name or task step title)
    | 'task.completed'; // task is done; pill bar slides out + confetti
  /** Human-readable status text for the pill bar */
  text: string;
  /** Optional structured payload */
  meta?: Record<string, unknown>;
}

// Tool names that are "real work" (write files, run shell, drive GUI,
// browser, AppleScript). Quiet lookup tools (read_file, recall,
// check_injection, etc.) are filtered out so the overlay doesn't flash
// on every chat-mode response that did a tiny lookup. The overlay
// represents user-perceptible work, not internal bookkeeping.
const OVERLAY_WORK_TOOLS = new Set([
  'write_file', 'run_terminal_command', 'run_background_command',
  'click_at', 'double_click_at', 'move_mouse', 'type_text', 'press_keys',
  'scroll_at', 'open_app', 'activate_app', 'quit_app', 'set_clipboard',
  'run_applescript', 'browser_navigate', 'browser_extract', 'browser_click',
  'browser_hover', 'browser_type', 'browser_get_text', 'browser_screenshot',
  'browser_press_key', 'browser_wait_for_url', 'browser_dismiss_cookies',
  'browser_clear', 'browser_fill_form', 'take_screenshot',
  'generate_image', 'speak', 'web_fetch', 'crawl_url', 'web_search',
  'start_task', 'start_ultra_task', 'remember',
]);

// Human-readable label for a tool the overlay can show in the pill.
function pillTextForTool(name: string, params?: Record<string, unknown>): string {
  const arg = (k: string) => (params && typeof params[k] === 'string' ? String(params[k]) : '');
  switch (name) {
    case 'run_terminal_command': return `Running: ${arg('command').slice(0, 80) || 'shell command'}`;
    case 'write_file':           return `Writing: ${arg('path').split('/').pop() || 'file'}`;
    case 'open_app':             return `Opening: ${arg('name') || 'app'}`;
    case 'click_at':             return `Clicking screen`;
    case 'type_text':            return `Typing`;
    case 'press_keys':           return `Pressing keys`;
    case 'run_applescript':      return `Running AppleScript`;
    case 'browser_navigate':     return `Navigating: ${arg('url').slice(0, 60) || 'a page'}`;
    case 'browser_extract':      return `Reading page content`;
    case 'browser_click':        return `Clicking in browser`;
    case 'take_screenshot':      return `Taking screenshot`;
    case 'generate_image':       return `Generating image`;
    case 'speak':                return `Speaking`;
    case 'web_search':           return `Searching the web`;
    case 'web_fetch':            return `Fetching: ${arg('url').slice(0, 60) || 'URL'}`;
    case 'crawl_url':            return `Crawling: ${arg('url').slice(0, 60) || 'URL'}`;
    case 'start_task':           return `Starting task`;
    case 'start_ultra_task':     return `Starting (ultra)`;
    default:                     return `Working: ${name}`;
  }
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

    // Per-chat state: track whether a tool has fired during the current
    // message. If yes, message.completed → emit task.completed (overlay
    // animates out + confetti). If no tool fired (instant chat reply),
    // skip the completion event entirely.
    const chatWorkedThisMessage = new Map<string, boolean>();

    this.subs.push(
      // ── Task lifecycle (start_task path) ──
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

      // ── Chat-mode tool lifecycle (covers the much more common path
      //    where the model handles work via direct tool calls instead
      //    of escalating to start_task — Lucas's desktop reorg case) ──
      events.on('tool.executed', (e) => {
        if (!OVERLAY_WORK_TOOLS.has(e.toolName)) return;
        this.publish({
          t: new Date().toISOString(),
          kind: 'task.step',
          text: pillTextForTool(e.toolName, e.params),
          meta: { toolName: e.toolName, durationMs: e.durationMs },
        });
        // Record per-chat for the message.completed handler. We don't
        // know the chatId from tool.executed, so use a single global
        // flag plus a chat-keyed one for safety.
        chatWorkedThisMessage.set('__any__', true);
      }),

      // ── Message lifecycle — fires the completion animation if any
      //    real work happened during this message. Suppresses on
      //    instant chat replies so the overlay doesn't flash on
      //    every "what time is it." ──
      events.on('message.completed', (e) => {
        const worked = chatWorkedThisMessage.get('__any__') === true;
        chatWorkedThisMessage.delete('__any__');
        if (!worked) return;
        this.publish({
          t: new Date().toISOString(),
          kind: 'task.completed',
          text: 'Done',
          meta: { chatId: e.chatId, durationMs: e.durationMs, toolCalls: e.toolCalls },
        });
      }),
      events.on('message.failed', (e) => {
        const worked = chatWorkedThisMessage.get('__any__') === true;
        chatWorkedThisMessage.delete('__any__');
        if (!worked) return;
        this.publish({
          t: new Date().toISOString(),
          kind: 'task.completed',
          text: 'Stopped',
          meta: { chatId: e.chatId, error: e.error.slice(0, 80), durationMs: e.durationMs },
        });
      }),
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
