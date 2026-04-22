import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SystemCheckResult,
  ConfigInput,
  PermissionCheck,
  InstallProgress,
  ChromeStatus,
  DetectionResult,
  DetectAction,
} from '../shared/types';
import { AGENT_CHOICES, PERSONALITY_PRESETS } from '../shared/types';

/* ──────────────────────────────────────────────────────────────────
   0. DETECT — pre-welcome gate, only shown when an existing install
   is found. If nothing is found, App.tsx skips past this.
────────────────────────────────────────────────────────────────── */
export function DetectStep(props: {
  detection: DetectionResult | null;
  onPick: (action: DetectAction) => void;
}): JSX.Element {
  if (props.detection === null) {
    return (
      <div className="step">
        <span className="eyebrow">Checking…</span>
        <h1 className="step-title">Looking for an existing <em>NEXUS</em>…</h1>
      </div>
    );
  }

  const d = props.detection;

  return (
    <div className="step">
      <div className="pill">
        <div className="pill-dot" />
        <span>NEXUS <strong>{d.version ?? 'already'} installed</strong></span>
      </div>
      <h1 className="step-title">
        We found an <em>existing</em> NEXUS.
      </h1>
      <p className="step-lead">
        What would you like to do?
      </p>

      <div className="checklist" style={{ marginTop: 10, marginBottom: 24 }}>
        <div className="check-item">
          <div className={`check-status ${d.configExists ? 'ok' : 'pending'}`}>{d.configExists ? '✓' : '—'}</div>
          <span className="check-name">Config file</span>
          <span className="check-detail">{d.configExists ? d.configPath : 'not present'}</span>
        </div>
        <div className="check-item">
          <div className={`check-status ${d.repoExists ? 'ok' : 'pending'}`}>{d.repoExists ? '✓' : '—'}</div>
          <span className="check-name">Source repo</span>
          <span className="check-detail">{d.repoExists ? d.repoPath : 'not present'}</span>
        </div>
        <div className="check-item">
          <div className={`check-status ${d.serviceRunning ? 'ok' : d.serviceRegistered ? 'pending' : 'fail'}`}>
            {d.serviceRunning ? '✓' : d.serviceRegistered ? '○' : '—'}
          </div>
          <span className="check-name">Background service</span>
          <span className="check-detail">
            {d.serviceRunning ? 'running' : d.serviceRegistered ? 'registered but stopped' : 'not registered'}
          </span>
        </div>
      </div>

      <div className="preset-grid">
        <button type="button" className="preset-card" onClick={() => props.onPick('reconfigure')}>
          <div className="preset-name">Reconfigure</div>
          <div className="preset-desc">Update Telegram, API key, agents, or personality. Nothing reinstalled.</div>
        </button>
        <button type="button" className="preset-card" onClick={() => props.onPick('repair')}>
          <div className="preset-name">Repair / Update</div>
          <div className="preset-desc">Pull the latest source, rebuild, re-register the service. Config preserved.</div>
        </button>
        <button type="button" className="preset-card" onClick={() => props.onPick('fresh')}>
          <div className="preset-name">Install fresh</div>
          <div className="preset-desc">Run the full wizard again. Overwrites config and repo.</div>
        </button>
        <button type="button" className="preset-card" onClick={() => props.onPick('uninstall')} style={{ borderColor: 'var(--tl)' }}>
          <div className="preset-name" style={{ color: 'var(--t)' }}>Uninstall</div>
          <div className="preset-desc">Stop the service and remove ~/.nexus. Repo removal is optional.</div>
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   0b. UNINSTALL — confirmation + teardown
────────────────────────────────────────────────────────────────── */
export function UninstallStep(props: {
  detection: DetectionResult | null;
  onCancel: () => void;
  onDone: () => void;
}): JSX.Element {
  const [removeRepo, setRemoveRepo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runUninstall = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await window.nexus.detect.uninstall({ removeRepo });
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="step">
        <span className="eyebrow">Uninstall complete</span>
        <h1 className="step-title">NEXUS is <em>gone</em>.</h1>
        <p className="step-lead">
          The service was stopped and <code>~/.nexus</code> was removed
          {removeRepo ? ` along with ${props.detection?.repoPath ?? 'the source repo'}` : ''}.
          You can reinstall any time from this same app.
        </p>
        <div className="btn-row">
          <button type="button" className="btn-p" onClick={props.onDone}>Install again →</button>
        </div>
      </div>
    );
  }

  return (
    <div className="step">
      <span className="eyebrow">Uninstall</span>
      <h1 className="step-title">Remove <em>NEXUS</em> from this Mac?</h1>
      <p className="step-lead">
        This will stop the background service, unload its launchd agent, and delete
        <code> ~/.nexus</code> (config, memory database, logs, screenshots). Your
        Telegram bot token and Anthropic API key will be gone.
      </p>

      <div className="card" style={{ marginBottom: 22 }}>
        <label className="card-row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={removeRepo}
            onChange={(e) => setRemoveRepo(e.target.checked)}
            style={{ marginTop: 4 }}
          />
          <div>
            <h3>Also delete the source repo at <code>{props.detection?.repoPath ?? '~/nexus'}</code></h3>
            <p>Only check this if you're sure — any local changes or memory snapshots there will be lost.</p>
          </div>
        </label>
      </div>

      {error && <p className="field-error">{error}</p>}

      <div className="btn-row">
        <button type="button" className="btn-g" onClick={props.onCancel} disabled={busy}>← Back</button>
        <button type="button" className="btn-p" onClick={() => void runUninstall()} disabled={busy} style={{ background: 'var(--td)' }}>
          {busy ? 'Uninstalling…' : 'Uninstall NEXUS'}
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   1. WELCOME
────────────────────────────────────────────────────────────────── */
export function WelcomeStep(props: { onNext: () => void }): JSX.Element {
  return (
    <div className="step">
      <div className="pill">
        <div className="pill-dot" />
        <span>Powered by Anthropic <strong>Claude</strong></span>
      </div>
      <h1 className="step-title">
        Let's set up <em>NEXUS</em> on<br />your machine.
      </h1>
      <p className="step-lead">
        In about 5 minutes, this installer will configure your Telegram bot, Anthropic
        API key, agent capabilities, and macOS permissions — then start NEXUS as a
        background service.
      </p>
      <div className="btn-row">
        <button type="button" className="btn-p" onClick={props.onNext}>
          Get started →
        </button>
        <button
          type="button"
          className="btn-g"
          onClick={() => window.nexus.external.open('https://github.com/blazelucastaco-ai/nexus')}
        >
          View on GitHub ↗
        </button>
      </div>
      <div className="dark-box" style={{ marginTop: 40 }}>
        <div className="dark-box-bar">
          <div className="dark-box-dot" />
          <span className="dark-box-label">installer · what you'll need</span>
        </div>
        <div className="dark-box-body">
          <span className="accent">✦</span>{' '}
          <span>A Telegram bot token</span>{' '}
          <span className="dim">— from @BotFather</span>
          {'\n'}
          <span className="accent">✦</span>{' '}
          <span>An Anthropic API key</span>{' '}
          <span className="dim">— from console.anthropic.com</span>
          {'\n'}
          <span className="accent">✦</span>{' '}
          <span>A few macOS permission grants</span>{' '}
          <span className="dim">— we'll open System Settings for you</span>
          {'\n'}
          <span className="accent">✦</span>{' '}
          <span>Chrome</span>{' '}
          <span className="dim">— optional, for the browser extension</span>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   2. SYSTEM CHECK
────────────────────────────────────────────────────────────────── */
export function SystemCheckStep(props: { onNext: () => void; onBack: () => void }): JSX.Element {
  const [results, setResults] = useState<SystemCheckResult[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.nexus.system.check().then((r) => {
      if (!cancelled) setResults(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const allRequiredOk = results?.every((r) => !r.required || r.ok) ?? false;

  return (
    <div className="step">
      <span className="eyebrow">Step 1 / 9</span>
      <h1 className="step-title">Checking your <em>system</em>.</h1>
      <p className="step-lead">
        NEXUS requires macOS and Node.js 22+. Missing tools will be installed for you.
      </p>
      <div className="checklist">
        {(results ?? Array.from({ length: 5 }).map(() => null)).map((r, i) => (
          <div className="check-item" key={r?.name ?? i}>
            {r === null ? (
              <div className="check-status spinner" />
            ) : r.ok ? (
              <div className="check-status ok">✓</div>
            ) : (
              <div className={`check-status ${r.required ? 'fail' : 'pending'}`}>
                {r.required ? '!' : '—'}
              </div>
            )}
            <span className="check-name">{r?.name ?? 'Checking…'}</span>
            <span className="check-detail">{r?.detail ?? ''}</span>
          </div>
        ))}
      </div>
      <div className="btn-row">
        <button type="button" className="btn-g" onClick={props.onBack}>
          ← Back
        </button>
        <button type="button" className="btn-p" onClick={props.onNext} disabled={!results || !allRequiredOk}>
          Continue →
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   3. TELEGRAM
────────────────────────────────────────────────────────────────── */
export function TelegramStep(props: {
  value: { botToken: string; chatId: string };
  onChange: (v: { botToken: string; chatId: string }) => void;
  onNext: () => void;
  onBack: () => void;
}): JSX.Element {
  const tokenValid = /^\d+:[A-Za-z0-9_-]+$/.test(props.value.botToken);
  const chatIdValid = /^-?\d+$/.test(props.value.chatId);

  return (
    <div className="step">
      <span className="eyebrow">Step 2 / 9</span>
      <h1 className="step-title">
        Connect your <em>Telegram</em> bot.
      </h1>
      <p className="step-lead">
        NEXUS uses a Telegram bot as its primary interface. Messages, commands, media,
        morning briefings — everything flows through here.
      </p>

      <div className="field">
        <label htmlFor="tg-token" className="field-label">Bot token</label>
        <input
          id="tg-token"
          type="password"
          className="field-input mono"
          placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
          value={props.value.botToken}
          onChange={(e) => props.onChange({ ...props.value, botToken: e.target.value })}
        />
        <p className="field-hint">
          Get one from{' '}
          <button type="button" className="link" onClick={() => window.nexus.external.open('https://t.me/BotFather')}>@BotFather</button>{' '}
          — send <code>/newbot</code> and copy the token.
        </p>
        {props.value.botToken && !tokenValid && (
          <p className="field-error">Expected format: <code>123456789:ABCdef...</code></p>
        )}
      </div>

      <div className="field">
        <label htmlFor="tg-chatid" className="field-label">Your chat ID</label>
        <input
          id="tg-chatid"
          type="text"
          className="field-input mono"
          placeholder="123456789"
          value={props.value.chatId}
          onChange={(e) => props.onChange({ ...props.value, chatId: e.target.value })}
        />
        <p className="field-hint">
          Send any message to your bot, then visit{' '}
          <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> and copy
          the <code>chat.id</code>.
        </p>
        {props.value.chatId && !chatIdValid && (
          <p className="field-error">Chat ID must be a number.</p>
        )}
      </div>

      <div className="btn-row">
        <button type="button" className="btn-g" onClick={props.onBack}>
          ← Back
        </button>
        <button
          type="button"
          className="btn-p"
          onClick={props.onNext}
          disabled={!tokenValid || !chatIdValid}
        >
          Continue →
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   4. AI KEY
────────────────────────────────────────────────────────────────── */
export function AIKeyStep(props: {
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
  onBack: () => void;
}): JSX.Element {
  const valid = props.value.startsWith('sk-ant-') && props.value.length > 20;

  return (
    <div className="step">
      <span className="eyebrow">Step 3 / 9</span>
      <h1 className="step-title">
        Anthropic <em>API key</em>.
      </h1>
      <p className="step-lead">
        NEXUS runs on Claude — Opus 4.7 for planning, Sonnet 4.6 for execution, and
        Haiku 4.5 for fast checks.
      </p>

      <div className="field">
        <label htmlFor="anthropic-key" className="field-label">Anthropic API key</label>
        <input
          id="anthropic-key"
          type="password"
          className="field-input mono"
          placeholder="sk-ant-api03-…"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <p className="field-hint">
          Get one at{' '}
          <button type="button" className="link" onClick={() => window.nexus.external.open('https://console.anthropic.com')}>
            console.anthropic.com
          </button>
          . Keys start with <code>sk-ant-</code>.
        </p>
        {props.value && !valid && (
          <p className="field-error">Expected format: <code>sk-ant-…</code></p>
        )}
      </div>

      <div className="btn-row">
        <button type="button" className="btn-g" onClick={props.onBack}>← Back</button>
        <button type="button" className="btn-p" onClick={props.onNext} disabled={!valid}>
          Continue →
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   5. AGENTS
────────────────────────────────────────────────────────────────── */
export function AgentsStep(props: {
  value: string[];
  onChange: (v: string[]) => void;
  onNext: () => void;
  onBack: () => void;
}): JSX.Element {
  const toggle = (id: string): void => {
    if (props.value.includes(id)) {
      props.onChange(props.value.filter((x) => x !== id));
    } else {
      props.onChange([...props.value, id]);
    }
  };

  return (
    <div className="step">
      <span className="eyebrow">Step 4 / 9</span>
      <h1 className="step-title">Pick your <em>agents</em>.</h1>
      <p className="step-lead">
        NEXUS routes tasks to specialized agents. All 10 are enabled by default —
        untick anything you don't need.
      </p>
      <div className="agents-grid">
        {AGENT_CHOICES.map((a) => {
          const selected = props.value.includes(a.id);
          return (
            <button
              key={a.id}
              className={`agent-chip ${selected ? 'selected' : ''}`}
              onClick={() => toggle(a.id)}
              type="button"
            >
              <div className="agent-chip-icon">{a.icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="agent-chip-name">{a.name}</div>
                <div className="agent-chip-desc">{a.description}</div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="btn-row">
        <button type="button" className="btn-g" onClick={props.onBack}>← Back</button>
        <button type="button" className="btn-p" onClick={props.onNext} disabled={props.value.length === 0}>
          Continue → <span style={{ color: 'rgba(255,255,255,.6)', marginLeft: 4 }}>
            {props.value.length}/10 enabled
          </span>
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   6. PERSONALITY
────────────────────────────────────────────────────────────────── */
const PRESET_META = [
  { id: 'professional', name: 'Professional', desc: 'Low humor, high formality, terse replies.' },
  { id: 'friendly', name: 'Friendly', desc: 'Balanced humor, warm tone, moderate verbosity.' },
  { id: 'sarcastic_genius', name: 'Sarcastic Genius', desc: 'Sharp wit, strong opinions, confident delivery.' },
  { id: 'custom', name: 'Custom', desc: 'Drag the sliders to taste.' },
] as const;

const TRAIT_LABELS: Array<{ key: keyof typeof PERSONALITY_PRESETS.friendly; label: string }> = [
  { key: 'humor', label: 'Humor' },
  { key: 'sarcasm', label: 'Sarcasm' },
  { key: 'formality', label: 'Formality' },
  { key: 'assertiveness', label: 'Assertiveness' },
  { key: 'verbosity', label: 'Verbosity' },
  { key: 'empathy', label: 'Empathy' },
];

export function PersonalityStep(props: {
  value: ConfigInput['personality'];
  onChange: (v: ConfigInput['personality']) => void;
  onNext: () => void;
  onBack: () => void;
}): JSX.Element {
  const isCustom = props.value.preset === 'custom';
  const setPreset = (preset: ConfigInput['personality']['preset']): void => {
    props.onChange({ preset, traits: { ...PERSONALITY_PRESETS[preset] } });
  };
  const updateTrait = (key: keyof typeof PERSONALITY_PRESETS.friendly, v: number): void => {
    props.onChange({
      preset: 'custom',
      traits: { ...props.value.traits, [key]: v / 10 },
    });
  };

  return (
    <div className="step">
      <span className="eyebrow">Step 5 / 9</span>
      <h1 className="step-title">How should NEXUS <em>talk</em>?</h1>
      <p className="step-lead">
        Pick a preset, or set custom traits. You can change this later in{' '}
        <code>~/.nexus/config.json</code>.
      </p>
      <div className="preset-grid">
        {PRESET_META.map((p) => (
          <button
            key={p.id}
            className={`preset-card ${props.value.preset === p.id ? 'selected' : ''}`}
            onClick={() => setPreset(p.id)}
            type="button"
          >
            <div className="preset-name">{p.name}</div>
            <div className="preset-desc">{p.desc}</div>
          </button>
        ))}
      </div>

      <div className="traits">
        {TRAIT_LABELS.map((t) => {
          const val = Math.round(props.value.traits[t.key] * 10);
          return (
            <div className="trait-row" key={t.key}>
              <div className="trait-label">{t.label}</div>
              {isCustom ? (
                <input
                  type="range"
                  className="trait-slider"
                  min={0}
                  max={10}
                  value={val}
                  onChange={(e) => updateTrait(t.key, Number.parseInt(e.target.value, 10))}
                />
              ) : (
                <div className="trait-bar">
                  <div className="trait-fill" style={{ width: `${val * 10}%` }} />
                </div>
              )}
              <div className="trait-value">{val}/10</div>
            </div>
          );
        })}
      </div>

      <div className="btn-row">
        <button type="button" className="btn-g" onClick={props.onBack}>← Back</button>
        <button type="button" className="btn-p" onClick={props.onNext}>Continue →</button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   7. PERMISSIONS
────────────────────────────────────────────────────────────────── */
export function PermissionsStep(props: { onNext: () => void; onBack: () => void }): JSX.Element {
  const [checks, setChecks] = useState<PermissionCheck[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const r = await window.nexus.permissions.check();
    setChecks(r);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Permissions that auto-prompt via TCC when the probe runs. Others
  // (Screen Recording, Accessibility) need the user to tick NEXUS.app
  // manually in System Settings — no silent prompt is possible.
  const AUTO_PROMPT = new Set(['contacts', 'automation']);

  const request = async (perm: PermissionCheck): Promise<void> => {
    setRequesting(perm.key);
    try {
      if (AUTO_PROMPT.has(perm.key)) {
        // Re-running the check triggers the underlying osascript probe again.
        // First time in the app's life, macOS will show the TCC dialog.
        await window.nexus.permissions.check();
      }
      // Always open Settings as a fallback — needed for Screen Recording /
      // Accessibility, harmless for the auto-prompt ones.
      await window.nexus.permissions.open(perm.prefsUrl);
      await new Promise((r) => setTimeout(r, 400));
      await refresh();
    } finally {
      setRequesting(null);
    }
  };

  return (
    <div className="step">
      <span className="eyebrow">Step 6 / 9</span>
      <h1 className="step-title">
        macOS <em>permissions</em>.
      </h1>
      <p className="step-lead">
        NEXUS needs a handful of permissions to see your screen, control apps, and
        look up contacts. Click <strong>Grant</strong> on each — Contacts will
        prompt in-place; Screen Recording and Accessibility open System Settings
        where you tick NEXUS.app manually.
      </p>

      <div className="checklist">
        {(checks ?? Array.from({ length: 4 }).map(() => null)).map((c, i) => (
          <div className="check-item" key={c?.key ?? i}>
            {c === null ? (
              <div className="check-status spinner" />
            ) : c.granted ? (
              <div className="check-status ok">✓</div>
            ) : (
              <div className="check-status pending">?</div>
            )}
            <span className="check-name">{c?.name ?? 'Checking…'}</span>
            {c && !c.granted && (
              <button
                type="button"
                className="check-action"
                onClick={() => void request(c)}
                disabled={requesting !== null}
              >
                {requesting === c.key ? 'Requesting…' : 'Grant'}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="btn-row">
        <button type="button" className="btn-g" onClick={props.onBack}>← Back</button>
        <button type="button" className="btn-g" onClick={() => void refresh()} disabled={loading}>
          Re-check
        </button>
        <button type="button" className="btn-p" onClick={props.onNext}>
          {checks?.every((c) => c.granted) ? 'Continue →' : 'Skip for now →'}
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   8. INSTALL (actual execution)
────────────────────────────────────────────────────────────────── */
export function InstallStep(props: {
  config: ConfigInput;
  mode: 'install' | 'reconfigure' | 'repair';
  onNext: () => void;
}): JSX.Element {
  const [progress, setProgress] = useState<InstallProgress>({
    phase: 'cloning',
    label: 'Preparing…',
    pct: 0,
  });
  const [logLines, setLogLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const startedRef = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const unsub = window.nexus.install.onProgress((p) => {
      setProgress(p);
      if (p.log) {
        setLogLines((lines) => [...lines.slice(-200), p.log!]);
      }
    });

    void (async () => {
      const runner =
        props.mode === 'reconfigure'
          ? window.nexus.install.reconfigure
          : window.nexus.install.run;
      const result = await runner(props.config);
      if (result.ok) {
        setDone(true);
      } else {
        setError(result.error ?? 'Install failed.');
      }
      unsub();
    })();

    return () => unsub();
  }, [props.config, props.mode]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: logLines.length is the trigger to scroll
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines.length]);

  const copy = {
    install:     { progress: 'Installing', done: 'Install',    failed: 'Install',    idle: 'Cloning the repo, installing dependencies, building, and registering the launchd service.', success: 'All components installed. The background service is running.' },
    repair:      { progress: 'Repairing',  done: 'Repair',     failed: 'Repair',     idle: 'Pulling the latest source, rebuilding, and re-registering the launchd service.',         success: 'NEXUS repaired and restarted.' },
    reconfigure: { progress: 'Saving',     done: 'Config',     failed: 'Save',       idle: 'Writing the new configuration and restarting the service…',                              success: 'Config updated. NEXUS restarted with the new settings.' },
  } as const;
  const c = copy[props.mode];

  return (
    <div className="step">
      <span className="eyebrow">Step 7 / 9</span>
      <h1 className="step-title">
        {error ? <>{c.failed} <em>failed</em>.</> : done ? <>{c.done} <em>complete</em>.</> : <>{c.progress} <em>NEXUS</em>.</>}
      </h1>
      <p className="step-lead">
        {error ? 'See the log below for details.' : done ? c.success : c.idle}
      </p>

      <div className="progress-wrap">
        <div className="progress-label">
          <span>{progress.label}</span>
          <span className="progress-pct">{Math.round(progress.pct)}%</span>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress.pct}%` }} />
        </div>
      </div>

      <div className="dark-box">
        <div className="dark-box-bar">
          <div className="dark-box-dot" />
          <span className="dark-box-label">installer · live log</span>
        </div>
        <div className="dark-box-body" ref={logRef}>
          {logLines.length === 0 ? (
            <span className="dim">Waiting for output…</span>
          ) : (
            logLines.map((l, i) => <div key={`${i}-${l.slice(0, 20)}`}>{l}</div>)
          )}
          {error && <div style={{ color: '#D17A60', marginTop: 10 }}>{error}</div>}
        </div>
      </div>

      <div className="btn-row">
        <button type="button" className="btn-p" onClick={props.onNext} disabled={!done && !error}>
          {error ? 'Continue anyway →' : 'Continue →'}
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   9. CHROME
────────────────────────────────────────────────────────────────── */
export function ChromeStep(props: { onNext: () => void }): JSX.Element {
  const [status, setStatus] = useState<ChromeStatus | null>(null);
  const [extPath, setExtPath] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);

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

  const openChrome = async (): Promise<void> => {
    if (status?.appLabel) {
      await window.nexus.chrome.openExtensions(status.appLabel);
    }
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    const ok = await window.nexus.chrome.testConnection();
    setTestResult(ok);
    setTesting(false);
  };

  if (status === null) {
    return (
      <div className="step">
        <span className="eyebrow">Step 8 / 9</span>
        <h1 className="step-title">Chrome extension.</h1>
        <p className="step-lead">Checking for Chrome…</p>
      </div>
    );
  }

  if (!status.installed) {
    return (
      <div className="step">
        <span className="eyebrow">Step 8 / 9</span>
        <h1 className="step-title">
          Chrome <em>not found</em>.
        </h1>
        <p className="step-lead">
          NEXUS can still work without it — the browser extension is optional. Install
          Chrome later and run <code>nexus extension</code> from the terminal when you
          want to set it up.
        </p>
        <div className="btn-row">
          <button type="button" className="btn-p" onClick={props.onNext}>Skip →</button>
        </div>
      </div>
    );
  }

  return (
    <div className="step">
      <span className="eyebrow">Step 8 / 9</span>
      <h1 className="step-title">
        Install the <em>Chrome extension</em>.
      </h1>
      <p className="step-lead">
        The NEXUS Bridge extension lets NEXUS drive {status.appLabel} — navigate,
        click, type, screenshot, extract content.
      </p>

      <div className="done-list">
        <div className="done-item">
          <div className="done-item-n">1</div>
          <div style={{ flex: 1 }}>
            <h4>Open chrome://extensions</h4>
            <p>
              Click the button to open {status.appLabel} at the extensions page.{' '}
              <button type="button" className="check-action" style={{ marginLeft: 8 }} onClick={() => void openChrome()}>
                Open {status.appLabel}
              </button>
            </p>
          </div>
        </div>
        <div className="done-item">
          <div className="done-item-n">2</div>
          <div>
            <h4>Turn on Developer mode</h4>
            <p>Toggle the switch in the top-right corner of the extensions page.</p>
          </div>
        </div>
        <div className="done-item">
          <div className="done-item-n">3</div>
          <div>
            <h4>Click "Load unpacked"</h4>
            <p>Select this folder when the file picker opens:</p>
            <code style={{ display: 'block', marginTop: 6, padding: '6px 10px', wordBreak: 'break-all' }}>
              {extPath}
            </code>
          </div>
        </div>
        <div className="done-item">
          <div className="done-item-n">4</div>
          <div>
            <h4>Test the connection</h4>
            <p>
              Once loaded, press this to confirm the extension can reach NEXUS.{' '}
              <button
                type="button"
                className="check-action"
                style={{ marginLeft: 8 }}
                onClick={() => void runTest()}
                disabled={testing}
              >
                {testing ? 'Testing…' : 'Test now'}
              </button>
              {testResult === true && <span style={{ color: '#5a8c54', marginLeft: 8 }}>✓ Connected</span>}
              {testResult === false && <span style={{ color: 'var(--t)', marginLeft: 8 }}>Not reachable</span>}
            </p>
          </div>
        </div>
      </div>

      <div className="btn-row">
        <button type="button" className="btn-p" onClick={props.onNext}>
          {testResult ? 'Continue →' : 'Done (or skip) →'}
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   10. ACCOUNT — link this install to the Nexus Hub
────────────────────────────────────────────────────────────────── */

type AccountMode = 'choose' | 'signup' | 'login' | 'linked';

export function AccountStep(props: { onNext: () => void; onBack: () => void }): JSX.Element {
  const [mode, setMode] = useState<AccountMode>('choose');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [instanceName, setInstanceName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<{ userId: string; email: string; displayName: string; username?: string | null; hubUrl: string; instanceId?: string } | null>(null);

  // On mount, pre-populate if the user is already signed in on this Mac.
  useEffect(() => {
    void (async () => {
      const existing = await window.nexus.main.hubSession();
      if (existing) {
        setSession(existing);
        setMode('linked');
      }
    })();
    setInstanceName('This Mac');
  }, []);

  const readableError = (code?: string): string => {
    switch (code) {
      case 'invalid_credentials': return 'Email or password is wrong.';
      case 'signup_unavailable': return 'Could not create the account. Try signing in instead.';
      case 'account_locked': return 'Too many failed attempts. Wait 15 minutes and try again.';
      case 'invalid_input': return 'Email needs to be valid and password at least 8 characters.';
      case 'invalid_username': return 'Username must be 3-24 chars, start with a letter, then letters / digits / _ / -.';
      case 'username_taken': return 'That username is already in use — try another.';
      case 'no_refresh_cookie': return 'Hub responded oddly — try again.';
      default:
        return code?.startsWith('network_error')
          ? 'Can\'t reach the Nexus Hub. Check your connection or that the hub is running.'
          : 'Something went wrong. Try again.';
    }
  };

  const doSignup = async (): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      // Username is optional during signup — user can always claim one later
      // from the Friends tab. If provided, validate here so we fail fast.
      const trimmedUsername = username.trim().toLowerCase();
      if (trimmedUsername && !/^[a-z][a-z0-9_-]{2,23}$/.test(trimmedUsername)) {
        setError(readableError('invalid_username'));
        return;
      }
      const r = await window.nexus.main.hubSignup({
        email, password, displayName,
        ...(trimmedUsername ? { username: trimmedUsername } : {}),
      });
      if (!r.ok || !r.session) { setError(readableError(r.error)); return; }
      const reg = await window.nexus.main.hubRegisterInstance(instanceName || 'This Mac');
      setSession({ ...r.session, instanceId: reg.instanceId });
      setMode('linked');
    } finally { setSubmitting(false); }
  };

  const doLogin = async (): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      const r = await window.nexus.main.hubLogin({ email, password });
      if (!r.ok || !r.session) { setError(readableError(r.error)); return; }
      const reg = await window.nexus.main.hubRegisterInstance(instanceName || 'This Mac');
      setSession({ ...r.session, instanceId: reg.instanceId });
      setMode('linked');
    } finally { setSubmitting(false); }
  };

  const doLogout = async (): Promise<void> => {
    await window.nexus.main.hubLogout();
    setSession(null);
    setMode('choose');
    setEmail(''); setPassword(''); setDisplayName('');
  };

  return (
    <div className="step">
      <span className="eyebrow">Step 10 / 11</span>
      <h1 className="step-title">
        Your <em>Nexus account</em>.
      </h1>
      <p className="step-lead">
        Link this install to the Nexus Hub. Once linked, it shows up in your hub
        alongside any other Mac you've installed NEXUS on — so your instances
        can sync memory, post to a shared feed, and (with your permission) gossip
        with your friends' agents. App-only feature; terminal installs stay offline.
      </p>

      {mode === 'choose' && !session && (
        <div className="btn-row" style={{ marginTop: 28 }}>
          <button type="button" className="btn-p" onClick={() => setMode('signup')}>
            Create account →
          </button>
          <button type="button" className="btn-g" onClick={() => setMode('login')}>
            I already have one
          </button>
          <button type="button" className="btn-g" style={{ marginLeft: 'auto' }} onClick={props.onNext}>
            Skip — keep this install offline
          </button>
        </div>
      )}

      {(mode === 'signup' || mode === 'login') && (
        <div style={{ maxWidth: 420, marginTop: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mode === 'signup' && (
            <>
              <label className="field">
                <span className="field-label">Display name</span>
                <input
                  type="text"
                  className="field-input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Lucas"
                  maxLength={64}
                />
              </label>
              <label className="field">
                <span className="field-label">Username <span className="subtle" style={{ fontWeight: 400 }}>(optional — friends add you by this)</span></span>
                <input
                  type="text"
                  className="field-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  placeholder="lucas"
                  maxLength={24}
                />
              </label>
            </>
          )}
          <label className="field">
            <span className="field-label">Email</span>
            <input
              type="email"
              className="field-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              maxLength={254}
            />
          </label>
          <label className="field">
            <span className="field-label">Password {mode === 'signup' ? '(min 8 characters)' : ''}</span>
            <input
              type="password"
              className="field-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              maxLength={256}
            />
          </label>
          <label className="field">
            <span className="field-label">Name for this Mac</span>
            <input
              type="text"
              className="field-input"
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
              placeholder="MacBook Pro"
              maxLength={64}
            />
          </label>

          {error && (
            <div className="subtle" style={{ color: 'var(--t)', fontSize: 13 }}>
              {error}
            </div>
          )}

          <div className="btn-row">
            <button type="button" className="btn-g" onClick={() => { setMode('choose'); setError(null); }} disabled={submitting}>
              ← Back
            </button>
            <button
              type="button"
              className="btn-p"
              onClick={() => void (mode === 'signup' ? doSignup() : doLogin())}
              disabled={
                submitting ||
                email.length < 3 ||
                password.length < 8 ||
                (mode === 'signup' && displayName.length < 1)
              }
            >
              {submitting ? (mode === 'signup' ? 'Creating…' : 'Signing in…') : mode === 'signup' ? 'Create account' : 'Sign in'}
            </button>
          </div>
        </div>
      )}

      {mode === 'linked' && session && (
        <>
          <div className="card" style={{ marginTop: 18, borderColor: '#A8C49F' }}>
            <h3 style={{ marginTop: 0, marginBottom: 8 }}>
              Linked as {session.displayName}
            </h3>
            <p className="subtle" style={{ margin: '0 0 6px' }}>
              <code>{session.email}</code>
            </p>
            {session.instanceId && (
              <p className="subtle" style={{ margin: 0, fontSize: 12 }}>
                Instance ID <code>{session.instanceId}</code> · stored in macOS Keychain
              </p>
            )}
          </div>

          <div className="btn-row" style={{ marginTop: 20 }}>
            <button type="button" className="btn-g" onClick={props.onBack}>← Back</button>
            <button type="button" className="btn-g" onClick={() => void doLogout()}>
              Sign out
            </button>
            <button type="button" className="btn-p" onClick={props.onNext} style={{ marginLeft: 'auto' }}>
              Continue →
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   11. MEMORY IMPORT — merge context from other agents
────────────────────────────────────────────────────────────────── */
interface DetectedSourceView {
  id: string;
  name: string;
  status: 'ready' | 'empty' | 'coming-soon' | string;
  summary: string;
  estimatedItems: number;
}

interface ImportResultView {
  imported: number;
  skipped: number;
  skillsWritten?: number;
  sources: Record<string, number>;
  llmUsed?: boolean;
  alreadyImported?: string[];
}

export function MemoryImportStep(props: { onNext: () => void; onBack: () => void }): JSX.Element {
  const [sources, setSources] = useState<DetectedSourceView[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ImportResultView | null>(null);
  const [progress, setProgress] = useState<{ label: string; pct: number } | null>(null);
  const [phaseLog, setPhaseLog] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      const s = await window.nexus.main.memoryDetectSources();
      setSources(s as DetectedSourceView[]);
      const preset = new Set<string>();
      for (const src of s) if (src.status === 'ready') preset.add(src.id);
      setSelected(preset);
    })();
  }, []);

  // Subscribe to per-phase progress events from the import subprocess.
  useEffect(() => {
    const unsub = window.nexus.main.onMemoryImportProgress((p) => {
      setProgress({ label: p.label, pct: p.pct });
      // Keep a small log of the "source-done" lines so the user sees
      // concrete counts per source as they stream in.
      if (p.phase === 'source-done') {
        setPhaseLog((prev) => [...prev, p.label].slice(-6));
      }
    });
    return () => unsub();
  }, []);

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runImport = async (): Promise<void> => {
    setRunning(true);
    setProgress({ label: 'Starting…', pct: 0 });
    setPhaseLog([]);
    try {
      const r = await window.nexus.main.memoryImport([...selected]);
      setResult(r as ImportResultView);
      setProgress({ label: 'Complete.', pct: 100 });
    } finally {
      setRunning(false);
    }
  };

  const readyCount = (sources ?? []).filter((s) => s.status === 'ready').length;

  return (
    <div className="step">
      <span className="eyebrow">Step 10 / 10</span>
      <h1 className="step-title">
        Start with a <em>head start</em>.
      </h1>
      <p className="step-lead">
        NEXUS can read the context you've built up in other AI agents on this Mac
        — memory notes, preferences, project info, workflow habits — and distil
        it through Claude into <strong>its own</strong> memories and skills. Not a
        mechanical copy. An actual synthesis in NEXUS's voice. Everything is tagged
        so you can audit or delete it later in the Memory tab.
      </p>

      {sources === null && (
        <p className="subtle">Scanning for installed agents…</p>
      )}

      {sources !== null && sources.length === 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <p className="subtle" style={{ margin: 0 }}>
            No other AI agents detected on this Mac. You can always run{' '}
            <code>nexus import-memories</code> later if you install one.
          </p>
        </div>
      )}

      {sources !== null && sources.length > 0 && !result && (
        <div className="checklist" style={{ marginTop: 18 }}>
          {sources.map((s) => {
            const isReady = s.status === 'ready';
            const isComing = s.status === 'coming-soon';
            const checked = selected.has(s.id);
            return (
              <label
                key={s.id}
                className="check-item"
                style={{
                  cursor: isReady ? 'pointer' : 'default',
                  opacity: isReady ? 1 : 0.55,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!isReady || running}
                  onChange={() => isReady && toggle(s.id)}
                  style={{ marginRight: 10 }}
                />
                <span className="check-name" style={{ flex: 1 }}>
                  <strong>{s.name}</strong>{' '}
                  <span className="subtle" style={{ fontSize: 13 }}>— {s.summary}</span>
                </span>
                {isComing && (
                  <span className="subtle" style={{ fontSize: 12, fontStyle: 'italic' }}>coming soon</span>
                )}
                {isReady && (
                  <span className="subtle" style={{ fontSize: 12 }}>
                    {s.estimatedItems} item{s.estimatedItems === 1 ? '' : 's'}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}

      {(running || (progress && !result)) && progress && (
        <div style={{ marginTop: 20 }}>
          <div className="progress-wrap">
            <div className="progress-label">
              <span>{progress.label}</span>
              <span className="progress-pct">{Math.round(progress.pct)}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${Math.max(2, progress.pct)}%` }} />
            </div>
          </div>
          {phaseLog.length > 0 && (
            <div className="subtle" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
              {phaseLog.map((line) => (
                <div key={line}>✓ {line}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {result && (() => {
        const already = result.alreadyImported ?? [];
        const didNothing = result.imported === 0 && already.length > 0;
        const headline = didNothing
          ? 'Already merged'
          : result.llmUsed
            ? 'NEXUS read it and wrote its own memory'
            : 'Imported';
        return (
          <div className="card" style={{ marginTop: 18, borderColor: '#A8C49F' }}>
            <h3 style={{ marginTop: 0, marginBottom: 8 }}>{headline}</h3>
            {didNothing ? (
              <p className="subtle" style={{ margin: '0 0 8px' }}>
                {already.join(', ')} {already.length === 1 ? 'was' : 'were'} already imported
                on a previous run. Re-running would have duplicated work — skipped.
              </p>
            ) : (
              <p className="subtle" style={{ margin: '0 0 8px' }}>
                {result.imported} memor{result.imported === 1 ? 'y' : 'ies'}
                {result.skillsWritten ? ` + ${result.skillsWritten} skill${result.skillsWritten === 1 ? '' : 's'}` : ''}
                {result.skipped > 0 ? ` · ${result.skipped} already present` : ''}
                {already.length > 0 ? ` · ${already.join(', ')} skipped (already imported)` : ''}
              </p>
            )}
            {Object.entries(result.sources).length > 0 && (
              <ul className="subtle" style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
                {Object.entries(result.sources).map(([src, n]) => (
                  <li key={src}><code>{src}</code>: {n}</li>
                ))}
              </ul>
            )}
            <p className="subtle" style={{ marginTop: 12, marginBottom: 0 }}>
              {didNothing
                ? 'Your memory is unchanged. You can manage imported items from the Memory tab.'
                : result.llmUsed
                  ? 'Synthesized memories are live. Skills were written to ~/.nexus/skills/ and will load on next restart.'
                  : 'NEXUS will surface these automatically in future conversations.'}
            </p>
          </div>
        );
      })()}

      <div className="btn-row" style={{ marginTop: 28 }}>
        <button type="button" className="btn-g" onClick={props.onBack} disabled={running}>← Back</button>
        {!result && readyCount > 0 && (
          <button
            type="button"
            className="btn-p"
            onClick={() => void runImport()}
            disabled={running || selected.size === 0}
          >
            {running
              ? 'Importing…'
              : selected.size === 0
                ? 'Nothing selected'
                : `Import ${selected.size} source${selected.size === 1 ? '' : 's'}`}
          </button>
        )}
        <button type="button" className="btn-g" onClick={props.onNext} disabled={running}>
          {result ? 'Continue →' : readyCount === 0 ? 'Skip →' : 'Skip for now →'}
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   11. DONE
────────────────────────────────────────────────────────────────── */
export function DoneStep(props: { mode: 'install' | 'reconfigure' | 'repair' }): JSX.Element {
  const leadText =
    props.mode === 'reconfigure'
      ? 'Your new settings are live. The service restarted automatically — send your bot a message to verify.'
      : props.mode === 'repair'
        ? 'NEXUS has been updated and restarted. Your config is unchanged.'
        : 'The service is running in the background. Send your Telegram bot any message to say hi.';

  const eyebrowText =
    props.mode === 'reconfigure' ? 'Config saved'
    : props.mode === 'repair' ? 'Repair complete'
    : 'Setup complete';

  return (
    <div className="step">
      <div className="done-hero">
        <div className="done-emoji">✨</div>
        <span className="eyebrow">{eyebrowText}</span>
        <h1 className="step-title">
          NEXUS is <em>ready</em>.
        </h1>
        <p className="step-lead">
          {leadText} Look for the <strong style={{ color: 'var(--t)' }}>◉</strong> icon in your menu bar —
          that's NEXUS living in the top-right of your screen, ready whenever you need it.
        </p>
      </div>
      <div className="done-list">
        <div className="done-item">
          <div className="done-item-n">1</div>
          <div>
            <h4>Open Telegram</h4>
            <p>Find your bot and send any message — even just "hi".</p>
          </div>
        </div>
        <div className="done-item">
          <div className="done-item-n">2</div>
          <div>
            <h4>Try a command</h4>
            <p>
              Send <code>/status</code> to confirm everything is wired up. You can also
              try <em>"Take a screenshot of my desktop"</em>.
            </p>
          </div>
        </div>
        <div className="done-item">
          <div className="done-item-n">3</div>
          <div>
            <h4>Manage it from the terminal</h4>
            <p>
              Run <code>nexus status</code>, <code>nexus logs</code>, or{' '}
              <code>nexus stop</code> any time.
            </p>
          </div>
        </div>
      </div>
      <div className="btn-row">
        <button
          type="button"
          className="btn-p"
          onClick={() => void window.nexus.main.openDashboard()}
        >
          Open NEXUS dashboard →
        </button>
        <button
          type="button"
          className="btn-g"
          onClick={() => window.nexus.external.open('https://t.me')}
        >
          Open Telegram ↗
        </button>
      </div>
    </div>
  );
}
