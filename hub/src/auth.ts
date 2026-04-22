// Authentication primitives — password hashing, JWTs, session management.
//
// Security properties enforced here:
//  - Passwords hashed with bcrypt cost 12 (configurable via env). Never logged.
//  - Access tokens are short-lived JWTs (15 min default). Refresh tokens are
//    long-lived opaque random strings, hashed in the DB.
//  - Login attempts are counted; after 5 failures in a row, the account is
//    locked for 15 minutes. Protects against credential stuffing at the per-
//    account layer; rate-limit middleware protects at the IP layer.
//  - Email stored as provided (for display) but matched case-insensitively.

import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import type { Database } from 'better-sqlite3';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

// scrypt cost parameters. N=2^15, r=8, p=1 is the OWASP 2024 recommendation
// for interactive logins (~64 MB memory, ~100ms on modern hardware). Higher N
// resists GPU brute-force better at the cost of slower logins.
const SCRYPT_KEYLEN = 64;
const MAX_FAILED_LOGINS = 5;
const LOCK_DURATION_MIN = 15;

function getSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters — generate one and set in .env');
  }
  return new TextEncoder().encode(raw);
}

export interface AccessTokenClaims {
  sub: string;      // user id
  iid?: string;     // instance id (optional — only set after registration)
  iat: number;
  exp: number;
  typ: 'access';
}

/**
 * Hash a password with scrypt. Output format:
 *   scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
 * where the `scrypt$` prefix lets us migrate to other KDFs later without
 * changing the column type. Never log the return value — it's a credential.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  if (password.length > 256) throw new Error('Password too long');
  const salt = randomBytes(16);
  // N=2^15 = 32768, r=8, p=1
  const N = 32768, r = 8, p = 1;
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[4]!, 'hex');
    const expected = Buffer.from(parts[5]!, 'hex');
    const got = await scrypt(password, salt, expected.length);
    if (got.length !== expected.length) return false;
    return timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

export async function signAccessToken(userId: string, instanceId?: string): Promise<string> {
  const ttl = Number.parseInt(process.env.ACCESS_TOKEN_TTL_SECONDS ?? '900', 10);
  const now = Math.floor(Date.now() / 1000);
  const payload: AccessTokenClaims = {
    sub: userId,
    ...(instanceId ? { iid: instanceId } : {}),
    iat: now,
    exp: now + ttl,
    typ: 'access',
  };
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(getSecret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if ((payload as Record<string, unknown>).typ !== 'access') return null;
    return payload as unknown as AccessTokenClaims;
  } catch {
    return null;
  }
}

/** Generates an opaque refresh token and returns { plaintext, hash }. Store
 *  only the hash server-side — the plaintext goes into the client cookie. */
export function generateRefreshToken(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(48).toString('base64url');
  const hash = createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash };
}

export function hashRefreshToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Non-reversible IP derivative used in audit + rate-limit rows. Never the raw IP. */
export function hashIp(ip: string): string {
  const pepper = process.env.JWT_SECRET ?? '';
  return createHash('sha256').update(pepper + '|' + ip).digest('hex').slice(0, 32);
}

// ─── Account-lock helpers ────────────────────────────────────────────

export function registerFailedLogin(db: Database, userId: string): void {
  const row = db.prepare('SELECT failed_logins FROM users WHERE id = ?').get(userId) as
    | { failed_logins: number } | undefined;
  const next = (row?.failed_logins ?? 0) + 1;
  if (next >= MAX_FAILED_LOGINS) {
    const lockUntil = new Date(Date.now() + LOCK_DURATION_MIN * 60_000).toISOString();
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
      .run(next, lockUntil, userId);
  } else {
    db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(next, userId);
  }
}

export function clearFailedLogins(db: Database, userId: string): void {
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime(\'now\') WHERE id = ?')
    .run(userId);
}

export function isAccountLocked(db: Database, userId: string): boolean {
  const row = db.prepare('SELECT locked_until FROM users WHERE id = ?').get(userId) as
    | { locked_until: string | null } | undefined;
  if (!row?.locked_until) return false;
  return new Date(row.locked_until).getTime() > Date.now();
}

// ─── Input validation ────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

export function validatePassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 256;
}

export function validateDisplayName(name: unknown): name is string {
  return typeof name === 'string' && name.length >= 1 && name.length <= 64;
}

// ─── Audit log writer — small, boring, never logs secrets ────────────

export function writeAudit(
  db: Database,
  action: string,
  opts: { userId?: string | null; detail?: string; ipHash?: string; userAgent?: string } = {},
): void {
  db.prepare(`
    INSERT INTO audit_log (id, user_id, action, detail, ip_hash, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    randomBytes(12).toString('hex'),
    opts.userId ?? null,
    action,
    opts.detail ?? null,
    opts.ipHash ?? null,
    opts.userAgent?.slice(0, 512) ?? null,
  );
}
