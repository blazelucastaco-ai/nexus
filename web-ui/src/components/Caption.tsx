import { useEffect, useRef, useState } from 'react';
import { speechSignal } from '../lib/signals';

// The large text under the orb that reveals character-by-character as NEXUS
// speaks. Reads speechSignal (driven by the voice controller) via RAF and only
// commits state when the revealed length actually changes, so it stays cheap.
export function Caption() {
  const [text, setText] = useState('');
  const [shown, setShown] = useState(0);
  const [active, setActive] = useState(false);
  const idRef = useRef(0);
  const eased = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (speechSignal.id !== idRef.current) {
        idRef.current = speechSignal.id;
        eased.current = 0;
        setText(speechSignal.text);
      }
      setActive(speechSignal.active);
      eased.current += (speechSignal.charIndex - eased.current) * 0.25;
      setShown(Math.round(eased.current));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!active || !text) return null;
  const visible = text.slice(0, Math.max(0, shown));
  return (
    <div className="caption boot">
      {visible}
      {shown < text.length ? <span className="cursor">.</span> : null}
    </div>
  );
}
