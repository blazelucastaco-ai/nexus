// Update Notification Popup
//
// A small toast-style window pinned to the top-right of the primary display,
// just below the macOS menu bar. Surfaces when `checkForUpdates()` reports
// `updateAvailable === true`, and walks through the full upgrade UX in-place:
//
//   prompt      → "Update available — vX.Y.Z" with [Update] [Later]
//   downloading → spinner + "Downloading vX.Y.Z…" with a thin progress bar
//   installing  → "Installing update…"
//   restarting  → "Restarting NEXUS…"
//   done        → "Re-launched on vX.Y.Z" (auto-fades after 4s)
//   error       → red border + the error string, with a "Try again" button
//
// Architecture mirrors task-overlay-window:
//   - main creates the window once and parks it (initially hidden)
//   - main sends state via webContents.send('update-popup:state', payload)
//   - renderer (inline HTML in a data: URL) listens via the preload
//     `window.updatePopup` API and re-renders
//   - clicks in the renderer fire IPC back to main: `update-popup:update`
//     (start the flow) or `update-popup:dismiss` (close the popup)
//
// Window flags:
//   - frame: false                 — no titlebar
//   - alwaysOnTop: 'floating'      — above app windows, below screen-saver
//   - skipTaskbar: true            — no Dock icon for the popup
//   - resizable/movable/closable: false — locked to the corner
//   - hasShadow: true              — native drop shadow so it reads as a
//                                    real macOS-style notification
//   - transparent: true            — corners blend with whatever's behind

import { BrowserWindow, ipcMain, screen, app } from 'electron';
import { join } from 'node:path';

const POPUP_WIDTH = 380;
const POPUP_HEIGHT = 168;  // +28px over base to fit the "release notes" link
// 12px right margin + ~30px clearance from the menu bar. macOS notifications
// sit at roughly y=44 — we match.
const POPUP_RIGHT_MARGIN = 16;
const POPUP_TOP_MARGIN = 44;

let popupWindow: BrowserWindow | null = null;
// Cache the latest state we sent so a freshly-loaded renderer can pull it
// via `update-popup:get-state` instead of relying on a `webContents.send`
// race with the renderer's listener registration.
let lastSentState: UpdatePopupState | null = null;

export type UpdatePopupState =
  | { phase: 'prompt';      installedVersion: string; latestVersion: string; downloadUrl: string; releasePageUrl?: string }
  | { phase: 'downloading'; pct: number; label: string }
  | { phase: 'installing';  label: string }
  | { phase: 'restarting';  label: string }
  | { phase: 'done';        label: string }
  | { phase: 'error';       label: string };

// Self-contained renderer. Loaded via data: URL — no separate Vite entry.
const POPUP_HTML = String.raw`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>NEXUS Update</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: transparent; overflow: hidden; -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif; user-select: none; -webkit-user-select: none; }
  body { display: flex; align-items: center; justify-content: center; }

  #card {
    width: calc(100% - 16px);
    height: calc(100% - 16px);
    margin: 8px;
    background: rgba(28, 28, 30, 0.96);
    color: #fff;
    border-radius: 14px;
    box-shadow:
      0 12px 36px -6px rgba(0, 0, 0, 0.5),
      0 0 0 1px rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    padding: 14px 16px;
    box-sizing: border-box;
    display: flex; flex-direction: column; gap: 8px;
    transform: translateX(120%);
    opacity: 0;
    transition: transform 360ms cubic-bezier(.34,1.56,.64,1), opacity 260ms ease-out;
  }
  #card.show { transform: translateX(0); opacity: 1; }
  #card.error { box-shadow: 0 12px 36px -6px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 84, 84, 0.55); }

  .row { display: flex; align-items: center; gap: 10px; }
  .icon {
    width: 28px; height: 28px; flex: 0 0 28px;
    border-radius: 8px;
    background: linear-gradient(140deg, #ff8a3d 0%, #ff5e3a 100%);
    display: flex; align-items: center; justify-content: center;
    font-size: 16px;
    color: #fff;
  }
  .title { font-size: 13px; font-weight: 600; flex: 1; }
  .subtitle { font-size: 12px; color: rgba(255,255,255,0.62); margin-top: -2px; }
  .actions { display: flex; gap: 8px; margin-top: 4px; }
  button {
    flex: 1;
    appearance: none;
    border: none;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 120ms ease, transform 80ms ease;
    font-family: inherit;
  }
  button:active { transform: scale(0.97); }
  .btn-primary { background: #ff8a3d; color: #fff; }
  .btn-primary:hover { background: #ff7826; }
  .btn-secondary { background: rgba(255,255,255,0.10); color: #fff; }
  .btn-secondary:hover { background: rgba(255,255,255,0.16); }

  #progress {
    width: 100%; height: 4px;
    background: rgba(255,255,255,0.10);
    border-radius: 4px;
    overflow: hidden;
    margin-top: 4px;
  }
  #progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #ff8a3d 0%, #ffd166 100%);
    width: 0%;
    transition: width 280ms ease-out;
    border-radius: 4px;
  }

  .spinner {
    width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.18);
    border-top-color: #ff8a3d;
    animation: spin 0.9s linear infinite;
    display: inline-block;
    flex: 0 0 12px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .status-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: rgba(255,255,255,0.84); }

  .release-link {
    display: inline-block;
    font-size: 11px;
    color: rgba(255,255,255,0.62);
    text-decoration: none;
    margin-top: 2px;
    margin-left: 38px; /* aligns under the title, past the icon column */
    transition: color 120ms ease;
    cursor: pointer;
  }
  .release-link:hover { color: rgba(255,255,255,0.92); }
</style>
</head>
<body>
<div id="card">
  <!-- Filled in dynamically by renderState() -->
</div>
<script>
(function() {
  const card = document.getElementById('card');

  function render(state) {
    if (!state) return;
    card.classList.remove('error');

    if (state.phase === 'prompt') {
      const notesLink = state.releasePageUrl
        ? \`<a class="release-link" id="release-link" href="#">View release notes →</a>\`
        : '';
      card.innerHTML = \`
        <div class="row">
          <div class="icon">↑</div>
          <div>
            <div class="title">Update available</div>
            <div class="subtitle">v\${escape(state.installedVersion)} → v\${escape(state.latestVersion)}</div>
          </div>
        </div>
        \${notesLink}
        <div class="actions">
          <button class="btn-secondary" id="later">Later</button>
          <button class="btn-primary" id="update">Update Now</button>
        </div>\`;
      document.getElementById('update').onclick = () => window.updatePopup.update();
      document.getElementById('later').onclick = () => window.updatePopup.dismiss();
      const linkEl = document.getElementById('release-link');
      if (linkEl) {
        linkEl.onclick = (e) => {
          e.preventDefault();
          window.updatePopup.openReleaseNotes();
        };
      }
    }
    else if (state.phase === 'downloading') {
      card.innerHTML = \`
        <div class="row">
          <div class="icon">↓</div>
          <div>
            <div class="title">Downloading update</div>
            <div class="subtitle">\${escape(state.label || '')}</div>
          </div>
        </div>
        <div id="progress"><div id="progress-fill" style="width:\${Math.max(2, Math.min(100, state.pct ?? 0))}%"></div></div>\`;
    }
    else if (state.phase === 'installing') {
      card.innerHTML = \`
        <div class="row">
          <div class="icon">⚙</div>
          <div>
            <div class="title">Installing update</div>
            <div class="subtitle">\${escape(state.label || 'Replacing app…')}</div>
          </div>
        </div>
        <div class="status-row"><span class="spinner"></span><span>Hold tight</span></div>\`;
    }
    else if (state.phase === 'restarting') {
      card.innerHTML = \`
        <div class="row">
          <div class="icon">↻</div>
          <div>
            <div class="title">Restarting NEXUS</div>
            <div class="subtitle">\${escape(state.label || 'Relaunching on the new version…')}</div>
          </div>
        </div>
        <div class="status-row"><span class="spinner"></span><span>Back in a moment</span></div>\`;
    }
    else if (state.phase === 'done') {
      card.innerHTML = \`
        <div class="row">
          <div class="icon" style="background:linear-gradient(140deg,#3aff8d 0%,#1eb854 100%)">✓</div>
          <div>
            <div class="title">Update complete</div>
            <div class="subtitle">\${escape(state.label || 'Running latest version.')}</div>
          </div>
        </div>\`;
      // Auto-dismiss after 4s on success.
      setTimeout(() => window.updatePopup.dismiss(), 4000);
    }
    else if (state.phase === 'error') {
      card.classList.add('error');
      card.innerHTML = \`
        <div class="row">
          <div class="icon" style="background:linear-gradient(140deg,#ff5e3a 0%,#c43328 100%)">!</div>
          <div>
            <div class="title">Update failed</div>
            <div class="subtitle">\${escape(state.label || 'Something went wrong.')}</div>
          </div>
        </div>
        <div class="actions">
          <button class="btn-secondary" id="dismiss">Dismiss</button>
          <button class="btn-primary" id="retry">Try Again</button>
        </div>\`;
      document.getElementById('retry').onclick = () => window.updatePopup.update();
      document.getElementById('dismiss').onclick = () => window.updatePopup.dismiss();
    }

    // Slide in on first render.
    requestAnimationFrame(() => card.classList.add('show'));
  }

  function escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Bridge from preload: window.updatePopup.{onState, update, dismiss, getState}.
  if (window.updatePopup && typeof window.updatePopup.onState === 'function') {
    // Future state changes come via push.
    window.updatePopup.onState(render);
  }
  // PULL the current state on mount. Fixes a race where main fires
  // webContents.send('update-popup:state', ...) before this inline
  // script has finished registering the onState listener — observed on
  // 2026-05-12 where the popup window existed at the right coords but
  // stayed fully transparent because no state ever reached the renderer.
  if (window.updatePopup && typeof window.updatePopup.getState === 'function') {
    window.updatePopup.getState().then((state) => {
      if (state) render(state);
    });
  }
})();
</script>
</body>
</html>`;

function getPopupBounds(): { x: number; y: number; width: number; height: number } {
  const primary = screen.getPrimaryDisplay();
  const work = primary.workArea; // accounts for menu bar + Dock
  return {
    x: work.x + work.width - POPUP_WIDTH - POPUP_RIGHT_MARGIN,
    y: work.y + POPUP_TOP_MARGIN,
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
  };
}

function createPopupWindow(): BrowserWindow {
  const bounds = getPopupBounds();

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    focusable: false,        // don't steal focus from whatever Lucas is doing
    hasShadow: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // need to expose update-popup IPC via preload
      preload: join(__dirname, 'update-popup-preload.js'),
      webSecurity: true,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(POPUP_HTML)}`;
  void win.loadURL(dataUrl);

  return win;
}

/**
 * Show or update the popup with the given state. Lazily creates the window
 * on first call. Subsequent calls reuse the window and just push new state.
 */
export function showUpdatePopup(state: UpdatePopupState): void {
  // Cache so the renderer can pull on mount if the push races it.
  lastSentState = state;
  if (!popupWindow || popupWindow.isDestroyed()) {
    popupWindow = createPopupWindow();
    popupWindow.once('ready-to-show', () => {
      if (popupWindow && !popupWindow.isDestroyed()) {
        popupWindow.showInactive();
        popupWindow.webContents.send('update-popup:state', state);
      }
    });
    // Fallback for data: URLs that don't fire ready-to-show.
    setTimeout(() => {
      if (popupWindow && !popupWindow.isDestroyed() && !popupWindow.isVisible()) {
        popupWindow.showInactive();
        popupWindow.webContents.send('update-popup:state', state);
      }
    }, 800);
  } else {
    if (!popupWindow.isVisible()) popupWindow.showInactive();
    popupWindow.webContents.send('update-popup:state', state);
  }
}

/** Tear down the popup. Safe to call when no popup exists. */
export function hideUpdatePopup(): void {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.destroy();
  }
  popupWindow = null;
}

/**
 * Wire IPC handlers. Call once from main.ts after `app.whenReady()`.
 *
 * The caller provides `onUpdateClicked` (runs the actual download +
 * install flow) and gets a state-update callback to drive the popup UI.
 */
export function registerUpdatePopupIpc(handlers: {
  onUpdate: (sendState: (s: UpdatePopupState) => void) => Promise<void>;
  onDismiss: () => void;
  onOpenReleaseNotes: () => void;
}): void {
  ipcMain.handle('update-popup:update', async () => {
    const sendState = (s: UpdatePopupState): void => showUpdatePopup(s);
    try {
      await handlers.onUpdate(sendState);
    } catch (err) {
      sendState({ phase: 'error', label: err instanceof Error ? err.message : String(err) });
    }
  });
  ipcMain.handle('update-popup:dismiss', async () => {
    handlers.onDismiss();
    hideUpdatePopup();
  });
  ipcMain.handle('update-popup:open-release-notes', async () => {
    handlers.onOpenReleaseNotes();
  });
  // Renderer pulls the most recent state on mount to defeat a push/listener
  // race. Returns null if nothing has been sent yet (popup shouldn't exist
  // in that state, but the handler is safe).
  ipcMain.handle('update-popup:get-state', async () => lastSentState);
}

/** Resolve the install root for in-place upgrades. */
export function getInstallRoot(): string | null {
  const exe = app.getPath('exe');
  // app.getPath('exe') points at .../NEXUS.app/Contents/MacOS/NEXUS — walk
  // up to the .app bundle.
  const m = exe.match(/^(.*\.app)\//);
  return m ? m[1] : null;
}
