import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

// PII / secret redaction. Applied to string values in the first (merging)
// object of every log call. Patterns are narrow-on-purpose — broad matches
// would dilute logs and destroy debuggability. Add new patterns here if a
// real-world leak shows up.
const SENSITIVE_PATTERNS: { re: RegExp; replace: string }[] = [
  // Explicit "password"/"passwd"/"secret"/"token"/"api_key" key=value forms,
  // both JSON-style and form-style.
  { re: /(["']?(?:password|passwd|secret|token|api[_-]?key|auth[_-]?token|access[_-]?token)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, replace: '$1[redacted]' },
  // Common API-key prefixes (Stripe sk_/pk_, GitHub ghp_ ghs_ github_pat_, OpenAI sk-)
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: '[redacted-sk]' },
  { re: /\b(?:ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9_-]{16,}/g, replace: '[redacted-gh]' },
  { re: /\bgithub_pat_[A-Za-z0-9_-]{16,}/g, replace: '[redacted-ghpat]' },
  { re: /\b(?:sk_live|sk_test|pk_live|pk_test)_[A-Za-z0-9_-]{16,}/g, replace: '[redacted-stripe]' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: '[redacted-slack]' },
  // Bearer tokens
  { re: /\bBearer\s+[A-Za-z0-9._-]{16,}/g, replace: 'Bearer [redacted]' },
];

function redactString(s: string): string {
  if (!s || typeof s !== 'string') return s;
  let out = s;
  for (const { re, replace } of SENSITIVE_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

function redactValue(v: unknown, depth = 0): unknown {
  if (depth > 4) return v; // don't recurse deeply into logged objects
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(val, depth + 1);
    }
    return out;
  }
  return v;
}

const NEXUS_DIR = join(homedir(), '.nexus');
const LOG_DIR = join(NEXUS_DIR, 'logs');

// Ensure log directories exist
mkdirSync(LOG_DIR, { recursive: true });

const level = process.env.LOG_LEVEL ?? 'info';

const isTTY = process.stdout.isTTY;

// When running in a TTY (terminal), use pino-pretty for human-readable output.
// When running headless (launchd service), write JSON to stdout — launchd redirects
// stdout to the log file via StandardOutPath in the plist.
const rootLogger: Logger = isTTY
  ? pino({
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      transport: {
        targets: [
          {
            target: 'pino-pretty',
            level,
            options: {
              colorize: true,
              translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
          {
            target: 'pino/file',
            level,
            options: {
              destination: join(NEXUS_DIR, 'nexus.log'),
              mkdir: true,
            },
          },
        ],
      },
    })
  : pino({ level, timestamp: pino.stdTimeFunctions.isoTime });

/**
 * Create a child logger scoped to a specific component.
 *
 * Every log line emitted via this logger is auto-enriched with the current
 * trace context (traceId, chatId) if one is active — so you can filter logs
 * by traceId to see everything that happened for one user message, across
 * every subsystem, without threading ids manually.
 *
 * @param name - Component or module name (e.g. 'MemoryManager', 'TelegramBot')
 * @returns A pino child logger with the component field set
 */
export function createLogger(name: string): Logger {
  const componentLogger = rootLogger.child({ component: name });
  // Wrap to inject current trace context lazily at log time.
  return wrapWithTrace(componentLogger);
}

/**
 * Wraps a logger so every log method includes the current trace context
 * (from AsyncLocalStorage) as fields. Trace context is resolved at call
 * time, not construction time, so a single logger works across messages.
 */
function wrapWithTrace(logger: Logger): Logger {
  // Lazy-resolve currentTrace to avoid any module init order issues.
  // Trace module does NOT import logger, so no cycle.
  let currentTraceFn: (() => { traceId?: string; chatId?: string } | undefined) | null = null;
  const resolveTrace = (): { traceId?: string; chatId?: string } | undefined => {
    if (!currentTraceFn) {
      try {
        // Using a relative sync require — we're in Node, the trace module is already loaded.
        // This works in both ESM (via module interop) and CJS builds.
        const mod: { currentTrace?: () => { traceId?: string; chatId?: string } | undefined } = (globalThis as any).__nexus_trace__ ?? {};
        currentTraceFn = mod.currentTrace ?? (() => undefined);
      } catch {
        currentTraceFn = () => undefined;
      }
    }
    return currentTraceFn();
  };

  const methods = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
  const wrapped = Object.create(logger);
  for (const method of methods) {
    wrapped[method] = function (...args: unknown[]) {
      const ctx = resolveTrace();
      // Redact PII / secrets in the merging object and string message.
      // Applied before any other processing to minimize the chance a secret
      // ever hits disk.
      if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
        args[0] = redactValue(args[0]);
        if (typeof args[1] === 'string') args[1] = redactString(args[1]);
      } else if (typeof args[0] === 'string') {
        args[0] = redactString(args[0]);
      }
      if (ctx && (ctx.traceId || ctx.chatId)) {
        // If first arg is an object (pino's "mergingObject"), merge trace fields in.
        if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
          const first = args[0] as Record<string, unknown>;
          // Don't overwrite explicit caller-provided traceId/chatId
          const enriched = {
            ...(ctx.traceId && !first.traceId ? { traceId: ctx.traceId } : {}),
            ...(ctx.chatId && !first.chatId ? { chatId: ctx.chatId } : {}),
            ...first,
          };
          return (logger[method] as (obj: Record<string, unknown>, ...rest: unknown[]) => void)(enriched, ...args.slice(1));
        }
        // First arg is a string — inject trace fields as the object
        const enriched = {
          ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
          ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
        };
        return (logger[method] as (obj: Record<string, unknown>, msg: string, ...rest: unknown[]) => void)(enriched, args[0] as string, ...args.slice(1));
      }
      return (logger[method] as (...a: unknown[]) => void)(...args);
    };
  }
  return wrapped as Logger;
}

/**
 * Register the trace accessor on globalThis so the logger can read trace context
 * without a static import (which would create a cycle risk if trace ever logs).
 * Called once at module load of trace.ts.
 */
export function registerTraceAccessor(currentTrace: () => { traceId?: string; chatId?: string } | undefined): void {
  (globalThis as any).__nexus_trace__ = { currentTrace };
}

export default rootLogger;
