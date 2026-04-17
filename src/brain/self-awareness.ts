// NEXUS Brain — Self-Awareness Layer (Phase 1.3)
//
// Gives NEXUS introspective access to its own process state, filesystem,
// memory statistics, emotional state, and host environment.

import { homedir, cpus, totalmem, release } from 'node:os';
import { statSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
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

/** Resolve the NEXUS source directory (where package.json lives). */
function getSourceDir(): string {
  // Try common locations
  const candidates = [
    join(HOME, 'Desktop', 'nexus'),
    join(HOME, 'nexus'),
    join(HOME, 'Projects', 'nexus'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  // Fallback: walk up from this file's compiled location
  let dir = __dirname ?? process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = join(dir, '..');
  }
  return process.cwd();
}

function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, timeout: 5000, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

export interface VersionInfo {
  version: string;
  branch: string;
  commitHash: string;
  commitDate: string;
  commitMessage: string;
  sourceDir: string;
}

export interface UpdateStatus {
  currentVersion: string;
  currentCommit: string;
  branch: string;
  behindBy: number;
  aheadBy: number;
  isUpToDate: boolean;
  latestRemoteCommit: string;
  latestRemoteMessage: string;
  summary: string;
}

export class SelfAwareness {
  private sourceDir: string;

  constructor(
    private memory: MemoryManager,
    private personality: PersonalityEngine,
  ) {
    this.sourceDir = getSourceDir();
  }

  /** Get the current version, branch, and commit info. */
  getVersionInfo(): VersionInfo {
    let version = '0.0.0';
    try {
      const pkgPath = join(this.sourceDir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      version = pkg.version ?? '0.0.0';
    } catch { /* ignore */ }

    const branch = runGit(['branch', '--show-current'], this.sourceDir) || 'unknown';
    const commitHash = runGit(['rev-parse', '--short', 'HEAD'], this.sourceDir) || 'unknown';
    const commitDate = runGit(['log', '-1', '--format=%ci'], this.sourceDir) || 'unknown';
    const commitMessage = runGit(['log', '-1', '--format=%s'], this.sourceDir) || 'unknown';

    return { version, branch, commitHash, commitDate, commitMessage, sourceDir: this.sourceDir };
  }

  /** Check the remote for updates and return a status summary. */
  checkForUpdates(): UpdateStatus {
    const info = this.getVersionInfo();

    // Fetch latest from remote (silent, best-effort)
    runGit(['fetch', '--quiet'], this.sourceDir);

    const branch = info.branch;
    const behind = runGit(['rev-list', '--count', `HEAD..origin/${branch}`], this.sourceDir);
    const ahead = runGit(['rev-list', '--count', `origin/${branch}..HEAD`], this.sourceDir);
    const behindBy = parseInt(behind, 10) || 0;
    const aheadBy = parseInt(ahead, 10) || 0;

    let latestRemoteCommit = '';
    let latestRemoteMessage = '';
    if (behindBy > 0) {
      latestRemoteCommit = runGit(['rev-parse', '--short', `origin/${branch}`], this.sourceDir);
      latestRemoteMessage = runGit(['log', '-1', '--format=%s', `origin/${branch}`], this.sourceDir);
    }

    const isUpToDate = behindBy === 0;
    let summary: string;
    if (isUpToDate && aheadBy === 0) {
      summary = `Up to date on branch "${branch}" at commit ${info.commitHash}.`;
    } else if (isUpToDate && aheadBy > 0) {
      summary = `On branch "${branch}" at commit ${info.commitHash}. ${aheadBy} local commit(s) ahead of remote.`;
    } else {
      summary = `${behindBy} update(s) available on branch "${branch}". Current: ${info.commitHash}. Latest remote: ${latestRemoteCommit} — "${latestRemoteMessage}".`;
    }

    return {
      currentVersion: info.version,
      currentCommit: info.commitHash,
      branch,
      behindBy,
      aheadBy,
      isUpToDate,
      latestRemoteCommit,
      latestRemoteMessage,
      summary,
    };
  }

  /**
   * Full introspection report — detailed text block covering process, files,
   * memory, emotional state, workspace, and host machine.
   */
  getSelfReport(): string {
    const uptimeSecs = Math.floor(process.uptime());
    const mem = process.memoryUsage();
    const nodeVersion = process.version;

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

    // Note: version/branch/commit/source/data paths intentionally omitted from
    // this report to avoid self-disclosure. That data lives in getVersionInfo()
    // and checkForUpdates() for maintenance use only.
    return [
      '╔══════════════════════════════════════════╗',
      '║       NEXUS SELF-AWARENESS REPORT        ║',
      '╚══════════════════════════════════════════╝',
      '',
      '── Process ──────────────────────────────────',
      `  Node version:  ${nodeVersion}`,
      `  Process uptime:${formatUptime(uptimeSecs)}`,
      `  Heap used:     ${heapUsedMB} MB / ${heapTotalMB} MB total`,
      `  RSS:           ${rssMB} MB`,
      `  External:      ${externalMB} MB`,
      '',
      '── Storage ──────────────────────────────────',
      `  Memory DB:     ${dbSize}`,
      `  Brain state:   ${brainStateSize}`,
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
   *
   * SECURITY: This string lands in the LLM's context every turn. Do NOT
   * include version, commit hash, branch, source directory, or any other
   * identifier that could leak back to the user in a response. Runtime
   * stats (uptime, heap, memory counts, emotion) are safe.
   */
  getCompactStatus(): string {
    const uptimeSecs = Math.floor(process.uptime());
    const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
    const stats = this.memory.getStats();
    const ps = this.personality.getPersonalityState();

    return (
      `[state: uptime=${formatUptime(uptimeSecs)} heap=${heapMB}MB ` +
      `memories=${stats.totalMemories} facts=${stats.totalFacts} ` +
      `emotion=${ps.emotionLabel} mood=${ps.mood.toFixed(2)}]`
    );
  }
}
