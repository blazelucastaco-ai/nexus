// Nexus AI — Proactive Behavior Engine (Phase 4.3)
//
// Monitors system state every 5 minutes and sends Telegram alerts when
// something notable happens. Toggled via /quiet and /loud commands.
//
// Checks:
//   - Disk space: warns when >= 90% full (< 10% free)
//   - CPU load: warns when user+sys load > 90%

import { execSync } from 'node:child_process';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ProactiveEngine');

export type SendFn = (message: string) => Promise<void>;

export class ProactiveEngine {
  private sendFn: SendFn;
  private quiet = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(sendFn: SendFn) {
    this.sendFn = sendFn;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.check().catch((err) => log.error({ err }, 'Proactive check failed'));
    }, this.INTERVAL_MS);
    log.info('Proactive engine started (interval: 5m)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
    log.info({ quiet }, 'Proactive quiet mode changed');
  }

  isQuiet(): boolean {
    return this.quiet;
  }

  // ── System checks ─────────────────────────────────────────────────

  private async check(): Promise<void> {
    if (this.quiet) return;

    const alerts: string[] = [];

    try {
      const diskAlert = this.checkDisk();
      if (diskAlert) alerts.push(diskAlert);
    } catch (err) {
      log.debug({ err }, 'Disk check skipped');
    }

    try {
      const cpuAlert = this.checkCPU();
      if (cpuAlert) alerts.push(cpuAlert);
    } catch (err) {
      log.debug({ err }, 'CPU check skipped');
    }

    for (const alert of alerts) {
      try {
        await this.sendFn(alert);
      } catch (err) {
        log.error({ err }, 'Failed to send proactive alert');
      }
    }
  }

  private checkDisk(): string | null {
    const output = execSync('df -h / | tail -1', { encoding: 'utf8', timeout: 5000 });
    // Format: "Filesystem  Size  Used  Avail  Use%  Mounted"
    const useMatch = output.match(/(\d+)%/);
    if (!useMatch) return null;

    const usePct = parseInt(useMatch[1]!, 10);
    if (usePct < 90) return null;

    const parts = output.trim().split(/\s+/);
    const avail = parts[3] ?? '?';
    return `⚠️ <b>Low disk space</b> — ${usePct}% used, ${avail} available\n\n<code>${output.trim()}</code>`;
  }

  private checkCPU(): string | null {
    // "CPU usage: 12.50% user, 8.33% sys, 79.16% idle"
    const output = execSync('top -l 1 -s 0 | grep "CPU usage"', { encoding: 'utf8', timeout: 10000 });
    const idleMatch = output.match(/(\d+(?:\.\d+)?)%\s+idle/);
    if (!idleMatch) return null;

    const idle = parseFloat(idleMatch[1]!);
    const usage = Math.round(100 - idle);
    if (usage <= 90) return null;

    return `🔥 <b>High CPU usage</b> — ${usage}% load\n\n<code>${output.trim()}</code>`;
  }
}
