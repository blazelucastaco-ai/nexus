// ─── Telegram Command Handlers ────────────────────────────────────────
import type { Bot, Context } from 'grammy';
import { execFileSync } from 'node:child_process';
import type { Orchestrator } from '../core/orchestrator.js';
import { createLogger } from '../utils/logger.js';
import { getDatabase } from '../memory/database.js';
import { listRecentSessionSummaries } from '../data/episodic-queries.js';
import {
  listProjects,
  getProject,
  listJournalEntries,
  slugify,
} from '../data/projects-repository.js';
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
  { command: 'undo', description: 'Undo the most recent file change' },
  { command: 'history', description: 'Recent session summaries' },
  { command: 'retry', description: 'Retry the last failed task' },
  { command: 'projects', description: 'List tracked projects with activity' },
  { command: 'go', description: 'Resume context on a project — /go <name>' },
  { command: 'project', description: 'Detailed status for a project — /project <name>' },
  { command: 'dreams', description: 'Recent Code Dreams observations — /dreams [project]' },
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
    if (!await requireSubsystem(ctx, orchestrator.memory, 'Memory system')) return;

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
    if (!await requireSubsystem(ctx, orchestrator.personality, 'Personality system')) return;

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
    if (!await requireSubsystem(ctx, orchestrator.agents, 'Agent system')) return;

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
    if (!await requireSubsystem(ctx, orchestrator.learning, 'Learning system')) return;

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
    if (!await requireSubsystem(ctx, orchestrator.learning, 'Learning system')) return;

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
    if (!await requireSubsystem(ctx, orchestrator.learning, 'Learning system')) return;

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

    const results = await orchestrator.memory.recall(query, {
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
    const matches = await orchestrator.memory.recall(topic, {
      layers: ['episodic', 'semantic'],
      limit: 10,
      minImportance: 0.0,
    });

    if (matches.length === 0) {
      await ctx.reply(`<b>Forget</b>\n\nNo memories found matching "<code>${escapeHtml(topic)}</code>".`, { parse_mode: 'HTML' });
      return;
    }

    // Delete from DB directly
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

    const matches = await orchestrator.memory.recall(topic, {
      layers: ['episodic', 'semantic', 'procedural'],
      limit: 5,
      minImportance: 0.0,
    });

    if (matches.length === 0) {
      await ctx.reply(`<b>Pin</b>\n\nNo memories found matching "<code>${escapeHtml(topic)}</code>".`, { parse_mode: 'HTML' });
      return;
    }

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

// ─── /undo ───────────────────────────────────────────────────────────

export async function handleUndo(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    const executor = orchestrator.toolExecutor;
    if (!executor) {
      await ctx.reply('Tool executor not available.');
      return;
    }
    const result = await executor.undoLastWrite();
    await ctx.reply(`↩️ ${result}`);
    log.info({ chatId: ctx.chat?.id }, '/undo command');
  } catch (err) {
    log.error({ err }, 'Error in /undo');
    await ctx.reply('Undo failed — check the logs.');
  }
}

// ─── /history ────────────────────────────────────────────────────────

export async function handleHistory(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    if (!await requireSubsystem(ctx, orchestrator.memory, 'Memory system')) return;

    const rows = listRecentSessionSummaries(10);

    if (rows.length === 0) {
      await ctx.reply('No recent session history yet.');
      return;
    }

    const lines: string[] = ['<b>📜 Recent history</b>\n'];
    for (const r of rows) {
      const time = new Date(r.created_at).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      const snippet = r.content.replace(/\n+/g, ' ').slice(0, 200);
      lines.push(`<i>${escapeHtml(time)}</i>`);
      lines.push(escapeHtml(snippet));
      lines.push('');
    }

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, count: rows.length }, '/history command');
  } catch (err) {
    log.error({ err }, 'Error in /history');
    await ctx.reply('Failed to retrieve history.');
  }
}

// ─── /retry ──────────────────────────────────────────────────────────

export async function handleRetry(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    const chatId = String(ctx.chat?.id ?? '');
    const lastRequest = orchestrator.getLastFailedRequest(chatId);
    if (!lastRequest) {
      await ctx.reply('No recent failed task to retry.');
      return;
    }
    await ctx.reply(`🔁 Retrying: <i>${escapeHtml(lastRequest.slice(0, 200))}</i>`, { parse_mode: 'HTML' });
    // Re-enter handleMessage with the original text
    const result = await orchestrator.handleMessage(chatId, lastRequest);
    await ctx.reply(truncateMessage(result), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id }, '/retry command');
  } catch (err) {
    log.error({ err }, 'Error in /retry');
    await ctx.reply('Retry failed — check the logs.');
  }
}

// ─── /projects ───────────────────────────────────────────────────────

export async function handleProjects(ctx: Context, _orchestrator: Orchestrator): Promise<void> {
  try {
    const projects = listProjects({ limit: 20 });
    if (projects.length === 0) {
      await ctx.reply('No projects tracked yet. Start a task and I\'ll begin tracking.');
      return;
    }

    const lines: string[] = ['<b>📁 Projects</b>\n'];
    const now = Date.now();
    for (const p of projects) {
      const lastActive = new Date(p.last_active_at).getTime();
      const ageMs = now - lastActive;
      const ageLabel = formatAge(ageMs);
      const status = p.last_task_success === null ? '' :
                     p.last_task_success === 1 ? ' ✅' : ' ⚠️';
      lines.push(`<b>${escapeHtml(p.display_name)}</b>${status}`);
      lines.push(`  <code>${escapeHtml(p.name)}</code> · ${p.task_count} task${p.task_count === 1 ? '' : 's'} · ${ageLabel}`);
      if (p.last_task_title) {
        lines.push(`  <i>Last: ${escapeHtml(p.last_task_title.slice(0, 80))}</i>`);
      }
      lines.push('');
    }
    lines.push('<i>Use /go &lt;name&gt; to resume context or /project &lt;name&gt; for details.</i>');

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, count: projects.length }, '/projects command');
  } catch (err) {
    log.error({ err }, 'Error in /projects');
    await ctx.reply('Failed to list projects.');
  }
}

// ─── /go <name> ──────────────────────────────────────────────────────

export async function handleGo(ctx: Context, _orchestrator: Orchestrator, name?: string): Promise<void> {
  try {
    if (!name) {
      await ctx.reply('Usage: /go &lt;project-name&gt; — see /projects for the list.', { parse_mode: 'HTML' });
      return;
    }
    const slug = slugify(name);
    const project = getProject(slug);
    if (!project) {
      await ctx.reply(`No project "${escapeHtml(slug)}". Try /projects.`, { parse_mode: 'HTML' });
      return;
    }

    const journal = listJournalEntries(slug, 5);
    const lastTaskEntry = journal.find((e) => e.kind === 'task');
    const lastErrorEntry = journal.find((e) => e.kind === 'error');

    const lines: string[] = [
      `<b>📂 ${escapeHtml(project.display_name)}</b>`,
      project.path ? `<code>${escapeHtml(project.path)}</code>` : '',
      '',
      `<b>Last active:</b> ${formatAge(Date.now() - new Date(project.last_active_at).getTime())} ago`,
      `<b>Total tasks:</b> ${project.task_count}`,
    ];

    if (project.last_task_title) {
      const icon = project.last_task_success === 1 ? '✅' : project.last_task_success === 0 ? '⚠️' : '•';
      lines.push(`<b>Last task:</b> ${icon} ${escapeHtml(project.last_task_title)}`);
    }

    if (lastErrorEntry) {
      lines.push('');
      lines.push(`<b>⚠️ Recent blocker:</b>`);
      lines.push(`<i>${escapeHtml(lastErrorEntry.summary.slice(0, 200))}</i>`);
    }

    lines.push('');
    lines.push(`<b>Activity log</b> (last ${journal.length}):`);
    for (const j of journal) {
      const icon = j.kind === 'task' ? '⚙️' : j.kind === 'error' ? '❌' : j.kind === 'tool' ? '🔧' : '📝';
      lines.push(`  ${icon} <i>${escapeHtml(j.summary.slice(0, 120))}</i>`);
    }

    await ctx.reply(truncateMessage(lines.filter(Boolean).join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, project: slug }, '/go command');
  } catch (err) {
    log.error({ err }, 'Error in /go');
    await ctx.reply('Failed to load project.');
  }
}

// ─── /project <name> ─────────────────────────────────────────────────
// Alias-like detailed view — for now identical to /go but named distinctly
// so future versions can diverge (e.g. /go auto-navigates + shows briefing,
// /project just lists metadata).

export async function handleProject(ctx: Context, orchestrator: Orchestrator, name?: string): Promise<void> {
  await handleGo(ctx, orchestrator, name);
}

// ─── /resume <name> ──────────────────────────────────────────────────
// Sets the active project for the session and shows a resume brief:
// last task, recent blockers, most recent journal entries, and a quick
// git log tail if the project has a disk path.

export async function handleResume(ctx: Context, orchestrator: Orchestrator, name?: string): Promise<void> {
  try {
    if (!name) {
      const active = orchestrator.activeProject;
      if (active) {
        await ctx.reply(
          `Currently resumed on <b>${escapeHtml(active)}</b>. Usage: /resume &lt;project-name&gt; to switch, or /resume --clear to stop.`,
          { parse_mode: 'HTML' },
        );
      } else {
        await ctx.reply('Usage: /resume &lt;project-name&gt; — see /projects for the list.', { parse_mode: 'HTML' });
      }
      return;
    }

    if (name === '--clear' || name === 'clear') {
      orchestrator.setActiveProject(null);
      await ctx.reply('Active project cleared.');
      return;
    }

    const slug = slugify(name);
    const project = getProject(slug);
    if (!project) {
      await ctx.reply(`No project "${escapeHtml(slug)}". Try /projects.`, { parse_mode: 'HTML' });
      return;
    }

    orchestrator.setActiveProject(slug);

    const journal = listJournalEntries(slug, 10);
    const lastTaskEntry = journal.find((e) => e.kind === 'task');
    const lastErrorEntry = journal.find((e) => e.kind === 'error');

    const lines: string[] = [
      `<b>▶️ Resuming: ${escapeHtml(project.display_name)}</b>`,
    ];
    if (project.path) lines.push(`<code>${escapeHtml(project.path)}</code>`);
    lines.push('');

    // Where we left off
    lines.push('<b>Where you left off</b>');
    if (project.last_task_title) {
      const icon = project.last_task_success === 1 ? '✅' : project.last_task_success === 0 ? '⚠️' : '•';
      lines.push(`${icon} ${escapeHtml(project.last_task_title)}`);
    } else {
      lines.push('<i>No tasks recorded yet.</i>');
    }
    lines.push(`<i>Last active: ${formatAge(Date.now() - new Date(project.last_active_at).getTime())} ago · ${project.task_count} task${project.task_count === 1 ? '' : 's'} total</i>`);

    // Unsolved blocker (most recent error that isn't resolved)
    if (lastErrorEntry) {
      lines.push('');
      lines.push('<b>⚠️ Last blocker</b>');
      lines.push(`<i>${escapeHtml(lastErrorEntry.summary.slice(0, 240))}</i>`);
    }

    // Recent activity
    if (journal.length > 0) {
      lines.push('');
      lines.push('<b>Recent activity</b>');
      for (const j of journal.slice(0, 5)) {
        const icon = j.kind === 'task' ? '⚙️' : j.kind === 'error' ? '❌' : j.kind === 'tool' ? '🔧' : '📝';
        lines.push(`  ${icon} <i>${escapeHtml(j.summary.slice(0, 120))}</i>`);
      }
    }

    // Git log tail
    if (project.path) {
      const gitLog = safeGitLog(project.path);
      if (gitLog.length > 0) {
        lines.push('');
        lines.push('<b>Recent commits</b>');
        for (const entry of gitLog.slice(0, 5)) {
          lines.push(`  <code>${escapeHtml(entry)}</code>`);
        }
      }
    }

    lines.push('');
    lines.push('<i>Active project set. New file writes default to this project\'s directory.</i>');

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
    log.info({ chatId: ctx.chat?.id, project: slug }, '/resume command');
  } catch (err) {
    log.error({ err }, 'Error in /resume');
    await ctx.reply('Failed to resume project.');
  }
}

function safeGitLog(cwd: string): string[] {
  try {
    // Only attempt git log if this looks like a git repo
    const out = execFileSync('git', ['log', '--oneline', '-5'], {
      cwd,
      timeout: 3000,
      encoding: 'utf-8',
    }).trim();
    return out ? out.split('\n') : [];
  } catch {
    return [];
  }
}

// ─── /dreams [project] ───────────────────────────────────────────────

export async function handleDreams(ctx: Context, _orchestrator: Orchestrator, name?: string): Promise<void> {
  try {
    if (name) {
      // One project's recent code-dream observations
      const slug = slugify(name);
      const project = getProject(slug);
      if (!project) {
        await ctx.reply(`No project "${escapeHtml(slug)}". Try /projects.`, { parse_mode: 'HTML' });
        return;
      }
      const entries = listJournalEntries(slug, 20).filter((e) => {
        try {
          const meta = JSON.parse(e.metadata ?? '{}');
          return e.kind === 'note' && meta.source === 'code-dreams';
        } catch { return false; }
      });
      if (entries.length === 0) {
        await ctx.reply(`No Code Dreams observations yet for <b>${escapeHtml(project.display_name)}</b>. They generate on the nightly dream cycle.`, { parse_mode: 'HTML' });
        return;
      }
      const lines: string[] = [`<b>🌙 Code Dreams · ${escapeHtml(project.display_name)}</b>\n`];
      for (const e of entries.slice(0, 5)) {
        const when = formatAge(Date.now() - new Date(e.created_at).getTime());
        lines.push(`<i>${when} ago</i>`);
        lines.push(escapeHtml(e.summary));
        lines.push('');
      }
      await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
      return;
    }

    // No arg — show latest dream per project (one per project, recent first)
    const projects = listProjects({ limit: 10 });
    if (projects.length === 0) {
      await ctx.reply('No projects tracked yet.');
      return;
    }
    const lines: string[] = ['<b>🌙 Recent Code Dreams</b>\n'];
    let anyShown = false;
    for (const p of projects) {
      const entries = listJournalEntries(p.name, 20).filter((e) => {
        try {
          const meta = JSON.parse(e.metadata ?? '{}');
          return e.kind === 'note' && meta.source === 'code-dreams';
        } catch { return false; }
      });
      if (entries.length === 0) continue;
      anyShown = true;
      const latest = entries[0]!;
      const when = formatAge(Date.now() - new Date(latest.created_at).getTime());
      lines.push(`<b>${escapeHtml(p.display_name)}</b> <i>(${when} ago)</i>`);
      lines.push(escapeHtml(latest.summary.slice(0, 250)));
      lines.push('');
    }
    if (!anyShown) {
      await ctx.reply('No Code Dreams yet. The first observations generate on the next nightly dream cycle.');
      return;
    }
    lines.push('<i>Use /dreams &lt;project&gt; for that project\'s full history.</i>');
    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
  } catch (err) {
    log.error({ err }, 'Error in /dreams');
    await ctx.reply('Failed to load Code Dreams.');
  }
}

// ─── /thinking ───────────────────────────────────────────────────────
// Surfaces NEXUS's current self-awareness: what it's doing, recent tools,
// which projects it's been touching, and a rolling narrative.

export async function handleThinking(ctx: Context, orchestrator: Orchestrator): Promise<void> {
  try {
    if (!orchestrator.introspection) {
      await ctx.reply('Introspection is not active yet.');
      return;
    }
    const snap = orchestrator.introspection.getSnapshot();
    const narrative = orchestrator.introspection.getNarrative();

    const lines: string[] = [];
    lines.push('<b>💭 Current thinking</b>');
    lines.push('');
    lines.push(escapeHtml(narrative));

    if (snap.recentTasks.length > 0) {
      lines.push('');
      lines.push('<b>Recent tasks:</b>');
      for (const t of snap.recentTasks.slice(0, 3)) {
        const ago = formatAge(Date.now() - t.at);
        lines.push(`  ${t.success ? '✓' : '✗'} ${escapeHtml(t.title)} <i>(${ago} ago)</i>`);
      }
    }

    if (snap.recentErrors.length > 0) {
      lines.push('');
      lines.push('<b>Recent errors:</b>');
      for (const e of snap.recentErrors.slice(0, 3)) {
        const ago = formatAge(Date.now() - e.at);
        lines.push(`  <i>[${e.source}] ${escapeHtml(e.message.slice(0, 140))}</i> <i>(${ago} ago)</i>`);
      }
    }

    await ctx.reply(truncateMessage(lines.join('\n')), { parse_mode: 'HTML' });
  } catch (err) {
    log.error({ err }, 'Error in /thinking');
    await ctx.reply('Failed to introspect.');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `just now`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const d = Math.floor(hr / 24);
  return `${d}d`;
}

function confidenceBar(confidence: number): string {
  const filled = Math.round(confidence * 5);
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}

/** Reply with "X not connected" and return false when a subsystem is absent. */
async function requireSubsystem(ctx: Context, value: unknown, name: string): Promise<boolean> {
  if (value) return true;
  await ctx.reply(`${name} not connected.`, { parse_mode: 'HTML' });
  return false;
}
