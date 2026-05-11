import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';
import type { BridgeAction, BridgeCommand, BridgeResponse } from './protocol.js';

const log = createLogger('BrowserBridge');

export const BRIDGE_PORT = 9338;
const COMMAND_TIMEOUT_MS = 30_000;
// 25s server-side WebSocket ping keeps Chrome MV3 service workers from
// going idle and dropping the connection (2026-05-11 flap diagnosis —
// observed 5+ disconnect/reconnect cycles during a single 30 min task).
const KEEPALIVE_INTERVAL_MS = 25_000;
// 10 MB max frame — LoopNet / large-content pages extracted via
// browser_extract routinely exceed 1 MB. The earlier 1 MB cap was
// silently killing the connection mid-extract, causing the flap pattern.
// Origin check already rejects non-extension connections.
const MAX_BRIDGE_PAYLOAD = 10 * 1024 * 1024;

interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserBridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private readonly pending = new Map<string, PendingCommand>();
  private _connectedAt: Date | null = null;
  private onConnectCb: (() => void) | null = null;
  private onDisconnectCb: (() => void) | null = null;

  /** Register a callback that fires whenever the Chrome extension connects. */
  onConnect(cb: () => void): void { this.onConnectCb = cb; }

  /** Register a callback that fires whenever the Chrome extension disconnects. */
  onDisconnect(cb: () => void): void { this.onDisconnectCb = cb; }

  start(): void {
    if (this.wss) return;

    try {
      // maxPayload caps incoming frames. 10 MB accommodates browser_extract
      // results from content-heavy pages (LoopNet listings, multi-pane SPAs,
      // pages with embedded data tables). Earlier 1 MB cap silently closed
      // the connection mid-extract — the symptom Lucas observed was the
      // flap pattern during a real LoopNet scrape. Origin check (below)
      // still rejects non-extension WebSocket clients.
      this.wss = new WebSocketServer({
        port: BRIDGE_PORT,
        host: '127.0.0.1',
        maxPayload: MAX_BRIDGE_PAYLOAD,
      });
    } catch (err) {
      log.error({ err, port: BRIDGE_PORT }, `Failed to start browser bridge — port may be in use`);
      throw err;
    }
    log.info({ port: BRIDGE_PORT }, 'Browser bridge listening for Chrome extension');

    this.wss.on('connection', (ws, req) => {
      // Origin check: only accept connections from the NEXUS Chrome extension
      // (chrome-extension://...) or from a tool explicitly identifying itself
      // via a user-agent match. Reject browser tabs / other origins — a malicious
      // page running JS could otherwise open ws://127.0.0.1:9338 and drive the
      // bridge (SSRF-adjacent attack on an in-process service).
      const origin = req.headers['origin'];
      const userAgent = String(req.headers['user-agent'] ?? '');
      const isExtension = typeof origin === 'string' && origin.startsWith('chrome-extension://');
      const isLoopbackTool = !origin && /nexus|node|curl|ws-cli/i.test(userAgent);
      if (!isExtension && !isLoopbackTool) {
        log.warn({ origin, userAgent: userAgent.slice(0, 80) }, 'Bridge: rejecting connection with unrecognized origin');
        ws.close(1008, 'Origin not allowed');
        return;
      }

      // Only allow one client at a time — check AND assign atomically
      // (Node's event loop makes this synchronous block atomic)
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        log.warn('Second extension tried to connect — rejecting');
        ws.close(1008, 'Only one client allowed');
        return;
      }
      this.client = ws;

      log.info('Chrome extension connected');
      this._connectedAt = new Date();
      this.onConnectCb?.();

      // Server-initiated keepalive — WebSocket protocol-level ping every
      // 25s. Chrome auto-responds with pong without waking the user's
      // page-level code, but the activity keeps the extension's service
      // worker alive past its idle threshold and lets us detect a dead
      // socket via ws.on('close') instead of stale-pending-command leaks.
      const keepaliveTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try { ws.ping(); } catch (e) { log.debug({ e }, 'Bridge keepalive ping failed (non-fatal)'); }
      }, KEEPALIVE_INTERVAL_MS);

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as BridgeResponse | { type: 'ping' };

          // Heartbeat
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }

          // Command response
          if (msg.type === 'response') {
            const pending = this.pending.get(msg.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            if (msg.success) {
              pending.resolve(msg.data);
            } else {
              pending.reject(new Error(msg.error ?? 'Command failed'));
            }
          }
        } catch (err) {
          log.warn({ err }, 'Failed to parse bridge message');
        }
      });

      ws.on('close', () => {
        log.info('Chrome extension disconnected');
        clearInterval(keepaliveTimer);
        if (this.client === ws) {
          this.client = null;
          this._connectedAt = null;
          this.onDisconnectCb?.();
        }
        // Reject all pending commands
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Chrome extension disconnected'));
          this.pending.delete(id);
        }
      });

      ws.on('error', (err) => log.warn({ err }, 'Bridge client error'));
    });

    this.wss.on('error', (err) => log.error({ err }, 'Browser bridge error'));
  }

  get isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  get connectedAt(): Date | null {
    return this._connectedAt;
  }

  send<T = unknown>(action: BridgeAction, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.isConnected) {
      return Promise.reject(
        new Error('Chrome extension not connected. Install the NEXUS Bridge extension in Chrome.'),
      );
    }

    // Cap the pending map so a misbehaving extension or flood of commands
    // can't exhaust memory. In practice there should be at most a handful
    // of commands in flight at once.
    const MAX_PENDING = 256;
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(
        new Error(`Bridge: too many commands in flight (${this.pending.size} >= ${MAX_PENDING})`),
      );
    }

    const id = generateId();
    const cmd: BridgeCommand = { id, type: 'command', action, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command timed out after ${COMMAND_TIMEOUT_MS}ms: ${action}`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (d: unknown) => void,
        reject,
        timer,
      });

      this.client!.send(JSON.stringify(cmd));
    });
  }

  stop(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bridge shutting down'));
    }
    this.pending.clear();
    this.client?.close();
    this.client = null;
    this.wss?.close();
    this.wss = null;
    log.info('Browser bridge stopped');
  }
}

// Singleton used across NEXUS
export const browserBridge = new BrowserBridge();
