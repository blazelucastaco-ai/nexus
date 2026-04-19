import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SystemCheckResult,
  ConfigInput,
  PermissionCheck,
  InstallProgress,
  ChromeStatus,
} from '../shared/types';
import { AGENT_CHOICES, PERSONALITY_PRESETS } from '../shared/types';

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

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const r = await window.nexus.permissions.check();
    setChecks(r);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="step">
      <span className="eyebrow">Step 6 / 9</span>
      <h1 className="step-title">
        macOS <em>permissions</em>.
      </h1>
      <p className="step-lead">
        NEXUS needs a handful of permissions to see your screen, control apps, and
        look up contacts. Click "Open Settings" to grant any that are missing.
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
                onClick={() => void window.nexus.permissions.open(c.prefsUrl)}
              >
                Open Settings
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
export function InstallStep(props: { config: ConfigInput; onNext: () => void }): JSX.Element {
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
      const result = await window.nexus.install.run(props.config);
      if (result.ok) {
        setDone(true);
      } else {
        setError(result.error ?? 'Install failed.');
      }
      unsub();
    })();

    return () => unsub();
  }, [props.config]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: logLines.length is the trigger to scroll
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines.length]);

  return (
    <div className="step">
      <span className="eyebrow">Step 7 / 9</span>
      <h1 className="step-title">
        {error ? <>Install <em>failed</em>.</> : done ? <>Install <em>complete</em>.</> : <>Installing <em>NEXUS</em>.</>}
      </h1>
      <p className="step-lead">
        {error
          ? 'See the log below for details.'
          : done
            ? 'All components installed. The background service is running.'
            : 'Cloning the repo, installing dependencies, building, and registering the launchd service.'}
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
   10. DONE
────────────────────────────────────────────────────────────────── */
export function DoneStep(): JSX.Element {
  return (
    <div className="step">
      <div className="done-hero">
        <div className="done-emoji">✨</div>
        <span className="eyebrow">Setup complete</span>
        <h1 className="step-title">
          NEXUS is <em>ready</em>.
        </h1>
        <p className="step-lead">
          The service is running in the background. Send your Telegram bot any message
          to say hi.
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
          onClick={() => window.nexus.external.open('https://t.me')}
        >
          Open Telegram ↗
        </button>
        <button
          type="button"
          className="btn-g"
          onClick={() => window.nexus.external.open('https://github.com/blazelucastaco-ai/nexus')}
        >
          View on GitHub ↗
        </button>
      </div>
    </div>
  );
}
