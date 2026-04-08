// Media Understanding — Audio transcription
// Uses macOS `whisper` CLI if available, falls back to OpenAI Whisper API.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AudioTranscription');
const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB (OpenAI limit)

export interface TranscriptionResult {
  text: string;
  method: 'whisper-cli' | 'openai-api' | 'unavailable';
  durationHint?: string;
}

/**
 * Transcribe an audio file. Tries local whisper CLI first, then OpenAI Whisper API.
 */
export async function transcribeAudio(
  filePath: string,
  openaiApiKey?: string,
): Promise<TranscriptionResult> {
  // Validate file exists and size
  const info = await stat(filePath);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`Audio file too large: ${(info.size / 1024 / 1024).toFixed(1)} MB (max 25 MB)`);
  }

  // Try local whisper CLI
  try {
    const { stdout } = await execFileAsync('whisper', [filePath, '--output_format', 'txt', '--fp16', 'False'], {
      timeout: 120_000,
    });
    const text = stdout.trim();
    if (text.length > 0) {
      log.info({ filePath, chars: text.length }, 'Transcribed via local whisper CLI');
      return { text, method: 'whisper-cli' };
    }
  } catch {
    // whisper not installed — try API
  }

  // Try OpenAI Whisper API
  if (openaiApiKey) {
    try {
      const buffer = await readFile(filePath);
      const formData = new FormData();
      formData.append('file', new Blob([buffer]), filePath.split('/').pop() ?? 'audio.mp3');
      formData.append('model', 'whisper-1');

      const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openaiApiKey}` },
        body: formData,
        signal: AbortSignal.timeout(120_000),
      });

      if (resp.ok) {
        const data = await resp.json() as { text?: string };
        const text = data.text ?? '';
        log.info({ filePath, chars: text.length }, 'Transcribed via OpenAI Whisper API');
        return { text, method: 'openai-api' };
      }
    } catch (err) {
      log.warn({ err }, 'OpenAI Whisper API failed');
    }
  }

  return {
    text: 'Audio transcription unavailable: install whisper-cli or configure OPENAI_API_KEY',
    method: 'unavailable',
  };
}
