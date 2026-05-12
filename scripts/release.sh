#!/bin/bash
# One-command NEXUS release: bump version + build signed DMG + commit/push +
# cut GitHub release + upload assets.
#
# USAGE:
#   ./scripts/release.sh patch    # 0.2.3 → 0.2.4 (default)
#   ./scripts/release.sh minor    # 0.2.3 → 0.3.0
#   ./scripts/release.sh major    # 0.2.3 → 1.0.0
#
# Prereqs (one-time setup, see installer-app/SIGNING.md):
#   - Apple Developer ID Application cert in your login keychain.
#   - notarytool credentials stored via:
#       xcrun notarytool store-credentials NEXUS-NOTARY ...
#   - These env vars set in your shell:
#       export CSC_NAME="LUCAS JOSEPH TOPINKA (9R8ZSRKHP2)"
#       export APPLE_TEAM_ID="9R8ZSRKHP2"
#       export APPLE_KEYCHAIN_PROFILE="NEXUS-NOTARY"
#       export APPLE_ID="lucastopinka@icloud.com"
#
# What it does (each step exits the script on failure via `set -e`):
#   1. Read current version from installer-app/package.json
#   2. Compute new version per the chosen bump kind
#   3. Patch 4 version surfaces (both package.jsons, VERSION const, sidebar)
#   4. pnpm run dist:signed → produces release/NEXUS-<new>-arm64.dmg
#   5. Stage /tmp/NEXUS-Installer.dmg + .sha256
#   6. git commit + git push
#   7. gh release create v<new> with the staged DMG attached
#
# What it deliberately does NOT do:
#   - Restart your menubar. If your menubar were restarted onto the new
#     version, you'd never see the update notification popup test. Keep
#     the menubar on the OLDER version and watch the toast fire.
#   - Refresh the daemon (com.nexus.ai). Daemon-only changes don't ship
#     via the DMG — they go straight through the source pull. The
#     release script is purely about installer-app releases.

set -euo pipefail

# Resolve repo root regardless of where the script was invoked from.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$REPO_ROOT"

KIND="${1:-patch}"
case "$KIND" in
  patch|minor|major) ;;
  *) echo "Usage: $0 [patch|minor|major]" >&2; exit 2 ;;
esac

# ── Required env vars ──────────────────────────────────────────────────────
for var in CSC_NAME APPLE_TEAM_ID APPLE_KEYCHAIN_PROFILE APPLE_ID; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var env var is required. See installer-app/SIGNING.md." >&2
    exit 2
  fi
done

# ── Compute new version ────────────────────────────────────────────────────
CURRENT="$(node -p "require('./installer-app/package.json').version")"
NEW="$(node -e "
  const [maj, min, pat] = '${CURRENT}'.split('.').map(Number);
  const kind = '${KIND}';
  let v;
  if (kind === 'major') v = \`\${maj + 1}.0.0\`;
  else if (kind === 'minor') v = \`\${maj}.\${min + 1}.0\`;
  else v = \`\${maj}.\${min}.\${pat + 1}\`;
  process.stdout.write(v);
")"
echo "==> Bumping ${CURRENT} → ${NEW} (${KIND})"

# ── Patch the 4 version surfaces ───────────────────────────────────────────
# Using a portable in-place sed (-i '' works on BSD/macOS, -i '' on GNU also).
sed -i.bak "s/\"version\": \"${CURRENT}\"/\"version\": \"${NEW}\"/" installer-app/package.json
sed -i.bak "s/\"version\": \"${CURRENT}\"/\"version\": \"${NEW}\"/" package.json
sed -i.bak "s/const VERSION = '${CURRENT}'/const VERSION = '${NEW}'/" installer-app/src/main/installer-core.ts
sed -i.bak "s/v${CURRENT} · INSTALLER/v${NEW} · INSTALLER/" installer-app/src/renderer/App.tsx
# Drop the .bak files sed left behind. Doing this in a separate step keeps
# the diff small if some surface fails to update (caller can inspect .bak).
# Explicit `rm -f` per known-target rather than `find -delete` so we don't
# accidentally nuke anyone else's .bak files in the tree.
rm -f package.json.bak \
      installer-app/package.json.bak \
      installer-app/src/main/installer-core.ts.bak \
      installer-app/src/renderer/App.tsx.bak

# Sanity-check the patch took.
ACTUAL="$(node -p "require('./installer-app/package.json').version")"
if [ "$ACTUAL" != "$NEW" ]; then
  echo "ERROR: installer-app/package.json wasn't patched (got $ACTUAL, expected $NEW)" >&2
  exit 1
fi

# ── Build the signed DMG ───────────────────────────────────────────────────
echo "==> Building signed + notarized DMG (takes 5–15 min for notarization)"
( cd installer-app && pnpm run dist:signed )

# ── Stage the assets ───────────────────────────────────────────────────────
DMG_LOCAL="installer-app/release/NEXUS-${NEW}-arm64.dmg"
if [ ! -f "$DMG_LOCAL" ]; then
  echo "ERROR: expected DMG at $DMG_LOCAL but it doesn't exist" >&2
  exit 1
fi
cp "$DMG_LOCAL" /tmp/NEXUS-Installer.dmg
shasum -a 256 /tmp/NEXUS-Installer.dmg | awk '{print $1"  NEXUS-Installer.dmg"}' > /tmp/NEXUS-Installer.dmg.sha256
echo "==> Staged /tmp/NEXUS-Installer.dmg ($(stat -f%z /tmp/NEXUS-Installer.dmg) bytes)"

# ── Commit + push ──────────────────────────────────────────────────────────
echo "==> Committing version bump"
git add \
  installer-app/package.json \
  package.json \
  installer-app/src/main/installer-core.ts \
  installer-app/src/renderer/App.tsx
git commit -m "chore(release): v${NEW}

Auto-generated by scripts/release.sh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin HEAD

# ── Cut the GitHub release ─────────────────────────────────────────────────
echo "==> Creating GitHub release v${NEW}"
gh release create "v${NEW}" \
  /tmp/NEXUS-Installer.dmg \
  /tmp/NEXUS-Installer.dmg.sha256 \
  --repo blazelucastaco-ai/nexus \
  --title "NEXUS Installer v${NEW}" \
  --generate-notes

echo ""
echo "============================================================"
echo "  v${NEW} released."
echo "  https://github.com/blazelucastaco-ai/nexus/releases/tag/v${NEW}"
echo "============================================================"
