# NEXUS rendezvous (signaling)

A **data-blind** WebRTC signaling switchboard for the NEXUS phone link. It matches your
paired Mac + iPhone by an opaque room id and relays their **signed** SDP/ICE blobs. It
holds no keys, parses no app data, and stores nothing — it "connects the line, then steps
away." All confidentiality + MITM-resistance lives in the devices' own signatures + DTLS
(`src/webrtc/*` in the daemon); this box only ever sees opaque blobs and IP:ports.

This is the only always-on cloud piece. Keep ONE machine running so the Mac can hold a
persistent connection.

## Deploy to Fly.io ("Launch from your machine")

Do **not** use Fly's "Launch from GitHub" pointed at the `nexus` repo — that would deploy
the whole NEXUS daemon. Deploy *this folder* instead:

```bash
# 1. install flyctl (once)
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh

# 2. log in (or you're already logged in via the dashboard)
fly auth login

# 3. from THIS folder, create + deploy the app
cd signaling-server
fly launch --no-deploy       # accept the Dockerfile; pick an app name + your nearest region
fly deploy
```

`fly launch` reads the included `Dockerfile` + `fly.toml`. After deploy, your URL is
`wss://<app-name>.fly.dev`. That value becomes `NEXUS_SIGNAL_URL` for the daemon and the
QR pairing payload.

Smoke-test it:
```bash
curl https://<app-name>.fly.dev/health   # → ok
```

## STUN / TURN (next)

For "works anywhere on cellular", the devices also need a STUN/TURN server (coturn).
STUN-only works for most networks; TURN-over-TLS (`turns:` on 443) is the fallback for
restrictive/symmetric-NAT networks. That's a separate, self-hosted piece added next — on
the same Fly org (a coturn app) or a small VPS. On the same LAN, neither is needed (direct
connection).

## Run locally
```bash
npm install && npm start    # listens on :8080 (ws://localhost:8080)
```
