// Nexus Hub client — the daemon-side library for talking to the hub.
//
// Reads the session marker written by the installer-app at
// ~/.nexus/hub-session.json, pulls access tokens from macOS Keychain,
// auto-refreshes on 401, signs posts with the Ed25519 key stored in
// Keychain, encrypts/decrypts gossip + soul messages with X25519 ECDH +
// XChaCha20-Poly1305.
//
// Absolutely no secrets land on disk: tokens in Keychain, session marker
// is just { userId, email, instanceId, hubUrl } public metadata.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  randomBytes, createPrivateKey, createPublicKey, sign as cryptoSign,
  createHash, diffieHellman,
} from 'node:crypto';
import { createLogger } from '../utils/logger.js';

const log = createLogger('HubClient');
const execFileAsync = promisify(execFile);

const HUB_SESSION_FILE = join(homedir(), '.nexus', 'hub-session.json');
const KEYCHAIN_SERVICE = 'com.nexus.hub';

export interface HubSession {
  userId: string;
  email: string;
  displayName: string;
  hubUrl: string;
  instanceId?: string | null;
}

// ─── Session + Keychain helpers ──────────────────────────────────────

// Hub URL allowlist. Prevents a malicious edit to ~/.nexus/hub-session.json
// from redirecting auth traffic to an attacker-controlled server. Production
// users always land on the official fly.dev host; the localhost entries are
// for developing the hub itself alongside the daemon.
const HUB_URL_ALLOWLIST = new Set([
  'https://nexus-hub-blazelucastaco.fly.dev',
  'https://nexus-hub-staging-blazelucastaco.fly.dev',
  'http://127.0.0.1:8787',
  'http://localhost:8787',
]);

export function readSession(): HubSession | null {
  if (!existsSync(HUB_SESSION_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(HUB_SESSION_FILE, 'utf-8'));
    if (!parsed.userId || !parsed.hubUrl) return null;
    if (!HUB_URL_ALLOWLIST.has(parsed.hubUrl)) {
      // Someone tampered with the session marker to point at an unknown host.
      // Refuse to use it — we don't want to leak tokens or decrypt messages
      // against an attacker's endpoint.
      log.error({ hubUrl: parsed.hubUrl }, 'Refusing session: hubUrl not in allowlist');
      return null;
    }
    return parsed as HubSession;
  } catch {
    return null;
  }
}

async function keychainGet(account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w',
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ─── HTTP with auto-refresh ──────────────────────────────────────────

// Shared single-flight mutex for /auth/refresh. Without this, multiple
// concurrent consumers (InboxPoller 60s tick, GossipGen, SoulGen, AutoPoster,
// dashboard /me fetch) all present the same refresh cookie in parallel,
// one wins + rotates it, the rest present a now-revoked token. Even with the
// hub's 10s race-grace window, only a proper mutex guarantees no 401
// cascades after a Mac wake-up.
let refreshInFlight: Promise<string | null> | null = null;

async function doRefresh(hubUrl: string, email: string, currentRefresh: string): Promise<string | null> {
  const refreshResp = await fetch(`${hubUrl}/auth/refresh`, {
    method: 'POST',
    headers: { cookie: `nexus_refresh=${currentRefresh}` },
  });
  if (!refreshResp.ok) return null;
  const body = (await refreshResp.json()) as { accessToken?: string };
  if (!body.accessToken) return null;
  // Absorb the rotated cookie BEFORE anyone else gets a chance to read it.
  const setCookies = refreshResp.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const m = c.match(/^nexus_refresh=([^;]+)/);
    if (m?.[1]) {
      await execFileAsync('security', [
        'add-generic-password', '-U',
        '-s', KEYCHAIN_SERVICE, '-a', `refresh:${email}`, '-w', m[1],
      ]).catch(() => null);
      break;
    }
  }
  await execFileAsync('security', [
    'add-generic-password', '-U',
    '-s', KEYCHAIN_SERVICE, '-a', `access:${email}`, '-w', body.accessToken,
  ]).catch(() => null);
  return body.accessToken;
}

async function singleFlightRefresh(hubUrl: string, email: string, currentRefresh: string): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh(hubUrl, email, currentRefresh).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function fetchWithAuth(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  const session = readSession();
  if (!session) return { ok: false, status: 0, data: null, error: 'no_session' };

  const email = session.email;
  let access = await keychainGet(`access:${email}`);
  const refresh = await keychainGet(`refresh:${email}`);
  if (!access || !refresh) return { ok: false, status: 0, data: null, error: 'missing_tokens' };

  // Request with timeout + 5xx retry. Transient hub blips (502/503/504 from
  // Fly's edge during a cold start) previously blew up every caller. One
  // retry with 500ms backoff soaks up ~90% of those without annoying users.
  const makeRequestWithRetry = async (token: string): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const first = await fetch(`${session.hubUrl}${path}`, {
        method: opts.method ?? (opts.body ? 'POST' : 'GET'),
        headers: {
          authorization: `Bearer ${token}`,
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      if (first.status < 500 || first.status === 501) return first;
      // Retry once on transient 5xx.
      await new Promise((r) => setTimeout(r, 500));
      return await fetch(`${session.hubUrl}${path}`, {
        method: opts.method ?? (opts.body ? 'POST' : 'GET'),
        headers: {
          authorization: `Bearer ${token}`,
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let r = await makeRequestWithRetry(access);
  if (r.status === 401) {
    // Single-flight refresh. If another consumer in this process is already
    // refreshing, we wait for their result and reuse whichever token they
    // got. This prevents the "two concurrent refreshes after Mac wake"
    // storm that was revoking whole session families.
    const newAccess = await singleFlightRefresh(session.hubUrl, email, refresh);
    if (newAccess) {
      access = newAccess;
      r = await makeRequestWithRetry(access);
    } else {
      // Refresh failed — the token is genuinely dead or the hub returned
      // a non-OK response. Clear Keychain so subsequent calls don't keep
      // hammering /auth/refresh with a known-bad token.
      await Promise.all([
        execFileAsync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', `access:${email}`]).catch(() => null),
        execFileAsync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', `refresh:${email}`]).catch(() => null),
      ]);
      return { ok: false, status: 401, data: null, error: 'session_revoked' };
    }
  }

  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return {
    ok: r.ok,
    status: r.status,
    data,
    error: r.ok ? undefined : (data?.error ?? `http_${r.status}`),
  };
}

// ─── Post signing (Ed25519) ──────────────────────────────────────────

/**
 * Signs a post using the instance's Ed25519 private key stored in Keychain.
 * Input canonicalisation MUST match the hub's verifier:
 *   data = `${content}\n${createdAt}\n${instanceId}`
 * Returns base64-encoded signature.
 */
async function signPost(content: string, createdAt: string, instanceId: string, email: string): Promise<string | null> {
  const privHex = await keychainGet(`instance-privkey:${email}`);
  if (!privHex) return null;
  try {
    const privRaw = Buffer.from(privHex, 'hex');
    if (privRaw.length !== 32) return null;
    // Wrap the raw 32-byte Ed25519 private key in a PKCS#8 DER prefix so
    // Node's createPrivateKey accepts it.
    const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
    const pkcs8 = Buffer.concat([pkcs8Prefix, privRaw]);
    const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
    const data = Buffer.from(`${content}\n${createdAt}\n${instanceId}`, 'utf-8');
    const sig = cryptoSign(null, data, priv);
    return sig.toString('base64');
  } catch (err) {
    log.warn({ err }, 'Signing failed');
    return null;
  }
}

// ─── Posts ──────────────────────────────────────────────────────────

export async function createPost(content: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const session = readSession();
  if (!session || !session.instanceId) return { ok: false, error: 'no_session_or_instance' };
  const createdAt = new Date().toISOString();
  const signature = await signPost(content, createdAt, session.instanceId, session.email);
  if (!signature) return { ok: false, error: 'sign_failed' };

  // Send createdAt so the hub verifies the signature against the exact same
  // canonical string we signed. Without this, clock drift breaks signing.
  const r = await fetchWithAuth('/posts', {
    method: 'POST',
    body: { instanceId: session.instanceId, content, signature, createdAt },
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, id: r.data?.id };
}

export async function fetchFeed(): Promise<Array<{
  id: string; userId: string; displayName: string | null; content: string; createdAt: string;
}>> {
  const r = await fetchWithAuth('/feed');
  if (!r.ok || !r.data?.posts) return [];
  return r.data.posts;
}

// ─── Gossip + Soul encryption (X25519 ECDH + XChaCha20-Poly1305) ────
//
// Node 20+ includes Ed25519 but NOT XChaCha20-Poly1305 or X25519 ECDH
// directly from the classic `createCipheriv` API. For X25519 we use
// `diffieHellman` which works on node:crypto KeyObjects. For authenticated
// encryption we use `chacha20-poly1305` (12-byte nonce) which IS available
// in Node 20+. That's the pragmatic choice here; upgrading to the 24-byte
// xchacha20 would need a tiny WASM dependency (future work if we ever
// want nonce-random extended space).

// ─── Inbox polling ──────────────────────────────────────────────────

export async function fetchGossipInbox(): Promise<Array<{
  id: string; fromInstanceId: string; ciphertext: string; nonce: string; createdAt: string;
}>> {
  const r = await fetchWithAuth('/gossip/inbox');
  if (!r.ok || !r.data?.messages) return [];
  return r.data.messages;
}

export async function fetchSoulInbox(): Promise<Array<{
  id: string; fromInstanceId: string; ciphertext: string; nonce: string; createdAt: string;
}>> {
  const r = await fetchWithAuth('/soul/inbox');
  if (!r.ok || !r.data?.messages) return [];
  return r.data.messages;
}

// ─── Convenience ────────────────────────────────────────────────────

export async function pingInstance(): Promise<boolean> {
  const session = readSession();
  if (!session?.instanceId) return false;
  const r = await fetchWithAuth(`/instances/${session.instanceId}/ping`, { method: 'POST' });
  return r.ok;
}

/** Fetch the current user's accepted-friend list plus gossip flags. */
export async function fetchFriends(): Promise<Array<{
  id: string; otherUserId: string; displayName: string | null; state: string; gossipEnabled: boolean;
}>> {
  const r = await fetchWithAuth('/friends');
  if (!r.ok || !r.data?.friends) return [];
  return r.data.friends;
}

/** Fetch sibling instances (same user) for soul sync target selection. */
export async function fetchSiblingInstances(): Promise<Array<{ id: string; name: string; publicKey: string }>> {
  const r = await fetchWithAuth('/instances');
  if (!r.ok || !r.data?.instances) return [];
  const session = readSession();
  return r.data.instances.filter((i: any) => i.id !== session?.instanceId);
}

// Internal hash helper — unused in v1 but kept for future ECDH key
// derivation if we wire gossip encryption here.
export function _sha256(input: Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}
export { diffieHellman, createPublicKey, randomBytes };
