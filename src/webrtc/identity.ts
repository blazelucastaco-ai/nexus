// Device identity + pairing crypto for the NEXUS phone link.
//
// The whole E2E promise rests here: long-term identity keys authenticate the WebRTC
// connection so the (self-hosted, data-blind) rendezvous can never MITM. We use Node's
// built-in crypto (OpenSSL) — no extra dependency:
//   - Mac identity:  Ed25519 (sign/verify)            — this device's identity.
//   - Phone identity: P-256 ECDSA, in the Secure Enclave (Enclave does P-256 only).
//     The Mac VERIFIES the phone's P-256 signatures; the phone verifies the Mac's
//     Ed25519. Signatures are intentionally MIXED-CURVE — do not "simplify" to one curve
//     or you break Secure-Enclave non-exportability.
//
// The pairing secret (256-bit, from the QR, off-network) is used ONLY as an HMAC key.
// It is NEVER fed to a KDF — in particular not src/utils/crypto.ts deriveKey() (saltless).

import {
  createHash,
  createHmac,
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
  type KeyObject,
} from 'node:crypto';

// ── primitives ───────────────────────────────────────────────────────────────

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

export function hmacSha256(key: Buffer, data: Buffer | string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** Constant-time compare (both must be equal length to be equal). */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Mac identity: Ed25519 ──────────────────────────────────────────────────────

export interface Ed25519Identity {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  /** Raw 32-byte public key, base64url — what goes in the QR + peer registry. */
  readonly publicRaw: string;
}

export function generateEd25519(): Ed25519Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey, privateKey, publicRaw: ed25519PublicRaw(publicKey) };
}

/** Raw 32-byte Ed25519 public key as base64url (matches iOS CryptoKit raw form). */
export function ed25519PublicRaw(pub: KeyObject): string {
  const jwk = pub.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('not an Ed25519 public key');
  return jwk.x; // already base64url
}

/** Import a raw 32-byte Ed25519 public key (base64url) for verification. */
export function ed25519PublicFromRaw(rawB64url: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: rawB64url }, format: 'jwk' });
}

/** Serialize/restore the private key for at-rest persistence (PKCS8 PEM). */
export function ed25519PrivatePem(priv: KeyObject): string {
  return priv.export({ type: 'pkcs8', format: 'pem' }).toString();
}
export function ed25519PrivateFromPem(pem: string): Ed25519Identity {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  return { publicKey, privateKey, publicRaw: ed25519PublicRaw(publicKey) };
}

export function ed25519Sign(priv: KeyObject, data: Buffer): Buffer {
  return nodeSign(null, data, priv);
}
export function ed25519Verify(pub: KeyObject, data: Buffer, sig: Buffer): boolean {
  try {
    return nodeVerify(null, data, pub, sig);
  } catch {
    return false;
  }
}

// ── Phone identity: P-256 ECDSA (verify-only on the Mac) ────────────────────────

/** Import an iOS Secure-Enclave P-256 public key from its X9.63 form (0x04‖X‖Y, 65
 *  bytes, base64) — CryptoKit's `publicKey.x963Representation`. */
export function p256PublicFromX963(x963B64: string): KeyObject {
  const buf = Buffer.from(x963B64, 'base64');
  if (buf.length !== 65 || buf[0] !== 0x04) throw new Error('expected 65-byte uncompressed P-256 point');
  const x = buf.subarray(1, 33).toString('base64url');
  const y = buf.subarray(33, 65).toString('base64url');
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' });
}

/** Verify a P-256 ECDSA signature. iOS CryptoKit's `.rawRepresentation` is raw r‖s
 *  (64 bytes) — so we tell OpenSSL the signature is IEEE-P1363, not DER. */
export function p256Verify(pub: KeyObject, data: Buffer, rawSig: Buffer): boolean {
  try {
    return nodeVerify('sha256', data, { key: pub, dsaEncoding: 'ieee-p1363' }, rawSig);
  } catch {
    return false;
  }
}

// ── SDP / connection authentication — the crux ─────────────────────────────────
//
// The rendezvous relays the SDP, which carries the DTLS fingerprint. Each side signs
// its SDP (incl. the fingerprint) with its long-term key; the peer verifies against the
// STORED pubkey and, after DTLS connects, asserts the negotiated remote fingerprint
// equals the signed one. A rendezvous that swaps the fingerprint invalidates the
// signature → fail closed → no MITM.

export type Role = 'mac' | 'phone';

export interface SignedSdp {
  sdp: string;
  from: Role;
  ts: number; // unix ms — fresh + monotonic per pairing (anti-replay)
  pairingId: string;
  sig: string; // base64url
}

/** Canonical, domain-separated, length-prefixed transcript that the signature covers.
 *  Exported so both signer sides (Ed25519 Mac, P-256 phone) bind the exact same bytes. */
export function sdpTranscript(pairingId: string, from: Role, ts: number, sdp: string): Buffer {
  const parts = ['nexus-sdp-v1', pairingId, from, String(ts), sdp];
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    chunks.push(len, b);
  }
  return sha256(Buffer.concat(chunks));
}

/** Sign an offer/answer envelope with this device's long-term key (Ed25519, Mac side). */
export function signSdpEnvelope(
  priv: KeyObject,
  fields: { sdp: string; from: Role; pairingId: string; ts?: number },
): SignedSdp {
  const ts = fields.ts ?? Date.now();
  const transcript = sdpTranscript(fields.pairingId, fields.from, ts, fields.sdp);
  const sig = ed25519Sign(priv, transcript).toString('base64url');
  return { sdp: fields.sdp, from: fields.from, ts, pairingId: fields.pairingId, sig };
}

/**
 * Verify a received offer/answer envelope against the stored peer key. Returns true only
 * if the signature is valid AND `ts` passes the freshness/monotonic checks. The caller
 * MUST additionally assert the negotiated DTLS fingerprint == extractFingerprint(env.sdp)
 * after the connection establishes (see WebRtcPeer). Fail-closed by construction.
 */
export function verifySdpEnvelope(
  env: SignedSdp,
  peer: { ed25519Raw?: string; p256X963?: string },
  opts: { expectPairingId: string; lastTs?: number; skewMs?: number },
): boolean {
  if (env.pairingId !== opts.expectPairingId) return false;
  const skew = opts.skewMs ?? 120_000;
  if (!Number.isFinite(env.ts)) return false;
  if (Math.abs(Date.now() - env.ts) > skew) return false; // coarse window
  if (opts.lastTs !== undefined && env.ts <= opts.lastTs) return false; // strictly monotonic
  const transcript = sdpTranscript(env.pairingId, env.from, env.ts, env.sdp);
  const sig = Buffer.from(env.sig, 'base64url');
  if (peer.ed25519Raw) return ed25519Verify(ed25519PublicFromRaw(peer.ed25519Raw), transcript, sig);
  if (peer.p256X963) return p256Verify(p256PublicFromX963(peer.p256X963), transcript, sig);
  return false;
}

/** Pull the SHA-256 DTLS fingerprint out of an SDP, normalized (upper-hex, colon-sep). */
export function extractFingerprint(sdp: string): string | null {
  const m = sdp.match(/a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/);
  return m?.[1] ? m[1].toUpperCase().replace(/[^0-9A-F:]/g, '') : null;
}

/** True iff the actual negotiated remote fingerprint matches the one in the signed SDP. */
export function fingerprintMatches(signedSdp: string, negotiated: string | null): boolean {
  if (!negotiated) return false;
  const claimed = extractFingerprint(signedSdp);
  if (!claimed) return false;
  return claimed === negotiated.toUpperCase().replace(/[^0-9A-F:]/g, '');
}

// ── QR pairing handshake (HMAC-authenticated, pairing_secret = HMAC key) ────────

export interface QrPayload {
  v: 1;
  macPub: string; // Ed25519 raw, base64url
  secret: string; // 256-bit single-use pairing secret, base64url
  rendezvous: string;
  pairingId: string;
  exp: number; // unix ms expiry
}

export function buildQrPayload(macPubRaw: string, rendezvous: string, ttlMs = 90_000): QrPayload {
  return {
    v: 1,
    macPub: macPubRaw,
    secret: randomToken(32),
    rendezvous,
    pairingId: randomBytes(16).toString('hex'),
    exp: Date.now() + ttlMs,
  };
}

/** Tag over a pairing message, keyed by the QR's secret. Both sides hold the secret
 *  (the Mac minted it; the phone scanned it) — a relay never does, so it can't forge. */
export function pairingTag(secret: string, label: string, ...fields: string[]): Buffer {
  const key = Buffer.from(secret, 'base64url');
  const parts = [label, ...fields];
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    chunks.push(len, b);
  }
  return hmacSha256(key, Buffer.concat(chunks));
}

export function verifyPairingTag(secret: string, tag: Buffer, label: string, ...fields: string[]): boolean {
  return safeEqual(tag, pairingTag(secret, label, ...fields));
}
