// Shared test harness — spins up a fresh in-memory SQLite-backed hub per test.
//
// Each test gets its own isolated DB, so we can run them in parallel and
// nothing crosses over. `buildTestApp` wires the real Fastify app against
// that DB; calls to it go through `app.inject()` rather than a real port,
// which is fast and doesn't need any socket bookkeeping.

import Database from 'better-sqlite3';
import {
  createHmac, createPrivateKey,
  randomBytes, generateKeyPairSync, sign as cryptoSign,
} from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { closeDb } from '../src/db.js';

// Deterministic JWT secret for tests. Long enough to pass the startup check.
export const TEST_JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret-test';

/** Fresh in-memory DB per call — zero shared state. */
export function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.pragma('foreign_keys = ON');
  return db;
}

export interface TestApp {
  app: FastifyInstance;
  db: Database.Database;
  close: () => Promise<void>;
}

export async function buildTestApp(): Promise<TestApp> {
  // Make sure the hub's env checks pass.
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.LOG_LEVEL = 'silent';

  const db = makeTestDb();
  const app = await buildApp({
    db,
    disableRateLimit: true,
    logLevel: 'silent',
  });
  await app.ready();

  return {
    app,
    db,
    close: async () => {
      await app.close();
      closeDb();
    },
  };
}

// ─── Convenience request helpers ─────────────────────────────────────

export async function signup(
  app: FastifyInstance,
  opts: { email: string; password: string; displayName: string; username?: string },
): Promise<{ status: number; body: any; refreshCookie: string | null }> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: opts,
  });
  const setCookie = r.headers['set-cookie'];
  const refreshCookie = extractRefresh(Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []);
  return { status: r.statusCode, body: r.json(), refreshCookie };
}

export async function login(
  app: FastifyInstance,
  opts: { email: string; password: string },
): Promise<{ status: number; body: any; refreshCookie: string | null }> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: opts,
  });
  let body: any = null;
  try { body = r.json(); } catch { body = null; }
  const setCookie = r.headers['set-cookie'];
  const refreshCookie = extractRefresh(Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []);
  return { status: r.statusCode, body, refreshCookie };
}

export function extractRefresh(setCookieHeaders: string[]): string | null {
  for (const c of setCookieHeaders) {
    const m = c.match(/^nexus_refresh=([^;]+)/);
    if (m) return m[1] ?? null;
  }
  return null;
}

export async function authed<T = any>(
  app: FastifyInstance,
  token: string,
  opts: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; payload?: unknown },
): Promise<{ status: number; body: T }> {
  const r = await app.inject({
    method: opts.method,
    url: opts.url,
    headers: { authorization: `Bearer ${token}` },
    payload: opts.payload,
  });
  let body: any = null;
  try { body = r.json(); } catch { body = null; }
  return { status: r.statusCode, body };
}

// ─── Crypto helpers (post signing) ───────────────────────────────────
//
// These mirror exactly what the NEXUS daemon does in src/hub/client.ts so
// tests exercise the real signature verification path on the hub.

export function genEd25519Keypair(): { pubHex: string; privHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  if (!pubJwk.x || !privJwk.d) throw new Error('key generation failed');
  return {
    pubHex: Buffer.from(pubJwk.x, 'base64url').toString('hex'),
    privHex: Buffer.from(privJwk.d, 'base64url').toString('hex'),
  };
}

export function signPost(privHex: string, content: string, createdAt: string, instanceId: string): string {
  const privRaw = Buffer.from(privHex, 'hex');
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8 = Buffer.concat([pkcs8Prefix, privRaw]);
  const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const data = Buffer.from(`${content}\n${createdAt}\n${instanceId}`, 'utf-8');
  return cryptoSign(null, data, priv).toString('base64');
}

/** Random unique email so parallel tests never collide. */
export function randEmail(): string {
  return `u-${randomBytes(6).toString('hex')}@test.local`;
}

export function randUsername(): string {
  // Must start with a letter — use 'u' + 8 hex chars.
  return `u${randomBytes(4).toString('hex')}`;
}

export function randHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

// HMAC placeholder — keeps type-sense in tests that want to assert their
// mock JWT shape without depending on jose.
export function fakeJwt(userId: string): string {
  const h = createHmac('sha256', TEST_JWT_SECRET).update(userId).digest('base64url');
  return `fake.${userId}.${h}`;
}
