// NEXUS Hub — account server entry.

import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { getDb, type HubDb } from './db.js';
import { authRoutes } from './routes/auth-routes.js';
import { instancesRoutes } from './routes/instances-routes.js';
import { friendsRoutes } from './routes/friends-routes.js';
import { postsRoutes } from './routes/posts-routes.js';
import { gossipRoutes } from './routes/gossip-routes.js';
import { soulRoutes } from './routes/soul-routes.js';

export interface BuildAppOptions {
  /** Override the global DB (useful for tests). */
  db?: HubDb;
  /** Skip rate-limiting entirely (tests rely on rapid back-to-back calls). */
  disableRateLimit?: boolean;
  /** Override the Pino log level. Tests pass "silent". */
  logLevel?: string;
}

/**
 * Build a Fastify instance with all routes registered. Exposed separately
 * from `main()` so the integration-test suite can spin up a fresh in-memory
 * hub without the listen/shutdown noise.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  // Warm the DB (runs migrations) unless the caller passed one in.
  if (opts.db) {
    // Inject the per-test DB so routes picking it up via getDb() get this one.
    const { setDbForTest } = await import('./db.js');
    setDbForTest(opts.db);
  } else {
    getDb();
  }

  const app = Fastify({
    logger: {
      level: opts.logLevel ?? process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        remove: true,
      },
    },
    trustProxy: process.env.PRODUCTION === '1',
    bodyLimit: 64 * 1024,
  });

  await app.register(sensible);
  await app.register(helmet, {
    // We're an API — CSP lockdown comes into play when a web UI ships.
    contentSecurityPolicy: false,
  });

  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || origins.includes(origin) || origin === 'null') return cb(null, true);
      cb(new Error('origin not allowed'), false);
    },
    credentials: true,
  });

  await app.register(cookie);
  if (!opts.disableRateLimit) {
    // Global IP-keyed rate limit for unauthenticated / auth endpoints.
    // Authed endpoints get an additional per-user limit registered below.
    await app.register(rateLimit, {
      max: Number.parseInt(process.env.AUTH_RATE_LIMIT ?? '10', 10),
      timeWindow: '15 minutes',
      keyGenerator: (req) => req.ip,
      // Only apply to auth routes — the authed routes have their own
      // per-user limiter that's looser but keyed on the JWT subject.
      allowList: (req) => !req.url.startsWith('/auth/'),
    });

    // Per-user limiter for authed routes. Implemented as a preHandler hook
    // (rather than a second `app.register(rateLimit, ...)` which would
    // collide with the first) so we can key on `req.userId` populated by
    // the bearer-token middleware.
    const AUTHED_MAX = Number.parseInt(process.env.AUTHED_RATE_LIMIT ?? '300', 10);
    const AUTHED_WINDOW_MS = 60_000; // per minute
    const userBuckets = new Map<string, { count: number; resetAt: number }>();
    app.addHook('preHandler', async (req, reply) => {
      if (!req.userId) return; // either anonymous or the auth middleware will 401 shortly
      const now = Date.now();
      const bucket = userBuckets.get(req.userId);
      if (!bucket || bucket.resetAt < now) {
        userBuckets.set(req.userId, { count: 1, resetAt: now + AUTHED_WINDOW_MS });
        return;
      }
      bucket.count++;
      if (bucket.count > AUTHED_MAX) {
        return reply.code(429).send({ error: 'rate_limited' });
      }
    });

    // Janitor — prune stale buckets every 2 minutes.
    const janitor = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of userBuckets) {
        if (v.resetAt < now) userBuckets.delete(k);
      }
    }, 120_000);
    janitor.unref?.();
  }

  // Root: return nothing. Don't leak server name/version to bots trawling the internet.
  app.get('/', async (_req, reply) => reply.code(204).send());

  // Background purge — keeps the SQLite volume from filling with stale
  // queue rows, revoked sessions, and ancient audit logs. Runs hourly.
  // Skipped under opts.db (test harness) since the tests need deterministic
  // row counts.
  if (!opts.db) {
    const purge = (): void => {
      try {
        const db = getDb();
        const now = new Date().toISOString();
        // Expired sessions — every one that's past expires_at is dead weight.
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
        // Delivered gossip / soul messages older than 90 days.
        db.prepare("DELETE FROM gossip_queue WHERE delivered_at IS NOT NULL AND delivered_at < datetime('now','-90 days')").run();
        db.prepare("DELETE FROM soul_queue WHERE delivered_at IS NOT NULL AND delivered_at < datetime('now','-90 days')").run();
        // Undelivered queue messages older than 180 days (never going to be consumed).
        db.prepare("DELETE FROM gossip_queue WHERE delivered_at IS NULL AND created_at < datetime('now','-180 days')").run();
        db.prepare("DELETE FROM soul_queue WHERE delivered_at IS NULL AND created_at < datetime('now','-180 days')").run();
        // Audit log older than 365 days.
        db.prepare("DELETE FROM audit_log WHERE created_at < datetime('now','-365 days')").run();
        app.log.debug('purge cycle complete');
      } catch (err) {
        app.log.warn({ err }, 'purge cycle failed');
      }
    };
    // First run 1 min after boot, then every hour.
    const firstTimer = setTimeout(purge, 60_000);
    firstTimer.unref?.();
    const hourlyTimer = setInterval(purge, 60 * 60_000);
    hourlyTimer.unref?.();
  }

  // Deep health check: hits SQLite so we detect "server is up but DB is sick".
  app.get('/healthz', async (_req, reply) => {
    try {
      const db = getDb();
      const row = db.prepare('SELECT 1 as ok').get() as { ok: number } | undefined;
      if (!row || row.ok !== 1) return reply.code(503).send({ ok: false, reason: 'db_query_failed' });
      return { ok: true };
    } catch (err) {
      return reply.code(503).send({ ok: false, reason: 'db_error', error: (err as Error).message });
    }
  });

  // Centralised error handler. Logs the full error with request context but
  // only ships a generic shape back to the client (no stack traces).
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const statusCode = err.statusCode ?? 500;
    req.log.error({ err, url: req.url, method: req.method }, 'request_failed');
    if (statusCode >= 500) return reply.code(500).send({ error: 'internal_error' });
    return reply.code(statusCode).send({ error: err.message || 'error' });
  });

  await app.register(authRoutes);
  await app.register(instancesRoutes);
  await app.register(friendsRoutes);
  await app.register(postsRoutes);
  await app.register(gossipRoutes);
  await app.register(soulRoutes);

  return app;
}

async function main(): Promise<void> {
  // Fail fast if required env is missing.
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('FATAL: JWT_SECRET missing or too short. Generate one:');
    console.error('  node -e "console.log(require(\'node:crypto\').randomBytes(48).toString(\'base64\'))"');
    process.exit(1);
  }

  const app = await buildApp();

  // Graceful shutdown — Fly sends SIGTERM on deploys. Flush in-flight
  // requests, close the DB, then exit. Without this, requests in progress
  // during a deploy get aborted and the client sees a network error.
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      const { closeDb } = await import('./db.js');
      closeDb();
    } catch (err) {
      app.log.error({ err }, 'shutdown error');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  const port = Number.parseInt(process.env.PORT ?? '8787', 10);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  app.log.info({ port, host }, 'nexus-hub listening');
}

// Only start the server when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error('Failed to start hub:', err);
    process.exit(1);
  });
}
