import { describe, it, expect, afterAll } from 'vitest';
import nodeDataChannel from 'node-datachannel';
import { generateKeyPairSync, sign as nodeSign, randomBytes } from 'node:crypto';
import { WebRtcPeer } from '../src/webrtc/peer.js';
import { SignalingClient } from '../src/webrtc/signaling-client.js';
import { pairingTag, pairingTranscript, sdpTranscript, verifyPairingTag, verifySdpEnvelope } from '../src/webrtc/identity.js';

// END-TO-END against the LIVE daemon: a simulated phone (node-datachannel) pairs over the
// real rendezvous, opens the authenticated WebRTC data channel to the running NEXUS, says
// "hello", and waits for a spoken (audio) reply. Logs every step so a stall is visible.
// Run explicitly:  npx vitest run tests/phone-e2e-live.test.ts
// Requires the daemon running on :4242 with the phone link up.

const CONTROL = 'http://127.0.0.1:4242/control';
const log = (...a: unknown[]) => console.log('[e2e]', ...a);
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fakePhone() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
  return { x963, sign: (d: Buffer) => nodeSign('sha256', d, { key: privateKey, dsaEncoding: 'ieee-p1363' }) };
}

afterAll(() => { try { nodeDataChannel.cleanup(); } catch { /* ignore */ } });

describe('phone E2E (live daemon)', () => {
  it('pairs + connects + says hello + gets a spoken reply', { timeout: 70000 }, async (ctx) => {
    // Live integration probe — skip in CI / when the daemon isn't running on :4242.
    try {
      await fetch('http://127.0.0.1:4242/', { signal: AbortSignal.timeout(2000) });
    } catch {
      return ctx.skip();
    }
    const r = await fetch(CONTROL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'start-pairing' }) });
    const body = (await r.json()) as { ok: boolean; payload?: { macPub: string; secret: string; rendezvous: string; pairingId: string } };
    expect(body.ok).toBe(true);
    const payload = body.payload!;
    const { macPub, secret, rendezvous, pairingId } = payload;
    log('payload OK — pairingId', pairingId.slice(0, 8), 'rendezvous', rendezvous);

    const phone = fakePhone();
    const state = { paired: false, connected: false, audioReply: false, assistant: null as string | null };
    let peer: WebRtcPeer | null = null;

    const startPeer = () => {
      log('→ starting WebRTC peer (phone is initiator)');
      peer = new WebRtcPeer({
        role: 'phone',
        initiator: true,
        pairingId,
        iceServers: [],
        sign: (sdp, from) => {
          const ts = Date.now();
          return { sdp, from, ts, pairingId, sig: phone.sign(sdpTranscript(pairingId, from, ts, sdp)).toString('base64url') };
        },
        verifyPeer: (env) => verifySdpEnvelope(env, { ed25519Raw: macPub }, { expectPairingId: pairingId }),
        onSignal: (m) => sig.send(m),
        onFrame: (text) => {
          let f: { t?: string; text?: string };
          try { f = JSON.parse(text); } catch { return; }
          log('  frame from NEXUS:', f.t, f.text ? `"${String(f.text).slice(0, 50)}"` : '');
          if (f.t === 'audio') state.audioReply = true;
          if (f.t === 'assistant') state.assistant = f.text ?? '';
        },
        onConnected: () => {
          state.connected = true;
          log('✓ CONNECTED — data channel open; sending "hello"');
          peer?.send(JSON.stringify({ t: 'user_message', text: 'hello' }));
        },
        onClosed: (reason) => log('✗ peer closed:', reason),
        log: (l) => log('  peer:', l),
      });
      peer.start();
    };

    const sig = new SignalingClient(rendezvous, 'phone', {
      onOpen: () => {
        const nonce = randomBytes(8).toString('hex');
        const tag = pairingTag(secret, 'pair-m1', pairingId, phone.x963, nonce).toString('base64url');
        const psig = phone.sign(pairingTranscript(pairingId, macPub, phone.x963, nonce)).toString('base64url');
        log('→ signaling open; sending M1');
        sig.send({ t: 'pair-m1', p256X963: phone.x963, nonce, tag, sig: psig });
      },
      onPeerPresent: (p) => log('  rendezvous: peer present =', p),
      onMessage: (msg) => {
        const m = msg as Record<string, unknown>;
        if (m.t === 'pair-m2') {
          state.paired = verifyPairingTag(secret, Buffer.from(String(m.confirmTag), 'base64url'), 'pair-m2', pairingId, macPub);
          log(state.paired ? '✓ paired (M2 confirmed)' : '✗ M2 confirmTag INVALID');
          if (state.paired) startPeer();
        } else if (m.kind === 'sdp' || m.kind === 'ice') {
          peer?.handleSignal(msg as never);
        } else if (m.t === 'pair-fail') {
          log('✗ pairing rejected:', m.reason);
        }
      },
    });

    sig.join(pairingId);

    const end = Date.now() + 60000;
    while (Date.now() < end && !state.audioReply) await delay(200);

    log('═══ RESULT — paired:', state.paired, '| connected:', state.connected, '| spoken reply:', state.audioReply, '| text:', state.assistant);
    sig.stop();
    peer?.close();

    expect(state.paired, 'pairing handshake').toBe(true);
    expect(state.connected, 'WebRTC data channel').toBe(true);
    expect(state.audioReply, 'NEXUS spoke a reply').toBe(true);
  });
});
