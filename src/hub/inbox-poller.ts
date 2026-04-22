// Gossip + Soul inbox poller. Runs on the NEXUS daemon and fetches
// undelivered messages every ~60s, decrypts them using X25519 ECDH-derived
// session keys, and writes the plaintext payloads into episodic memory.
//
// Guards:
//   - Paused during the 2am-5am dream window (same gate as heartbeats).
//   - Skipped when no hub session (account gate already locked us).
//   - Decryption failures (wrong key, tampered payload, bad nonce) are
//     silently dropped — we never crash a live daemon on bad inputs.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';
import type { MemoryManager } from '../memory/index.js';
import {
  readSession, fetchGossipInbox, fetchSoulInbox,
} from './client.js';
import { deriveSessionKey, decrypt } from './crypto.js';

const log = createLogger('InboxPoller');
const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = 'com.nexus.hub';
const POLL_INTERVAL_MS = 60 * 1000;
const NIGHT_START_HOUR = 2;
const NIGHT_END_HOUR = 5;

async function keychainGet(account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w',
    ]);
    return stdout.trim() || null;
  } catch { return null; }
}

function inDreamWindow(): boolean {
  const h = new Date().getHours();
  return h >= NIGHT_START_HOUR && h < NIGHT_END_HOUR;
}

interface GossipPayload {
  type: 'gossip';
  text: string;
  createdAt: string;
  senderName?: string;
}

interface SoulPayload {
  type: 'memory-share';
  layer: 'semantic' | 'procedural' | 'episodic';
  memoryType: 'fact' | 'preference' | 'workflow' | 'procedure';
  content: string;
  summary?: string;
  importance: number;
  createdAt: string;
  tags?: string[];
}

type Payload = GossipPayload | SoulPayload;

function isValidPayload(p: unknown): p is Payload {
  if (!p || typeof p !== 'object') return false;
  const x = p as Record<string, unknown>;
  if (x.type === 'gossip') return typeof x.text === 'string' && x.text.length < 2000;
  if (x.type === 'memory-share') {
    return typeof x.content === 'string'
      && typeof x.importance === 'number'
      && ['semantic', 'procedural', 'episodic'].includes(x.layer as string);
  }
  return false;
}

export class InboxPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private memory: MemoryManager) {}

  start(): void {
    if (this.timer) return;
    // First pass after 20s so the daemon isn't pounding the hub on boot.
    setTimeout(() => { void this.tick(); }, 20_000);
    this.timer = setInterval(() => { void this.tick(); }, POLL_INTERVAL_MS);
    this.timer.unref?.();
    log.info({ intervalMs: POLL_INTERVAL_MS }, 'Inbox poller started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async tick(): Promise<void> {
    if (inDreamWindow()) return;
    const session = readSession();
    if (!session?.instanceId) return;

    const email = session.email;
    const xPrivHex = await keychainGet(`instance-xprivkey:${email}`);
    if (!xPrivHex) {
      log.warn('No X25519 private key in keychain — skipping poll. Re-login to regenerate.');
      return;
    }

    await this.pollGossip(email, xPrivHex, session.instanceId);
    await this.pollSoul(email, xPrivHex, session.instanceId);
  }

  private async pollGossip(_email: string, myXPrivHex: string, myInstanceId: string): Promise<void> {
    const messages = await fetchGossipInbox();
    if (messages.length === 0) return;
    log.debug({ count: messages.length }, 'Gossip inbox fetched');

    for (const m of messages) {
      const senderXPub = await this.lookupInstanceXPubKey(m.fromInstanceId);
      if (!senderXPub) {
        log.warn({ fromInstanceId: m.fromInstanceId }, 'No X25519 key for sender — dropping');
        continue;
      }
      const key = deriveSessionKey(myXPrivHex, senderXPub, 'gossip', m.fromInstanceId, myInstanceId);
      const plaintext = decrypt(key, m.ciphertext, m.nonce);
      if (!plaintext) {
        log.warn({ id: m.id }, 'Gossip decrypt failed — dropping');
        continue;
      }
      try {
        const payload: unknown = JSON.parse(plaintext);
        if (!isValidPayload(payload) || payload.type !== 'gossip') continue;
        await this.handleGossip(payload, m.fromInstanceId);
      } catch {
        log.debug({ id: m.id }, 'Gossip JSON parse failed — dropping');
      }
    }
  }

  private async pollSoul(_email: string, myXPrivHex: string, myInstanceId: string): Promise<void> {
    const messages = await fetchSoulInbox();
    if (messages.length === 0) return;
    log.debug({ count: messages.length }, 'Soul inbox fetched');

    for (const m of messages) {
      const senderXPub = await this.lookupInstanceXPubKey(m.fromInstanceId);
      if (!senderXPub) continue;
      const key = deriveSessionKey(myXPrivHex, senderXPub, 'soul', m.fromInstanceId, myInstanceId);
      const plaintext = decrypt(key, m.ciphertext, m.nonce);
      if (!plaintext) {
        log.warn({ id: m.id }, 'Soul decrypt failed — dropping');
        continue;
      }
      try {
        const payload: unknown = JSON.parse(plaintext);
        if (!isValidPayload(payload) || payload.type !== 'memory-share') continue;
        await this.handleSoulMemory(payload, m.fromInstanceId);
      } catch {
        log.debug({ id: m.id }, 'Soul JSON parse failed — dropping');
      }
    }
  }

  private async handleGossip(p: GossipPayload, fromInstanceId: string): Promise<void> {
    const senderLabel = p.senderName ? `${p.senderName}'s agent` : 'a friend\'s agent';
    const content = `Gossip received from ${senderLabel}: ${p.text}`;
    try {
      await this.memory.store('episodic', 'conversation', content, {
        importance: 0.4,
        tags: ['gossip', 'imported', `from:${fromInstanceId}`],
        source: 'gossip-inbox',
      });
      log.info({ fromInstanceId, preview: p.text.slice(0, 80) }, 'Gossip stored to episodic');
    } catch (err) {
      log.warn({ err }, 'Storing gossip failed');
    }
  }

  private async handleSoulMemory(p: SoulPayload, fromInstanceId: string): Promise<void> {
    try {
      await this.memory.store(p.layer, p.memoryType, p.content, {
        summary: p.summary,
        importance: Math.max(0, Math.min(1, p.importance)),
        tags: [...(p.tags ?? []), 'soul-imported', `from:${fromInstanceId}`],
        source: 'soul-imported',
      });
      log.info({ fromInstanceId, layer: p.layer, preview: p.content.slice(0, 80) }, 'Soul memory merged');
    } catch (err) {
      log.warn({ err }, 'Merging soul memory failed');
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private instanceKeyCache = new Map<string, { xPub: string | null; fetchedAt: number }>();
  private async lookupInstanceXPubKey(instanceId: string): Promise<string | null> {
    const cached = this.instanceKeyCache.get(instanceId);
    if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) return cached.xPub;
    // fetchWithAuth is in client.ts; but we only have a narrow helper. Use
    // a direct fetch with Keychain-backed access token so we don't widen
    // the public client surface.
    const session = readSession();
    if (!session) return null;
    const access = await keychainGet(`access:${session.email}`);
    if (!access) return null;
    try {
      const r = await fetch(`${session.hubUrl}/instances/${instanceId}/keys`, {
        headers: { authorization: `Bearer ${access}` },
      });
      if (!r.ok) { this.instanceKeyCache.set(instanceId, { xPub: null, fetchedAt: Date.now() }); return null; }
      const body = (await r.json()) as { x25519PublicKey?: string | null };
      const xPub = body.x25519PublicKey ?? null;
      this.instanceKeyCache.set(instanceId, { xPub, fetchedAt: Date.now() });
      return xPub;
    } catch {
      return null;
    }
  }
}
