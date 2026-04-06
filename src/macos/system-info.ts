import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const logger = createLogger('SystemInfo');

export class SystemInfo {
  /**
   * Get current CPU usage as a percentage (0-100).
   */
  async getCPUUsage(): Promise<number> {
    try {
      const { stdout } = await execAsync(
        "ps -A -o %cpu | awk '{s+=$1} END {print s}'"
      );
      const usage = parseFloat(stdout.trim());
      logger.debug({ usage }, 'CPU usage retrieved');
      return Math.round(usage * 100) / 100;
    } catch (err) {
      logger.error({ err }, 'Failed to get CPU usage');
      throw new Error(`Failed to get CPU usage: ${(err as Error).message}`);
    }
  }

  /**
   * Get memory usage information in bytes.
   */
  async getMemoryUsage(): Promise<{
    total: number;
    used: number;
    free: number;
    percentUsed: number;
  }> {
    try {
      // Get total physical memory
      const { stdout: memTotal } = await execFileAsync('sysctl', ['-n', 'hw.memsize']);
      const total = parseInt(memTotal.trim(), 10);

      // Get page size and vm_stat
      const { stdout: pageInfo } = await execFileAsync('sysctl', ['-n', 'vm.pagesize']);
      const pageSize = parseInt(pageInfo.trim(), 10);

      const { stdout: vmStat } = await execFileAsync('vm_stat', []);
      const lines = vmStat.split('\n');

      let freePages = 0;
      let inactivePages = 0;

      for (const line of lines) {
        if (line.includes('Pages free')) {
          freePages = parseInt(line.split(':')[1].trim().replace('.', ''), 10);
        } else if (line.includes('Pages inactive')) {
          inactivePages = parseInt(line.split(':')[1].trim().replace('.', ''), 10);
        }
      }

      const free = (freePages + inactivePages) * pageSize;
      const used = total - free;
      const percentUsed = Math.round((used / total) * 10000) / 100;

      logger.debug({ total, used, free, percentUsed }, 'Memory usage retrieved');
      return { total, used, free, percentUsed };
    } catch (err) {
      logger.error({ err }, 'Failed to get memory usage');
      throw new Error(`Failed to get memory usage: ${(err as Error).message}`);
    }
  }

  /**
   * Get disk usage for the root volume.
   */
  async getDiskUsage(): Promise<{
    total: number;
    used: number;
    free: number;
    percentUsed: number;
  }> {
    try {
      const { stdout } = await execAsync("df -k / | tail -1");
      const parts = stdout.trim().split(/\s+/);
      // df -k output: Filesystem 1K-blocks Used Available Use% Mounted
      const totalKB = parseInt(parts[1], 10);
      const usedKB = parseInt(parts[2], 10);
      const freeKB = parseInt(parts[3], 10);

      const total = totalKB * 1024;
      const used = usedKB * 1024;
      const free = freeKB * 1024;
      const percentUsed = Math.round((used / total) * 10000) / 100;

      logger.debug({ total, used, free, percentUsed }, 'Disk usage retrieved');
      return { total, used, free, percentUsed };
    } catch (err) {
      logger.error({ err }, 'Failed to get disk usage');
      throw new Error(`Failed to get disk usage: ${(err as Error).message}`);
    }
  }

  /**
   * Get battery information, or null if no battery is present.
   */
  async getBatteryInfo(): Promise<{
    level: number;
    charging: boolean;
    timeRemaining: string;
  } | null> {
    try {
      const { stdout } = await execFileAsync('pmset', ['-g', 'batt']);
      const lines = stdout.trim();

      if (!lines.includes('InternalBattery')) {
        logger.debug('No battery detected');
        return null;
      }

      // Parse: " -InternalBattery-0 (id=...)	85%; charging; 1:23 remaining"
      const match = lines.match(/(\d+)%;\s*([\w\s]+?);?\s*([\d:]+\s*remaining|not charging|[\w\s]*)/);

      if (!match) {
        logger.warn('Could not parse battery info');
        return null;
      }

      const level = parseInt(match[1], 10);
      const statusStr = match[2].trim().toLowerCase();
      const charging = statusStr.includes('charging') && !statusStr.includes('not charging');
      const timeRemaining = match[3]?.trim() || (level === 100 ? 'fully charged' : 'calculating');

      logger.debug({ level, charging, timeRemaining }, 'Battery info retrieved');
      return { level, charging, timeRemaining };
    } catch (err) {
      logger.error({ err }, 'Failed to get battery info');
      throw new Error(`Failed to get battery info: ${(err as Error).message}`);
    }
  }

  /**
   * Get system uptime as a human-readable string.
   */
  async getUptime(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('uptime', []);
      // Extract the uptime portion: "up 5 days, 3:42"
      const match = stdout.match(/up\s+(.+?),\s+\d+\s+user/);
      const uptime = match?.[1]?.trim() ?? stdout.trim();
      logger.debug({ uptime }, 'Uptime retrieved');
      return uptime;
    } catch (err) {
      logger.error({ err }, 'Failed to get uptime');
      throw new Error(`Failed to get uptime: ${(err as Error).message}`);
    }
  }

  /**
   * Get active network interface information.
   */
  async getNetworkInfo(): Promise<Array<{ interface: string; ip: string }>> {
    try {
      const { stdout } = await execAsync(
        "ifconfig | awk '/^[a-z]/ {iface=$1} /inet / && !/127.0.0.1/ {print iface, $2}'"
      );

      const interfaces = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [iface, ip] = line.split(/\s+/);
          return {
            interface: iface.replace(':', ''),
            ip: ip || '',
          };
        });

      logger.debug({ count: interfaces.length }, 'Network info retrieved');
      return interfaces;
    } catch (err) {
      logger.error({ err }, 'Failed to get network info');
      throw new Error(`Failed to get network info: ${(err as Error).message}`);
    }
  }

  /**
   * Get a formatted summary of all system information.
   */
  async getSystemOverview(): Promise<string> {
    const sections: string[] = ['=== Nexus System Overview ===', ''];

    try {
      const [cpu, memory, disk, battery, uptime, network] = await Promise.allSettled([
        this.getCPUUsage(),
        this.getMemoryUsage(),
        this.getDiskUsage(),
        this.getBatteryInfo(),
        this.getUptime(),
        this.getNetworkInfo(),
      ]);

      // CPU
      if (cpu.status === 'fulfilled') {
        sections.push(`CPU Usage: ${cpu.value}%`);
      }

      // Memory
      if (memory.status === 'fulfilled') {
        const m = memory.value;
        const totalGB = (m.total / 1073741824).toFixed(1);
        const usedGB = (m.used / 1073741824).toFixed(1);
        const freeGB = (m.free / 1073741824).toFixed(1);
        sections.push(`Memory: ${usedGB} GB / ${totalGB} GB (${m.percentUsed}% used, ${freeGB} GB free)`);
      }

      // Disk
      if (disk.status === 'fulfilled') {
        const d = disk.value;
        const totalGB = (d.total / 1073741824).toFixed(1);
        const usedGB = (d.used / 1073741824).toFixed(1);
        const freeGB = (d.free / 1073741824).toFixed(1);
        sections.push(`Disk: ${usedGB} GB / ${totalGB} GB (${d.percentUsed}% used, ${freeGB} GB free)`);
      }

      // Battery
      if (battery.status === 'fulfilled' && battery.value) {
        const b = battery.value;
        sections.push(`Battery: ${b.level}% ${b.charging ? '(charging)' : '(discharging)'} — ${b.timeRemaining}`);
      }

      // Uptime
      if (uptime.status === 'fulfilled') {
        sections.push(`Uptime: ${uptime.value}`);
      }

      // Network
      if (network.status === 'fulfilled' && network.value.length > 0) {
        sections.push('');
        sections.push('Network Interfaces:');
        for (const iface of network.value) {
          sections.push(`  ${iface.interface}: ${iface.ip}`);
        }
      }

      logger.debug('System overview generated');
      return sections.join('\n');
    } catch (err) {
      logger.error({ err }, 'Failed to generate system overview');
      throw new Error(`Failed to generate system overview: ${(err as Error).message}`);
    }
  }
}
