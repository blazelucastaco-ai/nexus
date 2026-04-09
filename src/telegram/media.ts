// ─── Telegram Media Handling ──────────────────────────────────────────
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Bot, Context } from 'grammy';
import { createLogger } from '../utils/logger.js';
import { retryAsync, isTransientError } from '../utils/retry.js';

const log = createLogger('TelegramMedia');

const DOWNLOADS_DIR = join(homedir(), '.nexus', 'downloads');

// ─── Ensure Download Directory ───────────────────────────────────────

async function ensureDownloadsDir(): Promise<void> {
  await mkdir(DOWNLOADS_DIR, { recursive: true });
}

// ─── Build Telegram File Download URL ────────────────────────────────

function buildTelegramFileUrl(ctx: Context, filePath: string): string {
  const token = extractToken(ctx);
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

// ─── Download Any File by ID ─────────────────────────────────────────

/**
 * Download a Telegram file by its file_id to a local destination path.
 * Returns the absolute path of the saved file.
 */
export async function downloadFile(
  bot: Bot,
  fileId: string,
  destPath: string,
): Promise<string> {
  await ensureDownloadsDir();

  const file = await bot.api.getFile(fileId);

  if (!file.file_path) {
    throw new Error(`Telegram returned no file_path for file_id: ${fileId}`);
  }

  // Build the download URL
  // grammy provides a helper but we can also construct it directly
  const token = (bot.api as any).token ?? '';
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);

  log.info({ fileId, destPath, size: buffer.length }, 'File downloaded');
  return destPath;
}

// ─── Photo Handler ───────────────────────────────────────────────────

/**
 * Handle a received photo message.
 * Downloads the highest resolution version as a raw Buffer — no disk write.
 * Retries up to 3 times with exponential backoff on transient errors.
 */
export async function handlePhoto(
  ctx: Context,
): Promise<{ fileId: string; buffer: Buffer; mimeType: string }> {
  const photos = ctx.message?.photo;

  if (!photos || photos.length === 0) {
    throw new Error('No photo found in message');
  }

  // Telegram sends multiple sizes — pick the largest (last in array)
  const largest = photos[photos.length - 1];
  const fileId = largest.file_id;

  const file = await retryAsync(() => ctx.api.getFile(fileId), {
    attempts: 3,
    minDelay: 300,
    maxDelay: 4_000,
    shouldRetry: isTransientError,
  });

  if (!file.file_path) {
    throw new Error('No file_path returned for photo');
  }

  const url = buildTelegramFileUrl(ctx, file.file_path);

  const buffer = await retryAsync(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`Failed to download photo: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }, {
    attempts: 3,
    minDelay: 300,
    maxDelay: 4_000,
    shouldRetry: isTransientError,
  });

  log.info({ fileId, size: buffer.length }, 'Photo downloaded as Buffer');
  return { fileId, buffer, mimeType: 'image/jpeg' };
}

// ─── Document Handler ────────────────────────────────────────────────

/**
 * Handle a received document message.
 * Downloads the file and saves it locally with the original filename.
 */
export async function handleDocument(
  ctx: Context,
): Promise<{ fileId: string; filePath: string; fileName: string }> {
  const document = ctx.message?.document;

  if (!document) {
    throw new Error('No document found in message');
  }

  const fileId = document.file_id;
  const fileName = document.file_name ?? `document_${Date.now()}`;

  await ensureDownloadsDir();

  const destPath = join(DOWNLOADS_DIR, fileName);

  const file = await ctx.api.getFile(fileId);

  if (!file.file_path) {
    throw new Error('No file_path returned for document');
  }

  const token = extractToken(ctx);
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);

  log.info({ fileId, filePath: destPath, fileName }, 'Document downloaded');
  return { fileId, filePath: destPath, fileName };
}

// ─── Voice Handler ───────────────────────────────────────────────────

/**
 * Handle a received voice message.
 * Downloads the voice file (OGG Opus format) and saves it locally.
 */
export async function handleVoice(
  ctx: Context,
): Promise<{ fileId: string; filePath: string; duration: number }> {
  const voice = ctx.message?.voice;

  if (!voice) {
    throw new Error('No voice message found');
  }

  const fileId = voice.file_id;
  const duration = voice.duration;

  await ensureDownloadsDir();

  const filename = `voice_${Date.now()}.ogg`;
  const destPath = join(DOWNLOADS_DIR, filename);

  const file = await ctx.api.getFile(fileId);

  if (!file.file_path) {
    throw new Error('No file_path returned for voice message');
  }

  const token = extractToken(ctx);
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);

  log.info({ fileId, filePath: destPath, duration }, 'Voice message downloaded');
  return { fileId, filePath: destPath, duration };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract the bot token from a Grammy context.
 * Grammy stores it internally — we access it through the API config.
 */
function extractToken(ctx: Context): string {
  // Grammy's api object has a config with the token
  const api = ctx.api as any;
  return api.token ?? api.config?.token ?? '';
}
