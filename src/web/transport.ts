// WebTransport — what a WebGateway needs from its transport, independent of HOW bytes
// move. Two implementations feed the SAME gateway + brain:
//   - WebServer        (loopback HTTP/WS, the desktop browser)
//   - WebRtcTransport  (an E2E-encrypted WebRTC data channel, the phone)
// Keeping the gateway against this interface is what lets the phone be "the same NEXUS
// interface, from anywhere" with zero changes to the brain.

import type { ClientFrame, ServerFrame } from './protocol.js';

export type ClientMessageHandler = (frame: ClientFrame, reply: (f: ServerFrame) => void) => void;

export interface WebTransport {
  broadcast(frame: ServerFrame): void;
  get hasClients(): boolean;
  /** Cache an audio clip + return a URL id — for HTTP transports only. Non-HTTP
   *  transports embed the bytes in the audio frame instead, so this returns ''. */
  putTts(buffer: Buffer, mime?: string): string;
  onMessage(handler: ClientMessageHandler): void;
  /** true → audio is delivered as a `/tts/<id>` URL; false → embedded as base64 in-frame
   *  (no loopback HTTP exists over a P2P channel). */
  readonly servesHttp: boolean;
}
