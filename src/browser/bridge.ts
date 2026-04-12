import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';
import type { BridgeAction, BridgeCommand, BridgeResponse } from './protocol.js';

const log = createLogger('BrowserBridge');

export const BRIDGE_PORT = 9338;
const COMMAND_TIMEOUT_MS = 30_000;

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

    this.wss = new WebSocketServer({ port: BRIDGE_PORT, host: '127.0.0.1' });
    log.info({ port: BRIDGE_PORT }, 'Browser bridge listening for Chrome extension');

    this.wss.on('connection', (ws) => {
      // Only allow one client at a time
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        log.warn('Second extension tried to connect — rejecting');
        ws.close(1008, 'Only one client allowed');
        return;
      }

      log.info('Chrome extension connected');
      this.client = ws;
      this._connectedAt = new Date();
      this.onConnectCb?.();

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
