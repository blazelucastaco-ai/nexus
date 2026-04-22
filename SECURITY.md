# Security Policy

## Reporting a vulnerability

If you find a security issue in NEXUS, please do not file a public GitHub issue. Report it privately via one of:

1. **GitHub private advisory** — [github.com/blazelucastaco-ai/nexus/security/advisories/new](https://github.com/blazelucastaco-ai/nexus/security/advisories/new) (preferred).
2. **Email** — security reports to the project maintainer (address in the GitHub profile). Include `NEXUS SECURITY` in the subject.

You should expect an initial acknowledgement within 3 business days. We aim to validate and patch within 14 days for critical issues, 30 days for high, 90 days for medium. We'll credit you in the release notes unless you ask us not to.

## Scope

The scope covers code in this repository:

- **`src/`** — the NEXUS daemon that runs on a user's Mac.
- **`hub/`** — the Fastify account server deployed at `nexus-hub-blazelucastaco.fly.dev`.
- **`installer-app/`** — the Electron installer/dashboard app shipped as `NEXUS-Installer.dmg`.
- **`chrome-extension/`** — the browser bridge extension.

Out of scope: third-party dependencies (report upstream), social engineering of the single maintainer, physical access to the user's Mac.

## What counts as a vulnerability

In rough descending priority:

- Remote code execution in the daemon, hub, or installer-app.
- Authentication bypass on the hub (taking over another user's account, bypassing refresh-token rotation, bypassing lockout).
- Secret leakage — Anthropic key, Telegram token, JWT secret, refresh tokens, user passwords.
- Privilege escalation out of the Electron sandbox or the hub's request scope.
- Cross-user data leakage (seeing another user's friends, posts, gossip, or soul messages).
- Destructive operations without user consent (deleting files, memories, or accounts from a compromised tool or prompt-injection).
- Supply-chain attacks via dependency manipulation or the update flow.

Not a vulnerability (but still worth reporting as an issue): UI bugs, rate-limit evasion that only affects the attacker's own account, denial-of-service against the single maintainer's hub.

## Defense-in-depth design

- Passwords hashed with scrypt (N=32768, r=8, p=1). Never logged, never transmitted in plaintext after initial POST.
- Access tokens are short-lived HS256 JWTs (15 min), rotated via opaque refresh tokens (SHA-256-hashed in DB).
- Refresh tokens ROTATE on every use. Reuse of a revoked refresh triggers family-wide session revocation.
- Posts are Ed25519-signed by the originating instance; hub verifies client-supplied `createdAt` against signature canonical form with a ±2min skew window.
- Gossip + soul messages are end-to-end encrypted (X25519 ECDH + ChaCha20-Poly1305). Hub sees only ciphertext.
- File writes on the daemon go through a path guard that refuses writes inside the NEXUS source tree and outside `$HOME` / `/tmp`.
- Secret-bearing files (`.env`, `config.json/yaml`, `hub-session.json`, launchd plists) are written with mode 0o600.
- Rate limits: 10 / 15min per IP on `/auth/*`, 300 / min per authed user on everything else.
- Hub URL is allowlisted client-side to prevent session-marker tampering from redirecting auth traffic.
- Account lockout after 5 consecutive failed logins (15-minute lock).
- CSP on the installer-app renderer. `contextIsolation: true`, `nodeIntegration: false`.

## Rotating the JWT secret

See `hub/DEPLOY.md`. TL;DR: `fly secrets set JWT_SECRET=<new> --app nexus-hub-blazelucastaco`, then deploy. This invalidates every outstanding access token immediately; refresh tokens stay valid (they're not JWT-signed) so users are silently re-authed within 15 min. To invalidate refresh tokens too, `DELETE FROM sessions` on the hub.

## Disclosing a vulnerability you have already fixed

If you're a contributor and you fix a security issue in a PR, please still mention it in the security advisory system so we can tag a security release. Don't merge security fixes silently into `main`.
