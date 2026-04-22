import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  runSystemChecks,
  checkRepo,
  runInstall,
  reconfigure,
  checkPermissions,
  openPrefs,
  checkChrome,
  openChromeExtensions,
  getExtensionPath,
  testExtensionConnection,
  detectExistingInstall,
  uninstall,
  getServiceStatus,
  startService,
  stopService,
  restartService,
  openLogs,
  registerMenubarAgent,
  getDashboardState,
  tailLog,
  checkForUpdates,
  runUpdate,
  listMemories,
  deleteMemory,
  takeScreenshot,
  triggerDream,
  runHealthCheck,
  detectMemorySources,
  runMemoryImport,
  hubSignup,
  hubLogin,
  hubLogout,
  hubActiveSession,
  hubRegisterInstance,
  hubListInstances,
  getAboutInfo,
} from './installer-core';
import type { ConfigInput, InstallProgress, UpdateProgress } from '../shared/types';

const isDev = process.env.NEXUS_INSTALLER_DEV === '1';
const isMenubarMode = process.argv.includes('--menubar');
const initialRoute = process.argv.find((a) => a.startsWith('--route='))?.slice('--route='.length);

/**
 * URL allowlist for shell.openExternal + navigation handlers. Blocks
 * `javascript:`, `file:`, `data:`, and any custom protocol that could
 * trigger arbitrary app launches via URL handlers. Only obvious safe
 * schemes are let through.
 */
const AGENT_ID_ALLOWLIST = new Set([
  'vision', 'file', 'browser', 'terminal', 'code', 'research', 'system', 'creative', 'comms', 'scheduler',
]);
const PRESET_ALLOWLIST = new Set(['professional', 'friendly', 'sarcastic_genius', 'custom']);

/**
 * Validate a ConfigInput payload from the renderer before letting it touch
 * disk. Rejects anything malformed. This is defense-in-depth — contextIsolation
 * already prevents the web page from directly calling Node, but a compromised
 * renderer could still send junk via the exposed IPC bridge.
 */
function validateConfigInput(x: unknown): ConfigInput {
  if (!x || typeof x !== 'object') throw new Error('Invalid config: not an object');
  const c = x as Partial<ConfigInput>;

  // Telegram
  if (!c.telegram || typeof c.telegram !== 'object') throw new Error('Invalid config: telegram');
  if (typeof c.telegram.botToken !== 'string' || c.telegram.botToken.length > 1024) throw new Error('Invalid bot token');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(c.telegram.botToken)) throw new Error('Bot token format');
  if (typeof c.telegram.chatId !== 'string' || !/^-?\d{1,32}$/.test(c.telegram.chatId)) throw new Error('Chat ID format');

  // Anthropic key
  if (typeof c.anthropicKey !== 'string') throw new Error('Invalid anthropic key');
  if (!c.anthropicKey.startsWith('sk-ant-') || c.anthropicKey.length > 512) throw new Error('Anthropic key format');

  // Agents
  if (!Array.isArray(c.agents) || c.agents.length > 16) throw new Error('Invalid agents');
  for (const a of c.agents) {
    if (typeof a !== 'string' || !AGENT_ID_ALLOWLIST.has(a)) throw new Error(`Unknown agent: ${a}`);
  }

  // Personality
  if (!c.personality || typeof c.personality !== 'object') throw new Error('Invalid personality');
  if (!PRESET_ALLOWLIST.has(c.personality.preset)) throw new Error('Unknown preset');
  const t = c.personality.traits;
  if (!t || typeof t !== 'object') throw new Error('Invalid traits');
  for (const k of ['humor', 'sarcasm', 'formality', 'assertiveness', 'verbosity', 'empathy'] as const) {
    const v = (t as Record<string, unknown>)[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`Invalid trait ${k}`);
    }
  }

  return c as ConfigInput;
}

function isSafeExternalUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    // macOS System Settings deep-links are how we open permission panes.
    if (u.protocol === 'x-apple.systempreferences:') return true;
    if (u.protocol === 'https:' || u.protocol === 'http:') return true;
    if (u.protocol === 'mailto:') return true;
    return false;
  } catch {
    return false;
  }
}

let wizardWindow: BrowserWindow | null = null;
let dashboardWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let statusPollTimer: ReturnType<typeof setInterval> | null = null;

// ─────────────────────────────────────────────────────────────────────
// WINDOWS
// ─────────────────────────────────────────────────────────────────────

function createWizardWindow(_route?: 'wizard' | 'dashboard'): void {
  if (wizardWindow && !wizardWindow.isDestroyed()) {
    wizardWindow.show();
    wizardWindow.focus();
    return;
  }
  wizardWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 860,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#FAF6EE',
    title: 'NEXUS',
    show: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });
  wizardWindow.once('ready-to-show', () => wizardWindow?.show());
  setTimeout(() => {
    if (wizardWindow && !wizardWindow.isDestroyed() && !wizardWindow.isVisible()) {
      wizardWindow.show();
    }
  }, 2000);
  if (isDev) {
    void wizardWindow.loadURL('http://127.0.0.1:5173');
  } else {
    void wizardWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }
  wizardWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wizardWindow.webContents.on('will-navigate', (e, url) => {
    // Only allow navigating within the loaded file:// + dev server.
    if (!url.startsWith('file://') && !url.startsWith('http://127.0.0.1:5173')) {
      e.preventDefault();
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
    }
  });
  wizardWindow.on('closed', () => {
    wizardWindow = null;
  });
}

function createDashboardWindow(): void {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }
  dashboardWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#FAF6EE',
    title: 'NEXUS',
    show: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });
  dashboardWindow.once('ready-to-show', () => dashboardWindow?.show());
  // Fallback: if renderer never signals ready (e.g. a bundle error), show
  // the window anyway after 2s so the user sees something rather than nothing.
  setTimeout(() => {
    if (dashboardWindow && !dashboardWindow.isDestroyed() && !dashboardWindow.isVisible()) {
      dashboardWindow.show();
    }
  }, 2000);
  dashboardWindow.webContents.on('did-fail-load', (_e, _code, desc, url) => {
    console.error('Dashboard renderer failed to load:', desc, url);
  });
  if (isDev) {
    void dashboardWindow.loadURL('http://127.0.0.1:5173?route=dashboard');
  } else {
    void dashboardWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'), {
      query: { route: 'dashboard' },
    });
  }
  dashboardWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  dashboardWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith('http://127.0.0.1:5173')) {
      e.preventDefault();
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
    }
  });
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
}

// ─────────────────────────────────────────────────────────────────────
// MENUBAR MODE
// ─────────────────────────────────────────────────────────────────────

// 22x22 + 44x44 @2x NEXUS brain logo (full color — from docs/logo.png).
// NOT a template image — we want the terracotta brand colour to show
// through in the menu bar.
const TRAY_ICON_22 =
  'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAADFUlEQVR4nO1US2xUVRj+/nPOfUxn2pm00AHBgQlMg31EI5HEoPRhQlIStGKm3bAhJLAAFxASIcFcxo24cOXWsDBsuENcaKIYCSRKNMoCWNAFWiihQBtrHzPt0Jl7z/3JvaUVGlBTlvrlnOS8/u/8+f7vHOB//BswQOzmJTudil1XMrO4GI3zkhm0TEJXYhmxC3h6JBHAjInXsa7+re42X1MXmXbGeK1rTe2n736RVuz30tDVr1d8MXKX2RFEheBviTmcOw4NFwrm6pPvHRRWfJ+xYVMOHAArVgO+BibHgEwLapfO3fXOnTl++ZvK6S4HARXC8Kg/ScyhZiccmv7hZNbatv0ze/vOXmiJ2viopoZGDsZGIFJNBNNmfjADJaUSQRUzl84fqf/kwqeh7tRf1At8YjHdoiuoUAjU1u5DdltHr+fLqhdwIJJNEl5VqVyHEo3NEnMVJZpWKW3FtM60splr/bDUbW9D3mV2/uKLBuEC9ffrmT25l+31uQN+vNlHrWqS9gViccD3ENy7jeDeMMS6FnBpAjLXIWsXv9Jm66tJo6d3PxEFaHMXFZi/YTAfLeixUVuuyQLpF5iUCmDagFcD7DpQqhGyfQt4Zhpk1UFf+xlmzzvSL88yrXrx3YnNyFD/gF7Iep64WAwiubk6Wfnx25tqbspQiaTUd34LqHElyI6D4kmEOpMyIDe9ApF9CVyeAkvFuH/LNpJG6rHaQT2qIIetIbFx+E/3+05ZGj8qyhOd1p5j7f6DikYsxmzGCESCq3MUjNxC8Md9sDC0mapXlempIW/au83M4Rl+ho8pcs1oFun6XW+cqtsxsCOy2c3r8GUM3uQ4k7IIdQnPsg3Du3FluHZn6HhiQ6KIE4MeEZ5OzKE8bp5o4KwOPTi7e22fMKxmr1ROmxvb36eGVBOns8LKrId349pY5cvP305dwK+ch6QiFu32THD4/sIX+BhqH/Vt5tMfcHlvy9m5vsSuUSC94Kp/JFwKzufl/EfkRPWYPdrzceXwmwPRJonlkS4FO4544sLn+aWW4lH2z58l/jN4CGCnRA5C6O+gAAAAAElFTkSuQmCC';
const TRAY_ICON_44 =
  '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';

function makeTrayIcon(_active: boolean): Electron.NativeImage {
  const img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_22, 'base64'));
  img.addRepresentation({
    scaleFactor: 2,
    width: 44,
    height: 44,
    buffer: Buffer.from(TRAY_ICON_44, 'base64'),
  });
  return img;
}

// Remembers the last running state so we only fire a notification on
// transition (not every 3s poll).
let lastServiceRunning: boolean | null = null;

async function rebuildTrayMenu(): Promise<void> {
  if (!tray) return;
  const status = await getServiceStatus().catch(
    () =>
      ({
        registered: false,
        running: false,
        bridgeConnected: false,
        pid: undefined,
      }) as Awaited<ReturnType<typeof getServiceStatus>>,
  );

  // Fire a native notification on running → stopped transition. Skip the
  // initial read (lastServiceRunning === null) to avoid a ghost notification
  // on app boot.
  if (lastServiceRunning === true && status.running === false && status.registered) {
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: 'NEXUS stopped',
          body: 'The background service is no longer running. Open the dashboard to investigate.',
          silent: false,
        }).show();
      }
    } catch {
      /* ignore — notifications are best-effort */
    }
  }
  lastServiceRunning = status.running;

  tray.setImage(makeTrayIcon(status.running));
  tray.setToolTip(`NEXUS · ${status.running ? 'Running' : status.registered ? 'Stopped' : 'Not installed'}`);

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: status.running
        ? `● NEXUS running${status.pid ? ` (pid ${status.pid})` : ''}`
        : status.registered
          ? '○ NEXUS stopped'
          : '○ NEXUS not installed',
      enabled: false,
    },
    {
      label: status.bridgeConnected ? '● Chrome extension connected' : '○ Chrome extension idle',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open NEXUS dashboard…',
      click: () => { createDashboardWindow(); },
    },
    { type: 'separator' },
    {
      label: 'Start NEXUS',
      enabled: status.registered && !status.running,
      click: async () => { await startService(); await rebuildTrayMenu(); },
    },
    {
      label: 'Stop NEXUS',
      enabled: status.running,
      click: async () => { await stopService(); await rebuildTrayMenu(); },
    },
    {
      label: 'Restart NEXUS',
      enabled: status.registered,
      click: async () => { await restartService(); await rebuildTrayMenu(); },
    },
    { type: 'separator' },
    {
      label: 'Open Logs',
      enabled: status.registered,
      click: () => { void openLogs(); },
    },
    {
      label: 'Open Telegram',
      click: () => { void shell.openExternal('https://t.me'); },
    },
    { type: 'separator' },
    {
      label: 'Reconfigure NEXUS…',
      click: () => { createWizardWindow('wizard'); },
    },
    {
      label: 'About NEXUS',
      click: () => {
        createDashboardWindow();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit menu bar app',
      click: () => {
        if (statusPollTimer) clearInterval(statusPollTimer);
        app.quit();
      },
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function startMenubarMode(): void {
  if (!wizardWindow && !dashboardWindow) {
    app.dock?.hide();
  }
  tray = new Tray(makeTrayIcon(false));
  void rebuildTrayMenu();
  statusPollTimer = setInterval(() => {
    void rebuildTrayMenu();
  }, 3_000);
  app.on('before-quit', () => {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
// APP LIFECYCLE + IPC
// ─────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Wizard IPC
  ipcMain.handle('system:checks', async () => runSystemChecks());
  ipcMain.handle('repo:status', async () => checkRepo());
  ipcMain.handle('permissions:check', async () => checkPermissions());
  ipcMain.handle('permissions:open', async (_e, url: string) => {
    if (!isSafeExternalUrl(url)) throw new Error('URL rejected by allowlist');
    return openPrefs(url);
  });
  ipcMain.handle('chrome:check', async () => checkChrome());
  ipcMain.handle('chrome:open-extensions', async (_e, label: string) => openChromeExtensions(label));
  ipcMain.handle('chrome:extension-path', async () => getExtensionPath());
  ipcMain.handle('chrome:test-connection', async () => testExtensionConnection());
  ipcMain.handle('external:open', async (_e, url: string) => {
    if (!isSafeExternalUrl(url)) throw new Error('URL rejected by allowlist');
    return shell.openExternal(url);
  });

  ipcMain.handle('detect:existing', async () => detectExistingInstall());
  ipcMain.handle('detect:uninstall', async (_e, options: { removeRepo: boolean }) => {
    await uninstall(options);
    return { ok: true };
  });

  ipcMain.handle('install:run', async (event, rawInput: unknown) => {
    const send = (p: InstallProgress): void => { event.sender.send('install:progress', p); };
    try {
      const input = validateConfigInput(rawInput);
      await runInstall(input, send);
      const appBin = app.getPath('exe');
      await registerMenubarAgent(appBin);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('install:reconfigure', async (event, rawInput: unknown) => {
    const send = (p: InstallProgress): void => { event.sender.send('install:progress', p); };
    try {
      const input = validateConfigInput(rawInput);
      await reconfigure(input, send, app.getPath('exe'));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('service:status', async () => getServiceStatus());
  ipcMain.handle('service:start', async () => startService());
  ipcMain.handle('service:stop', async () => stopService());
  ipcMain.handle('service:restart', async () => restartService());
  ipcMain.handle('service:logs', async () => openLogs());

  // ── Main-app IPC ──
  ipcMain.handle('main:dashboard', async () => getDashboardState());
  ipcMain.handle('main:about', async () => getAboutInfo(app.getPath('exe')));
  ipcMain.handle('main:memories', async (_e, opts: { limit?: number; type?: string }) => listMemories(opts ?? {}));
  ipcMain.handle('main:updates-check', async () => checkForUpdates());
  ipcMain.handle('main:updates-run', async (event) => {
    const send = (p: UpdateProgress): void => { event.sender.send('main:update-progress', p); };
    try {
      await runUpdate(send);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Log tail — one active tail per webContents to avoid leaks.
  const tails = new Map<number, { stop: () => void }>();
  ipcMain.handle('main:log-tail-start', async (event) => {
    const id = event.sender.id;
    tails.get(id)?.stop();
    const t = tailLog((line) => {
      if (!event.sender.isDestroyed()) event.sender.send('main:log-line', line);
    });
    tails.set(id, t);
    event.sender.once('destroyed', () => {
      t.stop();
      tails.delete(id);
    });
    return { ok: true };
  });
  ipcMain.handle('main:log-tail-stop', async (event) => {
    const id = event.sender.id;
    tails.get(id)?.stop();
    tails.delete(id);
    return { ok: true };
  });

  ipcMain.handle('main:open-dashboard', () => { createDashboardWindow(); });
  ipcMain.handle('main:open-wizard', () => { createWizardWindow('wizard'); });

  ipcMain.handle('main:memory-delete', async (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
    return deleteMemory(id);
  });
  ipcMain.handle('main:action-screenshot', async () => takeScreenshot());
  ipcMain.handle('main:action-dream', async () => triggerDream());
  ipcMain.handle('main:action-health', async () => runHealthCheck());
  ipcMain.handle('main:memory-detect-sources', async () => detectMemorySources());
  ipcMain.handle('main:memory-import', async (_e, sourceIds: unknown) => {
    if (!Array.isArray(sourceIds)) return { imported: 0, skipped: 0, sources: {} };
    const ids = sourceIds.filter((x): x is string => typeof x === 'string');
    return runMemoryImport(ids);
  });

  // ── Nexus Hub ────────────────────────────────────────────────────
  ipcMain.handle('hub:signup', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid_input' };
    const p = payload as Record<string, unknown>;
    if (typeof p.email !== 'string' || typeof p.password !== 'string' || typeof p.displayName !== 'string') {
      return { ok: false, error: 'invalid_input' };
    }
    return hubSignup({ email: p.email, password: p.password, displayName: p.displayName });
  });
  ipcMain.handle('hub:login', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid_input' };
    const p = payload as Record<string, unknown>;
    if (typeof p.email !== 'string' || typeof p.password !== 'string') {
      return { ok: false, error: 'invalid_input' };
    }
    return hubLogin({ email: p.email, password: p.password });
  });
  ipcMain.handle('hub:logout', async () => hubLogout());
  ipcMain.handle('hub:session', async () => hubActiveSession());
  ipcMain.handle('hub:register-instance', async (_e, name: unknown) => {
    if (typeof name !== 'string' || !name) return { ok: false, error: 'invalid_name' };
    return hubRegisterInstance(name);
  });
  ipcMain.handle('hub:list-instances', async () => hubListInstances());

  if (isMenubarMode) {
    startMenubarMode();
  } else if (initialRoute === 'dashboard') {
    createDashboardWindow();
  } else if (initialRoute === 'wizard') {
    createWizardWindow();
  } else {
    // No explicit route: if NEXUS is already installed, land on the
    // dashboard. Only first-time users see the wizard.
    void detectExistingInstall()
      .then((d) => {
        const installed = d.configExists || d.serviceRegistered;
        if (installed) {
          createDashboardWindow();
        } else {
          createWizardWindow();
        }
      })
      .catch(() => createWizardWindow());
  }

  app.on('activate', () => {
    if (!isMenubarMode && BrowserWindow.getAllWindows().length === 0) {
      createWizardWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (!isMenubarMode && process.platform !== 'darwin') app.quit();
});

void homedir;
