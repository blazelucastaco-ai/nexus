import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  SystemCheckResult,
  RepoStatus,
  ConfigInput,
  PermissionCheck,
  InstallProgress,
  ChromeStatus,
} from '../shared/types';

const execFileAsync = promisify(execFile);

const VERSION = '0.1.0';
const HOME = homedir();
const NEXUS_DIR = join(HOME, '.nexus');
const CONFIG_PATH = join(NEXUS_DIR, 'config.json');
const DB_PATH = join(NEXUS_DIR, 'memory.db');
const REPO_DIR = join(HOME, 'nexus');
const ENV_PATH = join(REPO_DIR, '.env');
const REPO_URL = 'https://github.com/blazelucastaco-ai/nexus.git';

const BRIDGE_PORT = 9338;

// ── System checks ────────────────────────────────────────────────────

export async function runSystemChecks(): Promise<SystemCheckResult[]> {
  const checks: SystemCheckResult[] = [];

  try {
    const { stdout } = await execFileAsync('uname', []);
    checks.push({
      name: 'Operating system',
      ok: stdout.trim() === 'Darwin',
      detail: stdout.trim() === 'Darwin' ? 'macOS detected' : `Unsupported — ${stdout.trim()}`,
      required: true,
    });
  } catch {
    checks.push({ name: 'Operating system', ok: false, detail: 'Could not detect', required: true });
  }

  try {
    const { stdout } = await execFileAsync('sw_vers', ['-productVersion']);
    checks.push({ name: 'macOS version', ok: true, detail: stdout.trim(), required: false });
  } catch {
    checks.push({ name: 'macOS version', ok: false, detail: 'Could not detect', required: false });
  }

  const node = await findNode();
  if (node) {
    const major = Number.parseInt(node.version.split('.')[0] ?? '0', 10);
    checks.push({
      name: 'Node.js',
      ok: major >= 22,
      detail: major >= 22 ? `v${node.version}` : `v${node.version} — v22+ required`,
      required: true,
    });
  } else {
    checks.push({ name: 'Node.js', ok: false, detail: 'Not installed — will install via Homebrew', required: true });
  }

  const pnpm = await resolveBinary('pnpm');
  checks.push({
    name: 'pnpm',
    ok: pnpm !== null,
    detail: pnpm ?? 'Not installed — will install via corepack',
    required: false,
  });

  const git = await resolveBinary('git');
  checks.push({
    name: 'git',
    ok: git !== null,
    detail: git ? 'Available' : 'Missing — will prompt Xcode command-line tools',
    required: true,
  });

  const brew = await resolveBinary('brew');
  checks.push({
    name: 'Homebrew',
    ok: brew !== null,
    detail: brew ? 'Available' : 'Not found — Node install may need it',
    required: false,
  });

  return checks;
}

async function findNode(): Promise<{ version: string; path: string } | null> {
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', `${HOME}/.nvm/versions/node`];
  for (const c of candidates) {
    try {
      const { stdout } = await execFileAsync(c.endsWith('/node') ? c : 'which', c.endsWith('/node') ? ['-v'] : ['node']);
      if (stdout.trim().startsWith('v')) {
        return { version: stdout.trim().slice(1), path: c };
      }
    } catch {
      /* next */
    }
  }
  try {
    const { stdout } = await execFileAsync('node', ['-v']);
    return { version: stdout.trim().replace(/^v/, ''), path: 'node' };
  } catch {
    return null;
  }
}

async function resolveBinary(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-lc', `command -v ${name}`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ── Repo status ──────────────────────────────────────────────────────

export function checkRepo(): RepoStatus {
  if (!existsSync(REPO_DIR)) {
    return { installed: false, path: REPO_DIR };
  }
  const pkg = join(REPO_DIR, 'package.json');
  if (!existsSync(pkg)) {
    return { installed: false, path: REPO_DIR };
  }
  try {
    const parsed = JSON.parse(readFileSync(pkg, 'utf-8'));
    return { installed: true, path: REPO_DIR, version: parsed.version };
  } catch {
    return { installed: true, path: REPO_DIR };
  }
}

// ── Full install pipeline ────────────────────────────────────────────

type ProgressCb = (progress: InstallProgress) => void;

export async function runInstall(input: ConfigInput, onProgress: ProgressCb): Promise<void> {
  const steps: Array<{ phase: InstallProgress['phase']; label: string; run: () => Promise<void> }> = [
    { phase: 'cloning', label: 'Fetching NEXUS from GitHub…', run: () => cloneOrUpdateRepo(onProgress) },
    { phase: 'installing-deps', label: 'Installing dependencies…', run: () => installDeps(onProgress) },
    { phase: 'building', label: 'Building NEXUS…', run: () => buildRepo(onProgress) },
    { phase: 'linking-cli', label: 'Linking the nexus CLI…', run: () => linkCli(onProgress) },
    { phase: 'writing-config', label: 'Writing configuration…', run: () => writeConfig(input) },
    { phase: 'initializing-db', label: 'Creating memory database…', run: () => initDatabase() },
    { phase: 'registering-service', label: 'Registering background service…', run: () => registerLaunchd() },
  ];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    onProgress({ phase: step.phase, label: step.label, pct: (i / steps.length) * 100 });
    await step.run();
  }

  onProgress({ phase: 'done', label: 'Install complete.', pct: 100 });
}

async function cloneOrUpdateRepo(onProgress: ProgressCb): Promise<void> {
  if (existsSync(REPO_DIR)) {
    await runStreamed('git', ['pull', '--ff-only'], REPO_DIR, (line) =>
      onProgress({ phase: 'cloning', label: 'Updating NEXUS…', pct: 8, log: line }),
    );
    return;
  }
  await runStreamed('git', ['clone', '--depth', '1', REPO_URL, REPO_DIR], HOME, (line) =>
    onProgress({ phase: 'cloning', label: 'Cloning NEXUS…', pct: 8, log: line }),
  );
}

async function installDeps(onProgress: ProgressCb): Promise<void> {
  const pnpm = (await resolveBinary('pnpm')) ?? 'pnpm';
  await runStreamed(pnpm, ['install'], REPO_DIR, (line) =>
    onProgress({ phase: 'installing-deps', label: 'Installing dependencies…', pct: 30, log: line }),
  );
}

async function buildRepo(onProgress: ProgressCb): Promise<void> {
  const pnpm = (await resolveBinary('pnpm')) ?? 'pnpm';
  await runStreamed(pnpm, ['run', 'build'], REPO_DIR, (line) =>
    onProgress({ phase: 'building', label: 'Compiling TypeScript…', pct: 55, log: line }),
  );
}

async function linkCli(onProgress: ProgressCb): Promise<void> {
  const pnpm = (await resolveBinary('pnpm')) ?? 'pnpm';
  try {
    await runStreamed(pnpm, ['link', '--global'], REPO_DIR, (line) =>
      onProgress({ phase: 'linking-cli', label: 'Linking nexus CLI globally…', pct: 70, log: line }),
    );
  } catch {
    const localBin = join(HOME, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });
    const target = join(localBin, 'nexus');
    const src = join(REPO_DIR, 'dist', 'cli.js');
    await execFileAsync('ln', ['-sf', src, target]);
    await execFileAsync('chmod', ['+x', target]);
  }
}

function writeConfig(input: ConfigInput): Promise<void> {
  mkdirSync(NEXUS_DIR, { recursive: true });
  mkdirSync(join(NEXUS_DIR, 'logs'), { recursive: true });
  mkdirSync(join(NEXUS_DIR, 'screenshots'), { recursive: true });
  mkdirSync(join(NEXUS_DIR, 'data'), { recursive: true });

  const config = {
    version: VERSION,
    personality: {
      name: 'NEXUS',
      preset: input.personality.preset,
      traits: input.personality.traits,
      opinions: { enabled: true, pushbackThreshold: 0.6 },
    },
    memory: {
      dbPath: DB_PATH,
      consolidationSchedule: '0 3 * * *',
      maxShortTerm: 50,
      retrievalTopK: 20,
      importanceThreshold: 0.3,
    },
    ai: {
      provider: 'anthropic',
      opusModel: 'claude-opus-4-7',
      model: 'claude-sonnet-4-6',
      fastModel: 'claude-haiku-4-5-20251001',
      fallbackModel: 'claude-haiku-4-5-20251001',
      maxTokens: 32768,
      temperature: 0.4,
      providers: ['anthropic'],
    },
    telegram: {
      allowedUsers: [input.telegram.chatId],
    },
    macos: {
      screenshotQuality: 0.8,
      accessibilityEnabled: true,
    },
    agents: {
      autoDelegate: true,
      maxConcurrent: 5,
      timeoutSeconds: 300,
      enabled: input.agents,
    },
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  const envLines = [
    '# ─── NEXUS Environment ────────────────────────────────',
    `# Generated by the NEXUS Installer on ${new Date().toISOString().split('T')[0]}`,
    '',
    '# Telegram',
    `TELEGRAM_BOT_TOKEN=${input.telegram.botToken}`,
    `TELEGRAM_CHAT_ID=${input.telegram.chatId}`,
    '',
    '# AI Provider — Anthropic (Claude)',
    `ANTHROPIC_API_KEY=${input.anthropicKey}`,
    'NEXUS_AI_PROVIDER=anthropic',
    'NEXUS_AI_MODEL=claude-sonnet-4-6',
    'NEXUS_AI_OPUS_MODEL=claude-opus-4-7',
    'NEXUS_AI_FAST_MODEL=claude-haiku-4-5-20251001',
    '',
    '# System',
    `NEXUS_DATA_DIR=${NEXUS_DIR}`,
    'NEXUS_LOG_LEVEL=info',
    '',
  ];
  writeFileSync(ENV_PATH, envLines.join('\n'), 'utf-8');
  return Promise.resolve();
}

async function initDatabase(): Promise<void> {
  const nodeBin = (await resolveBinary('node')) ?? 'node';
  const script = `
    const Database = require('${REPO_DIR}/node_modules/better-sqlite3');
    const db = new Database('${DB_PATH}');
    db.pragma('journal_mode = WAL');
    db.exec(\`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
        embedding BLOB, importance REAL DEFAULT 0.5, access_count INTEGER DEFAULT 0,
        last_accessed TEXT, created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')), metadata TEXT DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, tokens INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')), metadata TEXT DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        status TEXT DEFAULT 'pending', agent TEXT, priority INTEGER DEFAULT 5,
        created_at TEXT DEFAULT (datetime('now')), completed_at TEXT,
        metadata TEXT DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS context (
        key TEXT PRIMARY KEY, value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    \`);
    db.close();
  `;
  await execFileAsync(nodeBin, ['-e', script]);
}

async function registerLaunchd(): Promise<void> {
  const plistPath = join(HOME, 'Library', 'LaunchAgents', 'com.nexus.ai.plist');
  const startSh = join(NEXUS_DIR, 'start.sh');
  const appCjs = join(NEXUS_DIR, 'app', 'index.cjs');

  mkdirSync(join(NEXUS_DIR, 'app'), { recursive: true });

  const built = join(REPO_DIR, 'dist', 'index.cjs');
  if (existsSync(built)) {
    await execFileAsync('cp', [built, appCjs]);
  }

  const startScript = `#!/bin/bash\ncd "${NEXUS_DIR}"\nexec /usr/bin/env node "${appCjs}"\n`;
  writeFileSync(startSh, startScript, { mode: 0o755 });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nexus.ai</string>
  <key>ProgramArguments</key>
  <array>
    <string>${startSh}</string>
  </array>
  <key>WorkingDirectory</key><string>${NEXUS_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(NEXUS_DIR, 'nexus.log')}</string>
  <key>StandardErrorPath</key><string>${join(NEXUS_DIR, 'nexus.err')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
  mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(plistPath, plist, 'utf-8');

  try {
    await execFileAsync('launchctl', ['unload', plistPath]);
  } catch {
    /* not loaded yet */
  }
  await execFileAsync('launchctl', ['load', plistPath]);
}

// ── Permissions ──────────────────────────────────────────────────────

export async function checkPermissions(): Promise<PermissionCheck[]> {
  const checks: Array<{ key: string; name: string; prefsUrl: string; test: () => Promise<boolean> }> = [
    {
      key: 'screenRecording',
      name: 'Screen Recording',
      prefsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      test: async () => {
        const tmp = `/tmp/nexus-perm-${Date.now()}.png`;
        try {
          await execFileAsync('/usr/sbin/screencapture', ['-x', tmp], { timeout: 5000 });
          if (existsSync(tmp)) {
            await execFileAsync('rm', [tmp]);
            return true;
          }
          return false;
        } catch {
          return false;
        }
      },
    },
    {
      key: 'accessibility',
      name: 'Accessibility',
      prefsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      test: async () => {
        try {
          const { stdout } = await execFileAsync(
            'osascript',
            ['-l', 'JavaScript', '-e', "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()"],
            { timeout: 3000 },
          );
          return stdout.trim() === 'true';
        } catch {
          return false;
        }
      },
    },
    {
      key: 'automation',
      name: 'Automation',
      prefsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
      test: async () => {
        try {
          await execFileAsync('osascript', ['-e', 'tell application "Finder" to return name'], { timeout: 3000 });
          return true;
        } catch {
          return false;
        }
      },
    },
    {
      key: 'contacts',
      name: 'Contacts',
      prefsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts',
      test: async () => {
        try {
          const { stdout } = await execFileAsync(
            'osascript',
            ['-e', 'tell application "Contacts" to return count of every person'],
            { timeout: 4000 },
          );
          return !Number.isNaN(Number.parseInt(stdout.trim(), 10));
        } catch {
          return false;
        }
      },
    },
  ];

  const out: PermissionCheck[] = [];
  for (const c of checks) {
    const granted = await c.test();
    out.push({ key: c.key, name: c.name, granted, prefsUrl: c.prefsUrl });
  }
  return out;
}

export async function openPrefs(url: string): Promise<void> {
  await execFileAsync('open', [url]);
}

// ── Chrome extension ─────────────────────────────────────────────────

export async function checkChrome(): Promise<ChromeStatus> {
  const candidates: Array<[string, string]> = [
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome'],
    ['/Applications/Chromium.app/Contents/MacOS/Chromium', 'Chromium'],
    ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'Brave Browser'],
  ];
  for (const [path, label] of candidates) {
    if (existsSync(path)) {
      return { installed: true, appPath: path, appLabel: label, extensionConnected: false };
    }
  }
  return { installed: false, appPath: null, appLabel: null, extensionConnected: false };
}

export async function openChromeExtensions(appLabel: string): Promise<void> {
  const script =
    `tell application "${appLabel}" to activate\n` +
    'delay 0.8\n' +
    `tell application "${appLabel}" to open location "chrome://extensions"`;
  try {
    await execFileAsync('osascript', ['-e', script]);
  } catch {
    await execFileAsync('open', ['-a', appLabel]);
  }
}

export function getExtensionPath(): string {
  return join(REPO_DIR, 'chrome-extension');
}

export async function testExtensionConnection(timeoutMs = 8000): Promise<boolean> {
  // Use a lightweight check: if the NEXUS bridge is already listening (service
  // running), a connect to it will succeed. Otherwise we just report false.
  return new Promise((resolve) => {
    const sock = require('node:net').createConnection({ host: '127.0.0.1', port: BRIDGE_PORT });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.end();
      resolve(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ── Streamed child-process helper ────────────────────────────────────

function runStreamed(
  cmd: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const pump = (chunk: Buffer): void => {
      buf += chunk.toString('utf-8');
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
        nl = buf.indexOf('\n');
      }
    };
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim());
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}
