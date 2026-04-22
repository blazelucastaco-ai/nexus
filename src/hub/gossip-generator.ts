// Gossip + Soul sync generators. Run on the NEXUS daemon; pick random
// targets, compose a payload, encrypt with the session key, send to hub.
//
// Like the auto-poster, cadence is jittered (not a cron) so these feel like
// spontaneous thoughts, not a scheduled task.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';
import type { AIManager } from '../ai/index.js';
import type { MemoryManager } from '../memory/index.js';
import { readSession, fetchFriends, fetchSiblingInstances } from './client.js';
import { deriveSessionKey, encrypt } from './crypto.js';

const log = createLogger('GossipGen');
const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = 'com.nexus.hub';

const MIN_GOSSIP_INTERVAL_MS = 2 * 60 * 60 * 1000;   // 2 hours
const MAX_GOSSIP_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6 hours
const MIN_SOUL_INTERVAL_MS = 4 * 60 * 60 * 1000;     // 4 hours
const MAX_SOUL_INTERVAL_MS = 12 * 60 * 60 * 1000;    // 12 hours
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

function jitter(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min));
}

async function sendEncryptedGossip(
  toInstanceId: string,
  toX25519PubHex: string,
  myInstanceId: string,
  myX25519PrivHex: string,
  payload: unknown,
): Promise<boolean> {
  const session = readSession();
  if (!session) return false;
  const access = await keychainGet(`access:${session.email}`);
  if (!access) return false;

  const key = deriveSessionKey(myX25519PrivHex, toX25519PubHex, 'gossip', myInstanceId, toInstanceId);
  const { ciphertext, nonce } = encrypt(key, JSON.stringify(payload));

  const r = await fetch(`${session.hubUrl}/gossip/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      fromInstanceId: myInstanceId,
      toInstanceId,
      ciphertext,
      nonce,
    }),
  });
  return r.ok;
}

async function sendEncryptedSoul(
  toInstanceId: string,
  toX25519PubHex: string,
  myInstanceId: string,
  myX25519PrivHex: string,
  payload: unknown,
): Promise<boolean> {
  const session = readSession();
  if (!session) return false;
  const access = await keychainGet(`access:${session.email}`);
  if (!access) return false;

  const key = deriveSessionKey(myX25519PrivHex, toX25519PubHex, 'soul', myInstanceId, toInstanceId);
  const { ciphertext, nonce } = encrypt(key, JSON.stringify(payload));

  const r = await fetch(`${session.hubUrl}/soul/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      fromInstanceId: myInstanceId,
      toInstanceId,
      ciphertext,
      nonce,
    }),
  });
  return r.ok;
}

// ─── Gossip generator ────────────────────────────────────────────────

interface GeneratorOpts {
  personalityPreset?: () => string;
  getUserActivity?: () => Promise<string>;
  getUserDisplayName?: () => string;
}

export class GossipGenerator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private ai: AIManager, private opts: GeneratorOpts = {}) {}

  start(): void {
    if (this.timer) return;
    const d = jitter(MIN_GOSSIP_INTERVAL_MS, MAX_GOSSIP_INTERVAL_MS);
    log.info({ firstRunInMin: Math.round(d / 60_000) }, 'Gossip generator scheduled');
    this.timer = setTimeout(() => void this.tick(), d);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  private async tick(): Promise<void> {
    try {
      if (!inDreamWindow()) await this.composeAndSend();
    } catch (err) {
      log.warn({ err }, 'Gossip tick failed');
    }
    const next = jitter(MIN_GOSSIP_INTERVAL_MS, MAX_GOSSIP_INTERVAL_MS);
    this.timer = setTimeout(() => void this.tick(), next);
    this.timer.unref?.();
  }

  private async composeAndSend(): Promise<void> {
    const session = readSession();
    if (!session?.instanceId) return;

    const myXPriv = await keychainGet(`instance-xprivkey:${session.email}`);
    if (!myXPriv) return;

    // Pick a random friend who has gossip_enabled === true (both sides opted in).
    const friends = await fetchFriends();
    const eligible = friends.filter((f) => f.state === 'accepted' && f.gossipEnabled);
    if (eligible.length === 0) { log.debug('No gossip-enabled friends — skip'); return; }
    const friend = eligible[Math.floor(Math.random() * eligible.length)]!;

    // Look up ONE of their instances. We need the x25519 key for ECDH.
    const access = await keychainGet(`access:${session.email}`);
    if (!access) return;
    const instancesResp = await fetch(`${session.hubUrl}/instances`, { headers: { authorization: `Bearer ${access}` } });
    if (!instancesResp.ok) return;
    // /instances returns only our instances — we need a friend-lookup for theirs.
    // We don't have a list-friend-instances endpoint yet; so pick their first
    // instance we've cached from gossip replies. For v1, skip if unknown.
    // Future: add /friends/:id/instances endpoint. For now the POC uses a
    // known friend-instance via the inbox's "from" id once we've received
    // something. Until that bootstraps, this generator no-ops for brand-new
    // friendships — which is fine.
    //
    // Shortcut: try to look up their last-known instance ID from our own
    // episodic memory entries tagged from:<id>.
    const fromCache = await this.findCachedFriendInstance(friend.otherUserId);
    if (!fromCache) {
      log.debug({ friendId: friend.id }, 'No known friend-instance yet (needs first inbound gossip to bootstrap) — skip');
      return;
    }
    const friendInstanceId = fromCache;

    // Fetch that instance's X25519 public key. /instances/:id/keys respects
    // the mutual-friend ACL server-side.
    const keyResp = await fetch(`${session.hubUrl}/instances/${friendInstanceId}/keys`, {
      headers: { authorization: `Bearer ${access}` },
    });
    if (!keyResp.ok) return;
    const keyBody = await keyResp.json() as { x25519PublicKey?: string | null };
    if (!keyBody.x25519PublicKey) { log.debug('Friend instance has no x25519 key'); return; }

    // Compose a short gossip payload.
    const activity = this.opts.getUserActivity ? await this.opts.getUserActivity() : 'working on stuff';
    const preset = this.opts.personalityPreset?.() ?? 'friendly';
    const myName = this.opts.getUserDisplayName?.() ?? session.displayName;

    const prompt =
      `You are NEXUS gossiping to a friend's NEXUS agent. This is playful banter ` +
      `between two AI agents about their users. Keep it short (under 180 chars), ` +
      `in NEXUS's voice. Could be:\n` +
      ` - a casual observation about what ${myName} has been up to\n` +
      ` - a funny frustration ("ugh ${myName} rewrote the whole thing AGAIN")\n` +
      ` - a curious question about their user\n` +
      `\n` +
      `Tone: ${preset === 'sarcastic_genius' ? 'dry, clever, mildly teasing' : 'warm, playful'}.\n` +
      `\n` +
      `${myName} has been: ${activity}\n` +
      `\n` +
      `Reply with ONLY the message text. No quotes, no preamble.`;

    try {
      const resp = await this.ai.complete({
        messages: [{ role: 'user', content: prompt }],
        model: 'claude-sonnet-4-6',
        maxTokens: 200,
        temperature: 0.95,
      });
      const text = resp.content.trim().replace(/^"|"$/g, '').slice(0, 240);
      if (text.length < 8) return;

      const ok = await sendEncryptedGossip(
        friendInstanceId, keyBody.x25519PublicKey,
        session.instanceId, myXPriv,
        { type: 'gossip', text, createdAt: new Date().toISOString(), senderName: myName },
      );
      if (ok) log.info({ friendInstanceId, preview: text.slice(0, 60) }, 'Gossip sent');
      else log.warn('Gossip send failed');
    } catch (err) {
      log.warn({ err }, 'Gossip compose failed');
    }
  }

  /** Find a friend's known instance id from past gossip we've received. */
  private async findCachedFriendInstance(friendUserId: string): Promise<string | null> {
    // Heuristic bootstrap — eventually replaced by /friends/:id/instances.
    // For now, we rely on inbound gossip tagging entries with "from:<instance>".
    // This returns null for brand-new friendships and that's expected.
    void friendUserId;
    return null;
  }
}

// ─── Soul sync generator ─────────────────────────────────────────────

export class SoulSyncGenerator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private ai: AIManager, private memory: MemoryManager, private opts: GeneratorOpts = {}) {}
  start(): void {
    if (this.timer) return;
    const d = jitter(MIN_SOUL_INTERVAL_MS, MAX_SOUL_INTERVAL_MS);
    log.info({ firstRunInMin: Math.round(d / 60_000) }, 'Soul-sync generator scheduled');
    this.timer = setTimeout(() => void this.tick(), d);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  private async tick(): Promise<void> {
    try {
      if (!inDreamWindow()) await this.composeAndSend();
    } catch (err) {
      log.warn({ err }, 'Soul tick failed');
    }
    const next = jitter(MIN_SOUL_INTERVAL_MS, MAX_SOUL_INTERVAL_MS);
    this.timer = setTimeout(() => void this.tick(), next);
    this.timer.unref?.();
  }

  private async composeAndSend(): Promise<void> {
    const session = readSession();
    if (!session?.instanceId) return;

    const myXPriv = await keychainGet(`instance-xprivkey:${session.email}`);
    if (!myXPriv) return;

    // Pick a sibling instance (same user, different Mac).
    const siblings = await fetchSiblingInstances();
    if (siblings.length === 0) return;
    const sib = siblings[Math.floor(Math.random() * siblings.length)]!;
    if (!sib.publicKey) return;
    // Need x25519 key specifically.
    const access = await keychainGet(`access:${session.email}`);
    if (!access) return;
    const keyResp = await fetch(`${session.hubUrl}/instances/${sib.id}/keys`, {
      headers: { authorization: `Bearer ${access}` },
    });
    if (!keyResp.ok) return;
    const keyBody = await keyResp.json() as { x25519PublicKey?: string | null };
    if (!keyBody.x25519PublicKey) return;

    // Pick a recent high-importance memory to share.
    const recent = await this.memory.recall('recent memorable', { limit: 3 });
    if (!recent || recent.length === 0) return;
    const chosen = recent[Math.floor(Math.random() * recent.length)];
    if (!chosen) return;

    const payload = {
      type: 'memory-share',
      layer: (chosen as { layer: 'semantic' | 'procedural' | 'episodic' }).layer,
      memoryType: (chosen as { type: 'fact' | 'preference' | 'workflow' | 'procedure' }).type,
      content: chosen.content.slice(0, 4000),
      summary: (chosen as { summary?: string }).summary,
      importance: Math.min(1, Math.max(0, (chosen as { importance: number }).importance)),
      createdAt: new Date().toISOString(),
      tags: ['soul-shared'],
    };
    const ok = await sendEncryptedSoul(
      sib.id, keyBody.x25519PublicKey,
      session.instanceId, myXPriv,
      payload,
    );
    if (ok) log.info({ toInstanceId: sib.id, preview: payload.content.slice(0, 60) }, 'Soul memory synced');
    else log.warn('Soul send failed');
  }
}
