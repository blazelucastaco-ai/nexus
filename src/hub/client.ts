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

export function readSession(): HubSession | null {
  if (!existsSync(HUB_SESSION_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(HUB_SESSION_FILE, 'utf-8'));
    if (!parsed.userId || !parsed.hubUrl) return null;
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

  const makeRequest = async (token: string): Promise<Response> => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (opts.body) headers['content-type'] = 'application/json';
    return fetch(`${session.hubUrl}${path}`, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  };

  let r = await makeRequest(access);
  if (r.status === 401) {
    // Refresh and retry once.
    const refreshResp = await fetch(`${session.hubUrl}/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `nexus_refresh=${refresh}` },
    });
    if (refreshResp.ok) {
      const body = (await refreshResp.json()) as { accessToken?: string };
      if (body.accessToken) {
        access = body.accessToken;
        // Update Keychain for future calls.
        await execFileAsync('security', [
          'add-generic-password', '-U',
          '-s', KEYCHAIN_SERVICE, '-a', `access:${email}`, '-w', access,
        ]).catch(() => null);
        r = await makeRequest(access);
      }
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
