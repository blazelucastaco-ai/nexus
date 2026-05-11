// Task Overlay Window
//
// Transparent fullscreen Electron window that renders:
//   - subtle orange screen glow while a task is running
//   - white pill bar at the bottom showing the current step text
//   - smooth slide-out animation + confetti burst on task completion
//
// Subscribes to the daemon's task-overlay-bridge WebSocket on
// 127.0.0.1:9339. Auto-reconnects on disconnect so a daemon restart
// doesn't strand the overlay forever.
//
// Window flags:
//   - transparent: true        — see-through background
//   - frame: false             — no titlebar / chrome
//   - alwaysOnTop: true        — stays above all app windows
//   - skipTaskbar: true        — doesn't show in Dock/CMD-Tab
//   - resizable: false
//   - focusable: false         — clicks pass to the window underneath
//   - hasShadow: false         — no native shadow
// setIgnoreMouseEvents(true)   — every click passes through

import { BrowserWindow, screen } from 'electron';
import WebSocket from 'ws';

const BRIDGE_URL = 'ws://127.0.0.1:9339';
const RECONNECT_MS = 3_000;

let overlayWindow: BrowserWindow | null = null;
let bridgeSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ─── HTML payload (inlined; loaded via data: URL) ──────────────────────
// Self-contained so we don't need a separate vite entry point or asset
// pipeline for the overlay. ~150 LOC of HTML+CSS+JS.
const OVERLAY_HTML = String.raw`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>NEXUS Overlay</title>
<style>
  /* fully transparent root; only the glow + pill are visible */
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; height: 100%; width: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; }
  body { pointer-events: none; }

  /* orange ambient glow — radial gradient at the edges of the screen */
  #glow {
    position: fixed; inset: 0;
    background: radial-gradient(ellipse at center, transparent 40%, rgba(255, 140, 0, 0.22) 100%);
    opacity: 0;
    transition: opacity 600ms cubic-bezier(.4,0,.2,1);
    pointer-events: none;
  }
  #glow.show { opacity: 1; }

  /* bottom pill */
  #pill {
    position: fixed;
    bottom: 36px;
    left: 50%;
    transform: translateX(-50%) translateY(60px);
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
  #pill.show {
    transform: translateX(-50%) translateY(0);
    opacity: 1;
  }
  #pill.hide {
    transform: translateX(-50%) translateY(80px);
    opacity: 0;
    transition: transform 540ms cubic-bezier(.4,0,.2,1), opacity 420ms ease-in;
  }
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
  #pill-text {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* confetti canvas — full screen, drawn on top */
  #confetti {
    position: fixed; inset: 0;
    pointer-events: none;
    width: 100%; height: 100%;
  }
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

  // Tiny self-contained confetti — no external library. Each piece is a
  // small rotated rectangle with gravity + drag. ~200 pieces per burst.
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
      p.vy += 0.35;           // gravity
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
      if (p.y > window.innerHeight + 50 || p.life > 140) {
        particles.splice(i, 1);
      }
    }
    if (particles.length > 0) requestAnimationFrame(tickConfetti);
    else ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  // Drive the visual state from messages posted by the main process.
  // The main process owns the WebSocket connection; it forwards each
  // overlay event here via webContents.send → ipcRenderer in preload.
  // To keep this overlay window simple + sandbox-safe we use a window
  // message channel instead of preload.
  window.addEventListener('message', (e) => {
    const evt = e.data;
    if (!evt || typeof evt !== 'object') return;
    if (evt.kind === 'task.planned' || evt.kind === 'task.step') {
      pillText.textContent = evt.text || 'Working…';
      glow.classList.add('show');
      pill.classList.remove('hide');
      pill.classList.add('show');
    } else if (evt.kind === 'task.completed') {
      pillText.textContent = evt.text || 'Done';
      // Brief moment showing the final text before sliding out
      setTimeout(() => {
        pill.classList.remove('show');
        pill.classList.add('hide');
        glow.classList.remove('show');
        spawnConfetti();
        requestAnimationFrame(tickConfetti);
      }, 280);
    } else if (evt.kind === 'hide') {
      pill.classList.remove('show');
      pill.classList.add('hide');
      glow.classList.remove('show');
    }
  });
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
    backgroundColor: '#00000000', // fully transparent
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Always above EVERYTHING — including fullscreen apps. 'screen-saver'
  // is the highest level Electron exposes on macOS.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  // Mouse passes through the entire overlay — user can keep working.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  // Show on all spaces / desktops + above fullscreen apps.
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`;
  void overlayWindow.loadURL(dataUrl);

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function showOverlay(evt: { kind: string; text: string }): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
  }
  if (!overlayWindow) return;
  overlayWindow.showInactive(); // show without stealing focus
  // Wait a tick for the renderer to be ready, then post the event in.
  setTimeout(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      // executeJavaScript posts the event to the renderer's window.
      // JSON.stringify the event so the renderer just reads it as data.
      const js = `window.postMessage(${JSON.stringify(evt)}, '*');`;
      void overlayWindow.webContents.executeJavaScript(js).catch(() => { /* tolerate */ });
    }
  }, 50);
}

function hideOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // Let the renderer animate the pill out + confetti before hiding the window.
  const js = `window.postMessage({ kind: 'hide' }, '*');`;
  void overlayWindow.webContents.executeJavaScript(js).catch(() => { /* tolerate */ });
  setTimeout(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  }, 1200);
}

function connectBridge(): void {
  try {
    bridgeSocket = new WebSocket(BRIDGE_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  bridgeSocket.on('open', () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  });
  bridgeSocket.on('message', (raw: Buffer) => {
    let evt: { kind: string; text: string };
    try { evt = JSON.parse(raw.toString()); } catch { return; }
    if (!evt || typeof evt.kind !== 'string') return;
    if (evt.kind === 'task.planned' || evt.kind === 'task.step') {
      showOverlay(evt);
    } else if (evt.kind === 'task.completed') {
      // Show final state + confetti, then hide after the animation runs.
      showOverlay(evt);
      setTimeout(hideOverlay, 1500);
    }
  });
  bridgeSocket.on('close', () => { bridgeSocket = null; scheduleReconnect(); });
  bridgeSocket.on('error', () => { /* swallow — reconnect handler covers it */ });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectBridge(); }, RECONNECT_MS);
}

export function startTaskOverlay(): void {
  createOverlayWindow();
  connectBridge();
}

export function stopTaskOverlay(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (bridgeSocket) { try { bridgeSocket.close(); } catch { /* ignore */ } bridgeSocket = null; }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
  }
  overlayWindow = null;
}
