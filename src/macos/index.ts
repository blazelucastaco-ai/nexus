import { createLogger } from '../utils/logger.js';
import { captureScreen, captureRegion, captureWindow } from './screenshots.js';
import { moveMouse, click, typeText, keyPress, type Modifier } from './input.js';
import {
  getFrontmostApp,
  getWindowList,
  getMenuItems,
  activateApp,
  isAccessibilityEnabled,
  type WindowInfo,
} from './accessibility.js';
import {
  runAppleScript,
  runJxa,
  openApp,
  quitApp,
  getClipboard,
  setClipboard,
  showNotification,
  showDialog,
} from './applescript.js';

const logger = createLogger('MacOSController');

/**
 * MacOSController — unified interface to all macOS automation capabilities.
 *
 * Combines screenshot capture, mouse/keyboard input, accessibility queries,
 * and AppleScript/JXA execution into a single controller.
 */
export class MacOSController {
  // ─── Screenshots ──────────────────────────────────────────────────

  /** Capture the full screen. Returns file path. */
  async screenshot(outputPath?: string): Promise<string> {
    return captureScreen(outputPath);
  }

  /** Capture a rectangular region. Returns file path. */
  async captureRegion(
    x: number,
    y: number,
    w: number,
    h: number,
    outputPath?: string,
  ): Promise<string> {
    return captureRegion(x, y, w, h, outputPath);
  }

  /** Capture the frontmost window. Returns file path. */
  async captureWindow(outputPath?: string): Promise<string> {
    return captureWindow(outputPath);
  }

  // ─── Input ────────────────────────────────────────────────────────

  /** Move the mouse cursor to absolute coordinates. */
  async moveMouse(x: number, y: number): Promise<void> {
    return moveMouse(x, y);
  }

  /** Click at absolute screen coordinates. */
  async click(x: number, y: number): Promise<void> {
    return click(x, y);
  }

  /** Type a string of text. Uses keystroke for short text, clipboard paste for long text. */
  async typeText(text: string): Promise<void> {
    return typeText(text);
  }

  /** Press a key with optional modifiers. */
  async keyPress(key: string, modifiers?: Modifier[]): Promise<void> {
    return keyPress(key, modifiers);
  }

  // ─── Accessibility ────────────────────────────────────────────────

  /** Get the name of the currently active application. */
  async getFrontmostApp(): Promise<string> {
    return getFrontmostApp();
  }

  /** List all visible windows with name, app, and bounds. */
  async getWindowList(): Promise<WindowInfo[]> {
    return getWindowList();
  }

  /** Get top-level menu bar items for an application. */
  async getMenuItems(app: string): Promise<string[]> {
    return getMenuItems(app);
  }

  /** Bring an application to the front. */
  async activateApp(name: string): Promise<void> {
    return activateApp(name);
  }

  /** Check if this process has Accessibility permissions. */
  async isAccessibilityEnabled(): Promise<boolean> {
    return isAccessibilityEnabled();
  }

  // ─── AppleScript / JXA ────────────────────────────────────────────

  /** Execute arbitrary AppleScript. */
  async run(script: string): Promise<string> {
    return runAppleScript(script);
  }

  /** Execute arbitrary JXA (JavaScript for Automation). */
  async runJxa(script: string): Promise<string> {
    return runJxa(script);
  }

  /** Launch an app by name. */
  async openApp(appName: string): Promise<void> {
    return openApp(appName);
  }

  /** Quit an app by name. */
  async quitApp(appName: string): Promise<void> {
    return quitApp(appName);
  }

  /** Show a macOS notification. */
  async notify(
    title: string,
    message: string,
    subtitle?: string,
    sound?: string,
  ): Promise<void> {
    return showNotification(title, message, subtitle, sound);
  }

  /** Show a dialog and return the button pressed. */
  async dialog(
    message: string,
    buttons?: string[],
    defaultButton?: string | number,
    title?: string,
  ): Promise<string> {
    return showDialog(message, buttons, defaultButton, title);
  }

  /** Get current clipboard text. */
  async getClipboard(): Promise<string> {
    return getClipboard();
  }

  /** Set clipboard to text. */
  async setClipboard(text: string): Promise<void> {
    return setClipboard(text);
  }

  // ─── Diagnostics ──────────────────────────────────────────────────

  /** Run a quick self-check of macOS automation capabilities. */
  async diagnostics(): Promise<{
    accessibility: boolean;
    frontmostApp: string | null;
    windowCount: number;
    clipboard: boolean;
  }> {
    const accessibility = await this.isAccessibilityEnabled().catch(() => false);

    let frontmostApp: string | null = null;
    try {
      frontmostApp = await this.getFrontmostApp();
    } catch {
      // noop
    }

    let windowCount = 0;
    try {
      const windows = await this.getWindowList();
      windowCount = windows.length;
    } catch {
      // noop
    }

    let clipboard = false;
    try {
      await this.getClipboard();
      clipboard = true;
    } catch {
      // noop
    }

    const result = { accessibility, frontmostApp, windowCount, clipboard };
    logger.info(result, 'MacOS diagnostics complete');
    return result;
  }
}

// Re-export everything for direct function-level imports
export {
  captureScreen,
  captureRegion,
  captureWindow,
  moveMouse,
  click,
  typeText,
  keyPress,
  getFrontmostApp,
  getWindowList,
  getMenuItems,
  activateApp,
  isAccessibilityEnabled,
  runAppleScript,
  runJxa,
  openApp,
  quitApp,
  getClipboard,
  setClipboard,
  showNotification,
  showDialog,
};
export type { Modifier, WindowInfo };
