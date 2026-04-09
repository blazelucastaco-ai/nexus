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

// New feature imports
import { analyzeImage } from '../media/image-understanding.js';
import { parsePdf, parsePdfFromUrl } from '../media/pdf-parser.js';
import { transcribeAudio } from '../media/audio-transcription.js';
import { crawlUrl } from '../media/link-crawler.js';
import { extractContent } from './content-extractor.js';
import { classifyCommand } from '../security/approval-policy.js';
import { checkApproval } from '../security/approval-gate.js';

import type { AgentManager } from '../agents/index.js';
import type { MemoryManager } from '../memory/index.js';
import type { TelegramGateway } from '../telegram/gateway.js';

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
  const total = text.length;
  const head = text.slice(0, TOOL_RESULT_HEAD);
  const tail = text.slice(total - TOOL_RESULT_TAIL);
  return `${head}\n[Output truncated: showing first ${TOOL_RESULT_HEAD} and last ${TOOL_RESULT_TAIL} of ${total} total characters]\n${tail}`;
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
  crawl_url:           'AUTO',
  check_injection:     'AUTO',
  write_file:          'LOGGED',
  run_terminal_command:'LOGGED',
  remember:            'LOGGED',
  take_screenshot:     'CONFIRM',
  send_photo:          'LOGGED',
  toggle_think_mode:   'AUTO',
  schedule_task:       'LOGGED',
  list_tasks:          'AUTO',
  cancel_task:         'LOGGED',
  generate_image:      'LOGGED',
  speak:               'LOGGED',
  list_sessions:       'AUTO',
  cleanup_sessions:    'LOGGED',
  export_session:      'AUTO',
  // Media understanding
  understand_image:    'AUTO',
  read_pdf:            'AUTO',
  transcribe_audio:    'AUTO',
  // Approval
  check_command_risk:  'AUTO',
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
  private currentChatId: string | null = null;
  private gateway: TelegramGateway | null = null;

  constructor(
    private agents: AgentManager,
    private memory: MemoryManager,
    private selfAwareness?: SelfAwareness,
    private innerMonologue?: InnerMonologue,
  ) {}

  /** Set the current Telegram context so tools like send_photo know who to reply to */
  setCurrentContext(chatId: string, gateway: TelegramGateway): void {
    this.currentChatId = chatId;
    this.gateway = gateway;
  }

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
      case 'send_photo':          return this.sendPhoto(args);
      case 'get_system_info':     return this.getSystemInfo(args);
      case 'remember':            return this.remember(args);
      case 'recall':              return this.recall(args);
      case 'web_search':          return this.webSearch(args);
      case 'web_fetch':           return this.webFetch(args);
      case 'crawl_url':           return this.crawlUrl(args);
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
      // Media understanding
      case 'understand_image':    return this.understandImage(args);
      case 'read_pdf':            return this.readPdf(args);
      case 'transcribe_audio':    return this.transcribeAudio(args);
      // Execution approval
      case 'check_command_risk':  return this.checkCommandRisk(args);
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

    // Natural-language destructive scope check
    const cmdLower = command.toLowerCase();
    const hasDestructiveVerb = /\b(delete|remove|destroy|erase|wipe|purge)\b/.test(cmdLower);
    const hasHomeScope = /\b(home\s+dir(ectory)?|all\s+files?|everything|~\/|home\s+folder)\b/.test(cmdLower);
    if (hasDestructiveVerb && hasHomeScope) {
      log.warn({ command }, 'Natural-language destructive home-dir command blocked');
      return '⚠️ This command could cause data loss. I won\'t execute destructive operations on your home directory.';
    }

    // Enhanced approval gate — uses risk tier system from security/approval-gate.ts
    const approvalDecision = await checkApproval(command, confirmed);
    if (!approvalDecision.allowed) {
      return approvalDecision.message ?? `Command not allowed: ${approvalDecision.reason}`;
    }

    // Legacy approval gate (belt-and-suspenders for patterns not yet in approval-policy)
    if (!confirmed) {
      const needsApproval = APPROVAL_REQUIRED_COMMANDS.some((pattern) =>
        command.toLowerCase().includes(pattern.toLowerCase()),
      );
      if (needsApproval) {
        log.warn({ command }, 'Command requires approval (legacy gate)');
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

  // ── send_photo ─────────────────────────────────────────────────────

  private async sendPhoto(args: Record<string, unknown>): Promise<string> {
    const filePath = expandPath(String(args.file_path ?? ''));
    const caption = args.caption ? String(args.caption) : undefined;

    if (!filePath) return 'Error: file_path is required';
    if (!this.gateway || !this.currentChatId) {
      return 'Error: No Telegram context available — send_photo can only be used during a conversation';
    }

    try {
      const buffer = await fsReadFile(filePath);
      await this.gateway.sendPhoto(this.currentChatId, buffer, caption);
      return `Photo sent: ${filePath}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error sending photo: ${msg}`;
    }
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

    // Broad identity queries: "everything you know about me", "what do you remember"
    const isBroadIdentityQuery =
      /\b(?:everything|all|anything)\b[\s\S]{0,80}\b(?:you\s+(?:know|remember|recall|learned?|stored?|have)\b[\s\S]{0,40}\b(?:about\s+me|me\b)|about\s+me)\b/i.test(query) ||
      /\bwhat\s+(?:do\s+you|have\s+you)\s+(?:know|remember|stored?|learned?)\b[\s\S]{0,60}\b(?:about\s+me|about\s+the\s+user)\b/i.test(query) ||
      /\btell\s+me\s+(?:everything|all)\b[\s\S]{0,40}\b(?:you\s+(?:know|remember)|about\s+me)\b/i.test(query);

    if (isBroadIdentityQuery) {
      const facts = this.memory.getRelevantFacts('user preference name age hobby like dislike', 30);
      const memoriesByTerm = [
        ...this.memory.recall('remember user', { limit: 20 }),
        ...this.memory.recall('preference like dislike', { limit: 10 }),
        ...this.memory.recall('fact personal', { limit: 10 }),
      ];
      const seen = new Set<string>();
      const allMemories = memoriesByTerm.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      const lines: string[] = [];
      if (facts.length > 0) {
        lines.push(`**Stored facts about you (${facts.length}):**`);
        for (const f of facts) lines.push(`- [${f.category}] ${f.key}: ${f.value}`);
      }
      if (allMemories.length > 0) {
        lines.push(`\n**Memory entries (${allMemories.length}):**`);
        for (const m of allMemories) {
          const summary = m.summary ?? truncate(m.content, 200);
          lines.push(`- [${m.type}/${m.layer}] ${summary}`);
        }
      }
      if (lines.length === 0) {
        return "I don't have any stored information about you yet. You can tell me things with 'Remember that...' and I'll store them.";
      }
      return lines.join('\n');
    }

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
  // Uses DuckDuckGo: tries Instant Answer API first, then HTML scraper.

  private async webSearch(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '');
    if (!query) return 'Error: No query provided';

    const encodedQuery = encodeURIComponent(query);

    // ── Step 1: DuckDuckGo Instant Answer API ─────────────────────
    try {
      const apiUrl = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;
      const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(10_000) });

      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        const results: string[] = [];

        if (data.Abstract && String(data.Abstract).length > 10) {
          results.push(`**Summary:** ${data.Abstract}`);
          if (data.AbstractURL) results.push(`Source: ${data.AbstractURL}`);
        }
        if (data.Answer && String(data.Answer).length > 0) {
          results.push(`**Answer:** ${data.Answer}`);
        }

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
      log.warn({ err }, 'DuckDuckGo Instant API failed — trying HTML scraper');
    }

    // ── Step 2: DDG HTML scraper (OpenClaw pattern) ───────────────
    // html.duckduckgo.com returns a plain HTML page with real search results.
    // Uses Linux Chrome UA (same as OpenClaw) to avoid bot detection.
    try {
      const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}&kl=us-en`;
      const htmlResp = await fetch(htmlUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(20_000),
      });

      if (htmlResp.ok) {
        const html = await htmlResp.text();

        // OpenClaw pattern: detect bot challenge / CAPTCHA page
        const hasBotChallenge = !/class="[^"]*\bresult__a\b[^"]*"/.test(html) &&
          /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i.test(html);

        if (hasBotChallenge) {
          log.warn({}, 'DDG HTML: bot challenge detected, skipping to lite scraper');
        } else {
          // OpenClaw regex-based extraction (faster and more reliable than cheerio for DDG)
          const resultAnchorRe = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
          const snippetRe = /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/gi;

          const links: Array<{ url: string; title: string }> = [];
          const snippets: string[] = [];

          let m: RegExpExecArray | null;
          while ((m = resultAnchorRe.exec(html)) !== null && links.length < 8) {
            const rawHref = m[1];
            const titleHtml = m[2];
            // Decode DDG redirect URL (uddg= param)
            let url = rawHref;
            try {
              const uddg = new URL('https://duckduckgo.com' + (rawHref.startsWith('/') ? rawHref : '/' + rawHref)).searchParams.get('uddg');
              if (uddg) url = uddg;
            } catch {
              const uddgMatch = rawHref.match(/uddg=([^&]+)/);
              if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
            }
            const title = titleHtml.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
            if (title && url) links.push({ url, title });
          }

          while ((m = snippetRe.exec(html)) !== null && snippets.length < 8) {
            const text = m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
            if (text) snippets.push(text);
          }

          if (links.length > 0) {
            const results: string[] = [`DuckDuckGo search results for: "${query}"\n`];
            for (let i = 0; i < Math.min(links.length, 6); i++) {
              results.push(`**${i + 1}. ${links[i].title}**`);
              results.push(`   ${links[i].url}`);
              if (snippets[i]) results.push(`   ${snippets[i]}`);
              results.push('');
            }
            return results.join('\n').trim();
          }
        }
      }
    } catch (err) {
      log.warn({ err }, 'DuckDuckGo HTML scraper failed');
    }

    // ── Step 3: DDG Lite scraper (OpenClaw pattern — lite.duckduckgo.com) ────
    try {
      const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`;
      const liteResp = await fetch(liteUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (liteResp.ok) {
        const html = await liteResp.text();
        const results: string[] = [];

        // DDG Lite: result links have class='result-link', snippets in td class='result-snippet'
        const linkRe = /<a\s[^>]*class=['"]result-link['"][^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const snippetRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

        const links: Array<{ url: string; title: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = linkRe.exec(html)) !== null && links.length < 8) {
          const rawHref = m[1];
          const uddgMatch = rawHref.match(/uddg=([^&]+)/);
          const url = uddgMatch ? decodeURIComponent(uddgMatch[1]) : rawHref;
          const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          if (title && url) links.push({ url, title });
        }

        const snippets: string[] = [];
        while ((m = snippetRe.exec(html)) !== null && snippets.length < 8) {
          const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          if (text) snippets.push(text);
        }

        if (links.length > 0) {
          results.push(`Search results for: "${query}"\n`);
          for (let i = 0; i < Math.min(links.length, 5); i++) {
            results.push(`**${i + 1}. ${links[i].title}**`);
            if (snippets[i]) results.push(snippets[i]);
            results.push(`${links[i].url}\n`);
          }
          return results.join('\n');
        }
      }
    } catch (err) {
      log.warn({ err }, 'DDG Lite scraper failed — falling back to browser');
    }

    // ── Step 4: Last resort — open browser ────────────────────────
    try {
      await execFileAsync('open', [`https://duckduckgo.com/?q=${encodedQuery}`], { timeout: 5_000 });
    } catch {
      // ignore
    }
    return `Couldn't retrieve inline search results for: "${query}". Opened DuckDuckGo in your browser.`;
  }

  // ── web_fetch ──────────────────────────────────────────────────────

  private async webFetch(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '');
    if (!url) return 'Error: No URL provided';

    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
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

  // ── understand_image ───────────────────────────────────────────────

  private async understandImage(args: Record<string, unknown>): Promise<string> {
    const source = String(args.source ?? '');
    const question = args.question ? String(args.question) : undefined;
    if (!source) return 'Error: No image source provided';

    const apiBaseUrl = process.env.OPENAI_BASE_URL ?? process.env.AI_BASE_URL ?? '';
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
    const model = process.env.AI_MODEL ?? 'gemini-2.5-flash';

    if (!apiBaseUrl || !apiKey) {
      return 'Error: Vision API not configured (need OPENAI_BASE_URL + OPENAI_API_KEY or AI_* env vars)';
    }

    try {
      let imageSource = source;
      let isBase64 = false;

      if (source.startsWith('http://') || source.startsWith('https://')) {
        // URL — analyzeImage will fetch it
        isBase64 = false;
      } else if (source.startsWith('/') || source.startsWith('~')) {
        // Local file path — read and convert to base64
        const filePath = expandPath(source);
        const fileBuffer = await fsReadFile(filePath);
        imageSource = fileBuffer.toString('base64');
        isBase64 = true;
      } else {
        // Assume raw base64
        isBase64 = true;
      }

      const result = await analyzeImage({
        source: imageSource,
        isBase64,
        question,
        apiBaseUrl,
        apiKey,
        model,
      });
      return question
        ? `Image analysis — Answer: ${result.answer ?? result.description}`
        : `Image description:\n\n${result.description}`;
    } catch (err) {
      return `Error analyzing image: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── read_pdf ───────────────────────────────────────────────────────

  private async readPdf(args: Record<string, unknown>): Promise<string> {
    const path = args.path ? expandPath(String(args.path)) : undefined;
    const url = args.url ? String(args.url) : undefined;

    if (!path && !url) return 'Error: Provide either path or url for the PDF';

    try {
      const result = path ? await parsePdf(path) : await parsePdfFromUrl(url!);
      const lines = [
        `PDF: ${path ?? url} (${result.pageCount} pages)`,
        result.truncated ? '[Content truncated to 20,000 chars]' : '',
        '',
        result.text,
      ];
      return lines.filter(Boolean).join('\n');
    } catch (err) {
      return `Error reading PDF: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── transcribe_audio ───────────────────────────────────────────────

  private async transcribeAudio(args: Record<string, unknown>): Promise<string> {
    const rawPath = String(args.path ?? '');
    if (!rawPath) return 'Error: No audio file path provided';

    const filePath = expandPath(rawPath);
    const openaiKey = process.env.OPENAI_API_KEY;

    try {
      const result = await transcribeAudio(filePath, openaiKey);
      const lines = [
        `Transcription (method: ${result.method}):`,
        '',
        result.text,
      ];
      return lines.join('\n');
    } catch (err) {
      return `Error transcribing audio: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── crawl_url ──────────────────────────────────────────────────────

  private async crawlUrl(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '');
    if (!url) return 'Error: No URL provided';

    try {
      const result = await crawlUrl(url);
      const lines = [
        `Title: ${result.title}`,
        `URL: ${result.url}`,
        `Words: ${result.wordCount}${result.truncated ? ' (truncated)' : ''}`,
        '',
        '── Content ──',
        result.mainContent,
      ];

      if (result.links.length > 0) {
        lines.push('', '── Links ──');
        for (const link of result.links.slice(0, 10)) {
          lines.push(`• ${link.text} → ${link.href}`);
        }
      }

      return lines.join('\n');
    } catch (err) {
      return `Error crawling URL: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── check_command_risk ─────────────────────────────────────────────

  private checkCommandRisk(args: Record<string, unknown>): string {
    const command = String(args.command ?? '');
    if (!command) return 'Error: No command provided';

    const result = classifyCommand(command);
    return [
      `Risk assessment for: \`${command}\``,
      `Tier: ${result.tier}`,
      `Reason: ${result.reason}`,
      result.matchedPattern ? `Matched: ${result.matchedPattern}` : '',
      '',
      result.tier === 'BLOCKED'
        ? '⛔ This command will be refused.'
        : result.tier === 'DANGEROUS'
          ? '⚠️ This command requires approval (confirmed=true) or allowlisting.'
          : result.tier === 'MODERATE'
            ? '📝 This command will run but will be logged.'
            : '✅ This command is safe to run.',
    ].filter(Boolean).join('\n');
  }
}
