// NEXUS wake-word supervisor (macOS only).
//
// Builds (if needed) and supervises the on-device Swift wake listener
// (macos/nexus-wake). When the helper prints "WAKE", onWake() fires — the
// daemon opens/focuses the Jarvis UI and tells the page to start listening.
//
// Fully local: audio never leaves the machine; only the literal token "WAKE"
// crosses the process boundary — never your speech. Non-fatal everywhere: the
// daemon, Telegram and the web keep running if Swift is missing, permission is
// denied, or there's no microphone.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getDataDir } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('WakeWord');
const execFileP = promisify(execFile);

const MAX_FAILURES = 4; // give up after this many immediate failures (e.g. permission denied)

function resolveBinary(): string | null {
  const candidates = [
    process.env.NEXUS_WAKE_BIN,
    join(getDataDir(), 'app', 'nexus-wake'), // deployed: ~/.nexus/app/nexus-wake
    join(process.cwd(), '.wake-bin', 'nexus-wake'), // dev: compiled on the fly
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

async function compileFromSource(): Promise<string | null> {
  const srcDir = join(process.cwd(), 'macos', 'nexus-wake');
  const main = join(srcDir, 'main.swift');
  const plist = join(srcDir, 'Info.plist');
  if (!existsSync(main)) return null;
  const outDir = join(process.cwd(), '.wake-bin');
  const out = join(outDir, 'nexus-wake');
  try {
    await execFileP('mkdir', ['-p', outDir]);
    await execFileP('swiftc', [
      '-O', '-swift-version', '5', main, '-o', out,
      '-framework', 'Speech', '-framework', 'AVFoundation',
      '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist,
    ]);
    await execFileP('codesign', ['--force', '--sign', '-', '--identifier', 'com.nexus.wake', out]).catch(() => {});
    log.info('Compiled wake-word helper from source');
    return existsSync(out) ? out : null;
  } catch (err) {
    log.warn({ err }, 'Failed to compile wake-word helper (Swift toolchain required)');
    return null;
  }
}

export class WakeListener {
  private child: ChildProcess | null = null;
  private stopped = false;
  private failures = 0;
  private binary: string | null = null;

  constructor(
    private readonly onWake: () => void,
    private readonly onCommand?: (text: string) => void,
  ) {}

  /** Returns true if the wake-word listener was armed (a child was spawned). */
  async start(): Promise<boolean> {
    if (process.platform !== 'darwin') {
      log.info('Wake word is macOS-only — skipping');
      return false;
    }
    if (process.env.NEXUS_WAKE_WORD === '0') {
      log.info('Wake word disabled (NEXUS_WAKE_WORD=0)');
      return false;
    }
    this.binary = resolveBinary() ?? (await compileFromSource());
    if (!this.binary) {
      log.warn('Wake-word helper unavailable (no prebuilt binary, and compile failed/skipped) — wake word off');
      return false;
    }
    this.spawnChild();
    return true;
  }

  private spawnChild(): void {
    if (this.stopped || !this.binary) return;
    log.info({ bin: this.binary }, 'Starting wake-word listener — say "Hey Nexus"');
    const child = spawn(this.binary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;

    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === 'WAKE') {
          log.info('Wake word detected — "Hey Nexus"');
          this.failures = 0; // a real detection proves the pipeline is healthy
          try { this.onWake(); } catch (err) { log.warn({ err }, 'onWake handler threw'); }
        } else if (line.startsWith('CMD:')) {
          const cmd = line.slice(4).trim();
          if (cmd) {
            log.info({ cmd: cmd.slice(0, 80) }, 'Voice command transcribed');
            try { this.onCommand?.(cmd); } catch (err) { log.warn({ err }, 'onCommand handler threw'); }
          }
        }
        nl = buf.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s) log.info({ helper: s }, 'wake helper');
    });

    child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      if (code && code !== 0) {
        this.failures += 1;
        if (this.failures >= MAX_FAILURES) {
          log.warn(
            { code },
            'Wake-word helper failed repeatedly — giving up. Grant Microphone + Speech Recognition permission to NEXUS, then restart the daemon.',
          );
          return;
        }
      }
      const delay = Math.min(1000 * 2 ** this.failures, 15000);
      setTimeout(() => this.spawnChild(), delay);
    });
    child.on('error', (err) => log.warn({ err }, 'Failed to spawn wake-word helper'));
  }

  stop(): void {
    this.stopped = true;
    try { this.child?.kill('SIGTERM'); } catch { /* ignore */ }
    this.child = null;
  }
}
