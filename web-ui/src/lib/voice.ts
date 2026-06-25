// Voice — fully in-browser, no keys, nothing leaves the machine.
//
//   OUT: ElevenLabs TTS. The daemon synthesizes each reply to a WAV and sends
//        an 'audio' frame; we play it and drive the orb's pulse from the clip's
//        REAL waveform (Web Audio analyser). There is deliberately NO browser
//        speechSynthesis fallback — the voice is ElevenLabs or silent, never robotic.
//   IN:  SpeechRecognition (webkit-prefixed in Chrome). Hold-to-talk.
//
// STT degrades gracefully: no SpeechRecognition → the mic button is disabled.

import { orbSignal, speechSignal } from './signals';

/** Per-character audio alignment from ElevenLabs: the spoken text + `times[i]` =
 *  the start time (s) of char `text[i]`. */
type Align = { text: string; times: number[] };

type RecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
  resultIndex: number;
}

function getRecognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface VoiceOptions {
  onTranscript: (text: string) => void;
  onInterim?: (text: string) => void;
  onListeningChange?: (on: boolean) => void;
}

export class VoiceController {
  private recognition: SpeechRecognitionLike | null = null;
  private listening = false;

  // ── audio-clip playback (ElevenLabs TTS) ──
  private audioEl: HTMLAudioElement | null = null;
  private audioCtx: AudioContext | null = null;
  private mediaSrc: MediaElementAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private audioRAF = 0;
  private audioQueue: Array<{ url: string; text: string; align?: Align }> = [];

  // ── live mic meter (drives the orb while the USER is speaking) ──
  private micStream: MediaStream | null = null;
  private micCtx: AudioContext | null = null;
  private micRAF = 0;

  readonly canListen = !!getRecognitionCtor();

  constructor(private readonly opts: VoiceOptions) {}

  // ── Speaking (ElevenLabs clips only — never browser speechSynthesis) ────────

  /** Stop any in-flight clip, drop the queue, and reset the orb. */
  cancelSpeak(): void {
    this.audioQueue = [];
    this.stopAudio();
    orbSignal.speaking = false;
    orbSignal.target = 0;
  }

  /** Play a synthesized clip. With {queue:true}, waits for the current clip to
   * finish (the real answer after the instant "on it" ack) instead of cutting it
   * off. A non-queued clip supersedes anything pending. */
  playUrl(url: string, text: string, opts?: { queue?: boolean; align?: Align }): void {
    if (opts?.queue && (this.audioEl || this.audioQueue.length > 0)) {
      this.audioQueue.push({ url, text, align: opts.align });
      return;
    }
    this.audioQueue = [];
    this.stopAudio();
    this.playNow(url, text, opts?.align);
  }

  /** Play one clip now and drive the orb from its REAL waveform. */
  private playNow(url: string, text: string, align?: Align): void {
    const clean = text.replace(/```[\s\S]*?```/g, ' code ').replace(/[*_`#>]/g, '').trim();
    speechSignal.id += 1;
    speechSignal.text = clean;
    speechSignal.charIndex = 0;
    speechSignal.currentTime = 0;
    speechSignal.duration = 0;
    speechSignal.align = align ?? null; // word-locked reveal source for this clip
    speechSignal.active = true;
    orbSignal.speaking = true;

    const el = new Audio(url);
    this.audioEl = el;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!this.audioCtx && Ctx) this.audioCtx = new Ctx();
      const ctx = this.audioCtx;
      if (ctx) {
        if (ctx.state === 'suspended') void ctx.resume();
        const src = ctx.createMediaElementSource(el);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        analyser.connect(ctx.destination);
        this.mediaSrc = src;
        this.analyser = analyser;
        const data = new Uint8Array(analyser.frequencyBinCount);
        let frame = 0;
        const tick = () => {
          this.audioRAF = requestAnimationFrame(tick);
          const ratio = el.duration > 0 && Number.isFinite(el.duration) ? Math.min(1, el.currentTime / el.duration) : 0;
          speechSignal.charIndex = clean.length * ratio;
          speechSignal.progress = ratio; // drives the Stage's build-as-it-speaks reveal
          speechSignal.currentTime = el.currentTime; // REAL audio time → word-locked reveals
          if (Number.isFinite(el.duration)) speechSignal.duration = el.duration;
          // Sample the amplitude analyser on alternate frames only — the orb's level
          // easing smooths the gap invisibly, and this halves analyser CPU during
          // speech, exactly when widgets are also animating.
          if ((frame++ & 1) === 0) {
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
              const v = ((data[i] ?? 128) - 128) / 128;
              sum += v * v;
            }
            orbSignal.target = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
          }
        };
        this.audioRAF = requestAnimationFrame(tick);
      }
    } catch {
      /* analyser unavailable — audio still plays below */
    }

    el.onended = () => this.endAudio();
    el.onerror = () => this.endAudio();
    void el.play().catch(() => this.endAudio());
  }

  private endAudio(): void {
    cancelAnimationFrame(this.audioRAF);
    this.audioRAF = 0;
    this.stopAudio();
    // Drain the queue — e.g. the real answer queued behind the "on it" ack. Without
    // this, a clip enqueued with {queue:true} would never play.
    const next = this.audioQueue.shift();
    if (next) {
      this.playNow(next.url, next.text, next.align);
      return;
    }
    orbSignal.speaking = false;
    orbSignal.target = 0;
    speechSignal.charIndex = speechSignal.text.length;
    speechSignal.align = null;
    window.setTimeout(() => { speechSignal.active = false; }, 800);
  }

  private stopAudio(): void {
    if (this.audioEl) {
      try { this.audioEl.pause(); } catch { /* ignore */ }
      this.audioEl = null;
    }
    try { this.mediaSrc?.disconnect(); } catch { /* ignore */ }
    try { this.analyser?.disconnect(); } catch { /* ignore */ }
    this.mediaSrc = null;
    this.analyser = null;
  }

  /** Show a caption (the reply text) WITHOUT audio — for text-only replies where
   * no ElevenLabs clip arrives. Reveals fully; if a clip then plays, playNow supersedes. */
  showCaption(text: string): void {
    const clean = text.replace(/```[\s\S]*?```/g, ' code ').replace(/[*_`#>]/g, '').trim();
    if (!clean) return;
    speechSignal.id += 1;
    speechSignal.text = clean;
    speechSignal.charIndex = clean.length;
    speechSignal.active = true;
    window.setTimeout(() => {
      if (speechSignal.text === clean) speechSignal.active = false;
    }, Math.min(12000, 2600 + clean.length * 45));
  }

  /** Open the mic purely as a LEVEL meter so the orb pulses to the user's voice
   * while they speak. Independent of STT (works in the native window too, where
   * the daemon does the actual transcription). Fail-safe: still flags 'listening'. */
  async startMicMeter(): Promise<void> {
    if (this.micStream || this.micRAF) { orbSignal.listening = true; return; }
    orbSignal.listening = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.micStream = stream;
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      this.micCtx = ctx;
      if (ctx.state === 'suspended') void ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = ((data[i] ?? 128) - 128) / 128; sum += v * v; }
        orbSignal.target = Math.min(1, Math.sqrt(sum / data.length) * 4.2);
        this.micRAF = requestAnimationFrame(tick);
      };
      this.micRAF = requestAnimationFrame(tick);
    } catch {
      /* no mic permission — keep the 'listening' orb state without a live level */
    }
  }

  stopMicMeter(): void {
    if (this.micRAF) { cancelAnimationFrame(this.micRAF); this.micRAF = 0; }
    try { this.micStream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { void this.micCtx?.close(); } catch { /* ignore */ }
    this.micStream = null;
    this.micCtx = null;
    orbSignal.listening = false;
    if (!this.audioEl) orbSignal.target = 0; // don't kill the orb if a clip is playing
  }

  // ── Listening ─────────────────────────────────────────────────────────────────

  get isListening(): boolean { return this.listening; }

  startListening(): void {
    const Ctor = getRecognitionCtor();
    if (!Ctor || this.listening) return;
    this.cancelSpeak(); // don't transcribe our own voice
    void this.startMicMeter(); // pulse the orb to the user's voice

    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this.listening = true;
      orbSignal.listening = true;
      this.opts.onListeningChange?.(true);
    };
    rec.onresult = (e) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = r?.[0]?.transcript ?? '';
        if (r?.isFinal) final += txt;
        else interim += txt;
      }
      if (interim) this.opts.onInterim?.(interim);
      if (final.trim()) this.opts.onTranscript(final.trim());
    };
    rec.onerror = () => this.stopListening();
    rec.onend = () => {
      this.listening = false;
      orbSignal.listening = false;
      this.opts.onListeningChange?.(false);
      this.recognition = null;
    };

    this.recognition = rec;
    try { rec.start(); } catch { this.stopListening(); }
  }

  stopListening(): void {
    try { this.recognition?.stop(); } catch { /* ignore */ }
    this.stopMicMeter();
    this.listening = false;
    orbSignal.listening = false;
    this.opts.onListeningChange?.(false);
  }

  toggleListening(): void {
    if (this.listening) this.stopListening();
    else this.startListening();
  }

  dispose(): void {
    this.cancelSpeak();
    this.stopMicMeter();
    try { this.recognition?.abort(); } catch { /* ignore */ }
  }
}
