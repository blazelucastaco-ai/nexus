// SignalingClient — the Mac's connection to the self-hosted rendezvous (NEXUS_SIGNAL_URL).
// It joins a room (the pairingId), relays opaque JSON blobs to/from the phone, and keeps
// itself connected with reconnect backoff so the phone can reach the Mac at any time. It
// interprets nothing about the payloads (pairing handshake vs SDP/ICE) — the PhoneLink
// above it decides. Reconnect is reactive (on drop), only while a room is joined — not a
// background poller.

import { WebSocket } from 'ws';
import { createLogger } from '../utils/logger.js';

const log = createLogger('signaling');

export interface SignalingEvents {
  /** The peer joined (true) or left (false) the room. */
  onPeerPresent?: (present: boolean) => void;
  /** An opaque relayed blob from the peer (already JSON-parsed). */
  onMessage?: (msg: unknown) => void;
  onOpen?: () => void;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private room: string | null = null;
  private closed = true;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly role: 'mac' | 'phone',
    private readonly events: SignalingEvents = {},
  ) {}

  /** Join (or switch to) a room and keep the connection alive until stop(). */
  join(room: string): void {
    this.room = room;
    this.closed = false;
    this.connect();
  }

  get joinedRoom(): string | null {
    return this.closed ? null : this.room;
  }

  send(msg: unknown): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private connect(): void {
    if (this.closed || !this.room) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.url}/?room=${this.room}&role=${this.role}`);
    } catch (e) {
      log.warn({ err: String(e) }, 'signaling connect threw');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = 1000;
      log.info({ room: this.room }, 'signaling connected');
      this.events.onOpen?.();
    });
    ws.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignore malformed
      }
      if (msg && typeof msg === 'object' && (msg as { t?: string }).t === 'peer') {
        this.events.onPeerPresent?.(Boolean((msg as { present?: boolean }).present));
        return;
      }
      this.events.onMessage?.(msg);
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    });
    ws.on('error', (err) => {
      log.warn({ err: String(err) }, 'signaling socket error');
      try {
        ws.close();
      } catch {
        /* close() may throw if already closing */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
