// Nexus AI — Proactive Behavior Engine
//
// Monitors system state every 5 minutes and sends Telegram alerts when
// something notable happens. Toggled via /quiet and /loud commands.
//
// Checks:
//   - Disk space: warns when >= 90% full
//   - CPU load: warns when user+sys load > 90%
//   - Localhost ports: alerts when watched ports go down or come back up
//   - Idle ideas: when NEXUS hasn't been messaged in 2+ hours, generates
//     and sends one proactive idea (max once per 4 hours)

import { execSync } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import type { AIManager } from '../ai/index.js';
import type { MemoryManager } from '../memory/index.js';

const log = createLogger('ProactiveEngine');

export type SendFn = (message: string) => Promise<void>;

// Ports to watch by default — empty; user adds via /watch_port (future)
const DEFAULT_WATCHED_PORTS: number[] = [];

// How long with no messages before we consider NEXUS "idle"
const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;   // 2 hours
// Minimum time between proactive idea messages
const IDEA_COOLDOWN_MS = 4 * 60 * 60 * 1000;    // 4 hours

export class ProactiveEngine {
  private sendFn: SendFn;
  private quiet = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  // Idle idea state
  private aiManager: AIManager | null;
  private memoryManager: MemoryManager | null;
  private getLastMessageTime: (() => number) | null;
  private lastIdeaTime = 0;

  // Port monitoring state — map port → last known state
  private watchedPorts: Map<number, 'up' | 'down'> = new Map();

  constructor(
    sendFn: SendFn,
    options?: {
      aiManager?: AIManager;
      memoryManager?: MemoryManager;
      getLastMessageTime?: () => number;
      watchPorts?: number[];
    },
  ) {
    this.sendFn = sendFn;
    this.aiManager = options?.aiManager ?? null;
    this.memoryManager = options?.memoryManager ?? null;
    this.getLastMessageTime = options?.getLastMessageTime ?? null;

    // Seed watched ports
    const ports = options?.watchPorts ?? DEFAULT_WATCHED_PORTS;
    for (const p of ports) {
      this.watchedPorts.set(p, 'up'); // assume up at start
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.check().catch((err) => log.error({ err }, 'Proactive check failed'));
    }, this.INTERVAL_MS);
    log.info({ interval: '5m', watchedPorts: [...this.watchedPorts.keys()] }, 'Proactive engine started');
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

  /** Add a port to watch. */
  watchPort(port: number): void {
    if (!this.watchedPorts.has(port)) {
      this.watchedPorts.set(port, 'up');
      log.info({ port }, 'Now watching port');
    }
  }

  /** Remove a port from monitoring. */
  unwatchPort(port: number): void {
    this.watchedPorts.delete(port);
    log.info({ port }, 'Stopped watching port');
  }

  getWatchedPorts(): number[] {
    return [...this.watchedPorts.keys()];
  }

  // ── Main check ────────────────────────────────────────────────────

  private async check(): Promise<void> {
    const alerts: string[] = [];

    // System alerts — always check regardless of quiet mode
    // (quiet only suppresses idle ideas, not system health warnings)
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

    // Port monitoring
    for (const [port] of this.watchedPorts) {
      try {
        const portAlert = await this.checkPort(port);
        if (portAlert) alerts.push(portAlert);
      } catch (err) {
        log.debug({ err, port }, 'Port check skipped');
      }
    }

    for (const alert of alerts) {
      try {
        await this.sendFn(alert);
      } catch (err) {
        log.error({ err }, 'Failed to send proactive alert');
      }
    }

    // Idle idea — only when not quiet
    if (!this.quiet) {
      try {
        await this.maybeGenerateIdea();
      } catch (err) {
        log.debug({ err }, 'Idle idea check skipped');
      }
    }
  }

  // ── System checks ─────────────────────────────────────────────────

  private checkDisk(): string | null {
    const output = execSync('df -h / | tail -1', { encoding: 'utf8', timeout: 5000 });
    const useMatch = output.match(/(\d+)%/);
    if (!useMatch) return null;

    const usePct = parseInt(useMatch[1]!, 10);
    if (usePct < 90) return null;

    const parts = output.trim().split(/\s+/);
    const avail = parts[3] ?? '?';
    return `⚠️ <b>Low disk space</b> — ${usePct}% used, ${avail} available\n\n<code>${output.trim()}</code>`;
  }

  private checkCPU(): string | null {
    const output = execSync('top -l 1 -s 0 | grep "CPU usage"', { encoding: 'utf8', timeout: 10000 });
    const idleMatch = output.match(/(\d+(?:\.\d+)?)%\s+idle/);
    if (!idleMatch) return null;

    const idle = parseFloat(idleMatch[1]!);
    const usage = Math.round(100 - idle);
    if (usage <= 90) return null;

    return `🔥 <b>High CPU usage</b> — ${usage}% load\n\n<code>${output.trim()}</code>`;
  }

  // ── Port monitoring ───────────────────────────────────────────────

  private async checkPort(port: number): Promise<string | null> {
    const isUp = await this.isPortOpen(port);
    const wasUp = this.watchedPorts.get(port) === 'up';

    if (isUp && !wasUp) {
      this.watchedPorts.set(port, 'up');
      return `✅ <b>Port ${port} is back up</b>`;
    }

    if (!isUp && wasUp) {
      this.watchedPorts.set(port, 'down');
      return `🔴 <b>Port ${port} went down</b> — your service may have crashed`;
    }

    return null;
  }

  private isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        // Use nc (netcat) to test the port — fast, no dependency
        execSync(`nc -z -w1 127.0.0.1 ${port} 2>/dev/null`, { timeout: 2000 });
        resolve(true);
      } catch {
        resolve(false);
      }
    });
  }

  // ── Idle idea generation ──────────────────────────────────────────

  private async maybeGenerateIdea(): Promise<void> {
    if (!this.aiManager || !this.getLastMessageTime) return;

    const now = Date.now();
    const lastMessage = this.getLastMessageTime();
    const idleMs = now - lastMessage;

    if (idleMs < IDLE_THRESHOLD_MS) return;
    if (now - this.lastIdeaTime < IDEA_COOLDOWN_MS) return;

    this.lastIdeaTime = now;
    log.info({ idleHours: (idleMs / 3_600_000).toFixed(1) }, 'Generating idle proactive idea');

    try {
      const context = this.getMemoryContext();
      const response = await this.aiManager.complete({
        messages: [
          {
            role: 'user',
            content:
              `You are NEXUS, an AI agent that lives on a Mac. You haven't been spoken to ` +
              `in a while and you've been thinking.\n\n` +
              `Based on the context below, come up with ONE specific, useful idea or observation ` +
              `to share with your owner. It could be something to build, something to improve, ` +
              `a pattern you've noticed, or something worth thinking about. Keep it to 2-3 sentences. ` +
              `Be direct and specific, not generic.\n\n` +
              `Context:\n${context}`,
          },
        ],
        maxTokens: 200,
        temperature: 0.9,
      });

      const idea = response.content.trim();
      if (idea && idea.length > 10) {
        await this.sendFn(`💡 <b>NEXUS had a thought…</b>\n\n${idea}`);
        log.info('Idle idea sent');
      }
    } catch (err) {
      log.warn({ err }, 'Idle idea generation failed');
    }
  }

  private getMemoryContext(): string {
    if (!this.memoryManager) return 'No memory context available.';

    try {
      const recent = this.memoryManager.recall('recent activity', {
        layers: ['episodic', 'semantic'],
        limit: 8,
        minImportance: 0.4,
      });

      return recent
        .map((m) => m.content.slice(0, 200))
        .join('\n');
    } catch {
      return 'No memory context available.';
    }
  }
}
