import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import {
  runSystemChecks,
  checkRepo,
  runInstall,
  checkPermissions,
  openPrefs,
  checkChrome,
  openChromeExtensions,
  getExtensionPath,
  testExtensionConnection,
} from './installer-core';
import type { ConfigInput, InstallProgress } from '../shared/types';

const isDev = process.env.NEXUS_INSTALLER_DEV === '1';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
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

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle('system:checks', async () => runSystemChecks());
  ipcMain.handle('repo:status', async () => checkRepo());
  ipcMain.handle('permissions:check', async () => checkPermissions());
  ipcMain.handle('permissions:open', async (_e, url: string) => openPrefs(url));
  ipcMain.handle('chrome:check', async () => checkChrome());
  ipcMain.handle('chrome:open-extensions', async (_e, label: string) => openChromeExtensions(label));
  ipcMain.handle('chrome:extension-path', async () => getExtensionPath());
  ipcMain.handle('chrome:test-connection', async () => testExtensionConnection());
  ipcMain.handle('external:open', async (_e, url: string) => shell.openExternal(url));

  ipcMain.handle('install:run', async (event, input: ConfigInput) => {
    const send = (p: InstallProgress): void => {
      event.sender.send('install:progress', p);
    };
    try {
      await runInstall(input, send);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
