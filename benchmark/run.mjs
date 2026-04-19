#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEXUS_DIR = '/Users/lucastopinka/nexus';
const PLIST = '/Users/lucastopinka/Library/LaunchAgents/com.nexus.ai.plist';

// ── extract Anthropic key from NEXUS plist ────────────────────────────────
const plist = readFileSync(PLIST, 'utf8');
const keyMatch = plist.match(/ANTHROPIC_API_KEY<\/key><string>([^<]+)<\/string>/);
if (!keyMatch) throw new Error('no ANTHROPIC_API_KEY in plist');
const ANTHROPIC_KEY = keyMatch[1];

// ── generic runner ────────────────────────────────────────────────────────
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ stdout, stderr: stderr + '\n[timeout]', code: -1, ms: performance.now() - t0 });
    }, opts.timeoutMs ?? 120_000);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, ms: performance.now() - t0 });
    });
  });
}

// ── NEXUS: one-shot via dev-chat.ts ──────────────────────────────────────
async function askNexus(prompt) {
  const res = await runCmd(
    'pnpm',
    ['--silent', 'exec', 'tsx', 'scripts/dev-chat.ts', prompt],
    { cwd: NEXUS_DIR, timeoutMs: 120_000 },
  );
  const reply = extractNexusReply(res.stdout);
  return { system: 'nexus', ms: res.ms, reply, raw: res.stdout.slice(-4000) };
}

function extractNexusReply(stdout) {
  const lines = stdout.split('\n').filter((l) => !l.startsWith('{"level"'));
  const idx = lines.findIndex((l) => l.includes('nexus >'));
  if (idx < 0) return '';
  const after = lines.slice(idx + 1).join('\n');
  return after
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\n+\s+Shutting down.*$/s, '')
    .trim();
}

// ── OpenClaw: one-shot via agent --local ──────────────────────────────────
async function askOpenclaw(prompt) {
  const res = await runCmd(
    'openclaw',
    ['agent', '--local', '--agent', 'main', '-m', prompt, '--json', '--timeout', '60'],
    { env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, timeoutMs: 120_000 },
  );
  const reply = extractOpenclawReply(res.stdout);
  return { system: 'openclaw', ms: res.ms, reply, raw: res.stdout.slice(-4000) };
}

function extractOpenclawReply(stdout) {
  try {
    const braceStart = stdout.indexOf('{\n  "payloads"');
    if (braceStart < 0) return '';
    const json = JSON.parse(stdout.slice(braceStart));
    const text = json?.payloads?.[0]?.text || '';
    return String(text).replace(/\x1b\[[0-9;]*m/g, '').trim();
  } catch {
    return '';
  }
}

// ── programmatic checks ───────────────────────────────────────────────────
function runCheck(reply, check) {
  const text = (reply || '').trim();
  switch (check.kind) {
    case 'contains': {
      const hay = check.caseSensitive ? text : text.toLowerCase();
      const ndl = check.caseSensitive ? check.expect : check.expect.toLowerCase();
      return hay.includes(ndl);
    }
    case 'exact-match':
      return text === check.expect;
    case 'word-count': {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length !== check.expect) return false;
      if (check.mustContain) {
        const low = text.toLowerCase();
        return check.mustContain.every((w) => low.includes(w.toLowerCase()));
      }
      return true;
    }
    case 'line-count': {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      return lines.length === check.expect;
    }
    case 'regex':
      return new RegExp(check.expect).test(text);
    default:
      return false;
  }
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  const all = JSON.parse(readFileSync(join(HERE, 'prompts.json'), 'utf8'));
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : all.length;
  const prompts = all.slice(0, limit);
  const outDir = join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = join(outDir, `run-${stamp}.json`);

  const results = [];
  for (const q of prompts) {
    process.stdout.write(`[${q.id}] ${q.category}  NEXUS... `);
    const nexus = await askNexus(q.prompt);
    const nexusPass = runCheck(nexus.reply, q.check);
    process.stdout.write(`${nexusPass ? 'PASS' : 'FAIL'} (${Math.round(nexus.ms)}ms)  OpenClaw... `);

    const openclaw = await askOpenclaw(q.prompt);
    const openclawPass = runCheck(openclaw.reply, q.check);
    process.stdout.write(`${openclawPass ? 'PASS' : 'FAIL'} (${Math.round(openclaw.ms)}ms)\n`);

    results.push({
      id: q.id,
      category: q.category,
      prompt: q.prompt,
      nexus: { ...nexus, pass: nexusPass },
      openclaw: { ...openclaw, pass: openclawPass },
    });

    writeFileSync(outFile, JSON.stringify({ stamp, results }, null, 2));
  }

  // summary
  const n = results.length;
  const nexusPass = results.filter((r) => r.nexus.pass).length;
  const openclawPass = results.filter((r) => r.openclaw.pass).length;
  const nexusAvg = Math.round(results.reduce((s, r) => s + r.nexus.ms, 0) / n);
  const openclawAvg = Math.round(results.reduce((s, r) => s + r.openclaw.ms, 0) / n);
  console.log('\n───── Summary ─────');
  console.log(`NEXUS    : ${nexusPass}/${n} pass · avg ${nexusAvg}ms`);
  console.log(`OpenClaw : ${openclawPass}/${n} pass · avg ${openclawAvg}ms`);
  console.log(`\nResults: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
