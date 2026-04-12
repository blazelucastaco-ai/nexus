#!/usr/bin/env tsx
/**
 * NEXUS Browser Bridge — live integration test
 * Starts the WebSocket bridge, waits for Chrome extension to connect,
 * then runs a series of real browser automation tasks.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import chalk from 'chalk';

const BRIDGE_PORT = 9338;
const CONNECT_TIMEOUT = 15_000;
const CMD_TIMEOUT = 20_000;

const VIOLET  = chalk.hex('#8B5CF6');
const EMERALD = chalk.hex('#34D399');
const ROSE    = chalk.hex('#F87171');
const AMBER   = chalk.hex('#FBBF24');
const PAD     = '  ';

// ─── Mini bridge for testing ──────────────────────────────────────────────────

let client: WebSocket | null = null;
const pending = new Map<string, { resolve: Function; reject: Function; timer: NodeJS.Timeout }>();

function send<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!client || client.readyState !== WebSocket.OPEN) throw new Error('Extension not connected');
  const id = nanoid();
  const msg = JSON.stringify({ id, type: 'command', action, params });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: ${action}`));
    }, CMD_TIMEOUT);
    pending.set(id, { resolve: resolve as Function, reject, timer });
    client!.send(msg);
  });
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(label: string, fn: () => Promise<void>) {
  process.stdout.write(`${PAD}${chalk.dim('→')} ${label.padEnd(44)}`);
  try {
    await fn();
    passed++;
    console.log(EMERALD('✓'));
  } catch (err) {
    failed++;
    console.log(ROSE('✗') + chalk.dim(` — ${err instanceof Error ? err.message : String(err)}`));
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log(`${PAD}${VIOLET.bold('◆ NEXUS')}  ${chalk.dim('Browser Bridge Test')}`);
  console.log(chalk.dim(`${PAD}${'─'.repeat(46)}`));
  console.log('');

  // Start WebSocket server
  const wss = new WebSocketServer({ port: BRIDGE_PORT, host: '127.0.0.1' });

  // Wait for extension to connect
  process.stdout.write(`${PAD}${chalk.dim('Waiting for Chrome extension')}${chalk.dim('…')}`);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Extension did not connect in time')), CONNECT_TIMEOUT);
      wss.on('connection', (ws) => {
        client = ws;
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
            if (msg.type === 'response') {
              const p = pending.get(msg.id);
              if (!p) return;
              clearTimeout(p.timer);
              pending.delete(msg.id);
              if (msg.success) p.resolve(msg.data);
              else p.reject(new Error(msg.error || 'Failed'));
            }
          } catch {}
        });
        ws.on('close', () => { client = null; });
        clearTimeout(timer);
        resolve();
      });
    });
    console.log(' ' + EMERALD('connected'));
  } catch (err) {
    console.log(' ' + ROSE('timeout'));
    console.log('');
    console.log(chalk.dim(`${PAD}Make sure Chrome is open with the NEXUS Bridge extension loaded.`));
    wss.close();
    process.exit(1);
  }

  console.log('');
  console.log(chalk.bold(`${PAD}Running tests`));
  console.log(chalk.dim(`${PAD}${'─'.repeat(32)}`));
  console.log('');

  // ── Test 1: Get active tab info ──────────────────────────────────────────────
  await test('get_info — active tab', async () => {
    const info = await send<{ url: string; title: string }>('get_info');
    assert(typeof info.url === 'string', 'No URL returned');
    console.log(chalk.dim(` (${info.url.slice(0, 50)})`));
  });

  // ── Test 2: List open tabs ───────────────────────────────────────────────────
  await test('get_tabs — list all tabs', async () => {
    const tabs = await send<Array<{ id: number; url: string; title: string }>>('get_tabs');
    assert(Array.isArray(tabs) && tabs.length > 0, 'No tabs returned');
    process.stdout.write(chalk.dim(` (${tabs.length} tab${tabs.length !== 1 ? 's' : ''})`));
  });

  // ── Test 3: Navigate to example.com ─────────────────────────────────────────
  await test('navigate — go to example.com', async () => {
    const result = await send<{ url: string; title: string }>('navigate', { url: 'https://example.com' });
    assert(result.url.includes('example.com'), `Wrong URL: ${result.url}`);
  });

  // ── Test 4: Extract full page content ───────────────────────────────────────
  await test('extract — page text + links', async () => {
    const data = await send<{ title: string; text: string; links: unknown[] }>('extract');
    assert(typeof data.title === 'string' && data.title.length > 0, 'No title');
    assert(typeof data.text === 'string' && data.text.length > 10, 'No text content');
    process.stdout.write(chalk.dim(` ("${data.title}")`));
  });

  // ── Test 5: Extract specific element ────────────────────────────────────────
  await test('extract — specific selector (h1)', async () => {
    const data = await send<string>('extract', { selector: 'h1' });
    assert(data !== null, 'h1 not found');
    process.stdout.write(chalk.dim(` ("${String(data).trim().slice(0, 40)}")`));
  });

  // ── Test 6: Evaluate JS in page ─────────────────────────────────────────────
  await test('evaluate — run JS in page', async () => {
    const result = await send<{ result: string }>('evaluate', {
      code: 'return document.querySelectorAll("a").length + " links on page"',
    });
    assert(result.result.includes('links'), `Unexpected result: ${result.result}`);
    process.stdout.write(chalk.dim(` (${result.result})`));
  });

  // ── Test 7: Screenshot current tab ──────────────────────────────────────────
  await test('screenshot — capture visible tab', async () => {
    const shot = await send<{ base64: string; mimeType: string }>('screenshot');
    assert(typeof shot.base64 === 'string' && shot.base64.length > 1000, 'Screenshot too small');
    process.stdout.write(chalk.dim(` (${Math.round(shot.base64.length / 1024)} KB PNG)`));
  });

  // ── Test 8: Navigate to GitHub ───────────────────────────────────────────────
  await test('navigate — go to github.com', async () => {
    const result = await send<{ url: string; title: string }>('navigate', { url: 'https://github.com' });
    assert(result.url.includes('github'), `Wrong URL: ${result.url}`);
  });

  // ── Test 9: Extract GitHub links ─────────────────────────────────────────────
  await test('extract — links from github.com', async () => {
    const data = await send<{ links: Array<{ text: string; href: string }> }>('extract');
    assert(Array.isArray(data.links) && data.links.length > 0, 'No links returned');
    process.stdout.write(chalk.dim(` (${data.links.length} links found)`));
  });

  // ── Test 10: Navigate to DuckDuckGo and search ───────────────────────────────
  await test('navigate — duckduckgo.com', async () => {
    await send('navigate', { url: 'https://duckduckgo.com' });
    const info = await send<{ url: string }>('get_info');
    assert(info.url.includes('duckduckgo'), `Wrong URL: ${info.url}`);
  });

  // ── Test 11: Type into DuckDuckGo search box ─────────────────────────────────
  await test('type — search input on DuckDuckGo', async () => {
    await send('wait_for', { selector: 'input[name="q"], #searchbox_input, #search_form_input_homepage', timeout: 5000 });
    await send('click', { selector: 'input[name="q"], #searchbox_input, #search_form_input_homepage' });
    await send('type', { text: 'NEXUS AI agent macOS' });
    const result = await send<string>('extract', {
      selector: 'input[name="q"], #searchbox_input, #search_form_input_homepage',
      attribute: 'value',
    });
    assert(String(result).includes('NEXUS'), `Input value wrong: ${result}`);
  });

  // ── Test 12: Scroll the page ──────────────────────────────────────────────────
  await test('scroll — scroll down 500px', async () => {
    await send('scroll', { y: 500 });
    // No assertion needed — just verify it didn't throw
  });

  // ── Test 13: Open a new tab ───────────────────────────────────────────────────
  await test('new_tab — open anthropic.com', async () => {
    const tab = await send<{ id: number; url: string }>('new_tab', { url: 'https://www.anthropic.com' });
    assert(typeof tab.id === 'number', 'No tab ID returned');
    process.stdout.write(chalk.dim(` (tab ${tab.id})`));
  });

  // ── Test 14: List tabs after new tab ─────────────────────────────────────────
  await test('get_tabs — should have more tabs now', async () => {
    const tabs = await send<Array<{ id: number }>>('get_tabs');
    assert(tabs.length >= 2, `Only ${tabs.length} tab(s) open`);
    process.stdout.write(chalk.dim(` (${tabs.length} tabs)`));
  });

  // ── Test 15: Close the extra tab ─────────────────────────────────────────────
  await test('close_tab — close active tab', async () => {
    await send('close_tab');
    const tabs = await send<Array<{ id: number }>>('get_tabs');
    assert(Array.isArray(tabs), 'Could not verify tabs after close');
  });

  // ── Summary ──────────────────────────────────────────────────────────────────

  console.log('');
  console.log(chalk.dim(`${PAD}${'─'.repeat(46)}`));
  console.log('');

  const total = passed + failed;
  if (failed === 0) {
    console.log(`${PAD}${EMERALD('◆')} ${chalk.bold('All tests passed')}  ${chalk.dim(`${passed}/${total}`)}`);
  } else {
    console.log(`${PAD}${AMBER('◆')} ${chalk.bold(`${passed}/${total} passed`)}  ${ROSE(`${failed} failed`)}`);
  }

  console.log('');

  wss.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(ROSE(`\n${PAD}Fatal: ${err.message}`));
  process.exit(1);
});
