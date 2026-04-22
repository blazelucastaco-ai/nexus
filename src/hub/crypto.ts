// Gossip + Soul end-to-end crypto.
//
// Scheme: X25519 ECDH → HKDF-SHA256 → ChaCha20-Poly1305 (AEAD).
//
// Both instances derive the same session key client-side. The hub only ever
// sees ciphertext + a random 12-byte nonce + auth tag. Because the ECDH
// output is deterministic from the key pair on each side, the key stays
// stable over time — we accept the tradeoff against forward secrecy for v1
// (adding a double-ratchet Signal-style setup is the obvious Phase-4 upgrade).
//
// All private keys live in macOS Keychain; this module never reads the
// filesystem directly — callers pass the private key bytes in.

import {
  createPrivateKey, createPublicKey, diffieHellman, hkdfSync,
  randomBytes, createCipheriv, createDecipheriv,
} from 'node:crypto';

// ─── Key wrapping ────────────────────────────────────────────────────

/** Wrap a raw 32-byte X25519 private key in PKCS#8 DER so node:crypto accepts it. */
function x25519PrivateKeyObject(rawHex: string): ReturnType<typeof createPrivateKey> {
  const raw = Buffer.from(rawHex, 'hex');
  if (raw.length !== 32) throw new Error('x25519 private key must be 32 bytes');
  // PKCS#8 prefix for X25519: SEQUENCE { version=0, AlgorithmIdentifier(1.3.101.110), OCTET STRING (32) }
  const prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
  const pkcs8 = Buffer.concat([prefix, raw]);
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

function x25519PublicKeyObject(rawHex: string): ReturnType<typeof createPublicKey> {
  const raw = Buffer.from(rawHex, 'hex');
  if (raw.length !== 32) throw new Error('x25519 public key must be 32 bytes');
  // SPKI prefix for X25519: SEQUENCE { AlgorithmIdentifier(1.3.101.110), BIT STRING(32) }
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  const spki = Buffer.concat([prefix, raw]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

/** Generate a fresh X25519 keypair. Returns raw 32-byte hex strings for storage. */
export function generateX25519Keypair(): { publicKeyHex: string; privateKeyHex: string } {
  // Use Node's generateKeyPair for X25519, then export the raw 32-byte bytes.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync } = require('node:crypto') as typeof import('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  if (!pubJwk.x || !privJwk.d) throw new Error('x25519 key export failed');
  return {
    publicKeyHex: Buffer.from(pubJwk.x, 'base64url').toString('hex'),
    privateKeyHex: Buffer.from(privJwk.d, 'base64url').toString('hex'),
  };
}

// ─── Shared-key derivation ───────────────────────────────────────────

const HKDF_SALT = Buffer.from('nexus-hub/v1', 'utf-8');

/**
 * Derive a 32-byte session key between two instances using X25519 ECDH +
 * HKDF-SHA256. Both sides MUST call this with the same (ordered) instance
 * IDs in `info` so they converge on the same key.
 *
 * @param context  'gossip' or 'soul' — domain separation so a gossip key
 *                  can't be reused for soul and vice versa.
 */
export function deriveSessionKey(
  myPrivateKeyHex: string,
  theirPublicKeyHex: string,
  context: 'gossip' | 'soul',
  instanceIdA: string,
  instanceIdB: string,
): Buffer {
  const myPriv = x25519PrivateKeyObject(myPrivateKeyHex);
  const theirPub = x25519PublicKeyObject(theirPublicKeyHex);
  const shared = diffieHellman({ privateKey: myPriv, publicKey: theirPub });
  // Sort IDs so both sides get the same `info` regardless of direction.
  const [lo, hi] = instanceIdA < instanceIdB
    ? [instanceIdA, instanceIdB]
    : [instanceIdB, instanceIdA];
  const info = Buffer.from(`${context}|${lo}|${hi}`, 'utf-8');
  const key = hkdfSync('sha256', shared, HKDF_SALT, info, 32);
  return Buffer.from(key);
}

// ─── AEAD encrypt / decrypt ──────────────────────────────────────────

export interface EncryptedMessage {
  ciphertext: string;  // base64url(iv|tag|ciphertext) — actually we transmit them separately
  nonce: string;       // 12 bytes hex
}

export function encrypt(sessionKey: Buffer, plaintext: string): { ciphertext: string; nonce: string } {
  const nonce = randomBytes(12); // ChaCha20-Poly1305 standard nonce
  const cipher = createCipheriv('chacha20-poly1305', sessionKey, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf-8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Bundle tag + ciphertext so the recipient has both. Base64 keeps the wire
  // small and the hub never touches this anyway.
  const bundled = Buffer.concat([tag, ct]).toString('base64');
  return { ciphertext: bundled, nonce: nonce.toString('hex') };
}

export function decrypt(sessionKey: Buffer, ciphertextB64: string, nonceHex: string): string | null {
  try {
    const nonce = Buffer.from(nonceHex, 'hex');
    if (nonce.length !== 12 && nonce.length !== 24) return null;
    const bundled = Buffer.from(ciphertextB64, 'base64');
    if (bundled.length < 17) return null;
    const tag = bundled.subarray(0, 16);
    const ct = bundled.subarray(16);
    const decipher = createDecipheriv('chacha20-poly1305', sessionKey, nonce, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf-8');
  } catch {
    // Auth tag mismatch, wrong key, tampered ciphertext — all end here.
    return null;
  }
}
