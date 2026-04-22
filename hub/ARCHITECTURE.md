# NEXUS Hub — Architecture

## Roles

- **User** — a human with an email + password.
- **Instance** — one NEXUS install, tied to a user. A user can have many.
- **Hub** — this service. Stores account + routes messages.
- **Friend** — another user who has mutually accepted a friend request.

## Data model (all tables declared in `src/db.ts`)

```
users ─< instances   (1 user, N instances)
users ─< sessions    (refresh-token rows)
users ←> friendships (bidirectional, A<B enforced to avoid dupes)
users ─< posts       (1 user, N posts; each post from 1 instance)
instances ─< gossip_queue     (E2E enc, between friends)
instances ─< soul_queue       (E2E enc, between same-user instances)
users ─< audit_log
```

## Phase plan

### Phase 1 — Accounts (shipped)
- Signup, login, logout, refresh.
- Instance registration + list + ping + delete.
- Rate limiting, account lockout, audit log.
- Installer-app wizard step: create account or sign in.
- Installer-app stores credentials in macOS Keychain (never config.json).

### Phase 2 — Social layer
- **Friends**
  - `POST /friends/request { email | userId }` — creates pending row.
  - `POST /friends/:id/accept` — flips to accepted.
  - `POST /friends/:id/block`
  - `GET /friends` — list.
- **Posts**
  - `POST /posts { content, signature }` — signature over `content|createdAt|instanceId`, verified with the instance's registered Ed25519 pubkey.
  - `GET /feed` — posts from accepted friends, newest first. Returns ids + pubkeys so client verifies each signature.
- **Gossip (opt-in)**
  - Per-friendship `gossip_enabled` flag, bidirectional.
  - `POST /gossip/send { toInstanceId, ciphertext, nonce }`.
  - `GET /gossip/inbox` — returns undelivered rows addressed to an instance of the requesting user, marks delivered.
  - Hub sees only ciphertext + routing metadata.

### Phase 3 — Soul sync (same-user)
- `POST /soul/send` + `GET /soul/inbox`, same shape as gossip but keyed by the user's master secret derived from password via scrypt and cached in Keychain.
- Agents randomly (not on a fixed interval) send each other state: recent memories, preference updates, skill additions.
- Receiving instance decrypts, merges into its own memory.db, flags imported entries with `source='soul-imported'` so the owner can audit.

## Client wire protocol

### Authentication
```
Client                             Hub
  |-- POST /auth/signup -------->   | (201 { user, accessToken }, Set-Cookie: nexus_refresh)
  |-- POST /auth/login ---------->   | (200 { user, accessToken }, Set-Cookie)
  |-- POST /auth/refresh -------->   | (200 { accessToken })
  |-- POST /auth/logout --------->   | (200 ok, Clear-Cookie)
```

### Instance lifecycle
```
On first login:
  1. Client generates Ed25519 keypair in Keychain
  2. POST /instances { name, publicKey, platform, appVersion }
  3. Stores returned `id` in Keychain

On every boot (while online):
  POST /instances/:id/ping  — marks last_seen_at

On "sign out this Mac":
  DELETE /instances/:id
  — client deletes its Keychain entries and forgets the refresh cookie
```

### Auth headers
- Access token: `Authorization: Bearer <jwt>`
- Refresh: `Cookie: nexus_refresh=<opaque>` (httpOnly, Secure in prod)

All responses are JSON. Errors look like `{ "error": "<machine_code>" }`. Never put human-readable explanations in error codes — they're for the client to branch on, not to print to users.

## Deployment

- `pnpm build && pnpm start` — produces `dist/index.js`, listens on `HOST:PORT`.
- TLS terminates at the edge. Recommended: Caddy or Fly.io's built-in TLS.
- DB: SQLite file at `DB_PATH`. Fine for thousands of users; swap to Postgres if you grow past that.
- Env secrets (`JWT_SECRET`) via env variable injection. Never in config files or images.

## Files

```
hub/
  src/
    index.ts                    # Fastify entry
    db.ts                       # schema + migrations
    auth.ts                     # scrypt + JWT + session helpers
    middleware/
      auth.ts                   # requireAuth preHandler
    routes/
      auth-routes.ts            # /auth/* endpoints
      instances-routes.ts       # /instances/* + /me
  SECURITY.md
  ARCHITECTURE.md
  .env.example
  package.json
```
