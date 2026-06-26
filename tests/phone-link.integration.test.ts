import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import nodeDataChannel from 'node-datachannel';
import { generateKeyPairSync, sign as nodeSign, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneLink } from '../src/webrtc/phone-link.js';
import { SignalingClient } from '../src/webrtc/signaling-client.js';
import { WebRtcPeer } from '../src/webrtc/peer.js';
import { pairingTag, pairingTranscript, sdpTranscript, verifySdpEnvelope } from '../src/webrtc/identity.js';

// THE Mac-side proof: a simulated phone pairs over a local rendezvous, opens an
// authenticated WebRTC connection, sends a user_message, and gets the brain's reply back
// over the data channel — i.e. the whole phone path minus the iOS shell, on one machine.

const PORT = 8096;
const URL = `ws://localhost:${PORT}`;
const dirs: string[] = [];
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => unknown, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await delay(50);
  }
  return false;
}

beforeAll(async () => {
  process.env.PORT = String(PORT);
  await import('../signaling-server/src/server.js');
  await delay(400);
});
afterAll(() => {
  try { nodeDataChannel.cleanup(); } catch { /* ignore */ }
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function fakePhoneKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64');
  return { x963, sign: (d: Buffer) => nodeSign('sha256', d, { key: privateKey, dsaEncoding: 'ieee-p1363' }) };
}

describe('PhoneLink — full Mac-side path', () => {
  it('pairs, connects (authenticated), and round-trips a message through the brain', { timeout: 30000 }, async () => {
    const identityDir = mkdtempSync(join(tmpdir(), 'nexus-pl-'));
    dirs.push(identityDir);

    // Stub brain: echoes via the streaming token callback (exercises the gateway path).
    const seen: string[] = [];
    const brain = {
      handleMessage: async (_c: string, text: string, onToken?: (s: string) => void) => {
        seen.push(text);
        onToken?.(`pong: ${text}`);
        return `pong: ${text}`;
      },
    };

    const link = new PhoneLink(brain, undefined, { signalUrl: URL, iceServers: [], chatId: 'web', identityDir });
    link.start();
    const qr = link.beginPairing();

    // ── simulated phone ───────────────────────────────────────────────────────────
    const phoneKey = fakePhoneKey();
    let phonePeer: WebRtcPeer | null = null;
    let assistant: string | null = null;
    let paired = false;

    const sig = new SignalingClient(URL, 'phone', {
      onMessage: (raw) => {
        const m = raw as Record<string, unknown>;
        if (m.t === 'pair-m2') {
          paired = true;
          // Phone initiates the WebRTC connection; signs SDP with its P-256 Enclave key.
          phonePeer = new WebRtcPeer({
            role: 'phone',
            initiator: true,
            pairingId: qr.pairingId,
            iceServers: [],
            sign: (sdp, from) => {
              const ts = Date.now();
              return { sdp, from, ts, pairingId: qr.pairingId, sig: phoneKey.sign(sdpTranscript(qr.pairingId, from, ts, sdp)).toString('base64url') };
            },
            verifyPeer: (env) => verifySdpEnvelope(env, { ed25519Raw: qr.macPub }, { expectPairingId: qr.pairingId }),
            onSignal: (s) => sig.send(s),
            onFrame: (text) => {
              const f = JSON.parse(text) as { t: string; text?: string };
              if (f.t === 'assistant' && f.text) assistant = f.text;
            },
          });
          phonePeer.start();
        } else if (m.kind === 'sdp' || m.kind === 'ice') {
          phonePeer?.handleSignal(raw as never);
        }
      },
    });
    sig.join(qr.pairingId);
    await delay(300);

    // M1: prove we hold the QR secret (HMAC) + bind the Enclave key (P-256 sig).
    const nonce = randomBytes(8).toString('hex');
    const tag = pairingTag(qr.secret, 'pair-m1', qr.pairingId, phoneKey.x963, nonce).toString('base64url');
    const m1sig = phoneKey.sign(pairingTranscript(qr.pairingId, qr.macPub, phoneKey.x963, nonce)).toString('base64url');
    sig.send({ t: 'pair-m1', p256X963: phoneKey.x963, nonce, tag, sig: m1sig });

    expect(await waitFor(() => paired, 5000)).toBe(true);
    expect(link.isPaired).toBe(true);

    // Connect, then talk to the brain.
    expect(await waitFor(() => phonePeer?.isReady, 20000)).toBe(true);
    phonePeer!.send(JSON.stringify({ t: 'user_message', text: 'hello nexus' }));
    expect(await waitFor(() => assistant, 8000)).toBe(true);
    expect(assistant).toBe('pong: hello nexus');
    expect(seen).toContain('hello nexus');

    link.stop();
    sig.stop();
    phonePeer?.close();
  });
});
