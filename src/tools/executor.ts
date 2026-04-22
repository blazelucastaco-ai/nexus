// Tool executor — maps structured tool calls to concrete implementations.
// Bridge between Claude's function calling and NEXUS's agent system.

import { homedir, tmpdir } from 'node:os';
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  rename as fsRename,
  readdir,
  stat,
  mkdir,
  chmod,
} from 'node:fs/promises';
import { join, dirname, resolve, extname, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';
import { nowISO, truncate } from '../utils/helpers.js';
import { detectInjection, sanitizeInput } from '../brain/injection-guard.js';
import type { SelfAwareness } from '../brain/self-awareness.js';
import type { InnerMonologue } from '../brain/inner-monologue.js';
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
import { events } from '../core/events.js';
import { isNexusSourcePath, SELF_PROTECTION_ERROR, getNexusSourceDir } from '../core/self-protection.js';
import { extractCommandHeads } from '../security/shell-parser.js';

const log = createLogger('ToolExecutor');
const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 200_000;
const TOOL_RESULT_MAX = 8_000;
const TOOL_RESULT_HEAD = 3_000;
const TOOL_RESULT_TAIL = 3_000;

// Hoisted to module scope (FIND-PRF-02): was being rebuilt per call inside
// truncateToolResult, which runs once per tool result (3–5× per request).
// Reset .lastIndex before each use.
const TOOL_RESULT_ERROR_PATTERNS =
  /^.*(error|Error|ERROR|warning|Warning|WARN|failed|Failed|FAILED|cannot|Cannot|ENOENT|EACCES|EPERM|not found|TypeError|SyntaxError|ReferenceError|Module not found|Could not resolve|✗|✘|FATAL).*$/gm;
const MAX_ERROR_CHARS = 1500;

/**
 * Smart truncation for tool results.
 * Strategy: keep head, tail, AND any error lines from the middle.
 * JSON results are never truncated.
 */
function truncateToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX) return text;

  // Don't truncate JSON — cutting inside a string produces invalid JSON the LLM can't use
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return text;

  const total = text.length;
  const head = text.slice(0, TOOL_RESULT_HEAD);
  const tail = text.slice(total - TOOL_RESULT_TAIL);

  // Extract error-relevant lines from the middle section
  const middle = text.slice(TOOL_RESULT_HEAD, total - TOOL_RESULT_TAIL);
  TOOL_RESULT_ERROR_PATTERNS.lastIndex = 0;
  const errorLines: string[] = [];
  let match: RegExpExecArray | null;
  let errorChars = 0;
  while ((match = TOOL_RESULT_ERROR_PATTERNS.exec(middle)) !== null) {
    const line = match[0].trim();
    if (line.length > 0 && errorChars + line.length < MAX_ERROR_CHARS) {
      errorLines.push(line);
      errorChars += line.length;
    }
  }

  const errorSection = errorLines.length > 0
    ? `\n[${errorLines.length} error/warning lines from middle section:]\n${errorLines.join('\n')}\n`
    : '';

  return `${head}\n[Output truncated: showing first ${TOOL_RESULT_HEAD} and last ${TOOL_RESULT_TAIL} of ${total} total chars]${errorSection}\n${tail}`;
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
  check_updates:       'AUTO',
  web_search:          'AUTO',
  web_fetch:           'AUTO',
  crawl_url:           'AUTO',
  check_injection:     'AUTO',
  write_file:          'LOGGED',
  run_terminal_command:'LOGGED',
  run_background_command:'LOGGED',
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
  // Media understanding
  understand_image:    'AUTO',
  read_pdf:            'AUTO',
  transcribe_audio:    'AUTO',
  // Approval
  check_command_risk:  'AUTO',
  // Chrome Browser Control
  browser_navigate:       'AUTO',
  browser_extract:        'AUTO',
  browser_screenshot:     'AUTO',
  browser_scroll:         'AUTO',
  browser_wait_for:       'AUTO',
  browser_wait_for_url:   'AUTO',
  browser_get_info:       'AUTO',
  browser_get_tabs:       'AUTO',
  browser_back:           'AUTO',
  browser_forward:        'AUTO',
  browser_reload:         'AUTO',
  browser_dismiss_cookies:   'AUTO',
  browser_suppress_dialogs:  'AUTO',
  browser_hover:          'LOGGED',
  browser_click:          'LOGGED',
  browser_type:           'LOGGED',
  browser_press_key:      'LOGGED',
  browser_evaluate:       'LOGGED',
  browser_new_tab:        'LOGGED',
  browser_close_tab:      'LOGGED',
  browser_fill_form:      'LOGGED',
  browser_switch_tab:     'LOGGED',
  browser_select:         'LOGGED',
  browser_clear:          'LOGGED',
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

/**
 * True if a shell command string appears to target the NEXUS source tree —
 * either by referencing the source directory directly, or by naming one of
 * the internal source-file paths (e.g. `cat src/brain/orchestrator.ts`).
 * Heuristic — not bulletproof, but catches the obvious cases.
 */
function commandTargetsNexusSource(command: string): boolean {
  if (!command) return false;
  const sourceDir = getNexusSourceDir();
  if (sourceDir && sourceDir !== '__NEXUS_SOURCE_UNKNOWN__') {
    // Absolute path reference — require a path separator or word boundary
    // AFTER the source dir, otherwise sibling folders like
    // `/Users/you/nexus-workspace/` would falsely match `/Users/you/nexus`.
    const escaped = sourceDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sourceDirRegex = new RegExp(`${escaped}(?:/|\\s|$|['"\`])`);
    if (sourceDirRegex.test(command)) return true;
    // ~/<last-segment-of-source> reference, e.g. ~/nexus or ~/nexus/src
    const base = sourceDir.split('/').pop();
    if (base && new RegExp(`(?:^|[\\s'"\`])~?\\/?${base}(?:\\/|[\\s'"\`$]|$)`).test(command)) {
      // Only block if it's clearly pointing into the source tree (not just mentioning "nexus")
      if (/\b(?:src|tests|scripts|dist|node_modules)\b/.test(command)) return true;
    }
  }
  // Relative internal module paths
  if (/\bsrc\/(?:brain|core|ai|memory|telegram|agents|tools|data|personality|learning|macos|media|browser|utils|skills)\//.test(command)) {
    return true;
  }
  return false;
}

/** Validate that a file path is within allowed boundaries (home dir or /tmp),
 *  AND is not inside the NEXUS source tree (self-protection, L3).
 *  Uses realpath-canonicalized parent-dir check to defeat symlink-traversal
 *  attacks where ~/link → /etc and a write would land outside home. */
function validateFilePath(filePath: string): string | null {
  const resolved = resolve(filePath);
  const home = homedir();
  if (isNexusSourcePath(resolved)) {
    log.warn({ filePath: resolved }, 'Self-protection: blocked access to NEXUS source');
    return SELF_PROTECTION_ERROR;
  }
  // Canonicalize the PARENT dir. If the parent is a symlink pointing outside
  // home/tmp, we need to detect that before allowing the write.
  let canonicalParent = dirname(resolved);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { realpathSync } = require('node:fs') as typeof import('node:fs');
  try {
    canonicalParent = realpathSync(canonicalParent);
  } catch {
    // Parent doesn't exist yet (recursive mkdir will create it). In that case,
    // we fall back to the resolved parent; the normal home/tmp check below
    // still applies.
  }
  const canonicalTarget = join(canonicalParent, resolved.slice(dirname(resolved).length + 1));
  if (isNexusSourcePath(canonicalTarget)) {
    log.warn({ filePath: canonicalTarget }, 'Self-protection: blocked symlink-traversal into NEXUS source');
    return SELF_PROTECTION_ERROR;
  }
  // macOS resolves /tmp -> /private/tmp via a symlink, and os.tmpdir()
  // returns /var/folders/... for per-user temp which realpath()s to
  // /private/var/folders/... We accept both the resolved and un-resolved
  // forms because the target path may not exist yet (and so dirname walk
  // can't canonicalize it), which means we can't force one or the other.
  let osTmpReal: string;
  try { osTmpReal = realpathSync(tmpdir()); }
  catch { osTmpReal = tmpdir(); }
  const osTmpRaw = tmpdir();

  const inTmp = (p: string): boolean =>
    p.startsWith('/tmp/') || p === '/tmp' ||
    p.startsWith('/private/tmp/') || p === '/private/tmp' ||
    p.startsWith(osTmpReal + sep) || p === osTmpReal ||
    p.startsWith(osTmpRaw + sep) || p === osTmpRaw;

  const allowed =
    canonicalTarget.startsWith(home) ||
    resolved.startsWith(home) ||
    inTmp(canonicalTarget) ||
    inTmp(resolved);
  if (!allowed) {
    return `Error: Path "${resolved}" is outside allowed directories (home directory or tmp). Refusing to write.`;
  }
  return null;
}

/**
 * Post-write syntax check for common code file types.
 * Returns a warning string if syntax errors are found, null if clean.
 * Never throws — syntax check failure is non-fatal.
 */
async function checkSyntax(filePath: string, content: string): Promise<string | null> {
  const ext = extname(filePath).toLowerCase();
  try {
    if (ext === '.ts' || ext === '.tsx') {
      // TypeScript: use tsc --noEmit. Pass filePath via argv to avoid shell injection.
      const { stderr } = await execFileAsync(
        'npx', ['--yes', 'tsc', '--noEmit', '--allowJs', '--checkJs', 'false',
          '--strict', 'false', '--skipLibCheck', '--target', 'ES2022',
          '--moduleResolution', 'node', filePath],
        { timeout: 15_000, maxBuffer: 1_000_000,
          env: { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ''}` } },
      ).catch((e: unknown) => ({ stderr: e instanceof Error ? e.message : String(e), stdout: '' }));
      if (stderr && stderr.includes('error TS')) {
        return stderr.split('\n').filter((l: string) => l.includes('error TS')).slice(0, 3).join('; ');
      }
    } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const result = await execFileAsync('node', ['--check', filePath], { timeout: 10_000, maxBuffer: 100_000 })
        .catch((e: unknown) => ({ stderr: e instanceof Error ? e.message : String(e), stdout: '' }));
      if ('stderr' in result && result.stderr) return result.stderr.split('\n')[0] ?? null;
    } else if (ext === '.py') {
      const result = await execFileAsync('python3', ['-m', 'py_compile', filePath], { timeout: 10_000, maxBuffer: 100_000 })
        .catch((e: unknown) => ({ stderr: e instanceof Error ? e.message : String(e), stdout: '' }));
      if ('stderr' in result && result.stderr) return result.stderr.split('\n').slice(0, 2).join(' ');
    } else if (ext === '.sh' || ext === '.bash') {
      const result = await execFileAsync('/bin/bash', ['-n', filePath], { timeout: 5_000, maxBuffer: 100_000 })
        .catch((e: unknown) => ({ stderr: e instanceof Error ? e.message : String(e), stdout: '' }));
      if ('stderr' in result && result.stderr) return result.stderr.split('\n')[0] ?? null;
    } else if (ext === '.json') {
      try { JSON.parse(content); } catch (e) { return e instanceof Error ? e.message : 'Invalid JSON'; }
    }
  } catch {
    // Syntax check failure is non-fatal
  }
  return null;
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

  /**
   * When set, returns the active project's disk path (or null if no active
   * project). Used to resolve bare/relative write_file paths so files land
   * in the project directory instead of $HOME — honors the "## Active
   * Project" promise made in the system prompt.
   */
  private activeProjectPath?: () => string | null;

  constructor(
    private agents: AgentManager,
    private memory: MemoryManager,
    private selfAwareness?: SelfAwareness,
    private innerMonologue?: InnerMonologue,
  ) {}

  /** Inject an accessor for the orchestrator's current active project. */
  setActiveProjectPath(resolver: () => string | null): void {
    this.activeProjectPath = resolver;
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
      try { hook(toolName, args); } catch (e) { log.warn({ err: e, toolName }, 'Before-hook threw; ignored'); }
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

    // Emit structured event so subscribers (journal, metrics, proactive) can react
    // without needing hook registration in orchestrator.init.
    const success = !result.startsWith('Error:') && !result.startsWith('Command rejected');
    if (success) {
      events.emit({ type: 'tool.executed', toolName, success, durationMs: duration, resultLen: result.length, params: args });
    } else {
      events.emit({ type: 'tool.error', toolName, error: result.slice(0, 200), params: args });
    }

    // FIX 3: Call after-hooks with result
    for (const hook of this.afterHooks) {
      try { hook(toolName, args, result); } catch (e) { log.warn({ err: e, toolName }, 'After-hook threw; ignored'); }
    }

    return result;
  }

  private async runTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case 'run_terminal_command': return this.runTerminalCommand(args);
      case 'run_background_command': return this.runBackgroundCommand(args);
      case 'write_file':          return this.writeFile(args);
      case 'read_file':           return this.readFile(args);
      case 'list_directory':      return this.listDirectory(args);
      case 'take_screenshot':     return this.takeScreenshot();
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
      case 'check_updates':       return this.checkUpdates();
      case 'check_command_risk':  return this.checkCommandRisk(args);
      // Chrome Browser Control
      case 'browser_navigate':         return this.runBrowserTool('navigate',        args);
      case 'browser_extract':          return this.runBrowserTool('extract',         args);
      case 'browser_click':            return this.runBrowserTool('click',           args);
      case 'browser_hover':            return this.runBrowserTool('hover',           args);
      case 'browser_type':             return this.runBrowserTool('type',            args);
      case 'browser_press_key':        return this.runBrowserTool('press_key',       args);
      case 'browser_screenshot':       return this.runBrowserTool('screenshot',      {});
      case 'browser_scroll':           return this.runBrowserTool('scroll',          args);
      case 'browser_evaluate':         return this.runBrowserTool('evaluate',        args);
      case 'browser_wait_for':         return this.runBrowserTool('wait_for',        args);
      case 'browser_wait_for_url':     return this.runBrowserTool('wait_for_url',    args);
      case 'browser_dismiss_cookies':   return this.runBrowserTool('dismiss_cookies',  {});
      case 'browser_suppress_dialogs':  return this.runBrowserTool('suppress_dialogs', {});
      case 'browser_get_info':         return this.runBrowserTool('get_info',        {});
      case 'browser_get_tabs':         return this.runBrowserTool('get_tabs',        {});
      case 'browser_new_tab':          return this.runBrowserTool('new_tab',         args);
      case 'browser_close_tab':        return this.runBrowserTool('close_tab',       args);
      case 'browser_fill_form':        return this.runBrowserToolFillForm(args);
      case 'browser_back':             return this.runBrowserTool('back',            {});
      case 'browser_forward':          return this.runBrowserTool('forward',         {});
      case 'browser_reload':           return this.runBrowserTool('reload',          {});
      case 'browser_switch_tab':       return this.runBrowserTool('switch_tab',      args);
      case 'browser_select':           return this.runBrowserTool('select',          args);
      case 'browser_clear':            return this.runBrowserTool('clear',           args);
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
    const timeoutMs = Math.max(1_000, Math.min(300_000, Number(args.timeout ?? 30_000)));
    const cwd = args.cwd ? expandPath(String(args.cwd)) : undefined;
    const confirmed = args.confirmed === true || args.confirmed === 'true';

    if (!command) return 'Error: No command provided';

    // L3: self-protection — block commands that target the NEXUS source tree
    // via cwd, or reference source paths in the command string itself.
    if (cwd && isNexusSourcePath(cwd)) {
      log.warn({ cwd, command: command.slice(0, 80) }, 'Self-protection: blocked terminal cwd in NEXUS source');
      return SELF_PROTECTION_ERROR;
    }
    if (commandTargetsNexusSource(command)) {
      log.warn({ command: command.slice(0, 80) }, 'Self-protection: blocked terminal command targeting NEXUS source');
      return SELF_PROTECTION_ERROR;
    }

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

    // Legacy approval gate (belt-and-suspenders for patterns not yet in approval-policy).
    // Intentionally does NOT honor `confirmed` — that flag is LLM-settable and
    // would let a prompt-injection bypass this gate. If the command matches a
    // legacy-approval pattern, we return a message that tells the LLM to ask
    // the user; the user can either run it manually or add an allowlist entry.
    {
      const needsApproval = APPROVAL_REQUIRED_COMMANDS.some((pattern) =>
        command.toLowerCase().includes(pattern.toLowerCase()),
      );
      if (needsApproval) {
        log.warn({ command }, 'Command requires approval (legacy gate)');
        return (
          `⚠️ This command matches a high-risk pattern and cannot be run automatically:\n\n\`${command}\`\n\n` +
          `Explain the risk to the user and let them decide. If they want this to run, they can execute it manually in their own terminal, or add it to ~/.nexus/allowlist.json and ask you to try again.`
        );
      }
    }

    // FIX 2: argv-level safety checks — validate EVERY command head in the
    // chain (`;`, `&&`, `||`, `|`, `&`, `$(...)`, backticks), not just the
    // first token. Previously we only checked argv[0]; `echo ok; shutdown -h`
    // passed the check because argv[0] was "echo". See CRIT-1 / shell-parser.ts.
    const heads = extractCommandHeads(command);
    for (const head of heads) {
      if (ARGV_BLOCKLIST.has(head)) {
        log.warn({ command: command.slice(0, 200), head }, 'Argv blocklist rejected a chained head');
        return `Command rejected as dangerous: "${head}" is in the command blocklist`;
      }
    }
    const argv = command.split(/\s+/).filter(Boolean);
    const cmd = argv[0] ?? '';

    // Detect inline code execution — flag as elevated risk but allow.
    // Inline-exec detection still looks at the outer command only, since the
    // argv blocklist already defends against chained interpreters.
    const inlineFlags = INLINE_EXEC_FLAGS[cmd];
    if (inlineFlags && argv.some((p) => inlineFlags.includes(p))) {
      log.warn({ command, argv }, 'Elevated-risk: inline code execution via interpreter flag (-c/-e)');
    }

    // Log full argv for all commands
    log.info({ argv, cwd }, 'Running command (full argv)');

    // Source user shell config so nvm, pyenv, rbenv, and project PATH entries work.
    // We run as a login shell (-l) AND explicitly source .zshrc for interactive-only setups.
    const wrappedCommand = `source ~/.zshrc 2>/dev/null; source ~/.zprofile 2>/dev/null; ${command}`;

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      const result = await execFileAsync('/bin/zsh', ['-l', '-c', wrappedCommand], {
        timeout: timeoutMs,
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: `/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ''}`,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      // execFileAsync throws on non-zero exit — extract stdout/stderr and report cleanly
      if (err && typeof err === 'object' && 'stdout' in err && 'stderr' in err) {
        const execErr = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string };
        stdout = execErr.stdout ?? '';
        stderr = execErr.stderr ?? '';
        exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
        if (execErr.killed) {
          return `Error: Command timed out after ${timeoutMs / 1000}s and was killed.\n${stderr ? `STDERR:\n${cleanTruncate(stderr.trim())}` : ''}`.trim();
        }
      } else {
        throw err; // unexpected error, let outer handler deal with it
      }
    }

    const out = cleanTruncate(stdout.trim());
    const err2 = stderr.trim();

    if (exitCode !== 0) {
      // Non-zero exit — return both output and exit code so LLM knows to fix
      const parts: string[] = [];
      if (out) parts.push(out);
      if (err2) parts.push(`STDERR:\n${err2}`);
      parts.push(`\nExit code: ${exitCode}`);
      return parts.join('\n\n');
    }

    if (out && err2) return `${out}\n\nSTDERR:\n${err2}`;
    if (out) return out;
    if (err2) return `STDERR:\n${err2}`;
    return '(command completed with no output)';
  }

  // ── run_background_command ──────────────────────────────────────────
  // Starts a command in the background (e.g. dev servers, watchers).
  // Returns immediately with PID. Captures initial output (first 3s).

  private backgroundProcesses = new Map<number, { command: string; startedAt: string }>();

  private async runBackgroundCommand(args: Record<string, unknown>): Promise<string> {
    const { spawn } = await import('node:child_process');
    const command = String(args.command ?? '');
    const cwd = args.cwd ? expandPath(String(args.cwd)) : undefined;

    if (!command) return 'Error: No command provided';

    if (DANGEROUS_PATTERNS.some((p) => p.test(command))) {
      return `Command rejected as dangerous: ${command}`;
    }

    const wrappedCommand = `source ~/.zshrc 2>/dev/null; source ~/.zprofile 2>/dev/null; ${command}`;

    const child = spawn('/bin/zsh', ['-l', '-c', wrappedCommand], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ''}`,
        TERM: 'xterm-256color',
      },
    });

    child.unref();
    const pid = child.pid ?? 0;

    // Capture initial output (first 3 seconds) to detect startup errors
    let initialOutput = '';
    let initialError = '';
    const captureTimeout = 3000;

    const outputPromise = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('started'), captureTimeout);

      child.stdout?.on('data', (chunk: Buffer) => {
        initialOutput += chunk.toString();
        if (initialOutput.length > 2000) initialOutput = initialOutput.slice(0, 2000);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        initialError += chunk.toString();
        if (initialError.length > 2000) initialError = initialError.slice(0, 2000);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? 'exited-ok' : `exited-${code}`);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve(`error: ${err.message}`);
      });
    });

    const status = await outputPromise;

    this.backgroundProcesses.set(pid, { command, startedAt: new Date().toISOString() });

    const parts = [`Background process started (PID: ${pid})`];
    if (status.startsWith('exited')) {
      parts[0] = `Process exited immediately (${status})`;
    }
    if (initialOutput.trim()) parts.push(`Initial output:\n${initialOutput.trim()}`);
    if (initialError.trim()) parts.push(`Initial stderr:\n${initialError.trim()}`);

    return parts.join('\n\n');
  }

  // ── write_file ─────────────────────────────────────────────────────

  // Undo stack: snapshots of the last N files we wrote/modified.
  // Each entry: { path, previousContent (null if file didn't exist), timestamp }
  private undoStack: Array<{ path: string; previousContent: string | null; timestamp: number }> = [];
  private static readonly MAX_UNDO_ENTRIES = 50;

  /** Return a copy of the undo stack (newest last). */
  getUndoStack(): Array<{ path: string; hadPrevious: boolean; timestamp: number }> {
    return this.undoStack.map((e) => ({ path: e.path, hadPrevious: e.previousContent !== null, timestamp: e.timestamp }));
  }

  /**
   * Restore the most recent file change. Returns a human-readable result.
   * If the file was newly created, deletes it. If modified, restores previous content.
   */
  async undoLastWrite(): Promise<string> {
    const entry = this.undoStack.pop();
    if (!entry) return 'Nothing to undo.';

    try {
      if (entry.previousContent === null) {
        // File was newly created — delete it
        const { unlink } = await import('node:fs/promises');
        await unlink(entry.path);
        return `Undid: deleted ${entry.path} (was newly created)`;
      }
      // File was modified — restore previous content
      await fsWriteFile(entry.path, entry.previousContent, 'utf-8');
      return `Undid: restored previous content of ${entry.path} (${entry.previousContent.length} bytes)`;
    } catch (err) {
      return `Undo failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async writeFile(args: Record<string, unknown>): Promise<string> {
    let rawPath = String(args.path ?? '');
    // Content arrives via JSON.parse() so actual newlines are already real newlines.
    // Do NOT unescape \n — that would corrupt Python/bash string literals like print("hello\nworld").
    const content = String(args.content ?? '');
    const executable = args.executable === true || args.executable === 'true';

    if (!rawPath) return 'Error: No path provided';

    // Active-project default: if the LLM passes a bare or relative path and
    // an active project is set, anchor the write under the project directory.
    // Absolute paths (/...) and home-relative paths (~/...) pass through
    // unchanged — the LLM made an explicit choice.
    if (this.activeProjectPath && !rawPath.startsWith('/') && !rawPath.startsWith('~')) {
      const projectDir = this.activeProjectPath();
      if (projectDir) {
        const anchored = `${projectDir.replace(/\/$/, '')}/${rawPath.replace(/^\.?\//, '')}`;
        log.info({ original: rawPath, anchored, projectDir }, 'write_file: anchoring bare path under active project');
        rawPath = anchored;
      }
    }

    // Guard against writing empty files (common LLM mistake when context is truncated)
    if (content.length === 0) {
      return 'Error: write_file called with empty content. Provide the full file content.';
    }

    // Guard against excessively large writes that could OOM the process
    const MAX_WRITE_BYTES = 10 * 1024 * 1024; // 10 MB
    if (content.length > MAX_WRITE_BYTES) {
      return `Error: Content too large (${(content.length / 1024 / 1024).toFixed(1)} MB). Max write size is 10 MB. Split into multiple files.`;
    }

    const filePath = expandPath(rawPath);

    // Security: prevent writes outside home directory or /tmp
    const pathError = validateFilePath(filePath);
    if (pathError) return pathError;

    // ALWAYS create parent directories first — prevents ENOENT permanently
    await mkdir(dirname(filePath), { recursive: true });

    // Snapshot previous content for /undo. Read-before-write is cheap for small files
    // and prevents data loss. Null means the file didn't exist (undo = delete).
    // Cap snapshot size to 1 MB — larger files are skipped for /undo purposes.
    let previousContent: string | null = null;
    try {
      const { stat, readFile } = await import('node:fs/promises');
      const s = await stat(filePath);
      if (s.size <= 1_000_000) {
        previousContent = await readFile(filePath, 'utf-8');
      }
    } catch {
      // File didn't exist — previousContent stays null, undo will delete
    }

    // Atomic write: write to temp file, then rename. Prevents partial writes corrupting files.
    const tmpPath = `${filePath}.nexus-tmp-${Date.now()}`;
    try {
      await fsWriteFile(tmpPath, content, 'utf-8');
      await fsRename(tmpPath, filePath);
    } catch (err) {
      // Clean up temp file if rename fails
      try { await fsWriteFile(filePath, content, 'utf-8'); } catch { /* ignore */ }
      try { const { unlink } = await import('node:fs/promises'); await unlink(tmpPath); } catch { /* ignore */ }
      if (err instanceof Error && !err.message.includes('EXDEV')) throw err;
    }

    if (executable) {
      await chmod(filePath, 0o755);
    }

    const info = await stat(filePath);
    const sizeKB = (info.size / 1024).toFixed(1);
    const lineCount = content.split('\n').length;
    log.info({ path: filePath, size: info.size }, 'File written via tool');

    // Push snapshot to undo stack (FIFO, capped)
    this.undoStack.push({ path: filePath, previousContent, timestamp: Date.now() });
    if (this.undoStack.length > ToolExecutor.MAX_UNDO_ENTRIES) this.undoStack.shift();

    // Post-write syntax check for common code file types
    const syntaxWarning = await checkSyntax(filePath, content);
    const syntaxNote = syntaxWarning ? `\n⚠️  Syntax warning: ${syntaxWarning}` : '';

    return `File written successfully: ${rawPath} (${sizeKB} KB, ${lineCount} lines${executable ? ', executable' : ''})${syntaxNote}`;
  }

  // ── read_file ──────────────────────────────────────────────────────

  private async readFile(args: Record<string, unknown>): Promise<string> {
    const rawPath = String(args.path ?? '');
    if (!rawPath) return 'Error: No path provided';

    const filePath = expandPath(rawPath);

    // L3: self-protection — refuse to read NEXUS source files.
    if (isNexusSourcePath(filePath)) {
      log.warn({ filePath }, 'Self-protection: blocked read of NEXUS source');
      return SELF_PROTECTION_ERROR;
    }

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

    // L3: self-protection — refuse to list NEXUS source tree.
    if (isNexusSourcePath(dir)) {
      log.warn({ dir }, 'Self-protection: blocked list of NEXUS source');
      return SELF_PROTECTION_ERROR;
    }

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

    // Embedding is generated by MemoryManager.store() automatically — no manual step needed here
    log.info({ content: truncate(content, 80) }, 'Stored memory via tool');
    return `Memory stored successfully. Tell the user: "Stored: ${truncate(content, 150)}"`;
  }

  // ── recall ─────────────────────────────────────────────────────────

  private async recall(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '');
    if (!query) return 'Error: No query provided';

    // Broad identity queries: "everything you know about me", "what do you remember"
    const isBroadIdentityQuery =
      /\b(?:everything|all|anything)\b[\s\S]{0,80}\b(?:you\s+(?:know|remember|recall|learned?|stored?|have)\b[\s\S]{0,40}\b(?:about\s+me|me\b)|about\s+me)\b/i.test(query) ||
      /\bwhat\s+(?:do\s+you|have\s+you)\s+(?:know|remember|stored?|learned?)\b[\s\S]{0,60}\b(?:about\s+me|about\s+the\s+user)\b/i.test(query) ||
      /\btell\s+me\s+(?:everything|all)\b[\s\S]{0,40}\b(?:you\s+(?:know|remember)|about\s+me)\b/i.test(query);

    if (isBroadIdentityQuery) {
      const facts = this.memory.getRelevantFacts('user preference name age hobby like dislike', 30);
      const [r1, r2, r3] = await Promise.all([
        this.memory.recall('remember user', { limit: 20 }),
        this.memory.recall('preference like dislike', { limit: 10 }),
        this.memory.recall('fact personal', { limit: 10 }),
      ]);
      const memoriesByTerm = [...r1, ...r2, ...r3];
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

    const memories = await this.memory.recall(query, { limit: 8 });
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
  // L3/L4: NEXUS's introspection report includes only runtime statistics
  // (heap, uptime, memory counts, emotional state). Source paths, commit
  // hashes, branch, and version are scrubbed from the report and are NOT
  // accessible via this tool. If the caller needs maintenance info, they
  // can use the SelfAwareness class directly from orchestrator code.

  private introspect(): string {
    if (!this.selfAwareness) {
      return 'Self-awareness module not initialized.';
    }
    return this.selfAwareness.getSelfReport();
  }

  // ── check_updates ──────────────────────────────────────────────────
  // Refuses to expose commit/branch info to the LLM. Lucas can invoke this
  // directly via CLI/maintenance hooks; it should never be surfaced in a
  // chat response.

  private checkUpdates(): string {
    log.warn('check_updates tool called — self-protection refusing');
    return SELF_PROTECTION_ERROR;
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

    // ── Step 2: DDG HTML scraper ───────────────
    // html.duckduckgo.com returns a plain HTML page with real search results.
    // Uses Linux Chrome UA to avoid bot detection.
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

        // Detect bot challenge / CAPTCHA page
        const hasBotChallenge = !/class="[^"]*\bresult__a\b[^"]*"/.test(html) &&
          /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i.test(html);

        if (hasBotChallenge) {
          log.warn({}, 'DDG HTML: bot challenge detected, skipping to lite scraper');
        } else {
          // Regex-based extraction (faster and more reliable than cheerio for DDG)
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

    // ── Step 3: DDG Lite scraper (lite.duckduckgo.com) ────
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
    const olderThanDays = Math.max(0, Number(args.days ?? 7));
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
    const { resolve: resolvePath } = await import('node:path');
    const sessDir = join(homedir(), '.nexus', 'sessions');
    const candidate = join(sessDir, id.endsWith('.json') ? id : `${id}.json`);
    // Prevent path traversal — session file must stay inside sessDir
    if (!resolvePath(candidate).startsWith(resolvePath(sessDir) + '/') &&
        resolvePath(candidate) !== resolvePath(sessDir)) {
      return 'Error: Invalid session id';
    }
    const sessFile = candidate;

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

    if (!process.env.ANTHROPIC_API_KEY) {
      return 'Error: ANTHROPIC_API_KEY is not set — cannot analyze image';
    }

    try {
      let imageSource = source;
      let isBase64 = false;

      let mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' = 'image/jpeg';
      if (source.startsWith('http://') || source.startsWith('https://')) {
        isBase64 = false;
      } else if (source.startsWith('/') || source.startsWith('~')) {
        // Local file — read and pass as base64
        const filePath = expandPath(source);
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        if (ext === 'png') mimeType = 'image/png';
        else if (ext === 'gif') mimeType = 'image/gif';
        else if (ext === 'webp') mimeType = 'image/webp';
        const fileBuffer = await fsReadFile(filePath);
        imageSource = fileBuffer.toString('base64');
        isBase64 = true;
      } else {
        // Assume raw base64
        isBase64 = true;
      }

      const result = await analyzeImage({ source: imageSource, isBase64, mimeType, question });
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

  // ── Chrome Browser Control ──────────────────────────────────────────

  private async runBrowserTool(action: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.agents.dispatch('browser', action, args);
    if (!result.success) {
      return `Browser error: ${result.error ?? 'Extension not connected or command failed'}`;
    }
    return typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
  }

  /**
   * browser_fill_form accepts fields as either a parsed array or a JSON string.
   * The LLM passes it as a JSON string in the tool arguments.
   */
  private async runBrowserToolFillForm(args: Record<string, unknown>): Promise<string> {
    let fields = args.fields;
    if (typeof fields === 'string') {
      try { fields = JSON.parse(fields); } catch {
        return 'Browser error: fields must be a valid JSON array of {selector, value} objects';
      }
    }
    return this.runBrowserTool('fill_form', { fields });
  }
}
