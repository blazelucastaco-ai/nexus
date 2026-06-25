// Wire protocol for the Jarvis web interface.
//
// The web UI is a second "door" into the same NEXUS brain that Telegram talks
// to. It speaks over a single loopback WebSocket: the browser sends ClientFrame,
// the daemon pushes ServerFrame. Everything here is plain JSON — no schema
// negotiation — so the browser and daemon can evolve a frame at a time.

/** Default loopback port for the web server (HTTP + WS share it). */
export const WEB_DEFAULT_PORT = 4242;

/** chatId used for the web channel when no Telegram chat is configured. */
export const WEB_FALLBACK_CHAT_ID = 'web-jarvis';

/**
 * The orb's mood. The frontend resolves a final visual state by priority
 * (speaking > listening > thinking > tool/task/dreaming/alert > idle); the
 * daemon only ever *suggests* a state via these frames.
 */
export type OrbState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'tool'
  | 'task'
  | 'dreaming'
  | 'alert';

// ─── Daemon → browser ────────────────────────────────────────────────────────

export type ServerFrame =
  /** Sent once on connect. `wakeWord` tells the UI whether "Hey Nexus" is armed. */
  | { t: 'hello'; chatId: string; version: string; serverTime: number; wakeWord?: boolean; bootId?: string }
  /** "Hey Nexus" was heard — wake the orb and start listening. */
  | { t: 'wake' }
  /** Echo a user utterance (from native on-device voice STT) so the UI shows it. */
  | { t: 'user_echo'; text: string }
  /** Suggest an orb state. ttlMs lets transient states (a tool firing) decay back to idle. */
  | { t: 'orb'; state: OrbState; intensity?: number; hue?: number; ttlMs?: number }
  /** Status line under the orb ("thinking…", "running a task…"). */
  | { t: 'status'; text: string }
  /** A streamed token of the in-flight assistant reply (best-effort). */
  | { t: 'token'; delta: string }
  /** A complete assistant message. */
  | { t: 'assistant'; text: string; final: boolean }
  /** A synthesized voice clip (ElevenLabs TTS) — the orb pulses to it. `queue:true`
   * means play it after the current clip finishes (the answer after the "on it" ack). */
  | { t: 'audio'; url: string; text: string; queue?: boolean }
  /** A line for the live activity feed (a tool ran, a task step finished…). */
  | { t: 'activity'; kind: string; label: string; detail?: string; ok?: boolean }
  /** A model-driven UI directive (render a chart / diagram / panel / projects…). */
  | { t: 'ui'; kind: string; payload: Record<string, unknown> }
  /** A proactive / dream / idle notice surfaced from the brain's background loops. */
  | { t: 'notice'; level: 'info' | 'warn' | 'idea' | 'dream'; text: string }
  /** Periodic liveness from the orchestrator heartbeat. */
  | { t: 'heartbeat'; mood: number; uptimeSec: number; memoryCount: number }
  | { t: 'pong' };

// ─── Browser → daemon ────────────────────────────────────────────────────────

export type ClientFrame =
  /** The user said / typed something. */
  | { t: 'user_message'; text: string }
  /** Mic open/closed — lets the orb reflect "listening" instantly. */
  | { t: 'listening'; on: boolean }
  | { t: 'ping' };

/** Narrow an unknown parsed object to a ClientFrame, or null if malformed. */
export function parseClientFrame(raw: unknown): ClientFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  switch (f.t) {
    case 'user_message':
      return typeof f.text === 'string' ? { t: 'user_message', text: f.text } : null;
    case 'listening':
      return typeof f.on === 'boolean' ? { t: 'listening', on: f.on } : null;
    case 'ping':
      return { t: 'ping' };
    default:
      return null;
  }
}
