# Deploying the Nexus Hub to Fly.io

**Two commands** (flyctl is already installed on this Mac).

## Sign in to Fly once

```bash
fly auth signup   # new Fly account — opens browser, verify email
# or
fly auth login    # existing account
```

No credit card required for the free tier.

## Deploy

```bash
./scripts/deploy.sh
```

That's it. The script:

1. Creates the Fly app (auto-named `nexus-hub-<your-fly-username>`)
2. Writes the app name + region into `fly.toml`
3. Creates the `hub_data` persistent volume for SQLite
4. Generates a strong random `JWT_SECRET` and sets it
5. Deploys the container
6. Prints the URL + writes it to `HUB_URL.txt`

Idempotent — re-run as often as you like. Existing app / volume / secret are detected and skipped.

Override defaults if you want:

```bash
./scripts/deploy.sh --app my-custom-name --region ams --size 3
```

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
