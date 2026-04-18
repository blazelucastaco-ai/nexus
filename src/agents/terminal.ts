import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { nowISO } from '../utils/helpers.js';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 200_000; // 200 KB — truncate cleanly at last newline

function cleanTruncate(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  const slice = text.slice(0, MAX_OUTPUT_BYTES);
  const lastNl = slice.lastIndexOf('\n');
  const truncated = lastNl > 0 ? slice.slice(0, lastNl) : slice;
  return truncated + `\n… [output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
}

const DANGEROUS_PATTERNS = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/\s*$/,
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,
  /rm\s+-rf\s+\/$/,
  /rm\s+-rf\s+\/\s/,
  /rm\s+-rf\s+~\s*$/,
  /mkfs\./,
  /dd\s+if=.*of=\/dev\//,
  /:\(\)\{.*\|.*&\s*\};\s*:/,
  />\s*\/dev\/sd[a-z]/,
  /chmod\s+-R\s+777\s+\//,
  /chown\s+-R\s+.*\s+\//,
  /curl.*\|\s*(sudo\s+)?bash/,
  /wget.*\|\s*(sudo\s+)?bash/,
  /sudo\s+rm\s+-rf\s+\//,
];

function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

export class TerminalAgent extends BaseAgent {
  constructor() {
    super('terminal', 'Executes shell commands with safety checks, timeout support, and output capture', [
      { name: 'run_command', description: 'Run a shell command and capture output' },
      { name: 'get_output', description: 'Run a command and return only its stdout' },
      { name: 'list_processes', description: 'List running processes' },
      { name: 'kill_process', description: 'Kill a process by PID' },
    ]);
  }

  async execute(action: string, params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    this.log.info({ action, params }, 'TerminalAgent executing');

    try {
      switch (action) {
        case 'run_command':
          return await this.runCommand(params, start);
        case 'get_output':
          return await this.getOutput(params, start);
        case 'list_processes':
          return await this.listProcesses(params, start);
        case 'kill_process':
          return await this.killProcess(params, start);
        default:
          return this.createResult(false, null, `Unknown action: ${action}`, start);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ action, error: msg }, 'TerminalAgent failed');
      return this.createResult(false, null, msg, start);
    }
  }

  private async runCommand(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const command = String(params.command);
    const timeoutMs = Number(params.timeout ?? 30_000);
    const cwd = params.cwd ? String(params.cwd) : undefined;

    if (isDangerous(command)) {
      this.log.warn({ command }, 'Blocked dangerous command');
      return this.createResult(false, null, `Command rejected as dangerous: ${command}`, start);
    }

    const { stdout, stderr } = await execFileAsync('/bin/zsh', ['-c', command], {
      timeout: timeoutMs,
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env },
    });

    return this.createResult(
      true,
      {
        command,
        stdout: cleanTruncate(stdout.trim()),
        stderr: cleanTruncate(stderr.trim()),
        executedAt: nowISO(),
      },
      undefined,
      start,
    );
  }

  private async getOutput(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const result = await this.runCommand(params, start);
    if (!result.success) return result;

    const data = result.data as { stdout: string };
    return this.createResult(true, { output: data.stdout }, undefined, start);
  }

  private async listProcesses(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const filter = params.filter ? String(params.filter) : undefined;
    const sortBy = String(params.sortBy ?? 'cpu');

    let psCommand = 'ps aux';
    if (sortBy === 'memory') {
      psCommand = 'ps aux --sort=-%mem 2>/dev/null || ps aux -m';
    }

    const { stdout } = await execFileAsync('/bin/zsh', ['-c', psCommand], {
      timeout: 5_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    const lines = stdout.trim().split('\n');
    const header = lines[0];
    let processes = lines.slice(1).map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        user: parts[0],
        pid: parseInt(parts[1], 10),
        cpu: parseFloat(parts[2]),
        memory: parseFloat(parts[3]),
        command: parts.slice(10).join(' '),
      };
    });

    if (filter) {
      const regex = new RegExp(filter, 'i');
      processes = processes.filter((p) => regex.test(p.command));
    }

    return this.createResult(
      true,
      { count: processes.length, header, processes: processes.slice(0, 50) },
      undefined,
      start,
    );
  }

  private async killProcess(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const pid = Number(params.pid);
    const signal = String(params.signal ?? 'TERM');

    if (!pid || Number.isNaN(pid)) {
      return this.createResult(false, null, 'Invalid PID', start);
    }

    await execFileAsync('kill', [`-${signal}`, String(pid)], { timeout: 5_000 });

    this.log.info({ pid, signal }, 'Process killed');
    return this.createResult(true, { pid, signal, killedAt: nowISO() }, undefined, start);
  }
}
