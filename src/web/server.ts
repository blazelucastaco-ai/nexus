// Jarvis web server — a loopback HTTP + WebSocket surface for the orb UI.
//
// Mirrors the conventions of the existing local bridges (browser/bridge.ts,
// core/task-overlay-bridge.ts): binds 127.0.0.1 only, non-fatal on bind
// failure, keeps a Set<WebSocket> of clients. It serves the built frontend
// (web-ui/dist) and upgrades /ws connections.
//
// Security model (personal, single-user, localhost):
//   1. Loopback bind — never 0.0.0.0. NEXUS is reachable over Tailscale; this
//      surface deliberately is not.
//   2. WS upgrade requires a loopback Origin AND a per-boot token that is only
//      injected into the same-origin index.html we serve. A web page on another
//      origin can neither read the token nor pass the Origin check.
//   3. Dev mode (NEXUS_WEB_DEV=1) relaxes the token check so the Vite dev server
//      on :5173 can connect; the loopback Origin check still applies.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '../utils/logger.js';
import { getDataDir } from '../config.js';
import { WEB_DEFAULT_PORT, type ServerFrame, type ClientFrame, parseClientFrame } from './protocol.js';

const log = createLogger('WebServer');

const MAX_CLIENTS = 6;
const MAX_PAYLOAD = 4 * 1024 * 1024; // 4 MB inbound cap

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

export interface WebServerOptions {
  port?: number;
  version?: string;
  chatId?: string;
}

export type ClientMessageHandler = (frame: ClientFrame, reply: (f: ServerFrame) => void) => void;

/**
 * Resolve the directory containing the built frontend. Checked in order:
 *   1. $NEXUS_WEB_DIR (explicit override)
 *   2. ~/.nexus/app/web-ui  (deployed daemon — `pnpm build` copies here)
 *   3. <cwd>/web-ui/dist    (running from the repo with `pnpm dev`)
 */
function resolveStaticDir(): string | null {
  const candidates = [
    process.env.NEXUS_WEB_DIR,
    join(getDataDir(), 'app', 'web-ui'),
    join(process.cwd(), 'web-ui', 'dist'),
  ].filter((c): c is string => Boolean(c));
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

/** Whitelisted loopback control actions the installer can trigger (intro / research). */
export type ControlCommand = 'telegram-intro' | 'voice-intro' | 'deep-research';

export class WebServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private messageHandler: ClientMessageHandler | null = null;
  /** Loopback control hook for installer-triggered actions (set by the daemon). */
  private controlHandler: ((cmd: ControlCommand) => Promise<{ ok: boolean }>) | null = null;

  readonly port: number;
  readonly version: string;
  readonly chatId: string;
  /** Per-boot token; only injected into the same-origin index.html we serve. */
  readonly token = randomBytes(18).toString('hex');
  private staticDir: string | null = null;
  /** Set true by the daemon when the wake-word listener is active (for the UI hint). */
  wakeWordEnabled = false;
  /** Last "Hey Nexus" wake, so a freshly-opened page can pick it up on connect. */
  private lastWakeAt = 0;
  /** Short-lived cache of synthesized TTS clips, served at /tts/<id>.<ext>. */
  private readonly ttsCache = new Map<string, { buffer: Buffer; mime: string }>();

  constructor(opts: WebServerOptions = {}) {
    this.port = opts.port ?? Number(process.env.NEXUS_WEB_PORT) ?? WEB_DEFAULT_PORT;
    if (!Number.isFinite(this.port)) this.port = WEB_DEFAULT_PORT;
    this.version = opts.version ?? '0.0.0';
    this.chatId = opts.chatId ?? '';
  }

  /** Register the handler invoked for each inbound ClientFrame. */
  onMessage(handler: ClientMessageHandler): void {
    this.messageHandler = handler;
  }

  /** Register the handler for loopback control actions (POST /control). */
  onControl(handler: (cmd: ControlCommand) => Promise<{ ok: boolean }>): void {
    this.controlHandler = handler;
  }

  start(): void {
    if (this.http) return;
    this.staticDir = resolveStaticDir();
    if (!this.staticDir) {
      log.warn('Jarvis frontend not built (web-ui/dist missing) — serving placeholder. Run `pnpm --dir web-ui build`.');
    }

    const server = createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        log.warn({ err }, 'web request handler failed');
        if (!res.headersSent) res.writeHead(500);
        res.end('Internal error');
      });
    });

    const wss = new WebSocketServer({
      server,
      maxPayload: MAX_PAYLOAD,
      verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) =>
        this.verifyClient(info.origin, info.req),
    });
    wss.on('connection', (ws) => this.onConnection(ws));

    server.on('error', (err: NodeJS.ErrnoException) => {
      // Non-fatal: the daemon (and Telegram) keep running even if the port is busy.
      log.error({ err, port: this.port }, 'Jarvis web server failed to bind — the orb UI will be unavailable');
    });

    server.listen(this.port, '127.0.0.1', () => {
      log.info({ port: this.port, static: this.staticDir ?? '(placeholder)' }, `Jarvis web interface on http://127.0.0.1:${this.port}`);
    });

    this.http = server;
    this.wss = wss;
  }

  stop(): void {
    for (const ws of this.clients) {
      try { ws.close(1001, 'shutting down'); } catch { /* ignore */ }
    }
    this.clients.clear();
    try { this.wss?.close(); } catch { /* ignore */ }
    try { this.http?.close(); } catch { /* ignore */ }
    this.wss = null;
    this.http = null;
  }

  /** Push a frame to every connected browser. */
  broadcast(frame: ServerFrame): void {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(frame);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(data); } catch (err) { log.warn({ err }, 'ws send failed'); }
      }
    }
  }

  /** True when at least one browser is connected (used to gate broadcasts). */
  get hasClients(): boolean {
    return this.clients.size > 0;
  }

  /**
   * Fire a wake: record the time and tell any open page to wake + start
   * listening. A page that opens within the next few seconds (e.g. the browser
   * the daemon just launched on "Hey Nexus") also receives it on connect.
   */
  broadcastWake(): void {
    this.lastWakeAt = Date.now();
    this.broadcast({ t: 'wake' });
  }

  /** Cache a synthesized clip and return its id (served at GET /tts/<id>.<ext>). */
  putTts(buffer: Buffer, mime = 'audio/mpeg'): string {
    const id = randomBytes(8).toString('hex');
    this.ttsCache.set(id, { buffer, mime });
    while (this.ttsCache.size > 24) {
      const oldest = this.ttsCache.keys().next().value;
      if (oldest === undefined) break;
      this.ttsCache.delete(oldest);
    }
    return id;
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  private verifyClient(origin: string | undefined, req: IncomingMessage): boolean {
    // Loopback Origin check: blocks any third-party site from opening ws to us.
    // A non-browser client (no Origin) is allowed; loopback bind is the floor.
    if (origin && !isLoopbackOrigin(origin)) {
      log.warn({ origin }, 'rejected ws connection — non-loopback origin');
      return false;
    }
    if (process.env.NEXUS_WEB_DEV === '1') return true;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = url.searchParams.get('token') ?? '';
    if (token !== this.token) {
      log.warn('rejected ws connection — bad/missing token');
      return false;
    }
    return true;
  }

  private onConnection(ws: WebSocket): void {
    if (this.clients.size >= MAX_CLIENTS) {
      ws.close(1008, 'too many clients');
      return;
    }
    this.clients.add(ws);
    log.info({ clients: this.clients.size }, 'Jarvis browser connected');

    const reply = (f: ServerFrame) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(f)); } catch { /* ignore */ }
      }
    };
    reply({ t: 'hello', chatId: this.chatId, version: this.version, serverTime: Date.now(), wakeWord: this.wakeWordEnabled });
    // If "Hey Nexus" fired moments ago, this page may be the one the daemon just
    // opened — deliver the wake now so it starts listening.
    if (Date.now() - this.lastWakeAt < 8000) reply({ t: 'wake' });

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const frame = parseClientFrame(parsed);
      if (!frame) return;
      if (frame.t === 'ping') {
        reply({ t: 'pong' });
        return;
      }
      this.messageHandler?.(frame, reply);
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      log.info({ clients: this.clients.size }, 'Jarvis browser disconnected');
    });
    ws.on('error', (err) => log.warn({ err }, 'ws client error'));
  }

  // ── HTTP (static frontend) ───────────────────────────────────────────────────

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Loopback-only manual wake trigger (handy for testing the UI side).
    if (req.method === 'POST' && new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/wake') {
      this.broadcastWake();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    // Loopback control trigger for the installer (intro / deep-research). Only the
    // three whitelisted, non-destructive commands are accepted; the actual prompts
    // live in the daemon (the installer only names which action to run).
    if (req.method === 'POST' && new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/control') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 4096) { res.writeHead(413); res.end('{"ok":false}'); return; }
        chunks.push(c as Buffer);
      }
      let cmd: ControlCommand | null = null;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { command?: string };
        if (body.command === 'telegram-intro' || body.command === 'voice-intro' || body.command === 'deep-research') {
          cmd = body.command;
        }
      } catch { /* invalid json → 400 below */ }
      if (!cmd) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false}'); return; }
      const result = (await this.controlHandler?.(cmd)) ?? { ok: false };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/health' || pathname === '/nexus/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: this.version, clients: this.clients.size }));
      return;
    }

    if (pathname.startsWith('/tts/')) {
      const id = pathname.slice('/tts/'.length).replace(/\.\w+$/, '');
      const clip = this.ttsCache.get(id);
      if (clip) {
        res.writeHead(200, { 'Content-Type': clip.mime, 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : clip.buffer);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
      return;
    }

    if (!this.staticDir) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(this.placeholderHtml());
      return;
    }

    // SPA: serve the requested asset, else fall back to index.html.
    const rel = pathname === '/' ? '/index.html' : pathname;
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(this.staticDir, safe);
    if (!filePath.startsWith(this.staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let isIndex = safe === '/index.html' || safe === 'index.html';
    if (!(await fileExists(filePath))) {
      // SPA fallback: any unknown non-asset path renders the app shell.
      if (extname(safe)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      filePath = join(this.staticDir, 'index.html');
      isIndex = true;
    }

    const ext = extname(filePath).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';

    if (isIndex) {
      // Inject the per-boot token so the same-origin app can open the WS.
      const html = (await readFile(filePath, 'utf-8')).replace(
        '</head>',
        `<script>window.__NEXUS_CFG__=${JSON.stringify({ token: this.token, port: this.port, version: this.version })};</script></head>`,
      );
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  private placeholderHtml(): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>NEXUS</title>
<style>html,body{height:100%;margin:0;background:#050505;color:#ff8a3c;font:15px/1.6 ui-monospace,monospace;display:grid;place-items:center}</style></head>
<body><div style="text-align:center;max-width:34rem;padding:2rem">
<div style="width:64px;height:64px;border-radius:50%;margin:0 auto 1.5rem;background:radial-gradient(circle at 40% 35%,#ffd29a,#ff7a1c 55%,#7a2c00);box-shadow:0 0 60px 12px rgba(255,122,28,.5);animation:b 3s ease-in-out infinite"></div>
<p>The Jarvis interface backend is live, but the frontend isn't built yet.</p>
<p style="opacity:.7">Run <code>pnpm --dir web-ui install &amp;&amp; pnpm --dir web-ui build</code>, then reload.</p>
<style>@keyframes b{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.12);opacity:1}}</style>
</div></body></html>`;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1';
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}
