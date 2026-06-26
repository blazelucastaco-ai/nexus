import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  buildQrPayload,
  ed25519PublicFromRaw,
  ed25519PublicRaw,
  ed25519Sign,
  ed25519Verify,
  extractFingerprint,
  fingerprintMatches,
  generateEd25519,
  ed25519PrivatePem,
  ed25519PrivateFromPem,
  p256PublicFromX963,
  p256Verify,
  pairingTag,
  sdpTranscript,
  signSdpEnvelope,
  verifyPairingTag,
  verifySdpEnvelope,
} from '../src/webrtc/identity.js';

const SDP = [
  'v=0',
  'o=- 1 1 IN IP4 127.0.0.1',
  's=-',
  'a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89',
  'a=setup:actpass',
].join('\r\n');

// Simulate the iPhone: a P-256 key whose public form is X9.63 (CryptoKit x963Representation)
// and whose signatures are raw r‖s (CryptoKit rawRepresentation == OpenSSL ieee-p1363).
function fakePhoneP256() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64');
  const sign = (data: Buffer) => nodeSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return { x963, sign };
}

describe('Ed25519 (Mac identity)', () => {
  it('round-trips raw public key + signs/verifies', () => {
    const id = generateEd25519();
    const data = Buffer.from('hello');
    const sig = ed25519Sign(id.privateKey, data);
    expect(ed25519Verify(id.publicKey, data, sig)).toBe(true);
    // raw export → import → verify still works
    const imported = ed25519PublicFromRaw(id.publicRaw);
    expect(ed25519Verify(imported, data, sig)).toBe(true);
    expect(ed25519PublicRaw(imported)).toBe(id.publicRaw);
    // tampered data fails
    expect(ed25519Verify(id.publicKey, Buffer.from('hellp'), sig)).toBe(false);
  });
  it('persists + restores the private key (PKCS8 PEM)', () => {
    const id = generateEd25519();
    const restored = ed25519PrivateFromPem(ed25519PrivatePem(id.privateKey));
    expect(restored.publicRaw).toBe(id.publicRaw);
    const data = Buffer.from('x');
    expect(ed25519Verify(id.publicKey, data, ed25519Sign(restored.privateKey, data))).toBe(true);
  });
});

describe('P-256 (phone / Secure Enclave) verification', () => {
  it('verifies a CryptoKit-style raw-r‖s signature from an X9.63 public key', () => {
    const phone = fakePhoneP256();
    const data = Buffer.from('payload');
    const sig = phone.sign(data);
    expect(p256Verify(p256PublicFromX963(phone.x963), data, sig)).toBe(true);
    expect(p256Verify(p256PublicFromX963(phone.x963), Buffer.from('payload2'), sig)).toBe(false);
  });
});

describe('SDP envelope auth (the connection-MITM defense)', () => {
  const id = generateEd25519();
  const pairingId = 'pair-123';

  it('verifies a well-formed envelope, rejects tampering', () => {
    const env = signSdpEnvelope(id.privateKey, { sdp: SDP, from: 'mac', pairingId });
    expect(verifySdpEnvelope(env, { ed25519Raw: id.publicRaw }, { expectPairingId: pairingId })).toBe(true);

    // tampered SDP (e.g. a relay swapped the fingerprint) → signature no longer covers it
    const swapped = { ...env, sdp: SDP.replace('AB:CD', 'FF:FF') };
    expect(verifySdpEnvelope(swapped, { ed25519Raw: id.publicRaw }, { expectPairingId: pairingId })).toBe(false);

    // wrong signer key → reject
    const other = generateEd25519();
    expect(verifySdpEnvelope(env, { ed25519Raw: other.publicRaw }, { expectPairingId: pairingId })).toBe(false);

    // wrong pairing → reject
    expect(verifySdpEnvelope(env, { ed25519Raw: id.publicRaw }, { expectPairingId: 'other' })).toBe(false);
  });

  it('rejects stale + replayed timestamps', () => {
    const stale = signSdpEnvelope(id.privateKey, { sdp: SDP, from: 'mac', pairingId, ts: Date.now() - 500_000 });
    expect(verifySdpEnvelope(stale, { ed25519Raw: id.publicRaw }, { expectPairingId: pairingId })).toBe(false);

    const env = signSdpEnvelope(id.privateKey, { sdp: SDP, from: 'mac', pairingId });
    // replay: a ts <= the last accepted ts is rejected (monotonic)
    expect(
      verifySdpEnvelope(env, { ed25519Raw: id.publicRaw }, { expectPairingId: pairingId, lastTs: env.ts }),
    ).toBe(false);
    // a strictly newer ts is accepted
    expect(
      verifySdpEnvelope(env, { ed25519Raw: id.publicRaw }, { expectPairingId: pairingId, lastTs: env.ts - 1 }),
    ).toBe(true);
  });

  it('verifies a phone (P-256) envelope over the SAME transcript (mixed-curve)', () => {
    const phone = fakePhoneP256();
    const ts = Date.now();
    const sig = phone.sign(sdpTranscript(pairingId, 'phone', ts, SDP)).toString('base64url');
    const env = { sdp: SDP, from: 'phone' as const, ts, pairingId, sig };
    expect(verifySdpEnvelope(env, { p256X963: phone.x963 }, { expectPairingId: pairingId })).toBe(true);
    // tampered → fail
    expect(verifySdpEnvelope({ ...env, sdp: SDP + 'x' }, { p256X963: phone.x963 }, { expectPairingId: pairingId })).toBe(false);
  });
});

describe('DTLS fingerprint binding', () => {
  const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
  it('extracts + matches the negotiated fingerprint, rejects a swap', () => {
    expect(extractFingerprint(SDP)).toBe(FP);
    expect(fingerprintMatches(SDP, FP)).toBe(true);
    expect(fingerprintMatches(SDP, FP.toLowerCase())).toBe(true); // case-insensitive
    expect(fingerprintMatches(SDP, FP.replace('AB:CD', 'FF:FF'))).toBe(false); // relay's cert ≠ signed
    expect(fingerprintMatches(SDP, null)).toBe(false);
  });
});

describe('pairing tags (HMAC keyed by the QR secret)', () => {
  it('a relay without the secret cannot forge a tag', () => {
    const qr = buildQrPayload(generateEd25519().publicRaw, 'wss://rv.example');
    const tag = pairingTag(qr.secret, 'M1', 'phonePub', 'nonce');
    expect(verifyPairingTag(qr.secret, tag, 'M1', 'phonePub', 'nonce')).toBe(true);
    // wrong secret (a relay guessing) → reject
    expect(verifyPairingTag(buildQrPayload('x', 'y').secret, tag, 'M1', 'phonePub', 'nonce')).toBe(false);
    // tampered field → reject
    expect(verifyPairingTag(qr.secret, tag, 'M1', 'phonePub2', 'nonce')).toBe(false);
  });
});
