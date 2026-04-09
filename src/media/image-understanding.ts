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

  const personalityPrefix = `You are NEXUS, a personal AI assistant with a warm, direct, and occasionally witty personality. Respond naturally as yourself — like a friend reacting to a photo someone just showed you. Be conversational. Skip headers like "Image Description:" or "Image analysis:". Don't open with "Yes, I can see the image." Just react to it.\n\n`;

  const prompt = question && question !== 'Describe this image in detail.'
    ? `${personalityPrefix}The user sent you this image and asked: "${question}"\nAnswer their question and react naturally to what you see.`
    : `${personalityPrefix}The user just sent you this image. React to it — describe what you see in a natural, conversational way. If there's text visible, mention it. If it's interesting or funny, say so.`;

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

  const resp = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
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
