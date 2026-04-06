import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';
import { getDataDir } from '../config.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('Screenshots');

const SCREENSHOT_DIR = join(getDataDir(), 'screenshots');

let dirReady = false;

async function ensureScreenshotDir(): Promise<void> {
  if (!dirReady) {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    dirReady = true;
  }
}

function generateTimestampPath(prefix = 'screenshot'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join(SCREENSHOT_DIR, `${prefix}-${ts}.png`);
}

/**
 * Capture the entire screen and save to disk.
 * @param outputPath - Where to save; defaults to ~/.nexus/screenshots/<timestamp>.png
 * @returns Absolute path to the saved screenshot
 */
export async function captureScreen(outputPath?: string): Promise<string> {
  await ensureScreenshotDir();
  const dest = outputPath ?? generateTimestampPath('screen');

  try {
    // -x suppresses the shutter sound, -t png sets format
    await execFileAsync('screencapture', ['-x', '-t', 'png', dest]);
    logger.info({ path: dest }, 'Full screen captured');
    return dest;
  } catch (err) {
    logger.error({ err, path: dest }, 'Failed to capture screen');
    throw new Error(`Screen capture failed: ${(err as Error).message}`);
  }
}

/**
 * Capture a rectangular region of the screen.
 * @param x - Left edge in pixels
 * @param y - Top edge in pixels
 * @param w - Width in pixels
 * @param h - Height in pixels
 * @param outputPath - Where to save; defaults to ~/.nexus/screenshots/<timestamp>.png
 * @returns Absolute path to the saved screenshot
 */
export async function captureRegion(
  x: number,
  y: number,
  w: number,
  h: number,
  outputPath?: string,
): Promise<string> {
  await ensureScreenshotDir();
  const dest = outputPath ?? generateTimestampPath('region');

  try {
    await execFileAsync('screencapture', [
      '-x',
      '-t',
      'png',
      '-R',
      `${x},${y},${w},${h}`,
      dest,
    ]);
    logger.info({ x, y, w, h, path: dest }, 'Region captured');
    return dest;
  } catch (err) {
    logger.error({ err, x, y, w, h }, 'Failed to capture region');
    throw new Error(`Region capture failed: ${(err as Error).message}`);
  }
}

/**
 * Capture the frontmost window.
 * Uses AppleScript to get the window ID of the frontmost app, then
 * screencapture -l <windowId> to capture just that window.
 * @param outputPath - Where to save; defaults to ~/.nexus/screenshots/<timestamp>.png
 * @returns Absolute path to the saved screenshot
 */
export async function captureWindow(outputPath?: string): Promise<string> {
  await ensureScreenshotDir();
  const dest = outputPath ?? generateTimestampPath('window');

  try {
    // Get the window ID of the frontmost window via JXA
    const jxaScript = `
      const app = Application("System Events");
      const frontApp = app.processes.whose({frontmost: true})[0];
      const win = frontApp.windows[0];
      // CGWindowListCopyWindowInfo approach via JXA
      ObjC.import('CoreGraphics');
      const list = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
      const count = ObjC.unwrap($.CFArrayGetCount(list));
      const frontName = ObjC.unwrap(frontApp.name());
      let windowId = null;
      for (let i = 0; i < count; i++) {
        const info = ObjC.unwrap($.CFArrayGetValueAtIndex(list, i));
        const owner = ObjC.unwrap(info['kCGWindowOwnerName']);
        const layer = ObjC.unwrap(info['kCGWindowLayer']);
        if (owner === frontName && layer === 0) {
          windowId = ObjC.unwrap(info['kCGWindowNumber']);
          break;
        }
      }
      windowId;
    `;

    let windowIdArg: string | null = null;
    try {
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', jxaScript]);
      const id = stdout.trim();
      if (id && id !== 'null' && id !== 'undefined') {
        windowIdArg = id;
      }
    } catch {
      logger.warn('Could not get window ID via JXA, falling back to interactive window capture');
    }

    const args = ['-x', '-t', 'png'];
    if (windowIdArg) {
      args.push('-l', windowIdArg);
    } else {
      // Fallback: capture frontmost window using -w flag
      args.push('-w');
    }
    args.push(dest);

    await execFileAsync('screencapture', args);
    logger.info({ path: dest, windowId: windowIdArg }, 'Window captured');
    return dest;
  } catch (err) {
    logger.error({ err, path: dest }, 'Failed to capture window');
    throw new Error(`Window capture failed: ${(err as Error).message}`);
  }
}
