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
  DashboardState,
  AboutInfo,
  MemoryEntry,
  UpdateProgress,
  QuickActionResult,
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
  main: {
    dashboard: (): Promise<DashboardState> => ipcRenderer.invoke('main:dashboard'),
    about: (): Promise<AboutInfo> => ipcRenderer.invoke('main:about'),
    memories: (opts: { limit?: number; type?: string }): Promise<MemoryEntry[]> =>
      ipcRenderer.invoke('main:memories', opts),
    updatesCheck: (): Promise<{
      localSha: string;
      remoteSha: string;
      commitsBehind: number;
      upToDate: boolean;
    }> => ipcRenderer.invoke('main:updates-check'),
    updatesRun: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('main:updates-run'),
    onUpdateProgress: (cb: (p: UpdateProgress) => void): (() => void) => {
      const listener = (_e: unknown, p: UpdateProgress): void => cb(p);
      ipcRenderer.on('main:update-progress', listener);
      return () => ipcRenderer.removeListener('main:update-progress', listener);
    },
    logTailStart: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('main:log-tail-start'),
    logTailStop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('main:log-tail-stop'),
    onLogLine: (cb: (line: string) => void): (() => void) => {
      const listener = (_e: unknown, line: string): void => cb(line);
      ipcRenderer.on('main:log-line', listener);
      return () => ipcRenderer.removeListener('main:log-line', listener);
    },
    openDashboard: (): Promise<void> => ipcRenderer.invoke('main:open-dashboard'),
    openWizard: (): Promise<void> => ipcRenderer.invoke('main:open-wizard'),
    memoryDelete: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('main:memory-delete', id),
    actionScreenshot: (): Promise<QuickActionResult> => ipcRenderer.invoke('main:action-screenshot'),

    // ── Hub ──────────────────────────────────────────────────
    hubSignup: (payload: { email: string; password: string; displayName: string; username?: string }): Promise<{ ok: boolean; session?: { userId: string; email: string; displayName: string; username?: string | null; hubUrl: string; instanceId?: string }; error?: string }> =>
      ipcRenderer.invoke('hub:signup', payload),
    hubLogin: (payload: { email: string; password: string }): Promise<{ ok: boolean; session?: { userId: string; email: string; displayName: string; username?: string | null; hubUrl: string; instanceId?: string }; error?: string }> =>
      ipcRenderer.invoke('hub:login', payload),
    hubSetUsername: (username: string): Promise<{ ok: boolean; username?: string; error?: string }> =>
      ipcRenderer.invoke('hub:set-username', username),
    hubLogout: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('hub:logout'),
    hubSession: (): Promise<{ userId: string; email: string; displayName: string; username?: string | null; hubUrl: string; instanceId?: string } | null> =>
      ipcRenderer.invoke('hub:session'),
    triggerHubPost: (): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke('main:trigger-hub-post'),
    hubRegisterInstance: (name: string): Promise<{ ok: boolean; instanceId?: string; error?: string }> =>
      ipcRenderer.invoke('hub:register-instance', name),
    hubListInstances: (): Promise<{ ok: boolean; instances?: Array<{ id: string; name: string; platform?: string; appVersion?: string; createdAt: string; lastSeenAt?: string | null; isMe?: boolean }>; error?: string }> =>
      ipcRenderer.invoke('hub:list-instances'),
    hubFriendsList: (): Promise<{ ok: boolean; friends?: Array<{ id: string; otherUserId: string; email: string; username: string | null; displayName: string | null; state: 'pending' | 'accepted' | 'blocked'; requestedByMe: boolean; gossipEnabled: boolean; createdAt: string; updatedAt: string }>; error?: string }> =>
      ipcRenderer.invoke('hub:friends-list'),
    hubFriendRequest: (identifier: string): Promise<{ ok: boolean; id?: string; state?: string; error?: string }> =>
      ipcRenderer.invoke('hub:friend-request', identifier),
    hubFriendAccept: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('hub:friend-accept', id),
    hubFriendBlock: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('hub:friend-block', id),
    hubFriendRemove: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('hub:friend-remove', id),
    hubFriendGossip: (id: string, enabled: boolean): Promise<{ ok: boolean; myPreference?: boolean; bothEnabled?: boolean; error?: string }> =>
      ipcRenderer.invoke('hub:friend-gossip', { id, enabled }),
    hubFeed: (): Promise<{ ok: boolean; posts?: Array<{ id: string; userId: string; displayName: string | null; username: string | null; email: string; instanceId: string; instanceName: string; content: string; signature: string; createdAt: string; mine?: boolean }>; error?: string }> =>
      ipcRenderer.invoke('hub:feed'),
    actionDream: (): Promise<QuickActionResult> => ipcRenderer.invoke('main:action-dream'),
    actionHealth: (): Promise<QuickActionResult> => ipcRenderer.invoke('main:action-health'),
    memoryDetectSources: (): Promise<Array<{ id: string; name: string; status: string; summary: string; estimatedItems: number }>> =>
      ipcRenderer.invoke('main:memory-detect-sources'),
    memoryImport: (sourceIds: string[]): Promise<{ imported: number; skipped: number; sources: Record<string, number> }> =>
      ipcRenderer.invoke('main:memory-import', sourceIds),
    onMemoryImportProgress: (
      cb: (p: { type: 'phase'; phase: string; label: string; pct: number; source?: string }) => void,
    ): (() => void) => {
      const listener = (_e: unknown, p: Parameters<typeof cb>[0]): void => cb(p);
      ipcRenderer.on('main:memory-import-progress', listener);
      return () => ipcRenderer.removeListener('main:memory-import-progress', listener);
    },
  },
};

contextBridge.exposeInMainWorld('nexus', api);

export type NexusApi = typeof api;
