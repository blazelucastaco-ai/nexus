# Contributing to NEXUS

Thanks for being interested. NEXUS is a one-maintainer project with a few moving parts — here's how to work on it without breaking the pieces you can't see yet.

## Repo layout

```
nexus/
├── src/                  NEXUS daemon (Node + TypeScript)
├── tests/                Daemon unit + integration tests (vitest)
├── scripts/              One-shot CLI helpers (setup, doctor, run-import, …)
├── hub/                  Fastify + SQLite account server — deployed to Fly.io
├── installer-app/        Electron installer + dashboard — shipped as a DMG
├── chrome-extension/     MV3 extension that bridges Chrome to the daemon
├── docs/                 GitHub Pages landing page
├── .github/              CI workflows
```

## Prerequisites

- Node.js 22+ (22 LTS is ideal — CI runs on 22).
- pnpm 10+ (`corepack enable` then `corepack prepare pnpm@10 --activate`).
- macOS for running the daemon end-to-end (the installer targets Mac only). Hub + tests run anywhere.
- A Fly.io account only if you're touching hub deployment.

```bash
git clone https://github.com/blazelucastaco-ai/nexus.git
cd nexus
pnpm install
pnpm test           # 854 daemon tests, ~20s
cd hub && pnpm install && pnpm test   # 62 hub tests, ~4s
```

## Running each piece locally

- **Daemon** — `pnpm dev` (tsx watch). Talk to it via Telegram after setting `ANTHROPIC_API_KEY` + `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env`.
- **Hub** — `cd hub && pnpm dev`. Exposes `http://127.0.0.1:8787`. Point the daemon at it with `NEXUS_HUB_URL=http://127.0.0.1:8787` (add that URL to the allowlist in `src/hub/client.ts` during development).
- **Installer-app** — `cd installer-app && pnpm dev`. Boots Electron with hot-reload on the renderer.

## Style

- **TypeScript** strict mode everywhere. `pnpm check` must pass (root, hub, installer-app).
- **Biome** handles lint + format. Run `pnpm check` before pushing.
- Comments explain the **why**, not the what. Keep them short (usually one line). Don't explain what well-named code already does.
- No emojis in source. (The only exception is renderer-side copy the user reads.)
- Don't add backwards-compatibility shims, unused re-exports, or half-finished abstractions.

## Tests

- Every PR that changes hub route behavior needs a test in `hub/tests/`.
- Every PR that changes daemon behavior needs a test in `tests/` unless it's trivially visual (renderer copy, SEO).
- Tests use in-memory SQLite (`:memory:`) for the hub, a real `~/.nexus/memory.db` for the daemon (cleaned between runs).
- Don't mock the DB; integration tests caught the signature-verification bug that unit tests would have missed.

## Security-sensitive changes

Anything that touches:

- Password hashing / token generation / JWT signing
- File permissions on secret-bearing files
- The self-protection regex, write guard, or approval gate
- Hub authentication flow (login, refresh, logout, delete)
- Gossip / soul encryption, post signing

…needs a follow-up test demonstrating the new protection, AND a line in the PR description calling it out. The maintainer will review it with extra care.

## Commit messages

- Conventional-ish. `feat(hub): ...`, `fix(daemon): ...`, `test(installer-app): ...`, `docs: ...`.
- Imperative mood. "add" not "adds" or "added."
- Body explains the why and the blast radius, not just the what.

## Pull requests

- One logical change per PR. If you find yourself writing "also…" in the description, split it.
- PRs must pass CI before merging. Don't merge with failing checks; fix them first.
- Any CI environment that needs secrets gets them from GitHub Actions secrets, never committed.
- Screenshots/videos help a lot for installer-app changes.

## Releases

- The maintainer tags `v0.1.x` → GitHub Actions builds the DMG, signs it (once a Developer ID is wired in), notarizes it, uploads to Releases.
- Hub deploys go through `bash hub/scripts/deploy.sh --staging` → manual validation → `bash hub/scripts/deploy.sh` for prod.

## Licensing

MIT. By contributing, you agree to license your contribution under the same terms. See `LICENSE`.

## Code of conduct

Be useful. Be kind. Don't waste the maintainer's time. If the project gets big enough to need a formal CoC, we'll add one; for now we work on trust.
