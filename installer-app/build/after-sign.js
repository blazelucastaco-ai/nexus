// electron-builder afterSign hook.
//
// PROBLEM
// We don't ship with an Apple Developer ID, so electron-builder relies on
// the OS / packaging step to apply an ad-hoc signature. The signature
// produced by that path has a resource manifest that references files
// that aren't where the manifest expects (asar repack timing, late-stage
// extraResources copy). macOS sees the mismatch and shows:
//
//   "NEXUS.app is damaged and can't be opened. You should move it to the Trash."
//
// (codesign --verify reports: "code has no resources but signature
// indicates they must be present")
//
// That's worse than the standard "Apple cannot verify" warning — there's
// no Open-Anyway button on a damaged-binary error.
//
// FIX
// Strip the broken sig and re-sign ad-hoc with a fresh manifest that
// matches the bundle as it actually exists at this point in the build.
//
//   codesign --remove-signature <app>
//   codesign --force --deep --sign - <app>
//
// `--sign -` is the ad-hoc identity. `--deep` recurses into nested
// bundles (Electron has helper apps inside Frameworks/). `--force`
// overwrites the existing (broken) sig.
//
// On Apple Silicon (arm64), macOS REQUIRES at least an ad-hoc signature
// to exec a binary — fully unsigned arm64 apps simply don't launch.
// That's why we re-sign here instead of leaving it bare.
//
// Result: app has a *valid* ad-hoc signature with a correct manifest.
// Gatekeeper falls back to the standard "Apple cannot verify" path with
// an Open Anyway button — no Terminal workaround needed.
//
// When (if ever) we sign with a real Developer ID, this hook short-
// circuits via the CSC_LINK / APPLE_ID env vars and leaves the real
// signature alone.

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // If a real Developer ID identity was used, leave the signature alone.
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

  console.log(`[after-sign] re-signing ad-hoc with fresh manifest: ${appPath}`);
  try {
    // 1. Strip the existing (broken) signature.
    execFileSync('codesign', ['--remove-signature', appPath], { stdio: 'inherit' });
    // 2. Re-sign ad-hoc with --deep so nested helper bundles also get a
    //    matching manifest. --force overwrites any leftover signature
    //    metadata. The "-" identity is the codesign convention for
    //    ad-hoc signing.
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', appPath],
      { stdio: 'inherit' },
    );
    // 3. Verify the result. If --verify fails, log loudly so the
    //    operator sees it, but don't throw — DMG packaging still
    //    proceeds. A failed verify here means we shipped the same
    //    broken DMG as before; not worse than the status quo.
    try {
      execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' });
      console.log('[after-sign] re-signed ad-hoc and verified');
    } catch (verifyErr) {
      console.error('[after-sign] re-sign succeeded but --verify failed:', verifyErr.message);
    }
  } catch (err) {
    console.error('[after-sign] codesign re-sign failed:', err.message);
    // Don't throw — let the build complete. Worst case the published DMG
    // has the same problem as before, but at least we don't break CI.
  }
};
