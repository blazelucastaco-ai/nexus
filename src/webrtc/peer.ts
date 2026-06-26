// WebRtcPeer — one authenticated, end-to-end-encrypted WebRTC connection to a paired
// device, over node-datachannel (libdatachannel: DTLS-SRTP + SCTP data channel + ICE).
//
// This is where the E2E guarantee becomes real. The (self-hosted, data-blind) rendezvous
// relays our SDP/ICE; it must not be able to MITM. So:
//   1. We SIGN our local SDP (incl. its DTLS fingerprint) with our long-term identity key.
//   2. We REFUSE any remote SDP whose signature doesn't verify against the stored peer key
//      (verifyPeer). No unauthenticated path, no downgrade — fail closed.
//   3. After DTLS connects we ASSERT the negotiated remote fingerprint == the one in the
//      signed SDP. libdatachannel already enforces cert==SDP-fingerprint during DTLS; this
//      explicit check is belt-and-suspenders and the audit's required gate.
// App frames only ever flow after all three hold.

import { PeerConnection, type DescriptionType } from 'node-datachannel';
import { extractFingerprint, fingerprintMatches, type Role, type SignedSdp } from './identity.js';

export type SignalMsg =
  | { kind: 'sdp'; env: SignedSdp }
  | { kind: 'ice'; candidate: string; mid: string };

export interface PeerOptions {
  role: Role;
  /** Who creates the offer (the Mac, when it initiates; the phone, when it dials). */
  initiator: boolean;
  iceServers?: string[];
  pairingId: string;
  /** Sign our local SDP with our long-term key. */
  sign: (sdp: string, from: Role) => SignedSdp;
  /** Verify a remote SDP envelope against the STORED peer key (+ pairing/monotonic ts). */
  verifyPeer: (env: SignedSdp) => boolean;
  /** Deliver a signaling message to the peer (via the rendezvous). */
  onSignal: (msg: SignalMsg) => void;
  onFrame?: (text: string) => void; // app frames (JSON), post-verification only
  onConnected?: () => void;
  onClosed?: (reason?: string) => void;
  log?: (m: string) => void;
}

const DC_LABEL = 'nexus';

export class WebRtcPeer {
  private pc: PeerConnection | null = null;
  private dc: ReturnType<PeerConnection['createDataChannel']> | null = null;
  private remoteSdp: string | null = null; // the verified remote SDP (for the fingerprint assertion)
  private verified = false;
  private closed = false;

  constructor(private readonly opts: PeerOptions) {}

  start(): void {
    const log = this.opts.log ?? (() => {});
    const pc = new PeerConnection(`nexus-${this.opts.role}`, {
      iceServers: this.opts.iceServers ?? [],
    });
    this.pc = pc;

    pc.onLocalDescription((sdp, type) => this.safely('onLocalDescription', () => {
      // Sign every offer/answer before it touches the rendezvous.
      this.opts.onSignal({ kind: 'sdp', env: this.opts.sign(sdp, this.opts.role) });
      log(`local ${type} signed + sent`);
    }));
    pc.onLocalCandidate((candidate, mid) => this.safely('onLocalCandidate', () => {
      this.opts.onSignal({ kind: 'ice', candidate, mid });
    }));
    pc.onStateChange((state) => this.safely('onStateChange', () => {
      log(`pc state: ${state}`);
      if (state === 'failed' || state === 'closed' || state === 'disconnected') this.fail(`pc ${state}`);
    }));

    if (this.opts.initiator) {
      this.dc = pc.createDataChannel(DC_LABEL); // triggers the offer
      this.wireDataChannel(this.dc);
    } else {
      pc.onDataChannel((dc) => this.safely('onDataChannel', () => {
        this.dc = dc;
        this.wireDataChannel(dc);
      }));
    }
  }

  /** Process a signaling message relayed from the peer. */
  handleSignal(msg: SignalMsg): void {
    const pc = this.pc;
    if (!pc || this.closed) return;
    if (msg.kind === 'sdp') {
      // THE gate: reject any SDP not signed by the stored peer key.
      if (!this.opts.verifyPeer(msg.env)) {
        this.fail('remote SDP failed identity verification — possible MITM');
        return;
      }
      this.remoteSdp = msg.env.sdp;
      // If WE initiated, the remote SDP is the answer; otherwise it's the offer.
      const type: DescriptionType = this.opts.initiator ? 'answer' : 'offer';
      try {
        pc.setRemoteDescription(msg.env.sdp, type);
      } catch (e) {
        // A malformed/unsupported remote SDP must fail THIS peer, never crash the daemon.
        this.fail(`setRemoteDescription failed: ${String(e)}`);
      }
    } else {
      try {
        pc.addRemoteCandidate(msg.candidate, msg.mid);
      } catch (e) {
        this.opts.log?.(`addRemoteCandidate failed: ${String(e)}`);
      }
    }
  }

  /** Send an app frame (already JSON-serialized) over the authenticated channel. */
  send(text: string): boolean {
    if (!this.verified || !this.dc) return false;
    try {
      return this.dc.sendMessage(text);
    } catch {
      return false;
    }
  }

  get isReady(): boolean {
    return this.verified && !this.closed;
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    try { this.dc?.close(); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
    this.opts.onClosed?.(reason);
  }

  private wireDataChannel(dc: ReturnType<PeerConnection['createDataChannel']>): void {
    dc.onOpen(() => this.safely('dc.onOpen', () => {
      // DTLS is up by the time the channel opens — assert the fingerprint binding NOW,
      // before any app frame is trusted.
      if (!this.assertFingerprint()) {
        this.fail('DTLS fingerprint did not match the signed SDP — refusing the channel');
        return;
      }
      this.verified = true;
      this.opts.log?.('channel verified + open');
      this.opts.onConnected?.();
    }));
    dc.onMessage((msg) => this.safely('dc.onMessage', () => {
      if (!this.verified) return; // never deliver pre-verification
      this.opts.onFrame?.(typeof msg === 'string' ? msg : msg.toString());
    }));
    dc.onClosed?.(() => this.safely('dc.onClosed', () => this.fail('data channel closed')));
  }

  /** Run a native-callback body so any throw is contained — never an uncaught daemon crash. */
  private safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.opts.log?.(`${what} threw (contained): ${String(e)}`);
    }
  }

  private assertFingerprint(): boolean {
    const pc = this.pc;
    if (!pc || !this.remoteSdp) return false;
    let negotiated: string | null = null;
    try {
      const fp = pc.remoteFingerprint() as { value?: string } | string;
      negotiated = typeof fp === 'string' ? fp : (fp?.value ?? null);
    } catch {
      return false;
    }
    if (!fingerprintMatches(this.remoteSdp, negotiated)) {
      this.opts.log?.(
        `fingerprint MISMATCH: signed=${extractFingerprint(this.remoteSdp)} negotiated=${negotiated}`,
      );
      return false;
    }
    return true;
  }

  private fail(reason: string): void {
    this.opts.log?.(`FAIL: ${reason}`);
    this.close(reason);
  }
}
