import { execSync } from 'child_process';

export class ProactiveEngine {
  private enabled = true;
  private interval: NodeJS.Timeout | null = null;
  private alerts: string[] = [];

  start() { this.interval = setInterval(() => this.monitor(), 5 * 60 * 1000); }
  stop() { if (this.interval) clearInterval(this.interval); }
  toggle(on?: boolean) { this.enabled = on ?? !this.enabled; return this.enabled; }

  getAlerts(): string[] { const a = [...this.alerts]; this.alerts = []; return a; }

  private monitor() {
    if (!this.enabled) return;
    try {
      const df = execSync("df -h / | tail -1", { encoding: 'utf-8' });
      const usePct = parseInt(df.match(/(\d+)%/)?.[1] || '0');
      if (usePct > 90) this.alerts.push(`⚠️ Disk usage at ${usePct}%`);
    } catch {}
  }
}
