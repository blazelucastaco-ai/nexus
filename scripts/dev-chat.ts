#!/usr/bin/env tsx
// ─── NEXUS Dev Chat ────────────────────────────────────────────────────────
// Standalone dev/testing script — chat with NEXUS directly from the terminal.
// Bypasses Telegram entirely. Useful for testing agent delegation, memory,
// and personality without needing a Telegram bot.
//
// Usage:
//   pnpm dev:chat                          # interactive REPL
//   pnpm dev:chat "hello nexus"            # single message
//   npx tsx scripts/dev-chat.ts --interactive
//   npx tsx scripts/dev-chat.ts "list files on my desktop"

import 'dotenv/config';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';

import chalk from 'chalk';

import { loadConfig } from '../src/config.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { MemoryManager } from '../src/memory/index.js';
import { MemoryCortex } from '../src/memory/cortex.js';
import { closeDatabase } from '../src/memory/database.js';
import { PersonalityEngine } from '../src/personality/index.js';
import { AgentManager } from '../src/agents/index.js';
import { AIManager } from '../src/ai/index.js';
import { MacOSController } from '../src/macos/index.js';
import { LearningSystem } from '../src/learning/index.js';
import { browserBridge } from '../src/browser/bridge.js';
import type { TelegramGateway } from '../src/telegram/index.js';

// ─── Display Helpers ──────────────────────────────────────────────────────

function showHeader() {
  console.log('');
  console.log(chalk.bold.cyan('  ◈ NEXUS') + chalk.dim(' dev chat'));
  console.log(chalk.dim('  ─────────────────────────────────────────────'));
  console.log(chalk.dim('  Bypassing Telegram. Talking directly to the brain.'));
  console.log('');
}

function showPrompt() {
  process.stdout.write(chalk.bold.green('\n  you > '));
}

function printResponse(response: string, agentLines: string[]) {
  console.log('');
  console.log(chalk.bold.cyan('  nexus > '));
  console.log('');

  // Print response with indentation
  for (const line of response.split('\n')) {
    console.log('    ' + chalk.white(line));
  }

  // Show agent delegation info if any
  if (agentLines.length > 0) {
    console.log('');
    console.log(chalk.dim('  ── agent activity ──'));
    for (const line of agentLines) {
      console.log(chalk.dim('  ' + line));
    }
  }

  console.log('');
}

// ─── Debug log (tool calls are now logged by the ToolExecutor) ───────────

function createDebugLog() {
  const agentLog: string[] = [];
  return { agentLog };
}

// ─── Initialization ───────────────────────────────────────────────────────

async function initNexus() {
  const config = loadConfig();

  const memory = new MemoryManager(config.memory.maxShortTerm);
  const personality = new PersonalityEngine(config);
  const ai = new AIManager(config.ai.provider);
  const macos = new MacOSController();
  const agents = new AgentManager();
  const cortex = new MemoryCortex();
  cortex.initialize(); // creates tables in memory.db (mistakes, preferences, etc.)
  const learning = new LearningSystem(cortex);

  // Ensure SQLite WAL is checkpointed and memories are flushed on exit.
  // closeDatabase() calls db.close() which performs a full WAL checkpoint.
  process.once('exit', () => { try { closeDatabase(); } catch {} try { browserBridge.stop(); } catch {} });
  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));

  // Dev telegram stub — prints all Telegram messages to the console
  // so we can see task runner progress updates in the terminal.
  let fakeMessageId = 1000;
  const fakeMessages = new Map<number, string>();

  const telegramStub = {
    start: async () => {},
    stop: () => {},
    setOrchestrator: () => {},
    onMessage: () => {},

    sendMessage: async (_chatId: string, text: string) => {
      const plain = text.replace(/<[^>]+>/g, '').trim();
      console.log('');
      console.log(chalk.bold.cyan('  [telegram:send] '));
      for (const line of plain.split('\n')) {
        console.log('    ' + chalk.white(line));
      }
    },

    sendStreamingMessage: async (_chatId: string, text: string) => {
      const id = fakeMessageId++;
      fakeMessages.set(id, text);
      const plain = text.replace(/<[^>]+>/g, '').trim();
      if (plain && plain !== '⏳') {
        console.log(chalk.dim(`\n  [telegram:stream#${id}] `) + chalk.white(plain));
      }
      return id;
    },

    editMessage: async (_chatId: string, messageId: number, text: string) => {
      fakeMessages.set(messageId, text);
      // Don't spam console for every edit — only show meaningful changes
    },

    finalizeStreamingMessage: async (_chatId: string, messageId: number, text: string) => {
      fakeMessages.set(messageId, text);
      const plain = text.replace(/<[^>]+>/g, '').trim();
      if (plain) {
        console.log('');
        console.log(chalk.dim(`  [telegram:msg#${messageId}]`));
        for (const line of plain.split('\n')) {
          console.log('    ' + chalk.cyan(line));
        }
      }
    },

    sendTypingAction: async () => {},
    sendPhoto: async () => {},
    sendDocument: async () => {},
  } as unknown as TelegramGateway;

  const orchestrator = new Orchestrator();
  orchestrator.init({
    memory,
    personality,
    agents,
    ai,
    telegram: telegramStub,
    macos,
    learning,
  });
  // Start browser bridge so browser_* tools work in dev-chat.
  // (Requires NEXUS service to be stopped first so port 9338 is free.)
  try {
    browserBridge.start();
    console.log(chalk.dim('  Browser bridge listening on :9338'));
    // Give the Chrome extension a moment to reconnect
    await new Promise<void>((resolve) => {
      if (browserBridge.isConnected) { resolve(); return; }
      const t = setTimeout(resolve, 35000); // wait up to 35s (alarm fires every 24s)
      browserBridge.onConnect(() => { clearTimeout(t); resolve(); });
    });
    if (browserBridge.isConnected) {
      console.log(chalk.green('  ✓ Chrome extension connected — browser tools ready'));
    } else {
      console.log(chalk.dim('  ⚠ Chrome extension not connected — browser tools will fail until it connects'));
    }
  } catch (e) {
    console.log(chalk.dim(`  ⚠ Browser bridge failed to start: ${e instanceof Error ? e.message : String(e)}`));
    console.log(chalk.dim('  (Is NEXUS still running? Stop it first with: launchctl stop com.nexus.ai)'));
  }

  // Note: we intentionally do NOT call orchestrator.start() — that would
  // attempt to connect to Telegram. processMessage() works without it.

  return orchestrator;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isInteractive = args.includes('--interactive') || args.length === 0;
  const singleMessage = args.filter((a) => !a.startsWith('--')).join(' ');

  showHeader();

  console.log(chalk.dim('  Initializing NEXUS subsystems...'));
  let orchestrator: Orchestrator;
  try {
    orchestrator = await initNexus();
    console.log(chalk.green('  ✓ Ready'));
  } catch (err) {
    console.log(chalk.red('  ✗ Failed to initialize NEXUS:'));
    console.log(chalk.dim('  ' + String(err)));
    console.log('');
    console.log(chalk.dim('  Make sure you have run `nexus setup` and your config is valid.'));
    process.exit(1);
  }

  const { agentLog } = createDebugLog();

  // ── Single message mode ──────────────────────────────────────────────
  if (!isInteractive && singleMessage) {
    console.log('');
    console.log(chalk.bold.green('  you > ') + chalk.white(singleMessage));
    console.log(chalk.dim('  processing...'));

    agentLog.length = 0;
    try {
      const response = await orchestrator.processMessage(singleMessage, 'dev-cli');
      printResponse(response, [...agentLog]);
      // Wait for any background task (task engine) to finish before exiting
      await orchestrator.waitForPendingTasks();
    } catch (err) {
      console.log(chalk.red('  Error: ') + String(err));
    }
    process.exit(0);
  }

  // ── Interactive REPL ─────────────────────────────────────────────────
  console.log(chalk.dim('  Type a message and press Enter. Use /quit to exit.'));
  console.log('');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: '',
  });

  const handleLine = async (line: string) => {
    const text = line.trim();

    if (!text) {
      showPrompt();
      return;
    }

    if (text === '/quit' || text === '/exit' || text === 'exit' || text === 'quit') {
      console.log('');
      console.log(chalk.dim('  Shutting down. Memory persisted.'));
      console.log('');
      rl.close();
      process.exit(0);
    }

    console.log(chalk.dim('\n  processing...'));

    agentLog.length = 0;
    try {
      const response = await orchestrator.processMessage(text, 'dev-cli');
      printResponse(response, [...agentLog]);
      await orchestrator.waitForPendingTasks();
    } catch (err) {
      console.log('');
      console.log(chalk.red('  Error: ') + String(err));
      console.log('');
    }

    showPrompt();
  };

  rl.on('line', handleLine);
  rl.on('close', () => {
    console.log('');
    process.exit(0);
  });

  showPrompt();
}

main().catch((err) => {
  console.error(chalk.red('Fatal:'), err);
  process.exit(1);
});
