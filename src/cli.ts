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
const DB_PATH = join(NEXUS_DIR, 'nexus.db');
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

// ─── Display Helpers ──────────────────────────────────────────────────────────

function showLogo(compact = false) {
  if (compact) {
    console.log('');
    console.log(chalk.bold.cyan('  ◈ NEXUS') + chalk.dim(` v${VERSION}`));
    console.log('');
    return;
  }
  console.log('');
  console.log(chalk.bold.cyan('  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗'));
  console.log(chalk.bold.cyan('  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝'));
  console.log(chalk.bold.blue('  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗'));
  console.log(chalk.bold.blue('  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║'));
  console.log(chalk.bold.magenta('  ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║'));
  console.log(chalk.bold.magenta('  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝'));
  console.log('');
  console.log(
    chalk.dim(`  v${VERSION}`) +
      chalk.dim('  ·  ') +
      chalk.hex('#9B59B6')('Personal AI That Lives On Your Mac'),
  );
  console.log(chalk.dim('  ─────────────────────────────────────────────'));
  console.log('');
}

function showPhrase() {
  console.log('');
  console.log(chalk.dim('  ' + randomPhrase()));
  console.log('');
}

function ok(label: string, value: string) {
  console.log(`  ${chalk.green('✓')} ${chalk.bold(label)}: ${chalk.green(value)}`);
}

function fail(label: string, value: string) {
  console.log(`  ${chalk.red('✗')} ${chalk.bold(label)}: ${chalk.red(value)}`);
}

function check(label: string, value: string, passed: boolean) {
  if (passed) ok(label, value);
  else fail(label, value);
}

function info(label: string, value: string) {
  console.log(`  ${chalk.cyan('◈')} ${chalk.bold(label)}: ${chalk.white(value)}`);
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
    console.log(chalk.bold('  Starting NEXUS...'));
    console.log('');

    if (isRunning()) {
      console.log(chalk.yellow('  ⚠  NEXUS is already running.'));
      console.log(chalk.dim('     Use `nexus restart` to restart it.'));
      showPhrase();
      return;
    }

    try {
      const result = startDaemon();
      console.log(chalk.green('  ✓  NEXUS started') + chalk.dim(` (via ${result.via})`));
      if (result.via === 'direct') {
        console.log(chalk.dim(`     PID: ${result.pid}`));
        console.log(chalk.dim('     Run `nexus setup` to configure launchd for auto-start on login.'));
      }
    } catch {
      console.log(chalk.red('  ✗  Failed to start NEXUS.'));
      console.log(chalk.dim('     Ensure the project is built: nexus update'));
    }

    showPhrase();
  });

// ── nexus stop ────────────────────────────────────────────────────────────────

program
  .command('stop')
  .description('Stop the NEXUS service')
  .action(() => {
    showLogo(true);
    console.log(chalk.bold('  Stopping NEXUS...'));
    console.log('');

    if (!isRunning()) {
      console.log(chalk.yellow('  ⚠  NEXUS is not running.'));
      showPhrase();
      return;
    }

    try {
      stopDaemon();
      console.log(chalk.green('  ✓  NEXUS stopped.'));
    } catch {
      console.log(chalk.red('  ✗  Failed to stop NEXUS.'));
    }

    showPhrase();
  });

// ── nexus restart ─────────────────────────────────────────────────────────────

program
  .command('restart')
  .description('Restart the NEXUS service')
  .action(async () => {
    showLogo(true);
    console.log(chalk.bold('  Restarting NEXUS...'));
    console.log('');

    try {
      stopDaemon();
      console.log(chalk.green('  ✓  Stopped.'));
    } catch {}

    await new Promise((r) => setTimeout(r, 1200));

    try {
      const result = startDaemon();
      console.log(chalk.green('  ✓  Started') + chalk.dim(` (via ${result.via})`));
    } catch {
      console.log(chalk.red('  ✗  Failed to start. Run `nexus update` to rebuild.'));
    }

    showPhrase();
  });

// ── nexus status ──────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show NEXUS status, uptime, and memory usage')
  .action(() => {
    showLogo(true);
    console.log(chalk.bold('  NEXUS Status'));
    console.log(chalk.dim('  ─────────────────────────'));
    console.log('');

    const running = isRunning();
    const pid = getPid();

    if (running && pid) {
      console.log(`  ${chalk.green('●')} ${chalk.green.bold('Running')}  ${chalk.dim(`PID: ${pid}`)}`);
      console.log(`  ${chalk.dim('Uptime:')}   ${getUptime(pid)}`);
      console.log(`  ${chalk.dim('Memory:')}   ${getMemUsage(pid)}`);
    } else {
      console.log(`  ${chalk.red('●')} ${chalk.red.bold('Stopped')}`);
      console.log(chalk.dim('  Run `nexus start` to start NEXUS.'));
    }

    console.log('');
    console.log(
      `  ${chalk.dim('Config:')}   ${existsSync(CONFIG_PATH) ? chalk.green('✓ found') : chalk.red('✗ missing')}`,
    );
    console.log(
      `  ${chalk.dim('Logs:')}     ${existsSync(LOG_PATH) ? chalk.green('✓ found') : chalk.dim('not yet created')}`,
    );
    console.log(
      `  ${chalk.dim('launchd:')} ${existsSync(PLIST_PATH) ? chalk.green('✓ installed') : chalk.yellow('not installed')}`,
    );

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
    console.log(chalk.bold('  Verifying NEXUS Installation'));
    console.log(chalk.dim('  ─────────────────────────────────'));
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
      console.log(chalk.green('  ✓ NEXUS is ready to run!'));
    } else {
      console.log(chalk.yellow('  ⚠  Some checks failed. Run `nexus setup` to fix them.'));
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
      console.log(chalk.yellow('  ⚠  No log file found yet.'));
      console.log(chalk.dim(`  Expected at: ${LOG_PATH}`));
      console.log(chalk.dim('  Start NEXUS first with: nexus start'));
      showPhrase();
      return;
    }

    console.log(chalk.bold(`  Tailing: ${chalk.cyan(LOG_PATH)}`));
    console.log(chalk.dim('  Press Ctrl+C to stop.\n'));

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
    console.log(chalk.bold('  NEXUS Configuration'));
    console.log(chalk.dim('  ─────────────────────────'));
    console.log('');

    if (!existsSync(CONFIG_PATH)) {
      console.log(chalk.red('  ✗ Config not found: ') + chalk.dim(CONFIG_PATH));
      console.log(chalk.dim('  Run `nexus setup` to create it.'));
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

      console.log(chalk.dim(`  ${CONFIG_PATH}\n`));
      for (const line of raw.split('\n')) {
        console.log('  ' + chalk.white(line));
      }
    } catch {
      console.log(chalk.red('  ✗ Could not read config file.'));
    }

    showPhrase();
  });

// ── nexus update ──────────────────────────────────────────────────────────────

program
  .command('update')
  .description('Pull latest from GitHub and rebuild')
  .action(() => {
    showLogo(true);
    console.log(chalk.bold('  Updating NEXUS...'));
    console.log('');

    const steps: Array<{ label: string; cmd: string }> = [
      { label: 'git pull', cmd: 'git pull' },
      { label: 'pnpm install', cmd: 'pnpm install' },
      { label: 'pnpm build', cmd: 'pnpm build' },
    ];

    for (const step of steps) {
      console.log(chalk.dim(`  → ${step.label}`));
      try {
        execSync(step.cmd, { cwd: PROJECT_DIR, stdio: 'inherit' });
        console.log('');
      } catch {
        console.log('');
        console.log(chalk.red(`  ✗ Failed at: ${step.label}`));
        showPhrase();
        return;
      }
    }

    console.log(chalk.green('  ✓ NEXUS updated successfully.'));
    console.log(chalk.dim('  Run `nexus restart` to apply the update.'));

    showPhrase();
  });

// ── nexus agents ──────────────────────────────────────────────────────────────

program
  .command('agents')
  .description('List all agents and their status')
  .action(() => {
    showLogo(true);
    console.log(chalk.bold('  NEXUS Agents'));
    console.log(chalk.dim('  ─────────────────────────'));
    console.log('');

    const ALL_AGENTS = [
      { name: 'vision', label: 'Vision', icon: '👁 ', desc: 'Screen capture, OCR, and visual analysis' },
      { name: 'file', label: 'File', icon: '📁', desc: 'File system operations — read, write, search, organize' },
      { name: 'browser', label: 'Browser', icon: '🌐', desc: 'Web browsing, scraping, and research' },
      { name: 'terminal', label: 'Terminal', icon: '💻', desc: 'Shell command execution and process management' },
      { name: 'code', label: 'Code', icon: '⚡', desc: 'Code generation, review, refactoring, and debugging' },
      { name: 'research', label: 'Research', icon: '🔍', desc: 'Deep web research with source synthesis' },
      { name: 'system', label: 'System', icon: '⚙️ ', desc: 'macOS control — apps, settings, notifications' },
      { name: 'creative', label: 'Creative', icon: '✨', desc: 'Writing, brainstorming, and content generation' },
      { name: 'comms', label: 'Comms', icon: '💬', desc: 'Message drafting, email composition' },
      { name: 'scheduler', label: 'Scheduler', icon: '📅', desc: 'Task scheduling, reminders, and time management' },
    ];

    let enabledAgents: string[] = [];
    if (existsSync(CONFIG_PATH)) {
      try {
        const raw = readFileSync(CONFIG_PATH, 'utf-8');
        const match = raw.match(/agents:\s*\n((?:\s+-\s+\w+\n?)+)/);
        if (match) {
          enabledAgents = match[1].match(/\w+/g) ?? [];
        }
      } catch {}
    }

    for (const agent of ALL_AGENTS) {
      const enabled = enabledAgents.length === 0 || enabledAgents.includes(agent.name);
      const status = enabled ? chalk.green('enabled') : chalk.dim('disabled');
      console.log(
        `  ${agent.icon}  ${chalk.bold(agent.label.padEnd(11))} ${status}  ${chalk.dim(agent.desc)}`,
      );
    }

    showPhrase();
  });

// ── nexus memory ──────────────────────────────────────────────────────────────

program
  .command('memory')
  .description('Show memory system statistics')
  .action(() => {
    showLogo(true);
    console.log(chalk.bold('  NEXUS Memory Stats'));
    console.log(chalk.dim('  ─────────────────────────'));
    console.log('');

    if (!existsSync(DB_PATH)) {
      console.log(chalk.yellow('  ⚠  No memory database found yet.'));
      console.log(chalk.dim('  Start NEXUS and interact with it to build memory.'));
      showPhrase();
      return;
    }

    const sizeMb = (statSync(DB_PATH).size / 1024 / 1024).toFixed(2);
    info('Database', DB_PATH);
    info('Size', `${sizeMb} MB`);

    try {
      const tables = ['episodic_memory', 'semantic_memory', 'procedural_memory', 'user_facts', 'mistakes'];
      const labels: Record<string, string> = {
        episodic_memory: 'Episodic memories',
        semantic_memory: 'Semantic memories',
        procedural_memory: 'Procedural memories',
        user_facts: 'User facts',
        mistakes: 'Tracked mistakes',
      };

      console.log('');
      for (const table of tables) {
        try {
          const count = execSync(
            `sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM ${table};" 2>/dev/null`,
            { stdio: 'pipe', shell: true },
          )
            .toString()
            .trim();
          info(labels[table], count);
        } catch {
          // table may not exist yet
        }
      }
    } catch {
      console.log(chalk.dim('  (Install sqlite3 CLI for detailed stats)'));
    }

    showPhrase();
  });

// ── nexus screenshot ──────────────────────────────────────────────────────────

program
  .command('screenshot')
  .description('Take a screenshot and save to Desktop')
  .action(() => {
    showLogo(true);
    console.log(chalk.bold('  Taking screenshot...'));
    console.log('');

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath = join(HOME, 'Desktop', `nexus-${ts}.png`);

    try {
      execSync(`screencapture -x "${outPath}"`, { stdio: 'pipe' });
      console.log(chalk.green('  ✓ Screenshot saved:'));
      console.log(chalk.cyan(`    ${outPath}`));
    } catch {
      console.log(chalk.red('  ✗ Screenshot failed.'));
      console.log(chalk.dim('  Ensure Screen Recording permission is granted in System Settings.'));
    }

    showPhrase();
  });

// ── nexus health ──────────────────────────────────────────────────────────────

program
  .command('health')
  .description('Full system health check')
  .action(() => {
    showLogo(true);
    console.log(chalk.bold('  NEXUS Health Check'));
    console.log(chalk.dim('  ─────────────────────────────────'));
    console.log('');

    // Service
    const running = isRunning();
    const pid = getPid();
    console.log(chalk.dim('  Service'));
    if (running && pid) {
      console.log(
        `    ${chalk.green('●')} Running  PID: ${pid}  Uptime: ${getUptime(pid)}  Mem: ${getMemUsage(pid)}`,
      );
    } else {
      console.log(`    ${chalk.red('●')} Stopped`);
    }

    // Installation
    console.log('');
    console.log(chalk.dim('  Installation'));
    try {
      const nodeVer = execSync('node -v', { stdio: 'pipe' }).toString().trim();
      check('  Node.js', nodeVer, parseInt(nodeVer.replace('v', ''), 10) >= 22);
    } catch {
      fail('  Node.js', 'not found');
    }

    const distOk = existsSync(join(PROJECT_DIR, 'dist', 'index.js'));
    const configOk = existsSync(CONFIG_PATH);
    const logsOk = existsSync(join(NEXUS_DIR, 'logs'));
    const plistOk = existsSync(PLIST_PATH);

    check('  Build', distOk ? 'found' : 'missing', distOk);
    check('  Config', configOk ? 'found' : 'missing', configOk);
    check('  Logs dir', logsOk ? 'found' : 'missing', logsOk);
    check('  launchd', plistOk ? 'installed' : 'not installed', plistOk);

    // Storage
    console.log('');
    console.log(chalk.dim('  Storage'));
    if (existsSync(DB_PATH)) {
      const sizeMb = (statSync(DB_PATH).size / 1024 / 1024).toFixed(2);
      ok('  Memory DB', `${sizeMb} MB`);
    } else {
      console.log(chalk.dim('    No memory DB yet — start NEXUS to create it'));
    }

    showPhrase();
  });

// ── nexus version ─────────────────────────────────────────────────────────────

program
  .command('version')
  .description('Show NEXUS version and environment info')
  .action(() => {
    showLogo(true);
    info('Version', VERSION);
    info('Node.js', process.version);
    info('Platform', `${process.platform} (${process.arch})`);
    info('Project', PROJECT_DIR);
    showPhrase();
  });

// ── nexus uninstall ───────────────────────────────────────────────────────────

program
  .command('uninstall')
  .description('Remove NEXUS from this system')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (opts) => {
    showLogo(true);
    console.log(chalk.red.bold('  ⚠  NEXUS Uninstall'));
    console.log('');
    console.log(chalk.dim('  This will:'));
    console.log(chalk.dim('  • Stop the NEXUS service'));
    console.log(chalk.dim('  • Remove the launchd plist'));
    console.log(chalk.dim(`  • Delete ${NEXUS_DIR} (config, logs, memory)`));
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
        console.log(chalk.dim('  Aborted. NEXUS lives on.'));
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
        execSync(`launchctl bootout gui/$(id -u)/${PLIST_LABEL} 2>/dev/null || true`, {
          shell: true,
        });
        execSync(`rm -f "${PLIST_PATH}"`, { shell: true });
        console.log(chalk.green('  ✓  launchd plist removed'));
      } catch {}
    }

    if (existsSync(NEXUS_DIR)) {
      execSync(`rm -rf "${NEXUS_DIR}"`, { shell: true });
      console.log(chalk.green(`  ✓  ${NEXUS_DIR} removed`));
    }

    console.log('');
    console.log(chalk.dim('  NEXUS has left the building.'));
    console.log(chalk.dim('  To reinstall: git clone && ./install.sh'));
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

    console.log(chalk.bold('  NEXUS Workspace'));
    console.log(chalk.dim('  ─────────────────────────'));
    console.log('');
    console.log(`  ${chalk.dim('Path:')}   ${chalk.cyan(workspacePath)}`);
    console.log('');

    // Create if missing
    if (!existsSync(workspacePath)) {
      try {
        mkdirSync(workspacePath, { recursive: true });
        console.log(chalk.green('  ✓ Workspace directory created'));
      } catch {
        console.log(chalk.yellow('  ⚠  Could not create workspace directory'));
      }
    }

    // List contents
    try {
      const entries = readdirSync(workspacePath);
      if (entries.length === 0) {
        console.log(chalk.dim('  (workspace is empty)'));
      } else {
        console.log(chalk.dim(`  ${entries.length} item(s):\n`));
        for (const entry of entries.slice(0, 20)) {
          const fullPath = join(workspacePath, entry);
          const isDir = statSync(fullPath).isDirectory();
          const icon = isDir ? '📁' : '📄';
          console.log(`  ${icon}  ${entry}`);
        }
        if (entries.length > 20) {
          console.log(chalk.dim(`  … and ${entries.length - 20} more`));
        }
      }
    } catch {
      console.log(chalk.dim('  (could not read workspace)'));
    }

    console.log('');

    // Open in Finder
    try {
      execSync(`open "${workspacePath}"`, { stdio: 'pipe' });
      console.log(chalk.green('  ✓ Opened in Finder'));
    } catch {
      console.log(chalk.dim(`  Run: open "${workspacePath}"`));
    }

    showPhrase();
  });

program.parse(process.argv);
