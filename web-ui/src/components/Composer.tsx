import { useState } from 'react';

interface Props {
  onSend: (text: string) => void;
  onToggleMic: () => void;
  listening: boolean;
  canListen: boolean;
}

export function Composer({ onSend, onToggleMic, listening, canListen }: Props) {
  const [val, setVal] = useState('');

  const submit = () => {
    const t = val.trim();
    if (!t) return;
    onSend(t);
    setVal('');
  };

  return (
    <div className={`composer ${listening ? 'listening' : ''}`}>
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={listening ? 'Listening…' : 'Talk to NEXUS — or hold Space'}
        // biome-ignore lint: autofocus is intentional for a single-purpose console
        autoFocus
        aria-label="Message"
      />
      {canListen ? (
        <button
          className={`icon-btn mic ${listening ? 'on' : ''}`}
          onClick={onToggleMic}
          title="Click or hold Space to talk"
          aria-label="Microphone"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" stroke="none" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
      ) : null}
      <button className="icon-btn send" onClick={submit} aria-label="Send">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      </button>
    </div>
  );
}
