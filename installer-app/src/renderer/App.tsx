import { useCallback, useEffect, useState } from 'react';
import type { StepKey, ConfigInput, DetectionResult, DetectAction } from '../shared/types';
import { PERSONALITY_PRESETS } from '../shared/types';
import {
  DetectStep,
  UninstallStep,
  WelcomeStep,
  SystemCheckStep,
  TelegramStep,
  AIKeyStep,
  AgentsStep,
  PersonalityStep,
  PermissionsStep,
  InstallStep,
  ChromeStep,
  AccountStep,
  MemoryImportStep,
  DoneStep,
} from './steps';

const FULL_STEPS: Array<{ key: StepKey; label: string }> = [
  { key: 'welcome', label: 'Welcome' },
  { key: 'system-check', label: 'System' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'ai', label: 'Anthropic' },
  { key: 'agents', label: 'Agents' },
  { key: 'personality', label: 'Personality' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'install', label: 'Install' },
  { key: 'chrome', label: 'Chrome' },
  { key: 'account', label: 'Account' },
  { key: 'memory-import', label: 'Memory' },
  { key: 'done', label: 'Ready' },
];

export function App(): JSX.Element {
  const [currentKey, setCurrentKey] = useState<StepKey>('detect');
  const [mode, setMode] = useState<'install' | 'reconfigure' | 'repair'>('install');
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [config, setConfig] = useState<ConfigInput>({
    telegram: { botToken: '', chatId: '' },
    anthropicKey: '',
    agents: ['vision', 'file', 'browser', 'terminal', 'code', 'research', 'system', 'creative', 'comms', 'scheduler'],
    personality: {
      preset: 'friendly',
      traits: { ...PERSONALITY_PRESETS.friendly },
    },
  });

  // Run detection on first render. If nothing is installed, fast-forward
  // past the detect gate into the welcome screen automatically.
  useEffect(() => {
    void window.nexus.detect.existing().then((d) => {
      setDetection(d);
      const hasAny = d.configExists || d.repoExists || d.serviceRegistered;
      if (!hasAny) {
        setCurrentKey('welcome');
      }
    });
  }, []);

  const updateConfig = useCallback((patch: Partial<ConfigInput>): void => {
    setConfig((c) => ({ ...c, ...patch }));
  }, []);

  const onDetectPick = useCallback((action: DetectAction): void => {
    if (!detection) return;
    if (action === 'fresh') {
      setMode('install');
      setCurrentKey('welcome');
      return;
    }
    if (action === 'uninstall') {
      setCurrentKey('uninstall');
      return;
    }
    // Reconfigure + repair both prefill the wizard with existing values.
    setConfig((c) => ({
      telegram: detection.existingTelegram ?? c.telegram,
      anthropicKey: detection.existingAnthropicKey ?? c.anthropicKey,
      agents: detection.existingAgents ?? c.agents,
      personality: detection.existingPersonality ?? c.personality,
    }));
    if (action === 'reconfigure') {
      setMode('reconfigure');
      setCurrentKey('telegram');
    } else {
      // repair: keep config, just re-run the install pipeline
      setMode('repair');
      setCurrentKey('install');
    }
  }, [detection]);

  // Sidebar: on the detect step show only "Detect", then swap to the full
  // wizard list once the user picks a path.
  const visibleSteps = currentKey === 'detect' || currentKey === 'uninstall'
    ? [{ key: currentKey, label: currentKey === 'uninstall' ? 'Uninstall' : 'Detect' }]
    : FULL_STEPS;
  const currentIdx = visibleSteps.findIndex((s) => s.key === currentKey);

  const next = useCallback((): void => {
    const idx = FULL_STEPS.findIndex((s) => s.key === currentKey);
    if (idx >= 0 && idx < FULL_STEPS.length - 1) {
      setCurrentKey(FULL_STEPS[idx + 1]!.key);
    }
  }, [currentKey]);
  const back = useCallback((): void => {
    const idx = FULL_STEPS.findIndex((s) => s.key === currentKey);
    if (idx > 0) {
      setCurrentKey(FULL_STEPS[idx - 1]!.key);
    }
  }, [currentKey]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-dot" />
          <span className="brand-name">NEXUS</span>
        </div>
        <div className="step-list">
          {visibleSteps.map((s, i) => {
            const state = i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'pending';
            return (
              <div key={s.key} className={`step-item ${state}`}>
                <div className="step-dot">{i < currentIdx ? '✓' : i + 1}</div>
                <span>{s.label}</span>
              </div>
            );
          })}
        </div>
        <div className="sidebar-footer">v0.1.0 · INSTALLER</div>
      </aside>
      <main className="main">
        {currentKey === 'detect' && (
          <DetectStep detection={detection} onPick={onDetectPick} />
        )}
        {currentKey === 'uninstall' && (
          <UninstallStep
            detection={detection}
            onCancel={() => setCurrentKey('detect')}
            onDone={() => setCurrentKey('welcome')}
          />
        )}
        {currentKey === 'welcome' && <WelcomeStep onNext={next} />}
        {currentKey === 'system-check' && <SystemCheckStep onNext={next} onBack={back} />}
        {currentKey === 'telegram' && (
          <TelegramStep
            value={config.telegram}
            onChange={(telegram) => updateConfig({ telegram })}
            onNext={next}
            onBack={back}
          />
        )}
        {currentKey === 'ai' && (
          <AIKeyStep
            value={config.anthropicKey}
            onChange={(anthropicKey) => updateConfig({ anthropicKey })}
            onNext={next}
            onBack={back}
          />
        )}
        {currentKey === 'agents' && (
          <AgentsStep
            value={config.agents}
            onChange={(agents) => updateConfig({ agents })}
            onNext={next}
            onBack={back}
          />
        )}
        {currentKey === 'personality' && (
          <PersonalityStep
            value={config.personality}
            onChange={(personality) => updateConfig({ personality })}
            onNext={next}
            onBack={back}
          />
        )}
        {currentKey === 'permissions' && <PermissionsStep onNext={next} onBack={back} />}
        {currentKey === 'install' && (
          <InstallStep config={config} mode={mode} onNext={next} />
        )}
        {currentKey === 'chrome' && <ChromeStep onNext={next} />}
        {currentKey === 'account' && <AccountStep onNext={next} onBack={back} />}
        {currentKey === 'memory-import' && <MemoryImportStep onNext={next} onBack={back} />}
        {currentKey === 'done' && <DoneStep mode={mode} />}
      </main>
    </div>
  );
}
