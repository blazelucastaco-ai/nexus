// Media Understanding — Image analysis via Gemini vision endpoint
// Accepts image URLs or base64, returns description / extracted text / answers

import { createLogger } from '../utils/logger.js';

const log = createLogger('ImageUnderstanding');

export interface ImageAnalysisResult {
  description: string;
  extractedText?: string;
  answer?: string;
}

/**
 * Fetch a remote image and convert to base64.
 */
async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`Failed to fetch image: HTTP ${resp.status}`);
  const contentType = resp.headers.get('content-type') ?? 'image/jpeg';
  const mimeType = contentType.split(';')[0]?.trim() ?? 'image/jpeg';
  const buffer = await resp.arrayBuffer();
  const data = Buffer.from(buffer).toString('base64');
  return { data, mimeType };
}

/**
 * Analyze an image using Gemini's vision capabilities via the OpenAI-compat endpoint.
 * Supports URL or raw base64 input.
 */
export async function analyzeImage(params: {
  source: string;          // URL or base64 string
  isBase64?: boolean;
  question?: string;       // Optional question about the image
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}): Promise<ImageAnalysisResult> {
  const { source, isBase64 = false, question, apiBaseUrl, apiKey, model } = params;

  let imageData: string;
  let mimeType = 'image/jpeg';

  if (isBase64) {
    imageData = source;
  } else {
    const fetched = await fetchImageAsBase64(source);
    imageData = fetched.data;
    mimeType = fetched.mimeType;
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
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${imageData}` },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
    max_tokens: 1024,
  };

  const resp = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Vision API error: HTTP ${resp.status} — ${err.slice(0, 200)}`);
  }

  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? '';

  log.info({ sourceLen: source.length, hasQuestion: !!question }, 'Image analyzed');

  return {
    description: content,
    answer: question ? content : undefined,
  };
}
