import { contextBridge, ipcRenderer } from 'electron';
import type {
  SystemCheckResult,
  RepoStatus,
  ConfigInput,
  PermissionCheck,
  InstallProgress,
  ChromeStatus,
  DetectionResult,
  ServiceStatus,
} from '../shared/types';

const api = {
  system: {
    check: (): Promise<SystemCheckResult[]> => ipcRenderer.invoke('system:checks'),
  },
  repo: {
    status: (): Promise<RepoStatus> => ipcRenderer.invoke('repo:status'),
  },
  permissions: {
    check: (): Promise<PermissionCheck[]> => ipcRenderer.invoke('permissions:check'),
    open: (url: string): Promise<void> => ipcRenderer.invoke('permissions:open', url),
  },
  chrome: {
    check: (): Promise<ChromeStatus> => ipcRenderer.invoke('chrome:check'),
    openExtensions: (label: string): Promise<void> => ipcRenderer.invoke('chrome:open-extensions', label),
    extensionPath: (): Promise<string> => ipcRenderer.invoke('chrome:extension-path'),
    testConnection: (): Promise<boolean> => ipcRenderer.invoke('chrome:test-connection'),
  },
  detect: {
    existing: (): Promise<DetectionResult> => ipcRenderer.invoke('detect:existing'),
    uninstall: (options: { removeRepo: boolean }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('detect:uninstall', options),
  },
  install: {
    run: (input: ConfigInput): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('install:run', input),
    reconfigure: (input: ConfigInput): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('install:reconfigure', input),
    onProgress: (cb: (progress: InstallProgress) => void): (() => void) => {
      const listener = (_e: unknown, progress: InstallProgress): void => cb(progress);
      ipcRenderer.on('install:progress', listener);
      return () => ipcRenderer.removeListener('install:progress', listener);
    },
  },
  service: {
    status: (): Promise<ServiceStatus> => ipcRenderer.invoke('service:status'),
    start: (): Promise<void> => ipcRenderer.invoke('service:start'),
    stop: (): Promise<void> => ipcRenderer.invoke('service:stop'),
    restart: (): Promise<void> => ipcRenderer.invoke('service:restart'),
    openLogs: (): Promise<void> => ipcRenderer.invoke('service:logs'),
  },
  external: {
    open: (url: string): Promise<void> => ipcRenderer.invoke('external:open', url),
  },
};

contextBridge.exposeInMainWorld('nexus', api);

export type NexusApi = typeof api;
