import { describe, it, expect } from 'vitest';
import { generateX25519Keypair, deriveSessionKey, encrypt, decrypt } from '../src/hub/crypto.js';

describe('hub crypto — X25519 + ChaCha20-Poly1305 round trip', () => {
  it('generates fresh 32-byte hex keypairs', () => {
    const kp = generateX25519Keypair();
    expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('both sides derive the same session key regardless of ID order', () => {
    const alice = generateX25519Keypair();
    const bob = generateX25519Keypair();
    const idA = 'a'.repeat(32);
    const idB = 'b'.repeat(32);

    const keyA = deriveSessionKey(alice.privateKeyHex, bob.publicKeyHex, 'gossip', idA, idB);
    const keyB = deriveSessionKey(bob.privateKeyHex, alice.publicKeyHex, 'gossip', idB, idA);

    expect(keyA.equals(keyB)).toBe(true);
    expect(keyA.length).toBe(32);
  });

  it('gossip and soul domains produce different keys', () => {
    const alice = generateX25519Keypair();
    const bob = generateX25519Keypair();
    const idA = 'a'.repeat(32);
    const idB = 'b'.repeat(32);

    const gossipKey = deriveSessionKey(alice.privateKeyHex, bob.publicKeyHex, 'gossip', idA, idB);
    const soulKey = deriveSessionKey(alice.privateKeyHex, bob.publicKeyHex, 'soul', idA, idB);

    expect(gossipKey.equals(soulKey)).toBe(false);
  });

  it('encrypt → decrypt returns the original plaintext', () => {
    const alice = generateX25519Keypair();
    const bob = generateX25519Keypair();
    const key = deriveSessionKey(alice.privateKeyHex, bob.publicKeyHex, 'gossip', 'a'.repeat(32), 'b'.repeat(32));

    const plaintext = JSON.stringify({ type: 'gossip', text: 'hello bob', createdAt: '2026-04-22T00:00:00Z' });
    const { ciphertext, nonce } = encrypt(key, plaintext);

    expect(ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(nonce).toMatch(/^[0-9a-f]{24}$/);

    const recovered = decrypt(key, ciphertext, nonce);
    expect(recovered).toBe(plaintext);
  });

  it('wrong key returns null (auth tag fails)', () => {
    const alice = generateX25519Keypair();
    const bob = generateX25519Keypair();
    const eve = generateX25519Keypair();
    const correctKey = deriveSessionKey(alice.privateKeyHex, bob.publicKeyHex, 'gossip', 'a'.repeat(32), 'b'.repeat(32));
    const wrongKey = deriveSessionKey(alice.privateKeyHex, eve.publicKeyHex, 'gossip', 'a'.repeat(32), 'e'.repeat(32));

    const { ciphertext, nonce } = encrypt(correctKey, 'secret message');
    expect(decrypt(wrongKey, ciphertext, nonce)).toBeNull();
  });

  it('tampered ciphertext returns null', () => {
    const alice = generateX25519Keypair();
    const bob = generateX25519Keypair();
    const key = deriveSessionKey(alice.privateKeyHex, bob.publicKeyHex, 'gossip', 'a'.repeat(32), 'b'.repeat(32));

    const { ciphertext, nonce } = encrypt(key, 'secret');
    // Flip one byte in the tag (first 16 bytes of the bundled blob).
    const buf = Buffer.from(ciphertext, 'base64');
    buf[0] = buf[0]! ^ 0xff;
    const tampered = buf.toString('base64');

    expect(decrypt(key, tampered, nonce)).toBeNull();
  });

  it('reordered instance IDs derive the same key (ordering is commutative)', () => {
    const alice = generateX25519Keypair();
    const bob = generateX25519Keypair();
    const idA = 'f'.repeat(32);
    const idB = '0'.repeat(32); // deliberately lexicographically smaller than idA

    const key1 = deriveSessionKey(alice.privateKeyHex, bob.publicKeyHex, 'gossip', idA, idB);
    const key2 = deriveSessionKey(bob.privateKeyHex, alice.publicKeyHex, 'gossip', idB, idA);
    expect(key1.equals(key2)).toBe(true);
  });
});
