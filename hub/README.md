# NEXUS Hub

Account server for NEXUS instances. Phase 1 of the Nexus-Hub platform:

- Email + password auth (scrypt, JWT access + refresh cookies)
- Instance registration + listing (Ed25519 public-key identity)
- Rate limiting, account lockout, audit log
- SQLite-backed, runs anywhere Node runs

Full architecture: [ARCHITECTURE.md](ARCHITECTURE.md) · Security model: [SECURITY.md](SECURITY.md)

## Run it

```bash
cd hub
pnpm install
cp .env.example .env
# Edit .env: generate a JWT_SECRET with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"`
pnpm dev   # http://127.0.0.1:8787
```

Health check: `curl http://127.0.0.1:8787/healthz`

## Quick API tour

```bash
# Sign up
curl -c cookies.txt -X POST http://127.0.0.1:8787/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse-battery","displayName":"Your Name"}'

# Token comes back in the response — export it
TOKEN=<access-token-from-above>

# Register this install
curl -b cookies.txt -X POST http://127.0.0.1:8787/instances \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"MacBook","publicKey":"<64-hex-Ed25519-pubkey>","platform":"darwin-25","appVersion":"0.1.0"}'

# List
curl -b cookies.txt -H "authorization: Bearer $TOKEN" http://127.0.0.1:8787/instances
```

## What's NOT in Phase 1

- Posts / feed
- Friends / friend requests
- Gossip (E2E agent-to-agent messaging)
- Soul sync (same-user instance sync)

These are designed in [ARCHITECTURE.md](ARCHITECTURE.md) and will land in Phase 2+. The table schema for all of them is already in `src/db.ts` so migrations are additive.

## License

MIT © 2026 Lucas Topinka
