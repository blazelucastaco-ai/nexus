// IdentityStore — the Mac's long-term identity + the registry of paired phones, plus the
// one-time QR pairing handshake. This is the durable trust root for the phone link:
//   - ~/.nexus/identity/mac_ed25519.pem  — the Mac's Ed25519 private key (0600)
//   - ~/.nexus/identity/peers.json       — the allowlist of paired phones (their P-256
//                                          Secure-Enclave pubkeys). Deleting an entry
//                                          instantly revokes that phone.
// The QR encodes a single-use 256-bit secret; the phone proves it scanned the real QR via
// an HMAC tag (a relay never holds the secret), and binds its Enclave key with a P-256
// signature over a transcript covering both pubkeys. Fail-closed throughout.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../config.js';
import { createLogger } from '../utils/logger.js';
import {
  buildQrPayload,
  ed25519PrivateFromPem,
  ed25519PrivatePem,
  generateEd25519,
  p256PublicFromX963,
  p256Verify,
  pairingTag,
  pairingTranscript,
  signSdpEnvelope,
  verifyPairingTag,
  verifySdpEnvelope,
  type Ed25519Identity,
  type QrPayload,
  type Role,
  type SignedSdp,
} from './identity.js';

const log = createLogger('identity-store');

export interface PairedPeer {
  pairingId: string;
  p256X963: string; // the phone's Secure-Enclave public key (X9.63 base64)
  label?: string;
  pairedAt: number;
  lastTs?: number; // highest accepted SDP-envelope ts (anti-replay across connections)
  voipToken?: string; // APNs VoIP token (so NEXUS can ring the phone) — delivered over E2E
}

/** The phone's first pairing message (M1), relayed over the rendezvous. */
export interface PairingM1 {
  p256X963: string;
  nonce: string;
  tag: string; // HMAC(secret, "pair-m1" | pairingId | p256X963 | nonce)
  sig: string; // P256(phoneKey, pairingTranscript(pairingId, macPub, p256X963, nonce))
}

export type PairingResult =
  | { ok: true; confirmTag: string; peer: PairedPeer }
  | { ok: false; reason: string };

export class IdentityStore {
  private identity!: Ed25519Identity;
  private peers: PairedPeer[] = [];
  private pending: { payload: QrPayload } | null = null;
  private readonly keyPath: string;
  private readonly peersPath: string;

  constructor(private readonly dir = join(getDataDir(), 'identity')) {
    this.keyPath = join(dir, 'mac_ed25519.pem');
    this.peersPath = join(dir, 'peers.json');
  }

  /** Load (or create on first run) the Mac key + paired-peers registry. */
  load(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (existsSync(this.keyPath)) {
      this.identity = ed25519PrivateFromPem(readFileSync(this.keyPath, 'utf8'));
    } else {
      this.identity = generateEd25519();
      writeFileSync(this.keyPath, ed25519PrivatePem(this.identity.privateKey), { mode: 0o600 });
      log.info('generated new Mac identity key');
    }
    if (existsSync(this.peersPath)) {
      try {
        this.peers = JSON.parse(readFileSync(this.peersPath, 'utf8')) as PairedPeer[];
      } catch {
        log.warn('peers.json unreadable — starting empty');
        this.peers = [];
      }
    }
  }

  get macPublicRaw(): string {
    return this.identity.publicRaw;
  }
  get pairedPeers(): readonly PairedPeer[] {
    return this.peers;
  }
  hasPeers(): boolean {
    return this.peers.length > 0;
  }

  /** Begin pairing: mint a single-use QR payload the Mac shows at the end of setup. */
  beginPairing(rendezvousUrl: string, ttlMs = 90_000): QrPayload {
    const payload = buildQrPayload(this.identity.publicRaw, rendezvousUrl, ttlMs);
    this.pending = { payload };
    log.info({ pairingId: payload.pairingId }, 'pairing started');
    return payload;
  }

  /** The room id (= pairingId) currently awaiting a phone, or null if none/expired. */
  get pendingPairingId(): string | null {
    if (!this.pending) return null;
    if (Date.now() > this.pending.payload.exp) {
      this.pending = null;
      return null;
    }
    return this.pending.payload.pairingId;
  }

  /**
   * Complete pairing from the phone's M1. Verifies (a) the HMAC tag — proves the phone
   * holds the QR secret, which a relay never does — and (b) the P-256 signature — proves
   * the phone owns the Enclave key it's registering. On success, persists the peer and
   * returns the Mac's confirmation tag (so the phone knows the real Mac finished). Fail-closed.
   */
  completePairing(m1: PairingM1): PairingResult {
    const p = this.pending;
    if (!p || Date.now() > p.payload.exp) return { ok: false, reason: 'no active pairing' };
    const { secret, pairingId, macPub } = p.payload;

    if (!verifyPairingTag(secret, Buffer.from(m1.tag, 'base64url'), 'pair-m1', pairingId, m1.p256X963, m1.nonce)) {
      return { ok: false, reason: 'pairing HMAC failed (wrong/absent QR secret)' };
    }
    let phoneKey: ReturnType<typeof p256PublicFromX963>;
    try {
      phoneKey = p256PublicFromX963(m1.p256X963);
    } catch {
      return { ok: false, reason: 'malformed phone public key' };
    }
    const transcript = pairingTranscript(pairingId, macPub, m1.p256X963, m1.nonce);
    if (!p256Verify(phoneKey, transcript, Buffer.from(m1.sig, 'base64url'))) {
      return { ok: false, reason: 'phone key signature failed' };
    }

    const peer: PairedPeer = { pairingId, p256X963: m1.p256X963, pairedAt: Date.now() };
    this.peers = [...this.peers.filter((x) => x.pairingId !== pairingId), peer];
    this.persistPeers();
    this.pending = null;
    const confirmTag = pairingTag(secret, 'pair-m2', pairingId, this.identity.publicRaw).toString('base64url');
    log.info({ pairingId }, 'phone paired');
    return { ok: true, confirmTag, peer };
  }

  /** Revoke a paired phone (immediate — its next connection is refused). */
  removePeer(pairingId: string): boolean {
    const before = this.peers.length;
    this.peers = this.peers.filter((p) => p.pairingId !== pairingId);
    if (this.peers.length === before) return false;
    this.persistPeers();
    log.info({ pairingId }, 'peer revoked');
    return true;
  }

  /** Store the phone's APNs VoIP token (delivered over the E2E channel) for ringing it. */
  setVoipToken(pairingId: string, token: string): void {
    const peer = this.peers.find((p) => p.pairingId === pairingId);
    if (peer && peer.voipToken !== token) {
      peer.voipToken = token;
      this.persistPeers();
    }
  }

  getVoipToken(pairingId: string): string | undefined {
    return this.peers.find((p) => p.pairingId === pairingId)?.voipToken;
  }

  // ── connection-time crypto, bound to this Mac identity + a paired peer ───────────────

  /** Sign one of our SDP offers/answers for a given pairing. */
  sign(sdp: string, from: Role, pairingId: string): SignedSdp {
    return signSdpEnvelope(this.identity.privateKey, { sdp, from, pairingId });
  }

  /** A verifier closure for a paired peer: checks the signature against the stored P-256
   *  key + the pairing + a strictly-monotonic ts (replay defense persisted in peers.json). */
  makeVerifier(pairingId: string): (env: SignedSdp) => boolean {
    return (env) => {
      const peer = this.peers.find((p) => p.pairingId === pairingId);
      if (!peer) return false;
      const ok = verifySdpEnvelope(env, { p256X963: peer.p256X963 }, { expectPairingId: pairingId, lastTs: peer.lastTs });
      if (ok) {
        peer.lastTs = env.ts;
        this.persistPeers();
      }
      return ok;
    };
  }

  private persistPeers(): void {
    writeFileSync(this.peersPath, JSON.stringify(this.peers, null, 2), { mode: 0o600 });
  }
}
