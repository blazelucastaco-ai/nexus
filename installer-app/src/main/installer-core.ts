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

const VERSION = '0.2.4';
const HOME = homedir();
const NEXUS_DIR = join(HOME, '.nexus');
// NEXUS daemon reads ONLY from config.yaml (see src/config.ts). Detection
// reads config.json first (easier to parse without a YAML dep) and falls back
// to .yaml. Writes must go to BOTH — otherwise reconfigure silently no-ops
// the daemon's view of the world. (See the bug hit on 2026-04-20 where
// personality changes were saved to json but the daemon kept reading the
// stale yaml.)
const CONFIG_PATH = join(NEXUS_DIR, 'config.json');
const CONFIG_PATH_YAML = join(NEXUS_DIR, 'config.yaml');

// Minimal YAML emitter for the fixed NexusConfig shape we write. Not a
// general-purpose serializer — it assumes objects with string keys, arrays
// of primitives (or objects), and primitive scalars (string | number |
// bool). Strings are quoted when they contain YAML specials.
function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    // Quote if contains YAML-sensitive chars, starts with a number/digit,
    // or could be ambiguous.
    if (/^[0-9\-+]|[:#{}\[\],&*!|>'"%@`?\n]/.test(value) || value === '' || /^(true|false|null|yes|no|on|off)$/i.test(value)) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '\n' + value.map((v) => `${pad}- ${toYaml(v, indent + 1).replace(/^\n/, '')}`).join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return '\n' + entries.map(([k, v]) => {
      const rendered = toYaml(v, indent + 1);
      if (rendered.startsWith('\n')) return `${pad}${k}:${rendered}`;
      return `${pad}${k}: ${rendered}`;
    }).join('\n');
  }
  return String(value);
}

function stringifyConfigYaml(obj: unknown): string {
  const body = toYaml(obj, 0);
  return (body.startsWith('\n') ? body.slice(1) : body) + '\n';
}
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

/**
 * Install the system-level prerequisites NEXUS needs (Node 22+, pnpm).
 * Called from the wizard's Step 1 Install button when those are missing.
 *
 * Strategy — pure background, single native macOS password dialog:
 *
 *   - Node.js → official `.pkg` from nodejs.org. Run with `/usr/sbin/installer`
 *     under `osascript do shell script with administrator privileges`. This
 *     pops the NATIVE macOS authorization dialog (the one with TouchID
 *     support that says "NEXUS wants to make changes"). No Terminal window,
 *     no AppleScript-app-control permission, no manual user intervention
 *     beyond the password / TouchID prompt.
 *
 *   - pnpm → `corepack enable`. Ships with Node 22, writes shims to
 *     /usr/local/bin (same elevated context). First `pnpm` invocation
 *     auto-downloads the binary into the user's cache.
 *
 *   - Homebrew is intentionally NOT installed. The system check marks it
 *     as `required: false` — NEXUS doesn't need brew, only Node + pnpm.
 *     Trying to install Homebrew from inside Electron is the path that
 *     forced a Terminal + AppleScript route in the previous attempt.
 *     Dropping it lets the whole flow stay native and silent.
 *
 * Progress streaming: the elevated install script writes phase markers
 * to a log file the main process polls every 400ms. Markers are
 * `PHASE:<phase>:<label>` (one per line). When osascript exits, we run
 * one final runSystemChecks to verify and emit 'done' or 'error'.
 */
type PrereqProgressCb = (p: import('../shared/types').PrereqProgress) => void;

// Fallback LTS if nodejs.org's index.json can't be reached at install time.
// Bump occasionally so a permanently-offline install still ends with a
// reasonably-recent Node. Resolution is dynamic by default — this is just
// the safety net.
const NODE_LTS_FALLBACK = '22.11.0';

/**
 * Resolve the latest LTS Node.js version from nodejs.org's dist index.
 * Returns the bare semver string ("22.11.0"). On network error / parse
 * failure / 10s timeout, returns NODE_LTS_FALLBACK so installs still
 * succeed in offline-ish conditions.
 *
 * `lts: "Jod"` is Node 22's codename — we filter to that line so future
 * Node 24/26 LTS versions don't accidentally land here without a code
 * change that confirms they're compatible.
 */
export async function resolveLatestNodeLts(): Promise<string> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch('https://nodejs.org/dist/index.json', {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return NODE_LTS_FALLBACK;
    const releases = (await resp.json()) as Array<{ version: string; lts: string | false }>;
    // releases are ordered newest-first. Find the newest entry with the
    // Node 22 LTS codename "Jod".
    const latest = releases.find((r) => r.lts === 'Jod');
    if (!latest?.version) return NODE_LTS_FALLBACK;
    return latest.version.replace(/^v/, '');
  } catch {
    return NODE_LTS_FALLBACK;
  }
}

// PHASE: marker format the install script writes to its log. Pure parser
// extracted so it can be unit-tested without spawning a real install.
//
//   "PHASE:downloading-node:Downloading Node.js (LTS)…"
//   "PHASE:done:All prerequisites installed."
//
// Anything not matching this shape returns null and is ignored — that
// covers blank lines, stdout from curl/installer, and any future log
// noise we haven't anticipated.
export function parsePhaseLine(line: string): import('../shared/types').PrereqProgress | null {
  if (!line || !line.startsWith('PHASE:')) return null;
  // Use slice rather than split(':', 3) — labels often contain colons
  // ("Installing… 60%") which split would chop.
  const afterPrefix = line.slice('PHASE:'.length);
  const sep = afterPrefix.indexOf(':');
  if (sep < 0) return null;
  const phase = afterPrefix.slice(0, sep);
  const label = afterPrefix.slice(sep + 1);
  if (!phase) return null;
  const pctMap: Record<string, number> = {
    'starting': 8,
    'downloading-node': 20,
    'installing-node': 65,
    'installing-pnpm': 88,
    'done': 100,
  };
  const pct = pctMap[phase] ?? 50;
  return {
    phase: (phase as import('../shared/types').PrereqProgress['phase']) ?? 'verifying',
    label: label || 'Working…',
    pct,
  };
}

/**
 * Robust user-cancel detection for the osascript authorization dialog.
 * The error surface has several shapes depending on macOS version + locale:
 *   - "User canceled."           (English, common)
 *   - "User cancelled."          (some locales)
 *   - "The operation was canceled by the user."
 *   - Exit code 1 with no stderr on some versions
 *   - errAuthorizationCanceled (-60006)
 * We check the union — any one matching wins. Plus a guard for cases
 * where osascript exits non-zero but we haven't seen a 'done' phase in
 * the log (i.e. install was halted partway).
 */
export function isOsascriptCancel(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? `${err.message} ${(err as { stderr?: string }).stderr ?? ''}` : String(err);
  if (/user\s+cancel{1,2}ed|operation\s+was\s+cancel{1,2}ed/i.test(msg)) return true;
  if (/-60006|errAuthorizationCanceled/.test(msg)) return true;
  return false;
}

export async function installPrereqs(onProgress: PrereqProgressCb): Promise<void> {
  onProgress({ phase: 'starting', label: 'Checking what to install…', pct: 2 });
  const checks = await runSystemChecks();
  const byName = new Map(checks.map((c) => [c.name, c]));

  const nodeMissing = !byName.get('Node.js')?.ok;
  const pnpmMissing = !byName.get('pnpm')?.ok;

  if (!nodeMissing && !pnpmMissing) {
    onProgress({ phase: 'done', label: 'Everything is already installed.', pct: 100 });
    return;
  }

  // ── Resolve the latest Node 22 LTS dynamically (with offline fallback) ──
  onProgress({ phase: 'starting', label: 'Looking up the latest Node.js LTS…', pct: 4 });
  const nodeVersion = await resolveLatestNodeLts();
  const nodePkgUrl = `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}.pkg`;

  // ── Write the install script + log to /tmp ──────────────────────────────
  const stamp = Date.now();
  const scriptPath = `/tmp/nexus-prereq-${stamp}.sh`;
  const logPath = `/tmp/nexus-prereq-${stamp}.log`;
  const pkgPath = `/tmp/nexus-node-${stamp}.pkg`;

  // The script runs as root (from osascript elevation). We log phase markers
  // to a file the user can read (writable by anyone). Each phase line is
  // `PHASE:<phase>:<label>`. The main process polls this file for progress.
  const script = [
    '#!/bin/bash',
    'set -e',
    `LOG="${logPath}"`,
    'log() { echo "$@" >> "$LOG"; }',
    '',
    // Make the log world-readable so the (non-root) main process can tail it.
    `touch "$LOG"`,
    `chmod 666 "$LOG"`,
    '',
    nodeMissing ? [
      `log "PHASE:downloading-node:Downloading Node.js v${nodeVersion}…"`,
      `if [ ! -f "${pkgPath}" ]; then`,
      `  curl -fsSL "${nodePkgUrl}" -o "${pkgPath}" >> "$LOG" 2>&1`,
      'fi',
      'log "PHASE:installing-node:Installing Node.js…"',
      `/usr/sbin/installer -pkg "${pkgPath}" -target / >> "$LOG" 2>&1`,
      `rm -f "${pkgPath}"`,
    ].join('\n') : '',
    pnpmMissing || nodeMissing ? [
      'log "PHASE:installing-pnpm:Setting up pnpm…"',
      // corepack ships in Node 22; the .pkg installs it to /usr/local/bin.
      // After `enable`, `pnpm` resolves on PATH for the user too.
      '/usr/local/bin/corepack enable >> "$LOG" 2>&1 || true',
    ].join('\n') : '',
    '',
    'log "PHASE:done:All prerequisites installed."',
    'exit 0',
  ].filter(Boolean).join('\n');

  writeFileSync(scriptPath, script, { mode: 0o755 });

  // ── Spawn the elevated install (no Terminal, no Automation permission) ─
  // `osascript do shell script ... with administrator privileges` shows the
  // NATIVE macOS authorization dialog. The dialog includes the app's name
  // (NEXUS) and a TouchID option. No Terminal window opens.
  const osascriptCmd = [
    `do shell script "/bin/bash '${scriptPath}'"`,
    `with prompt "NEXUS needs your password to install Node.js."`,
    `with administrator privileges`,
  ].join(' ');

  onProgress({
    phase: 'starting',
    label: 'Asking for your password…',
    pct: 6,
  });

  // Fire-and-await — osascript blocks until the install script completes.
  // In parallel, we poll the log file for phase markers.
  const installPromise = execFileAsync('osascript', ['-e', osascriptCmd], { maxBuffer: 4 * 1024 * 1024 });

  // ── Poll the log file every 400ms for new phase markers ────────────────
  let lastLineSeen = 0;
  let sawDoneMarker = false;
  const poll = setInterval(() => {
    try {
      if (!existsSync(logPath)) return;
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = lastLineSeen; i < lines.length; i++) {
        const parsed = parsePhaseLine(lines[i]);
        if (!parsed) continue;
        if (parsed.phase === 'done') sawDoneMarker = true;
        onProgress(parsed);
      }
      lastLineSeen = lines.length;
    } catch { /* tolerated — next tick */ }
  }, 400);

  try {
    await installPromise;
  } catch (err) {
    clearInterval(poll);
    if (isOsascriptCancel(err) || !sawDoneMarker) {
      // Either we got an explicit cancel signal, or osascript exited
      // non-zero without ever reaching the 'done' phase — both are
      // user-cancel-equivalent from a UX perspective.
      const isExplicitCancel = isOsascriptCancel(err);
      onProgress({
        phase: 'error',
        label: isExplicitCancel
          ? 'Install cancelled. Click Try Again to retry.'
          : `Install stopped early. ${err instanceof Error ? err.message.split('\n')[0] : ''}`.trim(),
        pct: 0,
      });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress({ phase: 'error', label: `Install failed: ${msg.split('\n')[0]}`, pct: 0 });
    }
    return;
  }
  clearInterval(poll);

  // ── Final verification ──────────────────────────────────────────────────
  onProgress({ phase: 'verifying', label: 'Verifying…', pct: 96 });
  const finalChecks = await runSystemChecks();
  const stillMissing = finalChecks.filter((c) => c.required && !c.ok).map((c) => c.name);
  if (stillMissing.length > 0) {
    onProgress({
      phase: 'error',
      label: `Still missing: ${stillMissing.join(', ')}. Try again or install manually.`,
      pct: 100,
    });
    return;
  }
  onProgress({ phase: 'done', label: 'All prerequisites installed.', pct: 100 });
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
    installMethod: 'app' as const,
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

  // mode 0o600 on files under ~/.nexus that hold identifying data. Even
  // though config.json / config.yaml don't contain tokens (those live in
  // .env), they include the Telegram chat ID and personality, which is
  // PII-ish and shouldn't be world-readable on a shared Mac.
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  // Also write YAML — the NEXUS daemon only reads config.yaml. Writing
  // both keeps detection fast (json) and the runtime correct (yaml).
  writeFileSync(CONFIG_PATH_YAML, stringifyConfigYaml(config), { encoding: 'utf-8', mode: 0o600 });

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
  // mode 0o600: the .env holds Anthropic API key + Telegram bot token.
  // World-readable would let any other local user process harvest them.
  writeFileSync(ENV_PATH, envLines.join('\n'), { encoding: 'utf-8', mode: 0o600 });
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
  // mode 0o700: owner-execute-only. Previously 0o755 (world-readable). The
  // script doesn't contain secrets but referencing it with 0o700 keeps the
  // whole ~/.nexus tree consistently owner-only on shared Macs.
  writeFileSync(startSh, startScript, { mode: 0o700 });

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
  // mode 0o600: the plist embeds all env vars in the file, including the
  // Anthropic API key and Telegram bot token. Plists under
  // ~/Library/LaunchAgents are user-scoped, but still default to 0o644
  // without this. Lock them down.
  writeFileSync(plistPath, plist, { encoding: 'utf-8', mode: 0o600 });

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
    // FORCE_COLOR=0 + CI=1 + TERM=dumb disables chalk colors, ora spinners,
    // and most progress-bar libraries in Node child processes. Without these,
    // `pnpm install` / `pnpm build` emit braille spinner frames + cursor
    // control codes that render as garbage in the install wizard's log pane.
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', CI: '1', TERM: 'dumb', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const pump = (chunk: Buffer): void => {
      buf += chunk.toString('utf-8');
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const rawLine = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        // Belt-and-suspenders — even with the env vars above, some tools
        // still emit control codes (`.catch(() => ...)` prints native error
        // messages, npm spinners, etc.). Strip them here too.
        const line = stripTerminalJunk(rawLine);
        if (line) onLine(line);
        nl = buf.indexOf('\n');
      }
    };
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('error', reject);
    child.on('close', (code) => {
      const tail = stripTerminalJunk(buf);
      if (tail) onLine(tail);
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

// ── Update (GitHub Releases-based) ───────────────────────────────────
//
// We don't ship a code-signed DMG, so in-place electron-updater isn't an
// option (it verifies signatures). Instead we poll the GitHub Releases API
// once per session (plus any time the user opens the Updates tab), compare
// the latest tag to the installed installer-app version, and — when newer —
// surface a banner that opens the release page / DMG URL in the user's
// browser. User drags the new DMG into /Applications as usual.
//
// Daemon source updates (git pull) still work for the CLI-install path;
// they're not exposed from the installer-app anymore because the install
// bundle itself is the source of truth.

type UpdateProgressCb = (p: import('../shared/types').UpdateProgress) => void;

const RELEASES_API = 'https://api.github.com/repos/blazelucastaco-ai/nexus/releases/latest';
const DMG_DOWNLOAD_URL = 'https://github.com/blazelucastaco-ai/nexus/releases/latest/download/NEXUS-Installer.dmg';
const RELEASE_PAGE_URL = 'https://github.com/blazelucastaco-ai/nexus/releases/latest';

/** Installed installer-app version. Read from package.json of the packaged app. */
function installedAppVersion(): string {
  try {
    // When packaged, app.asar unpacks package.json at root of __dirname's ancestor.
    // Safer: require via process.resourcesPath which electron exposes.
    const pkgPath = join(process.resourcesPath ?? REPO_DIR, 'app.asar', 'package.json');
    if (existsSync(pkgPath)) {
      return JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0';
    }
  } catch { /* fall through */ }
  // Fallback for `pnpm dev` or unpackaged runs — read from the source tree.
  try {
    const local = join(__dirname, '..', '..', 'package.json');
    if (existsSync(local)) return JSON.parse(readFileSync(local, 'utf-8')).version ?? '0.0.0';
  } catch { /* ignore */ }
  return '0.0.0';
}

/** Parse a semver "v1.2.3" or "1.2.3" into [major, minor, patch]. Garbage → [0,0,0]. */
function parseSemver(v: string): [number, number, number] {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)];
}

function isNewerSemver(remote: string, local: string): boolean {
  const [a1, a2, a3] = parseSemver(remote);
  const [b1, b2, b3] = parseSemver(local);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}

export async function checkForUpdates(): Promise<{
  /** Installed version on this Mac. */
  installedVersion: string;
  /** Latest version available on GitHub Releases. */
  latestVersion: string;
  /** Direct URL to the DMG for the latest release. */
  downloadUrl: string;
  /** Release page (so users can read release notes first). */
  releasePageUrl: string;
  /** True if an update is available. */
  updateAvailable: boolean;
  /** True if we couldn't reach GitHub (network issue). Callers should display "could not check". */
  offline?: boolean;
  // ── Legacy shape (kept for any old renderer code that still reads these).
  localSha: string;
  remoteSha: string;
  commitsBehind: number;
  upToDate: boolean;
}> {
  const installedVersion = installedAppVersion();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch(RELEASES_API, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `nexus-installer/${installedVersion}`,
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`github_${resp.status}`);
    const body = (await resp.json()) as { tag_name?: string; html_url?: string };
    const latestVersion = (body.tag_name ?? '').replace(/^v/, '') || installedVersion;
    const updateAvailable = isNewerSemver(latestVersion, installedVersion);
    return {
      installedVersion,
      latestVersion,
      downloadUrl: DMG_DOWNLOAD_URL,
      releasePageUrl: body.html_url ?? RELEASE_PAGE_URL,
      updateAvailable,
      // Legacy compatibility fields
      localSha: installedVersion,
      remoteSha: latestVersion,
      commitsBehind: updateAvailable ? 1 : 0,
      upToDate: !updateAvailable,
    };
  } catch {
    // Offline / rate-limited — report "up to date" rather than freaking out.
    return {
      installedVersion,
      latestVersion: installedVersion,
      downloadUrl: DMG_DOWNLOAD_URL,
      releasePageUrl: RELEASE_PAGE_URL,
      updateAvailable: false,
      offline: true,
      localSha: installedVersion,
      remoteSha: installedVersion,
      commitsBehind: 0,
      upToDate: true,
    };
  }
}

/**
 * "Run update" now just opens the DMG download in the user's browser.
 * In-place patching requires a code-signed binary that verifies the new
 * download; without signing the safest path is to let the user manually
 * replace the app.
 */
export async function runUpdate(onProgress: UpdateProgressCb): Promise<void> {
  onProgress({ phase: 'checking', label: 'Checking GitHub Releases…', pct: 10 });
  const check = await checkForUpdates();
  if (!check.updateAvailable) {
    onProgress({
      phase: 'up-to-date',
      label: check.offline ? 'Could not reach GitHub.' : `You're on the latest (v${check.installedVersion}).`,
      pct: 100,
      ...check,
    });
    return;
  }
  onProgress({
    phase: 'downloading',
    label: `v${check.latestVersion} available — opening download…`,
    pct: 50,
    ...check,
  });
  // Open the DMG URL in the default browser. User downloads, drags to
  // Applications, replaces the old NEXUS.app.
  try {
    const { shell } = await import('electron');
    await shell.openExternal(check.downloadUrl);
  } catch (err) {
    onProgress({
      phase: 'error',
      label: `Could not open download: ${(err as Error).message}`,
      pct: 100,
    });
    return;
  }
  onProgress({
    phase: 'done',
    label: 'Download started in your browser. Drag the new NEXUS into Applications to update.',
    pct: 100,
    ...check,
  });
}

/**
 * Auto-update: download the DMG to a temp file, mount it, copy the new .app
 * over the running one, detach, then `app.relaunch()` + `app.quit()`. The
 * running binary is memory-mapped on macOS, so replacing the file underneath
 * is safe — the running process keeps its open file handle, and the new
 * binary loads on relaunch.
 *
 * Safety:
 *   - Requires `installRoot` to be writable. If not (eg installed under
 *     /Applications without write perms), fall back to opening the DMG in
 *     Finder so the user can drag-replace manually.
 *   - Verifies the mount produced a NEXUS.app before swapping.
 *   - Detaches the volume even on error.
 *   - Does NOT call app.quit() itself — the caller decides when to restart,
 *     since the popup window may need a moment to render the "restarting"
 *     state before the process dies.
 */
export async function runAutoUpdate(
  installRoot: string,
  onProgress: UpdateProgressCb,
): Promise<{ ok: true; latestVersion: string } | { ok: false; error: string }> {
  onProgress({ phase: 'checking', label: 'Checking GitHub Releases…', pct: 5 });
  const check = await checkForUpdates();
  if (!check.updateAvailable) {
    return { ok: false, error: check.offline ? 'Could not reach GitHub.' : 'Already on the latest version.' };
  }

  const cacheDir = join(HOME, 'Library', 'Caches', 'NEXUS-installer');
  try { mkdirSync(cacheDir, { recursive: true }); } catch { /* tolerated */ }
  const dmgPath = join(cacheDir, `NEXUS-${check.latestVersion}.dmg`);

  // ── 1. Download ─────────────────────────────────────────────────────────
  onProgress({
    phase: 'downloading',
    label: `Downloading v${check.latestVersion}…`,
    pct: 15,
    ...check,
  });
  try {
    const resp = await fetch(check.downloadUrl);
    if (!resp.ok || !resp.body) throw new Error(`download_${resp.status}`);
    // Stream to disk so we don't buffer the full ~150MB in RAM.
    const total = Number(resp.headers.get('content-length') ?? '0');
    const fileHandle = await (await import('node:fs/promises')).open(dmgPath, 'w');
    let received = 0;
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await fileHandle.write(value);
        received += value.byteLength;
        if (total > 0) {
          const pct = 15 + Math.round((received / total) * 60); // 15..75
          onProgress({ phase: 'downloading', label: `Downloading v${check.latestVersion}…`, pct });
        }
      }
    }
    await fileHandle.close();
  } catch (err) {
    return { ok: false, error: `Download failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // ── 2. Mount ────────────────────────────────────────────────────────────
  onProgress({ phase: 'installing', label: 'Mounting installer…', pct: 78 });
  let mountPoint = '';
  try {
    // -nobrowse: don't show the DMG in Finder. -readonly: don't try to write
    // to the image. We parse the plist output to find the mount point.
    const { stdout } = await execFileAsync('hdiutil', [
      'attach', dmgPath, '-nobrowse', '-readonly', '-noverify', '-plist',
    ], { maxBuffer: 4 * 1024 * 1024 });
    const m = stdout.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
    if (!m) throw new Error('mount_point_not_found');
    mountPoint = m[1];
  } catch (err) {
    return { ok: false, error: `Could not mount DMG: ${err instanceof Error ? err.message : String(err)}` };
  }

  // ── 3. Swap the .app ────────────────────────────────────────────────────
  // We expect mountPoint to contain a NEXUS.app at its root.
  const newApp = join(mountPoint, 'NEXUS.app');
  if (!existsSync(newApp)) {
    try { await execFileAsync('hdiutil', ['detach', mountPoint, '-quiet']); } catch { /* ignore */ }
    return { ok: false, error: `NEXUS.app not found inside DMG (looked at ${newApp}).` };
  }

  // installRoot is the existing .app path. Move-aside + copy-new + delete-old
  // pattern keeps a backup if anything goes wrong mid-copy.
  const bakPath = `${installRoot}.bak-${Date.now()}`;
  try {
    onProgress({ phase: 'installing', label: 'Installing update…', pct: 86 });
    // Move the old app aside.
    await execFileAsync('mv', [installRoot, bakPath]);
    // Copy the new app into place. `cp -R` preserves perms + symlinks
    // inside Frameworks/. -p keeps mtime so Gatekeeper's translocation
    // heuristics don't flag this as a "new download from unknown origin."
    await execFileAsync('cp', ['-Rp', newApp, installRoot]);

    // ── Gatekeeper sanitation ─────────────────────────────────────────
    // 1) Strip the quarantine xattr that DMG-mounted files inherit. Without
    //    this, macOS pops "NEXUS was blocked to protect your Mac" on next
    //    launch and the user has to dig into System Settings → Privacy &
    //    Security → Open Anyway. `xattr -cr` clears *all* xattrs recursively;
    //    this is what every macOS self-updater does (Sparkle, Homebrew Cask,
    //    etc.). Tolerate failure — worst case the user sees the dialog once.
    onProgress({ phase: 'installing', label: 'Clearing quarantine…', pct: 91 });
    try { await execFileAsync('xattr', ['-cr', installRoot]); } catch { /* tolerated */ }

    // 2) Re-sign ad-hoc. The DMG ships with a signature that was valid in
    //    the build environment; after cp -Rp the bundle's signature can
    //    fail Gatekeeper's stricter checks on the destination filesystem.
    //    `codesign --force --deep --sign -` re-applies a fresh ad-hoc
    //    signature in-place. This is exactly what installer-app's own
    //    after-sign.js hook does at build time.
    onProgress({ phase: 'installing', label: 'Re-signing…', pct: 95 });
    try {
      await execFileAsync('codesign', [
        '--force', '--deep', '--sign', '-',
        '--timestamp=none',
        installRoot,
      ], { maxBuffer: 4 * 1024 * 1024 });
    } catch (err) {
      // Re-sign failure isn't fatal for app behavior, just for Gatekeeper
      // first-launch UX. Log and continue — the user can still "Open Anyway".
      // eslint-disable-next-line no-console
      console.warn('[runAutoUpdate] codesign failed:', err instanceof Error ? err.message : String(err));
    }

    // Clean up the backup. If this fails it's not fatal — the install
    // succeeded, the user just has a .bak directory they can rm later.
    try { rmSync(bakPath, { recursive: true, force: true }); } catch { /* ignore */ }
  } catch (err) {
    // Try to roll back if the new copy failed mid-way.
    try {
      if (existsSync(bakPath) && !existsSync(installRoot)) {
        await execFileAsync('mv', [bakPath, installRoot]);
      }
    } catch { /* best effort */ }
    try { await execFileAsync('hdiutil', ['detach', mountPoint, '-quiet']); } catch { /* ignore */ }
    return { ok: false, error: `Install failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // ── 4. Detach ───────────────────────────────────────────────────────────
  try { await execFileAsync('hdiutil', ['detach', mountPoint, '-quiet']); } catch { /* tolerated */ }

  onProgress({ phase: 'restarting', label: `Restarting on v${check.latestVersion}…`, pct: 98 });
  return { ok: true, latestVersion: check.latestVersion };
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

// ── Quick-action helpers (run real nexus CLI commands) ───────────────

/**
 * Strip ALL ANSI escape sequences plus spinner artefacts from CLI output so
 * the dashboard's <pre> blocks render clean text. The previous regex only
 * caught SGR color codes ending in `m`, leaving cursor-control sequences
 * (`\x1b[?25l`, `\x1b[K`, `\x1b[2A`) and `ora` spinner frames rendering as
 * "random letters" — the exact bug reported in the Dashboard actions.
 */
function stripTerminalJunk(s: string): string {
  return s
    // Full CSI sequence — `\x1b[` then optional `?` + digits/semicolons + final byte.
    .replace(/\x1b\[[?0-9;]*[a-zA-Z]/g, '')
    // OSC sequences (e.g. terminal titles): `\x1b]...\x07` or `\x1b]...\x1b\\`
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // ora/cli-spinners: braille + other common spinner glyphs, when they're
    // surrounded by whitespace (isolated Unicode spinner frames only — we
    // don't want to nuke legitimate Unicode in skill/memory content).
    .replace(/[\u2800-\u28FF]\s*/g, '')
    // Carriage returns without newlines — ora uses `\r` to overwrite the
    // spinner line. After stripping the spinner chars, these become dead
    // weight that makes the output look misaligned in a <pre>.
    .replace(/\r(?!\n)/g, '')
    .trim();
}

async function runNexusCli(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; output: string }> {
  const nexusBin = (await resolveBinary('nexus')) ?? 'nexus';
  return new Promise((resolve) => {
    const proc = spawn(nexusBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Tell the CLI it's not on a TTY so ora falls back to a quiet non-spinner
      // mode in libraries that check. Many ora-based CLIs will also disable
      // color + progress bars when FORCE_COLOR=0 + CI=1.
      env: { ...process.env, FORCE_COLOR: '0', CI: '1', TERM: 'dumb' },
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += String(d); });
    proc.stderr.on('data', (d) => { out += String(d); });
    const kill = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.on('exit', (code) => {
      clearTimeout(kill);
      resolve({ ok: code === 0, output: stripTerminalJunk(out) });
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

// ── Memory import (detect + merge other agents' memory) ─────────────

export interface DetectedMemorySource {
  id: string;
  name: string;
  status: 'ready' | 'empty' | 'coming-soon';
  summary: string;
  estimatedItems: number;
}

export interface MemoryImportResult {
  imported: number;
  skipped: number;
  skillsWritten?: number;
  sources: Record<string, number>;
  llmUsed?: boolean;
  /** Sources that were selected but already imported on a previous run — skipped. */
  alreadyImported?: string[];
}

/**
 * Detect which other AI agents (Claude Code, Codex, Gemini, Cursor) are
 * installed. This is a pure filesystem probe — no NEXUS daemon needed —
 * so it can run during the wizard before any install has happened.
 */
export async function detectMemorySources(): Promise<DetectedMemorySource[]> {
  // Direct filesystem-level detection — keeps us independent of the running
  // daemon. Mirrors the logic in src/memory/import.ts.
  const out: DetectedMemorySource[] = [];
  // Claude Code
  try {
    const root = join(HOME, '.claude', 'projects');
    if (existsSync(root)) {
      const { readdirSync } = await import('node:fs');
      let memoryCount = 0;
      for (const entry of readdirSync(root)) {
        const mem = join(root, entry, 'memory');
        if (!existsSync(mem)) continue;
        const files = readdirSync(mem).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
        memoryCount = files.length;
        if (memoryCount > 0) break;
      }
      out.push({
        id: 'claude-code',
        name: 'Claude Code',
        status: memoryCount > 0 ? 'ready' : 'empty',
        summary: memoryCount > 0 ? `${memoryCount} memory notes` : 'Installed, but no memory notes to import',
        estimatedItems: memoryCount,
      });
    }
  } catch { /* ignore */ }
  // OpenAI Codex
  try {
    const rulesFile = join(HOME, '.codex', 'rules', 'default.rules');
    if (existsSync(rulesFile)) {
      const content = readFileSync(rulesFile, 'utf-8');
      const n = content.split('\n').filter((l) => l.trim().startsWith('prefix_rule')).length;
      out.push({
        id: 'openai-codex',
        name: 'OpenAI Codex',
        status: n > 0 ? 'ready' : 'empty',
        summary: n > 0 ? `${n} command allowlist rules — extracted as workflow hints` : 'Rules file present but empty',
        estimatedItems: Math.min(n, 30),
      });
    }
  } catch { /* ignore */ }
  // Gemini CLI (coming soon)
  if (existsSync(join(HOME, '.gemini'))) {
    out.push({
      id: 'gemini-cli',
      name: 'Gemini CLI',
      status: 'coming-soon',
      summary: 'Detected — no user-memory format to import yet',
      estimatedItems: 0,
    });
  }
  // Cursor (coming soon)
  const cursorRoots = [join(HOME, 'Library', 'Application Support', 'Cursor'), join(HOME, '.cursor')];
  if (cursorRoots.some((r) => existsSync(r))) {
    out.push({
      id: 'cursor',
      name: 'Cursor',
      status: 'coming-soon',
      summary: 'Detected — rule/preference import coming soon',
      estimatedItems: 0,
    });
  }
  return out;
}

export type MemoryImportProgress =
  | { type: 'phase'; phase: string; label: string; pct: number; source?: string };

export type MemoryImportProgressCb = (p: MemoryImportProgress) => void;

/**
 * Run the memory-import subprocess and stream per-phase progress events to
 * the caller. Parent process reads stdout line by line: each `{type:"phase"…}`
 * JSON is a progress tick; the single `{type:"done",result:…}` JSON carries
 * the final counts.
 */
export async function runMemoryImport(
  sourceIds: string[],
  onProgress?: MemoryImportProgressCb,
): Promise<MemoryImportResult> {
  const zero: MemoryImportResult = { imported: 0, skipped: 0, sources: {}, alreadyImported: [] };
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return zero;
  const safeIds = new Set(['claude-code', 'openai-codex', 'gemini-cli', 'cursor']);
  const filtered = sourceIds.filter((id) => safeIds.has(id));
  if (filtered.length === 0) return zero;
  const pnpm = (await resolveBinary('pnpm')) ?? 'pnpm';
  const envKey = readAnthropicKeyFromRepoEnv();

  return new Promise<MemoryImportResult>((resolve) => {
    const proc = spawn(
      pnpm,
      ['--silent', 'exec', 'tsx', 'scripts/run-import.ts'],
      {
        cwd: REPO_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(envKey ? { ANTHROPIC_API_KEY: envKey } : {}),
          __NEXUS_IMPORT_SOURCES__: filtered.join(','),
        },
      },
    );

    let buffer = '';
    let finalResult: MemoryImportResult = zero;
    const killTimer = setTimeout(() => proc.kill('SIGKILL'), 300_000);

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let idx: number;
      // eslint-disable-next-line no-cond-assign
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as { type?: string };
          if (obj.type === 'phase') {
            onProgress?.(obj as MemoryImportProgress);
          } else if (obj.type === 'done') {
            const r = (obj as { result: MemoryImportResult }).result;
            if (r) finalResult = r;
          }
        } catch { /* partial JSON or other stdout — skip */ }
      }
    });

    proc.stderr.on('data', () => { /* swallowed */ });

    proc.on('exit', () => {
      clearTimeout(killTimer);
      resolve(finalResult);
    });
    proc.on('error', () => {
      clearTimeout(killTimer);
      resolve(zero);
    });
  });
}

function readAnthropicKeyFromRepoEnv(): string | null {
  const envPath = join(REPO_DIR, '.env');
  if (!existsSync(envPath)) return null;
  try {
    const text = readFileSync(envPath, 'utf-8');
    const m = text.match(/^ANTHROPIC_API_KEY\s*=\s*(.+)$/m);
    return m ? m[1]!.trim() : null;
  } catch { return null; }
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
