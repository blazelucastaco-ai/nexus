// NEXUS Brain — Self-Awareness Layer (Phase 1.3)
//
// Gives NEXUS introspective access to its own process state, filesystem,
// memory statistics, emotional state, and host environment.

import { homedir, cpus, totalmem, release } from 'node:os';
import { statSync, readdirSync, existsSync } from 'node:fs';
import { getDataDir, getDbPath } from '../config.js';
import type { MemoryManager } from '../memory/index.js';
import type { PersonalityEngine } from '../personality/index.js';

const HOME = homedir();

function expandPath(p: string): string {
  return p.replace(/^~/, HOME);
}

function fileSizeStr(path: string): string {
  try {
    const info = statSync(path);
    const kb = info.size / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
  } catch {
    return 'not found';
  }
}

function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export class SelfAwareness {
  constructor(
    private memory: MemoryManager,
    private personality: PersonalityEngine,
  ) {}

  /**
   * Full introspection report — detailed text block covering process, files,
   * memory, emotional state, workspace, and host machine.
   */
  getSelfReport(): string {
    const pid = process.pid;
    const uptimeSecs = Math.floor(process.uptime());
    const mem = process.memoryUsage();
    const nodeVersion = process.version;

    const sourceDir = `${HOME}/Desktop/nexus`;
    const dataDir = getDataDir();
    const dbPath = getDbPath();
    const brainStatePath = `${dataDir}/brain-state.json`;

    const dbSize = fileSizeStr(dbPath);
    const brainStateSize = fileSizeStr(brainStatePath);

    const stats = this.memory.getStats();

    const ps = this.personality.getPersonalityState();
    const moodLabel =
      ps.mood > 0.3 ? 'positive' : ps.mood < -0.3 ? 'negative' : 'neutral';

    // Workspace contents
    const workspacePath = expandPath('~/nexus-workspace');
    let workspaceContents: string;
    try {
      if (existsSync(workspacePath)) {
        const entries = readdirSync(workspacePath).filter(
          (e) => !e.startsWith('.'),
        );
        workspaceContents =
          entries.length > 0 ? entries.join(', ') : '(empty)';
      } else {
        workspaceContents = '(not created yet)';
      }
    } catch {
      workspaceContents = '(unreadable)';
    }

    // Host machine info via Node's os module
    const cpuList = cpus();
    const cpuModel = cpuList[0]?.model ?? 'unknown';
    const cpuCores = cpuList.length;
    const totalRAMGB = (totalmem() / 1024 / 1024 / 1024).toFixed(1);
    const macosKernel = release();

    // Memory usage
    const heapUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const heapTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(1);
    const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
    const externalMB = (mem.external / 1024 / 1024).toFixed(1);

    // Current time
    const timeStr = new Date().toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    return [
      '╔══════════════════════════════════════════╗',
      '║       NEXUS SELF-AWARENESS REPORT        ║',
      '╚══════════════════════════════════════════╝',
      '',
      '── Process ──────────────────────────────────',
      `  PID:           ${pid}`,
      `  Node version:  ${nodeVersion}`,
      `  Process uptime:${formatUptime(uptimeSecs)}`,
      `  Heap used:     ${heapUsedMB} MB / ${heapTotalMB} MB total`,
      `  RSS:           ${rssMB} MB`,
      `  External:      ${externalMB} MB`,
      '',
      '── Filesystem ───────────────────────────────',
      `  Source dir:    ${sourceDir}`,
      `  Data dir:      ${dataDir}`,
      `  Memory DB:     ${dbPath}  (${dbSize})`,
      `  Brain state:   ${brainStatePath}  (${brainStateSize})`,
      '',
      '── Memory Stats ─────────────────────────────',
      `  Total memories:  ${stats.totalMemories}`,
      `  Total facts:     ${stats.totalFacts}`,
      `  Total mistakes:  ${stats.totalMistakes}`,
      `  Episodic:        ${stats.byLayer['episodic'] ?? 0}`,
      `  Semantic:        ${stats.byLayer['semantic'] ?? 0}`,
      `  Procedural:      ${stats.byLayer['procedural'] ?? 0}`,
      `  Short-term buf:  ${stats.bufferSize} items`,
      '',
      '── Emotional State ──────────────────────────',
      `  Emotion:       ${ps.emotionLabel}`,
      `  Mood:          ${moodLabel}  (valence: ${ps.emotion.valence.toFixed(2)})`,
      `  Arousal:       ${(ps.emotion.arousal * 100).toFixed(0)}%`,
      `  Confidence:    ${(ps.emotion.confidence * 100).toFixed(0)}%`,
      `  Engagement:    ${(ps.emotion.engagement * 100).toFixed(0)}%`,
      `  Patience:      ${(ps.emotion.patience * 100).toFixed(0)}%`,
      `  Warmth:        ${(ps.relationshipWarmth * 100).toFixed(0)}%`,
      `  Days known:    ${ps.daysSinceFirstInteraction}`,
      '',
      '── Workspace ────────────────────────────────',
      `  Path:          ${workspacePath}`,
      `  Contents:      ${workspaceContents}`,
      '',
      '── Host Machine ─────────────────────────────',
      `  macOS kernel:  ${macosKernel}`,
      `  CPU:           ${cpuModel} (${cpuCores} cores)`,
      `  Total RAM:     ${totalRAMGB} GB`,
      '',
      '── Time ─────────────────────────────────────',
      `  Current time:  ${timeStr}`,
    ].join('\n');
  }

  /**
   * One-line compact summary — injected into every system prompt so
   * NEXUS always knows its own runtime state.
   */
  getCompactStatus(): string {
    const pid = process.pid;
    const uptimeSecs = Math.floor(process.uptime());
    const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
    const stats = this.memory.getStats();
    const ps = this.personality.getPersonalityState();

    return (
      `[self: pid=${pid} uptime=${formatUptime(uptimeSecs)} ` +
      `heap=${heapMB}MB memories=${stats.totalMemories} ` +
      `facts=${stats.totalFacts} emotion=${ps.emotionLabel} ` +
      `mood=${ps.mood.toFixed(2)}]`
    );
  }
}
