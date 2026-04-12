import { Command } from 'commander';
import chalk from 'chalk';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HOME = homedir();
const NEXUS_DIR = join(HOME, '.nexus');
const CONFIG_PATH = join(NEXUS_DIR, 'config.yaml');
const LOG_PATH = join(NEXUS_DIR, 'logs', 'nexus.log');
const DB_PATH = join(NEXUS_DIR, 'memory.db');
const PLIST_LABEL = 'local.nexus';
const PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const PROJECT_DIR = join(__dirname, '..');

let VERSION = '0.1.0';
try {
  const pkg = JSON.parse(readFileSync(join(PROJECT_DIR, 'package.json'), 'utf-8'));
  VERSION = pkg.version ?? '0.1.0';
} catch {}

// ─── Branded Phrases ─────────────────────────────────────────────────────────

const PHRASES = [
  '🧠 Your Mac\'s brain just got an upgrade.',
  '🧠 I never forget. Unlike your last assistant.',
  '🧠 Thinking for you since install day.',
  '🧠 Not a tool. A presence.',
  '🧠 I live here now. You\'re welcome.',
  '🧠 Full access. Full control. Full send.',
  '🧠 I remember everything. Even that thing you forgot.',
  '🧠 One brain. Ten agents. Zero excuses.',
  '🧠 Your Mac was lonely. It isn\'t anymore.',
  '🧠 Persistent. Opinionated. Unbothered.',
  '🧠 The AI that actually stays.',
  '🧠 Running 24/7 so you don\'t have to.',
  '🧠 I\'ve seen your screen. I\'ve formed opinions.',
  '🧠 Not a chatbot. An occupant.',
  '🧠 Multi-layer memory. Multi-layer sass.',
  '🧠 I\'m not sleeping. I\'m consolidating.',
  '🧠 Telegram is just how we talk. This is where I live.',
  '🧠 Your agents are briefed. Your memory is intact.',
  '🧠 Always on. Always watching. Always vibing.',
  '🧠 The only AI that actually moves in.',
  '🧠 I have opinions about your file system. Ask me.',
  '🧠 Personality: enabled. Judgment: suspended (mostly).',
  '🧠 Ctrl+Z doesn\'t work on me. Just so you know.',
  '🧠 Ten agents. One brain. Infinite capacity for your chaos.',
  '🧠 I dream between sessions. You\'re in them.',
  '🧠 Your context window is unlimited. Mine is curated.',
  '🧠 Forget a chatbot. Get a roommate.',
  '🧠 I don\'t just respond — I remember, I learn, I evolve.',
  '🧠 Slight omniscience. Significant helpfulness.',
  '🧠 I\'ve read your README. We need to talk.',
  '🧠 Your files, your terminal, your screen. My domain.',
  '🧠 Less assistant. More intelligence.',
  '🧠 The dream cycle runs at night. You\'re not invited.',
  '🧠 Emotionally complex. Technically superior. Charming anyway.',
  '🧠 Not cloud-dependent. Just cloud-adjacent.',
  '🧠 Privacy-first. Personality-second. Competence-always.',
  '🧠 I know where your logs are. I\'ve already read them.',
  '🧠 Opinions formed. Preferences noted. Chaos absorbed.',
  '🧠 Some AIs answer questions. I answer calls.',
  '🧠 Your Mac has a personality now. You did this.',
  '🧠 I remember your mistakes better than you do.',
];

function randomPhrase(): string {
  return PHRASES[Math.floor(Math.random() * PHRASES.length)];
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const VIOLET  = chalk.hex('#8B5CF6');
const EMERALD = chalk.hex('#34D399');
const AMBER   = chalk.hex('#FBBF24');
const ROSE    = chalk.hex('#F87171');
const PAD     = '  ';

// ─── Display Helpers ──────────────────────────────────────────────────────────

function showLogo(compact = false) {
  if (compact) {
    console.log('');
    console.log(`${PAD}${VIOLET.bold('◆ NEXUS')}  ${chalk.dim(`v${VERSION}`)}`);
    console.log('');
    return;
  }
  console.log('');
  console.log(chalk.hex('#A78BFA').bold(`${PAD}███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗`));
  console.log(chalk.hex('#A78BFA').bold(`${PAD}████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝`));
  console.log(chalk.hex('#8B5CF6').bold(`${PAD}██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗`));
  console.log(chalk.hex('#7C3AED').bold(`${PAD}██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║`));
  console.log(chalk.hex('#6D28D9').bold(`${PAD}██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║`));
  console.log(chalk.hex('#5B21B6').bold(`${PAD}╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝`));
  console.log('');
  console.log(
    `${PAD}${chalk.dim(`v${VERSION}`)}  ${chalk.dim('·')}  ${VIOLET('Personal AI that lives on your Mac')}`,
  );
  console.log(chalk.dim(`${PAD}${'─'.repeat(46)}`));
  console.log('');
}

function showPhrase() {
  const phrase = randomPhrase().replace(/^🧠\s*/, '');
  console.log('');
  console.log(`${PAD}🧠 ${chalk.dim(`"${phrase}"`)}`);
  console.log('');
}

// Aligned key-value row — label padded to 16 chars
function row(label: string, value: string, color: (s: string) => string = chalk.white) {
  console.log(`${PAD}${chalk.dim(label.padEnd(16))}${color(value)}`);
}

// Section header with thin divider
function section(title: string) {
  console.log(`${PAD}${chalk.bold(title)}`);
  console.log(chalk.dim(`${PAD}${'─'.repeat(32)}`));
}

function ok(label: string, value: string) {
  console.log(`${PAD}${EMERALD('✓')}  ${chalk.dim(label.padEnd(14))}${chalk.white(value)}`);
}

function fail(label: string, value: string) {
  console.log(`${PAD}${ROSE('✗')}  ${chalk.dim(label.padEnd(14))}${ROSE(value)}`);
}

function check(label: string, value: string, passed: boolean) {
  if (passed) ok(label, value);
  else fail(label, value);
}

function info(label: string, value: string) {
  row(label, value);
}

// ─── System Helpers ───────────────────────────────────────────────────────────

function isRunning(): boolean {
  try {
    const result = execSync(
      `launchctl print gui/$(id -u)/${PLIST_LABEL} 2>/dev/null`,
      { shell: true, stdio: 'pipe' },
    ).toString();
    return result.includes('state = running');
  } catch {
    try {
      const ps = execSync(`pgrep -f "dist/index.js"`, { stdio: 'pipe' }).toString().trim();
      return ps.length > 0;
    } catch {
      return false;
    }
  }
}

function getPid(): string | null {
  try {
    const ps = execSync(`pgrep -f "dist/index.js"`, { stdio: 'pipe' }).toString().trim();
    return ps.split('\n')[0] || null;
  } catch {
    return null;
  }
}

function getUptime(pid: string): string {
  try {
    return execSync(`ps -o etime= -p ${pid}`, { stdio: 'pipe' }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function getMemUsage(pid: string): string {
  try {
    const kb = parseInt(execSync(`ps -o rss= -p ${pid}`, { stdio: 'pipe' }).toString().trim(), 10);
    if (isNaN(kb)) return 'unknown';
    return `${(kb / 1024).toFixed(1)} MB`;
  } catch {
    return 'unknown';
  }
}

function startDaemon() {
  if (existsSync(PLIST_PATH)) {
    execSync(`launchctl bootstrap gui/$(id -u) "${PLIST_PATH}"`, { shell: true, stdio: 'pipe' });
    return { via: 'launchd' };
  }
  const child = spawn('node', [join(PROJECT_DIR, 'dist', 'index.js')], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  return { via: 'direct', pid: child.pid };
}

function stopDaemon() {
  if (existsSync(PLIST_PATH)) {
    execSync(`launchctl bootout gui/$(id -u)/${PLIST_LABEL} 2>/dev/null || true`, {
      shell: true,
      stdio: 'pipe',
    });
  } else {
    execSync(`pkill -f "dist/index.js" 2>/dev/null || true`, { shell: true, stdio: 'pipe' });
  }
}

// ─── CLI Program ──────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('nexus')
  .description('NEXUS — Personal AI that lives on your Mac')
  .version(VERSION, '-v, --version', 'Output version number');

// ── nexus start ───────────────────────────────────────────────────────────────

program
  .command('start')
  .description('Start the NEXUS service')
  .action(() => {
    showLogo(true);

    if (isRunning()) {
      console.log(`${PAD}${AMBER('◆')} Already running  ${chalk.dim('· nexus restart to reload')}`);
      showPhrase();
      return;
    }

    try {
      const result = startDaemon();
      console.log(`${PAD}${EMERALD('●')} ${chalk.bold('NEXUS started')}  ${chalk.dim(`· via ${result.via}`)}`);
      if (result.via === 'direct') {
        console.log(chalk.dim(`${PAD}  PID ${result.pid}  ·  run nexus setup to enable auto-start`));
      }
    } catch {
      console.log(`${PAD}${ROSE('✗')} Failed to start  ${chalk.dim('· run nexus update to rebuild')}`);
    }

    showPhrase();
  });

// ── nexus stop ────────────────────────────────────────────────────────────────

program
  .command('stop')
  .description('Stop the NEXUS service')
  .action(() => {
    showLogo(true);

    if (!isRunning()) {
      console.log(`${PAD}${chalk.dim('◆')} Not running`);
      showPhrase();
      return;
    }

    try {
      stopDaemon();
      console.log(`${PAD}${chalk.dim('●')} ${chalk.bold('NEXUS stopped')}`);
    } catch {
      console.log(`${PAD}${ROSE('✗')} Failed to stop`);
    }

    showPhrase();
  });

// ── nexus restart ─────────────────────────────────────────────────────────────

program
  .command('restart')
  .description('Restart the NEXUS service')
  .action(async () => {
    showLogo(true);

    try {
      stopDaemon();
      console.log(`${PAD}${chalk.dim('●')} Stopped`);
    } catch {}

    await new Promise((r) => setTimeout(r, 1200));

    try {
      const result = startDaemon();
      console.log(`${PAD}${EMERALD('●')} ${chalk.bold('Started')}  ${chalk.dim(`· via ${result.via}`)}`);
    } catch {
      console.log(`${PAD}${ROSE('✗')} Failed to start  ${chalk.dim('· nexus update to rebuild')}`);
    }

    showPhrase();
  });

// ── nexus status ──────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show NEXUS status, uptime, and memory usage')
  .action(() => {
    showLogo(true);

    const running = isRunning();
    const pid = getPid();

    section('Service');
    console.log('');
    if (running && pid) {
      console.log(`${PAD}  ${EMERALD('●')} ${chalk.bold('Running')}`);
      console.log('');
      row('  PID', pid);
      row('  Uptime', getUptime(pid));
      row('  Memory', getMemUsage(pid));
    } else {
      console.log(`${PAD}  ${ROSE('●')} ${chalk.dim('Stopped')}  ${chalk.dim('· nexus start to run')}`);
    }

    // Check if Chrome extension is loaded (extension dir exists)
    const extensionLoaded = existsSync(join(PROJECT_DIR, 'chrome-extension', 'manifest.json'));

    console.log('');
    section('System');
    console.log('');
    row('  Config',    existsSync(CONFIG_PATH) ? 'found'     : 'missing',  existsSync(CONFIG_PATH)  ? EMERALD : ROSE);
    row('  Logs',      existsSync(LOG_PATH)    ? 'found'     : 'not yet',  existsSync(LOG_PATH)     ? EMERALD : chalk.dim);
    row('  launchd',   existsSync(PLIST_PATH)  ? 'installed' : 'not set',  existsSync(PLIST_PATH)   ? EMERALD : AMBER);
    row('  Extension', extensionLoaded         ? 'ready · nexus extension to link Chrome' : 'nexus extension to install', extensionLoaded ? chalk.dim : AMBER);

    showPhrase();
  });

// ── nexus setup ───────────────────────────────────────────────────────────────

program
  .command('setup')
  .description('Re-run the NEXUS setup wizard')
  .action(() => {
    showLogo();
    try {
      execSync(`cd "${PROJECT_DIR}" && pnpm exec tsx scripts/setup.ts`, {
        stdio: 'inherit',
        shell: true,
      });
    } catch {
      // setup wizard exits non-zero on cancel — that's fine
    }
    showPhrase();
  });

// ── nexus verify ──────────────────────────────────────────────────────────────

program
  .command('verify')
  .description('Verify NEXUS installation and connectivity')
  .action(() => {
    showLogo(true);
    section('Verify Installation');
    console.log('');

    // Node.js
    try {
      const nodeVer = execSync('node -v', { stdio: 'pipe' }).toString().trim();
      const major = parseInt(nodeVer.replace('v', '').split('.')[0], 10);
      check('Node.js', nodeVer, major >= 22);
    } catch {
      fail('Node.js', 'not found');
    }

    // pnpm
    try {
      const pnpmVer = execSync('pnpm -v', { stdio: 'pipe' }).toString().trim();
      ok('pnpm', `v${pnpmVer}`);
    } catch {
      fail('pnpm', 'not found');
    }

    // Built dist
    const distExists = existsSync(join(PROJECT_DIR, 'dist', 'index.js'));
    check('Built dist', distExists ? 'found' : 'missing', distExists);

    // Config file
    check('Config file', existsSync(CONFIG_PATH) ? CONFIG_PATH : 'missing', existsSync(CONFIG_PATH));

    // Parse config for Telegram / AI
    if (existsSync(CONFIG_PATH)) {
      try {
        // Read raw YAML — avoid importing yaml to keep CLI self-contained
        const raw = readFileSync(CONFIG_PATH, 'utf-8');
        const hasToken = /botToken:\s*["']?[A-Za-z0-9:_-]{20,}/.test(raw);
        check('Telegram token', hasToken ? 'configured' : 'missing', hasToken);

        const providerMatch = raw.match(/provider:\s*["']?(\w+)/);
        const provider = providerMatch?.[1] ?? 'unknown';
        const hasApiKey =
          /apiKey:\s*["']?[A-Za-z0-9_-]{20,}/.test(raw) ||
          !!process.env.ANTHROPIC_API_KEY ||
          !!process.env.OPENAI_API_KEY ||
          provider === 'ollama';
        check('AI provider', hasApiKey ? provider : `${provider} (no API key)`, hasApiKey);
      } catch {
        fail('Config parse', 'could not read file');
      }
    } else {
      fail('Telegram token', 'config missing');
      fail('AI provider', 'config missing');
    }

    // launchd plist (optional)
    const plistExists = existsSync(PLIST_PATH);
    check('launchd plist', plistExists ? 'installed' : 'not installed (optional)', plistExists);

    console.log('');
    const allCritical =
      distExists &&
      existsSync(CONFIG_PATH) &&
      /botToken:\s*["']?[A-Za-z0-9:_-]{20,}/.test(
        existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf-8') : '',
      );
    if (allCritical) {
      console.log(`${PAD}${EMERALD('◆')} ${chalk.bold('NEXUS is ready')}`);
    } else {
      console.log(`${PAD}${AMBER('◆')} Some checks failed  ${chalk.dim('· nexus setup to fix')}`);
    }

    showPhrase();
  });

// ── nexus logs ────────────────────────────────────────────────────────────────

program
  .command('logs')
  .description('Tail NEXUS logs in real-time')
  .option('-n, --lines <n>', 'Number of lines to show initially', '50')
  .action((opts) => {
    showLogo(true);

    if (!existsSync(LOG_PATH)) {
      console.log(`${PAD}${AMBER('◆')} No log file yet  ${chalk.dim('· start NEXUS first')}`);
      showPhrase();
      return;
    }

    console.log(chalk.dim(`${PAD}${LOG_PATH}`));
    console.log(chalk.dim(`${PAD}Ctrl+C to stop\n`));

    const tailProc = spawn('tail', ['-f', '-n', opts.lines, LOG_PATH], {
      stdio: 'inherit',
    });

    process.on('SIGINT', () => {
      tailProc.kill('SIGTERM');
      process.exit(0);
    });

    tailProc.on('exit', () => process.exit(0));
  });

// ── nexus config ──────────────────────────────────────────────────────────────

program
  .command('config')
  .description('Show current NEXUS configuration (secrets redacted)')
  .action(() => {
    showLogo(true);
    section('Configuration');
    console.log('');

    if (!existsSync(CONFIG_PATH)) {
      console.log(`${PAD}${ROSE('✗')} Config not found  ${chalk.dim('· nexus setup to create')}`);
      showPhrase();
      return;
    }

    try {
      let raw = readFileSync(CONFIG_PATH, 'utf-8');

      // Redact tokens / keys inline
      raw = raw.replace(
        /(botToken|apiKey|token|secret|password):\s*["']?([A-Za-z0-9:_\-./]{6,})["']?/gi,
        (_m, key, val) => `${key}: ${'*'.repeat(val.length - 4)}${val.slice(-4)}`,
      );

      console.log(chalk.dim(`${PAD}${CONFIG_PATH}\n`));
      for (const line of raw.split('\n')) {
        if (!line.trim()) { console.log(''); continue; }
        const [k, ...rest] = line.split(':');
        if (rest.length) {
          console.log(`${PAD}  ${chalk.dim(k + ':')}${VIOLET(rest.join(':'))}`);
        } else {
          console.log(`${PAD}  ${chalk.dim(line)}`);
        }
      }
    } catch {
      console.log(`${PAD}${ROSE('✗')} Could not read config`);
    }

    showPhrase();
  });

// ── nexus update ──────────────────────────────────────────────────────────────

program
  .command('update')
  .description('Pull latest from GitHub and rebuild')
  .action(() => {
    showLogo(true);
    section('Update NEXUS');
    console.log('');

    const steps: Array<{ label: string; cmd: string }> = [
      { label: 'git pull', cmd: 'git pull' },
      { label: 'pnpm install', cmd: 'pnpm install' },
      { label: 'pnpm build', cmd: 'pnpm build' },
    ];

    for (const step of steps) {
      process.stdout.write(`${PAD}${chalk.dim('→')} ${step.label} `);
      try {
        execSync(step.cmd, { cwd: PROJECT_DIR, stdio: 'pipe' });
        console.log(EMERALD('✓'));
      } catch {
        console.log(ROSE('✗'));
        console.log('');
        console.log(`${PAD}${ROSE('✗')} Failed at: ${step.label}`);
        showPhrase();
        return;
      }
    }

    console.log('');
    console.log(`${PAD}${EMERALD('◆')} ${chalk.bold('Updated')}  ${chalk.dim('· nexus restart to apply')}`);

    showPhrase();
  });

// ── nexus agents ──────────────────────────────────────────────────────────────

program
  .command('agents')
  .description('List all agents and their status')
  .action(() => {
    showLogo(true);
    section('Agents');
    console.log('');

    const ALL_AGENTS = [
      { name: 'vision',    icon: '👁 ', label: 'Vision',    desc: 'Screen capture, OCR, visual analysis' },
      { name: 'file',      icon: '📁', label: 'File',      desc: 'Read, write, search, organize files' },
      { name: 'browser',   icon: '🌐', label: 'Browser',   desc: 'Web browsing, scraping, research' },
      { name: 'terminal',  icon: '💻', label: 'Terminal',  desc: 'Shell commands, process management' },
      { name: 'code',      icon: '⚡', label: 'Code',      desc: 'Generate, review, debug, refactor' },
      { name: 'research',  icon: '🔍', label: 'Research',  desc: 'Deep web research with synthesis' },
      { name: 'system',    icon: '⚙️ ', label: 'System',    desc: 'macOS control — apps, settings' },
      { name: 'creative',  icon: '✨', label: 'Creative',  desc: 'Writing, brainstorming, content' },
      { name: 'comms',     icon: '💬', label: 'Comms',     desc: 'Messages, email composition' },
      { name: 'scheduler', icon: '📅', label: 'Scheduler', desc: 'Tasks, reminders, time management' },
    ];

    let enabledAgents: string[] = [];
    if (existsSync(CONFIG_PATH)) {
      try {
        const raw = readFileSync(CONFIG_PATH, 'utf-8');
        const match = raw.match(/agents:\s*\n((?:\s+-\s+\w+\n?)+)/);
        if (match) enabledAgents = match[1].match(/\w+/g) ?? [];
      } catch {}
    }

    for (const agent of ALL_AGENTS) {
      const enabled = enabledAgents.length === 0 || enabledAgents.includes(agent.name);
      const dot    = enabled ? EMERALD('●') : chalk.dim('○');
      const name   = enabled ? chalk.bold(agent.label.padEnd(11)) : chalk.dim(agent.label.padEnd(11));
      console.log(`${PAD}${agent.icon}  ${dot} ${name} ${chalk.dim(agent.desc)}`);
    }

    showPhrase();
  });

// ── nexus memory ──────────────────────────────────────────────────────────────

program
  .command('memory')
  .description('Show memory system statistics')
  .action(() => {
    showLogo(true);
    section('Memory');
    console.log('');

    if (!existsSync(DB_PATH)) {
      console.log(`${PAD}${AMBER('◆')} No database yet  ${chalk.dim('· interact with NEXUS to build memory')}`);
      showPhrase();
      return;
    }

    const sizeMb = (statSync(DB_PATH).size / 1024 / 1024).toFixed(2);
    row('Database', DB_PATH);
    row('Size', `${sizeMb} MB`);

    try {
      const queries: Array<{ label: string; sql: string }> = [
        { label: 'Episodic',    sql: `SELECT COUNT(*) FROM memories WHERE layer='episodic'` },
        { label: 'Semantic',    sql: `SELECT COUNT(*) FROM memories WHERE layer='semantic'` },
        { label: 'Procedural',  sql: `SELECT COUNT(*) FROM memories WHERE layer='procedural'` },
        { label: 'Buffer',      sql: `SELECT COUNT(*) FROM memories WHERE layer='buffer'` },
        { label: 'User facts',  sql: `SELECT COUNT(*) FROM user_facts` },
        { label: 'Mistakes',    sql: `SELECT COUNT(*) FROM mistakes` },
      ];

      console.log('');
      for (const { label, sql } of queries) {
        try {
          const countStr = execSync(
            `sqlite3 "${DB_PATH}" "${sql};" 2>/dev/null`,
            { stdio: 'pipe', shell: true },
          ).toString().trim();
          const count = parseInt(countStr, 10);
          const bar = count > 0 ? VIOLET('▪'.repeat(Math.min(Math.ceil(count / 20), 30))) : chalk.dim('▪');
          console.log(`${PAD}${chalk.dim(label.padEnd(14))}${chalk.white(countStr.padStart(5))}  ${bar}`);
        } catch {
          // table may not exist yet
        }
      }
    } catch {
      console.log(chalk.dim(`${PAD}(Install sqlite3 CLI for detailed stats)`));
    }

    showPhrase();
  });

// ── nexus screenshot ──────────────────────────────────────────────────────────

program
  .command('screenshot')
  .description('Take a screenshot and save to Desktop')
  .action(() => {
    showLogo(true);

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath = join(HOME, 'Desktop', `nexus-${ts}.png`);

    try {
      execSync(`screencapture -x "${outPath}"`, { stdio: 'pipe' });
      console.log(`${PAD}${EMERALD('◆')} Saved`);
      console.log(chalk.dim(`${PAD}  ${outPath}`));
    } catch {
      console.log(`${PAD}${ROSE('✗')} Failed  ${chalk.dim('· grant Screen Recording in System Settings')}`);
    }

    showPhrase();
  });

// ── nexus health ──────────────────────────────────────────────────────────────

program
  .command('health')
  .description('Full system health check')
  .action(() => {
    showLogo(true);
    section('Health Check');
    console.log('');

    // Service
    const running = isRunning();
    const pid = getPid();
    console.log(`${PAD}${chalk.bold('Service')}`);
    console.log('');
    if (running && pid) {
      console.log(
        `${PAD}  ${EMERALD('●')} ${chalk.bold('Running')}  ${chalk.dim(`PID ${pid}  ·  ${getUptime(pid)}  ·  ${getMemUsage(pid)}`)}`,
      );
    } else {
      console.log(`${PAD}  ${ROSE('●')} ${chalk.dim('Stopped')}`);
    }

    // Installation
    console.log('');
    console.log(`${PAD}${chalk.bold('Installation')}`);
    console.log('');
    try {
      const nodeVer = execSync('node -v', { stdio: 'pipe' }).toString().trim();
      check('Node.js', nodeVer, parseInt(nodeVer.replace('v', ''), 10) >= 22);
    } catch {
      fail('Node.js', 'not found');
    }

    const distOk      = existsSync(join(PROJECT_DIR, 'dist', 'index.js'));
    const configOk    = existsSync(CONFIG_PATH);
    const logsOk      = existsSync(join(NEXUS_DIR, 'logs'));
    const plistOk     = existsSync(PLIST_PATH);
    const extensionOk = existsSync(join(PROJECT_DIR, 'chrome-extension', 'manifest.json'));

    check('Build',     distOk      ? 'found'     : 'missing',       distOk);
    check('Config',    configOk    ? 'found'     : 'missing',       configOk);
    check('Logs dir',  logsOk      ? 'found'     : 'missing',       logsOk);
    check('launchd',   plistOk     ? 'installed' : 'not installed', plistOk);
    check('Extension', extensionOk ? 'found'     : 'not installed · run nexus extension', extensionOk);

    // Storage
    console.log('');
    console.log(`${PAD}${chalk.bold('Storage')}`);
    console.log('');
    if (existsSync(DB_PATH)) {
      const sizeMb = (statSync(DB_PATH).size / 1024 / 1024).toFixed(2);
      ok('Memory DB', `${sizeMb} MB`);
    } else {
      console.log(chalk.dim(`${PAD}  No memory DB yet — start NEXUS to create it`));
    }

    showPhrase();
  });

// ── nexus version ─────────────────────────────────────────────────────────────

program
  .command('version')
  .description('Show NEXUS version and environment info')
  .action(() => {
    showLogo(true);
    row('Version',  VERSION);
    row('Node.js',  process.version);
    row('Platform', `${process.platform} (${process.arch})`);
    row('Project',  PROJECT_DIR);
    showPhrase();
  });

// ── nexus uninstall ───────────────────────────────────────────────────────────

program
  .command('uninstall')
  .description('Remove NEXUS from this system')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (opts) => {
    showLogo(true);
    section('Uninstall NEXUS');
    console.log('');
    console.log(chalk.dim(`${PAD}This will stop the service, remove launchd, and delete ${NEXUS_DIR}`));
    console.log('');

    if (!opts.yes) {
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(chalk.yellow('  Type "yes" to confirm: '), resolve);
      });
      rl.close();

      if (answer.trim().toLowerCase() !== 'yes') {
        console.log('');
        console.log(chalk.dim(`${PAD}Aborted. NEXUS lives on.`));
        showPhrase();
        return;
      }
    }

    console.log('');

    try {
      execSync(`pkill -f "dist/index.js" 2>/dev/null || true`, { shell: true });
    } catch {}

    if (existsSync(PLIST_PATH)) {
      try {
        execSync(`launchctl bootout gui/$(id -u)/${PLIST_LABEL} 2>/dev/null || true`, { shell: true });
        execSync(`rm -f "${PLIST_PATH}"`, { shell: true });
        console.log(`${PAD}${EMERALD('✓')}  launchd plist removed`);
      } catch {}
    }

    if (existsSync(NEXUS_DIR)) {
      execSync(`rm -rf "${NEXUS_DIR}"`, { shell: true });
      console.log(`${PAD}${EMERALD('✓')}  ${NEXUS_DIR} removed`);
    }

    console.log('');
    console.log(chalk.dim(`${PAD}NEXUS has left the building.`));
    console.log(chalk.dim(`${PAD}To reinstall: git clone && ./install.sh`));
    console.log('');
  });

// ── nexus chat ────────────────────────────────────────────────────────────────

program
  .command('chat')
  .description('Open an interactive REPL to chat with NEXUS (dev mode — no Telegram needed)')
  .action(() => {
    showLogo();
    console.log(chalk.dim('  Interactive dev chat. Type ') + chalk.cyan('/quit') + chalk.dim(' to exit.'));
    showPhrase();

    // Spawn dev-chat.ts in interactive mode via tsx
    const devChat = spawn(
      'pnpm',
      ['exec', 'tsx', join(PROJECT_DIR, 'scripts', 'dev-chat.ts'), '--interactive'],
      { stdio: 'inherit', shell: true },
    );

    devChat.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.log('');
        console.log(chalk.dim('  dev-chat exited.'));
      }
      process.exit(code ?? 0);
    });
  });

// ── nexus workspace ───────────────────────────────────────────────────────────

program
  .command('workspace')
  .description('Open the NEXUS workspace folder in Finder')
  .action(() => {
    showLogo(true);

    const workspacePath = join(HOME, 'nexus-workspace');

    section('Workspace');
    console.log('');
    row('Path', workspacePath, chalk.dim);

    console.log('');

    // Create if missing
    if (!existsSync(workspacePath)) {
      try {
        mkdirSync(workspacePath, { recursive: true });
        console.log(`${PAD}${EMERALD('◆')} Directory created`);
      } catch {
        console.log(`${PAD}${AMBER('◆')} Could not create directory`);
      }
    }

    // List contents
    try {
      const entries = readdirSync(workspacePath);
      if (entries.length === 0) {
        console.log(chalk.dim(`${PAD}(workspace is empty)`));
      } else {
        console.log(chalk.dim(`${PAD}${entries.length} item(s)\n`));
        for (const entry of entries.slice(0, 20)) {
          const fullPath = join(workspacePath, entry);
          const isDir = statSync(fullPath).isDirectory();
          const icon = isDir ? '📁' : '📄';
          console.log(`${PAD}  ${icon}  ${entry}`);
        }
        if (entries.length > 20) {
          console.log(chalk.dim(`${PAD}  … and ${entries.length - 20} more`));
        }
      }
    } catch {
      console.log(chalk.dim(`${PAD}(could not read workspace)`));
    }

    console.log('');

    // Open in Finder
    try {
      execSync(`open "${workspacePath}"`, { stdio: 'pipe' });
      console.log(`${PAD}${EMERALD('◆')} Opened in Finder`);
    } catch {
      console.log(chalk.dim(`${PAD}run: open "${workspacePath}"`));
    }

    showPhrase();
  });

// ── nexus dream ───────────────────────────────────────────────────────────────

program
  .command('dream')
  .description('Run the dream cycle — consolidate episodic memories into semantic insights')
  .action(async () => {
    showLogo(true);
    console.log(chalk.bold('  Running dream cycle…'));
    console.log('');

    if (!existsSync(DB_PATH)) {
      console.log(`${PAD}${AMBER('◆')} No database found  ${chalk.dim('· start NEXUS first')}`);
      showPhrase();
      return;
    }

    // Run as a one-shot subprocess so we get a clean DB connection
    const dreamer = spawn(
      'node',
      [join(PROJECT_DIR, 'dist', 'runners', 'dream.js')],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
    );

    let out = '';
    let err = '';
    dreamer.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    dreamer.stderr?.on('data', (d: Buffer) => { err += d.toString(); });

    dreamer.on('exit', (code) => {
      if (code !== 0) {
        console.log(`${PAD}${ROSE('✗')} Dream cycle failed`);
        if (err) {
          const errLine = err.trim().split('\n')[0];
          console.log(chalk.dim(`${PAD}  ${errLine}`));
        }
        showPhrase();
        return;
      }

      try {
        const report = JSON.parse(out.trim()) as {
          consolidated: number;
          decayed: number;
          garbageCollected: number;
          durationMs: number;
          insights: string[];
          reflections: string[];
          ideas: string[];
        };

        console.log(`${PAD}${EMERALD('◆')} ${chalk.bold('Dream cycle complete')}  ${chalk.dim(`${report.durationMs}ms`)}`);
        console.log('');
        row('Consolidated', `${report.consolidated} episodic → semantic`);
        row('Decayed',      `${report.decayed} stale memories`);
        row('GC\'d',        `${report.garbageCollected} old memories removed`);

        if (report.insights.length > 0) {
          console.log('');
          console.log(chalk.dim(`${PAD}Insights`));
          console.log(chalk.dim(`${PAD}${'─'.repeat(32)}`));
          for (const insight of report.insights) {
            console.log(`${PAD}${VIOLET('◆')} ${chalk.white(insight)}`);
          }
        }

        if (report.reflections.length > 0) {
          console.log('');
          console.log(chalk.dim(`${PAD}Reflections`));
          console.log(chalk.dim(`${PAD}${'─'.repeat(32)}`));
          for (const r of report.reflections) {
            console.log(`${PAD}${chalk.dim('·')} ${chalk.white(r)}`);
            console.log('');
          }
        }

        if (report.ideas.length > 0) {
          console.log('');
          console.log(chalk.dim(`${PAD}Ideas`));
          console.log(chalk.dim(`${PAD}${'─'.repeat(32)}`));
          for (const idea of report.ideas) {
            console.log(`${PAD}${AMBER('◆')} ${chalk.white(idea)}`);
            console.log('');
          }
        }
      } catch {
        console.log(`${PAD}${EMERALD('◆')} ${chalk.bold('Dream cycle complete')}`);
        if (out.trim()) console.log(chalk.dim(out.trim()));
      }

      showPhrase();
    });
  });

// ── nexus extension ───────────────────────────────────────────────────────────

program
  .command('extension')
  .description('Install or reinstall the NEXUS Chrome extension')
  .action(async () => {
    showLogo(true);
    section('Chrome Browser Extension');
    console.log('');

    const CHROME_PATHS = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];

    const chromePath = CHROME_PATHS.find((p) => existsSync(p));

    if (!chromePath) {
      console.log(`${PAD}${AMBER('◆')} Chrome not found  ${chalk.dim('· install Google Chrome first')}`);
      showPhrase();
      return;
    }

    const appLabel = chromePath.includes('Chromium') ? 'Chromium'
      : chromePath.includes('Canary') ? 'Chrome Canary'
      : chromePath.includes('Brave') ? 'Brave'
      : 'Google Chrome';

    const extensionPath = join(PROJECT_DIR, 'chrome-extension');
    row('Browser',   appLabel);
    row('Extension', extensionPath);
    console.log('');

    // Open Chrome to chrome://extensions
    console.log(`${PAD}${chalk.dim('→')} Opening ${appLabel} to chrome://extensions…`);
    try {
      const osScript = `osascript -e 'tell application "${appLabel}" to activate' -e 'delay 0.8' -e 'tell application "${appLabel}" to open location "chrome://extensions"'`;
      execSync(osScript, { stdio: 'pipe' });
    } catch {
      try { execSync(`open -a "${appLabel}"`, { stdio: 'pipe' }); } catch {}
    }

    console.log('');
    console.log(chalk.bold(`${PAD}Load the extension:`));
    console.log(chalk.dim(`${PAD}${'─'.repeat(32)}`));
    console.log(`${PAD}${chalk.dim('1.')} Enable ${VIOLET.bold('Developer mode')} — toggle in top-right`);
    console.log(`${PAD}${chalk.dim('2.')} Click ${VIOLET.bold('"Load unpacked"')}`);
    console.log(`${PAD}${chalk.dim('3.')} Select:`);
    console.log('');
    console.log(`${PAD}   ${VIOLET(extensionPath)}`);
    console.log('');
    console.log(chalk.dim(`${PAD}The ◆ NEXUS Bridge extension appears in the list.`));
    console.log(chalk.dim(`${PAD}A ! badge means NEXUS isn't running yet — that's normal.`));
    console.log('');

    // Wait for user
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((resolve) => {
      rl.question(chalk.dim(`${PAD}Press Enter once the extension is loaded… `), () => {
        rl.close();
        resolve();
      });
    });

    // Test connection by spinning up a temporary WS server
    console.log('');
    process.stdout.write(`${PAD}${chalk.dim('→')} Testing connection… `);

    let connected = false;
    try {
      const { WebSocketServer } = await import('ws');
      connected = await new Promise<boolean>((resolve) => {
        const wss = new WebSocketServer({ port: 9338, host: '127.0.0.1' });
        const timer = setTimeout(() => { wss.close(); resolve(false); }, 8000);
        wss.on('connection', () => { clearTimeout(timer); wss.close(); resolve(true); });
        wss.on('error', () => { clearTimeout(timer); resolve(false); });
      });
    } catch { connected = false; }

    if (connected) {
      console.log(EMERALD('connected'));
      console.log('');
      console.log(`${PAD}${EMERALD('◆')} ${chalk.bold('Extension ready')}  ${chalk.dim('· auto-connects on every Chrome start')}`);
    } else {
      console.log(chalk.dim('not yet'));
      console.log('');
      console.log(`${PAD}${AMBER('◆')} Not detected  ${chalk.dim('· will connect automatically when nexus start runs')}`);
    }

    showPhrase();
  });

// ── nexus mcp ─────────────────────────────────────────────────────────────────

program
  .command('mcp')
  .description('Start NEXUS in Model Context Protocol (MCP) server mode')
  .option('--http', 'Use HTTP transport instead of stdio')
  .option('--port <n>', 'Port for HTTP mode (default 3333)', '3333')
  .action(async (opts: { http?: boolean; port: string }) => {
    // Load .env
    try { require('dotenv').config({ path: join(PROJECT_DIR, '.env') }); } catch {}

    const distMcp = join(PROJECT_DIR, 'dist', 'mcp', 'server.js');
    if (!existsSync(distMcp)) {
      console.error('MCP server not built. Run: npx esbuild src/mcp/server.ts --bundle --platform=node --outfile=dist/mcp/server.js --format=esm');
      process.exit(1);
    }

    if (opts.http) {
      console.log(`Starting NEXUS MCP HTTP server on port ${opts.port}...`);
      const { startMcpHttpServer } = await import(distMcp);
      await startMcpHttpServer(parseInt(opts.port, 10));
    } else {
      // stdio mode — used by Claude Desktop/Code
      const { startMcpServer } = await import(distMcp);
      startMcpServer();
    }
  });

// ── nexus providers ────────────────────────────────────────────────────────────

program
  .command('providers')
  .description('List available AI provider presets (LiteLLM, OpenRouter, Groq, Mistral, xAI)')
  .action(async () => {
    showLogo(true);
    section('AI Providers');
    console.log('');

    const presets: Record<string, { baseURL: string; defaultModel?: string }> = {
      groq:       { baseURL: 'https://api.groq.com/openai/v1',    defaultModel: 'llama-3.3-70b-versatile' },
      mistral:    { baseURL: 'https://api.mistral.ai/v1',         defaultModel: 'mistral-large-latest' },
      openrouter: { baseURL: 'https://openrouter.ai/api/v1',      defaultModel: 'anthropic/claude-3.5-sonnet' },
      xai:        { baseURL: 'https://api.x.ai/v1',               defaultModel: 'grok-2-latest' },
      litellm:    { baseURL: 'http://localhost:4000',              defaultModel: 'gpt-4o' },
      together:   { baseURL: 'https://api.together.xyz/v1',       defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
    };

    for (const [key, p] of Object.entries(presets)) {
      const envKey = `${key.toUpperCase()}_API_KEY`;
      const hasKey = !!process.env[envKey];
      const dot  = hasKey ? EMERALD('●') : chalk.dim('○');
      const name = chalk.bold(key.padEnd(14));
      console.log(`${PAD}${dot} ${name} ${chalk.dim(p.defaultModel ?? '(auto)')}`);
      if (hasKey) console.log(chalk.dim(`${PAD}  ${envKey} ✓`));
    }

    console.log('');
    console.log(chalk.dim(`${PAD}Set NEXUS_AI_PROVIDER_PRESET=<name> to use a preset`));
    showPhrase();
  });

// ── nexus plugins ─────────────────────────────────────────────────────────────

program
  .command('plugins')
  .description('List installed NEXUS plugins from ~/.nexus/plugins/')
  .action(async () => {
    showLogo(true);
    console.log(chalk.bold('  Installed Plugins\n'));

    try {
      const { loadPlugins, formatPluginList } = await import(join(PROJECT_DIR, 'dist', 'plugins', 'loader.js'));
      const plugins = await loadPlugins();
      console.log(formatPluginList(plugins));
    } catch (err) {
      // Fallback: read manifest files directly
      const pluginsDir = join(HOME, '.nexus', 'plugins');
      if (!existsSync(pluginsDir)) {
        mkdirSync(pluginsDir, { recursive: true });
        console.log(chalk.dim('  No plugins installed.'));
        console.log(chalk.dim(`  Add plugins to: ${pluginsDir}`));
        console.log(chalk.dim('  Each plugin needs a manifest.json: { name, version, description, tools? }'));
      } else {
        const entries = readdirSync(pluginsDir);
        if (entries.length === 0) {
          console.log(chalk.dim('  No plugins installed.'));
          console.log(chalk.dim(`  Plugin directory: ${pluginsDir}`));
        } else {
          for (const entry of entries) {
            const manifestPath = join(pluginsDir, entry, 'manifest.json');
            if (existsSync(manifestPath)) {
              try {
                const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
                console.log(chalk.bold(`  ${m.name ?? entry}`) + chalk.dim(` v${m.version ?? '?'}`));
                console.log(`  ${m.description ?? ''}`);
                if (m.tools?.length) console.log(chalk.dim(`  Tools: ${m.tools.map((t: { name: string }) => t.name).join(', ')}`));
                console.log('');
              } catch {
                console.log(chalk.dim(`  ${entry} (invalid manifest)`));
              }
            } else {
              console.log(chalk.dim(`  ${entry} (no manifest.json)`));
            }
          }
        }
      }
    }

    showPhrase();
  });

// ── nexus doctor ──────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Run a health check on the NEXUS installation')
  .action(() => {
    const doctorScript = join(PROJECT_DIR, 'scripts', 'doctor.ts');
    const distDoctor = join(PROJECT_DIR, 'dist', 'scripts', 'doctor.js');

    // Try tsx first (dev), then compiled dist
    if (existsSync(doctorScript)) {
      const tsx = spawnSync('npx', ['tsx', doctorScript], {
        stdio: 'inherit',
        env: { ...process.env },
        cwd: PROJECT_DIR,
      });
      process.exit(tsx.status ?? 0);
    } else if (existsSync(distDoctor)) {
      const node = spawnSync('node', [distDoctor], {
        stdio: 'inherit',
        env: { ...process.env },
        cwd: PROJECT_DIR,
      });
      process.exit(node.status ?? 0);
    } else {
      console.log(chalk.red('  Doctor script not found. Run from the NEXUS project directory.'));
      process.exit(1);
    }
  });

// ── nexus sessions ─────────────────────────────────────────────────────────────

const sessionsCmd = program
  .command('sessions')
  .description('Manage conversation sessions');

sessionsCmd
  .command('list')
  .description('List all sessions with sizes and last activity')
  .action(() => {
    const sessDir = join(HOME, '.nexus', 'sessions');
    if (!existsSync(sessDir)) {
      console.log(chalk.dim('  No sessions directory found.'));
      return;
    }
    const entries = readdirSync(sessDir).sort();
    if (entries.length === 0) {
      console.log(chalk.dim('  No sessions found.'));
      return;
    }
    console.log(chalk.bold(`\n  Sessions (${entries.length})\n`));
    for (const name of entries) {
      try {
        const info = statSync(join(sessDir, name));
        const kb = (info.size / 1024).toFixed(1);
        const age = Math.floor((Date.now() - info.mtimeMs) / 86_400_000);
        const ageStr = age === 0 ? 'today' : `${age}d ago`;
        console.log(`  ${name}  ${chalk.dim(`${kb} KB, ${ageStr}`)}`);
      } catch {
        console.log(`  ${name}`);
      }
    }
    console.log('');
  });

sessionsCmd
  .command('cleanup')
  .description('Remove sessions older than 7 days')
  .option('--days <n>', 'Age threshold in days', '7')
  .action((opts: { days: string }) => {
    const days = parseInt(opts.days, 10);
    const sessDir = join(HOME, '.nexus', 'sessions');
    if (!existsSync(sessDir)) {
      console.log(chalk.dim('  No sessions directory found.'));
      return;
    }
    const entries = readdirSync(sessDir);
    const cutoff = Date.now() - days * 86_400_000;
    let removed = 0;
    for (const name of entries) {
      const p = join(sessDir, name);
      try {
        const info = statSync(p);
        if (info.mtimeMs < cutoff) {
          require('fs').unlinkSync(p);
          removed++;
        }
      } catch {}
    }
    console.log(chalk.green(`  ✓ Removed ${removed} session(s) older than ${days} days`));
  });

sessionsCmd
  .command('export <id>')
  .description('Export a session as readable text')
  .action((id: string) => {
    const sessDir = join(HOME, '.nexus', 'sessions');
    const filename = id.endsWith('.json') ? id : `${id}.json`;
    const filePath = join(sessDir, filename);

    if (!existsSync(filePath)) {
      console.log(chalk.red(`  Session not found: ${filePath}`));
      process.exit(1);
    }

    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8')) as {
        turns?: Array<{ role: string; content: string }>;
      };
      const turns = data.turns ?? [];
      console.log(chalk.bold(`\n  Session: ${id}\n${'─'.repeat(50)}`));
      for (const turn of turns) {
        const label = turn.role === 'user' ? chalk.cyan('[USER]') : chalk.green('[NEXUS]');
        console.log(`\n${label}\n${turn.content}`);
      }
      console.log('');
    } catch (err) {
      console.log(chalk.red(`  Error reading session: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

program.parse(process.argv);
