// ─── Telegram Message Formatting Utilities ────────────────────────────
// HTML formatting helpers for Telegram Bot API

import type {
  AgentTask,
  EmotionalState,
  EmotionLabel,
  PersonalityState,
  Memory,
} from '../types.js';

const TELEGRAM_MAX_LENGTH = 4096;

// ─── HTML Escaping ────────────────────────────────────────────────────

/**
 * Escape HTML special characters for safe use in Telegram HTML parse mode.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Truncation ───────────────────────────────────────────────────────

/**
 * Truncate a message to respect Telegram's 4096 character limit.
 * Appends an ellipsis indicator if truncated.
 */
export function truncateMessage(text: string, maxLength: number = TELEGRAM_MAX_LENGTH): string {
  if (text.length <= maxLength) return text;

  const suffix = '\n\n<i>... (truncated)</i>';
  return text.slice(0, maxLength - suffix.length) + suffix;
}

// ─── Path Sanitization ────────────────────────────────────────────────

/**
 * Replace absolute home directory paths with ~ to avoid leaking internal paths in Telegram messages.
 */
export function sanitizePaths(text: string): string {
  const home = process.env.HOME;
  if (!home) return text;
  return text.replaceAll(home, '~');
}

// ─── Status Formatting ───────────────────────────────────────────────

/**
 * Format a system status object into a rich Telegram HTML message.
 */
export function formatStatus(status: Record<string, unknown>): string {
  const uptime = status.uptime as number | undefined;
  const mood = status.mood as string | undefined;
  const activeTasks = status.activeTasks as number | undefined;
  const availableProviders = status.availableProviders as string[] | undefined;
  const availableAgents = status.availableAgents as string[] | undefined;
  const eventQueueSize = status.eventQueueSize as number | undefined;

  const lines: string[] = [
    '<b>NEXUS System Status</b>',
    '',
  ];

  if (uptime !== undefined) {
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const secs = uptime % 60;
    lines.push(`<b>Uptime:</b> ${hours}h ${mins}m ${secs}s`);
  }

  if (mood) {
    const emoji = getMoodEmoji(mood as EmotionLabel);
    lines.push(`<b>Mood:</b> ${emoji} ${escapeHtml(mood)}`);
  }

  if (activeTasks !== undefined) {
    lines.push(`<b>Active Tasks:</b> ${activeTasks}`);
  }

  if (availableProviders && availableProviders.length > 0) {
    lines.push(`<b>AI Providers:</b> ${availableProviders.map(escapeHtml).join(', ')}`);
  }

  if (availableAgents && availableAgents.length > 0) {
    lines.push(`<b>Available Agents:</b> ${availableAgents.length}`);
  }

  if (eventQueueSize !== undefined) {
    lines.push(`<b>Event Queue:</b> ${eventQueueSize}`);
  }

  // System resources
  const mem = process.memoryUsage();
  lines.push('');
  lines.push('<b>System Resources:</b>');
  lines.push(`  RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
  lines.push(`  Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} / ${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`);

  return lines.join('\n');
}

// ─── Memory Formatting ──────────────────────────────────────────────

/**
 * Format memory statistics into a Telegram HTML message.
 */
export function formatMemoryStats(stats: Record<string, unknown>): string {
  const lines: string[] = [
    '<b>Memory Report</b>',
    '',
  ];

  const totalMemories = stats.totalMemories as number | undefined;
  const bufferCount = stats.bufferCount as number | undefined;
  const episodicCount = stats.episodicCount as number | undefined;
  const semanticCount = stats.semanticCount as number | undefined;
  const proceduralCount = stats.proceduralCount as number | undefined;
  const consolidated = stats.consolidated as number | undefined;
  const recentMemories = stats.recentMemories as Memory[] | undefined;

  if (totalMemories !== undefined) {
    lines.push(`<b>Total Memories:</b> ${totalMemories}`);
  }

  lines.push('');
  lines.push('<b>Layers:</b>');

  const layers = [
    { label: 'Buffer', count: bufferCount },
    { label: 'Episodic', count: episodicCount },
    { label: 'Semantic', count: semanticCount },
    { label: 'Procedural', count: proceduralCount },
  ];

  for (const layer of layers) {
    if (layer.count !== undefined) {
      lines.push(`  ${layer.label}: ${layer.count}`);
    }
  }

  if (consolidated !== undefined) {
    lines.push('');
    lines.push(`<b>Consolidated:</b> ${consolidated} memories`);
  }

  if (recentMemories && recentMemories.length > 0) {
    lines.push('');
    lines.push('<b>Recent Memories:</b>');
    for (const mem of recentMemories.slice(0, 5)) {
      const summary = mem.summary || mem.content.slice(0, 80);
      lines.push(`  [${escapeHtml(mem.layer)}] ${escapeHtml(summary)}`);
    }
  }

  return lines.join('\n');
}

// ─── Agent Formatting ───────────────────────────────────────────────

/**
 * Format a list of agents and their status.
 */
export function formatAgentList(agents: Array<{ name: string; description: string; enabled: boolean }>): string {
  if (agents.length === 0) {
    return '<b>Agents</b>\n\nNo agents available.';
  }

  const lines: string[] = [
    '<b>Available Agents</b>',
    '',
  ];

  for (const agent of agents) {
    const icon = agent.enabled ? '🟢' : '🔴';
    lines.push(`${icon} <b>${escapeHtml(agent.name)}</b>`);
    lines.push(`    <i>${escapeHtml(agent.description)}</i>`);
  }

  const enabledCount = agents.filter((a) => a.enabled).length;
  lines.push('');
  lines.push(`<b>${enabledCount}/${agents.length}</b> agents active`);

  return lines.join('\n');
}

// ─── Task Formatting ────────────────────────────────────────────────

/**
 * Format a list of tasks with status indicators.
 */
export function formatTaskList(tasks: AgentTask[]): string {
  if (tasks.length === 0) {
    return '<b>Tasks</b>\n\nNo active tasks.';
  }

  const lines: string[] = [
    '<b>Active Tasks</b>',
    '',
  ];

  const statusIcons: Record<string, string> = {
    pending: '⏳',
    running: '🔄',
    completed: '✅',
    failed: '❌',
  };

  for (const task of tasks) {
    const icon = statusIcons[task.status] ?? '❓';
    lines.push(`${icon} <b>${escapeHtml(task.action)}</b>`);
    lines.push(`    Agent: <code>${escapeHtml(task.agentName)}</code> | Status: ${escapeHtml(task.status)}`);

    if (task.result?.error) {
      lines.push(`    <i>Error: ${escapeHtml(task.result.error)}</i>`);
    }
  }

  return lines.join('\n');
}

// ─── Mood Formatting ────────────────────────────────────────────────

/**
 * Get an emoji indicator for a given emotion label.
 */
function getMoodEmoji(emotion: EmotionLabel | string): string {
  const emojiMap: Record<string, string> = {
    enthusiastic: '🔥',
    focused: '🎯',
    amused: '😄',
    concerned: '😟',
    frustrated: '😤',
    satisfied: '😌',
    skeptical: '🤨',
    curious: '🧐',
    impatient: '⏰',
    playful: '😏',
    neutral: '😐',
  };

  return emojiMap[emotion] ?? '🤖';
}

/**
 * Format the current emotional state with emoji indicators.
 */
export function formatMood(personality: PersonalityState): string {
  const emoji = getMoodEmoji(personality.emotionLabel);
  const emotion = personality.emotion;

  const moodBar = (value: number, max: number = 1): string => {
    const filled = Math.round((value / max) * 10);
    const empty = 10 - filled;
    return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
  };

  const valenceBar = (value: number): string => {
    // -1 to +1 range — center at 5
    const pos = Math.round(((value + 1) / 2) * 10);
    return '░'.repeat(Math.max(0, pos)) + '█' + '░'.repeat(Math.max(0, 10 - pos));
  };

  const lines: string[] = [
    `${emoji} <b>Current Mood: ${escapeHtml(personality.emotionLabel)}</b>`,
    '',
    `<b>Overall Mood:</b> ${personality.mood > 0 ? '+' : ''}${personality.mood.toFixed(2)}`,
    '',
    '<b>Emotional State:</b>',
    `  Valence:    [${valenceBar(emotion.valence)}] ${emotion.valence > 0 ? '+' : ''}${emotion.valence.toFixed(2)}`,
    `  Arousal:    [${moodBar(emotion.arousal)}] ${emotion.arousal.toFixed(2)}`,
    `  Confidence: [${moodBar(emotion.confidence)}] ${emotion.confidence.toFixed(2)}`,
    `  Engagement: [${moodBar(emotion.engagement)}] ${emotion.engagement.toFixed(2)}`,
    `  Patience:   [${moodBar(emotion.patience)}] ${emotion.patience.toFixed(2)}`,
    '',
    `<b>Relationship Warmth:</b> [${moodBar(personality.relationshipWarmth)}] ${personality.relationshipWarmth.toFixed(2)}`,
    `<b>Days Known:</b> ${personality.daysSinceFirstInteraction}`,
  ];

  return lines.join('\n');
}

// ─── Error Formatting ───────────────────────────────────────────────

/**
 * Format an error for display in Telegram.
 */
export function formatError(error: Error): string {
  return [
    '❌ <b>Error</b>',
    '',
    `<b>Message:</b> ${escapeHtml(error.message)}`,
    error.stack
      ? `\n<pre>${escapeHtml(error.stack.split('\n').slice(0, 5).join('\n'))}</pre>`
      : '',
  ].join('\n');
}

// ─── Welcome Message ────────────────────────────────────────────────

/**
 * Format the NEXUS welcome / branding message.
 */
export function formatWelcome(): string {
  return [
    '<pre>',
    ' ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗',
    ' ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝',
    ' ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗',
    ' ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║',
    ' ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║',
    ' ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝',
    '</pre>',
    '',
    '<b>Your AI companion is online.</b>',
    '',
    'I can help you with tasks, research, code, system management, and more.',
    '',
    'Send me a message or use /help to see what I can do.',
  ].join('\n');
}

// ─── Help Message ───────────────────────────────────────────────────

/**
 * Format the help text listing all available commands.
 */
export function formatHelp(): string {
  const commands = [
    { cmd: '/start', desc: 'Start NEXUS and see welcome message' },
    { cmd: '/status', desc: 'System status and health check' },
    { cmd: '/screenshot', desc: 'Capture and send a screenshot' },
    { cmd: '/tasks', desc: 'List active and recent tasks' },
    { cmd: '/memory', desc: 'Memory layer statistics' },
    { cmd: '/mood', desc: 'Current emotional state' },
    { cmd: '/agents', desc: 'List available agents and status' },
    { cmd: '/settings', desc: 'Show current configuration' },
    { cmd: '/think', desc: 'Inner monologue on a topic — /think &lt;topic&gt;' },
    { cmd: '/stop', desc: 'Graceful shutdown' },
    { cmd: '/help', desc: 'Show this help message' },
  ];

  const lines: string[] = [
    '<b>NEXUS Commands</b>',
    '',
    ...commands.map((c) => `${c.cmd} — ${c.desc}`),
    '',
    'Or just send me a message and I\'ll figure out the rest.',
  ];

  return lines.join('\n');
}
