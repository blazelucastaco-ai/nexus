// Task Overlay Bridge — broadcasts task lifecycle events over a local
// WebSocket so the installer-app's overlay window can render orange-tint
// + pill-bar + confetti during tasks. the user asked for this on 2026-05-11.
//
// Subscribes to: task.planned, task.step.started, task.step.completed,
// task.completed. Pushes a thin JSON event to every connected client.
// No back-channel from client → daemon: pure outbound. Origin-restricted
// to loopback so non-localhost clients can't subscribe.

import { WebSocketServer, WebSocket } from 'ws';
import { events, type Subscription } from './events.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('TaskOverlayBridge');

export const TASK_OVERLAY_PORT = 9339;
const MAX_CLIENTS = 4; // Realistically just installer-app menubar + maybe a dev viewer

export interface OverlayEvent {
  /** ISO timestamp when the event was emitted */
  t: string;
  /** Event kind — maps to the orchestrator's internal event types */
  kind:
    | 'task.planned'    // task is starting; pill bar should appear
    | 'task.step'       // step text update (tool name or task step title)
    | 'task.completed'; // task is done; pill bar slides out + confetti
  /** Human-readable status text for the pill bar */
  text: string;
  /** Optional structured payload */
  meta?: Record<string, unknown>;
}

// Tool names that are "real work" (write files, run shell, drive GUI,
// browser, AppleScript). Quiet lookup tools (read_file, recall,
// check_injection, etc.) are filtered out so the overlay doesn't flash
// on every chat-mode response that did a tiny lookup. The overlay
// represents user-perceptible work, not internal bookkeeping.
const OVERLAY_WORK_TOOLS = new Set([
  'write_file', 'run_terminal_command', 'run_background_command',
  'click_at', 'double_click_at', 'move_mouse', 'type_text', 'press_keys',
  'scroll_at', 'open_app', 'activate_app', 'quit_app', 'set_clipboard',
  'run_applescript', 'browser_navigate', 'browser_extract', 'browser_click',
  'browser_hover', 'browser_type', 'browser_get_text', 'browser_screenshot',
  'browser_press_key', 'browser_wait_for_url', 'browser_dismiss_cookies',
  'browser_clear', 'browser_fill_form', 'take_screenshot',
  'generate_image', 'speak', 'web_fetch', 'crawl_url', 'web_search',
  'start_task', 'start_ultra_task', 'remember',
]);

// Human-readable label for a tool the overlay shows in the pill. the user
// asked for friendly phrases like "checking downloads folder" instead
// of the raw shell command. So for run_terminal_command we infer intent
// from the command verb + path/target rather than dumping the literal
// string. Anything we can't classify falls back to a generic label.
function pillTextForTool(name: string, params?: Record<string, unknown>): string {
  const arg = (k: string) => (params && typeof params[k] === 'string' ? String(params[k]) : '');
  switch (name) {
    case 'run_terminal_command':
    case 'run_background_command':
      return friendlyShellLabel(arg('command'));
    case 'write_file':       return writeFileLabel(arg('path'));
    case 'read_file':        return `Reading a file`; // (filtered out of OVERLAY_WORK_TOOLS but kept for safety)
    case 'open_app':         return `Opening ${arg('name') || 'an app'}`;
    case 'activate_app':     return `Switching to ${arg('name') || 'app'}`;
    case 'quit_app':         return `Closing ${arg('name') || 'app'}`;
    case 'click_at':         return `Clicking on screen`;
    case 'double_click_at':  return `Clicking on screen`;
    case 'move_mouse':       return `Moving mouse`;
    case 'type_text':        return `Typing`;
    case 'press_keys':       return `Using keyboard shortcut`;
    case 'scroll_at':        return `Scrolling`;
    case 'set_clipboard':    return `Copying to clipboard`;
    case 'run_applescript':  return `Working with your apps`;
    case 'browser_navigate': return `Opening ${friendlyUrlLabel(arg('url'))}`;
    case 'browser_extract':  return `Reading the page`;
    case 'browser_click':    return `Clicking on the page`;
    case 'browser_type':     return `Filling out the page`;
    case 'browser_press_key':return `Pressing a key on the page`;
    case 'browser_screenshot': return `Capturing the page`;
    case 'take_screenshot':  return `Capturing the screen`;
    case 'generate_image':   return `Creating an image`;
    case 'speak':            return `Speaking`;
    case 'web_search':       return `Searching the web`;
    case 'web_fetch':        return `Fetching ${friendlyUrlLabel(arg('url'))}`;
    case 'crawl_url':        return `Reading ${friendlyUrlLabel(arg('url'))}`;
    case 'remember':         return `Saving to memory`;
    case 'start_task':       return `Planning the work`;
    case 'start_ultra_task': return `Planning (with approval)`;
    default:                 return `Working`;
  }
}

/**
 * Map a shell command to a human-readable label. Looks at the first
 * meaningful token + path target. Conservative — if we can't tell what
 * it does, we say "running a command" rather than show the literal.
 */
function friendlyShellLabel(command: string): string {
  const cmd = command.trim();
  if (!cmd) return 'Running a command';

  // Pull out the first verb. Strip leading variable assignments like FOO=bar.
  const tokens = cmd.split(/\s+/);
  let verb = tokens[0] ?? '';
  if (verb.includes('=')) verb = tokens[1] ?? '';
  verb = verb.replace(/^.*\//, ''); // /usr/bin/ls → ls

  // Locate any path argument so we can name the target.
  const pathArg = tokens.find((t) => t.startsWith('/') || t.startsWith('~') || t.startsWith('./'))?.replace(/^~?\//, '').split('/').filter(Boolean).pop() ?? '';
  const target = pathArg ? ` ${pathArg}` : '';

  switch (verb) {
    case 'ls': case 'find':         return `Checking${target ? ` the ${target} folder` : ' files'}`;
    case 'du': case 'df':           return `Checking disk usage`;
    case 'cat': case 'less': case 'head': case 'tail': case 'bat':
                                    return `Reading${target ? ` ${target}` : ' a file'}`;
    case 'grep': case 'rg': case 'ag':
                                    return `Searching${target ? ` in ${target}` : ' files'}`;
    case 'cp': case 'rsync':        return `Copying files`;
    case 'mv':                      return `Moving files`;
    case 'rm':                      return `Cleaning up files`;
    case 'mkdir':                   return `Creating a folder`;
    case 'touch':                   return `Creating a file`;
    case 'chmod': case 'chown':     return `Adjusting file permissions`;
    case 'curl': case 'wget':       return `Fetching from the web`;
    case 'git':                     return gitLabel(tokens[1] ?? '');
    case 'npm': case 'pnpm': case 'yarn': case 'bun':
                                    return packageLabel(tokens[1] ?? '');
    case 'pip': case 'pip3':        return packageLabel(tokens[1] ?? '');
    case 'brew':                    return packageLabel(tokens[1] ?? '');
    case 'docker':                  return `Working with Docker`;
    case 'python': case 'python3':  return `Running a Python script`;
    case 'node':                    return `Running a Node script`;
    case 'bash': case 'sh': case 'zsh':
                                    return `Running a shell script`;
    case 'open':                    return target ? `Opening ${target}` : `Opening something`;
    case 'pbcopy':                  return `Copying to clipboard`;
    case 'pbpaste':                 return `Reading clipboard`;
    case 'osascript':               return `Talking to your apps`;
    case 'launchctl':               return `Managing services`;
    case 'killall': case 'kill':    return `Stopping a process`;
    case 'ps': case 'top':          return `Checking what's running`;
    case 'date':                    return `Checking the time`;
    case 'echo':                    return `Printing output`;
    case 'awk': case 'sed':         return `Processing text`;
    case 'jq':                      return `Reading JSON`;
    case 'codesign':                return `Code signing`;
    default:                        return `Running a command`;
  }
}

function gitLabel(sub: string): string {
  switch (sub) {
    case 'status': return `Checking git status`;
    case 'log':    return `Reading git history`;
    case 'diff':   return `Reading changes`;
    case 'add':    return `Staging changes`;
    case 'commit': return `Committing`;
    case 'push':   return `Pushing to remote`;
    case 'pull': case 'fetch': return `Syncing with remote`;
    case 'clone':  return `Cloning a repo`;
    case 'checkout': case 'switch': return `Switching branches`;
    case 'merge':  return `Merging`;
    case 'rebase': return `Rebasing`;
    case 'branch': return `Working with branches`;
    case 'restore': case 'reset':   return `Resetting changes`;
    default:       return `Working with git`;
  }
}

function packageLabel(sub: string): string {
  switch (sub) {
    case 'install': case 'i': case 'add':
                   return `Installing packages`;
    case 'uninstall': case 'remove': case 'rm':
                   return `Removing packages`;
    case 'update': case 'upgrade':
                   return `Updating packages`;
    case 'run':    return `Running a project script`;
    case 'test':   return `Running tests`;
    case 'build':  return `Building`;
    case 'start': case 'dev':
                   return `Starting dev server`;
    case 'list': case 'ls':
                   return `Listing packages`;
    default:       return `Working with packages`;
  }
}

function writeFileLabel(path: string): string {
  if (!path) return `Writing a file`;
  const name = path.split('/').pop() || path;
  const lower = name.toLowerCase();
  if (lower.endsWith('.md'))                              return `Writing a note`;
  if (/\.(html|htm)$/i.test(lower))                       return `Writing a webpage`;
  if (/\.(css|scss|sass)$/i.test(lower))                  return `Writing styles`;
  if (/\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(lower))          return `Writing code`;
  if (/\.(py|rb|go|rs|swift|java|c|cpp|h|hpp)$/i.test(lower)) return `Writing code`;
  if (/\.(json|yaml|yml|toml)$/i.test(lower))             return `Writing config`;
  if (/(report|summary|analysis|note)/i.test(lower))      return `Writing a report`;
  return `Writing ${name}`;
}

function friendlyUrlLabel(url: string): string {
  if (!url) return 'a webpage';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return 'a webpage';
  }
}

export class TaskOverlayBridge {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private subs: Subscription[] = [];

  start(): void {
    if (this.wss) return;
    try {
      this.wss = new WebSocketServer({
        port: TASK_OVERLAY_PORT,
        host: '127.0.0.1',
        maxPayload: 64 * 1024,
      });
    } catch (err) {
      log.error({ err, port: TASK_OVERLAY_PORT }, 'Task overlay bridge failed to bind — overlay events will not be delivered');
      return;
    }
    log.info({ port: TASK_OVERLAY_PORT }, 'Task overlay bridge listening');

    this.wss.on('connection', (ws) => {
      if (this.clients.size >= MAX_CLIENTS) {
        log.warn('Too many overlay clients — rejecting');
        ws.close(1008, 'Too many clients');
        return;
      }
      this.clients.add(ws);
      log.info({ count: this.clients.size }, 'Overlay client connected');

      const keepalive = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try { ws.ping(); } catch { /* non-fatal */ }
      }, 25_000);

      ws.on('close', () => {
        clearInterval(keepalive);
        this.clients.delete(ws);
        log.info({ count: this.clients.size }, 'Overlay client disconnected');
      });
      ws.on('error', () => { /* tolerate quietly */ });
    });

    this.wss.on('error', (err) => log.error({ err }, 'Overlay bridge server error'));

    // Per-chat state: track whether a tool has fired during the current
    // message. If yes, message.completed → emit task.completed (overlay
    // animates out + confetti). If no tool fired (instant chat reply),
    // skip the completion event entirely.
    const chatWorkedThisMessage = new Map<string, boolean>();

    this.subs.push(
      // ── Task lifecycle (start_task path) ──
      events.on('task.planned', (e) => this.publish({
        t: new Date().toISOString(),
        kind: 'task.planned',
        text: `Starting: ${e.title}`,
        meta: { stepCount: e.stepCount },
      })),
      events.on('task.step.started', (e) => this.publish({
        t: new Date().toISOString(),
        kind: 'task.step',
        text: `${e.stepTitle}`,
        meta: { stepId: e.stepId, planTitle: e.planTitle },
      })),
      events.on('task.completed', (e) => this.publish({
        t: new Date().toISOString(),
        kind: 'task.completed',
        text: e.success ? `Done: ${e.title}` : `Partial: ${e.title}`,
        meta: { success: e.success, durationMs: e.durationMs, stepsCompleted: e.stepsCompleted, totalSteps: e.totalSteps },
      })),

      // ── Chat-mode tool lifecycle (covers the much more common path
      //    where the model handles work via direct tool calls instead
      //    of escalating to start_task — the user's desktop reorg case) ──
      events.on('tool.executed', (e) => {
        if (!OVERLAY_WORK_TOOLS.has(e.toolName)) return;
        this.publish({
          t: new Date().toISOString(),
          kind: 'task.step',
          text: pillTextForTool(e.toolName, e.params),
          meta: { toolName: e.toolName, durationMs: e.durationMs },
        });
        // Record per-chat for the message.completed handler. We don't
        // know the chatId from tool.executed, so use a single global
        // flag plus a chat-keyed one for safety.
        chatWorkedThisMessage.set('__any__', true);
      }),

      // ── Message lifecycle — fires the completion animation if any
      //    real work happened during this message. Suppresses on
      //    instant chat replies so the overlay doesn't flash on
      //    every "what time is it." ──
      events.on('message.completed', (e) => {
        const worked = chatWorkedThisMessage.get('__any__') === true;
        chatWorkedThisMessage.delete('__any__');
        if (!worked) return;
        this.publish({
          t: new Date().toISOString(),
          kind: 'task.completed',
          text: 'Done',
          meta: { chatId: e.chatId, durationMs: e.durationMs, toolCalls: e.toolCalls },
        });
      }),
      events.on('message.failed', (e) => {
        const worked = chatWorkedThisMessage.get('__any__') === true;
        chatWorkedThisMessage.delete('__any__');
        if (!worked) return;
        this.publish({
          t: new Date().toISOString(),
          kind: 'task.completed',
          text: 'Stopped',
          meta: { chatId: e.chatId, error: e.error.slice(0, 80), durationMs: e.durationMs },
        });
      }),
    );
  }

  private publish(evt: OverlayEvent): void {
    const json = JSON.stringify(evt);
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(json); } catch (err) { log.debug({ err }, 'Overlay send failed (client drop)'); }
    }
  }

  stop(): void {
    for (const sub of this.subs) {
      try { sub.unsubscribe(); } catch { /* ignore */ }
    }
    this.subs = [];
    for (const ws of this.clients) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
    log.info('Task overlay bridge stopped');
  }
}

export const taskOverlayBridge = new TaskOverlayBridge();
