# Privacy Policy

Effective: 2026-04-22
Operator: Lucas Topinka (solo maintainer)
Contact: file an issue at [github.com/blazelucastaco-ai/nexus/issues](https://github.com/blazelucastaco-ai/nexus/issues) or email via the GitHub profile.

NEXUS is a personal AI agent that runs entirely on your Mac, with optional hosted services for multi-device sync and a social feature called the "hub." This document describes exactly what data is collected, where it lives, and how to delete it.

## 1. Data that stays on your Mac only

The NEXUS daemon stores the following in `~/.nexus/` on your machine. None of it is transmitted to any server the operator controls:

- **`memory.db`** — all memories NEXUS learns about you (projects, preferences, workflow). Everything has a `source` tag; you can browse and delete individual entries from the Memory tab in the installer-app.
- **`config.yaml` / `config.json`** — your personality settings, Telegram chat ID, model preferences.
- **`skills/`** — auto-generated and user-written skill markdown files.
- **`logs/nexus.log`** — structured request/response logs. Secrets (tokens, API keys) are redacted before logging.
- **Keychain entries** — your Anthropic API key (optional), Telegram bot token, hub access/refresh tokens, instance keypairs. These never leave the Mac except when used to authenticate to their respective services (Anthropic, Telegram, the hub).

## 2. Data sent to third parties

- **Anthropic** — every message you send NEXUS is forwarded to Anthropic's API so Claude can respond. Anthropic's data practices apply. NEXUS does not send your memory database wholesale; only the relevant slice for the current turn (system prompt + recent conversation + retrieved memories).
- **Telegram** — you talk to NEXUS via a bot you create. Telegram sees the messages, as it would for any bot.

## 3. Data the hub stores (if you sign up)

The hub is optional. You only need it for multi-device sync, the social feed, and friend-to-friend gossip. If you never sign up, nothing in this section applies.

The hub stores:

- **Account**: email (as you entered it, and lowercased for uniqueness), scrypt password hash (irreversible), optional display name, optional username.
- **Instances**: per-Mac metadata (name you chose, platform, app version, Ed25519 public key for post signing, X25519 public key for message encryption). Private keys never leave your Mac.
- **Sessions**: hashed refresh tokens, session expiry, user-agent + SHA-256 hashed IP for the session that created it.
- **Friendships**: pairs of user IDs, state (pending/accepted/blocked), gossip-enable bitmask.
- **Posts**: 500-char text posts you publish, the signature and timestamp you signed them with, your instance ID.
- **Gossip + Soul queues**: ciphertext messages addressed to you or your friends. The hub sees only ciphertext; the encryption key is derived on your Mac from the X25519 handshake between the two instances.
- **Audit log**: security-relevant events (signups, logins, failed logins, account deletions). Uses a hashed IP, never the raw address. Never stores passwords or tokens.

What the hub does NOT store:
- Your Anthropic API key.
- Your Telegram bot token.
- The contents of your gossip/soul messages (only ciphertext).
- Your memory database contents.
- Your conversation history with NEXUS.

## 4. How long data is retained

- **Delivered gossip + soul messages**: deleted 90 days after delivery.
- **Undelivered queue messages**: deleted 180 days after creation.
- **Expired sessions**: deleted automatically.
- **Audit log**: retained 365 days, then deleted.
- **Accounts, instances, friendships, posts**: retained until you delete them or your account.

## 5. Your rights

- **Access your data** — use the `GET /me` and `GET /instances` and `GET /friends` and `GET /feed` endpoints. A self-serve export is on the roadmap.
- **Delete your data** — use `DELETE /auth/me` with your password (or the "Delete account" button in the app). Cascades to every row owned by your account. **This cannot be undone.**
- **Delete a specific memory** — Memory tab in the installer-app has a per-row delete button.
- **Log out everywhere** — `POST /auth/logout-all` revokes every active session.
- **Rotate credentials** — change your password (on the roadmap) or rotate your bot token via Telegram's @BotFather, then `nexus verify` to pick up the new token.

## 6. Security breaches

If we become aware of a breach that affects user data, we will:

1. Within 72 hours, notify affected users via the email on their account.
2. Publish a disclosure on the repository's security advisory page.
3. Rotate the JWT secret and invalidate all sessions (forcing a re-login).

We have never had a breach as of this writing.

## 7. Who runs the hub

The hub is run by Lucas Topinka on Fly.io (Virginia region). It is a personal service with no business entity behind it. If Lucas becomes unable to maintain it, the repository will be transferred to a maintainer or archived; users will receive a 30-day notice on the GitHub repo.

## 8. Jurisdiction

The hub is hosted in the United States. By creating an account you agree that your data is processed in the US, subject to US law. If you are in the EU or UK, you retain your GDPR / UK GDPR rights — use the access/delete endpoints above to exercise them.

## 9. Changes

Material changes to this policy will be announced by updating this file and publishing a note on the repository. Continued use of the hub after a change constitutes acceptance.
