import { describe, it, expect, afterAll } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityStore } from '../src/webrtc/identity-store.js';
import { pairingTag, pairingTranscript, sdpTranscript } from '../src/webrtc/identity.js';

// Simulated iPhone: a P-256 Enclave-style key (x963 public form + raw r‖s signatures).
function fakePhone() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64');
  return { x963, sign: (d: Buffer) => nodeSign('sha256', d, { key: privateKey, dsaEncoding: 'ieee-p1363' }) };
}

const dirs: string[] = [];
function freshStore() {
  const d = mkdtempSync(join(tmpdir(), 'nexus-id-'));
  dirs.push(d);
  const s = new IdentityStore(d);
  s.load();
  return { s, d };
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const SDP = 'v=0\r\na=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89\r\n';

/** Build a valid phone M1 for the store's current pending QR. */
function m1For(qr: { secret: string; pairingId: string; macPub: string }, ph: ReturnType<typeof fakePhone>, nonce = randomBytes(8).toString('hex')) {
  const tag = pairingTag(qr.secret, 'pair-m1', qr.pairingId, ph.x963, nonce).toString('base64url');
  const sig = ph.sign(pairingTranscript(qr.pairingId, qr.macPub, ph.x963, nonce)).toString('base64url');
  return { p256X963: ph.x963, nonce, tag, sig };
}

describe('IdentityStore', () => {
  it('persists the Mac key + paired peers across reloads', () => {
    const { s, d } = freshStore();
    const pub = s.macPublicRaw;
    const qr = s.beginPairing('wss://rv');
    const res = s.completePairing(m1For(qr, fakePhone()));
    expect(res.ok).toBe(true);
    expect(s.hasPeers()).toBe(true);

    const reloaded = new IdentityStore(d);
    reloaded.load();
    expect(reloaded.macPublicRaw).toBe(pub); // same persisted key
    expect(reloaded.pairedPeers[0]?.pairingId).toBe(qr.pairingId);
  });

  it('rejects a pairing whose HMAC tag lacks the QR secret', () => {
    const { s } = freshStore();
    const qr = s.beginPairing('wss://rv');
    const ph = fakePhone();
    const nonce = 'abcd';
    const forgedTag = pairingTag('not-the-secret', 'pair-m1', qr.pairingId, ph.x963, nonce).toString('base64url');
    const sig = ph.sign(pairingTranscript(qr.pairingId, qr.macPub, ph.x963, nonce)).toString('base64url');
    expect(s.completePairing({ p256X963: ph.x963, nonce, tag: forgedTag, sig }).ok).toBe(false);
    expect(s.hasPeers()).toBe(false);
  });

  it('verifies post-pairing connection envelopes + rejects replay, then revokes', () => {
    const { s } = freshStore();
    const qr = s.beginPairing('wss://rv');
    const ph = fakePhone();
    expect(s.completePairing(m1For(qr, ph)).ok).toBe(true);

    const verify = s.makeVerifier(qr.pairingId);
    const ts = Date.now();
    const env = { sdp: SDP, from: 'phone' as const, ts, pairingId: qr.pairingId, sig: ph.sign(sdpTranscript(qr.pairingId, 'phone', ts, SDP)).toString('base64url') };
    expect(verify(env)).toBe(true); // first time: accepted + lastTs recorded
    expect(verify(env)).toBe(false); // replay: ts <= lastTs → rejected

    expect(s.removePeer(qr.pairingId)).toBe(true);
    const ts2 = ts + 1000;
    const env2 = { ...env, ts: ts2, sig: ph.sign(sdpTranscript(qr.pairingId, 'phone', ts2, SDP)).toString('base64url') };
    expect(verify(env2)).toBe(false); // revoked → no peer → refused
  });
});
