# Deploying the Nexus Hub to Fly.io

Four commands and it's live. Built-in TLS, auto-restart on crash, ~$0/month at low volume.

## One-time setup

Install flyctl if you don't already have it:

```bash
brew install flyctl
```

Sign in (or sign up — no credit card required for the free tier):

```bash
fly auth signup   # or: fly auth login
```

## Deploy

From inside `hub/`:

```bash
# 1. Create the app. Pick a unique name when asked (e.g. nexus-hub-yourname).
#    When it asks to create a Postgres/Upstash/etc., say NO to all.
fly launch --no-deploy

# 2. Create the persistent volume for SQLite. Pick the same region your app
#    is in. `iad` (Virginia) is a fine default for US users.
fly volumes create hub_data --region iad --size 1

# 3. Generate + set the JWT signing secret. Keep this out of git forever.
fly secrets set JWT_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64"))')"

# 4. Deploy.
fly deploy
```

That's it. Fly prints the URL — something like `https://nexus-hub-yourname.fly.dev`.

Smoke test:

```bash
curl https://nexus-hub-yourname.fly.dev/healthz
# → {"ok":true}
```

## Wire the installer-app to it

Edit `installer-app/src/main/installer-core.ts` and change the default hub URL constant (or set `NEXUS_HUB_URL` when launching the app). Rebuild the DMG with:

```bash
cd installer-app
pnpm dist
```

Users who download this new DMG will reach the production hub automatically.

## Rotating secrets

If `JWT_SECRET` ever leaks, rotate it. Every active access token is invalidated instantly (they can't be verified against the new secret). Refresh tokens still work because those are hashed in the DB, not signed.

```bash
fly secrets set JWT_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64"))')"
fly deploy
```

## Backups

Fly volumes snapshot daily by default and keep 5 days of history. Restore:

```bash
fly volumes snapshots list hub_data
fly volumes restore <snapshot-id>
```

Full DB export (run occasionally, store safely):

```bash
fly ssh console -C "sqlite3 /data/hub.db '.backup /tmp/backup.db'"
fly ssh sftp get /tmp/backup.db ./hub-backup-$(date +%F).db
```

## Costs

At the time of writing, a single 256 MB shared-cpu-1x machine running 24/7 is well under Fly's free allowance. Auto-stop is enabled in `fly.toml` — the machine shuts down when idle and boots in <1s on the next request, so cost is close to zero at low traffic.

## Troubleshooting

- **`DATABASE_PATH` issues after a deploy** — the volume wasn't created before `fly deploy`. Make `fly volumes create` first.
- **`JWT_SECRET missing` in logs** — run the `fly secrets set` step above, then `fly deploy` again.
- **Clients get CORS errors** — the Electron installer hits the hub with `Origin: null`. The default `CORS_ORIGINS=null,file://` already allows this; if you tighten it, include both.
- **Want a custom domain?** `fly certs add hub.yourname.com` then point a CNAME at the fly.dev address.
