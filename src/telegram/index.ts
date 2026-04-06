// ─── NEXUS Telegram Module ────────────────────────────────────────────
// Re-exports the gateway, commands, messages, and media modules.

export { TelegramGateway, default } from './gateway.js';

// Backward compatibility — the old class name used throughout the codebase
export { TelegramGateway as TelegramBot } from './gateway.js';
export {
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
  handleStop,
  handleHelp,
} from './commands.js';
export type { BotCommand } from './commands.js';
export {
  escapeHtml,
  truncateMessage,
  formatStatus,
  formatMemoryStats,
  formatAgentList,
  formatTaskList,
  formatMood,
  formatError,
  formatWelcome,
  formatHelp,
} from './messages.js';
export {
  handlePhoto,
  handleDocument,
  handleVoice,
  downloadFile,
} from './media.js';
