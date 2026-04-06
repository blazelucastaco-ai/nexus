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

// ─── Intercept agent results for debug output ─────────────────────────────

function wrapOrchestratorForDebug(orchestrator: Orchestrator) {
  const originalDelegate = orchestrator.delegateToAgent.bind(orchestrator);
  const agentLog: string[] = [];

  // Patch delegateToAgent to capture debug info
  (orchestrator as any).delegateToAgent = async (agentName: string, task: string) => {
    agentLog.push(`→ [${agentName}] delegated: ${task.slice(0, 80)}${task.length > 80 ? '…' : ''}`);
    const result = await originalDelegate(agentName as any, task);
    if (result.success) {
      const dataSummary = typeof result.data === 'string'
        ? result.data.slice(0, 100)
        : JSON.stringify(result.data).slice(0, 100);
      agentLog.push(`  ✓ [${agentName}] (${result.duration}ms): ${dataSummary}`);
    } else {
      agentLog.push(`  ✗ [${agentName}] failed: ${result.error ?? 'unknown'}`);
    }
    return result;
  };

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
  process.once('exit', () => closeDatabase());
  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));

  // Stub telegram — orchestrator's handleMessage never calls telegram directly.
  // We only need the type to satisfy TypeScript; no methods will be invoked.
  const telegramStub = {
    start: async () => {},
    stop: () => {},
    sendMessage: async () => {},
    setOrchestrator: () => {},
    onMessage: () => {},
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

  const { agentLog } = wrapOrchestratorForDebug(orchestrator);

  // ── Single message mode ──────────────────────────────────────────────
  if (!isInteractive && singleMessage) {
    console.log('');
    console.log(chalk.bold.green('  you > ') + chalk.white(singleMessage));
    console.log(chalk.dim('  processing...'));

    agentLog.length = 0;
    try {
      const response = await orchestrator.processMessage(singleMessage, 'dev-cli');
      printResponse(response, [...agentLog]);
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
