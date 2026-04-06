import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { nowISO } from '../utils/helpers.js';

const execFileAsync = promisify(execFile);

export class SystemAgent extends BaseAgent {
  constructor() {
    super('system', 'Reports system information — CPU, memory, disk, network, processes, and installed apps', [
      { name: 'system_info', description: 'Get comprehensive system information' },
      { name: 'disk_space', description: 'Show disk space usage' },
      { name: 'memory_usage', description: 'Show current memory usage' },
      { name: 'cpu_usage', description: 'Show CPU usage and load averages' },
      { name: 'list_processes', description: 'List top processes by CPU or memory' },
      { name: 'installed_apps', description: 'List installed macOS applications' },
      { name: 'network_info', description: 'Show network interfaces and connectivity' },
    ]);
  }

  async execute(action: string, params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    this.log.info({ action, params }, 'SystemAgent executing');

    try {
      switch (action) {
        case 'system_info':
          return await this.systemInfo(start);
        case 'disk_space':
          return await this.diskSpace(start);
        case 'memory_usage':
          return await this.memoryUsage(start);
        case 'cpu_usage':
          return await this.cpuUsage(start);
        case 'list_processes':
          return await this.listProcesses(params, start);
        case 'installed_apps':
          return await this.installedApps(start);
        case 'network_info':
          return await this.networkInfo(start);
        default:
          return this.createResult(false, null, `Unknown action: ${action}`, start);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ action, error: msg }, 'SystemAgent failed');
      return this.createResult(false, null, msg, start);
    }
  }

  private async systemInfo(start: number): Promise<AgentResult> {
    const [swVers, uname] = await Promise.all([
      execFileAsync('sw_vers', [], { timeout: 5_000 }).catch(() => ({ stdout: '' })),
      execFileAsync('uname', ['-a'], { timeout: 5_000 }).catch(() => ({ stdout: '' })),
    ]);

    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    // Parse sw_vers output
    const swVersLines = swVers.stdout.trim().split('\n');
    const swVersData: Record<string, string> = {};
    for (const line of swVersLines) {
      const [key, value] = line.split(':').map((s) => s.trim());
      if (key && value) swVersData[key] = value;
    }

    return this.createResult(
      true,
      {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        osRelease: os.release(),
        macOS: swVersData,
        kernel: uname.stdout.trim(),
        cpuModel: cpus[0]?.model ?? 'Unknown',
        cpuCores: cpus.length,
        totalMemoryGB: (totalMem / (1024 ** 3)).toFixed(2),
        freeMemoryGB: (freeMem / (1024 ** 3)).toFixed(2),
        usedMemoryGB: ((totalMem - freeMem) / (1024 ** 3)).toFixed(2),
        uptime: os.uptime(),
        uptimeHours: (os.uptime() / 3600).toFixed(1),
        loadAverage: os.loadavg(),
        homeDir: os.homedir(),
        tempDir: os.tmpdir(),
        checkedAt: nowISO(),
      },
      undefined,
      start,
    );
  }

  private async diskSpace(start: number): Promise<AgentResult> {
    const { stdout } = await execFileAsync('df', ['-h'], { timeout: 5_000 });

    const lines = stdout.trim().split('\n');
    const header = lines[0];
    const disks = lines.slice(1).map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        filesystem: parts[0],
        size: parts[1],
        used: parts[2],
        available: parts[3],
        usedPercent: parts[4],
        mountedOn: parts.slice(5).join(' '),
      };
    });

    return this.createResult(true, { header, disks }, undefined, start);
  }

  private async memoryUsage(start: number): Promise<AgentResult> {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Get more detailed memory info via vm_stat
    const { stdout: vmStat } = await execFileAsync('vm_stat', [], { timeout: 5_000 });

    const pageSize = 16384; // Default on Apple Silicon, 4096 on Intel
    const vmData: Record<string, number> = {};
    for (const line of vmStat.split('\n')) {
      const match = line.match(/^(.+?):\s+(\d+)/);
      if (match) {
        vmData[match[1].trim()] = parseInt(match[2], 10) * pageSize;
      }
    }

    return this.createResult(
      true,
      {
        totalGB: (totalMem / (1024 ** 3)).toFixed(2),
        usedGB: (usedMem / (1024 ** 3)).toFixed(2),
        freeGB: (freeMem / (1024 ** 3)).toFixed(2),
        usedPercent: ((usedMem / totalMem) * 100).toFixed(1),
        vmStats: vmData,
        checkedAt: nowISO(),
      },
      undefined,
      start,
    );
  }

  private async cpuUsage(start: number): Promise<AgentResult> {
    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    // Get CPU usage via top (single sample)
    const { stdout } = await execFileAsync('/bin/zsh', ['-c', 'top -l 1 -n 0 | head -12'], {
      timeout: 10_000,
    });

    const cpuLine = stdout.split('\n').find((l) => l.includes('CPU usage'));
    let cpuParsed: Record<string, string> = {};
    if (cpuLine) {
      const matches = cpuLine.match(/([\d.]+)%\s+(\w+)/g);
      if (matches) {
        for (const m of matches) {
          const [pct, label] = m.split('%');
          cpuParsed[label.trim()] = `${pct}%`;
        }
      }
    }

    return this.createResult(
      true,
      {
        model: cpus[0]?.model ?? 'Unknown',
        cores: cpus.length,
        loadAverage: {
          '1min': loadAvg[0].toFixed(2),
          '5min': loadAvg[1].toFixed(2),
          '15min': loadAvg[2].toFixed(2),
        },
        topOutput: cpuParsed,
        speeds: cpus.map((c) => c.speed),
        checkedAt: nowISO(),
      },
      undefined,
      start,
    );
  }

  private async listProcesses(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const limit = Number(params.limit ?? 20);
    const sortBy = String(params.sortBy ?? 'cpu');

    const sortFlag = sortBy === 'memory' ? '-m' : '-r';
    const { stdout } = await execFileAsync(
      '/bin/zsh',
      ['-c', `ps aux ${sortFlag} | head -${limit + 1}`],
      { timeout: 5_000 },
    );

    const lines = stdout.trim().split('\n');
    const header = lines[0];
    const processes = lines.slice(1).map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        user: parts[0],
        pid: parseInt(parts[1], 10),
        cpu: parseFloat(parts[2]),
        memory: parseFloat(parts[3]),
        command: parts.slice(10).join(' '),
      };
    });

    return this.createResult(
      true,
      { sortBy, count: processes.length, header, processes },
      undefined,
      start,
    );
  }

  private async installedApps(start: number): Promise<AgentResult> {
    const { stdout } = await execFileAsync('ls', ['/Applications'], { timeout: 5_000 });

    const apps = stdout
      .trim()
      .split('\n')
      .filter((name) => name.endsWith('.app'))
      .map((name) => name.replace('.app', ''))
      .sort();

    return this.createResult(
      true,
      { count: apps.length, apps, checkedAt: nowISO() },
      undefined,
      start,
    );
  }

  private async networkInfo(start: number): Promise<AgentResult> {
    const [ifconfig, scutil] = await Promise.all([
      execFileAsync('/bin/zsh', ['-c', 'ifconfig | grep -E "^[a-z]|inet "'], { timeout: 5_000 }).catch(() => ({
        stdout: '',
      })),
      execFileAsync('scutil', ['--dns'], { timeout: 5_000 }).catch(() => ({ stdout: '' })),
    ]);

    // Parse interfaces
    const interfaces: Array<{ name: string; addresses: string[] }> = [];
    let currentIface: { name: string; addresses: string[] } | null = null;

    for (const line of ifconfig.stdout.split('\n')) {
      const ifaceMatch = line.match(/^(\w+):/);
      if (ifaceMatch) {
        if (currentIface) interfaces.push(currentIface);
        currentIface = { name: ifaceMatch[1], addresses: [] };
      } else if (currentIface) {
        const addrMatch = line.match(/inet\s+([\d.]+)/);
        if (addrMatch) currentIface.addresses.push(addrMatch[1]);
      }
    }
    if (currentIface) interfaces.push(currentIface);

    // Get external IP
    let externalIp = 'unknown';
    try {
      const resp = await fetch('https://api.ipify.org?format=json', {
        signal: AbortSignal.timeout(5_000),
      });
      const json = (await resp.json()) as { ip: string };
      externalIp = json.ip;
    } catch {
      // ignore
    }

    // Extract DNS servers
    const dnsServers: string[] = [];
    for (const line of scutil.stdout.split('\n')) {
      const dnsMatch = line.match(/nameserver\[\d+\]\s*:\s*([\d.]+)/);
      if (dnsMatch && !dnsServers.includes(dnsMatch[1])) {
        dnsServers.push(dnsMatch[1]);
      }
    }

    return this.createResult(
      true,
      {
        interfaces: interfaces.filter((i) => i.addresses.length > 0),
        externalIp,
        dnsServers,
        checkedAt: nowISO(),
      },
      undefined,
      start,
    );
  }
}
