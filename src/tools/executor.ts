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
import {
  scheduleTaskTool,
  listTasksTool,
  cancelTaskTool,
} from '../brain/scheduler.js';
import type { LoadedPlugin } from '../plugins/loader.js';

import type { AgentManager } from '../agents/index.js';
import type { MemoryManager } from '../memory/index.js';

const log = createLogger('ToolExecutor');
const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 200_000;
const TOOL_RESULT_MAX = 8_000;
const TOOL_RESULT_HEAD = 3_000;
const TOOL_RESULT_TAIL = 3_000;

/**
 * FIX 4: Head+tail truncation for tool results.
 * Keeps first 3000 chars (command echo, headers) and last 3000 chars (errors, summaries).
 * Ensures we never lose the tail where errors typically appear.
 */
function truncateToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX) return text;
  const dropped = text.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  const head = text.slice(0, TOOL_RESULT_HEAD);
  const tail = text.slice(text.length - TOOL_RESULT_TAIL);
  return `${head}\n... [truncated ${dropped} chars] ...\n${tail}`;
}

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
  web_fetch:           'AUTO',
  check_injection:     'AUTO',
  write_file:          'LOGGED',
  run_terminal_command:'LOGGED',
  remember:            'LOGGED',
  take_screenshot:     'CONFIRM',
  toggle_think_mode:   'AUTO',
  schedule_task:       'LOGGED',
  list_tasks:          'AUTO',
  cancel_task:         'LOGGED',
  generate_image:      'LOGGED',
  speak:               'LOGGED',
  list_sessions:       'AUTO',
  cleanup_sessions:    'LOGGED',
  export_session:      'AUTO',
};

// Commands that require explicit user approval — returned as a confirmation prompt
// (distinct from DANGEROUS_PATTERNS which hard-block catastrophic patterns)
const APPROVAL_REQUIRED_COMMANDS = [
  'rm -rf',
  'rm -r ',
  'sudo rm',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'mkfs',
  'dd if=',
  'format ',
  'deltree',
  'diskutil eraseDisk',
  'diskutil eraseVolume',
];

// Commands always allowed without any warning (safe-bin allowlist)
const SAFE_BIN_ALLOWLIST = new Set([
  'ls', 'cat', 'echo', 'pwd', 'date', 'which', 'whoami', 'uname',
  'grep', 'find', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'awk', 'sed',
  'curl', 'wget', 'ping', 'nslookup', 'dig', 'ifconfig', 'netstat',
  'ps', 'top', 'htop', 'df', 'du', 'free', 'uptime',
  'git', 'npm', 'pnpm', 'node', 'python3', 'python',
  'open', 'say', 'osascript',
]);

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
  private plugins: LoadedPlugin[] = [];

  constructor(
    private agents: AgentManager,
    private memory: MemoryManager,
    private selfAwareness?: SelfAwareness,
    private innerMonologue?: InnerMonologue,
  ) {}

  /** Register loaded plugins so their tools can be dispatched */
  setPlugins(plugins: LoadedPlugin[]): void {
    this.plugins = plugins;
    log.info({ count: plugins.length }, 'Plugins registered with tool executor');
  }

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

    // FIX 4: Head+tail truncation — preserve both the start (headers) and end (errors)
    result = truncateToolResult(result);

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
      case 'web_fetch':           return this.webFetch(args);
      case 'check_injection':     return this.checkInjection(args);
      case 'introspect':          return this.introspect();
      case 'toggle_think_mode':   return this.toggleThinkMode(args);
      case 'schedule_task':       return scheduleTaskTool(args);
      case 'list_tasks':          return listTasksTool();
      case 'cancel_task':         return cancelTaskTool(args);
      case 'generate_image':      return this.generateImage(args);
      case 'speak':               return this.speak(args);
      case 'list_sessions':       return this.listSessions();
      case 'cleanup_sessions':    return this.cleanupSessions(args);
      case 'export_session':      return this.exportSession(args);
      default: {
        // Check plugin handlers
        for (const plugin of this.plugins) {
          if (toolName in plugin.handlers) {
            log.info({ toolName, plugin: plugin.manifest.name }, 'Dispatching to plugin handler');
            return plugin.handlers[toolName]!(args);
          }
        }
        return `Error: Unknown tool "${toolName}"`;
      }
    }
  }

  // ── run_terminal_command ────────────────────────────────────────────

  private async runTerminalCommand(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '');
    const timeoutMs = Number(args.timeout ?? 30_000);
    const cwd = args.cwd ? expandPath(String(args.cwd)) : undefined;
    const confirmed = args.confirmed === true || args.confirmed === 'true';

    if (!command) return 'Error: No command provided';

    if (DANGEROUS_PATTERNS.some((p) => p.test(command))) {
      return `Command rejected as dangerous: ${command}`;
    }

    // Approval gate — dangerous but not catastrophic commands require explicit confirmation
    if (!confirmed) {
      const needsApproval = APPROVAL_REQUIRED_COMMANDS.some((pattern) =>
        command.toLowerCase().includes(pattern.toLowerCase()),
      );
      if (needsApproval) {
        log.warn({ command }, 'Command requires approval');
        return (
          `⚠️ This command requires approval. Please confirm:\n\n\`${command}\`\n\n` +
          `Reply with: run_terminal_command with confirmed=true to proceed, or cancel.`
        );
      }
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
    // Content arrives via JSON.parse() so actual newlines are already real newlines.
    // Do NOT unescape \n — that would corrupt Python/bash string literals like print("hello\nworld").
    const content = String(args.content ?? '');
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
    const importance = Number(args.importance ?? 0.9);

    if (!content) return 'Error: No content to remember';

    // Store episodically so generic recall queries ("what do you remember?") find it.
    // Semantic (user_facts) only retrieves with specific keyword matches — episodic
    // retrieval falls back to importance-sorted results when no keywords match.
    const episodicContent = `REMEMBER: ${content}`;
    const result = this.memory.store('episodic', 'fact', episodicContent, {
      importance,
      tags: ['explicit-remember', 'tool-call', 'user-requested'],
      source: 'remember-tool',
    });

    // Generate and store a local TF-IDF embedding for vector search
    if (result && typeof result === 'object' && 'id' in result) {
      try {
        storeEmbedding((result as { id: string }).id, episodicContent);
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
  // Uses DuckDuckGo Instant Answer API (no key required) for real results.

  private async webSearch(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '');

    if (!query) return 'Error: No query provided';

    // Try DuckDuckGo Instant Answer API first
    try {
      const encodedQuery = encodeURIComponent(query);
      const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });

      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        const results: string[] = [];

        // Abstract (top answer)
        if (data.Abstract && String(data.Abstract).length > 10) {
          results.push(`**Summary:** ${data.Abstract}`);
          if (data.AbstractURL) results.push(`Source: ${data.AbstractURL}`);
        }

        // Instant answer
        if (data.Answer && String(data.Answer).length > 0) {
          results.push(`**Answer:** ${data.Answer}`);
        }

        // Related topics (top 5)
        const topics = (data.RelatedTopics as Array<{ Text?: string; FirstURL?: string }> | undefined) ?? [];
        const topResults = topics.slice(0, 5).filter((t) => t.Text);
        if (topResults.length > 0) {
          results.push('\n**Related:**');
          for (const t of topResults) {
            results.push(`• ${t.Text}${t.FirstURL ? `\n  ${t.FirstURL}` : ''}`);
          }
        }

        if (results.length > 0) {
          return `DuckDuckGo results for: "${query}"\n\n${results.join('\n')}`;
        }
      }
    } catch (err) {
      log.warn({ err }, 'DuckDuckGo API failed — falling back to browser open');
    }

    // Fallback: open browser
    const encodedQuery = encodeURIComponent(query);
    await execFileAsync('open', [`https://duckduckgo.com/?q=${encodedQuery}`], { timeout: 5_000 });
    return `No instant results found. Opened DuckDuckGo search for: "${query}"`;
  }

  // ── web_fetch ──────────────────────────────────────────────────────

  private async webFetch(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '');
    if (!url) return 'Error: No URL provided';

    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'NEXUS/1.0 (personal AI assistant)' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        return `Error: HTTP ${resp.status} ${resp.statusText} for ${url}`;
      }

      const contentType = resp.headers.get('content-type') ?? '';
      const text = await resp.text();

      // Strip HTML tags for readability
      if (contentType.includes('text/html')) {
        const stripped = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        const truncated = stripped.slice(0, 8_000);
        return `Content from ${url} (${text.length} chars, truncated to 8000):\n\n${truncated}`;
      }

      return truncateToolResult(text);
    } catch (err) {
      return `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── generate_image ─────────────────────────────────────────────────

  private async generateImage(args: Record<string, unknown>): Promise<string> {
    const prompt = String(args.prompt ?? args.description ?? '');
    if (!prompt) return 'Error: No image prompt provided';

    const workspace = expandPath('~/nexus-workspace');
    await mkdir(workspace, { recursive: true });

    // Try OpenAI DALL-E if key is present
    const openaiKey = process.env.OPENAI_API_KEY ?? '';
    if (openaiKey) {
      try {
        const resp = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openaiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1024x1024' }),
          signal: AbortSignal.timeout(60_000),
        });

        if (resp.ok) {
          const data = await resp.json() as { data?: Array<{ url?: string }> };
          const imageUrl = data.data?.[0]?.url;
          if (imageUrl) {
            // Download the image
            const imgResp = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
            const buffer = await imgResp.arrayBuffer();
            const filename = `image_${Date.now()}.png`;
            const outPath = join(workspace, filename);
            const { writeFile } = await import('node:fs/promises');
            await writeFile(outPath, Buffer.from(buffer));
            log.info({ path: outPath }, 'Image generated and saved');
            return `Image generated and saved to: ${outPath}\nPrompt: ${prompt}`;
          }
        }
      } catch (err) {
        log.warn({ err }, 'DALL-E generation failed');
      }
    }

    // Fallback: describe what would be generated
    return (
      `Image generation: No OpenAI API key configured for DALL-E.\n\n` +
      `Prompt: "${prompt}"\n\n` +
      `To enable: add OPENAI_API_KEY to .env\n` +
      `Images would be saved to: ${workspace}`
    );
  }

  // ── speak ──────────────────────────────────────────────────────────

  private async speak(args: Record<string, unknown>): Promise<string> {
    const text = String(args.text ?? args.message ?? '');
    const voice = String(args.voice ?? 'Samantha');
    const save = args.save === true || args.save === 'true';

    if (!text) return 'Error: No text to speak';

    // Sanitize text for shell safety — strip special chars
    const safeText = text.replace(/["`$\\]/g, ' ').slice(0, 500);

    if (save) {
      const workspace = expandPath('~/nexus-workspace');
      await mkdir(workspace, { recursive: true });
      const filename = `speech_${Date.now()}.aiff`;
      const outPath = join(workspace, filename);
      await execFileAsync('say', ['-v', voice, '-o', outPath, safeText], { timeout: 30_000 });
      log.info({ path: outPath }, 'Speech saved');
      return `Speech saved to: ${outPath}`;
    }

    await execFileAsync('say', ['-v', voice, safeText], { timeout: 30_000 });
    log.info({ text: truncate(safeText, 80) }, 'Speech played');
    return `Said: "${truncate(safeText, 100)}"`;
  }

  // ── session management ─────────────────────────────────────────────

  private async listSessions(): Promise<string> {
    const { homedir } = await import('node:os');
    const sessDir = join(homedir(), '.nexus', 'sessions');
    try {
      const entries = await readdir(sessDir);
      if (entries.length === 0) return 'No sessions found.';

      const rows: string[] = [`Sessions in ${sessDir}:\n`];
      for (const name of entries.sort()) {
        try {
          const info = await stat(join(sessDir, name));
          const kb = (info.size / 1024).toFixed(1);
          const age = Math.floor((Date.now() - info.mtimeMs) / 86_400_000);
          rows.push(`  ${name}  (${kb} KB, last modified ${age}d ago)`);
        } catch {
          rows.push(`  ${name}`);
        }
      }
      return rows.join('\n');
    } catch {
      return 'No sessions directory found.';
    }
  }

  private async cleanupSessions(args: Record<string, unknown>): Promise<string> {
    const olderThanDays = Number(args.days ?? 7);
    const { homedir } = await import('node:os');
    const { unlink } = await import('node:fs/promises');
    const sessDir = join(homedir(), '.nexus', 'sessions');
    try {
      const entries = await readdir(sessDir);
      const cutoff = Date.now() - olderThanDays * 86_400_000;
      let removed = 0;
      for (const name of entries) {
        const p = join(sessDir, name);
        const info = await stat(p).catch(() => null);
        if (info && info.mtimeMs < cutoff) {
          await unlink(p);
          removed++;
        }
      }
      return `Cleaned up ${removed} session(s) older than ${olderThanDays} days.`;
    } catch {
      return 'No sessions directory found or cleanup failed.';
    }
  }

  private async exportSession(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '');
    if (!id) return 'Error: No session id provided';

    const { homedir } = await import('node:os');
    const sessDir = join(homedir(), '.nexus', 'sessions');
    const sessFile = join(sessDir, id.endsWith('.json') ? id : `${id}.json`);

    try {
      const raw = await fsReadFile(sessFile, 'utf-8');
      const parsed = JSON.parse(raw) as { turns?: Array<{ role: string; content: string }> };
      const turns = parsed.turns ?? [];
      const lines = [`Session export: ${id}\n${'─'.repeat(40)}`];
      for (const turn of turns) {
        lines.push(`\n[${turn.role.toUpperCase()}]\n${turn.content}`);
      }
      return lines.join('\n');
    } catch (err) {
      return `Error reading session ${id}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
