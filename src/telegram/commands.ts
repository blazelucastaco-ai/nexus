// ─── Telegram Command Handlers ────────────────────────────────────────
import type { Bot, Context } from 'grammy';
import type { Orchestrator } from '../core/orchestrator.js';
import { createLogger } from '../utils/logger.js';
import {
  escapeHtml,
  formatAgentList,
  formatError,
  formatHelp,
  formatMemoryStats,
  formatMood,
  formatStatus,
  formatTaskList,
  formatWelcome,
  truncateMessage,
} from './messages.js';

const log = createLogger('TelegramCommands');

// ─── Command Definitions ─────────────────────────────────────────────

export interface BotCommand {
  command: string;
  description: string;
}

/**
 * All NEXUS bot commands with their descriptions.
 * Used to register the command menu in Telegram UI.
 */
export const commands: BotCommand[] = [
  { command: 'start', description: 'Start NEXUS and see welcome message' },
  { command: 'status', description: 'System status and health check' },
  { command: 'screenshot', description: 'Capture and send a screenshot' },
  { command: 'tasks', description: 'List active and recent tasks' },
  { command: 'memory', description: 'Memory layer statistics' },
  { command: 'mood', description: 'Current emotional state' },
  { command: 'agents', description: 'List available agents and status' },
  { command: 'settings', description: 'Show current configuration' },
  { command: 'think', description: 'Inner monologue on a topic' },
  { command: 'stop', description: 'Graceful shutdown' },
  { command: 'help', description: 'Show all available commands' },
];

/**
 * Register all commands with the Telegram Bot API.
 * This sets the command menu visible in the Telegram UI.
 */
export async function setupCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands(
    commands.map(({ command, description }) => ({ command, description })),
  );
}

// ─── /start ──────────────────────────────────────────────────────────

export async function handleStart(ctx: Context): Promise<void> {
  try {
    await ctx.reply(truncateMessage(formatWelcome()), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id }, '/start command');
  } catch (err) {
    log.error({ err }, 'Error in /start');
    await ctx.reply('Welcome to NEXUS! Use /help to see available commands.');
  }
}

// ─── /status ─────────────────────────────────────────────────────────

export async function handleStatus(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    const status = orchestrator.getStatus();
    await ctx.reply(truncateMessage(formatStatus(status)), { parse_mode: 'HTML' });
  } catch (err) {
    log.error({ err }, 'Error in /status');
    await ctx.reply('Failed to retrieve system status.');
  }
}

// ─── /screenshot ─────────────────────────────────────────────────────

export async function handleScreenshot(ctx: Context): Promise<void> {
  try {
    // Dynamic import to avoid hard dependency on macos module at command level
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { readFile } = await import('node:fs/promises');
    const { InputFile } = await import('grammy');

    const execFileAsync = promisify(execFile);
    const screenshotPath = join(tmpdir(), `nexus-screenshot-${Date.now()}.png`);

    await ctx.reply('Capturing screenshot...', { parse_mode: 'HTML' });

    // Use macOS screencapture command
    await execFileAsync('screencapture', ['-x', screenshotPath]);

    const fileData = await readFile(screenshotPath);
    await ctx.replyWithPhoto(new InputFile(fileData, 'screenshot.png'), {
      caption: '<b>Screenshot</b> — captured just now',
      parse_mode: 'HTML',
    });

    // Clean up
    const { unlink } = await import('node:fs/promises');
    await unlink(screenshotPath).catch(() => {});

    log.info({ chatId: ctx.chat?.id }, '/screenshot captured');
  } catch (err) {
    log.error({ err }, 'Error in /screenshot');
    await ctx.reply('Failed to capture screenshot.');
  }
}

// ─── /tasks ──────────────────────────────────────────────────────────

export async function handleTasks(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    const status = orchestrator.getStatus();
    // The orchestrator doesn't expose tasks directly, but we can get them from status
    // For now, show what we have
    const activeTasks = (status.activeTasks as number) ?? 0;

    if (activeTasks === 0) {
      await ctx.reply('<b>Tasks</b>\n\nNo active tasks. All clear.', { parse_mode: 'HTML' });
      return;
    }

    await ctx.reply(
      `<b>Tasks</b>\n\n<b>Active:</b> ${activeTasks}\n\nUse the chat to assign new tasks to any agent.`,
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    log.error({ err }, 'Error in /tasks');
    await ctx.reply('Failed to retrieve task list.');
  }
}

// ─── /memory ─────────────────────────────────────────────────────────

export async function handleMemory(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    if (!orchestrator.memory) {
      await ctx.reply('Memory system not connected.', { parse_mode: 'HTML' });
      return;
    }

    const stats = await orchestrator.memory.getStats();
    await ctx.reply(truncateMessage(formatMemoryStats(stats as unknown as Record<string, unknown>)), {
      parse_mode: 'HTML',
    });
  } catch (err) {
    log.error({ err }, 'Error in /memory');
    await ctx.reply('Failed to retrieve memory statistics.');
  }
}

// ─── /mood ───────────────────────────────────────────────────────────

export async function handleMood(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    if (!orchestrator.personality) {
      await ctx.reply('Personality system not connected.', { parse_mode: 'HTML' });
      return;
    }

    const personalityState = orchestrator.personality.getPersonalityState();
    await ctx.reply(truncateMessage(formatMood(personalityState)), { parse_mode: 'HTML' });
  } catch (err) {
    log.error({ err }, 'Error in /mood');
    await ctx.reply('Failed to retrieve mood state.');
  }
}

// ─── /agents ─────────────────────────────────────────────────────────

export async function handleAgents(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    if (!orchestrator.agents) {
      await ctx.reply('Agent system not connected.', { parse_mode: 'HTML' });
      return;
    }

    const availableAgents = orchestrator.agents.getAvailableAgents();
    const agents = availableAgents.map((agent: { name: string; description: string }) => ({
      name: agent.name,
      description: agent.description,
      enabled: true,
    }));

    await ctx.reply(truncateMessage(formatAgentList(agents)), { parse_mode: 'HTML' });
  } catch (err) {
    log.error({ err }, 'Error in /agents');
    await ctx.reply('Failed to list agents.');
  }
}

// ─── /settings ───────────────────────────────────────────────────────

export async function handleSettings(ctx: Context): Promise<void> {
  try {
    const { loadConfig } = await import('../config.js');
    const config = loadConfig();

    // Redact sensitive fields
    const safeConfig = {
      personality: config.personality,
      memory: config.memory,
      ai: {
        ...config.ai,
        // Don't redact provider/model — just sensitive keys if any
      },
      telegram: {
        botToken: '***REDACTED***',
        allowedUsers: config.telegram.allowedUsers,
      },
      macos: config.macos,
      agents: config.agents,
    };

    const json = JSON.stringify(safeConfig, null, 2);
    const lines = [
      '<b>Current Configuration</b>',
      '',
      `<pre>${escapeHtml(json)}</pre>`,
    ];

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
  } catch (err) {
    log.error({ err }, 'Error in /settings');
    await ctx.reply('Failed to retrieve configuration.');
  }
}

// ─── /think ──────────────────────────────────────────────────────────

export async function handleThink(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    const text = ctx.message?.text ?? '';
    const topic = text.replace(/^\/think\s*/, '').trim();

    if (!topic) {
      await ctx.reply(
        '<b>Usage:</b> <code>/think &lt;topic&gt;</code>\n\nI\'ll share my inner monologue on the given topic.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.replyWithChatAction('typing');

    // Use the orchestrator's AI to generate an inner monologue
    if (!orchestrator.ai) {
      await ctx.reply('AI system not connected.', { parse_mode: 'HTML' });
      return;
    }

    const personalityState = orchestrator.personality?.getPersonalityState();
    const emotionContext = personalityState
      ? `Current mood: ${personalityState.emotionLabel} (valence: ${personalityState.emotion.valence.toFixed(2)})`
      : '';

    const response = await orchestrator.ai.complete({
      messages: [
        {
          role: 'user',
          content: `Think deeply about: "${topic}". Share your genuine inner monologue — your real thoughts, associations, uncertainties, and conclusions. Be authentic, not performative.`,
        },
      ],
      systemPrompt: `You are NEXUS, an AI companion. ${emotionContext}. Share your genuine inner monologue on the given topic. Be reflective, honest, and show your reasoning process. Use first person. Keep it under 500 words.`,
      maxTokens: 1024,
      temperature: 0.8,
    });

    const lines = [
      `<b>Inner Monologue: ${escapeHtml(topic)}</b>`,
      '',
      escapeHtml(response.content),
    ];

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, topic }, '/think command');
  } catch (err) {
    log.error({ err }, 'Error in /think');
    await ctx.reply('Failed to generate inner monologue.');
  }
}

// ─── /stop ───────────────────────────────────────────────────────────

export async function handleStop(ctx: Context): Promise<void> {
  try {
    await ctx.reply(
      '<b>Shutting down NEXUS...</b>\n\nGoodbye. I\'ll be here when you need me.',
      { parse_mode: 'HTML' },
    );

    log.info({ chatId: ctx.chat?.id }, '/stop command — initiating shutdown');

    // Give the message time to send before shutting down
    setTimeout(() => {
      process.emit('SIGTERM', 'SIGTERM');
    }, 1000);
  } catch (err) {
    log.error({ err }, 'Error in /stop');
    await ctx.reply('Failed to initiate shutdown.');
  }
}

// ─── /help ───────────────────────────────────────────────────────────

export async function handleHelp(ctx: Context): Promise<void> {
  try {
    await ctx.reply(truncateMessage(formatHelp()), { parse_mode: 'HTML' });
  } catch (err) {
    log.error({ err }, 'Error in /help');
    await ctx.reply(
      'Available commands:\n' +
        commands.map((c) => `/${c.command} — ${c.description}`).join('\n'),
    );
  }
}
