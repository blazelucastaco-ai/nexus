import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('AppManager');

async function osascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script]);
  return stdout.trim();
}

async function runJXA(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script]);
  return stdout.trim();
}

export class AppManager {
  /**
   * Get all currently running (visible) applications.
   */
  async getRunningApps(): Promise<Array<{ name: string; pid: number; bundleId: string }>> {
    try {
      const script = `
        const se = Application('System Events');
        const procs = se.processes.whose({backgroundOnly: false});
        const result = [];
        for (let i = 0; i < procs.length; i++) {
          try {
            result.push({
              name: procs[i].name(),
              pid: procs[i].unixId(),
              bundleId: procs[i].bundleIdentifier() || ''
            });
          } catch(e) {}
        }
        JSON.stringify(result);
      `;
      const result = await runJXA(script);
      const apps = JSON.parse(result);
      logger.debug({ count: apps.length }, 'Running apps retrieved');
      return apps;
    } catch (err) {
      logger.error({ err }, 'Failed to get running apps');
      throw new Error(`Failed to get running apps: ${(err as Error).message}`);
    }
  }

  /**
   * Open an application by name.
   */
  async openApp(name: string): Promise<void> {
    try {
      await execFileAsync('open', ['-a', name]);
      logger.info({ name }, 'App opened');
    } catch (err) {
      logger.error({ err, name }, 'Failed to open app');
      throw new Error(`Failed to open ${name}: ${(err as Error).message}`);
    }
  }

  /**
   * Quit an application.
   * @param force - If true, force-quit the app (kill -9)
   */
  async quitApp(name: string, force?: boolean): Promise<void> {
    try {
      if (force) {
        // Force quit using pkill
        await execFileAsync('pkill', ['-9', '-f', name]).catch(() => {
          // pkill may fail if process already exited
        });
        logger.info({ name, force: true }, 'App force-quit');
      } else {
        const escaped = name.replace(/"/g, '\\"');
        await osascript(`tell application "${escaped}" to quit`);
        logger.info({ name }, 'App quit');
      }
    } catch (err) {
      logger.error({ err, name }, 'Failed to quit app');
      throw new Error(`Failed to quit ${name}: ${(err as Error).message}`);
    }
  }

  /**
   * Check whether an application is currently running.
   */
  async isAppRunning(name: string): Promise<boolean> {
    try {
      const escaped = name.replace(/"/g, '\\"');
      const result = await osascript(
        `tell application "System Events" to (name of processes) contains "${escaped}"`
      );
      return result === 'true';
    } catch (err) {
      logger.error({ err, name }, 'Failed to check if app is running');
      return false;
    }
  }

  /**
   * Get information about an installed application.
   */
  async getAppInfo(name: string): Promise<{ path: string; version: string }> {
    try {
      const escaped = name.replace(/"/g, '\\"');
      // Find the app bundle path
      const { stdout: pathOutput } = await execFileAsync('mdfind', [
        `kMDItemFSName == "${escaped}.app" && kMDItemKind == "Application"`,
      ]);
      const appPath = pathOutput.trim().split('\n')[0] || '';

      // Get version from the bundle's Info.plist
      let version = 'unknown';
      if (appPath) {
        try {
          const { stdout: versionOutput } = await execFileAsync('defaults', [
            'read',
            `${appPath}/Contents/Info`,
            'CFBundleShortVersionString',
          ]);
          version = versionOutput.trim();
        } catch {
          // Some apps may not have this key
        }
      }

      logger.debug({ name, path: appPath, version }, 'App info retrieved');
      return { path: appPath, version };
    } catch (err) {
      logger.error({ err, name }, 'Failed to get app info');
      throw new Error(`Failed to get info for ${name}: ${(err as Error).message}`);
    }
  }

  /**
   * Get the name of the frontmost application.
   */
  async getFrontmostApp(): Promise<string> {
    try {
      const result = await osascript(
        'tell application "System Events" to get name of first process whose frontmost is true'
      );
      logger.debug({ app: result }, 'Frontmost app retrieved');
      return result;
    } catch (err) {
      logger.error({ err }, 'Failed to get frontmost app');
      throw new Error(`Failed to get frontmost app: ${(err as Error).message}`);
    }
  }
}
