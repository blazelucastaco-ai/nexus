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
import { readFileSync } from 'node:fs';

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
// HTML lives in popup.html next to this file. Reading it at module load
// (rather than inlining as a TypeScript template literal) avoids the
// String.raw-escapes-bleed-into-inner-template-literals trap that left
// the renderer with a SyntaxError on 2026-05-13 — the inline `<script>`
// in the data: URL had backticks of the form `\\\`` which JS rejected,
// so the script never ran, render() never fired, and the card stayed
// at the default opacity:0/translateX(120%) (invisible off-screen).
const POPUP_HTML = readFileSync(join(__dirname, 'popup.html'), 'utf-8');

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
    focusable: false,        // don't steal focus from whatever the user is doing
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
