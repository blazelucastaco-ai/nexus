// NEXUS Hub — account server entry.

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { getDb } from './db.js';
import { authRoutes } from './routes/auth-routes.js';
import { instancesRoutes } from './routes/instances-routes.js';
import { friendsRoutes } from './routes/friends-routes.js';
import { postsRoutes } from './routes/posts-routes.js';
import { gossipRoutes } from './routes/gossip-routes.js';
import { soulRoutes } from './routes/soul-routes.js';

async function main(): Promise<void> {
  // Fail fast if required env is missing.
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('FATAL: JWT_SECRET missing or too short. Generate one:');
    console.error('  node -e "console.log(require(\'node:crypto\').randomBytes(48).toString(\'base64\'))"');
    process.exit(1);
  }

  // Warm the DB (runs migrations).
  getDb();

  const app = Fastify({
    logger: {
      // Keep logs structured but drop auth/cookie headers so nothing sensitive lands in log files.
      level: process.env.LOG_LEVEL ?? 'info',
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
      // Allow same-origin + explicit list. File-scheme origins from Electron
      // show up as 'null' or 'file://'.
      if (!origin || origins.includes(origin) || origin === 'null') return cb(null, true);
      cb(new Error('origin not allowed'), false);
    },
    credentials: true,
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    max: Number.parseInt(process.env.AUTH_RATE_LIMIT ?? '10', 10),
    timeWindow: '15 minutes',
    keyGenerator: (req) => req.ip,
    // Only apply to auth routes — instance pings should be unconstrained.
    allowList: (req) => !req.url.startsWith('/auth/'),
  });

  // Health check + a deliberately empty root. We don't advertise the server
  // name on the public root — bots trawling the internet get a minimal
  // response with no version string or fingerprint.
  app.get('/', async (_req, reply) => reply.code(204).send());
  app.get('/healthz', async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(instancesRoutes);
  await app.register(friendsRoutes);
  await app.register(postsRoutes);
  await app.register(gossipRoutes);
  await app.register(soulRoutes);

  const port = Number.parseInt(process.env.PORT ?? '8787', 10);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  app.log.info({ port, host }, 'nexus-hub listening');
}

main().catch((err: unknown) => {
  console.error('Failed to start hub:', err);
  process.exit(1);
});
