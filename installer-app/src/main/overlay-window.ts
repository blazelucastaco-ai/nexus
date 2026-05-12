// Task Overlay Window
//
// Transparent fullscreen Electron window that renders:
//   - subtle orange screen glow while a task is running
//   - white pill bar at the bottom showing the current step text
//   - smooth slide-out animation + confetti burst on task completion
//
// Architecture: the RENDERER process owns the WebSocket connection to
// the daemon's task-overlay-bridge on ws://127.0.0.1:9339. The main
// process just creates the window once at app start. The window is
// always visible but fully transparent + click-through until the
// renderer's incoming WS events flip CSS classes that fade in the glow
// and slide the pill up.
//
// Why renderer-owned WS:
//   - No postMessage race between main → renderer (was losing the first
//     event because the renderer hadn't finished loading the data URL
//     by the time main fired executeJavaScript).
//   - Browser WebSocket API is built in, no `ws` dep needed in the
//     main process.
//   - Single source of truth for visual state.
//
// Window flags:
//   - transparent: true        — see-through background
//   - frame: false             — no titlebar / chrome
//   - alwaysOnTop: 'screen-saver' — above everything, including fullscreen
//   - skipTaskbar: true        — doesn't show in Dock/CMD-Tab
//   - resizable / movable / focusable: false
//   - hasShadow: false         — no native shadow
//   - setIgnoreMouseEvents(true, { forward: true }) — clicks pass through

import { BrowserWindow, screen } from 'electron';

let overlayWindow: BrowserWindow | null = null;

// ─── HTML payload (self-contained, loaded via data: URL) ──────────────
//
// Inline so we don't need a separate vite entry point. Renderer connects
// directly to ws://127.0.0.1:9339 with reconnect on disconnect. State is
// driven entirely by event class toggles on #glow + #pill.
const OVERLAY_HTML = String.raw`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>NEXUS Overlay</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; height: 100%; width: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; }
  body { pointer-events: none; }

  #glow {
    position: fixed; inset: 0;
    background: radial-gradient(ellipse at center, transparent 40%, rgba(255, 140, 0, 0.22) 100%);
    opacity: 0;
    transition: opacity 600ms cubic-bezier(.4,0,.2,1);
    pointer-events: none;
  }
  #glow.show { opacity: 1; }

  #pill {
    position: fixed;
    /* Above the Dock + home indicator. The Dock varies in height
       (~72–88px depending on size setting + magnification). 120px
       gives clearance even when the Dock is at max size + leaves
       a comfortable visual gap. */
    bottom: 120px;
    left: 50%;
    transform: translateX(-50%) translateY(80px);
    background: #FFFFFF;
    color: #111;
    padding: 14px 22px;
    border-radius: 999px;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 18px 50px -8px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 140, 0, 0.18);
    display: flex; align-items: center; gap: 10px;
    max-width: min(80vw, 720px);
    opacity: 0;
    transition: transform 480ms cubic-bezier(.34,1.56,.64,1), opacity 280ms ease-out;
    will-change: transform, opacity;
  }
  #pill.show { transform: translateX(-50%) translateY(0); opacity: 1; }
  #pill.hide { transform: translateX(-50%) translateY(80px); opacity: 0; transition: transform 540ms cubic-bezier(.4,0,.2,1), opacity 420ms ease-in; }

  #pill-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #FF8C00;
    box-shadow: 0 0 0 0 rgba(255, 140, 0, 0.55);
    animation: pulse 1.6s infinite;
    flex-shrink: 0;
  }
  @keyframes pulse {
    0%   { box-shadow: 0 0 0 0 rgba(255, 140, 0, 0.55); }
    70%  { box-shadow: 0 0 0 14px rgba(255, 140, 0, 0); }
    100% { box-shadow: 0 0 0 0 rgba(255, 140, 0, 0); }
  }

  #pill-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  #confetti { position: fixed; inset: 0; pointer-events: none; width: 100%; height: 100%; }
</style>
</head>
<body>
  <div id="glow"></div>
  <div id="pill">
    <div id="pill-dot"></div>
    <div id="pill-text">Starting…</div>
  </div>
  <canvas id="confetti"></canvas>

<script>
(function () {
  const glow = document.getElementById('glow');
  const pill = document.getElementById('pill');
  const pillText = document.getElementById('pill-text');
  const canvas = document.getElementById('confetti');
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Confetti — 220 rotated rectangles, gravity + drag, ~120-frame lifetime
  const particles = [];
  function spawnConfetti() {
    const colors = ['#FF8C00', '#FFC857', '#FFFFFF', '#FF6B35', '#06D6A0', '#118AB2'];
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    for (let i = 0; i < 220; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 6 + Math.random() * 10;
      particles.push({
        x: cx + (Math.random() - 0.5) * 200,
        y: cy + (Math.random() - 0.5) * 60,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 4,
        rot: Math.random() * Math.PI * 2,
        rotV: (Math.random() - 0.5) * 0.4,
        size: 6 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 0,
      });
    }
  }
  function tickConfetti() {
    if (particles.length === 0) return;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.vy += 0.35;
      p.vx *= 0.99; p.vy *= 0.99;
      p.x += p.vx; p.y += p.vy;
      p.rot += p.rotV;
      p.life++;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - p.life / 120);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
      if (p.y > window.innerHeight + 50 || p.life > 140) particles.splice(i, 1);
    }
    if (particles.length > 0) requestAnimationFrame(tickConfetti);
    else ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  function showActive(text) {
    pillText.textContent = text || 'Working…';
    glow.classList.add('show');
    pill.classList.remove('hide');
    pill.classList.add('show');
  }
  function showDone(text) {
    pillText.textContent = text || 'Done';
    setTimeout(() => {
      pill.classList.remove('show');
      pill.classList.add('hide');
      glow.classList.remove('show');
      spawnConfetti();
      requestAnimationFrame(tickConfetti);
    }, 280);
  }

  // WebSocket connection to daemon's task-overlay-bridge.
  let ws = null;
  let reconnectTimer = null;
  function connect() {
    try { ws = new WebSocket('ws://127.0.0.1:9339'); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = () => { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } };
    ws.onmessage = (e) => {
      let evt;
      try { evt = JSON.parse(e.data); } catch { return; }
      if (!evt || typeof evt.kind !== 'string') return;
      if (evt.kind === 'task.planned' || evt.kind === 'task.step') showActive(evt.text);
      else if (evt.kind === 'task.completed') showDone(evt.text);
    };
    ws.onclose = () => { ws = null; scheduleReconnect(); };
    ws.onerror = () => { /* close handler covers reconnect */ };
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
  }
  connect();
})();
</script>
</body>
</html>`;

function createOverlayWindow(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;

  const primary = screen.getPrimaryDisplay();
  const { x, y, width, height } = primary.bounds;

  overlayWindow = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Highest z-order Electron exposes on macOS.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  // Every click passes through to whatever's underneath.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  // Visible on every Space + over fullscreen apps.
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`;
  void overlayWindow.loadURL(dataUrl);

  // Show after the renderer is ready so we don't briefly flash a blank
  // transparent canvas. Pill + glow are invisible-by-default via CSS
  // until the renderer's WS receives an event and flips the classes.
  overlayWindow.once('ready-to-show', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.showInactive();
  });

  // Fallback — data: URLs can be flaky about firing ready-to-show on
  // some Electron versions. Force-show after 1.5s if it hasn't fired.
  // The window is fully transparent until the renderer's WS gets an
  // event so this is safe to do early.
  setTimeout(() => {
    if (overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) {
      overlayWindow.showInactive();
    }
  }, 1500);

  overlayWindow.on('closed', () => { overlayWindow = null; });
}

export function startTaskOverlay(): void {
  createOverlayWindow();
}

export function stopTaskOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  overlayWindow = null;
}
