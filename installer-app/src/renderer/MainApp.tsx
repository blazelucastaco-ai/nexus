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
  ChatMessage,
} from '../shared/types';
import {
  IconDashboard, IconConfig, IconLogs, IconChrome, IconUpdate, IconMemory, IconAbout,
  IconChat,
  IconNexusLogo, IconEmptyMemory, IconExternal,
} from './icons';

const TABS: Array<{ key: MainTab; label: string; Icon: () => JSX.Element }> = [
  { key: 'dashboard', label: 'Dashboard', Icon: IconDashboard },
  { key: 'chat',      label: 'Chat',      Icon: IconChat },
  { key: 'config',    label: 'Configure', Icon: IconConfig },
  { key: 'logs',      label: 'Logs',      Icon: IconLogs },
  { key: 'chrome',    label: 'Chrome',    Icon: IconChrome },
  { key: 'updates',   label: 'Updates',   Icon: IconUpdate },
  { key: 'memory',    label: 'Memory',    Icon: IconMemory },
  { key: 'about',     label: 'About',     Icon: IconAbout },
];

export function MainApp(): JSX.Element {
  const [tab, setTab] = useState<MainTab>('dashboard');
  const [commitsBehind, setCommitsBehind] = useState(0);

  // Kick an update check on mount + every 30 minutes. If we're behind
  // upstream, show a red dot on the Updates nav item so the user notices.
  useEffect(() => {
    const check = async (): Promise<void> => {
      try {
        const r = await window.nexus.main.updatesCheck();
        setCommitsBehind(r.commitsBehind);
      } catch {
        /* offline or no repo — silently skip */
      }
    };
    void check();
    const id = setInterval(() => void check(), 30 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

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
              {t.key === 'updates' && commitsBehind > 0 && (
                <span className="nav-badge" title={`${commitsBehind} commit${commitsBehind === 1 ? '' : 's'} behind`}>
                  {commitsBehind > 9 ? '9+' : commitsBehind}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="sidebar-footer">v0.1.0</div>
      </aside>
      <main className="main">
        {tab === 'dashboard' && <DashboardTab onOpenChat={() => setTab('chat')} />}
        {tab === 'chat' && <ChatTab />}
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
function DashboardTab({ onOpenChat }: { onOpenChat: () => void }): JSX.Element {
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
          icon="💬"
          title="Chat with NEXUS"
          subtitle="Open the in-app conversation pane"
          onClick={onOpenChat}
          disabled={!state?.service.running}
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
   CHAT (in-app conversation with the local NEXUS)
═══════════════════════════════════════════════════════════════════ */
const CHAT_SUGGESTIONS = [
  'What did we work on yesterday?',
  'Summarize my recent commits',
  'Take a screenshot and tell me what you see',
  'What are my top recurring mistakes?',
  'List my active projects',
];

function ChatTab(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: 'welcome',
      role: 'system',
      text: 'Direct line to NEXUS. Messages here bypass Telegram — they go straight to the local brain.',
      ts: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom whenever the message list grows or a send completes.
  // The read of messages.length + sending inside the effect body is what biome
  // wants to see so it can track the dependencies.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // intentional reads so the effect re-runs when either changes
    void messages.length;
    void sending;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, sending]);

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || sending) return;
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text,
      ts: new Date().toISOString(),
    };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setSending(true);
    const started = Date.now();
    try {
      const r = await window.nexus.main.chatSend(text);
      const ms = Date.now() - started;
      if (r.ok && r.reply) {
        setMessages((m) => [...m, {
          id: `n-${Date.now()}`,
          role: 'nexus',
          text: r.reply!,
          ts: new Date().toISOString(),
          durationMs: ms,
        }]);
      } else {
        setMessages((m) => [...m, {
          id: `e-${Date.now()}`,
          role: 'system',
          text: `✗ ${r.error ?? 'Unknown error. Check that NEXUS is running and the repo is intact.'}`,
          ts: new Date().toISOString(),
        }]);
      }
    } finally {
      setSending(false);
    }
  };

  const clear = (): void => {
    setMessages([{
      id: 'welcome-2',
      role: 'system',
      text: 'Cleared. Start a new conversation.',
      ts: new Date().toISOString(),
    }]);
  };

  return (
    <div className="step chat-tab">
      <div className="chat-head">
        <div>
          <span className="eyebrow">Chat</span>
          <h1 className="step-title">Talk to <em>NEXUS</em>.</h1>
        </div>
        <button type="button" className="btn-g" style={{ padding: '8px 14px' }} onClick={clear} disabled={sending}>
          Clear
        </button>
      </div>
      <p className="step-lead" style={{ marginTop: -4 }}>
        In-app dev chat — same path as <code>nexus chat</code> in the terminal. The full orchestrator, memory, and personality stack runs on every message.
      </p>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
            {m.role !== 'system' && (
              <div className="chat-msg-head">
                <span className="chat-role">{m.role === 'user' ? 'you' : 'nexus'}</span>
                {m.durationMs && <span className="chat-ms">{(m.durationMs / 1000).toFixed(1)}s</span>}
              </div>
            )}
            <div className="chat-body">{m.text}</div>
          </div>
        ))}
        {sending && (
          <div className="chat-msg chat-msg-nexus pending">
            <div className="chat-msg-head">
              <span className="chat-role">nexus</span>
              <span className="chat-ms">thinking…</span>
            </div>
            <div className="chat-body"><span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" /></div>
          </div>
        )}
      </div>

      {messages.filter((m) => m.role !== 'system').length === 0 && !sending && (
        <div className="chat-suggestions">
          <div className="chat-sugg-label">Try one of these:</div>
          <div className="chat-sugg-row">
            {CHAT_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="chat-sugg"
                onClick={() => setInput(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message NEXUS…"
          rows={2}
          disabled={sending}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="btn-p chat-send-btn"
          onClick={() => void send()}
          disabled={sending || input.trim().length === 0}
        >
          {sending ? 'Sending…' : 'Send ↵'}
        </button>
      </div>
    </div>
  );
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
          {filtered.map((l) => (
            <div key={l.ts + l.msg + Math.random()} className={`log-line log-lvl-${l.level}`}>
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

function parseLogLine(raw: string): LogEntry {
  try {
    const j = JSON.parse(raw) as { time?: string; level?: number; component?: string; msg?: string };
    return {
      ts: j.time ?? '',
      level: typeof j.level === 'number' ? j.level : 30,
      component: j.component,
      msg: j.msg ?? raw,
      raw,
    };
  } catch {
    return { ts: '', level: 30, msg: raw, raw };
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
function UpdatesTab(): JSX.Element {
  const [check, setCheck] = useState<{ localSha: string; remoteSha: string; commitsBehind: number; upToDate: boolean } | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    const c = await window.nexus.main.updatesCheck();
    setCheck(c);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return window.nexus.main.onUpdateProgress((p) => {
      setProgress(p);
      if (p.log) setLogLines((ls) => [...ls.slice(-200), p.log!]);
    });
  }, []);

  const runUpdate = async (): Promise<void> => {
    setRunning(true);
    setLogLines([]);
    setProgress(null);
    try {
      await window.nexus.main.updatesRun();
      await refresh();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="step">
      <span className="eyebrow">Updates</span>
      <h1 className="step-title">
        {check?.upToDate ? <>You're <em>up to date</em>.</> : <>New <em>version</em> available.</>}
      </h1>
      <p className="step-lead">
        {check === null
          ? 'Checking GitHub for new commits…'
          : check.upToDate
            ? `Local is at ${check.localSha}. No new commits on the main branch.`
            : `${check.commitsBehind} commit${check.commitsBehind === 1 ? '' : 's'} behind upstream (${check.localSha} → ${check.remoteSha}).`}
      </p>

      {progress && (
        <div className="progress-wrap" style={{ marginBottom: 16 }}>
          <div className="progress-label">
            <span>{progress.label}</span>
            <span className="progress-pct">{Math.round(progress.pct)}%</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress.pct}%` }} />
          </div>
        </div>
      )}

      {logLines.length > 0 && (
        <div className="dark-box" style={{ marginBottom: 16 }}>
          <div className="dark-box-bar">
            <div className="dark-box-dot" />
            <span className="dark-box-label">update · live log</span>
          </div>
          <div className="dark-box-body">
            {logLines.map((l, i) => <div key={`${i}-${l.slice(0, 20)}`}>{l}</div>)}
          </div>
        </div>
      )}

      <div className="btn-row">
        <button
          type="button"
          className="btn-p"
          onClick={() => void runUpdate()}
          disabled={running || check?.upToDate}
        >
          {running ? 'Updating…' : check?.upToDate ? 'Up to date' : 'Pull & rebuild'}
        </button>
        <button type="button" className="btn-g" onClick={() => void refresh()} disabled={running}>
          Re-check
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
            <div className="mem-content">{m.content}</div>
          </div>
        ))}
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
