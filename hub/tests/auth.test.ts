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
  test('exchanges a valid refresh cookie for a new access token', async () => {
    const email = randEmail();
    const s = await signup(t.app, { email, password: 'password-1234', displayName: 'x' });
    const r = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `nexus_refresh=${s.refreshCookie}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().accessToken).toBeTruthy();
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
    expect(r.statusCode).toBe(401);
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
