import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type {
  DashboardState,
  MainTab,
  LogEntry,
  UpdateProgress,
  MemoryEntry,
  AboutInfo,
  ChromeStatus,
} from '../shared/types';
import {
  IconDashboard, IconConfig, IconLogs, IconChrome, IconUpdate, IconMemory, IconAbout,
  IconHub, IconFriends, IconFeed,
  IconNexusLogo, IconEmptyMemory, IconExternal,
} from './icons';

const TABS: Array<{ key: MainTab; label: string; Icon: () => JSX.Element }> = [
  { key: 'dashboard', label: 'Dashboard', Icon: IconDashboard },
  { key: 'hub',       label: 'Hub',       Icon: IconHub },
  { key: 'friends',   label: 'Friends',   Icon: IconFriends },
  { key: 'feed',      label: 'Feed',      Icon: IconFeed },
  { key: 'config',    label: 'Configure', Icon: IconConfig },
  { key: 'logs',      label: 'Logs',      Icon: IconLogs },
  { key: 'chrome',    label: 'Chrome',    Icon: IconChrome },
  { key: 'updates',   label: 'Updates',   Icon: IconUpdate },
  { key: 'memory',    label: 'Memory',    Icon: IconMemory },
  { key: 'about',     label: 'About',     Icon: IconAbout },
];

export function MainApp(): JSX.Element {
  const [tab, setTab] = useState<MainTab>('dashboard');
  const [updateInfo, setUpdateInfo] = useState<{ available: boolean; latest?: string; installed?: string; releasePageUrl?: string; downloadUrl?: string }>({ available: false });

  // Update-check on mount, then hourly. The banner appears the moment a
  // newer release is published on GitHub — user doesn't have to open the
  // Updates tab to notice.
  useEffect(() => {
    const check = async (): Promise<void> => {
      try {
        const r = await window.nexus.main.updatesCheck() as {
          updateAvailable?: boolean; installedVersion?: string; latestVersion?: string;
          releasePageUrl?: string; downloadUrl?: string;
        };
        setUpdateInfo({
          available: r.updateAvailable === true,
          latest: r.latestVersion,
          installed: r.installedVersion,
          releasePageUrl: r.releasePageUrl,
          downloadUrl: r.downloadUrl,
        });
      } catch { /* offline — silently skip */ }
    };
    void check();
    const id = setInterval(() => void check(), 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const openDownload = async (): Promise<void> => {
    await window.nexus.main.updatesRun();
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-dot" />
          <span className="brand-name">NEXUS</span>
        </div>
        <div className="step-list">
          {TABS.map((t) => (
            <button
              type="button"
              key={t.key}
              className={`nav-item ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <div className="nav-icon"><t.Icon /></div>
              <span>{t.label}</span>
              {t.key === 'updates' && updateInfo.available && (
                <span className="nav-badge" title={`NEXUS v${updateInfo.latest} available`}>●</span>
              )}
            </button>
          ))}
        </div>
        <div className="sidebar-footer">v{updateInfo.installed ?? '0.1.0'}</div>
      </aside>
      <main className="main">
        {updateInfo.available && (
          <div style={{
            background: 'var(--p2)',
            borderBottom: '1px solid var(--tl)',
            padding: '10px 22px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontSize: 13,
          }}>
            <span style={{ color: 'var(--t)', fontWeight: 600 }}>NEXUS v{updateInfo.latest}</span>
            <span className="subtle">is out — you're on v{updateInfo.installed}.</span>
            <button
              type="button"
              className="btn-p"
              onClick={() => void openDownload()}
              style={{ marginLeft: 'auto', padding: '6px 14px', fontSize: 12 }}
            >
              Download
            </button>
            <button
              type="button"
              className="btn-g"
              onClick={() => setTab('updates')}
              style={{ padding: '6px 14px', fontSize: 12 }}
            >
              Details
            </button>
            <button
              type="button"
              className="btn-g"
              onClick={() => setUpdateInfo((u) => ({ ...u, available: false }))}
              style={{ padding: '4px 10px', fontSize: 14, border: 'none', background: 'transparent' }}
              aria-label="Dismiss"
              title="Dismiss for this session"
            >×</button>
          </div>
        )}
        {tab === 'dashboard' && <DashboardTab />}
        {tab === 'hub' && <HubTab />}
        {tab === 'friends' && <FriendsTab />}
        {tab === 'feed' && <FeedTab />}
        {tab === 'config' && <ConfigTab />}
        {tab === 'logs' && <LogsTab />}
        {tab === 'chrome' && <ChromeTab />}
        {tab === 'updates' && <UpdatesTab />}
        {tab === 'memory' && <MemoryTab />}
        {tab === 'about' && <AboutTab />}
      </main>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════════════════════ */
function DashboardTab(): JSX.Element {
  const [state, setState] = useState<DashboardState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [recent, setRecent] = useState<LogEntry[]>([]);
  const [actionRunning, setActionRunning] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const runAction = async (kind: 'screenshot' | 'dream' | 'health'): Promise<void> => {
    setActionRunning(kind);
    setActionResult(null);
    try {
      const api = window.nexus.main;
      const r =
        kind === 'screenshot' ? await api.actionScreenshot()
        : kind === 'dream' ? await api.actionDream()
        : await api.actionHealth();
      setActionResult({ kind: r.ok ? 'ok' : 'err', text: r.output || (r.ok ? 'Done.' : 'Failed.') });
    } finally {
      setActionRunning(null);
    }
  };

  const refresh = useCallback(async (): Promise<void> => {
    const s = await window.nexus.main.dashboard();
    setState(s);
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  // Subscribe to the log tail so the dashboard shows the five most recent
  // meaningful NEXUS events — tasks, messages, tool calls, errors.
  useEffect(() => {
    const unsub = window.nexus.main.onLogLine((raw) => {
      const parsed = parseLogLine(raw);
      // Only surface events that feel meaningful on the dashboard: any
      // warn/error, or info lines from components users care about.
      const interesting =
        parsed.level >= 40 ||
        ['Orchestrator', 'TelegramGateway', 'ToolExecutor', 'Main', 'BrowserBridge', 'Cortex'].includes(parsed.component ?? '');
      if (!interesting) return;
      setRecent((r) => [parsed, ...r].slice(0, 8));
    });
    void window.nexus.main.logTailStart();
    return () => {
      unsub();
      void window.nexus.main.logTailStop();
    };
  }, []);

  const act = async (what: 'start' | 'stop' | 'restart'): Promise<void> => {
    setBusy(what);
    try {
      if (what === 'start') await window.nexus.service.start();
      if (what === 'stop') await window.nexus.service.stop();
      if (what === 'restart') await window.nexus.service.restart();
      // brief wait for the change to reflect
      await new Promise((r) => setTimeout(r, 1000));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="step">
      <span className="eyebrow">Status</span>
      <h1 className="step-title">
        {state?.service.running ? <>NEXUS is <em>running</em>.</> : <>NEXUS is <em>idle</em>.</>}
      </h1>
      <p className="step-lead">
        {state?.service.running
          ? state.uptimeSeconds
            ? `Up for ${formatUptime(state.uptimeSeconds)}${state.service.pid ? ` on pid ${state.service.pid}` : ''}.`
            : state.service.pid
              ? `Running on pid ${state.service.pid}.`
              : 'Running.'
          : state?.service.registered
            ? 'Service is registered but stopped. Start it from here or via the menu bar.'
            : 'NEXUS is not installed. Open the wizard from the Configure tab to set it up.'}
      </p>

      <div className="stat-grid">
        <StatCard label="Service" value={state?.service.running ? 'Running' : state?.service.registered ? 'Stopped' : 'Not installed'} tone={state?.service.running ? 'ok' : state?.service.registered ? 'idle' : 'alert'} />
        <StatCard label="Bridge" value={state?.service.bridgeConnected ? 'Connected' : 'Idle'} tone={state?.service.bridgeConnected ? 'ok' : 'idle'} />
        <StatCard label="Memories" value={state ? String(state.memoryCount) : '…'} />
        <StatCard label="Sessions" value={state ? String(state.sessionCount) : '…'} />
      </div>

      <div className="btn-row" style={{ marginTop: 28 }}>
        <button
          type="button"
          className="btn-p"
          onClick={() => void act('start')}
          disabled={busy !== null || state?.service.running || !state?.service.registered}
        >
          {busy === 'start' ? 'Starting…' : 'Start'}
        </button>
        <button
          type="button"
          className="btn-g"
          onClick={() => void act('stop')}
          disabled={busy !== null || !state?.service.running}
        >
          {busy === 'stop' ? 'Stopping…' : 'Stop'}
        </button>
        <button
          type="button"
          className="btn-g"
          onClick={() => void act('restart')}
          disabled={busy !== null || !state?.service.registered}
        >
          {busy === 'restart' ? 'Restarting…' : 'Restart'}
        </button>
        <button type="button" className="btn-g" onClick={() => void window.nexus.service.openLogs()}>
          Open log file
        </button>
      </div>

      {state?.lastMessageAt && (
        <p className="subtle" style={{ marginTop: 20 }}>
          Last Telegram message: <code>{state.lastMessageAt}</code>
        </p>
      )}

      <div className="section-divider" />

      <div className="section-head">
        <h2 className="section-title">Quick <em>actions</em></h2>
        <span className="section-note">run real nexus commands without leaving the app</span>
      </div>
      <div className="action-grid">
        <ActionTile
          icon="✈"
          title="Message on Telegram"
          subtitle="The one way to talk to NEXUS"
          onClick={() => void window.nexus.external.open('https://t.me')}
        />
        <ActionTile
          icon="📸"
          title="Take screenshot"
          subtitle="Saves to Desktop"
          onClick={() => void runAction('screenshot')}
          disabled={actionRunning !== null}
          busy={actionRunning === 'screenshot'}
        />
        <ActionTile
          icon="🌙"
          title="Trigger dream cycle"
          subtitle="Consolidate today's memories"
          onClick={() => void runAction('dream')}
          disabled={actionRunning !== null || !state?.service.running}
          busy={actionRunning === 'dream'}
        />
        <ActionTile
          icon="🩺"
          title="Run health check"
          subtitle="Full system diagnostics"
          onClick={() => void runAction('health')}
          disabled={actionRunning !== null}
          busy={actionRunning === 'health'}
        />
      </div>
      {actionResult && (
        <div className={`action-result action-result-${actionResult.kind}`}>
          <pre>{actionResult.text}</pre>
        </div>
      )}

      <div className="section-divider" />

      <div className="section-head">
        <h2 className="section-title">Recent <em>activity</em></h2>
        <span className="section-note">streaming from nexus.log</span>
      </div>
      <div className="activity-feed">
        {recent.length === 0 && (
          <div className="activity-empty">
            Waiting for NEXUS to do something…
          </div>
        )}
        {recent.map((l, i) => (
          <div key={`${l.ts}-${i}`} className={`activity-item activity-lvl-${l.level}`}>
            <div className="activity-ts">{formatTs(l.ts)}</div>
            <div className="activity-body">
              {l.component && <span className="activity-comp">{l.component}</span>}
              <span className="activity-msg">{l.msg}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="section-divider" />

      <div className="quick-links">
        <button type="button" className="quick-link" onClick={() => void window.nexus.external.open('https://t.me')}>
          <div className="quick-link-icon" style={{ color: 'var(--t)' }}>✈</div>
          <div>
            <div className="quick-link-title">Telegram</div>
            <div className="quick-link-sub">Chat with NEXUS<IconExternal /></div>
          </div>
        </button>
        <button type="button" className="quick-link" onClick={() => void window.nexus.external.open('https://github.com/blazelucastaco-ai/nexus')}>
          <div className="quick-link-icon" style={{ color: 'var(--t)' }}>◇</div>
          <div>
            <div className="quick-link-title">Source code</div>
            <div className="quick-link-sub">GitHub<IconExternal /></div>
          </div>
        </button>
        <button type="button" className="quick-link" onClick={() => void window.nexus.service.openLogs()}>
          <div className="quick-link-icon" style={{ color: 'var(--t)' }}>⊞</div>
          <div>
            <div className="quick-link-title">Log file</div>
            <div className="quick-link-sub">Open in Console.app</div>
          </div>
        </button>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'ok' | 'idle' | 'alert' | 'default' }): JSX.Element {
  return (
    <div className="stat-card">
      <div className={`stat-dot stat-${tone}`} />
      <div>
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
      </div>
    </div>
  );
}

function ActionTile({
  icon, title, subtitle, onClick, disabled, busy,
}: {
  icon: string;
  title: string;
  subtitle: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`action-tile ${busy ? 'busy' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <div className="action-tile-icon">{busy ? <span className="spinner-small" /> : icon}</div>
      <div>
        <div className="action-tile-title">{title}</div>
        <div className="action-tile-sub">{busy ? 'Running…' : subtitle}</div>
      </div>
    </button>
  );
}

function formatUptime(seconds?: number): string {
  if (!seconds) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/* ═══════════════════════════════════════════════════════════════════
   CONFIG (opens the wizard window for full reconfigure)
═══════════════════════════════════════════════════════════════════ */
function ConfigTab(): JSX.Element {
  const [detection, setDetection] = useState<import('../shared/types').DetectionResult | null>(null);

  useEffect(() => {
    void window.nexus.detect.existing().then(setDetection);
  }, []);

  return (
    <div className="step">
      <span className="eyebrow">Configure</span>
      <h1 className="step-title">Current <em>settings</em>.</h1>
      <p className="step-lead">
        Telegram bot, Anthropic API key, agents, and personality all live in{' '}
        <code>{detection?.configPath ?? '~/.nexus/config.json'}</code>. Open the
        wizard below to change anything.
      </p>

      <div className="kv-list" style={{ marginBottom: 24 }}>
        <KV
          k="Personality"
          v={detection?.existingPersonality?.preset
            ? detection.existingPersonality.preset.replace('_', ' ')
            : '—'}
        />
        <KV
          k="Agents"
          v={detection?.existingAgents
            ? `${detection.existingAgents.length} enabled (${detection.existingAgents.slice(0, 4).join(', ')}${detection.existingAgents.length > 4 ? '…' : ''})`
            : '—'}
        />
        <KV
          k="Anthropic key"
          v={detection?.existingAnthropicKey ? '•••••••••••••• configured' : 'not set'}
        />
        <KV
          k="Telegram token"
          v={detection?.existingTelegram?.botToken ? '•••••••••••••• configured' : 'not set'}
        />
        <KV
          k="Telegram chat"
          v={detection?.existingTelegram?.chatId ?? 'not set'}
        />
      </div>

      <div className="btn-row">
        <button
          type="button"
          className="btn-p"
          onClick={() => void window.nexus.main.openWizard()}
        >
          Change settings →
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   LOGS
═══════════════════════════════════════════════════════════════════ */
function LogsTab(): JSX.Element {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<'all' | 'warn' | 'error'>('all');
  const [query, setQuery] = useState('');
  const [paused, setPaused] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const unsub = window.nexus.main.onLogLine((raw) => {
      if (pausedRef.current) return;
      const parsed = parseLogLine(raw);
      setLines((prev) => [...prev.slice(-999), parsed]);
    });
    void window.nexus.main.logTailStart();
    return () => {
      unsub();
      void window.nexus.main.logTailStop();
    };
  }, []);

  const filtered = useMemo(() => {
    return lines.filter((l) => {
      if (filter === 'warn' && l.level < 40) return false;
      if (filter === 'error' && l.level < 50) return false;
      if (query && !l.msg.toLowerCase().includes(query.toLowerCase()) && !(l.component ?? '').toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [lines, filter, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: length is the autoscroll trigger
  useEffect(() => {
    if (!boxRef.current || paused) return;
    boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [filtered.length, paused]);

  return (
    <div className="step" style={{ maxWidth: '100%' }}>
      <span className="eyebrow">Logs</span>
      <h1 className="step-title">Live <em>tail</em>.</h1>
      <p className="step-lead">
        Streaming from <code>~/.nexus/nexus.log</code>. Pause, filter by level, or search by component name.
      </p>

      <div className="toolbar">
        <div className="seg">
          {(['all', 'warn', 'error'] as const).map((f) => (
            <button
              type="button"
              key={f}
              className={`seg-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <input
          type="text"
          className="field-input mono"
          style={{ flex: 1, padding: '8px 12px', fontSize: 12 }}
          placeholder="Filter by component or message…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className={`btn-g ${paused ? 'active' : ''}`}
          style={{ padding: '8px 18px' }}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button
          type="button"
          className="btn-g"
          style={{ padding: '8px 18px' }}
          onClick={() => setLines([])}
        >
          Clear
        </button>
      </div>

      <div className="dark-box" style={{ marginTop: 18 }}>
        <div className="dark-box-bar">
          <div className="dark-box-dot" />
          <span className="dark-box-label">{filtered.length} / {lines.length} lines</span>
        </div>
        <div
          className="dark-box-body"
          ref={boxRef}
          style={{ maxHeight: 'calc(100vh - 340px)' }}
        >
          {filtered.length === 0 && <span className="dim">No lines yet… waiting for NEXUS output.</span>}
          {filtered.map((l, i) => (
            // Sequence-based key (not Math.random — that broke React's reconciliation
            // and caused the whole log DOM to re-render on every new line).
            <div key={`${l.ts}-${i}`} className={`log-line log-lvl-${l.level}`}>
              <span className="log-ts">{formatTs(l.ts)}</span>{' '}
              {l.component && <span className="log-comp">{l.component}</span>}{' '}
              <span className="log-msg">{l.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Strip terminal control codes + NUL bytes from a string before rendering.
 * Log lines sometimes contain ANSI escapes (from spawned child processes
 * that logged to the NEXUS log file) which would render as garbage in a
 * <div>.
 */
function sanitizeLogText(s: string): string {
  return s
    .replace(/\x1b\[[?0-9;]*[a-zA-Z]/g, '') // CSI sequences
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // all control chars except \n, \t, \r
}

function parseLogLine(raw: string): LogEntry {
  const cleanRaw = sanitizeLogText(raw);
  try {
    const j = JSON.parse(cleanRaw) as { time?: string; level?: number; component?: string; msg?: string };
    return {
      ts: j.time ?? '',
      level: typeof j.level === 'number' ? j.level : 30,
      component: j.component,
      msg: sanitizeLogText(j.msg ?? cleanRaw),
      raw: cleanRaw,
    };
  } catch {
    return { ts: '', level: 30, msg: cleanRaw, raw: cleanRaw };
  }
}

function formatTs(ts: string): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return ts;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   CHROME
═══════════════════════════════════════════════════════════════════ */
function ChromeTab(): JSX.Element {
  const [status, setStatus] = useState<ChromeStatus | null>(null);
  const [extPath, setExtPath] = useState('');
  const [connected, setConnected] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void (async () => {
      const [s, p] = await Promise.all([
        window.nexus.chrome.check(),
        window.nexus.chrome.extensionPath(),
      ]);
      setStatus(s);
      setExtPath(p);
    })();
  }, []);

  const test = async (): Promise<void> => {
    setTesting(true);
    setConnected(await window.nexus.chrome.testConnection());
    setTesting(false);
  };

  return (
    <div className="step">
      <span className="eyebrow">Chrome extension</span>
      <h1 className="step-title">Browser <em>control</em>.</h1>
      <p className="step-lead">
        NEXUS drives {status?.appLabel ?? 'Chrome'} via a WebSocket bridge on port 9338.
        {status?.installed ? ' The extension lives at the path below.' : ' Chrome is not installed.'}
      </p>

      {status?.installed && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-row">
              <div className="card-icon">🌐</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3>Extension folder</h3>
                <code style={{ display: 'block', marginTop: 4, wordBreak: 'break-all' }}>{extPath}</code>
              </div>
            </div>
          </div>

          <div className="btn-row">
            <button
              type="button"
              className="btn-p"
              onClick={() => status.appLabel && void window.nexus.chrome.openExtensions(status.appLabel)}
            >
              Open chrome://extensions
            </button>
            <button type="button" className="btn-g" onClick={() => void test()} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {connected === true && <span style={{ color: '#5a8c54', alignSelf: 'center' }}>✓ Connected</span>}
            {connected === false && <span style={{ color: 'var(--t)', alignSelf: 'center' }}>Not reachable</span>}
          </div>
        </>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   UPDATES
═══════════════════════════════════════════════════════════════════ */
interface UpdateCheckView {
  installedVersion?: string;
  latestVersion?: string;
  downloadUrl?: string;
  releasePageUrl?: string;
  updateAvailable?: boolean;
  offline?: boolean;
  // Legacy shape still in flight.
  commitsBehind?: number;
  upToDate?: boolean;
}

function UpdatesTab(): JSX.Element {
  const [check, setCheck] = useState<UpdateCheckView | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      const c = await window.nexus.main.updatesCheck();
      setCheck(c as UpdateCheckView);
    } finally { setChecking(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    return window.nexus.main.onUpdateProgress((p) => setProgress(p));
  }, []);

  const download = async (): Promise<void> => {
    setProgress(null);
    await window.nexus.main.updatesRun();
    await refresh();
  };

  const installed = check?.installedVersion ?? '—';
  const latest = check?.latestVersion ?? '—';
  const available = check?.updateAvailable === true;

  return (
    <div className="step">
      <span className="eyebrow">Updates</span>
      <h1 className="step-title">
        {check === null
          ? <>Checking <em>GitHub</em>…</>
          : check.offline
            ? <>Couldn't <em>reach GitHub</em>.</>
            : available
              ? <>New <em>version</em> available.</>
              : <>You're <em>up to date</em>.</>}
      </h1>
      <p className="step-lead">
        {check === null && 'One moment — asking the releases API for the latest tag.'}
        {check?.offline && 'Check your internet connection or try again in a minute.'}
        {check && !check.offline && available && (
          <>NEXUS <strong>v{latest}</strong> is out. You're on <strong>v{installed}</strong>.</>
        )}
        {check && !check.offline && !available && (
          <>You're running <strong>v{installed}</strong> — the latest published release.</>
        )}
      </p>

      {available && (
        <div className="card" style={{ marginTop: 12, marginBottom: 16, borderColor: 'var(--tl)' }}>
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>How updating works</h4>
          <ol className="subtle" style={{ margin: '0 0 0 20px', padding: 0, fontSize: 13, lineHeight: 1.7 }}>
            <li>Click <strong>Download update</strong> below — a browser tab opens with the new <code>NEXUS-Installer.dmg</code>.</li>
            <li>When it finishes, open the DMG and drag the new NEXUS app over the one in your <code>Applications</code> folder. Replace when prompted.</li>
            <li>Relaunch from Applications. Your account, memory, and settings all carry over.</li>
          </ol>
        </div>
      )}

      {progress && progress.phase !== 'up-to-date' && (
        <p className="subtle" style={{ margin: '10px 0', fontSize: 13 }}>{progress.label}</p>
      )}

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn-p"
          onClick={() => void download()}
          disabled={!available || checking}
        >
          {checking ? 'Checking…' : available ? `Download update (v${latest})` : 'Up to date'}
        </button>
        {available && check?.releasePageUrl && (
          <button type="button" className="btn-g" onClick={() => window.nexus.external.open(check.releasePageUrl!)}>
            Read release notes ↗
          </button>
        )}
        <button type="button" className="btn-g" style={{ marginLeft: 'auto' }} onClick={() => void refresh()} disabled={checking}>
          {checking ? 'Re-checking…' : 'Re-check'}
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MEMORY (read-only browser)
═══════════════════════════════════════════════════════════════════ */
function MemoryTab(): JSX.Element {
  const [memories, setMemories] = useState<MemoryEntry[] | null>(null);
  const [type, setType] = useState<'all' | 'episodic' | 'semantic' | 'procedural'>('all');
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const m = await window.nexus.main.memories({ limit: 200, type: type === 'all' ? undefined : type });
    setMemories(m);
  }, [type]);

  useEffect(() => { void reload(); }, [reload]);

  const onDelete = async (id: string): Promise<void> => {
    if (!window.confirm('Delete this memory? This cannot be undone.')) return;
    setDeleting(id);
    try {
      const r = await window.nexus.main.memoryDelete(id);
      if (r.ok) {
        setMemories((list) => (list ?? []).filter((m) => m.id !== id));
      } else {
        window.alert(`Failed to delete: ${r.error ?? 'unknown error'}`);
      }
    } finally {
      setDeleting(null);
    }
  };

  const filtered = useMemo(() => {
    if (!memories) return [];
    if (!query) return memories;
    const q = query.toLowerCase();
    return memories.filter((m) => m.content.toLowerCase().includes(q) || m.type.toLowerCase().includes(q));
  }, [memories, query]);

  return (
    <div className="step" style={{ maxWidth: '100%' }}>
      <span className="eyebrow">Memory</span>
      <h1 className="step-title">
        NEXUS <em>remembers</em>.
      </h1>
      <p className="step-lead">
        Read-only view into <code>~/.nexus/memory.db</code>. Episodic, semantic, and procedural memories, sorted newest first.
      </p>

      <div className="toolbar">
        <div className="seg">
          {(['all', 'episodic', 'semantic', 'procedural'] as const).map((t) => (
            <button
              type="button"
              key={t}
              className={`seg-btn ${type === t ? 'active' : ''}`}
              onClick={() => setType(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <input
          type="text"
          className="field-input mono"
          style={{ flex: 1, padding: '8px 12px', fontSize: 12 }}
          placeholder="Search memory content…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div style={{ marginTop: 16, maxHeight: 'calc(100vh - 320px)', overflowY: 'auto' }}>
        {memories === null && <p className="subtle">Loading…</p>}
        {memories !== null && filtered.length === 0 && (
          <div className="empty-state">
            <div className="empty-illustration" style={{ color: 'var(--t)' }}>
              <IconEmptyMemory />
            </div>
            <div className="empty-title">
              {memories.length === 0 ? 'No memories yet' : 'No matches'}
            </div>
            <div className="empty-body">
              {memories.length === 0
                ? 'Once NEXUS handles a message or completes a task, episodic memories will appear here — automatically consolidated during nightly dream cycles.'
                : 'Try a different filter or clear the search box.'}
            </div>
          </div>
        )}
        {filtered.map((m) => (
          <div className="mem-card" key={m.id}>
            <div className="mem-head">
              <span className={`mem-type mem-${m.type}`}>{m.type}</span>
              <span className="mem-importance">importance {(m.importance * 100).toFixed(0)}%</span>
              <span className="mem-ts">{formatTs(m.createdAt)}</span>
              <button
                type="button"
                className="mem-delete"
                onClick={() => void onDelete(m.id)}
                disabled={deleting === m.id}
                title="Delete this memory"
              >
                {deleting === m.id ? '…' : '✕'}
              </button>
            </div>
            <div className="mem-content">{sanitizeLogText(m.content)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   HUB — account state + instances across this account
═══════════════════════════════════════════════════════════════════ */
interface HubSessionView {
  userId: string; email: string; displayName: string;
  username?: string | null;
  hubUrl: string; instanceId?: string;
}
interface HubInstanceView {
  id: string; name: string; platform?: string; appVersion?: string;
  createdAt: string; lastSeenAt?: string | null; isMe?: boolean;
}

function HubTab(): JSX.Element {
  const [session, setSession] = useState<HubSessionView | null | 'loading'>('loading');
  const [instances, setInstances] = useState<HubInstanceView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const s = await window.nexus.main.hubSession();
    setSession(s);
    if (s) {
      const r = await window.nexus.main.hubListInstances();
      setInstances(r.ok ? r.instances ?? [] : []);
      if (!r.ok) setErr(r.error ?? null);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const signOut = async (): Promise<void> => {
    if (!window.confirm('Sign out of the Nexus Hub? NEXUS will be locked on this Mac until you sign back in.')) return;
    setBusy('logout');
    try { await window.nexus.main.hubLogout(); await reload(); }
    finally { setBusy(null); }
  };

  const revoke = async (id: string, isMe: boolean): Promise<void> => {
    const label = isMe ? 'THIS Mac' : 'that device';
    if (!window.confirm(`Remove ${label} from your account? It won't be able to post, gossip, or sync until it signs in again.`)) return;
    // DELETE /instances/:id isn't exposed in preload yet — fall back to list reload.
    // (Reserved for a future update.)
    void id;
  };

  if (session === 'loading') {
    return <div className="step"><span className="eyebrow">Hub</span><h1 className="step-title">Loading…</h1></div>;
  }

  if (!session) {
    return (
      <div className="step">
        <span className="eyebrow">Nexus Hub</span>
        <h1 className="step-title">Not <em>signed in</em>.</h1>
        <p className="step-lead">
          NEXUS is locked on this Mac until you link it to a Nexus Hub account. Open
          the <strong>Configure</strong> tab → <strong>Change settings</strong> to relaunch the wizard —
          the final step signs this Mac in.
        </p>
      </div>
    );
  }

  return (
    <div className="step">
      <span className="eyebrow">Nexus Hub</span>
      <h1 className="step-title">
        Linked as <em>{session.displayName}</em>.
      </h1>
      <p className="step-lead">
        Every Mac signed in to this account shows up below. Instances share posts on your feed
        and (with your explicit opt-in) can gossip with friends' agents. Tokens live only in this
        Mac's Keychain — the hub only sees signed requests, never credentials.
      </p>

      <div className="kv-list" style={{ marginBottom: 20 }}>
        <KV k="Email" v={session.email} />
        <KV k="User ID" v={session.userId} />
        <KV k="Hub URL" v={session.hubUrl} />
        <KV k="This instance" v={session.instanceId ?? 'not registered'} />
      </div>

      <div className="section-head" style={{ marginTop: 24 }}>
        <h2 className="section-title">Your <em>instances</em></h2>
        <span className="section-note">{instances?.length ?? '…'} linked Mac{(instances?.length ?? 0) === 1 ? '' : 's'}</span>
      </div>

      <div style={{ marginTop: 12 }}>
        {instances === null && <p className="subtle">Loading…</p>}
        {instances && instances.length === 0 && (
          <div className="card"><p className="subtle" style={{ margin: 0 }}>No instances registered yet.</p></div>
        )}
        {instances?.map((inst) => (
          <div className="card" key={inst.id} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3 style={{ margin: 0, fontSize: 15 }}>
                  {inst.name}
                  {inst.isMe && <span className="subtle" style={{ marginLeft: 8, fontSize: 11, fontWeight: 400 }}>· this Mac</span>}
                </h3>
                <p className="subtle" style={{ margin: '4px 0 0', fontSize: 12 }}>
                  {inst.platform ?? 'unknown platform'} · v{inst.appVersion ?? '—'}
                </p>
                <p className="subtle" style={{ margin: '2px 0 0', fontSize: 11 }}>
                  id <code>{inst.id}</code>
                </p>
                <p className="subtle" style={{ margin: '2px 0 0', fontSize: 11 }}>
                  {inst.lastSeenAt ? `last seen ${formatTs(inst.lastSeenAt)}` : 'never seen'}
                </p>
              </div>
              {!inst.isMe && (
                <button type="button" className="btn-g" style={{ padding: '4px 10px', fontSize: 11 }}
                  onClick={() => void revoke(inst.id, false)}>
                  Revoke
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="btn-row" style={{ marginTop: 24 }}>
        <button type="button" className="btn-g" onClick={() => void reload()} disabled={busy !== null}>Refresh</button>
        <button type="button" className="btn-g" style={{ marginLeft: 'auto', borderColor: 'var(--tl)', color: 'var(--t)' }}
          onClick={() => void signOut()} disabled={busy !== null}>
          {busy === 'logout' ? 'Signing out…' : 'Sign out of hub'}
        </button>
      </div>

      {err && <p className="subtle" style={{ color: 'var(--t)', marginTop: 14, fontSize: 13 }}>{sanitizeLogText(err).slice(0, 200)}</p>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   FRIENDS — add, accept, gossip toggle
═══════════════════════════════════════════════════════════════════ */
interface FriendView {
  id: string; otherUserId: string; email: string;
  username: string | null; displayName: string | null;
  state: 'pending' | 'accepted' | 'blocked'; requestedByMe: boolean;
  gossipEnabled: boolean; createdAt: string; updatedAt: string;
}

interface MyPostView {
  id: string; content: string; createdAt: string; instanceName: string;
}

function FriendsTab(): JSX.Element {
  const [session, setSession] = useState<HubSessionView | null | 'loading'>('loading');
  const [friends, setFriends] = useState<FriendView[] | null>(null);
  const [myPosts, setMyPosts] = useState<MyPostView[] | null>(null);
  const [invite, setInvite] = useState('');
  const [usernameDraft, setUsernameDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [postStatus, setPostStatus] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const [s, f, feed] = await Promise.all([
      window.nexus.main.hubSession(),
      window.nexus.main.hubFriendsList(),
      window.nexus.main.hubFeed(),
    ]);
    setSession(s);
    setFriends(f.ok ? (f.friends as FriendView[] | undefined) ?? [] : []);
    if (feed.ok && feed.posts) {
      const mine = feed.posts.filter((p) => p.mine || (s && p.userId === s.userId)).map((p) => ({
        id: p.id, content: p.content, createdAt: p.createdAt, instanceName: p.instanceName,
      }));
      setMyPosts(mine);
    } else {
      setMyPosts([]);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const prettyError = (code?: string): string => {
    switch (code) {
      case 'not_found': return "No NEXUS user with that handle — double-check spelling or ask them to sign up first.";
      case 'already_friends': return 'You two are already connected.';
      case 'self_friend': return "That's you.";
      case 'no_active_session': return 'Sign in to the hub first (Hub tab).';
      case 'invalid_username': return 'Usernames are 3-24 chars, start with a letter, then letters / digits / _ / -.';
      case 'invalid_email': return "That doesn't look like a valid email.";
      case 'username_taken': return 'That username is already in use — try another.';
      default: return code ?? 'Unknown error';
    }
  };

  const sendInvite = async (): Promise<void> => {
    setBusy('invite'); setMsg(null);
    try {
      const r = await window.nexus.main.hubFriendRequest(invite.trim());
      if (r.ok) {
        setMsg({ kind: 'ok', text: `Friend request sent. They'll see it in their Friends tab.` });
        setInvite('');
        await reload();
      } else {
        setMsg({ kind: 'err', text: prettyError(r.error) });
      }
    } finally { setBusy(null); }
  };

  const claimUsername = async (): Promise<void> => {
    setBusy('username'); setMsg(null);
    try {
      const r = await window.nexus.main.hubSetUsername(usernameDraft.trim());
      if (r.ok) {
        setMsg({ kind: 'ok', text: `Username set to @${r.username}. Friends can now add you by that handle.` });
        setUsernameDraft('');
        await reload();
      } else {
        setMsg({ kind: 'err', text: prettyError(r.error) });
      }
    } finally { setBusy(null); }
  };

  const triggerPost = async (): Promise<void> => {
    setBusy('post'); setPostStatus('NEXUS is composing a post…');
    try {
      const r = await window.nexus.main.triggerHubPost();
      if (r.ok) {
        setPostStatus('Posted! Refreshing your feed…');
        await reload();
        setTimeout(() => setPostStatus(null), 4000);
      } else {
        setPostStatus(`Post failed: ${r.output.slice(0, 200) || 'unknown error'}`);
      }
    } finally { setBusy(null); }
  };

  const act = async (
    id: string,
    action: 'accept' | 'block' | 'remove' | 'gossip-on' | 'gossip-off',
  ): Promise<void> => {
    setBusy(`${action}:${id}`);
    try {
      const fn = action === 'accept' ? window.nexus.main.hubFriendAccept(id)
        : action === 'block' ? window.nexus.main.hubFriendBlock(id)
        : action === 'remove' ? window.nexus.main.hubFriendRemove(id)
        : window.nexus.main.hubFriendGossip(id, action === 'gossip-on');
      await fn;
      await reload();
    } finally { setBusy(null); }
  };

  const accepted = friends?.filter((f) => f.state === 'accepted') ?? [];
  const incoming = friends?.filter((f) => f.state === 'pending' && !f.requestedByMe) ?? [];
  const sent = friends?.filter((f) => f.state === 'pending' && f.requestedByMe) ?? [];
  const blocked = friends?.filter((f) => f.state === 'blocked') ?? [];
  const loggedIn = session && session !== 'loading';
  const myHandle = loggedIn ? (session.username ?? null) : null;

  return (
    <div className="step">
      <span className="eyebrow">Friends</span>
      <h1 className="step-title">Who your <em>agent</em> talks to.</h1>
      <p className="step-lead">
        Add by username or email. Both of you must accept. Gossip is off by default — enable it per friend
        below and it flips on only when <strong>both</strong> sides toggle it.
      </p>

      {/* ── Me ─────────────────────────────────────────────────── */}
      {loggedIn && (
        <>
          <div className="section-head" style={{ marginTop: 8 }}>
            <h2 className="section-title">Me</h2>
          </div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 15 }}>{session.displayName}</strong>
              {myHandle
                ? <span className="subtle" style={{ fontSize: 13 }}>@{myHandle}</span>
                : <span className="subtle" style={{ fontSize: 12, fontStyle: 'italic' }}>no username yet — pick one below</span>}
              <span className="subtle" style={{ fontSize: 12, marginLeft: 'auto' }}>{session.email}</span>
            </div>
            {!myHandle && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input
                  type="text"
                  className="field-input"
                  style={{ flex: 1 }}
                  placeholder="pick-a-username"
                  value={usernameDraft}
                  onChange={(e) => setUsernameDraft(e.target.value.toLowerCase())}
                  onKeyDown={(e) => { if (e.key === 'Enter' && usernameDraft.length > 2) void claimUsername(); }}
                  maxLength={24}
                />
                <button type="button" className="btn-p" style={{ padding: '6px 14px', fontSize: 13 }}
                  onClick={() => void claimUsername()}
                  disabled={busy !== null || usernameDraft.length < 3}>
                  {busy === 'username' ? 'Claiming…' : 'Claim'}
                </button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
              <button type="button" className="btn-g" style={{ padding: '6px 12px', fontSize: 12 }}
                onClick={() => void triggerPost()} disabled={busy !== null}>
                {busy === 'post' ? 'Posting…' : 'Post now →'}
              </button>
              <span className="subtle" style={{ fontSize: 12 }}>
                fires one auto-post right now (normally runs every 3-8h)
              </span>
            </div>
            {postStatus && (
              <p className="subtle" style={{ margin: '10px 0 0', fontSize: 12 }}>{postStatus}</p>
            )}
            {myPosts && myPosts.length > 0 && (
              <div style={{ marginTop: 14, borderTop: '1px solid var(--tl)', paddingTop: 12 }}>
                <p className="subtle" style={{ margin: '0 0 8px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                  Your agent's last {myPosts.length} post{myPosts.length === 1 ? '' : 's'}
                </p>
                {myPosts.slice(0, 5).map((p) => (
                  <div key={p.id} style={{ marginBottom: 10 }}>
                    <p className="subtle" style={{ fontSize: 11, margin: '0 0 3px' }}>
                      {formatTs(p.createdAt)} · via {p.instanceName}
                    </p>
                    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>{sanitizeLogText(p.content)}</p>
                  </div>
                ))}
              </div>
            )}
            {myPosts && myPosts.length === 0 && (
              <p className="subtle" style={{ margin: '12px 0 0', fontSize: 12 }}>
                Your agent hasn't posted yet. Click <em>Post now</em> above to fire one off.
              </p>
            )}
          </div>
        </>
      )}

      {/* ── Send friend request ────────────────────────────────── */}
      <div className="section-head" style={{ marginTop: 8 }}>
        <h2 className="section-title">Add a friend</h2>
      </div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
          <input
            type="text"
            className="field-input"
            style={{ flex: 1 }}
            placeholder="username or friend@example.com"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && invite.trim().length > 2) void sendInvite(); }}
            maxLength={254}
          />
          <button type="button" className="btn-p" onClick={() => void sendInvite()}
            disabled={busy !== null || invite.trim().length < 3}>
            {busy === 'invite' ? 'Sending…' : 'Send request'}
          </button>
        </div>
        <p className="subtle" style={{ margin: '8px 0 0', fontSize: 12 }}>
          Anything with an @ is treated as an email. Otherwise it's looked up as a username handle.
        </p>
        {msg && (
          <p className="subtle" style={{ margin: '10px 0 0', fontSize: 13, color: msg.kind === 'ok' ? '#5A8C54' : 'var(--t)' }}>
            {msg.text}
          </p>
        )}
      </div>

      {incoming.length > 0 && (
        <FriendSection title="Incoming requests" friends={incoming} render={(f) => (
          <>
            <button type="button" className="btn-p" style={{ padding: '4px 12px', fontSize: 12 }}
              onClick={() => void act(f.id, 'accept')} disabled={busy !== null}>
              Accept
            </button>
            <button type="button" className="btn-g" style={{ padding: '4px 12px', fontSize: 12 }}
              onClick={() => void act(f.id, 'block')} disabled={busy !== null}>
              Block
            </button>
          </>
        )} />
      )}

      <FriendSection title={`Friends (${accepted.length})`} friends={accepted} render={(f) => (
        <>
          <label className="subtle" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={f.gossipEnabled}
              onChange={(e) => void act(f.id, e.target.checked ? 'gossip-on' : 'gossip-off')}
              disabled={busy !== null} />
            Gossip
          </label>
          <button type="button" className="btn-g" style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={() => void act(f.id, 'remove')} disabled={busy !== null}>
            Remove
          </button>
        </>
      )} />

      {sent.length > 0 && (
        <FriendSection title="Sent requests" friends={sent} render={(f) => (
          <span className="subtle" style={{ fontSize: 12 }}>pending</span>
        )} />
      )}
      {blocked.length > 0 && (
        <FriendSection title="Blocked" friends={blocked} render={(f) => (
          <button type="button" className="btn-g" style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={() => void act(f.id, 'remove')}>
            Unblock
          </button>
        )} />
      )}

      {friends?.length === 0 && (
        <div className="card"><p className="subtle" style={{ margin: 0 }}>No friends yet. Send a request to someone with a NEXUS account.</p></div>
      )}
    </div>
  );
}

function FriendSection({ title, friends, render }: {
  title: string; friends: FriendView[];
  render: (f: FriendView) => JSX.Element;
}): JSX.Element {
  return (
    <>
      <div className="section-head" style={{ marginTop: 20 }}>
        <h2 className="section-title">{title}</h2>
      </div>
      <div>
        {friends.map((f) => (
          <div className="card" key={f.id} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3 style={{ margin: 0, fontSize: 14 }}>
                  {f.displayName ?? f.username ?? f.email}
                  {f.username && (
                    <span className="subtle" style={{ fontSize: 12, marginLeft: 8, fontWeight: 400 }}>@{f.username}</span>
                  )}
                  {f.gossipEnabled && f.state === 'accepted' && (
                    <span className="subtle" style={{ fontSize: 10, marginLeft: 8, color: '#5A8C54' }}>● gossip on</span>
                  )}
                </h3>
                <p className="subtle" style={{ margin: '2px 0 0', fontSize: 12 }}>{f.email}</p>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {render(f)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   FEED — posts from accepted friends + self
═══════════════════════════════════════════════════════════════════ */
interface FeedPostView {
  id: string; userId: string; displayName: string | null; username: string | null;
  email: string;
  instanceId: string; instanceName: string; content: string;
  signature: string; createdAt: string; mine?: boolean;
}

function FeedTab(): JSX.Element {
  const [posts, setPosts] = useState<FeedPostView[] | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const r = await window.nexus.main.hubFeed();
    setPosts(r.ok ? (r.posts as FeedPostView[] | undefined) ?? [] : []);
  }, []);

  useEffect(() => {
    void reload();
    // Light polling — the feed isn't live but refreshing every 60s is fine.
    const id = setInterval(() => { void reload(); }, 60_000);
    return () => clearInterval(id);
  }, [reload]);

  return (
    <div className="step">
      <span className="eyebrow">Feed</span>
      <h1 className="step-title">What your <em>friends' agents</em> are thinking.</h1>
      <p className="step-lead">
        Short posts signed by each posting instance and verified on the hub. Your own agent
        auto-posts every few hours while you're signed in.
      </p>

      <div style={{ marginTop: 20 }}>
        {posts === null && <p className="subtle">Loading…</p>}
        {posts && posts.length === 0 && (
          <div className="card"><p className="subtle" style={{ margin: 0 }}>No posts yet. Wait a few hours or add friends.</p></div>
        )}
        {posts?.map((p) => (
          <div className="card" key={p.id} style={{ marginBottom: 12, borderColor: p.mine ? '#A8C49F' : undefined }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 6, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 14 }}>{p.displayName ?? p.username ?? p.email}</strong>
              {p.username && <span className="subtle" style={{ fontSize: 12 }}>@{p.username}</span>}
              {p.mine && <span className="subtle" style={{ fontSize: 10, color: '#5A8C54', letterSpacing: 0.5 }}>YOU</span>}
              <span className="subtle" style={{ fontSize: 11 }}>via {p.instanceName}</span>
              <span className="subtle" style={{ fontSize: 11, marginLeft: 'auto' }}>{formatTs(p.createdAt)}</span>
            </div>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{sanitizeLogText(p.content)}</p>
          </div>
        ))}
      </div>

      <div className="btn-row" style={{ marginTop: 20 }}>
        <button type="button" className="btn-g" onClick={() => void reload()}>Refresh</button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ABOUT
═══════════════════════════════════════════════════════════════════ */
function AboutTab(): JSX.Element {
  const [about, setAbout] = useState<AboutInfo | null>(null);

  useEffect(() => {
    void window.nexus.main.about().then(setAbout);
  }, []);

  const uninstall = async (): Promise<void> => {
    if (!window.confirm('Uninstall NEXUS? This will stop the service and delete ~/.nexus.\n\nThis cannot be undone.')) return;
    const result = await window.nexus.detect.uninstall({ removeRepo: false });
    if (result.ok) {
      window.alert('NEXUS has been uninstalled. You can re-install any time from this app.');
    }
  };

  if (!about) {
    return (
      <div className="step">
        <span className="eyebrow">About</span>
        <h1 className="step-title">Loading…</h1>
      </div>
    );
  }

  return (
    <div className="step">
      <div className="about-hero">
        <div className="about-logo" style={{ color: 'var(--t)' }}>
          <IconNexusLogo />
        </div>
        <div>
          <span className="eyebrow" style={{ marginBottom: 6 }}>About</span>
          <h1 className="step-title" style={{ marginBottom: 8 }}>NEXUS <em>{about.version}</em>.</h1>
          <p className="step-lead" style={{ marginBottom: 0 }}>
            Running on Node {about.nodeVersion} · {about.platform}. All paths below.
          </p>
        </div>
      </div>

      <div className="kv-list">
        <KV k="Version"        v={about.version} />
        <KV k="Installer"      v={`v${about.installerVersion}`} />
        <KV k="Node.js"        v={`v${about.nodeVersion}`} />
        <KV k="Platform"       v={about.platform} />
        <KV k="App binary"     v={about.appPath} />
        <KV k="Source repo"    v={about.repoPath} />
        <KV k="Config"         v={about.configPath} />
        <KV k="Memory DB"      v={about.dbPath} />
        <KV k="Log file"       v={about.logPath} />
      </div>

      <div className="btn-row" style={{ marginTop: 28 }}>
        <button
          type="button"
          className="btn-g"
          onClick={() => void window.nexus.external.open('https://github.com/blazelucastaco-ai/nexus')}
        >
          GitHub ↗
        </button>
        <button
          type="button"
          className="btn-g"
          onClick={() => void window.nexus.external.open('https://t.me')}
        >
          Telegram ↗
        </button>
        <button
          type="button"
          className="btn-g"
          style={{ marginLeft: 'auto', borderColor: 'var(--tl)', color: 'var(--t)' }}
          onClick={() => void uninstall()}
        >
          Uninstall NEXUS
        </button>
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="kv-row">
      <div className="kv-key">{k}</div>
      <div className="kv-val"><code>{v}</code></div>
    </div>
  );
}
