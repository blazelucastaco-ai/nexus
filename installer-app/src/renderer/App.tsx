import { useState, useCallback } from 'react';
import type { StepKey, ConfigInput } from '../shared/types';
import { PERSONALITY_PRESETS } from '../shared/types';
import {
  WelcomeStep,
  SystemCheckStep,
  TelegramStep,
  AIKeyStep,
  AgentsStep,
  PersonalityStep,
  PermissionsStep,
  InstallStep,
  ChromeStep,
  DoneStep,
} from './steps';

const STEPS: Array<{ key: StepKey; label: string }> = [
  { key: 'welcome', label: 'Welcome' },
  { key: 'system-check', label: 'System' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'ai', label: 'Anthropic' },
  { key: 'agents', label: 'Agents' },
  { key: 'personality', label: 'Personality' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'install', label: 'Install' },
  { key: 'chrome', label: 'Chrome' },
  { key: 'done', label: 'Ready' },
];

export function App(): JSX.Element {
  const [currentKey, setCurrentKey] = useState<StepKey>('welcome');
  const [config, setConfig] = useState<ConfigInput>({
    telegram: { botToken: '', chatId: '' },
    anthropicKey: '',
    agents: ['vision', 'file', 'browser', 'terminal', 'code', 'research', 'system', 'creative', 'comms', 'scheduler'],
    personality: {
      preset: 'friendly',
      traits: { ...PERSONALITY_PRESETS.friendly },
    },
  });

  const updateConfig = useCallback((patch: Partial<ConfigInput>): void => {
    setConfig((c) => ({ ...c, ...patch }));
  }, []);

  const currentIdx = STEPS.findIndex((s) => s.key === currentKey);
  const go = useCallback((key: StepKey): void => setCurrentKey(key), []);
  const next = useCallback((): void => {
    const idx = STEPS.findIndex((s) => s.key === currentKey);
    if (idx >= 0 && idx < STEPS.length - 1) {
      setCurrentKey(STEPS[idx + 1]!.key);
    }
  }, [currentKey]);
  const back = useCallback((): void => {
    const idx = STEPS.findIndex((s) => s.key === currentKey);
    if (idx > 0) {
      setCurrentKey(STEPS[idx - 1]!.key);
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
          {STEPS.map((s, i) => {
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
        {currentKey === 'install' && <InstallStep config={config} onNext={next} />}
        {currentKey === 'chrome' && <ChromeStep onNext={next} />}
        {currentKey === 'done' && <DoneStep />}
      </main>
    </div>
  );
}
