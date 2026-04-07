// Tool executor — maps structured tool calls to concrete implementations.
// This is the bridge between Gemini's function calling and NEXUS's agent system.

import { homedir } from 'node:os';
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  readdir,
  stat,
  mkdir,
  chmod,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';
import { nowISO, truncate } from '../utils/helpers.js';

import type { AgentManager } from '../agents/index.js';
import type { MemoryManager } from '../memory/index.js';

const log = createLogger('ToolExecutor');
const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 200_000;

function cleanTruncate(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  const slice = text.slice(0, MAX_OUTPUT_BYTES);
  const lastNl = slice.lastIndexOf('\n');
  const truncated = lastNl > 0 ? slice.slice(0, lastNl) : slice;
  return truncated + `\n… [output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
}

function expandPath(p: string): string {
  if (p.startsWith('~')) return p.replace(/^~/, homedir());
  return p;
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

export class ToolExecutor {
  constructor(
    private agents: AgentManager,
    private memory: MemoryManager,
  ) {}

  /**
   * Execute a tool by name with the given arguments.
   * Returns a string result suitable for sending back as a function response.
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    log.info({ toolName, args: truncate(JSON.stringify(args), 200) }, 'Executing tool');
    const start = Date.now();

    try {
      let result: string;

      switch (toolName) {
        case 'run_terminal_command':
          result = await this.runTerminalCommand(args);
          break;
        case 'write_file':
          result = await this.writeFile(args);
          break;
        case 'read_file':
          result = await this.readFile(args);
          break;
        case 'list_directory':
          result = await this.listDirectory(args);
          break;
        case 'take_screenshot':
          result = await this.takeScreenshot();
          break;
        case 'get_system_info':
          result = await this.getSystemInfo(args);
          break;
        case 'remember':
          result = await this.remember(args);
          break;
        case 'recall':
          result = this.recall(args);
          break;
        case 'web_search':
          result = await this.webSearch(args);
          break;
        default:
          result = `Error: Unknown tool "${toolName}"`;
      }

      const duration = Date.now() - start;
      log.info({ toolName, duration, resultLen: result.length }, 'Tool executed');
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - start;
      log.error({ toolName, error: msg, duration }, 'Tool execution failed');
      return `Error: ${msg}`;
    }
  }

  // ── run_terminal_command ────────────────────────────────────────────

  private async runTerminalCommand(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '');
    const timeoutMs = Number(args.timeout ?? 30_000);
    const cwd = args.cwd ? expandPath(String(args.cwd)) : undefined;

    if (!command) return 'Error: No command provided';

    if (DANGEROUS_PATTERNS.some((p) => p.test(command))) {
      return `Command rejected as dangerous: ${command}`;
    }

    const { stdout, stderr } = await execFileAsync('/bin/zsh', ['-c', command], {
      timeout: timeoutMs,
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    });

    const out = cleanTruncate(stdout.trim());
    const err = stderr.trim();

    if (out && err) return `${out}\n\nSTDERR:\n${err}`;
    if (out) return out;
    if (err) return `STDERR:\n${err}`;
    return '(command completed with no output)';
  }

  // ── write_file ─────────────────────────────────────────────────────

  private async writeFile(args: Record<string, unknown>): Promise<string> {
    const rawPath = String(args.path ?? '');
    let content = String(args.content ?? '');
    const executable = args.executable === true || args.executable === 'true';

    // Unescape literal \n and \t that Gemini sends as two-character sequences
    content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

    if (!rawPath) return 'Error: No path provided';

    // Unescape literal backslash-escaped sequences from LLM output
    content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');

    const filePath = expandPath(rawPath);

    // ALWAYS create parent directories first — prevents ENOENT permanently
    await mkdir(dirname(filePath), { recursive: true });
    await fsWriteFile(filePath, content, 'utf-8');

    if (executable) {
      await chmod(filePath, 0o755);
    }

    const info = await stat(filePath);
    const sizeKB = (info.size / 1024).toFixed(1);
    log.info({ path: filePath, size: info.size }, 'File written via tool');
    return `File written successfully: ${rawPath} (${sizeKB} KB, ${content.split('\n').length} lines${executable ? ', executable' : ''})`;
  }

  // ── read_file ──────────────────────────────────────────────────────

  private async readFile(args: Record<string, unknown>): Promise<string> {
    const rawPath = String(args.path ?? '');
    if (!rawPath) return 'Error: No path provided';

    const filePath = expandPath(rawPath);
    const info = await stat(filePath);

    if (info.size > 1_000_000) {
      return `Error: File too large (${(info.size / 1024 / 1024).toFixed(1)} MB, max 1 MB)`;
    }

    return await fsReadFile(filePath, 'utf-8');
  }

  // ── list_directory ─────────────────────────────────────────────────

  private async listDirectory(args: Record<string, unknown>): Promise<string> {
    const dir = expandPath(String(args.path ?? '.'));
    const showHidden = args.showHidden === 'true' || args.showHidden === true;

    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((e) => showHidden || !e.name.startsWith('.'))
        .map(async (e) => {
          const fullPath = join(dir, e.name);
          const info = await stat(fullPath).catch(() => null);
          const type = e.isDirectory() ? 'dir' : 'file';
          const size = info ? `${info.size}B` : '?';
          return `  ${type}\t${size}\t${e.name}`;
        }),
    );

    return `Directory: ${dir}\n${files.join('\n')}`;
  }

  // ── take_screenshot ────────────────────────────────────────────────

  private async takeScreenshot(): Promise<string> {
    const result = await this.agents.dispatch('vision', 'screenshot', {});
    if (!result.success) {
      return `Error: ${result.error ?? 'Screenshot failed'}`;
    }
    const data = result.data as { path: string };
    return `Screenshot saved to: ${data.path}`;
  }

  // ── get_system_info ────────────────────────────────────────────────

  private async getSystemInfo(args: Record<string, unknown>): Promise<string> {
    const category = String(args.category ?? 'overview');

    const actionMap: Record<string, string> = {
      overview: 'system_info',
      cpu: 'cpu_usage',
      memory: 'memory_usage',
      disk: 'disk_space',
      network: 'network_info',
      processes: 'list_processes',
      apps: 'installed_apps',
    };

    const action = actionMap[category] ?? 'system_info';
    const result = await this.agents.dispatch('system', action, {});

    if (!result.success) {
      return `Error: ${result.error ?? 'System info failed'}`;
    }

    return typeof result.data === 'string'
      ? result.data
      : JSON.stringify(result.data, null, 2);
  }

  // ── remember ───────────────────────────────────────────────────────

  private async remember(args: Record<string, unknown>): Promise<string> {
    const content = String(args.content ?? '');
    const importance = Number(args.importance ?? 0.7);

    if (!content) return 'Error: No content to remember';

    this.memory.store('semantic', 'fact', content, {
      importance,
      tags: ['explicit-remember', 'tool-call'],
      source: 'tool-executor',
    });

    log.info({ content: truncate(content, 80) }, 'Stored memory via tool');
    return `Remembered: "${truncate(content, 100)}"`;
  }

  // ── recall ─────────────────────────────────────────────────────────

  private recall(args: Record<string, unknown>): string {
    const query = String(args.query ?? '');
    if (!query) return 'Error: No query provided';

    const memories = this.memory.recall(query, { limit: 8 });
    if (memories.length === 0) {
      return 'No relevant memories found.';
    }

    const results = memories.map((m) => {
      const summary = m.summary ?? truncate(m.content, 200);
      return `- [${m.type}] ${summary}`;
    });

    return `Found ${memories.length} relevant memories:\n${results.join('\n')}`;
  }

  // ── web_search ─────────────────────────────────────────────────────

  private async webSearch(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '');
    const engine = String(args.engine ?? 'google');

    if (!query) return 'Error: No query provided';

    const encodedQuery = encodeURIComponent(query);
    const urls: Record<string, string> = {
      google: `https://www.google.com/search?q=${encodedQuery}`,
      duckduckgo: `https://duckduckgo.com/?q=${encodedQuery}`,
      bing: `https://www.bing.com/search?q=${encodedQuery}`,
    };

    const url = urls[engine] ?? urls.google!;
    await execFileAsync('open', [url], { timeout: 5_000 });
    return `Opened ${engine} search for: "${query}"`;
  }
}
