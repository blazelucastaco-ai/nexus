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
  { command: 'workspace', description: 'List contents of the NEXUS workspace folder' },
  { command: 'think', description: 'Toggle think mode, or /think <topic> for one-shot inner monologue' },
  { command: 'preferences', description: 'What I\'ve learned about your preferences' },
  { command: 'patterns', description: 'Behavioral patterns I\'ve detected' },
  { command: 'opinions', description: 'My current opinions and stances' },
  { command: 'journal', description: 'Recent tool activity log' },
  { command: 'mistakes', description: 'Mistakes I\'ve tracked and learned from' },
  { command: 'search', description: 'Search memories — /search <query>' },
  { command: 'forget', description: 'Delete memories about a topic — /forget <topic>' },
  { command: 'pin', description: 'Pin a memory so it never decays — /pin <topic>' },
  { command: 'grant', description: 'Trigger macOS permission dialog — /grant contacts|messages' },
  { command: 'briefing', description: 'Send today\'s morning briefing now' },
  { command: 'quiet', description: 'Disable proactive system alerts' },
  { command: 'loud', description: 'Enable proactive system alerts' },
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
    await unlink(screenshotPath).catch((err) => log.debug({ err, screenshotPath }, 'Failed to clean up screenshot temp file'));

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
      if (!orchestrator.innerMonologue) {
        await ctx.reply('Inner monologue module not initialized.', { parse_mode: 'HTML' });
        return;
      }
      const newState = orchestrator.innerMonologue.toggleThinkMode();
      const icon = newState ? '💭' : '🔇';
      const statusLine = newState
        ? '<b>Think mode ON</b> — I\'ll prefix each response with my inner monologue.'
        : '<b>Think mode OFF</b> — responses are clean again.';
      await ctx.reply(`${icon} ${statusLine}`, { parse_mode: 'HTML' });
      log.info({ chatId: ctx.chat?.id, thinkMode: newState }, '/think toggle');
      return;
    }

    await ctx.replyWithChatAction('typing');

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
      `💭 <b>Inner Monologue: ${escapeHtml(topic)}</b>`,
      '',
      escapeHtml(response.content),
    ];

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, topic }, '/think one-shot');
  } catch (err) {
    log.error({ err }, 'Error in /think');
    await ctx.reply('Failed to generate inner monologue.');
  }
}

// ─── /preferences ────────────────────────────────────────────────────

export async function handlePreferences(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    if (!orchestrator.learning) {
      await ctx.reply('Learning system not connected.', { parse_mode: 'HTML' });
      return;
    }

    const prefs = orchestrator.learning.preferences.getAllPreferences();

    const lines: string[] = ['<b>What I\'ve learned about you</b>\n'];

    if (prefs.length === 0) {
      lines.push('<i>Not enough data yet — keep chatting and I\'ll pick up on your preferences.</i>');
    } else {
      for (const p of prefs) {
        const bar = confidenceBar(p.confidence);
        lines.push(`${bar} <b>${escapeHtml(p.category)}</b>`);
        lines.push(`   → ${escapeHtml(p.value)}`);
        lines.push(`   <i>${Math.round(p.confidence * 100)}% confident</i>`);
        lines.push('');
      }
    }

    // Also pull stored preference facts from semantic memory
    try {
      const storedFacts = orchestrator.memory.semantic.getPreferences().slice(0, 5);
      if (storedFacts.length > 0 && prefs.length === 0) {
        lines.push('<b>Stored facts:</b>');
        for (const f of storedFacts) {
          lines.push(`• <code>${escapeHtml(f.key)}</code>: ${escapeHtml(f.value)}`);
        }
      }
    } catch {
      // semantic memory may not be accessible
    }

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, prefCount: prefs.length }, '/preferences command');
  } catch (err) {
    log.error({ err }, 'Error in /preferences');
    await ctx.reply('Failed to retrieve preferences.');
  }
}

// ─── /patterns ───────────────────────────────────────────────────────

export async function handlePatterns(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    if (!orchestrator.learning) {
      await ctx.reply('Learning system not connected.', { parse_mode: 'HTML' });
      return;
    }

    const temporal = orchestrator.learning.patterns.detectTemporalPatterns();
    const sequences = orchestrator.learning.patterns.detectSequencePatterns();
    const prefPatterns = orchestrator.learning.patterns.detectPreferencePatterns();

    const lines: string[] = ['<b>Patterns I\'ve detected</b>\n'];

    if (temporal.length === 0 && sequences.length === 0 && prefPatterns.length === 0) {
      lines.push('<i>Not enough activity yet to detect patterns. Keep using NEXUS and I\'ll start recognizing your habits.</i>');
    } else {
      if (temporal.length > 0) {
        lines.push('⏰ <b>Timing patterns:</b>');
        for (const t of temporal.slice(0, 5)) {
          const pct = Math.round(t.confidence * 100);
          lines.push(`  • ${escapeHtml(t.pattern)} <i>(${pct}%)</i>`);
        }
        lines.push('');
      }

      if (sequences.length > 0) {
        lines.push('🔗 <b>Sequences:</b>');
        for (const s of sequences.slice(0, 5)) {
          const pct = Math.round(s.confidence * 100);
          const seq = s.sequence.map((x) => escapeHtml(x)).join(' → ');
          lines.push(`  • ${seq} <i>(${pct}%)</i>`);
        }
        lines.push('');
      }

      if (prefPatterns.length > 0) {
        lines.push('💡 <b>Preference patterns:</b>');
        for (const p of prefPatterns.slice(0, 5)) {
          const pct = Math.round(p.confidence * 100);
          lines.push(`  • <b>${escapeHtml(p.category)}</b>: prefers <code>${escapeHtml(p.preference)}</code> <i>(${pct}%)</i>`);
        }
      }
    }

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id }, '/patterns command');
  } catch (err) {
    log.error({ err }, 'Error in /patterns');
    await ctx.reply('Failed to retrieve patterns.');
  }
}

// ─── /opinions ───────────────────────────────────────────────────────

export async function handleOpinions(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    if (!orchestrator.personality) {
      await ctx.reply('Personality system not connected.', { parse_mode: 'HTML' });
      return;
    }

    const allOpinions = orchestrator.personality.opinions.getAllOpinions();

    const lines: string[] = ['<b>My current opinions</b>\n'];

    if (allOpinions.length === 0) {
      lines.push('<i>No opinions formed yet. Start debating with me and I\'ll develop stances.</i>');
    } else {
      const sorted = [...allOpinions].sort((a, b) => b.confidence - a.confidence);

      for (const op of sorted.slice(0, 10)) {
        const stanceLabel = op.stance > 0.3 ? '👍 for' : op.stance < -0.3 ? '👎 against' : '🤷 neutral on';
        const strengthLabel = op.confidence >= 0.7 ? 'strongly' : op.confidence >= 0.4 ? 'moderately' : 'mildly';
        const evidenceCount = op.evidence.length;

        lines.push(`<b>${escapeHtml(op.topic)}</b>`);
        lines.push(`   ${stanceLabel} — ${strengthLabel} (${Math.round(op.confidence * 100)}% confident)`);
        lines.push(`   <i>${evidenceCount} piece${evidenceCount !== 1 ? 's' : ''} of evidence</i>`);
        lines.push('');
      }

      if (allOpinions.length > 10) {
        lines.push(`<i>…and ${allOpinions.length - 10} more opinions</i>`);
      }
    }

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, opinionCount: allOpinions.length }, '/opinions command');
  } catch (err) {
    log.error({ err }, 'Error in /opinions');
    await ctx.reply('Failed to retrieve opinions.');
  }
}

// ─── /journal ────────────────────────────────────────────────────────

export async function handleJournal(ctx: Context): Promise<void> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const journalPath = join(homedir(), '.nexus', 'task-journal.jsonl');

    let raw: string;
    try {
      raw = await readFile(journalPath, 'utf-8');
    } catch {
      await ctx.reply('<b>Task Journal</b>\n\n<i>No entries yet — run some commands and I\'ll log them here.</i>', { parse_mode: 'HTML' });
      return;
    }

    const lines = raw.trim().split('\n').filter(Boolean);
    const recent = lines.slice(-15);

    const output: string[] = ['<b>Task Journal</b> — last 15 entries\n'];

    for (const line of recent) {
      try {
        const entry = JSON.parse(line) as {
          timestamp: string;
          toolName: string;
          params: Record<string, unknown>;
          result: string;
          success: boolean;
        };

        const ts = new Date(entry.timestamp).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
        const icon = entry.success ? '✓' : '✗';
        const shortResult = (entry.result ?? '').replace(/\n/g, ' ').slice(0, 60);

        output.push(`<code>${ts}</code> [${icon}] <b>${escapeHtml(entry.toolName)}</b>`);
        if (shortResult) {
          output.push(`  <i>${escapeHtml(shortResult)}${entry.result.length > 60 ? '…' : ''}</i>`);
        }
      } catch {
        // skip malformed lines
      }
    }

    output.push('');
    output.push(`<i>${lines.length} total entries</i>`);

    await ctx.reply(truncateMessage(output.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, entryCount: recent.length }, '/journal command');
  } catch (err) {
    log.error({ err }, 'Error in /journal');
    await ctx.reply('Failed to read task journal.');
  }
}

// ─── /mistakes ───────────────────────────────────────────────────────

export async function handleMistakes(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    if (!orchestrator.learning) {
      await ctx.reply('Learning system not connected.', { parse_mode: 'HTML' });
      return;
    }

    const stats = orchestrator.learning.mistakes.getMistakeStats();
    const recurring = orchestrator.learning.mistakes.getRecurringMistakes();

    const lines: string[] = ['<b>Mistake Tracker</b>\n'];

    lines.push(`📊 <b>Stats:</b>`);
    lines.push(`  Total recorded: <b>${stats.total}</b>`);
    lines.push(`  Resolved: <b>${stats.resolved}</b>`);
    lines.push(`  Recurring (not yet fixed): <b>${stats.recurring}</b>`);

    if (Object.keys(stats.byCategory).length > 0) {
      lines.push('');
      lines.push('  <b>By category:</b>');
      for (const [cat, count] of Object.entries(stats.byCategory)) {
        lines.push(`    • ${escapeHtml(cat)}: ${count}`);
      }
    }

    if (recurring.length > 0) {
      lines.push('');
      lines.push('⚠️ <b>Recurring mistakes:</b>');
      for (const m of recurring.slice(0, 5)) {
        lines.push(`  <b>${escapeHtml(m.description)}</b> (×${m.recurrenceCount + 1})`);
        lines.push(`  <i>Prevention: ${escapeHtml(m.preventionStrategy)}</i>`);
        lines.push('');
      }
    } else if (stats.total === 0) {
      lines.push('\n<i>No mistakes recorded yet.</i>');
    } else {
      lines.push('\n<i>No recurring mistakes — clean record so far.</i>');
    }

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, total: stats.total }, '/mistakes command');
  } catch (err) {
    log.error({ err }, 'Error in /mistakes');
    await ctx.reply('Failed to retrieve mistake data.');
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

    setTimeout(() => {
      process.emit('SIGTERM', 'SIGTERM');
    }, 1000);
  } catch (err) {
    log.error({ err }, 'Error in /stop');
    await ctx.reply('Failed to initiate shutdown.');
  }
}

// ─── /workspace ──────────────────────────────────────────────────────

export async function handleWorkspace(ctx: Context): Promise<void> {
  try {
    const { readdir, stat, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const { existsSync } = await import('node:fs');

    const workspacePath = join(homedir(), 'nexus-workspace');

    if (!existsSync(workspacePath)) {
      await mkdir(workspacePath, { recursive: true });
    }

    const entries = await readdir(workspacePath, { withFileTypes: true });

    if (entries.length === 0) {
      await ctx.reply(
        `<b>Workspace</b>\n\n<code>${escapeHtml(workspacePath)}</code>\n\n<i>Empty — nothing here yet.</i>\n\nAsk me to create a project and I'll put it here.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const lines: string[] = [
      `<b>Workspace</b> — <code>${escapeHtml(workspacePath)}</code>`,
      '',
    ];

    for (const entry of entries.slice(0, 30)) {
      const icon = entry.isDirectory() ? '📁' : '📄';
      lines.push(`${icon} ${escapeHtml(entry.name)}`);
    }

    if (entries.length > 30) {
      lines.push(`\n<i>… and ${entries.length - 30} more items</i>`);
    }

    lines.push('', `<i>${entries.length} item(s) total</i>`);

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, itemCount: entries.length }, '/workspace command');
  } catch (err) {
    log.error({ err }, 'Error in /workspace');
    await ctx.reply('Failed to read workspace folder.');
  }
}

// ─── /quiet ──────────────────────────────────────────────────────────

export async function handleQuiet(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    orchestrator.proactive?.setQuiet(true);
    await ctx.reply('🔇 <b>Quiet mode on</b> — proactive alerts paused.', { parse_mode: 'HTML' });
  } catch (err) {
    log.error({ err }, 'Error in /quiet');
    await ctx.reply('Failed to enable quiet mode.');
  }
}

// ─── /loud ───────────────────────────────────────────────────────────

export async function handleLoud(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    orchestrator.proactive?.setQuiet(false);
    await ctx.reply('🔔 <b>Alerts on</b> — I\'ll notify you of notable system events.', { parse_mode: 'HTML' });
  } catch (err) {
    log.error({ err }, 'Error in /loud');
    await ctx.reply('Failed to enable alerts.');
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

// ─── /search ─────────────────────────────────────────────────────────

export async function handleSearch(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    const text = ctx.message?.text ?? '';
    const query = text.replace(/^\/search\s*/i, '').trim();

    if (!query) {
      await ctx.reply('<b>Search memories</b>\n\nUsage: <code>/search &lt;query&gt;</code>\nExample: <code>/search python project</code>', { parse_mode: 'HTML' });
      return;
    }

    if (!orchestrator.memory) {
      await ctx.reply('Memory system not connected.', { parse_mode: 'HTML' });
      return;
    }

    await ctx.replyWithChatAction('typing');

    const results = orchestrator.memory.recall(query, {
      layers: ['episodic', 'semantic', 'procedural'],
      limit: 8,
      minImportance: 0.2,
    });

    const lines: string[] = [`<b>Memory search: "${escapeHtml(query)}"</b>\n`];

    if (results.length === 0) {
      lines.push('<i>No memories found matching that query.</i>');
    } else {
      for (const mem of results) {
        const layerIcon = mem.layer === 'semantic' ? '🧠' : mem.layer === 'procedural' ? '⚙️' : '📖';
        const date = new Date(mem.createdAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
        const preview = mem.content.replace(/\n/g, ' ').slice(0, 150);
        const importance = Math.round((mem.importance ?? 0) * 100);

        lines.push(`${layerIcon} <i>${escapeHtml(date)} · ${mem.layer} · ${importance}%</i>`);
        lines.push(escapeHtml(preview) + (mem.content.length > 150 ? '…' : ''));
        lines.push('');
      }
      lines.push(`<i>${results.length} result${results.length !== 1 ? 's' : ''}</i>`);
    }

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, query, resultCount: results.length }, '/search command');
  } catch (err) {
    log.error({ err }, 'Error in /search');
    await ctx.reply('Search failed.');
  }
}

// ─── /forget ─────────────────────────────────────────────────────────

export async function handleForget(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    const text = ctx.message?.text ?? '';
    const topic = text.replace(/^\/forget\s*/i, '').trim();

    if (!topic) {
      await ctx.reply('<b>Forget memories</b>\n\nUsage: <code>/forget &lt;topic&gt;</code>\nExample: <code>/forget my old API key</code>', { parse_mode: 'HTML' });
      return;
    }

    if (!orchestrator.memory) {
      await ctx.reply('Memory system not connected.', { parse_mode: 'HTML' });
      return;
    }

    // Find matching memories
    const matches = orchestrator.memory.recall(topic, {
      layers: ['episodic', 'semantic'],
      limit: 10,
      minImportance: 0.0,
    });

    if (matches.length === 0) {
      await ctx.reply(`<b>Forget</b>\n\nNo memories found matching "<code>${escapeHtml(topic)}</code>".`, { parse_mode: 'HTML' });
      return;
    }

    // Delete from DB directly
    const { getDatabase } = await import('../memory/database.js');
    const db = getDatabase();
    let deleted = 0;
    for (const mem of matches) {
      try {
        const result = db.prepare('DELETE FROM memories WHERE id = ?').run(mem.id);
        deleted += result.changes ?? 0;
      } catch { /* skip */ }
    }

    const lines = [
      `🗑️ <b>Forgotten</b>`,
      '',
      `Deleted <b>${deleted}</b> memor${deleted !== 1 ? 'ies' : 'y'} matching "<code>${escapeHtml(topic)}</code>":`,
      '',
      ...matches.slice(0, 5).map((m) => `• <i>${escapeHtml(m.content.slice(0, 80))}…</i>`),
    ];

    if (matches.length > 5) lines.push(`<i>…and ${matches.length - 5} more</i>`);

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, topic, deleted }, '/forget command');
  } catch (err) {
    log.error({ err }, 'Error in /forget');
    await ctx.reply('Forget failed.');
  }
}

// ─── /pin ────────────────────────────────────────────────────────────

export async function handlePin(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    const text = ctx.message?.text ?? '';
    const topic = text.replace(/^\/pin\s*/i, '').trim();

    if (!topic) {
      await ctx.reply('<b>Pin a memory</b>\n\nUsage: <code>/pin &lt;topic&gt;</code>\nPinned memories get max importance and never decay.\nExample: <code>/pin my API keys setup</code>', { parse_mode: 'HTML' });
      return;
    }

    if (!orchestrator.memory) {
      await ctx.reply('Memory system not connected.', { parse_mode: 'HTML' });
      return;
    }

    const matches = orchestrator.memory.recall(topic, {
      layers: ['episodic', 'semantic', 'procedural'],
      limit: 5,
      minImportance: 0.0,
    });

    if (matches.length === 0) {
      await ctx.reply(`<b>Pin</b>\n\nNo memories found matching "<code>${escapeHtml(topic)}</code>".`, { parse_mode: 'HTML' });
      return;
    }

    const { getDatabase } = await import('../memory/database.js');
    const db = getDatabase();
    let pinned = 0;
    for (const mem of matches) {
      try {
        const result = db.prepare('UPDATE memories SET importance = 1.0 WHERE id = ?').run(mem.id);
        pinned += result.changes ?? 0;
      } catch { /* skip */ }
    }

    const lines = [
      `📌 <b>Pinned</b>`,
      '',
      `Set <b>${pinned}</b> memor${pinned !== 1 ? 'ies' : 'y'} to max importance — they won't decay:`,
      '',
      ...matches.slice(0, 5).map((m) => `• <i>${escapeHtml(m.content.slice(0, 80))}…</i>`),
    ];

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, topic, pinned }, '/pin command');
  } catch (err) {
    log.error({ err }, 'Error in /pin');
    await ctx.reply('Pin failed.');
  }
}

// ─── /briefing ───────────────────────────────────────────────────────

export async function handleBriefing(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    await ctx.replyWithChatAction('typing');
    await orchestrator.sendBriefingNow();
    // briefing sends to the primary chat — if this was a different chat, acknowledge
    const primaryChatId = orchestrator.getPrimaryChatId();
    if (primaryChatId && String(ctx.chat?.id) !== primaryChatId) {
      await ctx.reply('<i>Briefing sent to primary chat.</i>', { parse_mode: 'HTML' });
    }
  } catch (err) {
    log.error({ err }, 'Error in /briefing');
    await ctx.reply('Failed to send briefing.');
  }
}

// ─── /grant ──────────────────────────────────────────────────────────

export async function handleGrant(ctx: Context): Promise<void> {
  try {
    const text = ctx.message?.text ?? '';
    const target = text.replace(/^\/grant\s*/i, '').trim().toLowerCase();

    if (!target || !['contacts', 'messages'].includes(target)) {
      await ctx.reply(
        '<b>Grant macOS Permission</b>\n\n' +
        'Usage:\n' +
        '  <code>/grant contacts</code> — trigger Contacts access dialog\n' +
        '  <code>/grant messages</code> — trigger Messages automation dialog\n\n' +
        '<i>This opens Script Editor on your Mac with the right AppleScript.\n' +
        'Just press ▶ Run — macOS will prompt you to allow access.</i>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const { triggerPermissionPrompt } = await import('../macos/permissions.js');
    await ctx.reply(
      `🔑 Opening Script Editor for <b>${escapeHtml(target)}</b> permission...\n\n` +
      `Press <b>▶ Run</b> in Script Editor — macOS will show the permission dialog.\n` +
      `Then restart NEXUS.`,
      { parse_mode: 'HTML' },
    );

    await triggerPermissionPrompt(target as 'contacts' | 'messages');
    log.info({ chatId: ctx.chat?.id, target }, '/grant permission triggered');
  } catch (err) {
    log.error({ err }, 'Error in /grant');
    await ctx.reply('Failed to open Script Editor.');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function confidenceBar(confidence: number): string {
  const filled = Math.round(confidence * 5);
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}
