# Security Policy

## Reporting a vulnerability

If you find a security issue in NEXUS, please do not file a public GitHub issue. Report it privately via one of:

1. **GitHub private advisory** — [github.com/blazelucastaco-ai/nexus/security/advisories/new](https://github.com/blazelucastaco-ai/nexus/security/advisories/new) (preferred).
2. **Email** — security reports to the project maintainer (address in the GitHub profile). Include `NEXUS SECURITY` in the subject.

You should expect an initial acknowledgement within 3 business days. We aim to validate and patch within 14 days for critical issues, 30 days for high, 90 days for medium. We'll credit you in the release notes unless you ask us not to.

## Scope

The scope covers code in this repository:

- **`src/`** — the NEXUS daemon that runs on a user's Mac.
- **`installer-app/`** — the Electron installer/dashboard app shipped as `NEXUS-Installer.dmg`.
- **`chrome-extension/`** — the browser bridge extension.

> NEXUS is now a **fully local** assistant — there is no remote account server, no
> cross-instance gossip/feed/friend system, and no telemetry to anyone but the user's
> own Telegram chat. Anything in older docs that references a hosted hub is historical.

Out of scope: third-party dependencies (report upstream), social engineering of the single maintainer, physical access to the user's Mac.

## What counts as a vulnerability

In rough descending priority:

- Remote code execution in the daemon or installer-app (e.g. via prompt injection that escapes the tool sandbox).
- Secret leakage — Anthropic key, Telegram bot token, anything in `.env`, anything in macOS Keychain that NEXUS owns.
- Privilege escalation out of the Electron sandbox or the daemon's tool-approval gate.
- Destructive operations without user consent (deleting files, memories, or shell state from a compromised tool call or prompt-injection).
- Supply-chain attacks via dependency manipulation or the update flow.

Not a vulnerability (but still worth reporting as an issue): local UI bugs, behavior that only affects the attacker's own machine after they already have shell access.

## Defense-in-depth design

- File writes on the daemon go through a path guard that refuses writes inside the NEXUS source tree and outside `$HOME` / `/tmp`.
- Tool calls that touch the shell or filesystem run through an approval gate (`src/tools/`).
- Secret-bearing files (`.env`, `config.json/yaml`, launchd plists) are written with mode 0o600.
- The orchestrator's self-protection layer refuses to disclose its own source / paths / commits when asked.
- Telegram bot accepts messages only from `allowedUsers` configured at install.
- CSP on the installer-app renderer. `contextIsolation: true`, `nodeIntegration: false`.
- Chrome extension bridge listens on `127.0.0.1:9338` only; rejects non-localhost origins.

## Disclosing a vulnerability you have already fixed

If you're a contributor and you fix a security issue in a PR, please still mention it in the security advisory system so we can tag a security release. Don't merge security fixes silently into `main`.
