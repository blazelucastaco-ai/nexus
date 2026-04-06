import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

const NEXUS_DIR = join(homedir(), '.nexus');
const LOG_DIR = join(NEXUS_DIR, 'logs');

// Ensure log directories exist
mkdirSync(LOG_DIR, { recursive: true });

const level = process.env.LOG_LEVEL ?? 'info';

const rootLogger: Logger = pino({
  level,
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        level,
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
      {
        target: 'pino/file',
        level,
        options: {
          destination: join(NEXUS_DIR, 'nexus.log'),
          mkdir: true,
        },
      },
    ],
  },
});

/**
 * Create a child logger scoped to a specific component.
 *
 * @param name - Component or module name (e.g. 'MemoryManager', 'TelegramBot')
 * @returns A pino child logger with the component field set
 */
export function createLogger(name: string): Logger {
  return rootLogger.child({ component: name });
}

export default rootLogger;
