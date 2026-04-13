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
    unlink(testPath).catch(() => {});
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
 * Logs warnings for any missing permissions and opens the relevant System Settings panes.
 * Returns an array of human-readable warning strings (suitable for Telegram).
 */
export async function warnMissingPermissions(status: PermissionStatus): Promise<string[]> {
  const warnings: string[] = [];
  const missing = (Object.entries(status) as [keyof PermissionStatus, boolean][]).filter(
    ([, granted]) => !granted,
  );

  if (missing.length === 0) return warnings;

  logger.warn({ missing: missing.map(([k]) => k) }, 'Some macOS permissions are missing');

  for (const [key] of missing) {
    const name = PERMISSION_NAMES[key];
    logger.warn(
      `Missing permission: ${name}. ` +
      `Grant it in System Settings > Privacy & Security > ${name}`,
    );
    warnings.push(
      `⚠️ *Missing permission: ${name}*\n` +
      `Go to System Settings → Privacy & Security → ${name}\n` +
      `and enable access for the node binary or your terminal.`,
    );
    await openPermissionPane(key);
  }

  return warnings;
}
