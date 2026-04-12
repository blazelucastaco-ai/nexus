#!/usr/bin/env tsx
/**
 * NEXUS Browser Integration Test
 * Exercises the full dispatch chain: ToolExecutor → AgentManager → BrowserAgent → BrowserBridge → Chrome
 */

import chalk from 'chalk';
import { AgentManager } from '../src/agents/index.js';
import { MemoryManager } from '../src/memory/index.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { browserBridge } from '../src/browser/bridge.js';

const VIOLET  = chalk.hex('#8B5CF6');
const EMERALD = chalk.hex('#34D399');
const ROSE    = chalk.hex('#F87171');
const AMBER   = chalk.hex('#FBBF24');
const DIM     = chalk.dim;
const PAD     = '  ';

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(label: string, fn: () => Promise<void>) {
  process.stdout.write(`${PAD}${DIM('→')} ${label.padEnd(46)}`);
  try {
    await fn();
    passed++;
    console.log(EMERALD('✓'));
  } catch (err) {
    failed++;
    console.log(ROSE('✗') + DIM(` — ${err instanceof Error ? err.message : String(err)}`));
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertContains(result: string, substring: string, label = substring) {
  if (!result.toLowerCase().includes(substring.toLowerCase())) {
    throw new Error(`Expected "${label}" in result. Got: ${result.slice(0, 120)}`);
  }
}

function assertNoError(result: string) {
  if (result.startsWith('Error:') || result.startsWith('Browser error:')) {
    throw new Error(result.slice(0, 200));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log(`${PAD}${VIOLET.bold('◆ NEXUS')}  ${DIM('Browser Integration Test')}`);
  console.log(`${PAD}${DIM('Testing: ToolExecutor → AgentManager → BrowserAgent → BrowserBridge → Chrome')}`);
  console.log(DIM(`${PAD}${'─'.repeat(50)}`));
  console.log('');

  // Boot the bridge server
  browserBridge.start();

  // Wait for Chrome extension to connect
  process.stdout.write(`${PAD}${DIM('Waiting for Chrome extension')}${DIM('…')}`);
  try {
    await new Promise<void>((resolve, reject) => {
      if (browserBridge.isConnected) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error('Timeout — make sure NEXUS Bridge extension is loaded in Chrome')), 15_000);
      browserBridge.onConnect(() => { clearTimeout(timer); resolve(); });
    });
    console.log(' ' + EMERALD('connected'));
  } catch (err) {
    console.log(' ' + ROSE('timeout'));
    console.log(DIM(`${PAD}Open Chrome with the NEXUS Bridge extension loaded.`));
    browserBridge.stop();
    process.exit(1);
  }

  // Build the stack
  const agents  = new AgentManager();
  const memory  = new MemoryManager(50);
  const executor = new ToolExecutor(agents, memory);

  const run = (tool: string, args: Record<string, unknown> = {}) => executor.execute(tool, args);

  console.log('');
  console.log(chalk.bold(`${PAD}Running executor-level browser tool tests`));
  console.log(DIM(`${PAD}${'─'.repeat(38)}`));
  console.log('');

  // ── 1. browser_get_info ──────────────────────────────────────────────────────
  await test('browser_get_info — active tab URL', async () => {
    const r = await run('browser_get_info');
    assertNoError(r);
    assertContains(r, '"url"');
    const parsed = JSON.parse(r);
    assert(typeof parsed.url === 'string' && parsed.url.length > 0, 'No URL in result');
    process.stdout.write(DIM(` (${parsed.url.slice(0, 50)})`));
  });

  // ── 2. browser_get_tabs ──────────────────────────────────────────────────────
  await test('browser_get_tabs — list tabs', async () => {
    const r = await run('browser_get_tabs');
    assertNoError(r);
    const tabs = JSON.parse(r);
    assert(Array.isArray(tabs) && tabs.length > 0, 'No tabs returned');
    process.stdout.write(DIM(` (${tabs.length} tab${tabs.length !== 1 ? 's' : ''})`));
  });

  // ── 3. browser_navigate ──────────────────────────────────────────────────────
  await test('browser_navigate — example.com', async () => {
    const r = await run('browser_navigate', { url: 'https://example.com' });
    assertNoError(r);
    const data = JSON.parse(r);
    assert(data.url?.includes('example.com'), `Wrong URL: ${data.url}`);
  });

  // ── 4. browser_extract (full page) ───────────────────────────────────────────
  await test('browser_extract — full page', async () => {
    const r = await run('browser_extract');
    assertNoError(r);
    const data = JSON.parse(r);
    assert(typeof data.title === 'string' && data.title.length > 0, 'No title');
    assert(typeof data.text  === 'string' && data.text.length > 10,  'No text');
    process.stdout.write(DIM(` ("${data.title}")`));
  });

  // ── 5. browser_extract (selector) ────────────────────────────────────────────
  await test('browser_extract — h1 selector', async () => {
    const r = await run('browser_extract', { selector: 'h1' });
    assertNoError(r);
    assert(r.length > 0 && !r.startsWith('{'), 'Expected plain text from h1');
    process.stdout.write(DIM(` ("${r.trim().slice(0, 40)}")`));
  });

  // ── 6. browser_evaluate ──────────────────────────────────────────────────────
  await test('browser_evaluate — JS in page', async () => {
    const r = await run('browser_evaluate', { code: 'return document.title' });
    assertNoError(r);
    const data = JSON.parse(r);
    assert(typeof data.result === 'string' && data.result.length > 0, 'No result from evaluate');
    process.stdout.write(DIM(` ("${data.result}")`));
  });

  // ── 7. browser_screenshot ────────────────────────────────────────────────────
  await test('browser_screenshot — capture PNG', async () => {
    const r = await run('browser_screenshot');
    assertNoError(r);
    // base64 PNG is large — parse carefully
    assert(r.includes('"base64"') && r.includes('"mimeType"'), 'Missing base64 or mimeType in response');
    const data = JSON.parse(r);
    assert(typeof data.base64 === 'string' && data.base64.length > 1000, 'Screenshot too small');
    process.stdout.write(DIM(` (${Math.round(data.base64.length / 1024)} KB)`));
  });

  // ── 8. browser_scroll ────────────────────────────────────────────────────────
  await test('browser_scroll — scroll 300px', async () => {
    const r = await run('browser_scroll', { y: 300 });
    assertNoError(r);
  });

  // ── 9. browser_navigate → github ─────────────────────────────────────────────
  await test('browser_navigate — github.com', async () => {
    const r = await run('browser_navigate', { url: 'https://github.com' });
    assertNoError(r);
    const data = JSON.parse(r);
    assert(data.url?.includes('github'), `Wrong URL: ${data.url}`);
  });

  // ── 10. browser_extract links ────────────────────────────────────────────────
  await test('browser_extract — links on github.com', async () => {
    const r = await run('browser_extract');
    assertNoError(r);
    // Full-page extract is large JSON — check it parsed correctly
    assert(r.includes('"links"') && r.includes('"title"'), 'Missing links or title in extract');
    const data = JSON.parse(r);
    assert(Array.isArray(data.links) && data.links.length > 0, 'No links found');
    process.stdout.write(DIM(` (${data.links.length} links)`));
  });

  // ── 11. browser_new_tab ──────────────────────────────────────────────────────
  await test('browser_new_tab — open anthropic.com', async () => {
    const r = await run('browser_new_tab', { url: 'https://www.anthropic.com' });
    assertNoError(r);
    const data = JSON.parse(r);
    assert(typeof data.id === 'number', 'No tab ID');
    process.stdout.write(DIM(` (tab ${data.id})`));
  });

  // ── 12. browser_get_info (new tab) ───────────────────────────────────────────
  await test('browser_get_info — now on anthropic.com', async () => {
    const r = await run('browser_get_info');
    assertNoError(r);
    const data = JSON.parse(r);
    assert(data.url?.includes('anthropic'), `Expected anthropic, got: ${data.url}`);
  });

  // ── 13. browser_navigate → duckduckgo ────────────────────────────────────────
  await test('browser_navigate — duckduckgo.com', async () => {
    const r = await run('browser_navigate', { url: 'https://duckduckgo.com' });
    assertNoError(r);
  });

  // ── 14. browser_wait_for ─────────────────────────────────────────────────────
  await test('browser_wait_for — search input', async () => {
    const r = await run('browser_wait_for', {
      selector: 'input[name="q"], #searchbox_input',
      timeout: 8000,
    });
    assertNoError(r);
    const data = JSON.parse(r);
    assert(data.found === true, 'Search input not found');
  });

  // ── 15. browser_type ─────────────────────────────────────────────────────────
  await test('browser_type — type in search box', async () => {
    await run('browser_click', { selector: 'input[name="q"], #searchbox_input' });
    const r = await run('browser_type', { text: 'NEXUS AI agent macOS' });
    assertNoError(r);
    const data = JSON.parse(r);
    assert(data.typed === 'NEXUS AI agent macOS', `Wrong typed value: ${data.typed}`);
  });

  // ── 16. browser_extract — verify typed value ─────────────────────────────────
  await test('browser_extract — confirm search value', async () => {
    const r = await run('browser_extract', {
      selector: 'input[name="q"], #searchbox_input',
      attribute: 'value',
    });
    assertNoError(r);
    assert(r.includes('NEXUS'), `Input value wrong: ${r}`);
    process.stdout.write(DIM(` ("${r.trim().slice(0, 40)}")`));
  });

  // ── 17. browser_close_tab ────────────────────────────────────────────────────
  await test('browser_close_tab — close active', async () => {
    const r = await run('browser_close_tab');
    assertNoError(r);
    const data = JSON.parse(r);
    assert(typeof data.closed === 'number', 'No closed tab ID');
  });

  // ── 18. browser_reload ───────────────────────────────────────────────────────
  await test('browser_reload — reload active tab', async () => {
    const r = await run('browser_reload');
    assertNoError(r);
    const data = JSON.parse(r);
    assert(typeof data.url === 'string', 'No URL after reload');
  });

  // ── 19. browser_back ─────────────────────────────────────────────────────────
  await test('browser_back — go back in history', async () => {
    const r = await run('browser_back');
    assertNoError(r);
  });

  // ── 20. browser_fill_form — JSON string fields ───────────────────────────────
  await test('browser_fill_form — JSON string input', async () => {
    await run('browser_navigate', { url: 'https://duckduckgo.com' });
    await run('browser_wait_for', { selector: 'input[name="q"], #searchbox_input', timeout: 5000 });
    const fields = JSON.stringify([{ selector: 'input[name="q"], #searchbox_input', value: 'NEXUS fill_form test' }]);
    const r = await run('browser_fill_form', { fields });
    assertNoError(r);
    const data = JSON.parse(r);
    assert(data.filled >= 1, `Expected >=1 filled, got ${data.filled}`);
    process.stdout.write(DIM(` (${data.filled} field filled)`));
  });

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log('');
  console.log(DIM(`${PAD}${'─'.repeat(50)}`));
  console.log('');

  const total = passed + failed;
  if (failed === 0) {
    console.log(`${PAD}${EMERALD('◆')} ${chalk.bold('All tests passed')}  ${DIM(`${passed}/${total}`)}`);
    console.log(`${PAD}${DIM('Full stack verified: ToolExecutor → BrowserAgent → BrowserBridge → Chrome')}`);
  } else {
    console.log(`${PAD}${AMBER('◆')} ${chalk.bold(`${passed}/${total} passed`)}  ${ROSE(`${failed} failed`)}`);
  }

  console.log('');

  browserBridge.stop();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(ROSE(`\n${PAD}Fatal: ${err.message}`));
  browserBridge.stop();
  process.exit(1);
});
