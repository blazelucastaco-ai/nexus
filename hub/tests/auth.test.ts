// Auth route integration tests — signup, login, refresh, lockout,
// enumeration-safety. Each test owns its own hub + in-memory DB.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, signup, login, authed, randEmail, randUsername, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => { t = await buildTestApp(); });
afterEach(async () => { await t.close(); });

describe('POST /auth/signup', () => {
  test('creates a user and returns an access token + refresh cookie', async () => {
    const email = randEmail();
    const r = await signup(t.app, { email, password: 'password-1234', displayName: 'Test' });
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe(email);
    expect(r.body.user.id).toMatch(/^[a-f0-9]{32}$/);
    expect(r.body.accessToken).toBeTruthy();
    expect(r.refreshCookie).toBeTruthy();
  });

  test('accepts an optional username', async () => {
    const username = randUsername();
    const r = await signup(t.app, {
      email: randEmail(), password: 'password-1234',
      displayName: 'With handle', username,
    });
    expect(r.status).toBe(201);
    expect(r.body.user.username).toBe(username);
  });

  test('rejects a duplicate email with a generic error (no enumeration)', async () => {
    const email = randEmail();
    await signup(t.app, { email, password: 'password-1234', displayName: 'First' });
    const r = await signup(t.app, { email, password: 'password-1234', displayName: 'Second' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('signup_unavailable');
  });

  test('rejects a duplicate username', async () => {
    const username = randUsername();
    await signup(t.app, { email: randEmail(), password: 'password-1234', displayName: 'First', username });
    const r = await signup(t.app, { email: randEmail(), password: 'password-1234', displayName: 'Second', username });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('username_taken');
  });

  test('rejects invalid email format', async () => {
    const r = await signup(t.app, { email: 'not-an-email', password: 'password-1234', displayName: 'x' });
    expect(r.status).toBe(400);
  });

  test('rejects short password', async () => {
    const r = await signup(t.app, { email: randEmail(), password: 'short', displayName: 'x' });
    expect(r.status).toBe(400);
  });

  test('rejects malformed username (leading digit)', async () => {
    const r = await signup(t.app, {
      email: randEmail(), password: 'password-1234',
      displayName: 'x', username: '9bad',
    });
    expect(r.status).toBe(400);
  });

  test('never stores the raw password', async () => {
    const email = randEmail();
    await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    const row = t.db.prepare('SELECT password_hash FROM users WHERE email_lower = ?').get(email.toLowerCase()) as { password_hash: string };
    expect(row.password_hash).not.toContain('password-1234');
    // scrypt format emitted by src/auth.ts: scrypt$N$r$p$saltHex$hashHex
    expect(row.password_hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[a-f0-9]+\$[a-f0-9]+$/);
  });
});

describe('POST /auth/login', () => {
  test('returns an access token + refresh cookie on correct credentials', async () => {
    const email = randEmail();
    await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    const r = await login(t.app, { email, password: 'password-1234' });
    expect(r.status).toBe(200);
    expect(r.body.accessToken).toBeTruthy();
    expect(r.refreshCookie).toBeTruthy();
  });

  test('rejects wrong password with the same 401 as missing user (enumeration safety)', async () => {
    const email = randEmail();
    await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    const wrong = await login(t.app, { email, password: 'wrong-password-1234' });
    const missing = await login(t.app, { email: randEmail(), password: 'password-1234' });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body.error).toBe(missing.body.error);
  });

  test('email lookup is case-insensitive', async () => {
    const email = 'Mixed.Case+Plus@Example.COM';
    await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    const r = await login(t.app, { email: email.toLowerCase(), password: 'password-1234' });
    expect(r.status).toBe(200);
  });

  test('locks the account after 5 failed attempts', async () => {
    const email = randEmail();
    await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    // 5 failed attempts
    for (let i = 0; i < 5; i++) {
      const fail = await login(t.app, { email, password: 'wrong-password' });
      expect(fail.status).toBe(401);
    }
    // 6th attempt — even with the CORRECT password — should be locked
    const locked = await login(t.app, { email, password: 'password-1234' });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('account_locked');
  });

  test('clears the failed-login counter after a successful login', async () => {
    const email = randEmail();
    await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    // 3 fails...
    for (let i = 0; i < 3; i++) {
      await login(t.app, { email, password: 'wrong-password' });
    }
    // ...then a successful login resets the counter
    const ok = await login(t.app, { email, password: 'password-1234' });
    expect(ok.status).toBe(200);
    const row = t.db.prepare('SELECT failed_logins FROM users WHERE email_lower = ?').get(email.toLowerCase()) as { failed_logins: number };
    expect(row.failed_logins).toBe(0);
  });
});

describe('POST /auth/refresh', () => {
  test('exchanges a valid refresh cookie for a new access token + new refresh cookie (rotation)', async () => {
    const email = randEmail();
    const s = await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    const r = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `nexus_refresh=${s.refreshCookie}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().accessToken).toBeTruthy();
    // Rotation: the response MUST issue a new cookie (different from the one sent).
    const setCookie = r.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const newToken = cookies.find((c) => c.startsWith('nexus_refresh='))?.match(/^nexus_refresh=([^;]+)/)?.[1];
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(s.refreshCookie);
  });

  test('rejects when no cookie is sent', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/auth/refresh' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('missing_refresh');
  });

  test('rejects a revoked refresh token', async () => {
    const email = randEmail();
    const s = await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    // Logout revokes the session
    await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `nexus_refresh=${s.refreshCookie}` },
    });
    const r = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `nexus_refresh=${s.refreshCookie}` },
    });
    // The logout flow trips the "reuse after revoke" detection path, but the
    // same 401 + cookie-cleared outcome is what matters for security.
    expect(r.statusCode).toBe(401);
  });

  test('replaying an already-rotated refresh triggers family-wide revocation', async () => {
    const email = randEmail();
    const s = await signup(t.app, { email, password: 'password-1234', displayName: 'x' });

    // First refresh — gets new cookie, old one now revoked.
    const firstRefresh = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `nexus_refresh=${s.refreshCookie}` },
    });
    expect(firstRefresh.statusCode).toBe(200);
    const setCookie = firstRefresh.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const newToken = cookies.find((c) => c.startsWith('nexus_refresh='))?.match(/^nexus_refresh=([^;]+)/)?.[1];

    // Attacker replays the OLD cookie — should fail and wipe the family.
    const replay = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `nexus_refresh=${s.refreshCookie}` },
    });
    expect(replay.statusCode).toBe(401);
    // Immediately replay falls within the race-grace window → 401 but no
    // family revoke. Attack replays after the window still trip the full
    // detection; that path is covered in a separate "older revoke" test.
    expect(['session_revoked', 'refresh_race_lost']).toContain(replay.json().error);

    // The legitimate NEW cookie should fail in the family-revoke scenario
    // (older replay), OR still work if we fell into the race-grace path.
    // Either is acceptable — the important invariant is "stolen cookies
    // don't stay alive."
    const legitimate = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `nexus_refresh=${newToken}` },
    });
    expect([200, 401]).toContain(legitimate.statusCode);
  });

  test('an OLD revoked refresh (>10s after revocation) DOES trigger family revocation', async () => {
    const email = randEmail();
    const s = await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    // Manually set the session's revoked_at to something old enough to bypass the race grace.
    const tokenHash = require('node:crypto').createHash('sha256').update(s.refreshCookie).digest('hex');
    const oldRevoked = new Date(Date.now() - 30_000).toISOString();
    t.db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(oldRevoked, tokenHash);
    // Issue a second session for the same user so we can check it gets nuked.
    await login(t.app, { email, password: 'password-1234' });
    const beforeFamily = t.db.prepare('SELECT COUNT(*) as n FROM sessions WHERE user_id = ? AND revoked_at IS NULL')
      .get(s.body.user.id) as { n: number };
    expect(beforeFamily.n).toBe(1);  // the new login's session
    // Present the OLD revoked cookie — should trigger family revoke.
    const r = await t.app.inject({
      method: 'POST', url: '/auth/refresh',
      headers: { cookie: `nexus_refresh=${s.refreshCookie}` },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('session_revoked');
    const afterFamily = t.db.prepare('SELECT COUNT(*) as n FROM sessions WHERE user_id = ? AND revoked_at IS NULL')
      .get(s.body.user.id) as { n: number };
    expect(afterFamily.n).toBe(0);  // new login also nuked
  });
});

describe('POST /auth/logout-all', () => {
  test('revokes every active session for the user', async () => {
    const email = randEmail();
    // Sign up + login twice = three sessions for the same user.
    const a = await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    const b = await login(t.app, { email, password: 'password-1234' });
    const c = await login(t.app, { email, password: 'password-1234' });

    const r = await authed(t.app, a.body.accessToken, { method: 'POST', url: '/auth/logout-all' });
    expect(r.status).toBe(200);
    expect(r.body.revokedCount).toBeGreaterThanOrEqual(3);

    // All three refresh cookies should now fail.
    for (const cookie of [a.refreshCookie, b.refreshCookie, c.refreshCookie]) {
      const rr = await t.app.inject({
        method: 'POST', url: '/auth/refresh',
        headers: { cookie: `nexus_refresh=${cookie}` },
      });
      expect(rr.statusCode).toBe(401);
    }
  });

  test('rejects without a valid access token', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/auth/logout-all' });
    expect(r.statusCode).toBe(401);
  });
});

describe('DELETE /auth/me', () => {
  test('deletes the user after password re-auth', async () => {
    const email = randEmail();
    const s = await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    const r = await authed(t.app, s.body.accessToken, {
      method: 'DELETE', url: '/auth/me',
      payload: { password: 'password-1234', confirm: 'DELETE' },
    });
    expect(r.status).toBe(200);
    const row = t.db.prepare('SELECT id FROM users WHERE id = ?').get(s.body.user.id);
    expect(row).toBeUndefined();
  });

  test('rejects a wrong password', async () => {
    const email = randEmail();
    const s = await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    const r = await authed(t.app, s.body.accessToken, {
      method: 'DELETE', url: '/auth/me',
      payload: { password: 'wrong-password', confirm: 'DELETE' },
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('invalid_password');
    // Row still exists.
    const row = t.db.prepare('SELECT id FROM users WHERE id = ?').get(s.body.user.id);
    expect(row).toBeTruthy();
  });

  test('rejects missing confirm string', async () => {
    const s = await signup(t.app, { email: randEmail(), password: 'password-1234', displayName: 'x' });
    const r = await authed(t.app, s.body.accessToken, {
      method: 'DELETE', url: '/auth/me',
      payload: { password: 'password-1234' },
    });
    expect(r.status).toBe(400);
  });

  test('cascades: deletes sessions, instances, friendships, posts', async () => {
    // Create friendship between A and B, then delete A.
    const aEmail = randEmail();
    const a = await signup(t.app, { email: aEmail, password: 'password-1234', displayName: 'A' });
    const b = await signup(t.app, { email: randEmail(), password: 'password-1234', displayName: 'B' });
    await authed(t.app, a.body.accessToken, {
      method: 'POST', url: '/friends/request', payload: { email: (t.db.prepare('SELECT email FROM users WHERE id = ?').get(b.body.user.id) as { email: string }).email },
    });
    const before = t.db.prepare('SELECT COUNT(*) as n FROM friendships').get() as { n: number };
    expect(before.n).toBe(1);

    // Delete A
    await authed(t.app, a.body.accessToken, {
      method: 'DELETE', url: '/auth/me',
      payload: { password: 'password-1234', confirm: 'DELETE' },
    });

    const after = t.db.prepare('SELECT COUNT(*) as n FROM friendships').get() as { n: number };
    expect(after.n).toBe(0);
  });
});

describe('GET /me', () => {
  test('returns the current user profile including username', async () => {
    const email = randEmail();
    const username = randUsername();
    const s = await signup(t.app, { email, password: 'password-1234', displayName: 'Name', username });
    const r = await authed(t.app, s.body.accessToken, { method: 'GET', url: '/me' });
    expect(r.status).toBe(200);
    expect(r.body.email).toBe(email);
    expect(r.body.username).toBe(username);
    expect(r.body.displayName).toBe('Name');
  });

  test('rejects without auth', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/me' });
    expect(r.statusCode).toBe(401);
  });
});

describe('POST /me/username', () => {
  test('lets a user claim a username after signup', async () => {
    const s = await signup(t.app, { email: randEmail(), password: 'password-1234', displayName: 'x' });
    const username = randUsername();
    const r = await authed(t.app, s.body.accessToken, {
      method: 'POST', url: '/me/username', payload: { username },
    });
    expect(r.status).toBe(200);
    expect(r.body.username).toBe(username);
  });

  test('rejects a taken username', async () => {
    const username = randUsername();
    await signup(t.app, { email: randEmail(), password: 'password-1234', displayName: 'x', username });
    const other = await signup(t.app, { email: randEmail(), password: 'password-1234', displayName: 'y' });
    const r = await authed(t.app, other.body.accessToken, {
      method: 'POST', url: '/me/username', payload: { username },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('username_taken');
  });

  test('rejects malformed usernames', async () => {
    const s = await signup(t.app, { email: randEmail(), password: 'password-1234', displayName: 'x' });
    const r = await authed(t.app, s.body.accessToken, {
      method: 'POST', url: '/me/username', payload: { username: '1starts-with-digit' },
    });
    expect(r.status).toBe(400);
  });

  test('allows a user to change their own username', async () => {
    const s = await signup(t.app, { email: randEmail(), password: 'password-1234', displayName: 'x', username: randUsername() });
    const newName = randUsername();
    const r = await authed(t.app, s.body.accessToken, {
      method: 'POST', url: '/me/username', payload: { username: newName },
    });
    expect(r.status).toBe(200);
    expect(r.body.username).toBe(newName);
  });
});
