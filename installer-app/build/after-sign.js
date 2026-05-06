// electron-builder afterSign hook.
//
// We don't ship with an Apple Developer ID, so electron-builder applies an
// ad-hoc signature to the .app by default. That signature's resource
// manifest sometimes references files that aren't where the manifest
// expects them (asar repack timing, late-stage extraResources copy), and
// the result is the macOS error:
//
//   "NEXUS.app is damaged and can't be opened. You should move it to the Trash."
//
// (codesign --verify reports: "code has no resources but signature
// indicates they must be present")
//
// That's worse than the standard "Apple cannot verify" warning because
// users hit it BEFORE Gatekeeper even shows them an Open-Anyway button.
//
// This hook strips the ad-hoc signature post-sign and pre-DMG-package, so
// the .app is *truly* unsigned. Gatekeeper falls back to the standard
// unsigned-app path: System Settings → Privacy & Security → Open Anyway.
//
// When (if ever) we sign with a real Developer ID, this hook should
// short-circuit if context.electronPlatformName !== 'darwin' OR the
// CSC_LINK / APPLE_ID env vars are set (i.e. real signing happened).

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // If a real Developer ID identity was used, leave the signature alone —
  // it's a valid signature and stripping it would defeat the whole point
  // of paying $99/year for the cert.
  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.APPLE_ID) {
    console.log('[after-sign] real signing identity detected — leaving signature intact');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);

  if (!existsSync(appPath)) {
    console.warn(`[after-sign] expected app at ${appPath} but it doesn't exist — skipping`);
    return;
  }

  console.log(`[after-sign] stripping broken ad-hoc signature from ${appPath}`);
  try {
    execFileSync('codesign', ['--remove-signature', appPath], { stdio: 'inherit' });
    console.log('[after-sign] signature removed; app is now truly unsigned');
  } catch (err) {
    console.error('[after-sign] codesign --remove-signature failed:', err.message);
    // Don't throw — let the build complete. Worst case the published DMG
    // has the same problem as before, but at least we don't break CI.
  }
};
