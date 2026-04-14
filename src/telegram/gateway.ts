// ─── NEXUS Telegram Gateway ───────────────────────────────────────────
// Main Telegram bot interface — routes messages through the orchestrator.

import { Bot, Context, InputFile } from 'grammy';
import { createLogger } from '../utils/logger.js';
import type { Orchestrator } from '../core/orchestrator.js';
import {
  commands,
  setupCommands,
  handleStart,
  handleStatus,
  handleScreenshot,
  handleTasks,
  handleMemory,
  handleMood,
  handleAgents,
  handleSettings,
  handleWorkspace,
  handleThink,
  handlePreferences,
  handlePatterns,
  handleOpinions,
  handleJournal,
  handleMistakes,
  handleSearch,
  handleForget,
  handlePin,
  handleBriefing,
  handleGrant,
  handleQuiet,
  handleLoud,
  handleStop,
  handleHelp,
} from './commands.js';
import { escapeHtml, markdownToHtml, sanitizePaths, truncateMessage } from './messages.js';
import { handlePhoto, handleDocument, handleVoice } from './media.js';

const log = createLogger('TelegramGateway');

// ─── Types ───────────────────────────────────────────────────────────

interface TelegramGatewayConfig {
  botToken: string;
  chatId: string;
}

type MessageHandler = (text: string, ctx: Context) => Promise<void>;

// ─── TelegramGateway Class ───────────────────────────────────────────

export class TelegramGateway {
  private bot: Bot<Context>;
  private chatId: string;
  private orchestrator: Orchestrator | null = null;
  private messageHandler: MessageHandler | null = null;
  private running = false;

  constructor(config: TelegramGatewayConfig) {
    this.bot = new Bot<Context>(config.botToken);
    this.chatId = config.chatId;

    this.setupMiddleware();
    this.setupCommandHandlers();
    this.setupCallbackQueryHandler();
    this.setupMessageHandler();
    this.setupMediaHandlers();
    this.setupErrorHandler();

    log.info('TelegramGateway instance created');
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Wire the orchestrator for command handlers that need it.
   */
  setOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator;
    log.info('Orchestrator connected to gateway');
  }

  /**
   * Register a custom message handler for all non-command text messages.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Start the bot with long polling.
   */
  async start(): Promise<void> {
    if (this.running) {
      log.warn('Gateway already running');
      return;
    }

    try {
      await setupCommands(this.bot);
      log.info('Bot commands registered with Telegram');
    } catch (err) {
      log.warn({ err }, 'Failed to register commands with Telegram — continuing anyway');
    }

    this.bot.start({
      onStart: () => {
        this.running = true;
        log.info('NEXUS Telegram gateway is polling');
      },
    });
  }

  /**
   * Stop the bot gracefully.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.bot.stop();
    this.running = false;
    log.info('NEXUS Telegram gateway stopped');
  }

  /**
   * Send a text message to a specific chat.
   */
  async sendMessage(
    chatId: string,
    text: string,
    options?: {
      parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
      replyMarkup?: any;
    },
  ): Promise<void> {
    const truncated = truncateMessage(text);

    try {
      await this.bot.api.sendMessage(chatId, truncated, {
        parse_mode: options?.parseMode ?? 'HTML',
        reply_markup: options?.replyMarkup,
      });
    } catch (err) {
      log.error({ err, chatId }, 'Failed to send message with formatting');

      // Retry as plain text on formatting failure
      try {
        const plain = text.replace(/<[^>]+>/g, '').slice(0, 4096);
        await this.bot.api.sendMessage(chatId, plain);
      } catch (retryErr) {
        log.error({ err: retryErr, chatId }, 'Failed to send plain text fallback');
        throw retryErr;
      }
    }
  }

  /**
   * Send a photo to a specific chat.
   */
  async sendPhoto(
    chatId: string,
    photo: Buffer | string,
    caption?: string,
  ): Promise<void> {
    try {
      const input = typeof photo === 'string'
        ? new InputFile(photo)
        : new InputFile(photo, 'image.png');

      await this.bot.api.sendPhoto(chatId, input, {
        caption,
        parse_mode: caption ? 'HTML' : undefined,
      });

      log.info({ chatId }, 'Photo sent');
    } catch (err) {
      log.error({ err, chatId }, 'Failed to send photo');
      throw err;
    }
  }

  /**
   * Send a document to a specific chat.
   */
  async sendDocument(
    chatId: string,
    document: Buffer | string,
    filename?: string,
    caption?: string,
  ): Promise<void> {
    try {
      const input = typeof document === 'string'
        ? new InputFile(document)
        : new InputFile(document, filename ?? 'file');

      await this.bot.api.sendDocument(chatId, input, {
        caption,
        parse_mode: caption ? 'HTML' : undefined,
      });

      log.info({ chatId, filename }, 'Document sent');
    } catch (err) {
      log.error({ err, chatId, filename }, 'Failed to send document');
      throw err;
    }
  }

  /**
   * Send an initial message and return its ID for later editing.
   * Used for streaming: send a placeholder, then edit it as tokens arrive.
   */
  async sendStreamingMessage(chatId: string, initialText: string): Promise<number | null> {
    try {
      const msg = await this.bot.api.sendMessage(chatId, initialText || '▍', {
        parse_mode: undefined, // plain text for streaming — avoids parse errors on partial HTML
      });
      return msg.message_id;
    } catch (err) {
      log.error({ err, chatId }, 'Failed to send streaming message');
      return null;
    }
  }

  /**
   * Edit an existing message's text (for streaming updates).
   * Silently ignores "message is not modified" errors from Telegram.
   */
  async editMessage(chatId: string, messageId: number, text: string): Promise<void> {
    try {
      const truncated = truncateMessage(text);
      await this.bot.api.editMessageText(chatId, messageId, truncated, {
        parse_mode: undefined, // plain text to avoid partial-HTML parse errors
      });
    } catch (err: unknown) {
      // Telegram returns 400 "message is not modified" if text hasn't changed — ignore it
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('message is not modified')) {
        log.debug({ err, chatId, messageId }, 'Failed to edit message');
      }
    }
  }

  /**
   * Finalize a streaming message with proper HTML formatting.
   */
  async finalizeStreamingMessage(chatId: string, messageId: number, text: string): Promise<void> {
    try {
      const truncated = truncateMessage(text);
      await this.bot.api.editMessageText(chatId, messageId, truncated, {
        parse_mode: 'HTML',
      });
    } catch (err: unknown) {
      // If HTML formatting fails, try plain text
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('message is not modified')) {
        try {
          const plain = text.replace(/<[^>]+>/g, '').slice(0, 4096);
          await this.bot.api.editMessageText(chatId, messageId, plain);
        } catch {
          log.debug({ chatId, messageId }, 'Failed to finalize streaming message');
        }
      }
    }
  }

  /**
   * Send a "typing..." indicator to a specific chat.
   */
  async sendTypingAction(chatId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(chatId, 'typing');
    } catch (err) {
      log.error({ err, chatId }, 'Failed to send typing action');
    }
  }

  // ─── Middleware ─────────────────────────────────────────────────

  private setupMiddleware(): void {
    // Auth middleware — validate incoming messages are from allowed chat ID
    this.bot.use(async (ctx, next) => {
      const chatId = String(ctx.chat?.id ?? '');

      // If no chatId is configured, allow all (development mode)
      if (!this.chatId) {
        await next();
        return;
      }

      if (chatId !== this.chatId) {
        log.warn({ chatId, from: ctx.from?.username }, 'Unauthorized access attempt');
        await ctx.reply('Access denied. This bot is private.');
        return;
      }

      await next();
    });
  }

  // ─── Command Routing ───────────────────────────────────────────

  private setupCommandHandlers(): void {
    this.bot.command('start', (ctx) => handleStart(ctx));

    this.bot.command('status', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleStatus(ctx, this.orchestrator);
    });

    this.bot.command('screenshot', (ctx) => handleScreenshot(ctx));

    this.bot.command('tasks', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleTasks(ctx, this.orchestrator);
    });

    this.bot.command('memory', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleMemory(ctx, this.orchestrator);
    });

    this.bot.command('mood', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleMood(ctx, this.orchestrator);
    });

    this.bot.command('agents', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleAgents(ctx, this.orchestrator);
    });

    this.bot.command('settings', (ctx) => handleSettings(ctx));

    this.bot.command('workspace', (ctx) => handleWorkspace(ctx));

    this.bot.command('think', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleThink(ctx, this.orchestrator);
    });

    this.bot.command('preferences', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handlePreferences(ctx, this.orchestrator);
    });

    this.bot.command('patterns', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handlePatterns(ctx, this.orchestrator);
    });

    this.bot.command('opinions', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleOpinions(ctx, this.orchestrator);
    });

    this.bot.command('journal', (ctx) => handleJournal(ctx));

    this.bot.command('mistakes', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleMistakes(ctx, this.orchestrator);
    });

    this.bot.command('search', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleSearch(ctx, this.orchestrator);
    });

    this.bot.command('forget', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleForget(ctx, this.orchestrator);
    });

    this.bot.command('pin', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handlePin(ctx, this.orchestrator);
    });

    this.bot.command('grant', (ctx) => handleGrant(ctx));

    this.bot.command('briefing', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleBriefing(ctx, this.orchestrator);
    });

    this.bot.command('quiet', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleQuiet(ctx, this.orchestrator);
    });

    this.bot.command('loud', (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      return handleLoud(ctx, this.orchestrator);
    });

    this.bot.command('stop', (ctx) => handleStop(ctx));

    this.bot.command('help', (ctx) => handleHelp(ctx));

    // ── Ultra mode approval ────────────────────────────────────────
    this.bot.command('approve', async (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      const chatId = String(ctx.chat.id);
      const args = ctx.message.text.split(' ');
      const planId = args[1]?.trim();
      if (!planId) return ctx.reply('Usage: /approve <plan_id>');
      const ok = await this.orchestrator.approveUltraPlan(planId);
      return ctx.reply(ok
        ? `✅ Plan approved — executing now.`
        : `❌ No pending plan with ID <code>${escapeHtml(planId)}</code>.`,
        { parse_mode: 'HTML' },
      );
    });

    this.bot.command('reject', async (ctx) => {
      if (!this.orchestrator) return ctx.reply('Orchestrator not connected.');
      const args = ctx.message.text.split(' ');
      const planId = args[1]?.trim();
      if (!planId) return ctx.reply('Usage: /reject <plan_id>');
      const ok = this.orchestrator.rejectUltraPlan(planId);
      return ctx.reply(ok ? '🗑️ Plan rejected and discarded.' : `❌ No pending plan with ID <code>${escapeHtml(planId)}</code>.`, { parse_mode: 'HTML' });
    });
  }

  // ─── Callback Query (Inline Keyboard Buttons) ─────────────────

  private setupCallbackQueryHandler(): void {
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);

      try {
        if (data.startsWith('approve:')) {
          const planId = data.slice('approve:'.length);
          if (!this.orchestrator) {
            await ctx.answerCallbackQuery({ text: 'Orchestrator not connected.' });
            return;
          }
          const ok = await this.orchestrator.approveUltraPlan(planId);
          if (ok) {
            await ctx.answerCallbackQuery({ text: '✅ Plan approved — executing now.' });
            // Edit the original message to remove the buttons
            try {
              await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
            } catch { /* ignore if already edited */ }
            await this.bot.api.sendMessage(chatId, '✅ Plan approved — running task now…', { parse_mode: 'HTML' });
          } else {
            await ctx.answerCallbackQuery({ text: '❌ Plan not found — may have already been processed.' });
          }
        } else if (data.startsWith('reject:')) {
          const planId = data.slice('reject:'.length);
          if (!this.orchestrator) {
            await ctx.answerCallbackQuery({ text: 'Orchestrator not connected.' });
            return;
          }
          const ok = this.orchestrator.rejectUltraPlan(planId);
          if (ok) {
            await ctx.answerCallbackQuery({ text: '🗑️ Plan rejected.' });
            try {
              await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
            } catch { /* ignore */ }
            await this.bot.api.sendMessage(chatId, '🗑️ Plan rejected and discarded.', { parse_mode: 'HTML' });
          } else {
            await ctx.answerCallbackQuery({ text: '❌ Plan not found — may have already been processed.' });
          }
        } else {
          await ctx.answerCallbackQuery();
        }
      } catch (err) {
        log.error({ err, data, chatId }, 'Callback query handler failed');
        await ctx.answerCallbackQuery({ text: 'An error occurred.' }).catch(() => {});
      }
    });
  }

  // ─── Message Handling ──────────────────────────────────────────

  private setupMessageHandler(): void {
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;

      // Ignore commands (already handled above)
      if (text.startsWith('/')) return;

      const chatId = String(ctx.chat.id);
      log.info({ chatId, textLen: text.length }, 'Incoming message');

      // Show typing indicator
      await ctx.replyWithChatAction('typing');

      // Use custom handler if registered
      if (this.messageHandler) {
        try {
          await this.messageHandler(text, ctx);
          return;
        } catch (err) {
          log.error({ err, chatId }, 'Custom message handler failed');
        }
      }

      // Default: route through orchestrator with live status updates
      if (this.orchestrator) {
        try {
          // ── Status message: shows what NEXUS is doing in real-time ──────────
          let statusMsgId: number | null = null;
          let lastStatusText = '';
          let lastStatusEditTime = 0;
          const STATUS_THROTTLE_MS = 1200; // Telegram rate-limit: don't edit faster than this

          statusMsgId = await this.sendStreamingMessage(chatId, '⏳');

          const onStatus = (status: string) => {
            if (!statusMsgId || status === lastStatusText) return;
            const now = Date.now();
            if (now - lastStatusEditTime < STATUS_THROTTLE_MS) return;
            lastStatusText = status;
            lastStatusEditTime = now;
            this.editMessage(chatId, statusMsgId!, status).catch(() => {});
          };

          // ── Response message: streams the final answer as it arrives ────────
          let responseMsgId: number | null = null;
          let responseBuffer = '';
          let lastResponseEditTime = 0;
          const RESPONSE_THROTTLE_MS = 900;

          const onToken = (chunk: string) => {
            responseBuffer += chunk;
            const now = Date.now();
            if (now - lastResponseEditTime < RESPONSE_THROTTLE_MS) return;
            lastResponseEditTime = now;

            if (!responseMsgId) {
              // Create the response message on first token
              this.sendStreamingMessage(chatId, responseBuffer + ' ▍')
                .then((id) => { responseMsgId = id; })
                .catch(() => {});
            } else {
              this.editMessage(chatId, responseMsgId, responseBuffer.slice(0, 4000) + ' ▍').catch(() => {});
            }
          };

          const response = await this.orchestrator.handleMessage(chatId, text, onToken, onStatus);
          const formatted = markdownToHtml(sanitizePaths(response));

          if (responseMsgId) {
            // Finalize the response message that was already streaming
            await this.finalizeStreamingMessage(chatId, responseMsgId, formatted);
            // Update status to show done (keep it compact)
            if (statusMsgId) await this.editMessage(chatId, statusMsgId, lastStatusText || '✅');
          } else if (responseBuffer.length > 0) {
            // Tokens arrived but message wasn't created yet — create it now
            await this.sendMessage(chatId, formatted);
            if (statusMsgId) await this.editMessage(chatId, statusMsgId, lastStatusText || '✅');
          } else {
            // No streaming at all (tool-only response, no LLM tokens) — send as new message
            await this.sendMessage(chatId, formatted);
            if (statusMsgId) await this.editMessage(chatId, statusMsgId, lastStatusText || '✅');
          }
        } catch (err) {
          log.error({ err, chatId }, 'Orchestrator message handling failed');
          await ctx.reply('Something went wrong processing your message. I\'ll look into it.');
        }
        return;
      }

      await ctx.reply('NEXUS is starting up. Please try again in a moment.');
    });
  }

  // ─── Media Handling ────────────────────────────────────────────

  private setupMediaHandlers(): void {
    // Photo handler
    this.bot.on('message:photo', async (ctx) => {
      try {
        const result = await handlePhoto(ctx);

        if (this.orchestrator) {
          const caption = ctx.message.caption;
          const chatId = String(ctx.chat.id);
          const question = caption
            ? caption
            : 'Describe this image in detail.';
          const response = await this.orchestrator.handleMessage(
            chatId,
            `[PHOTO] ${result.filePath}${caption ? `\n${caption}` : ''}`,
          );
          await this.sendMessage(chatId, markdownToHtml(sanitizePaths(response)));
        } else {
          await ctx.reply(
            `<b>Photo received</b>\nSaved to: <code>${escapeHtml(result.filePath)}</code>`,
            { parse_mode: 'HTML' },
          );
        }
      } catch (err) {
        log.error({ err }, 'Failed to process photo');
        await ctx.reply('Failed to process the photo.');
      }
    });

    // Sticker handler — acknowledge gracefully
    this.bot.on('message:sticker', async (ctx) => {
      await ctx.reply('Nice sticker! Send me a photo if you want me to analyze an image.');
    });

    // Document handler
    this.bot.on('message:document', async (ctx) => {
      try {
        const result = await handleDocument(ctx);
        await ctx.reply(
          `<b>Document received</b>\nFile: <code>${escapeHtml(result.fileName)}</code>\nSaved to: <code>${escapeHtml(result.filePath)}</code>`,
          { parse_mode: 'HTML' },
        );

        if (this.orchestrator) {
          const caption = ctx.message.caption ?? `User sent a document: ${result.fileName}`;
          const chatId = String(ctx.chat.id);
          const response = await this.orchestrator.handleMessage(
            chatId,
            `[Document received: ${result.filePath}] ${caption}`,
          );
          await this.sendMessage(chatId, markdownToHtml(sanitizePaths(response)));
        }
      } catch (err) {
        log.error({ err }, 'Failed to process document');
        await ctx.reply('Failed to process the document.');
      }
    });

    // Voice handler
    this.bot.on('message:voice', async (ctx) => {
      try {
        const result = await handleVoice(ctx);
        await ctx.reply(
          `<b>Voice message received</b>\nDuration: ${result.duration}s\nSaved to: <code>${escapeHtml(result.filePath)}</code>`,
          { parse_mode: 'HTML' },
        );

        if (this.orchestrator) {
          const chatId = String(ctx.chat.id);
          const response = await this.orchestrator.handleMessage(
            chatId,
            `[Voice message received: ${result.filePath}, duration: ${result.duration}s]`,
          );
          await this.sendMessage(chatId, markdownToHtml(sanitizePaths(response)));
        }
      } catch (err) {
        log.error({ err }, 'Failed to process voice message');
        await ctx.reply('Failed to process the voice message.');
      }
    });
  }

  // ─── Error Handling ────────────────────────────────────────────

  private setupErrorHandler(): void {
    this.bot.catch((err) => {
      const ctx = err.ctx;
      const error = err.error;

      log.error(
        { err: error, updateId: ctx?.update?.update_id },
        'Unhandled bot error',
      );

      // Try to notify the user
      try {
        ctx?.reply('An unexpected error occurred. I\'m recovering...');
      } catch {
        // Swallow — if we can't even reply, just log it
      }
    });
  }
}

export default TelegramGateway;
