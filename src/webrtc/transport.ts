// WebRtcTransport — adapts one authenticated WebRtcPeer (the E2E link to the phone) to
// the WebTransport interface, so the SAME WebGateway + brain drive the phone exactly as
// they drive the desktop browser. Audio is embedded in-frame (servesHttp=false): there
// is no loopback HTTP over a P2P channel.

import { parseClientFrame, type ServerFrame } from '../web/protocol.js';
import type { ClientMessageHandler, WebTransport } from '../web/transport.js';
import type { WebRtcPeer } from './peer.js';

export class WebRtcTransport implements WebTransport {
  readonly servesHttp = false;
  private peer: WebRtcPeer | null = null;
  private handler: ClientMessageHandler | null = null;

  /** Bind the peer this transport sends over. The daemon wires the peer's `onFrame` to
   *  `feed()` at construction, so inbound app frames reach the gateway. */
  attach(peer: WebRtcPeer): void {
    this.peer = peer;
  }

  /** Inbound app frame (JSON text) from the peer's data channel → the gateway. */
  feed(text: string): void {
    const frame = parseClientFrame(safeParse(text));
    if (!frame) return;
    // `reply` targets the single peer this transport serves.
    this.handler?.(frame, (f) => this.send(f));
  }

  broadcast(frame: ServerFrame): void {
    // Orb-only: the phone shows ONLY the orb + voice — never the visual/widget Stage.
    // Drop `ui` frames so widgets/diagrams/nodes never reach the companion.
    if (frame.t === 'ui') return;
    this.send(frame);
  }

  get hasClients(): boolean {
    return this.peer?.isReady ?? false;
  }

  putTts(): string {
    return ''; // unused — audio rides in the frame (servesHttp=false)
  }

  onMessage(handler: ClientMessageHandler): void {
    this.handler = handler;
  }

  private send(frame: ServerFrame): void {
    this.peer?.send(JSON.stringify(frame));
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
