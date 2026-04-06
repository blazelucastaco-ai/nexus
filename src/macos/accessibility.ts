import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('MacAccessibility');

/**
 * Run an AppleScript and return trimmed stdout.
 */
async function osascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script]);
  return stdout.trim();
}

/**
 * Run a JXA (JavaScript for Automation) script and return trimmed stdout.
 */
async function jxa(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script]);
  return stdout.trim();
}

/**
 * Escape a string for safe embedding in AppleScript double-quoted strings.
 */
function escapeAS(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Get the name of the frontmost (active) application.
 * @returns The application name string (e.g. "Safari", "Terminal")
 */
export async function getFrontmostApp(): Promise<string> {
  try {
    const name = await osascript(
      'tell application "System Events" to get name of first application process whose frontmost is true',
    );
    logger.debug({ app: name }, 'Got frontmost app');
    return name;
  } catch (err) {
    logger.error({ err }, 'Failed to get frontmost app');
    throw new Error(`getFrontmostApp failed: ${(err as Error).message}`);
  }
}

export interface WindowInfo {
  name: string;
  app: string;
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * List all visible on-screen windows across all applications.
 * Uses CoreGraphics via JXA to enumerate windows.
 * @returns Array of window info objects with name, owning app, and bounds
 */
export async function getWindowList(): Promise<WindowInfo[]> {
  try {
    const script = `
      ObjC.import('CoreGraphics');
      const list = $.CGWindowListCopyWindowInfo(
        $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
        $.kCGNullWindowID
      );
      const count = ObjC.unwrap($.CFArrayGetCount(list));
      const result = [];
      for (let i = 0; i < count; i++) {
        const info = ObjC.unwrap($.CFArrayGetValueAtIndex(list, i));
        const layer = ObjC.unwrap(info['kCGWindowLayer']);
        if (layer !== 0) continue;
        const owner = ObjC.unwrap(info['kCGWindowOwnerName']) || '';
        const name = ObjC.unwrap(info['kCGWindowName']) || '';
        const bounds = ObjC.unwrap(info['kCGWindowBounds']);
        if (!bounds) continue;
        result.push({
          name: name,
          app: owner,
          bounds: {
            x: ObjC.unwrap(bounds['X']) || 0,
            y: ObjC.unwrap(bounds['Y']) || 0,
            width: ObjC.unwrap(bounds['Width']) || 0,
            height: ObjC.unwrap(bounds['Height']) || 0,
          }
        });
      }
      JSON.stringify(result);
    `;

    const raw = await jxa(script);
    const windows: WindowInfo[] = JSON.parse(raw);
    logger.debug({ count: windows.length }, 'Got window list');
    return windows;
  } catch (err) {
    logger.error({ err }, 'Failed to get window list');
    throw new Error(`getWindowList failed: ${(err as Error).message}`);
  }
}

/**
 * Get the menu bar items for a given application.
 * Requires Accessibility permissions.
 * @param app - Application name (e.g. "Finder", "Safari")
 * @returns Array of top-level menu item names
 */
export async function getMenuItems(app: string): Promise<string[]> {
  try {
    const escaped = escapeAS(app);
    const script = `
      tell application "System Events"
        tell process "${escaped}"
          set menuNames to {}
          repeat with m in menu bar items of menu bar 1
            set end of menuNames to name of m
          end repeat
          return menuNames
        end tell
      end tell
    `;

    const raw = await osascript(script);
    // AppleScript returns comma-separated list
    const items = raw.split(', ').map((s) => s.trim()).filter(Boolean);
    logger.debug({ app, count: items.length }, 'Got menu items');
    return items;
  } catch (err) {
    logger.error({ err, app }, 'Failed to get menu items');
    throw new Error(`getMenuItems failed: ${(err as Error).message}`);
  }
}

/**
 * Activate (bring to front) an application by name.
 * @param name - Application name (e.g. "Safari", "Terminal")
 */
export async function activateApp(name: string): Promise<void> {
  try {
    const escaped = escapeAS(name);
    await osascript(`tell application "${escaped}" to activate`);
    logger.debug({ app: name }, 'App activated');
  } catch (err) {
    logger.error({ err, app: name }, 'Failed to activate app');
    throw new Error(`activateApp failed: ${(err as Error).message}`);
  }
}

/**
 * Check whether Accessibility permissions are granted for this process.
 * Uses the AXIsProcessTrusted() API via JXA.
 * @returns true if trusted, false otherwise
 */
export async function isAccessibilityEnabled(): Promise<boolean> {
  try {
    const script = `
      ObjC.import('ApplicationServices');
      $.AXIsProcessTrusted();
    `;
    const result = await jxa(script);
    return result === 'true' || result === '1';
  } catch {
    logger.warn('Could not check accessibility status');
    return false;
  }
}

/**
 * Get detailed info about the active application: name, bundle ID, and PID.
 */
export async function getActiveAppInfo(): Promise<{ name: string; bundleId: string; pid: number }> {
  try {
    const script = `
      const se = Application('System Events');
      const procs = se.processes.whose({frontmost: true});
      const proc = procs[0];
      JSON.stringify({
        name: proc.name(),
        bundleId: proc.bundleIdentifier(),
        pid: proc.unixId()
      });
    `;
    const result = await jxa(script);
    const parsed = JSON.parse(result);
    logger.debug({ app: parsed.name }, 'Active app info retrieved');
    return parsed;
  } catch (err) {
    logger.error({ err }, 'Failed to get active app info');
    throw new Error(`getActiveAppInfo failed: ${(err as Error).message}`);
  }
}

/**
 * Get the UI element tree for a given application (up to depth 3, max 20 children per level).
 * Useful for finding clickable elements, text fields, buttons, etc.
 * @param appName - The application process name
 */
export async function getUIElements(appName: string): Promise<unknown[]> {
  try {
    const escaped = appName.replace(/'/g, "\\'");
    const script = `
      const se = Application('System Events');
      const proc = se.processes.byName('${escaped}');

      function describeElement(el, depth) {
        if (depth > 3) return null;
        const info = {};
        try { info.role = el.role(); } catch(e) {}
        try { info.title = el.title(); } catch(e) {}
        try { info.value = String(el.value()).substring(0, 200); } catch(e) {}
        try { info.description = el.description(); } catch(e) {}
        try {
          const pos = el.position();
          const sz = el.size();
          info.bounds = {x: pos[0], y: pos[1], width: sz[0], height: sz[1]};
        } catch(e) {}
        try {
          const kids = el.uiElements();
          if (kids.length > 0) {
            info.children = kids.slice(0, 20).map(k => describeElement(k, depth + 1)).filter(Boolean);
          }
        } catch(e) {}
        return info;
      }

      const windows = proc.windows();
      const result = windows.slice(0, 5).map(w => describeElement(w, 0));
      JSON.stringify(result);
    `;
    const result = await jxa(script);
    const elements = JSON.parse(result);
    logger.debug({ appName, count: elements.length }, 'UI elements retrieved');
    return elements;
  } catch (err) {
    logger.error({ err, appName }, 'Failed to get UI elements');
    throw new Error(`getUIElements failed for ${appName}: ${(err as Error).message}`);
  }
}
