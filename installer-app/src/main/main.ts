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

// 22x22 + 44x44 @2x NEXUS "N" glyph (monochrome). We use setTemplateImage so
// macOS inverts based on menu bar appearance — bigger + crisper than the
// previous 16x16 scaled-down color logo.
const TRAY_ICON_22 =
  'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAZklEQVR4nNXUQQoAIQxD0f65/511Kwy0TSULsxKsj5KFEa+F47ySuyq/t58wLCWDr/AKDie8XPAIz2Bu8GpjpninCiZ4t2OaczIc6tYKjIKrG9PFJ1XQwacd4/wrcMHhhHHBKW7JBgy8DSblzxQFAAAAAElFTkSuQmCC';
const TRAY_ICON_44 =
  'iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAAs0lEQVR4nO2YwQ3DMAwDSe6/M7tAH20iy6LhewaRchAowDFwuWTDL8/85/tV+JfvqrBpC3pQ4zRhJAobgRM2AiNhBGbYCFw6Y6gwsRkV9vJUYe6U1sO6bdJ6UbtFWi/r26VV0IMnHX48VbgtGirs1SIt1LJcWqhnqbSwBp70i+SpwkuisXrCrJbuiAQrpbsyzCrpzqXjSRcpnirMxAkzMRJMzDATl45pwkgUZprwiCuwSywfqUIZSjTBfFcAAAAASUVORK5CYII=';

function makeTrayIcon(_active: boolean): Electron.NativeImage {
  const img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_22, 'base64'));
  img.addRepresentation({
    scaleFactor: 2,
    width: 44,
    height: 44,
    buffer: Buffer.from(TRAY_ICON_44, 'base64'),
  });
  // Template images render in the current menu bar accent color (black on
  // light mode, white on dark). Way more prominent than the muddy scaled-
  // down logo we had before.
  img.setTemplateImage(true);
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
