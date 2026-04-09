// Media Understanding — Image analysis via Gemini vision endpoint
// Buffer-based pipeline: raw Buffer is passed through, base64 conversion happens
// only at the API call point (matching OpenClaw's proven pattern).

import { createLogger } from '../utils/logger.js';
import { retryAsync, isTransientError } from '../utils/retry.js';

const log = createLogger('ImageUnderstanding');

export interface ImageAnalysisResult {
  description: string;
  extractedText?: string;
  answer?: string;
}

/**
 * Analyze an image using Gemini's vision capabilities via the OpenAI-compat endpoint.
 *
 * Accepts either:
 *  - A raw Buffer (preferred — base64 conversion happens here, at the API call point)
 *  - A URL string (fetched and converted internally)
 *  - A pre-encoded base64 string (isBase64: true)
 */
export async function analyzeImage(params: {
  buffer?: Buffer;
  mimeType?: string;
  source?: string;
  isBase64?: boolean;
  question?: string;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}): Promise<ImageAnalysisResult> {
  const { buffer, mimeType = 'image/jpeg', source, isBase64 = false, question, apiBaseUrl, apiKey, model } = params;

  let imageData: string;
  let resolvedMime = mimeType;

  if (buffer) {
    // Buffer path — convert to base64 here, at the API call point (OpenClaw pattern)
    imageData = buffer.toString('base64');
  } else if (!source) {
    throw new Error('analyzeImage: provide either buffer or source');
  } else if (isBase64) {
    imageData = source;
  } else {
    // URL — fetch and convert to base64
    const resp = await fetch(source, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`Failed to fetch image: HTTP ${resp.status}`);
    const ct = resp.headers.get('content-type') ?? 'image/jpeg';
    resolvedMime = ct.split(';')[0]?.trim() ?? 'image/jpeg';
    imageData = Buffer.from(await resp.arrayBuffer()).toString('base64');
  }

  const prompt = question
    ? `Answer this question about the image: ${question}\nAlso provide a brief description of the image.`
    : 'Describe this image in detail. Extract any visible text. Note key objects, people, and context.';

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:${resolvedMime};base64,${imageData}` },
          },
        ],
      },
    ],
    max_tokens: 1024,
  };

  const baseUrl = apiBaseUrl.replace(/\/$/, '');

  const result = await retryAsync(async () => {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Vision API error: HTTP ${resp.status} — ${errText.slice(0, 200)}`);
    }

    return resp.json() as Promise<{ choices?: Array<{ message?: { content?: string } }> }>;
  }, {
    attempts: 3,
    minDelay: 300,
    maxDelay: 1_200,
    shouldRetry: (err) => {
      if (err instanceof Error && /HTTP (503|429)/.test(err.message)) return true;
      return isTransientError(err);
    },
  });

  const content = result.choices?.[0]?.message?.content ?? '';

  log.info({ hasBuffer: !!buffer, hasQuestion: !!question }, 'Image analyzed');

  return {
    description: content,
    answer: question ? content : undefined,
  };
}
