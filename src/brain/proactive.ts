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
import { countRecentTaskFailures } from '../data/episodic-queries.js';

const log = createLogger('ProactiveEngine');

export type SendFn = (message: string) => Promise<void>;

// Ports to watch by default — empty; user adds via /watch_port (future)
const DEFAULT_WATCHED_PORTS: number[] = [];

// How long with no messages before we consider NEXUS "idle"
const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;   // 2 hours
// Minimum time between proactive idea messages
const IDEA_COOLDOWN_MS = 4 * 60 * 60 * 1000;    // 4 hours

interface PortState {
  status: 'up' | 'down';
  consecutiveFailures: number; // increments each check while down
  nextCheckAt: number;         // epoch ms — skip check until this time
  alertedDown: boolean;        // true after first down-alert is sent; reset on recovery
}

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

  // Port monitoring state — map port → rich state with backoff
  private watchedPorts: Map<number, PortState> = new Map();

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
      this.watchedPorts.set(p, { status: 'up', consecutiveFailures: 0, nextCheckAt: 0, alertedDown: false });
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
      this.watchedPorts.set(port, { status: 'up', consecutiveFailures: 0, nextCheckAt: 0, alertedDown: false });
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

    // Task-failure cascade — alert when tasks repeatedly fail
    try {
      const taskAlert = this.checkTaskFailures();
      if (taskAlert) alerts.push(taskAlert);
    } catch (err) {
      log.debug({ err }, 'Task failure check skipped');
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
    // Use `df --output=avail,pcent` on Linux; macOS `df` doesn't support
    // --output, so fall back to parsing the percent column and treating the
    // usage % as the signal. "Avail" column index varies by locale/flags;
    // parse the header row to locate it instead of assuming parts[3] (FIND-BUG-02).
    const full = execSync('df -h /', { encoding: 'utf8', timeout: 5000 });
    const lines = full.trim().split('\n');
    if (lines.length < 2) return null;
    const header = lines[0]!.split(/\s+/);
    const row = lines[lines.length - 1]!.split(/\s+/);
    const useMatch = lines[lines.length - 1]!.match(/(\d+)%/);
    if (!useMatch) return null;
    const usePct = parseInt(useMatch[1]!, 10);
    if (usePct < 90) return null;
    // Find the column labeled something like "Avail" / "Available" (any case).
    const availIdx = header.findIndex((h) => /^avail/i.test(h));
    const avail = availIdx >= 0 && row[availIdx] ? row[availIdx] : '?';
    return `⚠️ <b>Low disk space</b> — ${usePct}% used, ${avail} available\n\n<code>${lines[lines.length - 1]!.trim()}</code>`;
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

  // ── Task-failure monitoring ──────────────────────────────────────
  // Tracks when we last alerted so we don't spam. Alerts again after 2h.
  private lastTaskFailureAlert = 0;
  private readonly TASK_FAILURE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
  private readonly TASK_FAILURE_THRESHOLD = 3;
  private readonly TASK_FAILURE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  /**
   * Alert if 3+ task failures happened in the last hour.
   * Queries routed through the episodic-queries repository — no raw SQL here.
   */
  private checkTaskFailures(): string | null {
    const now = Date.now();
    if (now - this.lastTaskFailureAlert < this.TASK_FAILURE_COOLDOWN_MS) {
      return null; // cooldown active
    }

    const { count, titles } = countRecentTaskFailures(this.TASK_FAILURE_WINDOW_MS);
    if (count < this.TASK_FAILURE_THRESHOLD) return null;

    this.lastTaskFailureAlert = now;

    const bullets = titles.map((t) => `  • ${t}`).join('\n');
    return `⚠️ <b>${count} tasks failed in the last hour</b>\n\n${bullets}\n\n<i>Want me to investigate a pattern?</i>`;
  }

  // ── Port monitoring ───────────────────────────────────────────────

  private async checkPort(port: number): Promise<string | null> {
    const state = this.watchedPorts.get(port);
    if (!state) return null;

    const now = Date.now();

    // Skip check if still in backoff window
    if (now < state.nextCheckAt) {
      const waitMin = Math.round((state.nextCheckAt - now) / 60_000);
      log.debug({ port, waitMin }, 'Port check skipped — backoff active');
      return null;
    }

    const isUp = await this.isPortOpen(port);

    if (isUp && state.status === 'down') {
      // Recovery — reset all backoff state
      state.status = 'up';
      state.consecutiveFailures = 0;
      state.nextCheckAt = 0;
      state.alertedDown = false;
      return `✅ <b>Port ${port} is back up</b>`;
    }

    if (!isUp && state.status === 'up') {
      // First failure — alert and start backoff
      state.status = 'down';
      state.consecutiveFailures = 1;
      state.nextCheckAt = now + backoffMs(1);
      state.alertedDown = true;
      return `🔴 <b>Port ${port} went down</b> — your service may have crashed`;
    }

    if (!isUp && state.status === 'down') {
      // Continued failure — increment and extend backoff, no repeat alert
      state.consecutiveFailures += 1;
      state.nextCheckAt = now + backoffMs(state.consecutiveFailures);
      log.debug({ port, consecutiveFailures: state.consecutiveFailures }, 'Port still down — backoff extended');
      return null;
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
      const context = await this.getMemoryContext();
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

  private async getMemoryContext(): Promise<string> {
    if (!this.memoryManager) return 'No memory context available.';

    try {
      const recent = await this.memoryManager.recall('recent activity', {
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Backoff schedule for consecutive port failures:
 *   1–2 failures  →  5 min  (normal cadence)
 *   3–5 failures  →  30 min
 *   6+ failures   →  2 hours
 */
function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures >= 6) return 2 * 60 * 60 * 1000;   // 2 hours
  if (consecutiveFailures >= 3) return 30 * 60 * 1000;        // 30 min
  return 5 * 60 * 1000;                                        // 5 min (normal)
}
