# NEXUS Operational Runbook

"When X goes wrong, here's exactly what to do." Written for the solo maintainer; if you're a user, most of this doesn't apply.

## 1. Hub is down (users report they can't post / friend-request / sync)

**Diagnose:**
```bash
curl -sS https://nexus-hub-blazelucastaco.fly.dev/healthz
fly status --app nexus-hub-blazelucastaco
fly logs --app nexus-hub-blazelucastaco | tail -100
```

**Recover in descending order of disruption:**

1. **Machine is down / stuck** — `fly machine restart --app nexus-hub-blazelucastaco`.
2. **Bad deploy** — roll back to previous release:
   ```bash
   fly releases --app nexus-hub-blazelucastaco
   fly releases rollback <id> --app nexus-hub-blazelucastaco
   ```
3. **Volume is full / DB sick** — SSH in, check disk:
   ```bash
   fly ssh console --app nexus-hub-blazelucastaco
   df -h /data
   sqlite3 /data/hub.db 'PRAGMA integrity_check;'
   ```
   If full, run the purge queries from `src/index.ts` manually, or grow the volume:
   ```bash
   fly volumes extend <vol-id> --size 2 --app nexus-hub-blazelucastaco
   ```
4. **Fly-wide outage** — check [status.fly.io](https://status.fly.io). Post a GitHub issue; users will see.

After recovery, verify:
```bash
curl -sS https://nexus-hub-blazelucastaco.fly.dev/healthz
# expect {"ok":true}
```

## 2. JWT secret compromised

```bash
# Generate a new secret
NEW=$(node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64"))')
# Pipe via stdin, not CLI arg
echo "$NEW" | fly secrets set JWT_SECRET=- --app nexus-hub-blazelucastaco
# Invalidate every refresh token too (access tokens die in 15 min regardless)
fly ssh console --app nexus-hub-blazelucastaco -C \
  "sqlite3 /data/hub.db 'UPDATE sessions SET revoked_at = datetime(\"now\") WHERE revoked_at IS NULL'"
# Deploy the restart
fly deploy --app nexus-hub-blazelucastaco
unset NEW
```

All users are kicked and must re-login. Communicate via GitHub issue + the social feed.

## 3. Anthropic API key compromised (user-side)

Each user owns their own Anthropic key. Tell the user to:

1. Revoke at [console.anthropic.com](https://console.anthropic.com) → API Keys.
2. Create a new key.
3. Run `nexus verify` on their Mac, paste the new key.
4. Daemon restarts automatically.

## 4. Telegram bot token compromised

1. Revoke via `@BotFather` → `/revoke` (generates a new token).
2. User updates via Configure tab → Change Telegram token.
3. Daemon restarts, old bot receives no further messages.

## 5. User reports data loss (memory missing)

1. Check backups: `fly ssh console --app nexus-hub-blazelucastaco -C "ls -lh /data/backups"`.
2. If recent backup exists: `sqlite3 /data/hub.db < /data/backups/hub-<ts>.db.gz` (after decompressing).
3. If no backup: user's personal Mac memory.db is the source of truth — check `~/.nexus/memory.db` on their machine.

## 6. CI is red on main

Run locally first:
```bash
pnpm install
pnpm check                # biome
pnpm exec tsc --noEmit    # typecheck
pnpm test                 # 854 daemon tests
cd hub && pnpm install && pnpm test   # 62 hub tests
```

Common causes:
- `HOME` path resolves inside the repo on CI → tests that touch `~/.nexus/` get blocked by self-protection. Fix: use `os.tmpdir()`.
- Hub tests imported at the root level → missing `include` in `vitest.config.ts`. Fix: ensure `exclude: ['hub/**', 'installer-app/**']` is present.
- Native module build failure (better-sqlite3) → check Node version matches `engines` in `package.json`.

## 7. Deploying a new DMG release

```bash
# Bump the version
# (once a bump-version script exists, use it; for now edit package.json + hub/package.json + installer-app/package.json)

# Tag and push
git tag v0.1.1
git push origin v0.1.1

# Once the release workflow exists, it will build + sign + notarize + upload the DMG.
# Until then, manually:
cd installer-app
pnpm dist
cp release/NEXUS-*-arm64.dmg ../NEXUS-Installer.dmg
gh release upload v0.1.1 ../NEXUS-Installer.dmg --clobber
```

Verify: download the DMG from the Releases page and install it on a clean Mac (or a scratch VM).

## 8. Bad hub deploy rollback (with data migration)

If the bad deploy added a migration that changed schema:

1. `fly releases rollback <id>` gets you back the old code but leaves the migrated schema.
2. If that causes new errors, you need a schema rollback. Since SQLite doesn't support `DROP COLUMN` pre-3.35, this may require manually dumping, editing, and restoring:
   ```bash
   fly ssh console --app nexus-hub-blazelucastaco
   sqlite3 /data/hub.db .dump > /tmp/dump.sql
   # edit dump.sql to remove the bad column
   rm /data/hub.db /data/hub.db-wal /data/hub.db-shm
   sqlite3 /data/hub.db < /tmp/dump.sql
   fly machine restart
   ```

Always test migrations on staging (`bash scripts/deploy.sh --staging`) before pushing to prod.

## 9. User reports "0 memories imported" or similar import bug

Check:
```bash
# In their terminal:
sqlite3 ~/.nexus/memory.db "SELECT source, COUNT(*) FROM memories WHERE source LIKE 'imported-%' GROUP BY source;"
ls -la ~/.nexus/skills/
```

If rows exist and the user sees 0, they've already imported on a previous run and the dedup logic (in `scripts/run-import.ts`) is correctly skipping — the wizard UI shows "Already merged" in that case. If UI shows wrong copy, it's a bug in the wizard renderer.

## 10. Can't reach GitHub or Releases

The install command is `curl -fsSL https://raw.githubusercontent.com/blazelucastaco-ai/nexus/main/remote-install.sh | bash`. If GitHub is down, the install fails at fetch time with a clear error. No state change; user retries later.

The daemon doesn't depend on GitHub at runtime — only at install, at `nexus update`, and for the chrome-extension.

---

## One-time setup (do these once, when ready)

These are things the operator needs to click through in a browser — they can't
be automated from this repo because they require credentials / accounts.

### Enable branch protection on `main`

`main` should require a passing CI check and a PR (no direct pushes). Browse to:

https://github.com/blazelucastaco-ai/nexus/settings/branches

Click **Add branch ruleset** → target `main` → enable:
- Require a pull request before merging
- Require status checks to pass (select `check`)
- Require linear history
- Block force pushes
- (Optional) Require signed commits

### Set up uptime monitoring on the hub

Pick one, both free tier:

- **UptimeRobot** (easier): sign up at uptimerobot.com → add HTTP(s) monitor →
  URL `https://nexus-hub-blazelucastaco.fly.dev/healthz` → interval 5 min →
  alert contact = your email.
- **Better Stack** (better integration): sign up at betterstack.com → add
  monitor with the same URL → interval 30 sec → on-call routing if you want.

Either way, the monitor should page you within a minute of `/healthz` returning
non-200.

### Wire Sentry error tracking (optional)

1. Sign up at [sentry.io](https://sentry.io) → create project → copy DSN.
2. Add it as a Fly secret on both apps:
   ```bash
   fly secrets set --app nexus-hub-blazelucastaco SENTRY_DSN=<dsn>
   fly secrets set --app nexus-hub-staging-blazelucastaco SENTRY_DSN=<dsn> HUB_ENV=staging
   ```
3. Install the optional dep in hub/:
   ```bash
   cd hub && pnpm add @sentry/node
   ```
4. Deploy. Errors (500s + unhandled exceptions) now stream to Sentry with
   method + url + userId tags (no headers, no body).

The hub runs fine without Sentry installed — `src/error-reporter.ts` no-ops
when the DSN isn't set.

### Schedule the backup

`hub/scripts/backup.sh` exists but isn't scheduled. Run it nightly via a
Fly scheduled machine:

```bash
cd hub
# Create a scheduled machine that runs the backup script daily at 02:00 UTC.
fly machine run . --app nexus-hub-blazelucastaco \
  --schedule daily \
  --entrypoint "sh /app/scripts/backup.sh"
```

Verify backups are landing on the volume:
```bash
fly ssh console --app nexus-hub-blazelucastaco -C "ls -lh /data/backups"
```

### Release a new version

- Bump the version in `package.json`, `hub/package.json`, and
  `installer-app/package.json` (all three need to match).
- Tag and push:
  ```bash
  git tag v0.1.1
  git push origin v0.1.1
  ```
- `.github/workflows/release.yml` runs automatically:
  - Builds the DMG on a macOS runner
  - Generates `NEXUS-Installer.dmg.sha256` sidecar
  - Uploads both to the GitHub Release
  - Deploys the hub to Fly (if `FLY_API_TOKEN` is set)
- Users running the installer-app see the new version banner within an hour
  (the app polls GitHub Releases on mount + hourly).

---

If something's broken and it's not on this list, file a GitHub issue with:
- What you tried to do
- What happened instead
- The output of `nexus doctor` (or `fly status` for hub issues)
- The tail of `~/.nexus/logs/nexus.log` (for daemon issues) or `fly logs` (for hub issues)
