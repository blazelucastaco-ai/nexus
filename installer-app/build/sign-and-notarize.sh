#!/bin/bash
# Build + sign + notarize + staple, using a Keychain-stored notary profile
# so no app-specific password ever passes through env vars.
#
# Required env vars (caller's shell):
#   CSC_NAME                    — codesign identity (e.g.
#                                 "LUCAS JOSEPH TOPINKA (TEAMID)" — no prefix)
#   APPLE_TEAM_ID               — 10-char Developer ID team
#   APPLE_KEYCHAIN_PROFILE      — notarytool credentials profile name
#                                 (created via `xcrun notarytool store-credentials`)
#
# Why this script instead of electron-builder's built-in notarize:
#   electron-builder 25.1.8's mac.notarize schema only exposes `{ teamId? }`.
#   To use a keychain profile we'd have to set APPLE_APP_SPECIFIC_PASSWORD,
#   pulling the secret out of the keychain into a process env var. notarytool
#   talks to the keychain natively — no env-var-secret needed.
#
# Steps:
#   1. Build + sign with electron-builder (no notarize)
#   2. notarytool submit --wait → Apple notarizes, returns verdict
#   3. stapler staple → attach the ticket to the DMG so it works offline
#   4. spctl assess → verify the result before we ship
#
# Exits non-zero with a readable error at any failed step.

set -euo pipefail

# Sanity-check required env.
: "${CSC_NAME:?CSC_NAME env var is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID env var is required}"
: "${APPLE_KEYCHAIN_PROFILE:?APPLE_KEYCHAIN_PROFILE env var is required}"

cd "$(dirname "$0")/.."

# ── 1) Build + sign ────────────────────────────────────────────────────────
echo "[sign-and-notarize] step 1/4 — build + sign with electron-builder"
pnpm run build
npx electron-builder --mac dmg \
  --config.mac.identity="$CSC_NAME" \
  --config.mac.hardenedRuntime=true \
  --config.mac.gatekeeperAssess=true \
  --config.mac.entitlements=build/entitlements.mac.plist \
  --config.mac.entitlementsInherit=build/entitlements.mac.plist \
  --config.mac.notarize=false

# Find the produced DMG (electron-builder names it NEXUS-<version>-arm64.dmg).
DMG="$(ls -t release/NEXUS-*-arm64.dmg 2>/dev/null | head -1 || true)"
if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "[sign-and-notarize] FAILED — no DMG found in release/ after build"
  exit 1
fi
echo "[sign-and-notarize] built: $DMG"

# ── 2) Submit to Apple for notarization ────────────────────────────────────
echo "[sign-and-notarize] step 2/4 — notarytool submit (takes ~5–15 min)"
xcrun notarytool submit "$DMG" \
  --keychain-profile "$APPLE_KEYCHAIN_PROFILE" \
  --wait
# `--wait` blocks until Apple returns a verdict. notarytool exits non-zero
# if Apple rejects the submission. set -e propagates that and we abort.

# ── 3) Staple the ticket ───────────────────────────────────────────────────
echo "[sign-and-notarize] step 3/4 — stapler staple"
xcrun stapler staple "$DMG"

# ── 4) Verify ──────────────────────────────────────────────────────────────
echo "[sign-and-notarize] step 4/4 — spctl assess"
spctl -a -t install -vv "$DMG" || {
  echo "[sign-and-notarize] WARNING — spctl assessment did not report success."
  echo "[sign-and-notarize] The DMG is signed + notarized but Gatekeeper rejected it."
  echo "[sign-and-notarize] Run \`xcrun stapler validate $DMG\` for details."
  exit 1
}

echo "[sign-and-notarize] DONE — $DMG is signed, notarized, stapled, and Gatekeeper-approved."
