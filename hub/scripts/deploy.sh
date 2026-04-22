#!/usr/bin/env bash
# One-shot Fly.io deploy for the NEXUS Hub.
#
# Run this AFTER you've signed into Fly (`fly auth login` or `fly auth signup`).
# It handles:
#   1. Creating the app (idempotent — safe to re-run)
#   2. Creating the persistent SQLite volume
#   3. Generating + setting the JWT secret
#   4. Deploying the container
#   5. Printing the resulting URL + writing it to HUB_URL.txt
#
# Flags:
#   --app  <name>    override the default app name "nexus-hub-<fly-username>"
#   --region <code>  override region (default: iad)
#   --size <GB>      volume size (default: 1)

set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME=""
REGION="iad"
VOLUME_SIZE="1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)    APP_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --size)   VOLUME_SIZE="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────

if ! command -v fly >/dev/null 2>&1; then
  echo "fly CLI not found. Install with: brew install flyctl" >&2
  exit 1
fi

if ! fly auth whoami >/dev/null 2>&1; then
  echo "Not signed into Fly.io. Run one of:" >&2
  echo "  fly auth signup    # new Fly account" >&2
  echo "  fly auth login     # existing account" >&2
  exit 1
fi

# Default app name includes Fly username so it's unique.
if [[ -z "$APP_NAME" ]]; then
  USERNAME=$(fly auth whoami | sed 's/@.*//' | tr -cd 'a-z0-9-')
  APP_NAME="nexus-hub-${USERNAME}"
fi

echo "─── NEXUS Hub deploy ───"
echo "  App:    $APP_NAME"
echo "  Region: $REGION"
echo "  Volume: ${VOLUME_SIZE}GB"
echo "────────────────────────"

# ── 1. Create the app (idempotent) ───────────────────────────────────

if fly apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP_NAME"; then
  echo "✓ app '$APP_NAME' already exists"
else
  echo "→ creating app '$APP_NAME'…"
  fly apps create "$APP_NAME" --org personal
fi

# Update fly.toml with the actual app name.
# Uses awk so the replacement is idempotent and handles both the default
# value and any previous deploy's name.
TMP_TOML=$(mktemp)
awk -v name="$APP_NAME" -v region="$REGION" '
  /^app = / { print "app = \"" name "\""; next }
  /^primary_region = / { print "primary_region = \"" region "\""; next }
  { print }
' fly.toml > "$TMP_TOML" && mv "$TMP_TOML" fly.toml

# ── 2. Persistent volume ─────────────────────────────────────────────

EXISTING_VOLS=$(fly volumes list --app "$APP_NAME" 2>/dev/null | awk '$2 == "hub_data" {print $1}' || true)
if [[ -n "$EXISTING_VOLS" ]]; then
  echo "✓ volume hub_data already exists"
else
  echo "→ creating volume hub_data (${VOLUME_SIZE}GB in $REGION)…"
  fly volumes create hub_data \
    --app "$APP_NAME" \
    --region "$REGION" \
    --size "$VOLUME_SIZE" \
    --yes
fi

# ── 3. JWT secret ────────────────────────────────────────────────────

if fly secrets list --app "$APP_NAME" 2>/dev/null | grep -q '^JWT_SECRET'; then
  echo "✓ JWT_SECRET already set (not rotating — use --rotate to force)"
else
  echo "→ generating + setting JWT_SECRET…"
  SECRET=$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))")
  fly secrets set JWT_SECRET="$SECRET" --app "$APP_NAME"
fi

# ── 4. Deploy ────────────────────────────────────────────────────────

echo "→ deploying…"
fly deploy --app "$APP_NAME" --ha=false

# ── 5. Summary ───────────────────────────────────────────────────────

URL="https://${APP_NAME}.fly.dev"
echo "$URL" > HUB_URL.txt

echo ""
echo "───────────────────────────────────────────────"
echo "  Deployed → $URL"
echo "  Health → ${URL}/healthz"
echo "───────────────────────────────────────────────"
echo ""
echo "Next: update the installer-app default URL. Run:"
echo ""
echo "  sed -i '' \"s|http://127.0.0.1:8787|${URL}|\" \\"
echo "    ../installer-app/src/main/installer-core.ts"
echo ""
echo "Then rebuild the DMG from inside installer-app/:"
echo "  pnpm dist"
echo ""
