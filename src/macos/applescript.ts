import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('AppleScript');

/**
 * Escape a string for safe embedding in AppleScript double-quoted strings.
 * Handles backslashes, double quotes, and tabs/newlines.
 */
function escapeAS(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r');
}

/**
 * Execute an arbitrary AppleScript string via osascript.
 * @param script - The AppleScript source code
 * @returns The stdout output from the script, trimmed
 */
export async function runAppleScript(script: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      timeout: 30_000,
    });
    logger.debug({ scriptLength: script.length }, 'AppleScript executed');
    return stdout.trim();
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err, script: script.substring(0, 200) }, 'AppleScript execution failed');
    throw new Error(`AppleScript failed: ${msg}`);
  }
}

/**
 * Execute a JXA (JavaScript for Automation) script via osascript.
 * @param script - The JavaScript source code
 * @returns The stdout output from the script, trimmed
 */
export async function runJxa(script: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: 30_000,
    });
    logger.debug({ scriptLength: script.length }, 'JXA executed');
    return stdout.trim();
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err, script: script.substring(0, 200) }, 'JXA execution failed');
    throw new Error(`JXA failed: ${msg}`);
  }
}

// ─── Common Helper Functions ──────────────────────────────────────────

/**
 * Open (launch and activate) an application by name.
 * Uses `open -a` for reliability — works even if the app isn't running yet.
 * @param appName - Name of the application (e.g. "Safari", "Terminal")
 */
export async function openApp(appName: string): Promise<void> {
  try {
    await execFileAsync('open', ['-a', appName]);
    logger.info({ app: appName }, 'App opened');
  } catch (err) {
    logger.error({ err, app: appName }, 'Failed to open app');
    throw new Error(`Failed to open ${appName}: ${(err as Error).message}`);
  }
}

/**
 * Quit an application by name.
 * @param appName - Name of the application
 */
export async function quitApp(appName: string): Promise<void> {
  const escaped = escapeAS(appName);
  try {
    await runAppleScript(`tell application "${escaped}" to quit`);
    logger.info({ app: appName }, 'App quit');
  } catch (err) {
    logger.error({ err, app: appName }, 'Failed to quit app');
    throw new Error(`Failed to quit ${appName}: ${(err as Error).message}`);
  }
}

/**
 * Get the current system clipboard text contents.
 * @returns The clipboard text string
 */
export async function getClipboard(): Promise<string> {
  const result = await runAppleScript('the clipboard');
  return result;
}

/**
 * Set the system clipboard to a given text string.
 * @param text - The text to place on the clipboard
 */
export async function setClipboard(text: string): Promise<void> {
  const escaped = escapeAS(text);
  await runAppleScript(`set the clipboard to "${escaped}"`);
  logger.debug({ length: text.length }, 'Clipboard set');
}

/**
 * Show a macOS notification via osascript display notification.
 * @param title - The notification title
 * @param message - The notification body text
 * @param subtitle - Optional subtitle line
 * @param sound - Optional system sound name (e.g. "Glass", "Ping", "Basso")
 */
export async function showNotification(
  title: string,
  message: string,
  subtitle?: string,
  sound?: string,
): Promise<void> {
  const titleEsc = escapeAS(title);
  const msgEsc = escapeAS(message);

  let script = `display notification "${msgEsc}" with title "${titleEsc}"`;
  if (subtitle) {
    script += ` subtitle "${escapeAS(subtitle)}"`;
  }
  if (sound) {
    script += ` sound name "${escapeAS(sound)}"`;
  }

  await runAppleScript(script);
  logger.debug({ title }, 'Notification shown');
}

/**
 * Show a dialog box and return the button that was pressed.
 * @param message - The dialog message text
 * @param buttons - Array of button labels (max 3). Defaults to ["OK"]
 * @param defaultButton - Optional index (1-based) or name of the default button
 * @param title - Optional dialog title
 * @returns The name of the button that was clicked, or empty string if cancelled
 */
export async function showDialog(
  message: string,
  buttons: string[] = ['OK'],
  defaultButton?: string | number,
  title?: string,
): Promise<string> {
  const msgEsc = escapeAS(message);
  const btnList = buttons.map((b) => `"${escapeAS(b)}"`).join(', ');

  let script = `display dialog "${msgEsc}" buttons {${btnList}}`;

  if (defaultButton !== undefined) {
    if (typeof defaultButton === 'number') {
      script += ` default button ${defaultButton}`;
    } else {
      script += ` default button "${escapeAS(defaultButton)}"`;
    }
  } else {
    script += ' default button 1';
  }

  if (title) {
    script += ` with title "${escapeAS(title)}"`;
  }

  try {
    const result = await runAppleScript(script);
    // Result format: "button returned:OK"
    const match = result.match(/button returned:(.+)/);
    const clicked = match?.[1]?.trim() ?? buttons[0];
    logger.debug({ title, clicked }, 'Dialog shown');
    return clicked;
  } catch (err) {
    // Handle user cancellation (error -128)
    const errMsg = (err as Error).message ?? '';
    if (errMsg.includes('User canceled') || errMsg.includes('-128')) {
      logger.debug({ title }, 'Dialog cancelled by user');
      return '';
    }
    throw err;
  }
}

/**
 * Get a list of all currently running (non-background) application names.
 * @returns Array of application name strings
 */
export async function getRunningApps(): Promise<string[]> {
  try {
    const result = await runAppleScript(
      'tell application "System Events" to get name of every process whose background only is false',
    );
    const apps = result.split(', ').map((name) => name.trim()).filter(Boolean);
    logger.debug({ count: apps.length }, 'Running apps retrieved');
    return apps;
  } catch (err) {
    logger.error({ err }, 'Failed to get running apps');
    throw new Error(`Failed to get running apps: ${(err as Error).message}`);
  }
}
