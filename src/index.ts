import 'dotenv/config';
import { loadConfig } from './config.js';
import { setUserName } from './core/user-name.js';
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
import { taskOverlayBridge } from './core/task-overlay-bridge.js';
import { setMcpToolExecutor } from './mcp/server.js';
import { WebServer } from './web/server.js';
import { WebGateway } from './web/gateway.js';
import { PhoneGateway } from './phone/gateway.js';
import { PhoneLink } from './webrtc/phone-link.js';
import { ApnsSender, apnsConfigFromEnv } from './push/apns.js';
import { loadPhoneConfig } from './phone/types.js';
import { createTelephonyProvider } from './phone/provider.js';
import { WEB_FALLBACK_CHAT_ID } from './web/protocol.js';
import { WakeListener } from './web/wake.js';
import { TtsService } from './web/tts.js';

const log = createLogger('Main');

async function main() {
  log.info('Initializing NEXUS...');

  // Load configuration
  const config = loadConfig();
  setUserName(config.userName); // so prompts address the user by name (never hardcoded)

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
  const learning = new LearningSystem(cortex);

  log.info('Initializing Telegram bot...');
  const telegram = new TelegramGateway({
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
  });

  // Start browser bridge (Chrome extension WebSocket server)
  log.info('Starting browser bridge...');
  browserBridge.start();

  // Start task overlay bridge — broadcasts task lifecycle events on a
  // separate local WS port (9339) so the installer-app overlay window
  // can render orange-tint + pill-bar + confetti during tasks.
  log.info('Starting task overlay bridge...');
  taskOverlayBridge.start();

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

  // Jarvis web interface — declared here so graceful shutdown can stop it.
  let webServer: WebServer | undefined;
  let webGateway: WebGateway | undefined;
  let wakeListener: WakeListener | undefined;
  let tts: TtsService | undefined;
  let phoneGateway: PhoneGateway | undefined;
  let phoneLink: PhoneLink | undefined;

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info('Received shutdown signal');
    wakeListener?.stop();
    tts?.stop();
    phoneLink?.stop();
    void phoneGateway?.stop();
    webGateway?.stop();
    webServer?.stop();
    browserBridge.stop();
    taskOverlayBridge.stop();
    await orchestrator.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Don't let an unhandled rejection silently crash the daemon. launchd
  // will KeepAlive restart, but every in-flight conversation is lost on
  // a cold restart. Log + Telegram-notify so the user knows the daemon
  // recovered from something bad.
  process.on('unhandledRejection', (reason) => {
    log.fatal({ reason }, 'unhandled_rejection');
    try {
      const chatId = config.telegram.chatId;
      if (chatId) {
        telegram.sendMessage(
          chatId,
          `⚠️ NEXUS hit an unhandled promise rejection and recovered. Check logs.\n\n<code>${String(reason).slice(0, 200)}</code>`,
          { parseMode: 'HTML' },
        ).catch(() => null);
      }
    } catch { /* ignore — we're already in a bad state */ }
  });

  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught_exception');
    // Let the process actually exit so launchd restarts — an uncaught
    // exception has put us in an unknown state that we shouldn't try to
    // recover from in-process.
    setTimeout(() => process.exit(1), 100);
  });

  // Start everything
  await orchestrator.start();

  // Jarvis web interface — a second door into the SAME brain. By reusing the
  // primary Telegram chatId it shares memory and the live conversation thread
  // (the orchestrator's history is one shared array). Non-fatal: the daemon and
  // Telegram keep running even if the port is busy or the frontend isn't built.
  try {
    const webChatId = config.telegram.chatId || WEB_FALLBACK_CHAT_ID;
    webServer = new WebServer({ chatId: webChatId, version: '0.2.13' });
    tts = new TtsService(config.tts);
    webGateway = new WebGateway(orchestrator, webServer, webChatId, tts);
    webServer.start();
    webGateway.start();
    void tts.start();

    // Phone companion (orb-only): a 2nd gateway over an E2E WebRTC channel feeding the
    // SAME brain + memory, reachable from anywhere via the self-hosted rendezvous. Starts
    // only when NEXUS_SIGNAL_URL is set (the installer wires it); best-effort like the rest.
    const signalUrl = process.env.NEXUS_SIGNAL_URL?.trim();
    if (signalUrl) {
      const iceServers = (process.env.NEXUS_ICE_SERVERS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const apnsCfg = apnsConfigFromEnv();
      phoneLink = new PhoneLink(orchestrator, tts, {
        signalUrl, iceServers, chatId: webChatId,
        apns: apnsCfg ? new ApnsSender(apnsCfg) : undefined,
      });
      phoneLink.start();
      log.info({ signalUrl, paired: phoneLink.isPaired }, 'phone companion link started');
    }

    // Loopback control hook for the installer's launch-choice + "learn about you"
    // buttons — each command drives the ONE brain (no parallel path). The two intros
    // are genuine self-introductions through the orchestrator; the research is a
    // bounded, READ-ONLY scan that remembers a few durable facts about the user.
    const INTRO_TELEGRAM =
      "Introduce yourself to me — this is the very first thing you're saying to me, I just finished setting you up. " +
      'First person, warm and concise: who you are, that you live on this Mac with persistent memory and real control of it, ' +
      'and the main things you can do for me. A few natural sentences, not a manual.';
    const INTRO_VOICE =
      "Greet me out loud — I've just brought you online for the very first time. Briefly introduce yourself: who you are, " +
      'and that I can simply talk to you. Calm and composed.';
    const DEEP_RESEARCH =
      'Build a profile of me by inspecting THIS Mac, read-only, then remember what you learn. ' +
      'You MAY: list installed apps and call get_system_info; list non-hidden folders under my home ' +
      '(Desktop, Documents, Downloads, Projects); read README / package.json / obvious project descriptors to learn what I build; ' +
      'note my dev stack and the tools I use a lot. ' +
      'You MUST NOT: read or open any secret, key, token, .env, .ssh, Keychain, password store, browser profile, or git credentials; ' +
      'never write, move, or delete any file; never run a destructive or network-exfiltrating command. ' +
      'Keep the scan bounded — a quick pass over those folders, not the whole disk. ' +
      'When done, store 5 to 15 durable facts about me with the remember tool (high importance), each a single clear sentence.';
    webServer.onControl(async (cmd) => {
      try {
        if (cmd === 'telegram-intro') {
          const tgChat = config.telegram.chatId;
          if (!tgChat) return { ok: false };
          const reply = await orchestrator.handleMessage(tgChat, INTRO_TELEGRAM);
          if (reply.trim()) await telegram.sendMessage(tgChat, reply);
          return { ok: true };
        }
        if (cmd === 'voice-intro') {
          webGateway?.submitUserText(INTRO_VOICE);
          return { ok: true };
        }
        if (cmd === 'deep-research') {
          // Long-running task — fire and forget so the HTTP response is instant;
          // progress surfaces on Telegram + the activity feed.
          void orchestrator.handleMessage(webChatId, DEEP_RESEARCH).catch((err) => log.warn({ err }, 'deep-research job failed'));
          return { ok: true };
        }
        if (cmd === 'start-pairing') {
          // Show the QR at the end of setup: mint a single-use pairing offer + render it.
          if (!phoneLink) return { ok: false, error: 'phone link unavailable (set NEXUS_SIGNAL_URL)' };
          const payload = phoneLink.beginPairing();
          const QRCode = (await import('qrcode')).default;
          const qrDataUrl = await QRCode.toDataURL(JSON.stringify(payload), { margin: 1, width: 220, errorCorrectionLevel: 'M' });
          // payload is returned too (loopback only) so an automated harness can pair.
          return { ok: true, qrDataUrl, expiresAt: payload.exp, payload };
        }
      } catch (err) {
        log.warn({ err, cmd }, 'control command failed');
      }
      return { ok: false };
    });

    // Wake word — "Hey Nexus" opens/focuses the Jarvis UI and starts it
    // listening. On-device speech (local, no keys, no network); only the literal
    // token "WAKE" ever reaches the daemon. Non-fatal: everything else keeps
    // running even if it can't arm (no Swift, denied permission, no mic).
    const wsRef = webServer;
    const wgRef = webGateway;
    // Wake word → wake the native Jarvis window (it shows itself on the wake
    // frame). The helper also transcribes the spoken command on-device; route
    // that straight through the same brain as a typed message.
    wakeListener = new WakeListener(
      () => wsRef.broadcastWake(),
      (cmd) => wgRef.submitUserText(cmd),
    );
    wsRef.wakeWordEnabled = await wakeListener.start();
  } catch (err) {
    log.warn({ err }, 'Jarvis web interface failed to start — continuing without it');
  }

  // Phone — a THIRD door into the same brain (see PHONE_SETUP.md). Provisioning a
  // real number needs a telephony account + carrier registration (yours to set up).
  // Once NEXUS_PHONE_* + the provider creds are in the env and the provider is
  // built, calls bridge through the same orchestrator + ElevenLabs voice with per-caller
  // memory isolation and barge-in. Fully dormant + non-fatal when unconfigured.
  try {
    const phoneConfig = loadPhoneConfig();
    if (phoneConfig) {
      try {
        const provider = await createTelephonyProvider(phoneConfig);
        if (!tts) { tts = new TtsService(config.tts); void tts.start(); }
        const phoneChatId = config.telegram.chatId || WEB_FALLBACK_CHAT_ID;
        phoneGateway = new PhoneGateway(orchestrator, tts, provider, phoneConfig, phoneChatId);
        await phoneGateway.start();
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, 'Phone configured but the telephony provider is not built yet — see PHONE_SETUP.md');
      }
    } else {
      log.debug('Phone not configured (set NEXUS_PHONE_* + provider creds to enable) — running without it');
    }
  } catch (err) {
    log.warn({ err }, 'Phone init skipped');
  }

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
