// Media Understanding — Image analysis via Anthropic Claude vision
// Accepts image URLs or base64, returns description / extracted text / answers

import Anthropic from '@anthropic-ai/sdk';
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
async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: Anthropic.Base64ImageSource['media_type'] }> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`Failed to fetch image: HTTP ${resp.status}`);
  const contentType = resp.headers.get('content-type') ?? 'image/jpeg';
  const rawMime = contentType.split(';')[0]?.trim() ?? 'image/jpeg';
  // Anthropic only accepts these four MIME types
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
  const mimeType = (allowed.includes(rawMime as any) ? rawMime : 'image/jpeg') as Anthropic.Base64ImageSource['media_type'];
  const buffer = await resp.arrayBuffer();
  const data = Buffer.from(buffer).toString('base64');
  return { data, mimeType };
}

/**
 * Analyze an image using Claude's vision capabilities.
 * Supports URL or base64 input. Uses Claude's native vision — no external APIs needed.
 */
export async function analyzeImage(params: {
  source: string;       // URL or base64 string
  isBase64?: boolean;
  question?: string;    // Optional question about the image
  // Legacy params kept for backward compat — ignored, uses ANTHROPIC_API_KEY
  apiBaseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<ImageAnalysisResult> {
  const { source, isBase64 = false, question } = params;

  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — cannot analyze image');
  }

  const client = new Anthropic({ apiKey: anthropicKey });

  const prompt = question
    ? `Answer this question about the image: ${question}\nAlso provide a brief description of the image.`
    : 'Describe this image in detail. Extract any visible text. Note key objects, people, and context.';

  let imageBlock: Anthropic.ImageBlockParam;

  if (!isBase64 && (source.startsWith('http://') || source.startsWith('https://'))) {
    // Use URL source directly — Claude can fetch public URLs
    imageBlock = {
      type: 'image',
      source: { type: 'url', url: source },
    };
  } else {
    // Base64 — need media type
    let imageData = source;
    let mimeType: Anthropic.Base64ImageSource['media_type'] = 'image/jpeg';

    if (!isBase64) {
      // It's a local file that was already read into base64 by the caller
      imageData = source;
    } else if (source.startsWith('http://') || source.startsWith('https://')) {
      const fetched = await fetchImageAsBase64(source);
      imageData = fetched.data;
      mimeType = fetched.mimeType;
    }

    imageBlock = {
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data: imageData },
    };
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [imageBlock, { type: 'text', text: prompt }],
      },
    ],
  });

  const content = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  log.info({ sourceLen: source.length, hasQuestion: !!question }, 'Image analyzed via Claude vision');

  return {
    description: content,
    answer: question ? content : undefined,
  };
}
