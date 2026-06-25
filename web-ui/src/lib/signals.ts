// Mutable, non-React signals for high-frequency UI.
//
// The orb's render loop reads `orbSignal` every animation frame (~60fps) and the
// caption reveal reads `speechSignal` while NEXUS speaks. Routing those through
// React state would cause a re-render storm, so they live here as plain mutable
// objects that the WebGL loop / RAF loops poll directly.

import type { OrbState } from './protocol';

export const orbSignal = {
  /** Eased 0..1 energy driving brightness + scale. */
  level: 0,
  /** Raw target the render loop eases `level` toward (audio amplitude, etc.). */
  target: 0,
  /** Base hue in degrees. Warm orange ≈ 28. */
  hue: 28,
  speaking: false,
  listening: false,
  thinking: false,
  dreaming: false,
  /** performance.now() timestamp until which a tool/task pulse is active. */
  busyUntil: 0,
  /** performance.now() timestamp until which an alert flash is active. */
  alertUntil: 0,
  /** Model-forced state (from the ui_set_orb tool) and its expiry. */
  forcedState: null as OrbState | null,
  forcedUntil: 0,
  /** True while a primary visual is on the Stage — the orb glides to a corner to
   *  make room, and back to center when it clears. Eased in the render loop. */
  dock: false,
};

export type OrbSignal = typeof orbSignal;

/** Resolve the orb's visible state by priority (voice wins over background work). */
export function effectiveOrbState(now: number): OrbState {
  const s = orbSignal;
  if (s.speaking) return 'speaking';
  if (s.listening) return 'listening';
  if (s.forcedState && now < s.forcedUntil) return s.forcedState;
  if (s.thinking) return 'thinking';
  if (now < s.alertUntil) return 'alert';
  if (s.dreaming) return 'dreaming';
  if (now < s.busyUntil) return 'tool';
  return 'idle';
}

// Expose the signals on window for headless render verification / debugging. Harmless
// read-only handle; the signals are plain mutable objects driving the RAF loops.
if (typeof window !== 'undefined') {
  (window as unknown as { __sig?: unknown }).__sig = { orb: orbSignal };
}

/** Drives the big caption's character-by-character reveal, synced to TTS. */
export const speechSignal = {
  id: 0,
  text: '',
  charIndex: 0,
  active: false,
  /** 0..1 progress through the current spoken clip (currentTime/duration). The
   *  Stage uses this to build a visual piece-by-piece as NEXUS narrates. */
  progress: 0,
};
