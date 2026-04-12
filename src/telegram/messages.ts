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

/**
 * Convert LLM markdown output to Telegram HTML.
 * Handles code blocks first (escaped but not markdown-processed),
 * then converts **bold**, *italic*, `inline code` in the rest.
 * Safe to call instead of plain escapeHtml() on LLM responses.
 */
export function markdownToHtml(text: string): string {
  const segments: Array<{ type: 'code' | 'text'; content: string; lang?: string }> = [];

  // Split out fenced code blocks (``` ... ```) first
  const fenceRe = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  // eslint-disable-next-line no-cond-assign
  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > lastIdx) {
      segments.push({ type: 'text', content: text.slice(lastIdx, m.index) });
    }
    segments.push({ type: 'code', content: m[2] ?? '', lang: m[1] || undefined });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIdx) });
  }

  return segments.map((seg) => {
    if (seg.type === 'code') {
      const escaped = escapeHtml(seg.content.trimEnd());
      return `<pre>${escaped}</pre>`;
    }

    // Process inline elements — escape first, then replace markdown tokens with HTML tags
    let s = escapeHtml(seg.content);

    // Inline code  `code`
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold  **text** or __text__
    s = s.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');
    s = s.replace(/__(.+?)__/gs, '<b>$1</b>');

    // Italic  *text* or _text_  (must come after bold)
    s = s.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
    s = s.replace(/_([^_\n]+)_/g, '<i>$1</i>');

    return s;
  }).join('');
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
  const uptime = status.uptimeFormatted as string | undefined;
  const mood = status.mood as string | undefined;
  const emotion = status.emotion as string | undefined;
  const activeTasks = status.activeTasks as number | undefined;
  const availableProviders = status.availableProviders as string[] | undefined;
  const availableAgents = status.availableAgents as string[] | undefined;
  const sessionTurns = status.sessionTurns as number | undefined;
  const sessionTokens = status.sessionTokens as { input: number; output: number; requests: number } | undefined;
  const learningStats = status.learningStats as { preferencesLearned: number; mistakesTracked: number; recurringMistakes: number } | null | undefined;
  const opinionsHeld = status.opinionsHeld as number | undefined;

  const lines: string[] = [
    '<b>NEXUS Status</b>',
    '',
  ];

  // Identity
  if (uptime) lines.push(`⏱ <b>Uptime:</b> ${escapeHtml(uptime)}`);
  if (mood) {
    const emoji = getMoodEmoji(mood as EmotionLabel);
    const emotionStr = emotion ? ` · ${escapeHtml(emotion)}` : '';
    lines.push(`${emoji} <b>Mood:</b> ${escapeHtml(mood)}${emotionStr}`);
  }

  // Session
  if (sessionTurns !== undefined || sessionTokens) {
    lines.push('');
    lines.push('<b>This session:</b>');
    if (sessionTurns !== undefined) lines.push(`  Turns: ${sessionTurns}`);
    if (sessionTokens && sessionTokens.requests > 0) {
      const totalTokens = sessionTokens.input + sessionTokens.output;
      lines.push(`  Tokens: ${totalTokens.toLocaleString()} (${sessionTokens.input.toLocaleString()} in / ${sessionTokens.output.toLocaleString()} out)`);
      lines.push(`  LLM calls: ${sessionTokens.requests}`);
    }
  }

  // Tasks
  if (activeTasks !== undefined) {
    lines.push('');
    lines.push(`📋 <b>Tasks:</b> ${activeTasks} active`);
  }

  // Agents & providers
  if (availableAgents && availableAgents.length > 0) {
    lines.push(`🤖 <b>Agents:</b> ${availableAgents.length} available`);
  }
  if (availableProviders && availableProviders.length > 0) {
    lines.push(`🧠 <b>AI:</b> ${availableProviders.map(escapeHtml).join(', ')}`);
  }

  // Learning & opinions
  if (learningStats || opinionsHeld !== undefined) {
    lines.push('');
    lines.push('<b>What I know:</b>');
    if (learningStats) {
      lines.push(`  Preferences learned: ${learningStats.preferencesLearned}`);
      lines.push(`  Mistakes tracked: ${learningStats.mistakesTracked} (${learningStats.recurringMistakes} recurring)`);
    }
    if (opinionsHeld !== undefined) lines.push(`  Opinions held: ${opinionsHeld}`);
  }

  // System resources
  const mem = process.memoryUsage();
  lines.push('');
  lines.push('<b>Resources:</b>');
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
    { cmd: '/status', desc: 'Full system status — uptime, tokens, learning stats' },
    { cmd: '/mood', desc: 'My current emotional state' },
    { cmd: '/preferences', desc: 'What I\'ve learned about your preferences' },
    { cmd: '/patterns', desc: 'Behavioral patterns I\'ve detected' },
    { cmd: '/opinions', desc: 'My current opinions and stances' },
    { cmd: '/journal', desc: 'Recent tool activity log' },
    { cmd: '/mistakes', desc: 'Mistakes I\'ve tracked and learned from' },
    { cmd: '/memory', desc: 'Memory layer statistics' },
    { cmd: '/agents', desc: 'Available agents' },
    { cmd: '/tasks', desc: 'Active tasks' },
    { cmd: '/workspace', desc: 'Files in my workspace folder' },
    { cmd: '/screenshot', desc: 'Capture a screenshot' },
    { cmd: '/think', desc: 'Inner monologue — /think &lt;topic&gt;' },
    { cmd: '/quiet', desc: 'Disable proactive alerts' },
    { cmd: '/loud', desc: 'Enable proactive alerts' },
    { cmd: '/settings', desc: 'Current configuration' },
    { cmd: '/stop', desc: 'Graceful shutdown' },
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
