// /auth/* endpoints — signup, login, logout, refresh, me.

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db.js';
import {
  hashPassword, verifyPassword, validateEmail, validatePassword, validateDisplayName,
  signAccessToken, generateRefreshToken, hashRefreshToken, hashIp,
  registerFailedLogin, clearFailedLogins, isAccountLocked, writeAudit,
} from '../auth.js';

const REFRESH_COOKIE = 'nexus_refresh';
const isProduction = process.env.PRODUCTION === '1';
const refreshTtlSec = Number.parseInt(process.env.REFRESH_TOKEN_TTL_SECONDS ?? '2592000', 10);

const SignupBody = z.object({
  email: z.string().max(254).refine(validateEmail, 'invalid email'),
  password: z.string().min(8).max(256).refine(validatePassword, 'invalid password'),
  displayName: z.string().min(1).max(64).refine(validateDisplayName, 'invalid display name'),
});

const LoginBody = z.object({
  email: z.string().max(254).refine(validateEmail, 'invalid email'),
  password: z.string().min(1).max(256),
});

function cookieOpts(): Parameters<import('fastify').FastifyReply['setCookie']>[2] {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: refreshTtlSec,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /auth/signup ─────────────────────────────────────────────
  app.post('/auth/signup', async (req, reply) => {
    const parsed = SignupBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const { email, password, displayName } = parsed.data;
    const db = getDb();
    const emailLower = email.toLowerCase();

    const existing = db.prepare('SELECT id FROM users WHERE email_lower = ?').get(emailLower);
    if (existing) {
      // Deliberately the same 400 to avoid account enumeration via timing
      // on signup. The existing user just tries login instead.
      return reply.code(400).send({ error: 'signup_unavailable' });
    }

    const id = randomBytes(16).toString('hex');
    let passwordHash: string;
    try { passwordHash = await hashPassword(password); }
    catch { return reply.code(400).send({ error: 'invalid_input' }); }

    db.prepare(`
      INSERT INTO users (id, email, email_lower, password_hash, display_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, email, emailLower, passwordHash, displayName);

    const { plaintext: refresh, hash: refreshHash } = generateRefreshToken();
    const sessionId = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + refreshTtlSec * 1000).toISOString();
    db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, id, refreshHash, expiresAt,
           req.headers['user-agent']?.slice(0, 512) ?? null,
           hashIp(req.ip));

    writeAudit(db, 'signup', { userId: id, ipHash: hashIp(req.ip), userAgent: req.headers['user-agent'] });

    const access = await signAccessToken(id);
    reply.setCookie(REFRESH_COOKIE, refresh, cookieOpts());
    return reply.code(201).send({
      user: { id, email, displayName },
      accessToken: access,
    });
  });

  // ── POST /auth/login ──────────────────────────────────────────────
  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const { email, password } = parsed.data;
    const db = getDb();
    const user = db.prepare(`
      SELECT id, email, display_name, password_hash FROM users WHERE email_lower = ?
    `).get(email.toLowerCase()) as
      | { id: string; email: string; display_name: string | null; password_hash: string }
      | undefined;

    if (!user) {
      // Run a dummy hash to keep timing consistent against enumeration.
      await hashPassword('x'.repeat(16)).catch(() => null);
      writeAudit(db, 'login_fail', { detail: 'no_such_user', ipHash: hashIp(req.ip), userAgent: req.headers['user-agent'] });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    if (isAccountLocked(db, user.id)) {
      writeAudit(db, 'login_blocked_locked', { userId: user.id, ipHash: hashIp(req.ip) });
      return reply.code(429).send({ error: 'account_locked' });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      registerFailedLogin(db, user.id);
      writeAudit(db, 'login_fail', { userId: user.id, detail: 'bad_password', ipHash: hashIp(req.ip) });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    clearFailedLogins(db, user.id);

    const { plaintext: refresh, hash: refreshHash } = generateRefreshToken();
    const sessionId = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + refreshTtlSec * 1000).toISOString();
    db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, user.id, refreshHash, expiresAt,
           req.headers['user-agent']?.slice(0, 512) ?? null,
           hashIp(req.ip));

    writeAudit(db, 'login_ok', { userId: user.id, ipHash: hashIp(req.ip), userAgent: req.headers['user-agent'] });
    const access = await signAccessToken(user.id);
    reply.setCookie(REFRESH_COOKIE, refresh, cookieOpts());
    return reply.send({
      user: { id: user.id, email: user.email, displayName: user.display_name },
      accessToken: access,
    });
  });

  // ── POST /auth/refresh ────────────────────────────────────────────
  app.post('/auth/refresh', async (req, reply) => {
    const refresh = req.cookies?.[REFRESH_COOKIE];
    if (!refresh) return reply.code(401).send({ error: 'missing_refresh' });
    const db = getDb();
    const session = db.prepare(`
      SELECT id, user_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?
    `).get(hashRefreshToken(refresh)) as
      | { id: string; user_id: string; expires_at: string; revoked_at: string | null } | undefined;
    if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) {
      return reply.code(401).send({ error: 'invalid_refresh' });
    }
    const access = await signAccessToken(session.user_id);
    return reply.send({ accessToken: access });
  });

  // ── POST /auth/logout ─────────────────────────────────────────────
  app.post('/auth/logout', async (req, reply) => {
    const refresh = req.cookies?.[REFRESH_COOKIE];
    if (refresh) {
      const db = getDb();
      db.prepare('UPDATE sessions SET revoked_at = datetime(\'now\') WHERE token_hash = ?')
        .run(hashRefreshToken(refresh));
    }
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });
}
