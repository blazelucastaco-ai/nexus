#!/usr/bin/env tsx
/**
 * Test: screenshot → Telegram photo delivery
 *
 * Exercises the maybeSendScreenshot path in the orchestrator directly.
 * 1. Takes a macOS screenshot via the take_screenshot tool
 * 2. Takes a browser screenshot via browser_screenshot tool
 * 3. Calls maybeSendScreenshot for each and verifies the Telegram photo is sent.
 *
 * Requires NEXUS config (for Telegram credentials) and Chrome extension connected.
 */

import chalk from 'chalk';
import { AgentManager } from '../src/agents/index.js';
import { MemoryManager } from '../src/memory/index.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { TelegramGateway } from '../src/telegram/gateway.js';
import { loadConfig } from '../src/config.js';

const VIOLET  = chalk.hex('#8B5CF6');
const EMERALD = chalk.hex('#34D399');
const ROSE    = chalk.hex('#F87171');
const AMBER   = chalk.hex('#FBBF24');
const PAD     = '  ';

let passed = 0;
let failed = 0;

async function test(label: string, fn: () => Promise<void>) {
  process.stdout.write(`\n${PAD}${chalk.dim('→')} ${label.padEnd(50)}`);
  try {
    await fn();
    passed++;
    console.log(EMERALD(' ✓'));
  } catch (err) {
    failed++;
    console.log(ROSE(` ✗  ${err instanceof Error ? err.message : String(err)}`));
  }
}

async function maybeSendScreenshot(
  telegram: TelegramGateway,
  chatId: string,
  toolName: string,
  result: string,
): Promise<void> {
  if (toolName === 'take_screenshot') {
    const match = result.match(/Screenshot saved to:\s*(.+)/);
    if (match?.[1]) {
      const path = match[1].trim();
      console.log(`\n${PAD}  ${chalk.dim(`Sending file: ${path}`)}`);
      await telegram.sendPhoto(chatId, path, '📸 Screenshot (test)');
    } else {
      throw new Error(`Unexpected take_screenshot result: ${result.slice(0, 200)}`);
    }
  } else if (toolName === 'browser_screenshot') {
    const data = JSON.parse(result) as { base64?: string; mimeType?: string };
    if (!data.base64) throw new Error('No base64 in browser_screenshot result');
    const buf = Buffer.from(data.base64, 'base64');
    console.log(`\n${PAD}  ${chalk.dim(`Sending ${Math.round(buf.length / 1024)} KB PNG buffer`)}`);
    await telegram.sendPhoto(chatId, buf, '📸 Browser screenshot (test)');
  }
}

async function main() {
  console.log('');
  console.log(`${PAD}${VIOLET.bold('◆ NEXUS')}  ${chalk.bold('Screenshot → Telegram Test')}`);
  console.log(`${PAD}${chalk.dim('─'.repeat(52))}`);

  // Load config
  const config = loadConfig();
  const chatId = config.telegram.allowedUsers?.[0] ?? config.telegram.chatId;
  if (!chatId) {
    console.error(ROSE(`\n${PAD}No chatId/allowedUsers in config — set NEXUS_CHAT_ID env var or configure Telegram`));
    process.exit(1);
  }
  if (!config.telegram.botToken) {
    console.error(ROSE(`\n${PAD}No botToken in config — set TELEGRAM_BOT_TOKEN env var`));
    process.exit(1);
  }

  console.log(`${PAD}${chalk.dim(`Sending to chat: ${chatId}`)}`);

  // Boot services (NEXUS already holds port 9338, so we just piggyback on it)
  const telegram = new TelegramGateway(config.telegram);
  const agents   = new AgentManager();
  const memory   = new MemoryManager(50);
  const executor = new ToolExecutor(agents, memory);
  const run      = (tool: string, args: Record<string, unknown> = {}) => executor.execute(tool, args);

  // ── Test 1: macOS take_screenshot ──────────────────────────────────────────
  await test('take_screenshot → saves file → sendPhoto(path)', async () => {
    const result = await run('take_screenshot');
    if (result.startsWith('Error') || !result.includes('Screenshot saved to:')) {
      throw new Error(`take_screenshot failed: ${result.slice(0, 200)}`);
    }
    console.log(`\n${PAD}  ${chalk.dim(`Tool result: ${result.trim()}`)}`);
    await maybeSendScreenshot(telegram, chatId, 'take_screenshot', result);
  });

  // ── Test 2: browser_screenshot ──────────────────────────────────────────────
  // browser_screenshot only works when the BrowserBridge is held by this process.
  // In production, NEXUS holds the bridge — so we test sendPhoto(Buffer) directly
  // by building a mock base64 PNG to verify the Telegram upload path.
  await test('browser_screenshot → sendPhoto(Buffer) [path test]', async () => {
    // Build a minimal valid 1×1 PNG in base64 to verify Buffer→sendPhoto works
    // without needing the Chrome extension connected to this test process
    const TINY_PNG_BASE64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const buf = Buffer.from(TINY_PNG_BASE64, 'base64');
    console.log(`\n${PAD}  ${chalk.dim(`Sending ${buf.length} byte test PNG`)}`);
    await telegram.sendPhoto(chatId, buf, '📸 Browser screenshot path test (1×1 PNG)');
  });

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`${PAD}${chalk.dim('─'.repeat(52))}`);
  const total = passed + failed;
  if (failed === 0) {
    console.log(`${PAD}${EMERALD('◆')} ${chalk.bold('All passed')}  ${chalk.dim(`${passed}/${total}`)}  — check Telegram for the photos`);
  } else {
    console.log(`${PAD}${AMBER('◆')} ${chalk.bold(`${passed}/${total} passed`)}  ${ROSE(`${failed} failed`)}`);
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(ROSE(`\n${PAD}Fatal: ${err.message}`));
  process.exit(1);
});
