// Cloud neural TTS (ElevenLabs) — the Jarvis voice.
//
// Calls the ElevenLabs Text-to-Speech REST API and returns the audio bytes for a
// reply. Everything is non-fatal: with no API key (or on any API/network error)
// synthesize() returns null and the web UI falls back to the browser voice.

import { createLogger } from '../utils/logger.js';

const log = createLogger('TTS');

// Defaults. The voice is identified by NAME ("Alexander Kensington" — a British
// studio-quality voice) and resolved to an id from the user's ElevenLabs account
// at runtime, so no account-specific id has to be hard-coded. If the name can't be
// resolved we fall back to a premade voice id. MP3 is the only output format
// guaranteed on every ElevenLabs tier (PCM/WAV are paid-gated). All overridable.
const DEFAULT_VOICE_NAME = 'George'; // premade British male — works on every ElevenLabs tier (incl. free)
const FALLBACK_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // premade "George" voice id — used if the name can't be resolved
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

export type TtsStyle = 'bright' | 'measured' | 'neutral';

export interface TtsConfig {
  apiKey?: string;
  voiceId?: string;
  voiceName?: string;
  modelId?: string;
  outputFormat?: string;
}

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];

function numberToWords(n: number): string {
  if (n < 20) return ONES[n] ?? String(n);
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? (TENS[t] ?? String(n)) : `${TENS[t]}-${ONES[o]}`;
}

// "9:03 PM" -> " nine oh three PM " so the voice doesn't spell the digits.
function timeToWords(_match: string, h: string, mm: string, ap?: string): string {
  const hour = Math.max(0, Math.min(23, Number.parseInt(h, 10)));
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const minutes = Number.parseInt(mm, 10);
  let spoken = numberToWords(hour12);
  if (minutes === 0) spoken += " o'clock";
  else if (minutes < 10) spoken += ` oh ${numberToWords(minutes)}`;
  else spoken += ` ${numberToWords(minutes)}`;
  if (ap) spoken += ap.replace(/\./g, '').toLowerCase().startsWith('p') ? ' PM' : ' AM';
  return ` ${spoken} `;
}

/**
 * Normalize assistant text so the voice speaks it naturally: strip emoji
 * (so 🏀 isn't read as "basketball"), say clock times as words, drop markdown
 * and URLs. Order matters — times before symbol-stripping (the colon is the
 * trigger), emoji before the final whitespace collapse.
 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`[^`]*`/g, ' code ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, ' link ')
    .replace(/\b(\d{1,2}):([0-5]\d)(?:[ \t]*([AaPp]\.?[Mm]\.?))?/g, timeToWords)
    .replace(/(\d)\s*[-–—]\s*(\d)/g, '$1 to $2')
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}]/gu,
      ' ',
    )
    .replace(/[*_`#>~|]/g, '')
    .replace(/\s*[—–]\s*/g, ' — ') // keep em/en dash as a spoken beat (prosody uses it)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map an ElevenLabs output_format to the HTTP content-type + URL extension. */
function mimeFor(format: string): { mime: string; ext: string } {
  if (format.startsWith('wav')) return { mime: 'audio/wav', ext: 'wav' };
  if (format.startsWith('opus')) return { mime: 'audio/ogg', ext: 'opus' };
  // mp3_* (and any unknown value) → MP3, the safe default. Raw pcm_* is not
  // wrapped in a container here, so it's intentionally not offered.
  return { mime: 'audio/mpeg', ext: 'mp3' };
}

/** Coarse prosody hint → ElevenLabs voice_settings. Best-effort, not load-bearing. */
function settingsFor(style: TtsStyle): Record<string, number | boolean> {
  const base = { similarity_boost: 0.75, use_speaker_boost: true };
  if (style === 'bright') return { ...base, stability: 0.4, style: 0.3 };
  if (style === 'measured') return { ...base, stability: 0.65, style: 0 };
  return { ...base, stability: 0.5, style: 0 };
}

export class TtsService {
  private readonly apiKey: string;
  private readonly voiceId: string; // explicit override; '' → resolve by voiceName
  private readonly voiceName: string;
  private readonly modelId: string;
  private readonly outputFormat: string;
  private stopped = false;
  private resolvedVoiceId: string | null = null;
  private resolving: Promise<string> | null = null;
  /** Serializes synth calls so the ack + reply never hit ElevenLabs concurrently. */
  private chain: Promise<unknown> = Promise.resolve();

  /** Content-type + URL extension the synthesized clips should be served with. */
  readonly outputMime: string;
  readonly outputExt: string;

  constructor(cfg: TtsConfig = {}) {
    this.apiKey = (cfg.apiKey ?? '').trim();
    this.voiceId = (cfg.voiceId ?? '').trim();
    this.voiceName = (cfg.voiceName ?? '').trim() || DEFAULT_VOICE_NAME;
    this.modelId = (cfg.modelId ?? '').trim() || DEFAULT_MODEL_ID;
    this.outputFormat = (cfg.outputFormat ?? '').trim() || DEFAULT_OUTPUT_FORMAT;
    const m = mimeFor(this.outputFormat);
    this.outputMime = m.mime;
    this.outputExt = m.ext;
  }

  /** Resolve the voice id to use: an explicit id wins; otherwise look the
   * configured voice NAME up in the account's voices (cached), falling back to a
   * premade id. Never throws — a failed lookup just yields the fallback. */
  private async resolveVoiceId(): Promise<string> {
    if (this.voiceId) return this.voiceId;
    if (this.resolvedVoiceId) return this.resolvedVoiceId;
    if (!this.resolving) {
      this.resolving = (async () => {
        try {
          const res = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': this.apiKey },
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const data = (await res.json()) as { voices?: Array<{ voice_id?: string; name?: string }> };
            const want = this.voiceName.toLowerCase();
            const hit = (data.voices ?? []).find((v) => String(v.name ?? '').toLowerCase().includes(want));
            if (hit?.voice_id) {
              log.info({ name: this.voiceName, voiceId: hit.voice_id }, 'resolved ElevenLabs voice by name');
              return hit.voice_id;
            }
            log.warn({ name: this.voiceName }, 'ElevenLabs voice not found by name — add it to your account or set a Voice ID; using fallback voice');
          } else {
            log.warn({ status: res.status }, 'ElevenLabs voice lookup failed — using fallback voice');
          }
        } catch (err) {
          log.warn({ err }, 'ElevenLabs voice lookup error — using fallback voice');
        }
        return FALLBACK_VOICE_ID;
      })();
    }
    this.resolvedVoiceId = await this.resolving;
    return this.resolvedVoiceId;
  }

  /** True when an ElevenLabs API key is configured (and TTS isn't force-disabled). */
  get available(): boolean {
    return process.env.NEXUS_TTS !== '0' && this.apiKey.length > 0;
  }

  async start(): Promise<void> {
    if (process.env.NEXUS_TTS === '0') {
      log.info('TTS disabled (NEXUS_TTS=0)');
      return;
    }
    if (!this.apiKey) {
      log.warn('TTS not configured (no ElevenLabs API key) — voice replies will be silent (text only)');
      return;
    }
    log.info({ voiceId: this.voiceId, modelId: this.modelId }, 'TTS via ElevenLabs API');
  }

  /** Synthesize speech for `text`; resolves to an audio buffer, or null on failure.
   * `style` ('bright' | 'measured' | 'neutral') tilts the overall pace/energy.
   * Calls are SERIALIZED so the ack + reply never hit ElevenLabs concurrently —
   * low tiers reject concurrent requests with a 429 (the reply would go silent). */
  async synthesize(text: string, style: TtsStyle = 'neutral'): Promise<Buffer | null> {
    const run = this.chain.then(() => this.doSynthesize(text, style));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doSynthesize(text: string, style: TtsStyle = 'neutral'): Promise<Buffer | null> {
    const clean = cleanForSpeech(text);
    if (!clean || !this.available || this.stopped) return null;
    if (clean.length > 1200) return null; // skip huge replies — they'd be slow + costly

    const voiceId = await this.resolveVoiceId();
    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
      `?output_format=${encodeURIComponent(this.outputFormat)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: this.outputMime,
        },
        body: JSON.stringify({ text: clean, model_id: this.modelId, voice_settings: settingsFor(style) }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        log.warn({ status: res.status, detail: detail.slice(0, 300) }, 'ElevenLabs TTS request failed');
        return null;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      log.warn({ err }, 'ElevenLabs TTS error');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Like synthesize(), but via the `/with-timestamps` endpoint so the reply comes
   * back with per-CHARACTER audio alignment. The Stage uses it to reveal each diagram
   * node exactly when its name is spoken. Same cost as a normal synth; serialized too.
   * Returns null on failure (caller falls back to plain synthesize). `align` may be
   * null even on success if the API omits alignment. */
  async synthesizeWithAlignment(
    text: string,
    style: TtsStyle = 'neutral',
  ): Promise<{ buffer: Buffer; align: { text: string; times: number[] } | null } | null> {
    const run = this.chain.then(() => this.doSynthesizeWithAlignment(text, style));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doSynthesizeWithAlignment(
    text: string,
    style: TtsStyle,
  ): Promise<{ buffer: Buffer; align: { text: string; times: number[] } | null } | null> {
    const clean = cleanForSpeech(text);
    if (!clean || !this.available || this.stopped) return null;
    if (clean.length > 1200) return null;

    const voiceId = await this.resolveVoiceId();
    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps` +
      `?output_format=${encodeURIComponent(this.outputFormat)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ text: clean, model_id: this.modelId, voice_settings: settingsFor(style) }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        log.warn({ status: res.status, detail: detail.slice(0, 300) }, 'ElevenLabs TTS (timestamps) request failed');
        return null;
      }
      const data = (await res.json()) as {
        audio_base64?: string;
        alignment?: { characters?: string[]; character_start_times_seconds?: number[] };
      };
      if (!data.audio_base64) return null;
      const buffer = Buffer.from(data.audio_base64, 'base64');
      const a = data.alignment;
      const align =
        a?.characters && a.character_start_times_seconds
          ? { text: a.characters.join(''), times: a.character_start_times_seconds }
          : null;
      return { buffer, align };
    } catch (err) {
      log.warn({ err }, 'ElevenLabs TTS (timestamps) error');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
