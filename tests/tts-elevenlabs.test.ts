import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtsService } from '../src/web/tts.js';

describe('TtsService (ElevenLabs)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.NEXUS_TTS = ''; // reset the kill-switch (avoid delete — biome noDelete)
  });

  it('is unavailable and returns null with no API key — and never hits the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const tts = new TtsService({});
    expect(tts.available).toBe(false);
    expect(await tts.synthesize('Good evening, Sir.')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('defaults to MP3 output (mime + ext)', () => {
    const tts = new TtsService({ apiKey: 'k' });
    expect(tts.outputMime).toBe('audio/mpeg');
    expect(tts.outputExt).toBe('mp3');
  });

  it('maps a wav_* output format to audio/wav', () => {
    const tts = new TtsService({ apiKey: 'k', outputFormat: 'wav_44100' });
    expect(tts.outputMime).toBe('audio/wav');
    expect(tts.outputExt).toBe('wav');
  });

  it('POSTs to ElevenLabs with the key/model/format and returns the audio buffer', async () => {
    const audio = new Uint8Array([1, 2, 3, 4]).buffer;
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => audio });
    vi.stubGlobal('fetch', fetchSpy);

    const tts = new TtsService({ apiKey: 'secret-key', voiceId: 'VOICE1', modelId: 'model-x' });
    expect(tts.available).toBe(true);
    const buf = await tts.synthesize('Right away, Sir.', 'bright');

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf?.length).toBe(4);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toContain('/text-to-speech/VOICE1');
    expect(url).toContain('output_format=mp3_44100_128');
    expect(opts.method).toBe('POST');
    expect(opts.headers['xi-api-key']).toBe('secret-key');
    const body = JSON.parse(String(opts.body));
    expect(body.model_id).toBe('model-x');
    expect(body.text).toBe('Right away, Sir.');
    expect(body.voice_settings).toBeTruthy();
  });

  it('returns null on a non-ok API response (non-fatal)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) });
    vi.stubGlobal('fetch', fetchSpy);
    const tts = new TtsService({ apiKey: 'bad-key' });
    expect(await tts.synthesize('hello')).toBeNull();
  });

  it('honors NEXUS_TTS=0 as a hard kill switch', async () => {
    process.env.NEXUS_TTS = '0';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const tts = new TtsService({ apiKey: 'k' });
    expect(tts.available).toBe(false);
    expect(await tts.synthesize('hi')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
