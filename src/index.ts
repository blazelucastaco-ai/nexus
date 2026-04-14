import 'dotenv/config';
import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { Orchestrator } from './core/orchestrator.js';
import { MemoryManager } from './memory/index.js';
import { MemoryCortex } from './memory/cortex.js';
import { PersonalityEngine } from './personality/index.js';
import { AgentManager } from './agents/index.js';
import { AIManager } from './ai/index.js';
import { TelegramGateway } from './telegram/index.js';
import { MacOSController } from './macos/index.js';
import { LearningSystem } from './learning/index.js';
import { EmbeddingProvider } from './providers/embeddings.js';
import { checkPermissions, warnMissingPermissions } from './macos/permissions.js';
import { browserBridge } from './browser/bridge.js';
import { setMcpToolExecutor } from './mcp/server.js';

const log = createLogger('Main');

async function main() {
  log.info('Initializing NEXUS...');

  // Load configuration
  const config = loadConfig();

  // Initialize subsystems
  log.info('Initializing memory system...');
  const memory = new MemoryManager(config.memory.maxShortTerm);

  // Wire semantic embeddings — OpenAI gives true semantic search, local works offline
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const embeddingProvider = new EmbeddingProvider('openai', { apiKey: openaiKey });
    memory.setEmbeddingProvider(embeddingProvider, 'text-embedding-3-small');
    log.info('Semantic embeddings: OpenAI text-embedding-3-small');
  } else {
    const embeddingProvider = new EmbeddingProvider('local');
    memory.setEmbeddingProvider(embeddingProvider, 'local');
    log.info('Semantic embeddings: local (set OPENAI_API_KEY for semantic search)');
  }

  log.info('Initializing personality engine...');
  const personality = new PersonalityEngine(config);

  log.info('Initializing AI providers...');
  const ai = new AIManager(config.ai.provider);

  log.info('Initializing macOS controller...');
  const macos = new MacOSController();

  log.info('Initializing agents...');
  const agents = new AgentManager();

  log.info('Initializing learning system...');
  const cortex = new MemoryCortex();
  cortex.initialize();
  const learning = new LearningSystem(cortex);

  log.info('Initializing Telegram bot...');
  const telegram = new TelegramGateway({
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
  });

  // Start browser bridge (Chrome extension WebSocket server)
  log.info('Starting browser bridge...');
  browserBridge.start();

  // Notify Telegram when the Chrome extension connects / disconnects
  browserBridge.onConnect(() => {
    const chatId = config.telegram.chatId;
    if (chatId) {
      telegram.sendMessage(chatId, '🌐 Chrome extension connected — browser control is live.')
        .catch((err) => log.warn({ err }, 'Failed to send browser connect notification'));
    }
    log.info('Browser bridge: Chrome extension is connected');
  });

  browserBridge.onDisconnect(() => {
    const chatId = config.telegram.chatId;
    if (chatId) {
      telegram.sendMessage(chatId, '⚠️ Chrome extension disconnected — browser tools unavailable until it reconnects.')
        .catch((err) => log.warn({ err }, 'Failed to send browser disconnect notification'));
    }
    log.warn('Browser bridge: Chrome extension disconnected');
  });

  // Create and wire up orchestrator
  const orchestrator = new Orchestrator();
  orchestrator.init({ memory, personality, agents, ai, telegram, macos, learning });

  // Wire orchestrator into gateway for command handlers
  telegram.setOrchestrator(orchestrator);

  // Wire MCP server so tools/call requests can dispatch to the tool executor
  setMcpToolExecutor(orchestrator.toolExecutor);

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info('Received shutdown signal');
    browserBridge.stop();
    await orchestrator.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start everything
  await orchestrator.start();

  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log.info('  NEXUS is alive. Waiting for messages...');
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Check macOS permissions and warn via Telegram if anything is missing
  const chatId = config.telegram.chatId;
  if (chatId) {
    try {
      const permStatus = await checkPermissions();
      const warnings = await warnMissingPermissions(permStatus);
      if (warnings.length > 0) {
        await telegram.sendMessage(chatId, warnings[0], { parseMode: 'HTML' }).catch((err) => log.warn({ err }, 'Failed to send permission warning'));
      }
    } catch (err) {
      log.warn({ err }, 'Permission check failed — skipping');
    }
  }
}

main().catch((err) => {
  log.fatal({ err }, 'Failed to start NEXUS');
  process.exit(1);
});
