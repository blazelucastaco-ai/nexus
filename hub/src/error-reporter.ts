// Optional error reporter.
//
// When SENTRY_DSN is set we stream uncaught errors (via Fastify's
// setErrorHandler) to Sentry. When it isn't set — the common case for
// personal-use deploys — this module does nothing and doesn't even import
// @sentry/node, so the hub stays lean.
//
// Sentry is opt-in, not a dependency in package.json. If the DSN is set but
// the package isn't installed (`pnpm add @sentry/node` not run), we log a
// warning once and continue without monitoring. This way the repo ships
// ready-to-use with Sentry but zero-cost for everyone who doesn't enable it.

import type { FastifyInstance, FastifyRequest } from 'fastify';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SentryLike = { init?: any; captureException?: any; setTag?: any };

let sentry: SentryLike | null = null;

/**
 * Initialise the error reporter. Call once at startup from buildApp().
 * Idempotent — repeat calls are no-ops.
 */
export async function initErrorReporter(log: FastifyInstance['log']): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || sentry) return;

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — optional dep, may not be installed
    sentry = await import('@sentry/node').catch(() => null);
    if (!sentry?.init) {
      log.warn('SENTRY_DSN is set but @sentry/node is not installed — run `pnpm add @sentry/node` in hub/ to enable');
      sentry = null;
      return;
    }
    sentry.init({
      dsn,
      environment: process.env.HUB_ENV ?? (process.env.PRODUCTION === '1' ? 'prod' : 'dev'),
      tracesSampleRate: 0,  // we only care about errors, not perf
      release: process.env.GITHUB_SHA ?? undefined,
    });
    sentry.setTag?.('service', 'nexus-hub');
    log.info('Sentry error reporter initialised');
  } catch (err) {
    log.warn({ err }, 'Failed to init Sentry — continuing without error monitoring');
    sentry = null;
  }
}

/**
 * Ship one exception to Sentry if configured. Attaches request context
 * (method + url + userId, never headers/body) so the report is actionable
 * without leaking PII.
 */
export function reportError(err: unknown, req?: FastifyRequest): void {
  if (!sentry?.captureException) return;
  try {
    sentry.captureException(err, {
      tags: {
        method: req?.method,
        url: req?.url,
      },
      user: req?.userId ? { id: req.userId } : undefined,
    });
  } catch { /* don't let the reporter itself crash the process */ }
}
