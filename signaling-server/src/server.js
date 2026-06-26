// NEXUS rendezvous — a DATA-BLIND WebRTC signaling switchboard.
//
// It matches two paired devices by an opaque room id (the pairingId — a 128-bit secret
// known only to your Mac + phone from QR pairing) and relays their signed SDP/ICE blobs
// to each other. It holds NO keys, parses NO app data, and stores nothing. It "connects
// the line, then steps away." Confidentiality + MITM-resistance come from the devices'
// own identity signatures + DTLS (see src/webrtc/* in the daemon); this box only ever
// sees opaque blobs it cannot read and the two peers' network addresses.
//
// Self-hosted, single small process. Deployable to any host (Fly.io, a VPS, etc.).

import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 5000);
const OPEN = WebSocket.OPEN;

/** room id -> { mac?: WebSocket, phone?: WebSocket } */
const rooms = new Map();

const http = createServer((req, res) => {
  // Health check (Fly/any LB) — reveals nothing.
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http, maxPayload: 256 * 1024 });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const room = url.searchParams.get('room') ?? '';
  const role = url.searchParams.get('role') ?? '';
  // room = the pairingId (hex). role identifies the two ends. Anything else is junk.
  if (!/^[a-f0-9]{16,64}$/i.test(room) || (role !== 'mac' && role !== 'phone')) {
    ws.close(1008, 'bad room/role');
    return;
  }
  if (!rooms.has(room)) {
    if (rooms.size >= MAX_ROOMS) { ws.close(1013, 'busy'); return; }
    rooms.set(room, {});
  }
  const slot = rooms.get(room);
  const peerRole = role === 'mac' ? 'phone' : 'mac';

  // A fresh connection for the same role replaces the stale one (e.g. reconnect).
  if (slot[role] && slot[role].readyState === OPEN) slot[role].close(1000, 'replaced');
  slot[role] = ws;

  const peer = () => rooms.get(room)?.[peerRole];
  // Tell both ends when the pair is complete, so the initiator starts the offer.
  if (peer()?.readyState === OPEN) {
    ws.send(JSON.stringify({ t: 'peer', present: true }));
    peer().send(JSON.stringify({ t: 'peer', present: true }));
  }

  ws.on('message', (data, isBinary) => {
    // PURE RELAY — forward the opaque blob to the other end. We never parse it.
    const p = peer();
    if (p?.readyState === OPEN) p.send(data, { binary: isBinary });
  });

  ws.on('close', () => {
    const r = rooms.get(room);
    if (!r) return;
    if (r[role] === ws) delete r[role];
    const p = r[peerRole];
    if (p?.readyState === OPEN) p.send(JSON.stringify({ t: 'peer', present: false }));
    if (!r.mac && !r.phone) rooms.delete(room);
  });

  ws.on('error', () => { try { ws.close(); } catch { /* ignore */ } });
});

http.listen(PORT, () => console.log(`nexus-rendezvous listening on :${PORT}`));
