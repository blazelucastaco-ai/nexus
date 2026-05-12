# Signing the NEXUS installer with your Apple Developer ID

The default `pnpm run dist` produces an **ad-hoc-signed** DMG. macOS still shows the "Apple cannot verify that NEXUS is free of malware" dialog on first launch (with an Open Anyway button users can click).

To eliminate that warning entirely you need to **sign with a Developer ID certificate** and **notarize** the DMG with Apple. This document walks through the one-time setup, then how to build a signed + notarized DMG.

> When this is wired correctly, end users double-click `NEXUS-Installer.dmg`, drag NEXUS into Applications, and launch — no Gatekeeper dialog, no "Open Anyway", no Privacy & Security trip. Apple has already pre-cleared the binary.

---

## 1. Confirm you have an active Apple Developer account

You need a paid Apple Developer Program membership ($99/year). Sign in at <https://developer.apple.com/account>. The dashboard should say **Membership: Active**.

If it says Pending, wait until Apple completes the enrollment review (usually 24–48 hours) before continuing.

## 2. Create a Developer ID Application certificate

Apps distributed *outside* the Mac App Store sign with a **Developer ID Application** cert (not Mac App Distribution).

### Option A — via Xcode (easiest)
1. Open Xcode → **Settings** → **Accounts**.
2. Add your Apple ID if it's not already there.
3. Select your team → **Manage Certificates…**
4. Click the **+** at the bottom-left → **Developer ID Application**.
5. Xcode creates the cert, downloads it, and installs it in your login keychain.

### Option B — via the Apple Developer portal
1. Go to <https://developer.apple.com/account/resources/certificates/list>.
2. Click **+** → **Developer ID Application** → Continue.
3. Generate a Certificate Signing Request (CSR) in Keychain Access: **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority…** Save the `.certSigningRequest` file.
4. Upload it back at developer.apple.com → click **Continue** → download the `.cer` file.
5. Double-click the `.cer` to add it to your login keychain.

### Verify the cert is present
```sh
security find-identity -v -p codesigning
```
You should see a line like:
```
1) ABC123DEF456...  "Developer ID Application: Lucas Topinka (TEAMID)"
```

Note the **identity name** (everything between the quotes) and your **Team ID** (the 10-character string in parentheses).

## 3. Get an app-specific password for notarization

Notarization talks to Apple via your Apple ID, but Apple requires an *app-specific password* (not your real Apple ID password):

1. Sign in at <https://appleid.apple.com>.
2. Under **Sign-In and Security** → **App-Specific Passwords** → click **+**.
3. Label it `NEXUS notarization`. Apple returns a 4×4 password like `xxxx-xxxx-xxxx-xxxx`.
4. **Save it somewhere safe** — Apple shows it once. You'll need it as `APPLE_APP_SPECIFIC_PASSWORD`.

## 4. Set the environment variables

Three options — pick one:

### A. One-off (shell session only)
```sh
export APPLE_ID="your@appleid.email"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID12345"
export CSC_NAME="Developer ID Application: Lucas Topinka (TEAMID12345)"
```

### B. Persistent (`~/.zshrc`)
Append the four `export` lines above to `~/.zshrc`. Don't commit this — it's secrets.

### C. macOS Keychain (recommended for production)
Store the password in Keychain so it survives across machines and doesn't sit in shell history:
```sh
xcrun notarytool store-credentials "NEXUS-NOTARY" \
  --apple-id "your@appleid.email" \
  --team-id "TEAMID12345" \
  --password "xxxx-xxxx-xxxx-xxxx"
```
Then set `APPLE_KEYCHAIN_PROFILE=NEXUS-NOTARY` instead of `APPLE_APP_SPECIFIC_PASSWORD`.

## 5. Build the signed + notarized DMG

```sh
cd ~/nexus/installer-app
pnpm run dist:signed
```

What happens under the hood:
1. **vite build** + **tsc** compile the renderer + main as usual.
2. electron-builder reads `package.json` `build.mac` → sees `CSC_NAME` env var is set → uses that identity instead of ad-hoc.
3. After the bundle is laid out, `build/after-sign.js` detects the real signing env vars and **does not re-sign** ad-hoc (it short-circuits — see the comment block in that file).
4. electron-builder runs `codesign` with the Developer ID cert.
5. The DMG is packaged.
6. electron-builder uploads the DMG to Apple's notary service, polls for the verdict, then **staples** the notarization ticket to the DMG so it works offline.

The whole thing takes 5–15 minutes (notarization queue time varies).

**Output:** `installer-app/release/NEXUS-Installer.dmg` — fully trusted by Gatekeeper.

## 6. Verify the DMG before uploading

```sh
codesign --verify --deep --strict --verbose=2 release/mac-arm64/NEXUS.app
spctl -a -t install -vv release/NEXUS-0.2.0-arm64.dmg
xcrun stapler validate release/NEXUS-0.2.0-arm64.dmg
```
All three should report success. If `spctl` reports `Notarized Developer ID`, you're golden — that's the magic phrase that means Apple has signed off on this binary.

## 7. Ship it

```sh
cp release/NEXUS-0.2.0-arm64.dmg /tmp/NEXUS-Installer.dmg
shasum -a 256 /tmp/NEXUS-Installer.dmg | awk '{print $1"  NEXUS-Installer.dmg"}' > /tmp/NEXUS-Installer.dmg.sha256
gh release upload v0.2.0 /tmp/NEXUS-Installer.dmg /tmp/NEXUS-Installer.dmg.sha256 --clobber --repo blazelucastaco-ai/nexus
```

---

## Troubleshooting

- **"errSecInternalComponent" during codesign** — the certificate is locked in the keychain. Unlock it: `security unlock-keychain ~/Library/Keychains/login.keychain-db`
- **"Code object is not signed at all"** — `hardenedRuntime` isn't enabled in the signed config. Make sure you ran `dist:signed`, not `dist`.
- **Notarization rejection** — read the log: `xcrun notarytool log <submission-id> --keychain-profile NEXUS-NOTARY`. Most common cause: missing entitlements for the helper apps inside Frameworks/.
- **"App is damaged" on user's Mac** — staple wasn't attached. Re-run `xcrun stapler staple release/NEXUS-Installer.dmg` and re-upload.

## What if the cert expires?

Developer ID Application certs are valid for 5 years. When yours expires:
1. Generate a new one (Step 2 again).
2. Old DMGs already notarized stay valid forever — notarization tickets don't expire.
3. New DMGs built after expiry will fail signing until you swap in the new cert.

Apple emails you 30 days before expiry — don't ignore it.
