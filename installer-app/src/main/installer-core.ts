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
  DetectionResult,
  ServiceStatus,
} from '../shared/types';
import { rmSync } from 'node:fs';

const execFileAsync = promisify(execFile);

const VERSION = '0.1.0';
const HOME = homedir();
const NEXUS_DIR = join(HOME, '.nexus');
// Wizard writes config.json; older installs (and the legacy setup.yaml flow)
// use config.yaml. Detection accepts either; writes always go to .json.
const CONFIG_PATH = join(NEXUS_DIR, 'config.json');
const CONFIG_PATH_YAML = join(NEXUS_DIR, 'config.yaml');
const DB_PATH = join(NEXUS_DIR, 'memory.db');
const REPO_DIR = join(HOME, 'nexus');
const ENV_PATH = join(REPO_DIR, '.env');
const REPO_URL = 'https://github.com/blazelucastaco-ai/nexus.git';
const LAUNCH_AGENTS_DIR = join(HOME, 'Library', 'LaunchAgents');
const NEXUS_PLIST = join(LAUNCH_AGENTS_DIR, 'com.nexus.ai.plist');
const MENUBAR_PLIST = join(LAUNCH_AGENTS_DIR, 'com.nexus.menubar.plist');
const NEXUS_LABEL = 'com.nexus.ai';
const MENUBAR_LABEL = 'com.nexus.menubar';

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
  // Pre-create the full ~/.nexus/ tree so that package.json's build script,
  // which does `cp dist/index.cjs ~/.nexus/app/index.cjs`, doesn't fail on
  // a fresh install before our registerLaunchd step has had a chance to
  // create it. All four subdirs are cheap and idempotent.
  mkdirSync(NEXUS_DIR, { recursive: true });
  mkdirSync(join(NEXUS_DIR, 'app'), { recursive: true });
  mkdirSync(join(NEXUS_DIR, 'logs'), { recursive: true });
  mkdirSync(join(NEXUS_DIR, 'screenshots'), { recursive: true });
  mkdirSync(join(NEXUS_DIR, 'data'), { recursive: true });

  const steps: Array<{ phase: InstallProgress['phase']; label: string; run: () => Promise<void> }> = [
    { phase: 'cloning', label: 'Fetching NEXUS from GitHub…', run: () => cloneOrUpdateRepo(onProgress) },
    { phase: 'installing-deps', label: 'Installing dependencies…', run: () => installDeps(onProgress) },
    { phase: 'building', label: 'Building NEXUS…', run: () => buildRepo(onProgress) },
    { phase: 'linking-cli', label: 'Linking the nexus CLI…', run: () => linkCli(onProgress) },
    { phase: 'writing-config', label: 'Writing configuration…', run: () => writeConfig(input) },
    { phase: 'initializing-db', label: 'Creating memory database…', run: () => initDatabase() },
    { phase: 'registering-service', label: 'Registering background service…', run: () => registerLaunchd(input) },
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
  onProgress({ phase: 'linking-cli', label: 'Linking nexus CLI globally…', pct: 70 });
  try {
    await runStreamed(pnpm, ['link', '--global'], REPO_DIR, (line) =>
      onProgress({ phase: 'linking-cli', label: 'Linking nexus CLI globally…', pct: 70, log: line }),
    );
    return;
  } catch {
    /* pnpm link needs a global bin dir that may not be set up — fall through */
  }
  // Fallback: symlink into ~/.local/bin pointing at the actual built artifact.
  // `dist/index.cjs` is produced by tsup; the original setup.ts also used this.
  const localBin = join(HOME, '.local', 'bin');
  mkdirSync(localBin, { recursive: true });
  const target = join(localBin, 'nexus');
  const src = join(REPO_DIR, 'dist', 'index.cjs');
  if (!existsSync(src)) {
    onProgress({
      phase: 'linking-cli',
      label: 'Skipping CLI link — build artifact missing',
      pct: 70,
      log: `warn: ${src} not found; nexus CLI won't be available in PATH`,
    });
    return;
  }
  await execFileAsync('ln', ['-sf', src, target]);
  try {
    await execFileAsync('chmod', ['+x', src]);
  } catch {
    /* source lives in pnpm store on some setups; chmod not critical */
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
  // NEXUS ships its own migration system that creates all tables on first
  // boot. Pre-creating schema here caused conflicts (CREATE TABLE without
  // IF NOT EXISTS vs tables we'd already made) and the service would fail
  // to start. Just ensure the directory exists and let NEXUS populate it.
  mkdirSync(NEXUS_DIR, { recursive: true });
  // Touching a zero-byte file is optional; better-sqlite3 creates it on open.
  // Leaving this as a no-op keeps the step visible in the progress UI.
  return Promise.resolve();
}

async function registerLaunchd(input?: ConfigInput): Promise<void> {
  const plistPath = NEXUS_PLIST;
  const startSh = join(NEXUS_DIR, 'start.sh');
  const appCjs = join(NEXUS_DIR, 'app', 'index.cjs');

  mkdirSync(join(NEXUS_DIR, 'app'), { recursive: true });

  const built = join(REPO_DIR, 'dist', 'index.cjs');
  if (existsSync(built)) {
    await execFileAsync('cp', [built, appCjs]);
  }

  const startScript = `#!/bin/bash\ncd "${NEXUS_DIR}"\nexec /usr/bin/env node "${appCjs}"\n`;
  writeFileSync(startSh, startScript, { mode: 0o755 });

  // Pull credentials from the just-written .env so the service process
  // has them in its environment too — required because the built
  // dist/index.cjs expects TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID /
  // ANTHROPIC_API_KEY in process.env.
  const envVars = readEnvVars();
  if (input) {
    envVars.TELEGRAM_BOT_TOKEN = input.telegram.botToken;
    envVars.TELEGRAM_CHAT_ID = input.telegram.chatId;
    envVars.ANTHROPIC_API_KEY = input.anthropicKey;
  }
  // NODE_PATH points at the repo's node_modules so `require('better-sqlite3')`
  // et al. resolve — without it, the service crashes at startup with
  // MODULE_NOT_FOUND. See "Destructive test 2" finding, 2026-04-19.
  envVars.NODE_PATH = join(REPO_DIR, 'node_modules');
  envVars.PATH = envVars.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

  const envXml = Object.entries(envVars)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key><string>${escapeXml(v)}</string>`)
    .join('\n');

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
${envXml}
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

function readEnvVars(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(ENV_PATH)) return out;
  try {
    const text = readFileSync(ENV_PATH, 'utf-8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]!] = m[2]!.trim();
    }
  } catch {
    /* swallow */
  }
  return out;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  );
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

const CHROME_LABEL_ALLOWLIST = new Set(['Google Chrome', 'Chromium', 'Brave Browser']);

export async function openChromeExtensions(appLabel: string): Promise<void> {
  // Only accept known-good Chromium-family app names. Anything else
  // could let a compromised renderer pass an AppleScript payload into
  // osascript via string templating.
  if (!CHROME_LABEL_ALLOWLIST.has(appLabel)) {
    throw new Error(`Refusing to open unknown app: ${appLabel}`);
  }
  const escaped = appLabel.replace(/"/g, '\\"');
  const script =
    `tell application "${escaped}" to activate\n` +
    'delay 0.8\n' +
    `tell application "${escaped}" to open location "chrome://extensions"`;
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

// ── Detection ────────────────────────────────────────────────────────

export async function detectExistingInstall(): Promise<DetectionResult> {
  const jsonExists = existsSync(CONFIG_PATH);
  const yamlExists = existsSync(CONFIG_PATH_YAML);
  const configExists = jsonExists || yamlExists;
  // Report whichever config file is actually on disk so the UI can tell
  // the user exactly where it lives.
  const configPath = jsonExists ? CONFIG_PATH : yamlExists ? CONFIG_PATH_YAML : CONFIG_PATH;
  const repoExists = existsSync(join(REPO_DIR, 'package.json'));
  const serviceRegistered = existsSync(NEXUS_PLIST);
  const menubarRegistered = existsSync(MENUBAR_PLIST);

  let serviceRunning = false;
  try {
    const { stdout } = await execFileAsync('launchctl', ['list']);
    serviceRunning = stdout.split('\n').some((line) => {
      const cols = line.trim().split(/\s+/);
      // launchctl list format: PID STATUS LABEL. A running service has a numeric PID.
      return cols[2] === NEXUS_LABEL && /^\d+$/.test(cols[0] ?? '');
    });
  } catch {
    /* leave serviceRunning = false */
  }

  const result: DetectionResult = {
    configExists,
    repoExists,
    serviceRegistered,
    serviceRunning,
    menubarRegistered,
    configPath,
    repoPath: REPO_DIR,
  };

  // Prefill from config.json only — we don't ship a YAML parser and legacy
  // users will retype their personality/agents. Services + .env probing
  // below still work for YAML-only installs, so they get prefilled keys.
  if (jsonExists) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      if (typeof parsed?.version === 'string') result.version = parsed.version;
      if (Array.isArray(parsed?.agents?.enabled)) result.existingAgents = parsed.agents.enabled;
      if (parsed?.personality?.preset && parsed?.personality?.traits) {
        result.existingPersonality = {
          preset: parsed.personality.preset,
          traits: parsed.personality.traits,
        };
      }
    } catch {
      /* malformed config — ignore */
    }
  }

  if (existsSync(ENV_PATH)) {
    try {
      const env = readFileSync(ENV_PATH, 'utf-8');
      const get = (k: string): string | undefined => {
        const m = env.match(new RegExp(`^${k}=(.*)$`, 'm'));
        return m?.[1]?.trim();
      };
      const botToken = get('TELEGRAM_BOT_TOKEN');
      const chatId = get('TELEGRAM_CHAT_ID');
      const anthropicKey = get('ANTHROPIC_API_KEY');
      if (botToken && chatId) result.existingTelegram = { botToken, chatId };
      if (anthropicKey) result.existingAnthropicKey = anthropicKey;
    } catch {
      /* ignore */
    }
  }

  return result;
}

// ── Uninstall ────────────────────────────────────────────────────────

export async function uninstall(options: { removeRepo: boolean }): Promise<void> {
  // 1. Stop + unload the NEXUS service
  if (existsSync(NEXUS_PLIST)) {
    try {
      await execFileAsync('launchctl', ['unload', NEXUS_PLIST]);
    } catch {
      /* already unloaded */
    }
    try {
      rmSync(NEXUS_PLIST);
    } catch {
      /* leave it — launchctl unload is the important part */
    }
  }

  // 2. Stop + unload the menubar agent
  if (existsSync(MENUBAR_PLIST)) {
    try {
      await execFileAsync('launchctl', ['unload', MENUBAR_PLIST]);
    } catch {
      /* ignore */
    }
    try {
      rmSync(MENUBAR_PLIST);
    } catch {
      /* ignore */
    }
  }

  // 3. Wipe ~/.nexus (config, db, logs, screenshots)
  if (existsSync(NEXUS_DIR)) {
    rmSync(NEXUS_DIR, { recursive: true, force: true });
  }

  // 4. Optionally remove the cloned repo at ~/nexus/
  if (options.removeRepo && existsSync(REPO_DIR)) {
    rmSync(REPO_DIR, { recursive: true, force: true });
  }
}

// ── Service control ──────────────────────────────────────────────────

export async function getServiceStatus(): Promise<ServiceStatus> {
  const registered = existsSync(NEXUS_PLIST);
  let running = false;
  let pid: number | undefined;
  try {
    const { stdout } = await execFileAsync('launchctl', ['list']);
    for (const line of stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols[2] === NEXUS_LABEL) {
        running = /^\d+$/.test(cols[0] ?? '');
        if (running) pid = Number.parseInt(cols[0]!, 10);
        break;
      }
    }
  } catch {
    /* ignore */
  }
  const bridgeConnected = await testExtensionConnection(500);
  return { registered, running, pid, bridgeConnected };
}

export async function startService(): Promise<void> {
  if (existsSync(NEXUS_PLIST)) {
    try { await execFileAsync('launchctl', ['load', NEXUS_PLIST]); } catch { /* may already be loaded */ }
  }
  try { await execFileAsync('launchctl', ['start', NEXUS_LABEL]); } catch { /* ignore */ }
}

export async function stopService(): Promise<void> {
  try { await execFileAsync('launchctl', ['stop', NEXUS_LABEL]); } catch { /* ignore */ }
}

export async function restartService(): Promise<void> {
  try { await execFileAsync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/${NEXUS_LABEL}`]); }
  catch { await stopService(); await new Promise((r) => setTimeout(r, 500)); await startService(); }
}

export function openLogs(): Promise<void> {
  return execFileAsync('open', [join(NEXUS_DIR, 'nexus.log')]).then(() => undefined);
}

// ── Menubar launchd agent ────────────────────────────────────────────

export async function registerMenubarAgent(appBinary: string): Promise<void> {
  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MENUBAR_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${appBinary}</string>
    <string>--menubar</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${join(NEXUS_DIR, 'menubar.log')}</string>
  <key>StandardErrorPath</key><string>${join(NEXUS_DIR, 'menubar.err')}</string>
</dict>
</plist>
`;
  writeFileSync(MENUBAR_PLIST, plist, 'utf-8');
  try { await execFileAsync('launchctl', ['unload', MENUBAR_PLIST]); } catch { /* not loaded */ }
  await execFileAsync('launchctl', ['load', MENUBAR_PLIST]);
}

// ── Reconfigure (writes fresh config+env without re-cloning/building) ─

export async function reconfigure(
  input: ConfigInput,
  onProgress: ProgressCb,
  appBin?: string,
): Promise<void> {
  onProgress({ phase: 'writing-config', label: 'Writing configuration…', pct: 30 });
  await writeConfig(input);
  // Re-register the launchd agent so new Telegram/Anthropic env values land
  // in the plist's EnvironmentVariables dict — writeConfig only touches
  // config.json and .env, but the running service loads env from the plist.
  onProgress({ phase: 'registering-service', label: 'Re-registering service with new creds…', pct: 70 });
  try {
    await registerLaunchd(input);
  } catch (err) {
    onProgress({
      phase: 'registering-service',
      label: 'Could not re-register service — restarting anyway',
      pct: 80,
      log: err instanceof Error ? err.message : String(err),
    });
    try { await restartService(); } catch { /* ignore */ }
  }
  // Ensure the menu-bar tray agent is also registered. On legacy installs
  // (or manual setups that predate this flow) it might be missing — if so,
  // Reconfigure is a good opportunity to repair it.
  if (appBin && !existsSync(MENUBAR_PLIST)) {
    try {
      await registerMenubarAgent(appBin);
      onProgress({
        phase: 'registering-service',
        label: 'Registered menu bar agent',
        pct: 90,
      });
    } catch {
      /* non-fatal */
    }
  }
  onProgress({ phase: 'done', label: 'Config updated.', pct: 100 });
}

// ═════════════════════════════════════════════════════════════════════
// MAIN-APP FUNCTIONS (post-install management UI)
// ═════════════════════════════════════════════════════════════════════

const LOG_PATH = join(NEXUS_DIR, 'nexus.log');

// ── Dashboard ────────────────────────────────────────────────────────

export async function getDashboardState(): Promise<import('../shared/types').DashboardState> {
  const service = await getServiceStatus();
  const configPath = existsSync(join(NEXUS_DIR, 'config.json')) ? join(NEXUS_DIR, 'config.json') : join(NEXUS_DIR, 'config.yaml');
  let version: string | undefined;
  try {
    if (existsSync(configPath) && configPath.endsWith('.json')) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (typeof parsed?.version === 'string') version = parsed.version;
    }
  } catch { /* ignore */ }

  // Uptime: ps -o etimes for the service pid
  let uptimeSeconds: number | undefined;
  if (service.pid) {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(service.pid), '-o', 'etimes=']);
      const n = Number.parseInt(stdout.trim(), 10);
      if (Number.isFinite(n)) uptimeSeconds = n;
    } catch { /* ignore */ }
  }

  // Memory + session counts from the DB (best-effort; don't fail the dashboard if DB is missing or locked)
  let memoryCount = 0;
  let sessionCount = 0;
  let lastMessageAt: string | undefined;
  try {
    const nodeBin = (await resolveBinary('node')) ?? 'node';
    const bsqlPath = join(REPO_DIR, 'node_modules', 'better-sqlite3');
    if (existsSync(DB_PATH) && existsSync(bsqlPath)) {
      const script = `
        const Database = require('${bsqlPath}');
        const db = new Database('${DB_PATH}', { readonly: true });
        let mem = 0, sess = 0, lastMsg = null;
        try { mem = db.prepare('SELECT COUNT(*) AS c FROM memories').get().c; } catch {}
        try { sess = db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM conversations').get().c; } catch {}
        try { lastMsg = db.prepare('SELECT created_at FROM conversations ORDER BY created_at DESC LIMIT 1').get()?.created_at ?? null; } catch {}
        db.close();
        console.log(JSON.stringify({ mem, sess, lastMsg }));
      `;
      const { stdout } = await execFileAsync(nodeBin, ['-e', script], { timeout: 3000 });
      const parsed = JSON.parse(stdout);
      memoryCount = parsed.mem ?? 0;
      sessionCount = parsed.sess ?? 0;
      lastMessageAt = parsed.lastMsg ?? undefined;
    }
  } catch { /* ignore — stats are best-effort */ }

  return {
    service,
    uptimeSeconds,
    configPath,
    logPath: LOG_PATH,
    repoPath: REPO_DIR,
    memoryCount,
    version,
    sessionCount,
    lastMessageAt,
  };
}

// ── Live log tail ────────────────────────────────────────────────────

type LogLineCb = (line: string) => void;

interface LogTail {
  stop: () => void;
}

export function tailLog(onLine: LogLineCb): LogTail {
  if (!existsSync(LOG_PATH)) {
    onLine('{"level":30,"time":"","component":"installer","msg":"Log file does not exist yet — waiting…"}');
  }
  const child = spawn('tail', ['-n', '200', '-F', LOG_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf-8');
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
      nl = buf.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    // tail -F prints "file not found" to stderr while waiting for creation —
    // surface these as log lines so the UI can show the wait state.
    const s = chunk.toString('utf-8').trim();
    if (s) onLine(`{"level":40,"time":"","component":"tail","msg":${JSON.stringify(s)}}`);
  });
  child.on('error', (err) => {
    onLine(`{"level":50,"time":"","component":"tail","msg":${JSON.stringify(err.message)}}`);
  });
  return {
    stop: () => {
      try { child.kill(); } catch { /* ignore */ }
    },
  };
}

// ── Update (git pull + rebuild + restart) ────────────────────────────

type UpdateProgressCb = (p: import('../shared/types').UpdateProgress) => void;

export async function checkForUpdates(): Promise<{
  localSha: string;
  remoteSha: string;
  commitsBehind: number;
  upToDate: boolean;
}> {
  if (!existsSync(REPO_DIR)) {
    return { localSha: '', remoteSha: '', commitsBehind: 0, upToDate: true };
  }
  const { stdout: local } = await execFileAsync('git', ['-C', REPO_DIR, 'rev-parse', 'HEAD']);
  await execFileAsync('git', ['-C', REPO_DIR, 'fetch', '--quiet']).catch(() => undefined);
  const { stdout: remote } = await execFileAsync('git', ['-C', REPO_DIR, 'rev-parse', '@{u}']).catch(
    async () => await execFileAsync('git', ['-C', REPO_DIR, 'rev-parse', 'origin/main']),
  );
  const { stdout: countStr } = await execFileAsync('git', [
    '-C', REPO_DIR, 'rev-list', '--count', `${local.trim()}..${remote.trim()}`,
  ]).catch(() => ({ stdout: '0' }));
  const commitsBehind = Number.parseInt(countStr.trim(), 10) || 0;
  return {
    localSha: local.trim().slice(0, 7),
    remoteSha: remote.trim().slice(0, 7),
    commitsBehind,
    upToDate: commitsBehind === 0,
  };
}

export async function runUpdate(onProgress: UpdateProgressCb): Promise<void> {
  onProgress({ phase: 'checking', label: 'Checking for updates…', pct: 5 });
  const check = await checkForUpdates();
  if (check.upToDate) {
    onProgress({ phase: 'up-to-date', label: 'Already up to date.', pct: 100, ...check });
    return;
  }
  onProgress({
    phase: 'pulling',
    label: `Pulling ${check.commitsBehind} new commit${check.commitsBehind === 1 ? '' : 's'}…`,
    pct: 20,
    ...check,
  });
  await runStreamed('git', ['-C', REPO_DIR, 'pull', '--ff-only'], REPO_DIR, (line) =>
    onProgress({ phase: 'pulling', label: 'Pulling…', pct: 25, log: line }),
  );

  onProgress({ phase: 'installing', label: 'Installing updated dependencies…', pct: 40 });
  const pnpm = (await resolveBinary('pnpm')) ?? 'pnpm';
  await runStreamed(pnpm, ['install'], REPO_DIR, (line) =>
    onProgress({ phase: 'installing', label: 'Installing…', pct: 50, log: line }),
  );

  onProgress({ phase: 'building', label: 'Rebuilding…', pct: 65 });
  await runStreamed(pnpm, ['run', 'build'], REPO_DIR, (line) =>
    onProgress({ phase: 'building', label: 'Building…', pct: 75, log: line }),
  );

  // Copy new build to ~/.nexus/app/index.cjs
  const built = join(REPO_DIR, 'dist', 'index.cjs');
  if (existsSync(built)) {
    mkdirSync(join(NEXUS_DIR, 'app'), { recursive: true });
    await execFileAsync('cp', [built, join(NEXUS_DIR, 'app', 'index.cjs')]);
  }

  onProgress({ phase: 'restarting', label: 'Restarting NEXUS service…', pct: 90 });
  try {
    await restartService();
  } catch {
    /* not fatal — user can start manually */
  }
  onProgress({ phase: 'done', label: 'Update complete.', pct: 100 });
}

// ── Memory browser (read-only) ───────────────────────────────────────

const MEMORY_TYPE_ENUM = new Set(['episodic', 'semantic', 'procedural']);

export async function listMemories(opts: {
  limit?: number;
  type?: string;
}): Promise<Array<import('../shared/types').MemoryEntry>> {
  if (!existsSync(DB_PATH)) return [];
  const bsqlPath = join(REPO_DIR, 'node_modules', 'better-sqlite3');
  if (!existsSync(bsqlPath)) return [];
  const nodeBin = (await resolveBinary('node')) ?? 'node';
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  // Clamp type to the known enum. If the caller sent anything else,
  // silently ignore the filter — never inject arbitrary strings into SQL.
  const safeType = opts.type && MEMORY_TYPE_ENUM.has(opts.type) ? opts.type : null;
  // Pass the type + limit as a JSON arg to the child process so they flow
  // into the query via prepared-statement bindings, not string templating.
  const payload = JSON.stringify({ type: safeType, limit });
  const script = `
    const Database = require(${JSON.stringify(bsqlPath)});
    const args = JSON.parse(process.env.__NEXUS_ARGS__ || '{}');
    const db = new Database(${JSON.stringify(DB_PATH)}, { readonly: true });
    try {
      const sql = args.type
        ? 'SELECT id, type, content, importance, created_at FROM memories WHERE type = ? ORDER BY created_at DESC LIMIT ?'
        : 'SELECT id, type, content, importance, created_at FROM memories ORDER BY created_at DESC LIMIT ?';
      const params = args.type ? [args.type, args.limit] : [args.limit];
      const rows = db.prepare(sql).all(...params);
      console.log(JSON.stringify(rows));
    } catch (e) {
      console.log('[]');
    } finally {
      db.close();
    }
  `;
  try {
    const { stdout } = await execFileAsync(nodeBin, ['-e', script], {
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, __NEXUS_ARGS__: payload },
    });
    const raw = JSON.parse(stdout) as Array<{ id: string; type: string; content: string; importance: number; created_at: string }>;
    return raw.map((r) => ({
      id: r.id,
      type: r.type,
      content: r.content,
      importance: r.importance,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

// ── Memory delete ────────────────────────────────────────────────────

export async function deleteMemory(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(DB_PATH)) return { ok: false, error: 'memory.db not found' };
  const bsqlPath = join(REPO_DIR, 'node_modules', 'better-sqlite3');
  if (!existsSync(bsqlPath)) return { ok: false, error: 'better-sqlite3 not available' };
  // UUIDs only — silently reject anything else so we never pass user input
  // into a query path that could surprise us.
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return { ok: false, error: 'invalid id' };
  const nodeBin = (await resolveBinary('node')) ?? 'node';
  const payload = JSON.stringify({ id });
  const script = `
    const Database = require(${JSON.stringify(bsqlPath)});
    const args = JSON.parse(process.env.__NEXUS_ARGS__ || '{}');
    const db = new Database(${JSON.stringify(DB_PATH)});
    try {
      const info = db.prepare('DELETE FROM memories WHERE id = ?').run(args.id);
      console.log(JSON.stringify({ changes: info.changes }));
    } catch (e) {
      console.log(JSON.stringify({ error: String(e?.message || e) }));
    } finally {
      db.close();
    }
  `;
  try {
    const { stdout } = await execFileAsync(nodeBin, ['-e', script], {
      timeout: 5000,
      env: { ...process.env, __NEXUS_ARGS__: payload },
    });
    const result = JSON.parse(stdout) as { changes?: number; error?: string };
    if (result.error) return { ok: false, error: result.error };
    if (!result.changes) return { ok: false, error: 'no memory deleted' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

// ── Chat (one-shot via dev-chat.ts) ──────────────────────────────────

export async function chatSend(prompt: string): Promise<{ ok: boolean; reply?: string; error?: string }> {
  const trimmed = prompt.trim();
  if (!trimmed) return { ok: false, error: 'empty prompt' };
  if (trimmed.length > 4000) return { ok: false, error: 'prompt too long (4000 chars max)' };
  if (!existsSync(REPO_DIR)) return { ok: false, error: 'NEXUS repo not found' };
  const pnpm = (await resolveBinary('pnpm')) ?? 'pnpm';
  return new Promise((resolve) => {
    const proc = spawn(
      pnpm,
      ['--silent', 'exec', 'tsx', 'scripts/dev-chat.ts', trimmed],
      { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    proc.stdout.on('data', (d) => { out += String(d); });
    proc.stderr.on('data', () => {});
    const kill = setTimeout(() => { proc.kill('SIGKILL'); }, 150_000);
    proc.on('exit', () => {
      clearTimeout(kill);
      const clean = out.replace(/\x1b\[[0-9;]*m/g, '');
      const idx = clean.lastIndexOf('nexus > ');
      if (idx < 0) return resolve({ ok: false, error: 'no reply captured' });
      const after = clean.slice(idx + 'nexus > '.length);
      const reply = after
        .split('\n')
        .filter((l) => !l.startsWith('{"level"'))
        .join('\n')
        .trim();
      resolve({ ok: true, reply });
    });
    proc.on('error', (err) => {
      clearTimeout(kill);
      resolve({ ok: false, error: String(err.message || err) });
    });
  });
}

// ── Quick-action helpers (run real nexus CLI commands) ───────────────

async function runNexusCli(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; output: string }> {
  const nexusBin = (await resolveBinary('nexus')) ?? 'nexus';
  return new Promise((resolve) => {
    const proc = spawn(nexusBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += String(d); });
    proc.stderr.on('data', (d) => { out += String(d); });
    const kill = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.on('exit', (code) => {
      clearTimeout(kill);
      resolve({ ok: code === 0, output: out.replace(/\x1b\[[0-9;]*m/g, '').trim() });
    });
    proc.on('error', () => {
      clearTimeout(kill);
      resolve({ ok: false, output: 'failed to spawn nexus CLI' });
    });
  });
}

export async function takeScreenshot(): Promise<{ ok: boolean; output: string }> {
  return runNexusCli(['screenshot']);
}

export async function triggerDream(): Promise<{ ok: boolean; output: string }> {
  return runNexusCli(['dream'], 180_000);
}

export async function runHealthCheck(): Promise<{ ok: boolean; output: string }> {
  return runNexusCli(['health']);
}

// ── About / system info ──────────────────────────────────────────────

export async function getAboutInfo(appPath: string): Promise<import('../shared/types').AboutInfo> {
  const { stdout: nodeVer } = await execFileAsync((await resolveBinary('node')) ?? 'node', ['-v']).catch(
    () => ({ stdout: 'unknown' }),
  );
  let version: string | undefined;
  const cjson = join(NEXUS_DIR, 'config.json');
  if (existsSync(cjson)) {
    try {
      version = JSON.parse(readFileSync(cjson, 'utf-8'))?.version;
    } catch { /* ignore */ }
  }
  return {
    version: version ?? 'unknown',
    nodeVersion: nodeVer.trim().replace(/^v/, ''),
    platform: process.platform,
    configPath: existsSync(cjson) ? cjson : join(NEXUS_DIR, 'config.yaml'),
    dbPath: DB_PATH,
    logPath: LOG_PATH,
    repoPath: REPO_DIR,
    appPath,
    installerVersion: VERSION,
  };
}
