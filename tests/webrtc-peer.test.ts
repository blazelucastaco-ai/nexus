import { describe, it, expect, afterAll } from 'vitest';
import nodeDataChannel from 'node-datachannel';
import { WebRtcPeer, type SignalMsg } from '../src/webrtc/peer.js';
import { generateEd25519, signSdpEnvelope, verifySdpEnvelope } from '../src/webrtc/identity.js';

// Two authenticated peers connect via an in-process "rendezvous" (a function relaying the
// signed SDP/ICE). This exercises REAL libdatachannel DTLS-SRTP + ICE on localhost — the
// load-bearing proof that the fingerprint binding holds against actual DTLS, not a mock.

afterAll(() => {
  try { nodeDataChannel.cleanup(); } catch { /* ignore */ }
});

type Relay = (msg: SignalMsg) => SignalMsg | null;
const passthrough: Relay = (m) => m;

/** Wire two peers (mac initiator, phone answerer) through a relay that may tamper. */
function makePair(relayToPhone: Relay, relayToMac: Relay) {
  const mac = generateEd25519();
  const phone = generateEd25519();
  const pairingId = 'live-1';
  const logs: string[] = [];
  const events = { macConnected: false, phoneConnected: false, macClosed: '', phoneClosed: '', received: '' };

  // Each peer's onSignal references the other (assigned just below); the closures only
  // run during start(), by which point both are initialized — so `const` is safe.
  const macPeer: WebRtcPeer = new WebRtcPeer({
    role: 'mac',
    initiator: true,
    pairingId,
    sign: (sdp, from) => signSdpEnvelope(mac.privateKey, { sdp, from, pairingId }),
    verifyPeer: (env) => verifySdpEnvelope(env, { ed25519Raw: phone.publicRaw }, { expectPairingId: pairingId }),
    onSignal: (msg) => { const m = relayToPhone(msg); if (m) phonePeer.handleSignal(m); },
    onConnected: () => { events.macConnected = true; },
    onClosed: (r) => { events.macClosed = r ?? ''; },
    onFrame: (t) => { events.received = t; },
    log: (m) => logs.push(`mac: ${m}`),
  });
  const phonePeer: WebRtcPeer = new WebRtcPeer({
    role: 'phone',
    initiator: false,
    pairingId,
    sign: (sdp, from) => signSdpEnvelope(phone.privateKey, { sdp, from, pairingId }),
    verifyPeer: (env) => verifySdpEnvelope(env, { ed25519Raw: mac.publicRaw }, { expectPairingId: pairingId }),
    onSignal: (msg) => { const m = relayToMac(msg); if (m) macPeer.handleSignal(m); },
    onConnected: () => { events.phoneConnected = true; },
    onClosed: (r) => { events.phoneClosed = r ?? ''; },
    onFrame: (t) => { events.received = t; }, // the mac→phone frame lands here
    log: (m) => logs.push(`phone: ${m}`),
  });
  return { macPeer, phonePeer, events, logs };
}

describe('WebRtcPeer — live authenticated channel', () => {
  it('two paired peers connect over real DTLS and exchange a frame', { timeout: 20000 }, async () => {
    const { macPeer, phonePeer, events, logs } = makePair(passthrough, passthrough);
    try {
      macPeer.start();
      phonePeer.start();
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout\n${logs.join('\n')}`)), 18000);
        const poll = setInterval(() => {
          if (events.macConnected && events.phoneConnected && !events.received) {
            macPeer.send(JSON.stringify({ t: 'assistant', text: 'hi from the Mac' }));
          }
          if (events.received) { clearInterval(poll); clearTimeout(t); resolve(); }
        }, 50);
      });
      expect(events.macConnected).toBe(true);
      expect(events.phoneConnected).toBe(true);
      expect(JSON.parse(events.received).text).toBe('hi from the Mac');
    } finally {
      macPeer.close();
      phonePeer.close();
    }
  });

  it('rejects a rendezvous that tampers the SDP (fail-closed, no channel)', { timeout: 20000 }, async () => {
    // Malicious relay flips a byte in the Mac→phone SDP — the signature no longer covers it.
    const tamper: Relay = (m) => (m.kind === 'sdp' ? { ...m, env: { ...m.env, sdp: m.env.sdp.replace('a=', 'b=') } } : m);
    const { macPeer, phonePeer, events, logs } = makePair(tamper, passthrough);
    try {
      macPeer.start();
      phonePeer.start();
      // wait for the phone to reject + close, and confirm it never connected
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000);
        const poll = setInterval(() => {
          if (events.phoneClosed) { clearInterval(poll); clearTimeout(t); resolve(); }
        }, 50);
      });
      expect(events.phoneConnected).toBe(false);
      expect(events.phoneClosed).toMatch(/verification|MITM/i);
      expect(logs.join('\n')).toContain('failed identity verification');
    } finally {
      macPeer.close();
      phonePeer.close();
    }
  });
});
