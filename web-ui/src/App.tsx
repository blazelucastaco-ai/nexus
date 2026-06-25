import { useEffect, useRef, useState } from 'react';
import { NexusSocket } from './lib/socket';
import { VoiceController } from './lib/voice';
import { orbSignal, speechSignal } from './lib/signals';
import { ui, useUI } from './lib/store';
import type { OrbState, ServerFrame } from './lib/protocol';
import { Orb } from './orb/Orb';
import { StatusLine } from './components/StatusLine';
import { Caption } from './components/Caption';
import { Feed } from './components/Feed';
import { Toasts } from './components/Toasts';
import { Conn } from './components/Conn';
import { Composer } from './components/Composer';
import { Rail } from './components/Rail';
import { Stage } from './components/Stage';

// Running inside the NEXUS native (Electron) window? Its Chromium can't do
// Chrome's speech *recognition*, so we rely on the daemon's on-device STT there.
const IS_ELECTRON = typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent);

/** Bridge exposed by the NEXUS app's preload (absent in a plain browser). */
function nexusJarvis(): { show?: () => void; hide?: () => void } | undefined {
  return (window as unknown as { nexusJarvis?: { show?: () => void; hide?: () => void } }).nexusJarvis;
}

export function App() {
  const socketRef = useRef<NexusSocket | null>(null);
  const voiceRef = useRef<VoiceController | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [, setStreaming] = useState('');
  const [canListen, setCanListen] = useState(false);
  const [wakeArmed, setWakeArmed] = useState(false);
  const [speaking, setSpeaking] = useState(false); // NEXUS caption is revealing
  const audioFallback = useRef<number | null>(null);
  const { status } = useUI();

  // Mirror speechSignal.active into React (cheaply — only on change) so the text
  // states below can be made strictly mutually exclusive (caption wins the zone).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setSpeaking((prev) => (prev === speechSignal.active ? prev : speechSignal.active));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Send a user turn into the one shared brain.
  function sendMessage(text: string): void {
    const t = text.trim();
    if (!t) return;
    setStreaming('');
    ui.clearVisual(); // start the turn with a clean stage; a new visual may replace it
    orbSignal.thinking = true; // instant feedback; backend confirms via events
    socketRef.current?.send({ t: 'user_message', text: t });
  }

  function applyOrbFlags(state: OrbState, ttlMs?: number, hue?: number): void {
    const now = performance.now();
    if (typeof hue === 'number' && Number.isFinite(hue)) orbSignal.hue = hue;
    switch (state) {
      case 'idle':
        orbSignal.thinking = false;
        orbSignal.dreaming = false;
        orbSignal.busyUntil = 0;
        break;
      case 'thinking': orbSignal.thinking = true; break;
      case 'tool': orbSignal.busyUntil = now + (ttlMs ?? 1400); break;
      case 'task': orbSignal.busyUntil = now + (ttlMs ?? 4000); break;
      case 'dreaming': orbSignal.dreaming = true; break;
      case 'alert': orbSignal.alertUntil = now + (ttlMs ?? 2600); break;
      default: break; // listening / speaking are driven locally by the voice controller
    }
  }

  function applyOrbForced(payload: Record<string, unknown>): void {
    const state = String(payload.state ?? 'idle') as OrbState;
    const hue = Number(payload.hue);
    if (payload.hue !== undefined && payload.hue !== '' && Number.isFinite(hue)) orbSignal.hue = hue;
    if (state === 'idle') {
      orbSignal.forcedState = null;
      orbSignal.forcedUntil = 0;
      return;
    }
    orbSignal.forcedState = state;
    orbSignal.forcedUntil = performance.now() + 7000;
  }

  function handleUi(kind: string, payload: Record<string, unknown>): void {
    switch (kind) {
      case 'visual': ui.setVisual(payload); break;       // the unified center-stage visual
      case 'dismiss': ui.clearVisual(); break;
      case 'chart': ui.addCard('chart', payload); break;
      case 'diagram': ui.addCard('diagram', payload); break;
      case 'panel': ui.addCard('panel', payload); break;
      case 'projects': ui.addCard('projects', payload); break;
      case 'clear': ui.clearCards(); ui.clearVisual(); break;
      case 'orb': applyOrbForced(payload); break;
      default: break;
    }
  }

  // "Hey Nexus" was heard (or this page was opened by the wake word): light up + listen.
  function wake(): void {
    nexusJarvis()?.show?.(); // native window: bring it to the front
    try { window.focus(); } catch { /* background tabs can't self-focus */ }
    orbSignal.target = 1; // a bright flare as it wakes
    // Pulse the orb to the USER's voice while they speak (native window too, where
    // the daemon does the actual transcription). Idempotent with startListening.
    void voiceRef.current?.startMicMeter();
    window.setTimeout(() => voiceRef.current?.stopMicMeter(), 12000); // backstop if no command lands
    // In a plain browser, capture the command via browser STT. In the native
    // window the daemon transcribes it on-device, so don't double-listen.
    if (!IS_ELECTRON && voiceRef.current?.canListen) voiceRef.current.startListening();
  }

  function handleFrame(f: ServerFrame): void {
    switch (f.t) {
      case 'hello': {
        if (f.wakeWord) setWakeArmed(true);
        // The daemon redeployed/restarted since this page loaded (different bootId) →
        // this page is a stale cached bundle; reload to fetch the fresh build.
        const loaded = (window as unknown as { __NEXUS_CFG__?: { bootId?: string } }).__NEXUS_CFG__?.bootId;
        if (loaded && f.bootId && loaded !== f.bootId) window.location.reload();
        break;
      }
      case 'wake': wake(); break;
      case 'user_echo':
        // The command was transcribed — stop the user-voice orb meter. No echo bubble.
        voiceRef.current?.stopMicMeter();
        setStreaming('');
        break;
      case 'token': break; // tokens aren't shown — the caption reveals synced to speech
      case 'status': ui.setStatus(f.text); break;
      case 'orb': applyOrbFlags(f.state, f.ttlMs, f.hue); break;
      case 'assistant':
        setStreaming('');
        // The spoken reply arrives as a ElevenLabs 'audio' frame that reveals the caption
        // synced to speech. If no clip shows up (text-only reply), fall back to
        // showing the text as a caption after a short beat. No chat bubble, ever.
        if (f.text?.trim()) {
          const txt = f.text;
          if (audioFallback.current) window.clearTimeout(audioFallback.current);
          audioFallback.current = window.setTimeout(() => {
            audioFallback.current = null;
            voiceRef.current?.showCaption(txt);
          }, 1600);
        }
        break;
      case 'audio':
        if (audioFallback.current) { window.clearTimeout(audioFallback.current); audioFallback.current = null; }
        ui.setStatus(''); // NEXUS is speaking now — clear "thinking…"
        voiceRef.current?.stopMicMeter();
        voiceRef.current?.playUrl(f.url, f.text, { queue: f.queue, align: f.align });
        break;
      case 'activity': ui.addFeed({ kind: f.kind, label: f.label, detail: f.detail, ok: f.ok }); break;
      case 'ui': handleUi(f.kind, f.payload); break;
      case 'notice': ui.addToast(f.level, f.text); break;
      case 'heartbeat': ui.setMood(f.mood); break;
      default: break; // hello / token / pong
    }
  }

  useEffect(() => {
    const voice = new VoiceController({
      onTranscript: (text) => { setInterim(''); sendMessage(text); },
      onInterim: (text) => setInterim(text),
      onListeningChange: (on) => {
        setListening(on);
        socketRef.current?.send({ t: 'listening', on });
        if (!on) setInterim('');
      },
    });
    voiceRef.current = voice;
    setCanListen(voice.canListen && !IS_ELECTRON);

    const socket = new NexusSocket(handleFrame, (up) => ui.setConnected(up));
    socketRef.current = socket;
    socket.connect();

    // Push-to-talk: hold Space (unless typing in the composer input).
    const isTyping = () => document.activeElement instanceof HTMLInputElement;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !isTyping()) {
        e.preventDefault();
        voice.startListening();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping()) {
        e.preventDefault();
        voice.stopListening();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      socket.close();
      voice.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMic = () => voiceRef.current?.toggleListening();

  return (
    <div className="stage boot">
      <Orb onActivate={canListen ? toggleMic : undefined} />
      {/* Center-stage visual surface — diagrams/charts/widgets NEXUS conjures, which
          dock the orb aside and build in as it narrates. */}
      <Stage />
      {/* The thinking bubble — NEXUS's first-person thought, drifting ABOVE the orb. */}
      {!speaking ? <StatusLine /> : null}
      {/* Text zone BELOW the orb. Mutually exclusive so nothing overlaps:
          NEXUS caption > your live transcript > wake hint. */}
      <div className="stage-text">
        <Caption />
        {!speaking && interim ? <div className="interim">{interim}</div> : null}
        {!speaking && !interim && !status && wakeArmed && !listening ? (
          <div className="wake-hint">say “Hey Nexus”</div>
        ) : null}
      </div>
      <Feed />
      <Rail />
      <Toasts />
      <Conn />
      <Composer onSend={sendMessage} onToggleMic={toggleMic} listening={listening} canListen={canListen} />
      <div className="vignette" />
      <div className="scanlines" />
    </div>
  );
}
