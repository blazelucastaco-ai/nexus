export type StepKey =
  | 'detect'
  | 'welcome'
  | 'system-check'
  | 'repo'
  | 'telegram'
  | 'ai'
  | 'agents'
  | 'personality'
  | 'permissions'
  | 'install'
  | 'chrome'
  | 'account'
  | 'memory-import'
  | 'uninstall'
  | 'done';

export interface HubAccountSession {
  userId: string;
  email: string;
  displayName: string;
  accessToken: string;
  instanceId?: string; // populated once this install has registered
}

export interface DetectionResult {
  configExists: boolean;
  repoExists: boolean;
  serviceRegistered: boolean;
  serviceRunning: boolean;
  menubarRegistered: boolean;
  version?: string;
  configPath: string;
  repoPath: string;
  existingTelegram?: { botToken: string; chatId: string };
  existingAnthropicKey?: string;
  existingAgents?: string[];
  existingPersonality?: {
    preset: 'professional' | 'friendly' | 'sarcastic_genius' | 'custom';
    traits: {
      humor: number; sarcasm: number; formality: number;
      assertiveness: number; verbosity: number; empathy: number;
    };
  };
}

export type DetectAction = 'reconfigure' | 'repair' | 'uninstall' | 'fresh';

export interface ServiceStatus {
  registered: boolean;
  running: boolean;
  pid?: number;
  bridgeConnected: boolean;
}

export interface SystemCheckResult {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export interface RepoStatus {
  installed: boolean;
  path: string;
  version?: string;
}

export interface ConfigInput {
  telegram: { botToken: string; chatId: string };
  anthropicKey: string;
  agents: string[];
  personality: {
    preset: 'professional' | 'friendly' | 'sarcastic_genius' | 'custom';
    traits: {
      humor: number;
      sarcasm: number;
      formality: number;
      assertiveness: number;
      verbosity: number;
      empathy: number;
    };
  };
}

export interface PermissionCheck {
  key: string;
  name: string;
  granted: boolean;
  prefsUrl: string;
}

export type InstallPhase =
  | 'cloning'
  | 'installing-deps'
  | 'building'
  | 'linking-cli'
  | 'writing-config'
  | 'initializing-db'
  | 'registering-service'
  | 'done';

export interface InstallProgress {
  phase: InstallPhase;
  label: string;
  pct: number;
  log?: string;
}

export interface ChromeStatus {
  installed: boolean;
  appPath: string | null;
  appLabel: string | null;
  extensionConnected: boolean;
}

export const AGENT_CHOICES: Array<{ id: string; icon: string; name: string; description: string }> = [
  { id: 'vision', icon: '👁', name: 'Vision', description: 'Screenshots, screen analysis, OCR' },
  { id: 'file', icon: '📁', name: 'File', description: 'File operations, search, organization' },
  { id: 'browser', icon: '🌐', name: 'Browser', description: 'Web browsing, scraping, search' },
  { id: 'terminal', icon: '💻', name: 'Terminal', description: 'Shell commands, scripts' },
  { id: 'code', icon: '🔧', name: 'Code', description: 'Read, write, debug, run code' },
  { id: 'research', icon: '🔍', name: 'Research', description: 'Web research, summarization' },
  { id: 'system', icon: '⚙️', name: 'System', description: 'System monitoring, app management' },
  { id: 'creative', icon: '🎨', name: 'Creative', description: 'Text generation, brainstorming' },
  { id: 'comms', icon: '📧', name: 'Comms', description: 'Notifications, email drafts' },
  { id: 'scheduler', icon: '⏰', name: 'Scheduler', description: 'Reminders, scheduled tasks' },
];

export const PERSONALITY_PRESETS = {
  professional: { humor: 0.2, sarcasm: 0.1, formality: 0.8, assertiveness: 0.5, verbosity: 0.4, empathy: 0.5 },
  friendly:     { humor: 0.7, sarcasm: 0.3, formality: 0.3, assertiveness: 0.5, verbosity: 0.6, empathy: 0.8 },
  sarcastic_genius: { humor: 0.9, sarcasm: 0.8, formality: 0.2, assertiveness: 0.8, verbosity: 0.5, empathy: 0.4 },
  custom:       { humor: 0.5, sarcasm: 0.5, formality: 0.5, assertiveness: 0.5, verbosity: 0.5, empathy: 0.5 },
} as const;

// ─── Main-app types (post-install management UI) ──────────────────────

export type MainTab = 'dashboard' | 'hub' | 'friends' | 'feed' | 'config' | 'logs' | 'chrome' | 'updates' | 'memory' | 'about';

export interface QuickActionResult {
  ok: boolean;
  output: string;
}

export interface DashboardState {
  service: ServiceStatus;
  uptimeSeconds?: number;
  configPath: string;
  logPath: string;
  repoPath: string;
  memoryCount: number;
  version?: string;
  sessionCount: number;
  lastMessageAt?: string;
}

export interface LogEntry {
  ts: string;
  level: number; // pino numeric level
  component?: string;
  msg: string;
  raw: string;
}

export type UpdatePhase =
  | 'checking'
  | 'downloading'
  | 'done'
  | 'up-to-date'
  | 'error'
  // ── Legacy phases, kept so old renderer builds don't type-error ──
  | 'pulling'
  | 'installing'
  | 'building'
  | 'restarting';

export interface UpdateProgress {
  phase: UpdatePhase;
  label: string;
  pct: number;
  log?: string;
  // New shape (GitHub Releases-based):
  installedVersion?: string;
  latestVersion?: string;
  downloadUrl?: string;
  releasePageUrl?: string;
  updateAvailable?: boolean;
  offline?: boolean;
  // Legacy fields kept for backwards compat with older dashboard builds.
  localSha?: string;
  remoteSha?: string;
  commitsBehind?: number;
  upToDate?: boolean;
}

export interface MemoryEntry {
  id: string;
  type: string;
  content: string;
  importance: number;
  createdAt: string;
}

export interface AboutInfo {
  version: string;
  nodeVersion: string;
  platform: string;
  configPath: string;
  dbPath: string;
  logPath: string;
  repoPath: string;
  appPath: string;
  installerVersion: string;
}
