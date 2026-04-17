import { execFile } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('Permissions');

export interface PermissionStatus {
  screenRecording: boolean;
  accessibility: boolean;
  fullDiskAccess: boolean;
  automation: boolean;
  contacts: boolean;
  messages: boolean;
}

const PERMISSION_NAMES: Record<keyof PermissionStatus, string> = {
  screenRecording: 'Screen Recording',
  accessibility: 'Accessibility',
  fullDiskAccess: 'Full Disk Access',
  automation: 'Automation',
  contacts: 'Contacts',
  messages: 'Messages (Automation)',
};

// System Settings pane URLs for each permission
const PREF_URLS: Record<keyof PermissionStatus, string> = {
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  fullDiskAccess: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  contacts: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts',
  messages: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

async function checkScreenRecording(): Promise<boolean> {
  const testPath = join(tmpdir(), `nexus-perm-${Date.now()}.png`);
  try {
    await execFileAsync('/usr/sbin/screencapture', ['-x', testPath], { timeout: 5000 });
    // Cleanup is best-effort; a leftover probe file is harmless
    unlink(testPath).catch((e) => { logger.debug({ e, testPath }, 'Failed to clean up permission probe file'); });
    return true;
  } catch {
    return false;
  }
}

async function checkAccessibility(): Promise<boolean> {
  try {
    // AXIsProcessTrusted check via JXA
    const script = `ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()`;
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: 3000,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function checkFullDiskAccess(): Promise<boolean> {
  try {
    // Protected file only readable with Full Disk Access
    await execFileAsync('sqlite3', [
      '/Library/Application Support/com.apple.TCC/TCC.db',
      '.tables',
    ], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function checkAutomation(): Promise<boolean> {
  try {
    await execFileAsync('osascript', ['-e', 'tell application "Finder" to return name'], {
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

async function checkContacts(): Promise<boolean> {
  try {
    // Use tccutil or check TCC db if we have Full Disk Access; otherwise attempt a quick
    // read and treat a non-timeout result (even an error) as "permission granted or promptable"
    const { stdout } = await execFileAsync(
      'osascript',
      ['-e', 'tell application "Contacts" to return count of every person'],
      { timeout: 4000 },
    );
    return !isNaN(parseInt(stdout.trim(), 10));
  } catch {
    return false;
  }
}

async function checkMessagesAutomation(): Promise<boolean> {
  try {
    await execFileAsync(
      'osascript',
      ['-e', 'tell application "Messages" to return name of first service'],
      { timeout: 4000 },
    );
    return true;
  } catch {
    return false;
  }
}

export async function checkPermissions(): Promise<PermissionStatus> {
  const [screenRecording, accessibility, fullDiskAccess, automation, contacts, messages] =
    await Promise.all([
      checkScreenRecording(),
      checkAccessibility(),
      checkFullDiskAccess(),
      checkAutomation(),
      checkContacts(),
      checkMessagesAutomation(),
    ]);
  const status = { screenRecording, accessibility, fullDiskAccess, automation, contacts, messages };
  logger.debug(status, 'Permission check complete');
  return status;
}

export async function openPermissionPane(permission: keyof PermissionStatus): Promise<void> {
  try {
    await execFileAsync('open', [PREF_URLS[permission]]);
  } catch (err) {
    logger.warn({ err, permission }, 'Failed to open System Settings pane');
  }
}

/**
 * Opens Script Editor with an AppleScript that triggers the TCC permission dialog.
 * Use this for Contacts and Messages since background processes don't get auto-prompted.
 */
export async function triggerPermissionPrompt(permission: 'contacts' | 'messages'): Promise<void> {
  const scripts: Record<string, string> = {
    contacts: 'tell application "Contacts" to return count of every person',
    messages: 'tell application "Messages" to return name of first service',
  };
  const script = scripts[permission];
  if (!script) return;

  try {
    // Open Script Editor with the script — user just hits Cmd+R to trigger the TCC dialog
    await execFileAsync('osascript', [
      '-e',
      `tell application "Script Editor"
        activate
        set doc to make new document
        set contents of doc to "${script}"
      end tell`,
    ], { timeout: 5000 });
    logger.info({ permission }, 'Opened Script Editor to trigger TCC permission prompt');
  } catch (err) {
    logger.warn({ err, permission }, 'Failed to open Script Editor for permission prompt');
  }
}

// Detailed manual instructions for permissions that won't auto-prompt
// (macOS TCC doesn't show dialogs for background Node.js subprocesses)
const MANUAL_INSTRUCTIONS: Partial<Record<keyof PermissionStatus, string>> = {
  contacts:
    `System Settings → Privacy &amp; Security → Contacts\n` +
    `Enable <b>Terminal</b> (or node). If missing, run this in Script Editor first:\n` +
    `<code>tell application "Contacts" to return count of every person</code>`,

  messages:
    `System Settings → Privacy &amp; Security → Automation\n` +
    `Expand <b>Terminal</b> → enable the <b>Messages</b> checkbox. If missing, run this in Script Editor first:\n` +
    `<code>tell application "Messages" to return name of first service</code>`,
};

// ─── Why macOS won't auto-prompt ─────────────────────────────────────────────
// NEXUS runs as a background Node.js process. When it spawns osascript to check
// Contacts or Messages, macOS TCC attributes the request to the `osascript`
// binary (a system tool), not to Terminal or NEXUS. Background processes with
// no UI bundle often get silently denied without showing a dialog at all.
// The only reliable trigger is running the AppleScript from an interactive app
// like Script Editor, which gets the proper TCC prompt.

/**
 * Logs warnings for any missing permissions and opens the relevant System Settings panes.
 * Returns an array of human-readable warning strings (suitable for Telegram HTML mode).
 */
export async function warnMissingPermissions(status: PermissionStatus): Promise<string[]> {
  const warnings: string[] = [];
  const missing = (Object.entries(status) as [keyof PermissionStatus, boolean][]).filter(
    ([, granted]) => !granted,
  );

  if (missing.length === 0) return warnings;

  logger.warn({ missing: missing.map(([k]) => k) }, 'Some macOS permissions are missing');

  const lines: string[] = ['⚠️ <b>NEXUS — missing permissions</b>\n'];

  for (const [key] of missing) {
    const name = PERMISSION_NAMES[key];
    logger.warn(`Missing permission: ${name}. Grant it in System Settings > Privacy & Security > ${name}`);

    const manualSteps = MANUAL_INSTRUCTIONS[key];
    if (manualSteps) {
      lines.push(`<b>${name}</b>\n${manualSteps}`);
    } else {
      lines.push(
        `<b>${name}</b>\nSystem Settings → Privacy &amp; Security → ${name}\nEnable Terminal or node, then restart NEXUS.`,
      );
      await openPermissionPane(key);
    }
  }

  lines.push('\nRestart NEXUS after granting.');
  warnings.push(lines.join('\n\n'));

  return warnings;
}
