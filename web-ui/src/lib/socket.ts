// WebSocket client to the NEXUS daemon. Auto-reconnects with backoff.
//
// Connection target:
//   - Served by the daemon (prod): same origin; the daemon injects
//     window.__NEXUS_CFG__ = { token, port } into index.html.
//   - Vite dev server (:5174): no injected config; connect to 127.0.0.1:4242
//     with no token. Start the daemon with NEXUS_WEB_DEV=1 so it skips the
//     token check for that cross-origin dev connection.

import type { ClientFrame, ServerFrame } from './protocol';

interface NexusCfg {
  token?: string;
  port?: number;
  version?: string;
}

function cfg(): NexusCfg {
  return (window as unknown as { __NEXUS_CFG__?: NexusCfg }).__NEXUS_CFG__ ?? {};
}

export function serverVersion(): string {
  return cfg().version ?? '';
}

function wsUrl(): string {
  const c = cfg();
  const loc = window.location;
  const devPorts = new Set(['5173', '5174']);
  const isDev = devPorts.has(loc.port) || !loc.port;
  const port = c.port ?? (isDev ? 4242 : Number(loc.port) || 4242);
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  const token = c.token ? `?token=${encodeURIComponent(c.token)}` : '';
  return `${proto}://127.0.0.1:${port}/${token}`;
}

export class NexusSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private pingTimer: number | undefined;
  private reloadedOnce = false;

  constructor(
    private readonly onFrame: (f: ServerFrame) => void,
    private readonly onStatus: (up: boolean) => void,
  ) {}

  connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.reloadedOnce = false;
      this.onStatus(true);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping' }), 25000);
    };
    ws.onmessage = (ev) => {
      try {
        this.onFrame(JSON.parse(String(ev.data)) as ServerFrame);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      this.onStatus(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.retry = Math.min(this.retry + 1, 6);
    // After a few failures (e.g. the daemon restarted and rotated its per-boot
    // token), reload once to fetch a fresh token from the freshly-served HTML.
    if (this.retry >= 4 && !this.reloadedOnce) {
      this.reloadedOnce = true;
      try {
        window.location.reload();
        return;
      } catch {
        /* ignore */
      }
    }
    const delay = Math.min(400 * 2 ** this.retry, 8000);
    window.setTimeout(() => this.connect(), delay);
  }

  send(frame: ClientFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  close(): void {
    this.closed = true;
    window.clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
