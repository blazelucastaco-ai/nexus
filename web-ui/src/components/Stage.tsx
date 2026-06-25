import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useUI } from '../lib/store';
import { orbSignal, speechSignal } from '../lib/signals';
import { NodeGraph } from '../cards/NodeGraph';
import { Chart } from '../cards/Chart';
import { Panel } from '../cards/Panel';
import { Steps, Fallback } from '../cards/StageWidgets';
import { Stats, Comparison, Timeline, ListView, Code } from '../cards/MoreWidgets';
import { Custom } from '../cards/Custom';

// The Stage: the large, center-stage visual surface. When NEXUS calls ui_show_visual
// the spec lands here — it docks the orb to a corner to make room, renders the right
// widget by type, and builds it in piece-by-piece as NEXUS narrates (keyed to the
// spoken clip's progress). The side Rail stays for ambient/secondary cards.

const EASE = [0.16, 1, 0.3, 1] as const;

/** How many ordered pieces the visual has (drives the reveal). */
function pieceCount(spec: Record<string, unknown>): number {
  for (const k of ['nodes', 'steps', 'items', 'events', 'stats', 'rows', 'data']) {
    if (Array.isArray(spec[k])) return Math.max(1, (spec[k] as unknown[]).length);
  }
  return 1;
}

function renderWidget(type: string, spec: Record<string, unknown>, revealUpTo: number, highlight: number) {
  switch (type) {
    case 'node_graph': return <NodeGraph payload={spec} revealUpTo={revealUpTo} highlight={highlight} />;
    case 'chart': return <Chart payload={spec} />;
    case 'steps': return <Steps payload={spec} revealUpTo={revealUpTo} highlight={highlight} />;
    case 'stat_dashboard': return <Stats payload={spec} revealUpTo={revealUpTo} highlight={highlight} />;
    case 'comparison': return <Comparison payload={spec} revealUpTo={revealUpTo} />;
    case 'timeline': return <Timeline payload={spec} revealUpTo={revealUpTo} highlight={highlight} />;
    case 'list': return <ListView payload={spec} revealUpTo={revealUpTo} />;
    case 'code': return <Code payload={spec} />;
    case 'info_panel': return <Panel payload={spec} />;
    case 'custom': return <Custom payload={spec} revealUpTo={revealUpTo} />;
    default: return <Fallback payload={spec} />;
  }
}

export function Stage() {
  const { visual } = useUI();
  const present = !!visual;
  const [reveal, setReveal] = useState(999);
  const [hl, setHl] = useState(-1);
  const startedRef = useRef(false);
  const appearedRef = useRef(0);

  // Dock the orb to a corner whenever a primary visual holds the stage; release it
  // (glide back to center) when the stage clears.
  useEffect(() => {
    orbSignal.dock = present;
    return () => { orbSignal.dock = false; };
  }, [present]);

  // Build the visual in as NEXUS narrates. Show just the first piece while waiting
  // for the voice, advance by the clip's progress while speaking, reveal everything
  // once the clip ends (or for a text-only reply that never speaks).
  useEffect(() => {
    if (!visual) { setReveal(999); setHl(-1); return; }
    startedRef.current = false;
    appearedRef.current = performance.now();
    const total = pieceCount(visual);
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      if (speechSignal.active) {
        startedRef.current = true;
        const p = speechSignal.progress;
        const upTo = Math.max(0, Math.ceil(p * total) - 1);
        const active = Math.min(total - 1, Math.floor(p * total));
        setReveal((v) => (v === upTo ? v : upTo));
        setHl((v) => (v === active ? v : active));
      } else if (startedRef.current || now - appearedRef.current > 3500) {
        setReveal((v) => (v === 999 ? v : 999));
        setHl((v) => (v === -1 ? v : -1));
      } else {
        setReveal((v) => (v === 0 ? v : 0)); // waiting for the voice — show just the core
        setHl((v) => (v === 0 ? v : 0));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visual]);

  return (
    <div className="stage-layer">
      <AnimatePresence>
        {visual ? (
          <motion.div
            className="stage-visual"
            key={String(visual.id ?? 'v')}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            {visual.title ? <div className="stage-title">{String(visual.title)}</div> : null}
            <div className="stage-body">
              {renderWidget(String(visual.type ?? ''), visual, reveal, hl)}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
