import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
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
} from './installer-core';
import type { ConfigInput, InstallProgress } from '../shared/types';

const isDev = process.env.NEXUS_INSTALLER_DEV === '1';
const isMenubarMode = process.argv.includes('--menubar');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let statusPollTimer: ReturnType<typeof setInterval> | null = null;

// ─────────────────────────────────────────────────────────────────────
// WIZARD WINDOW
// ─────────────────────────────────────────────────────────────────────

function createWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 860,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#FAF6EE',
    title: 'NEXUS Installer',
    show: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (isDev) {
    void mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─────────────────────────────────────────────────────────────────────
// MENUBAR MODE
// ─────────────────────────────────────────────────────────────────────

// 16x16 and 32x32 @2x PNGs of the NEXUS logo, embedded so we don't have
// to fight asset-path resolution between dev mode and .app bundle.
const TRAY_ICON_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAA0VXHyAAABoElEQVQ4Ed2QSyhEYRiG3/+cOf/MMJy5YYbEkDIpCxMWFFIuUZRbs7K0UuwsKYWFLCxsZceOsrAgERsLSooF0bhlFMY5DOfmH7cMjT3f5vt7v/d7+r8X+PNFEl1w3+FJ4x3OPKGozKFtrx1eTB+FfED0u/8HQB6oCwheb79hT68lAvUIdhc0OSLpD9Lu4+LskDgXWvoKiQNIvWVBS2X9FO/NEXXpHjrHAYRDzMSbOOi3N7KyOt9qntxaZpoRAzHHW8l9Aa/gLxnj7W5RZbJOLbGtV4DB3mqSCM6Wmgx/YPy2GuLH3ieAPGs+ml+YrdkcgK4DAoXBOnG4ATODqQpUsxU0K6eYltdU/QRcHp9FdzbW+fApePkOxJoMzuVhH2UQlgNxpoNYbCAKyzF8zqhvFZdBCLDaG6yNtKV7mJZU+CGzHCIRqJLEQAaoiUf0ZP9Q2VxpSl24Pogh4gDvUDw0I8tU3tKpnJ+kcc6MIC+6crlMn6ZehfaeFmbaJlZxNMgO/fD/2p9HukqfRrsOlHZXbdiNlF/NiYZ3Pf6CRLN/oL8APG+Cr3lk5owAAAAASUVORK5CYII=';
const TRAY_ICON_32 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACshmLzAAAFK0lEQVRYCe2VWWxUVRjH/+cus3RmOoUy3feNMrSFQoGaYtlBVNxKEYQHkyqasCQ+SjD2wfBCTIwG44OixgdIFIlUCCJCpWpZ7FQoZavSQhfazkw7a2fmbsfTiZERplI0Jj70S25ycu853/c/v2+5wJRNEZgi8C8JUEA4zZ5/6oZM5iBtBAfHDJP3jsvGi0gQSguruJTsx2SPWxPsVeVi0gwtcvbkMfR0XqIa8e49Hjn+ZiPz3AjKAjCNE9ukBDgBi3mDrZ5buHI7l1FQJnAQ4RsFRB2wcQfQ3ARcvQDUPA7qHZGk9pbvI6cO7yZJVo9lyHWTNEOZSMKEAmi9zUw+dwb8L5VuNSxe+xpEYzEf8PBqvh3K5XPQ171C5QvNhEucBrX7CrjMAhC2ht8LQRkDE/CL0nfzM9OhkfdYEHkiAXy8D90v5hl0fk/prurcTYaKRe8K2cU2zZDA0bxZLNsC6PAASGoW0a78DO3WDeie2AKSYILyw1EQ63SoAT90aTlpuqXr1gQT+k172oZPxIsz/o6L9yH/k54wbFmPJCxe8zYpmkNoyRzKAkK73g6ExwBrMjhbOojBCN36raBBH+SvPoa4djP4uTXgZ82DWlAGmlYIIbtoa3AJFnjrs6bHixVXgGc5CvlZla9rhIcmSZBbTxIaCoIrrgA/s5IFToB6xRHFDp0RytlvoW/YxfCPQmH1QFkatIFb0BQZuprVZi0nd6+g+gqjxXyPirgCxKraN/RlCzLlgA8wJ4Fk5oO3z4fW+yuUS62gg7dAMvJAZQlaz3UgEobmvAPlYitIchqEhctAzBbIxw9C8flh3rBtiSaYckgjtHvix00B4Y2mcng80G/cBpI0jd3IA+nLj0BMVohrNkBYXge17QzUaw5oQ73Qb9pOufRsCNWrwM9ZBOpxQ73qgLCICUnJAFVV8NlFOztng7XNXy3eAKHaqLMTFdXzlPYfo/nlslguVz7LbngW0oF9oL4R5nwFxFV1UW/aWIAobS2AFAFUBXR0GOLKOvCllZAO7gNJywaXN7Mmx9ZSwg5cjpVwn4BwXWqBGvB24dQX4ArmgqtdB7WrA9Lh/dEA4pNbougpmwNqx3lGoC/aGVxOMYT5j4KOp40VKmXPeHAutwRqfze4gd94ahSsuGck3CdgjJPculHnkbGWY6niUG8D73MbBI8LYfcg9C/vjqZD/u4w+AJ7tO911SsYJT801yDUdlYDmblQO9sA1hnC/FqAZ53e0QrJOdQrGs1MrScWACYcROO7Qk8ZajmDpUEO+jLFpxuWi6s3E/nMEfCzq8CXLYBy7hToyBBoKAQuPZeR0LE5kMRqYJSJCoJYrGzthBjyotjw/6DFtWKBH9YfZtj+7dnhO3OIe/PsBawDgoMvmpD4K5BqtRbzfzmdiJzaORp5rB0KoAhmNRnAF9/lKjCBeMxKFJWl1lvaaJxLDbIhyBN1CV6nvRzEYvhZF7qHHstmSiE6zSofYdmbDjwGNbIIB+Pjz3UOcHwbvzJt/1AQzd/7kEXUyvp5/g3Ty5LUBf8z+u1EALnnpOT4jB7+IiTqmp67EjjYx6sezUDuuLhQzg10wb7dMq44BCmeCD0Z5ndx1ifMenybn3w03/K/J3l43fKzgfAAAAAElFTkSuQmCC';

function makeTrayIcon(_active: boolean): Electron.NativeImage {
  // State differentiation happens through the tooltip + menu header text.
  // Keeping the visual icon stable prevents tray flicker every 3s poll.
  const img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_16, 'base64'));
  img.addRepresentation({
    scaleFactor: 2,
    width: 32,
    height: 32,
    buffer: Buffer.from(TRAY_ICON_32, 'base64'),
  });
  return img;
}

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
      click: () => { createWindow(); },
    },
    {
      label: 'About NEXUS',
      click: () => {
        void shell.openExternal('https://github.com/blazelucastaco-ai/nexus');
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
  // Hide from Dock in menubar-only mode — this app lives in the menu bar.
  if (!mainWindow) {
    app.dock?.hide();
  }

  tray = new Tray(makeTrayIcon(false));
  void rebuildTrayMenu();

  // Refresh menu + icon every 3s so "Running" badge reflects reality.
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
  // Common IPC handlers — available to both modes (wizard and menubar).
  ipcMain.handle('system:checks', async () => runSystemChecks());
  ipcMain.handle('repo:status', async () => checkRepo());
  ipcMain.handle('permissions:check', async () => checkPermissions());
  ipcMain.handle('permissions:open', async (_e, url: string) => openPrefs(url));
  ipcMain.handle('chrome:check', async () => checkChrome());
  ipcMain.handle('chrome:open-extensions', async (_e, label: string) => openChromeExtensions(label));
  ipcMain.handle('chrome:extension-path', async () => getExtensionPath());
  ipcMain.handle('chrome:test-connection', async () => testExtensionConnection());
  ipcMain.handle('external:open', async (_e, url: string) => shell.openExternal(url));

  ipcMain.handle('detect:existing', async () => detectExistingInstall());
  ipcMain.handle('detect:uninstall', async (_e, options: { removeRepo: boolean }) => {
    await uninstall(options);
    return { ok: true };
  });

  ipcMain.handle('install:run', async (event, input: ConfigInput) => {
    const send = (p: InstallProgress): void => {
      event.sender.send('install:progress', p);
    };
    try {
      await runInstall(input, send);
      // After a successful install, register the menubar agent too so
      // the icon appears in the top-right at next login.
      const appBin = app.getPath('exe');
      await registerMenubarAgent(appBin);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('install:reconfigure', async (event, input: ConfigInput) => {
    const send = (p: InstallProgress): void => {
      event.sender.send('install:progress', p);
    };
    try {
      await reconfigure(input, send);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('service:status', async () => getServiceStatus());
  ipcMain.handle('service:start', async () => startService());
  ipcMain.handle('service:stop', async () => stopService());
  ipcMain.handle('service:restart', async () => restartService());
  ipcMain.handle('service:logs', async () => openLogs());

  if (isMenubarMode) {
    startMenubarMode();
  } else {
    createWindow();
  }

  app.on('activate', () => {
    if (!isMenubarMode && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // In menubar mode we keep running without any windows (Tray keeps the
  // app alive). In wizard mode on macOS we still follow the usual pattern.
  if (!isMenubarMode && process.platform !== 'darwin') app.quit();
});

// Silence the `homedir` import warning — it's used by the main module.
void homedir;
