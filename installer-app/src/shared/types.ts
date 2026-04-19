export type StepKey =
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
  | 'done';

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
