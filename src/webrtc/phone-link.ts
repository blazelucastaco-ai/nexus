// PhoneLink — the Mac-side subsystem that makes the phone "a window into NEXUS." It ties
// together: the IdentityStore (trust root), the SignalingClient (reachability via the
// self-hosted rendezvous), an authenticated WebRtcPeer per connection, the orb-only
// WebRtcTransport, and a second WebGateway feeding the SAME brain (shared memory).
//
// Two modes over one rendezvous room (= pairingId):
//   - pairing:   show a QR, wait for the phone's M1, complete the handshake, send M2.
//   - listening: a paired phone may connect anytime; the Mac ANSWERS its WebRTC offer
//                (the phone initiates — it's the side "opening the window").
// All startup is best-effort: a failure here must never take down Telegram or the web UI.

import type { WebBrain } from '../web/gateway.js';
import { WebGateway } from '../web/gateway.js';
import type { TtsService } from '../web/tts.js';
import { createLogger } from '../utils/logger.js';
import { IdentityStore, type PairingM1 } from './identity-store.js';
import { WebRtcPeer } from './peer.js';
import { WebRtcTransport } from './transport.js';
import { SignalingClient } from './signaling-client.js';
import type { QrPayload } from './identity.js';
import type { ApnsSender } from '../push/apns.js';

const log = createLogger('phone-link');

export interface PhoneLinkOptions {
  signalUrl: string;
  /** ICE servers (STUN/TURN). Empty = LAN-only (direct host candidates) until coturn. */
  iceServers?: string[];
  /** Shared with the desktop web gateway → shared conversation memory/continuity. */
  chatId: string;
  /** Override the identity dir (defaults to ~/.nexus/identity). For tests. */
  identityDir?: string;
  /** APNs sender — enables NEXUS-initiated calls (ringing the phone). */
  apns?: ApnsSender;
}

export class PhoneLink {
  private readonly store: IdentityStore;
  private readonly transport = new WebRtcTransport();
  private readonly gateway: WebGateway;
  private signaling: SignalingClient | null = null;
  private peer: WebRtcPeer | null = null;
  private mode: 'idle' | 'pairing' | 'listening' = 'idle';
  private activePairingId: string | null = null;

  constructor(brain: WebBrain, tts: TtsService | undefined, private readonly opts: PhoneLinkOptions) {
    this.store = new IdentityStore(opts.identityDir);
    // 'phone' tells the brain it's the orb-only companion — no screen for visuals.
    this.gateway = new WebGateway(brain, this.transport, opts.chatId, tts, 'phone');
  }

  /** Load identity + start the gateway; if a phone is already paired, listen for it. */
  start(): void {
    this.store.load();
    this.gateway.start();
    const paired = this.store.pairedPeers[0];
    if (paired) {
      log.info({ pairingId: paired.pairingId }, 'paired phone found — listening');
      this.listen(paired.pairingId);
    } else {
      log.info('no paired phone yet — call beginPairing() to show a QR');
    }
  }

  get isPaired(): boolean {
    return this.store.hasPeers();
  }

  /** Start pairing: returns the QR payload the Mac shows at the end of setup. The phone
   *  scans it and the handshake completes over the rendezvous. */
  beginPairing(): QrPayload {
    const qr = this.store.beginPairing(this.opts.signalUrl);
    this.activePairingId = qr.pairingId;
    this.mode = 'pairing';
    this.connectSignaling(qr.pairingId);
    return qr;
  }

  stop(): void {
    this.teardownPeer();
    this.signaling?.stop();
    this.signaling = null;
    this.gateway.stop();
  }

  // ── internals ────────────────────────────────────────────────────────────────────

  private listen(pairingId: string): void {
    this.activePairingId = pairingId;
    this.mode = 'listening';
    this.connectSignaling(pairingId);
  }

  private connectSignaling(room: string): void {
    this.signaling?.stop();
    this.signaling = new SignalingClient(this.opts.signalUrl, 'mac', {
      onPeerPresent: (present) => {
        if (!present) this.teardownPeer(); // phone left → drop the connection, await its return
      },
      onMessage: (msg) => this.onSignal(msg),
    });
    this.signaling.join(room);
  }

  private onSignal(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;

    // Pairing handshake (M1 from the phone).
    if (this.mode === 'pairing' && m.t === 'pair-m1') {
      const m1: PairingM1 = {
        p256X963: String(m.p256X963 ?? ''),
        nonce: String(m.nonce ?? ''),
        tag: String(m.tag ?? ''),
        sig: String(m.sig ?? ''),
      };
      const res = this.store.completePairing(m1);
      if (res.ok) {
        this.signaling?.send({ t: 'pair-m2', confirmTag: res.confirmTag });
        this.mode = 'listening'; // same room now carries the WebRTC connection
        log.info('pairing complete — now listening for the phone');
      } else {
        this.signaling?.send({ t: 'pair-fail', reason: res.reason });
        log.warn({ reason: res.reason }, 'pairing rejected');
      }
      return;
    }

    // Connection signaling (the phone's offer / ICE) — the Mac answers.
    if (m.kind === 'sdp' || m.kind === 'ice') {
      this.ensurePeer();
      this.peer?.handleSignal(msg as never);
    }
  }

  private ensurePeer(): void {
    if (this.peer || !this.activePairingId) return;
    const pid = this.activePairingId;
    this.peer = new WebRtcPeer({
      role: 'mac',
      initiator: false, // the phone opens the link; the Mac answers
      pairingId: pid,
      iceServers: this.opts.iceServers ?? [],
      sign: (sdp, from) => this.store.sign(sdp, from, pid),
      verifyPeer: this.store.makeVerifier(pid),
      onSignal: (m) => this.signaling?.send(m),
      onFrame: (text) => this.onPhoneFrame(text),
      onConnected: () => log.info('phone connected (authenticated)'),
      onClosed: (reason) => {
        log.info({ reason }, 'phone connection closed');
        this.teardownPeer();
      },
      log: (l) => log.debug(l),
    });
    this.transport.attach(this.peer);
    this.peer.start();
  }

  private teardownPeer(): void {
    if (!this.peer) return;
    try {
      this.peer.close();
    } catch {
      /* ignore */
    }
    this.peer = null;
  }

  /** Inbound app frame from the phone. Intercepts control frames (the VoIP token), else
   *  passes it to the gateway (orb/voice). */
  private onPhoneFrame(text: string): void {
    try {
      const f = JSON.parse(text) as { t?: string; token?: string };
      if (f.t === 'voip-token' && typeof f.token === 'string' && this.activePairingId) {
        this.store.setVoipToken(this.activePairingId, f.token);
        return;
      }
    } catch {
      /* not control JSON — fall through to the gateway */
    }
    this.transport.feed(text);
  }

  /** Ring the phone (NEXUS-initiated call) via a contentless APNs VoIP push. Best-effort;
   *  needs APNs configured + a stored VoIP token. */
  async callUser(): Promise<boolean> {
    const pid = this.store.pairedPeers[0]?.pairingId;
    const token = pid ? this.store.getVoipToken(pid) : undefined;
    if (!this.opts.apns || !token) {
      log.warn('callUser: APNs not configured or no VoIP token yet');
      return false;
    }
    return this.opts.apns.ring(token);
  }
}
