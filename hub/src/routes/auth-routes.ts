// /auth/* endpoints — signup, login, logout, refresh, me.

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db.js';
import {
  hashPassword, verifyPassword, validateEmail, validatePassword, validateDisplayName,
  validateUsername,
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
  // Optional during the rollout window — old clients don't send it. Once every
  // client is upgraded we can mark this required and backfill placeholders.
  username: z.string().optional().refine(
    (u) => u === undefined || validateUsername(u),
    'invalid username',
  ),
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

    const { email, password, displayName, username } = parsed.data;
    const db = getDb();
    const emailLower = email.toLowerCase();
    const usernameLower = username ? username.toLowerCase() : null;

    const existing = db.prepare('SELECT id FROM users WHERE email_lower = ?').get(emailLower);
    if (existing) {
      // Deliberately the same 400 to avoid account enumeration via timing
      // on signup. The existing user just tries login instead.
      return reply.code(400).send({ error: 'signup_unavailable' });
    }

    if (usernameLower) {
      const takenByUser = db.prepare('SELECT id FROM users WHERE username_lower = ?').get(usernameLower);
      if (takenByUser) {
        return reply.code(400).send({ error: 'username_taken' });
      }
    }

    const id = randomBytes(16).toString('hex');
    let passwordHash: string;
    try { passwordHash = await hashPassword(password); }
    catch { return reply.code(400).send({ error: 'invalid_input' }); }

    db.prepare(`
      INSERT INTO users (id, email, email_lower, password_hash, display_name, username, username_lower)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, email, emailLower, passwordHash, displayName, username ?? null, usernameLower);

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
      user: { id, email, displayName, username: username ?? null },
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
      SELECT id, email, display_name, username, password_hash FROM users WHERE email_lower = ?
    `).get(email.toLowerCase()) as
      | { id: string; email: string; display_name: string | null; username: string | null; password_hash: string }
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
      user: { id: user.id, email: user.email, displayName: user.display_name, username: user.username },
      accessToken: access,
    });
  });

  // ── POST /auth/refresh ────────────────────────────────────────────
  //
  // Rotating-refresh pattern: every successful refresh REVOKES the old
  // refresh token and issues a brand-new one. A stolen cookie works once;
  // when the legitimate client next refreshes, the old (stolen) token is
  // already revoked and returns 401. Classic OAuth 2.0 refresh rotation.
  //
  // If we see a revoked refresh being presented again ("reuse after
  // rotation"), we treat that as a compromise signal and revoke the
  // entire user's session family — forcing a fresh login everywhere.
  app.post('/auth/refresh', async (req, reply) => {
    const refresh = req.cookies?.[REFRESH_COOKIE];
    if (!refresh) return reply.code(401).send({ error: 'missing_refresh' });
    const db = getDb();
    const tokenHash = hashRefreshToken(refresh);
    const session = db.prepare(`
      SELECT id, user_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?
    `).get(tokenHash) as
      | { id: string; user_id: string; expires_at: string; revoked_at: string | null } | undefined;

    if (!session) {
      reply.clearCookie(REFRESH_COOKIE, { path: '/' });
      return reply.code(401).send({ error: 'invalid_refresh' });
    }

    // Reuse of an already-revoked refresh = potential theft-and-replay,
    // BUT also the natural outcome of a legitimate race between two
    // processes sharing the same Keychain (the NEXUS daemon and the
    // installer-app both read from Keychain; after Mac sleep/wake they
    // both fire refresh catch-ups in the same 100-200ms window). If the
    // revocation just happened (within GRACE_MS), we treat it as a race
    // and 401 quietly — the caller will fall back to re-reading the
    // rotated cookie from Keychain on its next attempt.
    //
    // Only trip family-wide revocation when the revocation is OLDER than
    // the grace window — a real stolen cookie replay.
    if (session.revoked_at) {
      const GRACE_MS = 10_000;
      const revokedAgeMs = Date.now() - new Date(session.revoked_at).getTime();
      if (Number.isFinite(revokedAgeMs) && revokedAgeMs <= GRACE_MS) {
        reply.clearCookie(REFRESH_COOKIE, { path: '/' });
        return reply.code(401).send({ error: 'refresh_race_lost' });
      }
      db.prepare('UPDATE sessions SET revoked_at = datetime(\'now\') WHERE user_id = ? AND revoked_at IS NULL')
        .run(session.user_id);
      writeAudit(db, 'refresh_reuse_detected', {
        userId: session.user_id,
        ipHash: hashIp(req.ip),
        userAgent: req.headers['user-agent'],
      });
      reply.clearCookie(REFRESH_COOKIE, { path: '/' });
      return reply.code(401).send({ error: 'session_revoked' });
    }

    if (new Date(session.expires_at).getTime() < Date.now()) {
      reply.clearCookie(REFRESH_COOKIE, { path: '/' });
      return reply.code(401).send({ error: 'refresh_expired' });
    }

    // Revoke old, issue new.
    const { plaintext: newRefresh, hash: newHash } = generateRefreshToken();
    const newSessionId = randomBytes(16).toString('hex');
    const newExpiresAt = new Date(Date.now() + refreshTtlSec * 1000).toISOString();

    db.transaction(() => {
      db.prepare('UPDATE sessions SET revoked_at = datetime(\'now\') WHERE id = ?').run(session.id);
      db.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent, ip_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(newSessionId, session.user_id, newHash, newExpiresAt,
             req.headers['user-agent']?.slice(0, 512) ?? null,
             hashIp(req.ip));
    })();

    const access = await signAccessToken(session.user_id);
    reply.setCookie(REFRESH_COOKIE, newRefresh, cookieOpts());
    return reply.send({ accessToken: access });
  });

  // ── POST /auth/logout ─────────────────────────────────────────────
  // Revokes only the current session (this device).
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

  // ── POST /auth/logout-all ─────────────────────────────────────────
  //
  // "Log out everywhere." Revokes every active session for the authed user.
  // Critical escape hatch if the user suspects a cookie was stolen — without
  // this they'd have to wait for every session's 30-day TTL to expire.
  //
  // Caller must present a valid access token (not just the refresh cookie)
  // so an attacker with just the cookie can't lock out the real user.
  app.post('/auth/logout-all', async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthorized' });
    const token = auth.slice(7);
    const { verifyAccessToken } = await import('../auth.js');
    const claims = await verifyAccessToken(token);
    if (!claims) return reply.code(401).send({ error: 'unauthorized' });

    const db = getDb();
    const result = db.prepare(`
      UPDATE sessions SET revoked_at = datetime('now')
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(claims.sub);

    writeAudit(db, 'logout_all', { userId: claims.sub, ipHash: hashIp(req.ip), userAgent: req.headers['user-agent'] });
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return reply.send({ ok: true, revokedCount: result.changes });
  });

  // ── DELETE /auth/me ───────────────────────────────────────────────
  //
  // GDPR Article 17 ("right to erasure") self-serve: authed user can delete
  // their own account + cascade all owned data. Requires a re-confirmation
  // of the password so a stolen access token alone can't nuke the account.
  const DeleteBody = z.object({
    password: z.string().min(1).max(256),
    confirm: z.literal('DELETE'),
  });
  app.delete('/auth/me', async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthorized' });
    const { verifyAccessToken } = await import('../auth.js');
    const claims = await verifyAccessToken(auth.slice(7));
    if (!claims) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = DeleteBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const db = getDb();
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(claims.sub) as
      | { password_hash: string } | undefined;
    if (!user) return reply.code(404).send({ error: 'not_found' });
    const ok = await verifyPassword(parsed.data.password, user.password_hash);
    if (!ok) return reply.code(401).send({ error: 'invalid_password' });

    // All user-owned tables have ON DELETE CASCADE → deleting the user row
    // removes sessions, instances, friendships, posts, gossip_queue, soul_queue,
    // audit_log entries (via SET NULL) in one shot.
    writeAudit(db, 'account_deleted', { userId: claims.sub, ipHash: hashIp(req.ip), userAgent: req.headers['user-agent'] });
    db.prepare('DELETE FROM users WHERE id = ?').run(claims.sub);

    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });
}
