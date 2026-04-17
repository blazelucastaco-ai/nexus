// Media Understanding — PDF text extraction using pdf-parse
// Extracts text content and metadata from PDF files

import { readFile, stat } from 'node:fs/promises';
import { createLogger } from '../utils/logger.js';

const log = createLogger('PdfParser');

export interface PdfParseResult {
  text: string;
  pageCount: number;
  info: Record<string, unknown>;
  truncated: boolean;
}

const MAX_CHARS = 20_000;
const MAX_PDF_BYTES = 50 * 1024 * 1024; // 50 MB — prevent PDF bomb OOM

/**
 * Parse a PDF file and extract its text content.
 */
export async function parsePdf(filePath: string): Promise<PdfParseResult> {
  const stats = await stat(filePath);
  if (stats.size > MAX_PDF_BYTES) {
    throw new Error(`PDF too large: ${stats.size} bytes (max ${MAX_PDF_BYTES})`);
  }
  const buffer = await readFile(filePath);

  // Dynamic import to avoid bundler issues with pdf-parse
  const pdfModule = await import('pdf-parse');
  const pdfParseFn = ((pdfModule as unknown as { default?: unknown }).default ?? pdfModule) as (buf: Buffer) => Promise<{ text: string; numpages: number; info: unknown }>;
  const result = await pdfParseFn(buffer);

  const fullText = result.text ?? '';
  const truncated = fullText.length > MAX_CHARS;
  const text = truncated ? fullText.slice(0, MAX_CHARS) + '\n[...truncated]' : fullText;

  log.info({ filePath, pageCount: result.numpages, chars: fullText.length }, 'PDF parsed');

  return {
    text,
    pageCount: result.numpages ?? 0,
    info: (result.info as Record<string, unknown>) ?? {},
    truncated,
  };
}

/**
 * Parse a PDF from a URL by downloading it first.
 */
export async function parsePdfFromUrl(url: string): Promise<PdfParseResult> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`Failed to download PDF: HTTP ${resp.status}`);

  // Check content length before buffering to prevent PDF bomb OOM
  const contentLength = resp.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_PDF_BYTES) {
    throw new Error(`PDF too large: ${contentLength} bytes (max ${MAX_PDF_BYTES})`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(`PDF too large: ${buffer.length} bytes (max ${MAX_PDF_BYTES})`);
  }
  const pdfModule2 = await import('pdf-parse');
  const pdfParseFn2 = ((pdfModule2 as unknown as { default?: unknown }).default ?? pdfModule2) as (buf: Buffer) => Promise<{ text: string; numpages: number; info: unknown }>;
  const result = await pdfParseFn2(buffer);

  const fullText = result.text ?? '';
  const truncated = fullText.length > MAX_CHARS;
  const text = truncated ? fullText.slice(0, MAX_CHARS) + '\n[...truncated]' : fullText;

  log.info({ url, pageCount: result.numpages, chars: fullText.length }, 'PDF parsed from URL');

  return {
    text,
    pageCount: result.numpages ?? 0,
    info: (result.info as Record<string, unknown>) ?? {},
    truncated,
  };
}
