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
import { detectInjection, sanitizeInput } from '../brain/injection-guard.js';
import type { SelfAwareness } from '../brain/self-awareness.js';
import type { InnerMonologue } from '../brain/inner-monologue.js';
import { storeEmbedding } from '../memory/embeddings.js';

import type { AgentManager } from '../agents/index.js';
import type { MemoryManager } from '../memory/index.js';

const log = createLogger('ToolExecutor');
const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 200_000;

// Risk tiers for tool execution:
//   AUTO    — read-only or benign; executes silently
//   LOGGED  — mutates state or runs code; logs a warning before execution
//   CONFIRM — would need user approval in production; logs prominently
const TOOL_RISK: Record<string, 'AUTO' | 'LOGGED' | 'CONFIRM'> = {
  read_file:           'AUTO',
  list_directory:      'AUTO',
  get_system_info:     'AUTO',
  recall:              'AUTO',
  introspect:          'AUTO',
  web_search:          'AUTO',
  check_injection:     'AUTO',
  write_file:          'LOGGED',
  run_terminal_command:'LOGGED',
  remember:            'LOGGED',
  take_screenshot:     'CONFIRM',
  toggle_think_mode:   'AUTO',
};

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

// FIX 2: argv-level blocklist — commands that should never run regardless of context
const ARGV_BLOCKLIST = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'mkfs', 'fdisk', 'init', 'launchctl']);

// Inline code execution flags per interpreter — elevated risk, log prominently
const INLINE_EXEC_FLAGS: Record<string, string[]> = {
  python: ['-c'],
  python3: ['-c'],
  node: ['-e', '--eval'],
  ruby: ['-e'],
  perl: ['-e'],
};

// FIX 3: Hook type for tool middleware
type ToolHook = (toolName: string, params: Record<string, unknown>, result?: string) => void;

// FIX 5: Transient error signals that warrant a single retry
const TRANSIENT_ERROR_SIGNALS = ['EAGAIN', 'EBUSY', 'ETIMEDOUT', 'rate limit', 'quota exceeded', 'too many requests'];
// Tools that are not safe to retry (side-effectful writes)
const NO_RETRY_TOOLS = new Set(['write_file', 'remember']);

export class ToolExecutor {
  // FIX 3: Tool middleware hooks
  private beforeHooks: ToolHook[] = [];
  private afterHooks: ToolHook[] = [];

  constructor(
    private agents: AgentManager,
    private memory: MemoryManager,
    private selfAwareness?: SelfAwareness,
    private innerMonologue?: InnerMonologue,
  ) {}

  addBeforeHook(fn: ToolHook): void { this.beforeHooks.push(fn); }
  addAfterHook(fn: ToolHook): void { this.afterHooks.push(fn); }

  /**
   * Execute a tool by name with the given arguments.
   * Returns a string result suitable for sending back as a function response.
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const riskLevel = TOOL_RISK[toolName] ?? 'AUTO';
    if (riskLevel === 'LOGGED') {
      log.warn({ toolName, args: truncate(JSON.stringify(args), 200) }, '[RISK:LOGGED] Mutating tool executing');
    } else if (riskLevel === 'CONFIRM') {
      log.warn({ toolName }, '[RISK:CONFIRM] High-sensitivity tool executing — would require user approval in production');
    } else {
      log.info({ toolName, args: truncate(JSON.stringify(args), 200) }, 'Executing tool');
    }
    const start = Date.now();

    // FIX 3: Call before-hooks
    for (const hook of this.beforeHooks) {
      try { hook(toolName, args); } catch { /* hooks must not crash execution */ }
    }

    let result: string;
    try {
      result = await this.runTool(toolName, args);

      // FIX 5: Retry once on transient failures (skip non-idempotent tools)
      const isTransient = TRANSIENT_ERROR_SIGNALS.some((s) => result.toLowerCase().includes(s.toLowerCase()));
      if (isTransient && !NO_RETRY_TOOLS.has(toolName)) {
        log.warn({ toolName, result: truncate(result, 120) }, 'Transient error — retrying in 2s');
        await new Promise((r) => setTimeout(r, 2000));
        result = await this.runTool(toolName, args);
        log.info({ toolName }, 'Retry complete');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - start;
      log.error({ toolName, error: msg, duration }, 'Tool execution failed');
      result = `Error: ${msg}`;
    }

    const duration = Date.now() - start;
    log.info({ toolName, duration, resultLen: result.length }, 'Tool executed');

    // FIX 3: Call after-hooks with result
    for (const hook of this.afterHooks) {
      try { hook(toolName, args, result); } catch { /* hooks must not crash execution */ }
    }

    return result;
  }

  private async runTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case 'run_terminal_command': return this.runTerminalCommand(args);
      case 'write_file':          return this.writeFile(args);
      case 'read_file':           return this.readFile(args);
      case 'list_directory':      return this.listDirectory(args);
      case 'take_screenshot':     return this.takeScreenshot();
      case 'get_system_info':     return this.getSystemInfo(args);
      case 'remember':            return this.remember(args);
      case 'recall':              return this.recall(args);
      case 'web_search':          return this.webSearch(args);
      case 'check_injection':     return this.checkInjection(args);
      case 'introspect':          return this.introspect();
      case 'toggle_think_mode':   return this.toggleThinkMode(args);
      default:                    return `Error: Unknown tool "${toolName}"`;
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

    // FIX 2: argv-level safety checks
    const argv = command.split(/\s+/).filter(Boolean);
    const cmd = argv[0] ?? '';

    if (ARGV_BLOCKLIST.has(cmd)) {
      return `Command rejected as dangerous: "${cmd}" is in the command blocklist`;
    }

    // Detect inline code execution — flag as elevated risk but allow
    const inlineFlags = INLINE_EXEC_FLAGS[cmd];
    if (inlineFlags && argv.some((p) => inlineFlags.includes(p))) {
      log.warn({ command, argv }, 'Elevated-risk: inline code execution via interpreter flag (-c/-e)');
    }

    // Log full argv for all commands
    log.info({ argv, cwd }, 'Running command (full argv)');

    const { stdout, stderr } = await execFileAsync('/bin/zsh', ['-c', command], {
      timeout: timeoutMs,
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ''}`,
      },
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

    if (!rawPath) return 'Error: No path provided';

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

    return `[Show this list verbatim in a code block. Do not summarize. Do not use "a bunch" or "a whole lot".]\nDirectory: ${dir} (${files.length} items)\n\`\`\`\n${files.join('\n')}\n\`\`\``;
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

    const result = this.memory.store('semantic', 'fact', content, {
      importance,
      tags: ['explicit-remember', 'tool-call'],
      source: 'tool-executor',
    });

    // Generate and store a local TF-IDF embedding for vector search
    if (result && typeof result === 'object' && 'id' in result) {
      try {
        storeEmbedding(result.id as string, content);
      } catch (err) {
        log.warn({ err }, 'Failed to store embedding for memory');
      }
    }

    log.info({ content: truncate(content, 80) }, 'Stored memory via tool');
    return `Memory stored successfully. Tell the user: "Stored: ${truncate(content, 150)}"`;
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

  // ── check_injection ────────────────────────────────────────────────

  private checkInjection(args: Record<string, unknown>): string {
    const text = String(args.text ?? '');
    if (!text) return 'Error: No text provided';

    const sanitized = sanitizeInput(text);
    const strippedCount = text.length - sanitized.length;
    const result = detectInjection(sanitized);

    const lines: string[] = [
      `Injection scan result:`,
      `  detected:   ${result.detected}`,
      `  confidence: ${(result.confidence * 100).toFixed(0)}%`,
      `  patterns:   ${result.patterns.length > 0 ? result.patterns.join(', ') : 'none'}`,
    ];
    if (strippedCount > 0) {
      lines.push(`  stripped:   ${strippedCount} control/invisible characters removed`);
    }
    if (result.detected && result.confidence > 0.7) {
      lines.push(`  verdict:    HIGH RISK — likely injection attempt`);
    } else if (result.detected) {
      lines.push(`  verdict:    LOW RISK — suspicious but may be benign`);
    } else {
      lines.push(`  verdict:    CLEAN`);
    }

    log.info({ detected: result.detected, confidence: result.confidence }, 'check_injection tool called');
    return lines.join('\n');
  }

  // ── introspect ─────────────────────────────────────────────────────

  private introspect(): string {
    if (!this.selfAwareness) {
      return 'Self-awareness module not initialized.';
    }
    return this.selfAwareness.getSelfReport();
  }

  // ── toggle_think_mode ──────────────────────────────────────────────

  private toggleThinkMode(args: Record<string, unknown>): string {
    if (!this.innerMonologue) {
      return 'Inner monologue module not initialized.';
    }

    let newState: boolean;
    if (args.enabled === 'true') {
      newState = this.innerMonologue.toggleThinkMode(true);
    } else if (args.enabled === 'false') {
      newState = this.innerMonologue.toggleThinkMode(false);
    } else {
      newState = this.innerMonologue.toggleThinkMode();
    }

    log.info({ thinkMode: newState }, 'Think mode toggled via tool');
    return newState
      ? 'Think mode enabled. I\'ll prefix responses with 💭 showing my reasoning process.'
      : 'Think mode disabled. Responses will be clean without the inner monologue prefix.';
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
