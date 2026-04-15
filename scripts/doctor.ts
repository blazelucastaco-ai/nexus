#!/usr/bin/env tsx
// NEXUS Doctor — health check script
// Run: tsx scripts/doctor.ts  OR  nexus doctor

import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const HOME = homedir();
const NEXUS_DIR = join(HOME, '.nexus');
const ENV_PATH = join(process.cwd(), '.env');
const CONFIG_PATH = join(NEXUS_DIR, 'config.yaml');
const DB_PATH = join(NEXUS_DIR, 'memory.db');

type CheckResult = { name: string; status: 'PASS' | 'FAIL' | 'WARN'; detail: string; fix?: string };

const results: CheckResult[] = [];

function check(name: string, fn: () => { ok: boolean; detail: string; fix?: string }): void {
  try {
    const { ok, detail, fix } = fn();
    results.push({ name, status: ok ? 'PASS' : 'FAIL', detail, fix });
  } catch (err) {
    results.push({
      name,
      status: 'FAIL',
      detail: err instanceof Error ? err.message : String(err),
      fix: 'Investigate the error manually',
    });
  }
}

function warn(name: string, fn: () => { ok: boolean; detail: string; fix?: string }): void {
  try {
    const { ok, detail, fix } = fn();
    results.push({ name, status: ok ? 'PASS' : 'WARN', detail, fix });
  } catch (err) {
    results.push({ name, status: 'WARN', detail: err instanceof Error ? err.message : String(err) });
  }
}

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// ── Checks ────────────────────────────────────────────────────────────────────

check('Node.js version', () => {
  const v = process.version;
  const major = parseInt(v.slice(1).split('.')[0] ?? '0', 10);
  return {
    ok: major >= 22,
    detail: `${v} (requires >=22)`,
    fix: 'Install Node.js 22+ from https://nodejs.org',
  };
});

check('pnpm available', () => {
  try {
    const v = run('pnpm --version');
    return { ok: true, detail: `pnpm ${v}` };
  } catch {
    return {
      ok: false,
      detail: 'pnpm not found',
      fix: 'Run: npm install -g pnpm',
    };
  }
});

check('better-sqlite3 binary', () => {
  try {
    // Dynamic require to check native module
    const modPath = join(process.cwd(), 'node_modules', 'better-sqlite3');
    if (!existsSync(modPath)) {
      return { ok: false, detail: 'better-sqlite3 not installed', fix: 'Run: pnpm install' };
    }
    // Try to actually load it
    const Database = require(modPath);
    const db = new Database(':memory:');
    db.close();
    return { ok: true, detail: 'Native binary loads successfully' };
  } catch (err) {
    return {
      ok: false,
      detail: `Failed to load: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Run: npm rebuild better-sqlite3  or  pnpm rebuild better-sqlite3',
    };
  }
});

check('.env file exists', () => {
  const exists = existsSync(ENV_PATH);
  return {
    ok: exists,
    detail: exists ? ENV_PATH : 'Not found at project root',
    fix: 'Copy .env.example to .env and fill in your tokens',
  };
});

check('config.yaml exists', () => {
  const exists = existsSync(CONFIG_PATH);
  return {
    ok: exists,
    detail: exists ? CONFIG_PATH : `Not found at ${CONFIG_PATH}`,
    fix: 'Run: nexus setup  or  nexus init  to create the config',
  };
});

check('Telegram bot token set', () => {
  const token =
    process.env.TELEGRAM_BOT_TOKEN ??
    (() => {
      try {
        const env = readFileSync(ENV_PATH, 'utf-8');
        const match = env.match(/TELEGRAM_BOT_TOKEN=([^\n]+)/);
        return match?.[1]?.trim() ?? '';
      } catch {
        return '';
      }
    })();

  const set = !!(token && token.length > 10 && token !== 'your_telegram_bot_token_here');
  return {
    ok: set,
    detail: set ? `Token present (${token.slice(0, 8)}…)` : 'TELEGRAM_BOT_TOKEN not set',
    fix: 'Get a token from @BotFather on Telegram, add to .env',
  };
});

warn('Telegram token validity', () => {
  const token =
    process.env.TELEGRAM_BOT_TOKEN ??
    (() => {
      try {
        const env = readFileSync(ENV_PATH, 'utf-8');
        const match = env.match(/TELEGRAM_BOT_TOKEN=([^\n]+)/);
        return match?.[1]?.trim() ?? '';
      } catch {
        return '';
      }
    })();

  if (!token || token.length < 10) {
    return { ok: false, detail: 'No token to validate' };
  }

  try {
    const result = run(
      `curl -s --max-time 5 "https://api.telegram.org/bot${token}/getMe"`,
    );
    const parsed = JSON.parse(result);
    if (parsed.ok) {
      return { ok: true, detail: `Bot: @${parsed.result?.username ?? 'unknown'}` };
    }
    return {
      ok: false,
      detail: `API error: ${parsed.description ?? 'unknown'}`,
      fix: 'Double-check your TELEGRAM_BOT_TOKEN in .env',
    };
  } catch {
    return { ok: false, detail: 'Could not reach Telegram API (network?)', fix: 'Check internet connectivity' };
  }
});

check('Anthropic API key set', () => {
  const key =
    process.env.ANTHROPIC_API_KEY ??
    (() => {
      try {
        const env = readFileSync(ENV_PATH, 'utf-8');
        const match = env.match(/ANTHROPIC_API_KEY=([^\n]+)/);
        return match?.[1]?.trim() ?? '';
      } catch {
        return '';
      }
    })();

  const set = !!(key && key.length > 10 && key !== 'your_anthropic_api_key');
  return {
    ok: set,
    detail: set ? `Key present (${key.slice(0, 8)}…)` : 'ANTHROPIC_API_KEY not set',
    fix: 'Get an API key at console.anthropic.com, add ANTHROPIC_API_KEY to .env',
  };
});

warn('Anthropic API connectivity', () => {
  const key =
    process.env.ANTHROPIC_API_KEY ??
    (() => {
      try {
        const env = readFileSync(ENV_PATH, 'utf-8');
        const match = env.match(/ANTHROPIC_API_KEY=([^\n]+)/);
        return match?.[1]?.trim() ?? '';
      } catch {
        return '';
      }
    })();

  if (!key || key.length < 10 || key === 'your_anthropic_api_key') {
    return { ok: false, detail: 'No key to validate' };
  }

  try {
    const result = run(
      `curl -s --max-time 8 -o /dev/null -w "%{http_code}" https://api.anthropic.com/v1/models -H "x-api-key: ${key}" -H "anthropic-version: 2023-06-01"`,
    );
    const code = parseInt(result.trim(), 10);
    if (code === 200) return { ok: true, detail: 'Anthropic API reachable and key valid' };
    if (code === 401) return { ok: false, detail: 'Invalid API key (401)', fix: 'Check ANTHROPIC_API_KEY in .env' };
    return { ok: false, detail: `Unexpected HTTP ${code}`, fix: 'Check network connectivity or Anthropic status' };
  } catch {
    return { ok: false, detail: 'Could not reach Anthropic API (network?)', fix: 'Check internet connectivity' };
  }
});

check('Memory DB integrity', () => {
  if (!existsSync(DB_PATH)) {
    return { ok: false, detail: `DB not found: ${DB_PATH}`, fix: 'Start NEXUS once to initialize the database' };
  }

  try {
    const size = statSync(DB_PATH).size;
    const kb = (size / 1024).toFixed(1);

    // Quick integrity check using sqlite3 CLI if available
    try {
      const result = run(`sqlite3 "${DB_PATH}" "PRAGMA integrity_check;" 2>/dev/null`);
      const ok = result.trim() === 'ok';
      return {
        ok,
        detail: ok ? `DB healthy (${kb} KB)` : `Integrity issue: ${result}`,
        fix: ok ? undefined : 'Backup and delete the DB, then restart NEXUS',
      };
    } catch {
      // sqlite3 CLI not available — just check size
      return { ok: size > 0, detail: `DB exists, ${kb} KB (sqlite3 CLI not available for deep check)` };
    }
  } catch (err) {
    return { ok: false, detail: `Cannot stat DB: ${err}`, fix: 'Check file permissions on ~/.nexus/' };
  }
});

check('Disk space', () => {
  try {
    const output = run('df -h ~ | tail -1');
    const parts = output.split(/\s+/);
    const usePercent = parts[4] ?? '';
    const used = parseInt(usePercent, 10);
    const avail = parts[3] ?? '?';
    return {
      ok: used < 90,
      detail: `${avail} available (${usePercent} used)`,
      fix: used >= 90 ? 'Free up disk space — less than 10% remaining' : undefined,
    };
  } catch {
    return { ok: true, detail: 'Could not check disk space' };
  }
});

warn('dist/ bundle exists', () => {
  const distPath = join(process.cwd(), 'dist', 'index.js');
  const exists = existsSync(distPath);
  return {
    ok: exists,
    detail: exists ? `dist/index.js found` : 'dist/index.js not found',
    fix: exists
      ? undefined
      : 'Run: npx esbuild src/index.ts --bundle --platform=node --outfile=dist/index.js --external:better-sqlite3 --format=esm',
  };
});

// ── Report ─────────────────────────────────────────────────────────────────────

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const WARN = '\x1b[33mWARN\x1b[0m';

console.log('\n🔍 NEXUS Doctor\n');

let failures = 0;
let warnings = 0;

for (const r of results) {
  const badge = r.status === 'PASS' ? PASS : r.status === 'FAIL' ? FAIL : WARN;
  console.log(`  [${badge}] ${r.name}`);
  console.log(`         ${r.detail}`);
  if (r.fix) console.log(`         \x1b[2mFix: ${r.fix}\x1b[0m`);
  if (r.status === 'FAIL') failures++;
  if (r.status === 'WARN') warnings++;
}

const total = results.length;
const passed = total - failures - warnings;
console.log(`\n  ${passed}/${total} checks passed, ${warnings} warnings, ${failures} failures\n`);

if (failures > 0) {
  console.log('  ❌ NEXUS has issues that need fixing before it will run correctly.\n');
  process.exit(1);
} else if (warnings > 0) {
  console.log('  ⚠️  NEXUS should work but some optional checks failed.\n');
  process.exit(0);
} else {
  console.log('  ✅ NEXUS looks healthy!\n');
  process.exit(0);
}
