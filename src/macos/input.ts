import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('MacInput');

/**
 * Escape a string for safe embedding inside an AppleScript double-quoted string.
 * Handles backslashes and double quotes.
 */
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Run an AppleScript snippet via osascript. Returns stdout trimmed.
 */
async function osascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script]);
  return stdout.trim();
}

/**
 * Move the mouse cursor to absolute screen coordinates.
 * Uses CoreGraphics via Python + Quartz (available by default on macOS).
 */
export async function moveMouse(x: number, y: number): Promise<void> {
  try {
    const pyScript = [
      'import Quartz',
      `point = Quartz.CGPointMake(${x}, ${y})`,
      'event = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, point, Quartz.kCGMouseButtonLeft)',
      'Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)',
    ].join('\n');

    await execFileAsync('python3', ['-c', pyScript]);
    logger.debug({ x, y }, 'Mouse moved');
  } catch (err) {
    logger.error({ err, x, y }, 'Failed to move mouse');
    throw new Error(`Move mouse failed: ${(err as Error).message}`);
  }
}

/**
 * Click at absolute screen coordinates.
 * Moves cursor then posts a left-click down+up event via Python + Quartz.
 * @param x - Screen x coordinate
 * @param y - Screen y coordinate
 * @param button - 'left' (default) or 'right'
 */
export async function click(
  x: number,
  y: number,
  button: 'left' | 'right' = 'left',
): Promise<void> {
  try {
    const downEvent = button === 'right' ? 'Quartz.kCGEventRightMouseDown' : 'Quartz.kCGEventLeftMouseDown';
    const upEvent = button === 'right' ? 'Quartz.kCGEventRightMouseUp' : 'Quartz.kCGEventLeftMouseUp';
    const mouseButton = button === 'right' ? 'Quartz.kCGMouseButtonRight' : 'Quartz.kCGMouseButtonLeft';

    const pyScript = [
      'import Quartz, time',
      `point = Quartz.CGPointMake(${x}, ${y})`,
      `move = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, point, ${mouseButton})`,
      'Quartz.CGEventPost(Quartz.kCGHIDEventTap, move)',
      'time.sleep(0.05)',
      `down = Quartz.CGEventCreateMouseEvent(None, ${downEvent}, point, ${mouseButton})`,
      'Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)',
      'time.sleep(0.05)',
      `up = Quartz.CGEventCreateMouseEvent(None, ${upEvent}, point, ${mouseButton})`,
      'Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)',
    ].join('\n');

    await execFileAsync('python3', ['-c', pyScript]);
    logger.debug({ x, y, button }, 'Clicked');
  } catch (err) {
    logger.error({ err, x, y }, 'Failed to click');
    throw new Error(`Click failed: ${(err as Error).message}`);
  }
}

/**
 * Type a string of text using AppleScript keystroke.
 * For short ASCII text, sends keystrokes directly.
 * For long or complex text, uses the clipboard to paste.
 */
export async function typeText(text: string): Promise<void> {
  try {
    if (text.length <= 200 && /^[\x20-\x7E\n\t]+$/.test(text)) {
      // Direct keystroke for short, simple ASCII text
      const escaped = escapeAppleScript(text);
      await osascript(
        `tell application "System Events" to keystroke "${escaped}"`,
      );
    } else {
      // For longer or non-ASCII text, paste via clipboard
      const escaped = escapeAppleScript(text);
      await osascript(`set the clipboard to "${escaped}"`);
      await osascript(
        `tell application "System Events" to keystroke "v" using command down`,
      );
    }
    logger.debug({ length: text.length }, 'Text typed');
  } catch (err) {
    logger.error({ err }, 'Failed to type text');
    throw new Error(`Type text failed: ${(err as Error).message}`);
  }
}

/**
 * Map of common key names to AppleScript key codes.
 */
const KEY_CODE_MAP: Record<string, number> = {
  return: 36,
  enter: 76,
  tab: 48,
  space: 49,
  delete: 51,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  forwarddelete: 117,
};

export type Modifier = 'command' | 'shift' | 'option' | 'control' | 'fn';

/**
 * Press a key, optionally with modifiers.
 * @param key - Key name (e.g. 'a', 'return', 'f5') or single character
 * @param modifiers - Optional array of modifier keys: 'command', 'shift', 'option', 'control', 'fn'
 */
export async function keyPress(key: string, modifiers?: Modifier[]): Promise<void> {
  try {
    const modStr = modifiers && modifiers.length > 0
      ? ` using {${modifiers.map((m) => `${m} down`).join(', ')}}`
      : '';

    const lowerKey = key.toLowerCase();
    const keyCode = KEY_CODE_MAP[lowerKey];

    let script: string;
    if (keyCode !== undefined) {
      script = `tell application "System Events" to key code ${keyCode}${modStr}`;
    } else {
      const escaped = escapeAppleScript(key);
      script = `tell application "System Events" to keystroke "${escaped}"${modStr}`;
    }

    await osascript(script);
    logger.debug({ key, modifiers }, 'Key pressed');
  } catch (err) {
    logger.error({ err, key, modifiers }, 'Failed to press key');
    throw new Error(`Key press failed: ${(err as Error).message}`);
  }
}

/**
 * Scroll at the given position.
 * @param x - Screen x coordinate
 * @param y - Screen y coordinate
 * @param amount - Positive scrolls up, negative scrolls down (in lines)
 */
export async function scroll(x: number, y: number, amount: number): Promise<void> {
  try {
    const pyScript = [
      'import Quartz',
      `point = Quartz.CGPointMake(${x}, ${y})`,
      'move = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, point, Quartz.kCGMouseButtonLeft)',
      'Quartz.CGEventPost(Quartz.kCGHIDEventTap, move)',
      `scroll = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, ${amount})`,
      'Quartz.CGEventPost(Quartz.kCGHIDEventTap, scroll)',
    ].join('\n');

    await execFileAsync('python3', ['-c', pyScript]);
    logger.debug({ x, y, amount }, 'Scroll performed');
  } catch (err) {
    logger.error({ err, x, y, amount }, 'Scroll failed');
    throw new Error(`Scroll failed: ${(err as Error).message}`);
  }
}

/**
 * Double-click at the given coordinates.
 */
export async function doubleClick(x: number, y: number): Promise<void> {
  try {
    const pyScript = [
      'import Quartz, time',
      `point = Quartz.CGPointMake(${x}, ${y})`,
      'for _ in range(2):',
      '    down = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, point, Quartz.kCGMouseButtonLeft)',
      '    up = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, point, Quartz.kCGMouseButtonLeft)',
      '    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)',
      '    time.sleep(0.05)',
      '    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)',
      '    time.sleep(0.05)',
    ].join('\n');

    await execFileAsync('python3', ['-c', pyScript]);
    logger.debug({ x, y }, 'Double-click performed');
  } catch (err) {
    logger.error({ err, x, y }, 'Double-click failed');
    throw new Error(`Double-click failed: ${(err as Error).message}`);
  }
}
