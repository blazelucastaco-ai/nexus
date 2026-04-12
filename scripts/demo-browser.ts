#!/usr/bin/env tsx
/**
 * NEXUS Browser Demo — slow, visible automation you can watch in Chrome
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
const PAD     = '  ';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function step(label: string, fn: () => Promise<string | void>) {
  process.stdout.write(`\n${PAD}${VIOLET('▸')} ${chalk.bold(label)}\n`);
  try {
    const result = await fn();
    if (result) {
      const lines = result.split('\n').slice(0, 6);
      for (const line of lines) {
        console.log(`${PAD}  ${chalk.dim(line.slice(0, 90))}`);
      }
    }
    console.log(`${PAD}  ${EMERALD('✓ done')}`);
  } catch (err) {
    console.log(`${PAD}  ${ROSE('✗')} ${err instanceof Error ? err.message : String(err)}`);
  }
  await sleep(1800);
}

async function main() {
  console.log('');
  console.log(`${PAD}${VIOLET.bold('◆ NEXUS')}  ${chalk.bold('Browser Control Demo')}`);
  console.log(`${PAD}${chalk.dim('Watch Chrome — NEXUS is driving it in real time')}`);
  console.log(`${PAD}${chalk.dim('─'.repeat(50))}`);

  browserBridge.start();

  process.stdout.write(`\n${PAD}${chalk.dim('Waiting for Chrome extension…')}`);
  await new Promise<void>((resolve, reject) => {
    if (browserBridge.isConnected) { resolve(); return; }
    const t = setTimeout(() => reject(new Error('Extension not connected')), 15_000);
    browserBridge.onConnect(() => { clearTimeout(t); resolve(); });
  });
  console.log(' ' + EMERALD('connected\n'));

  const agents   = new AgentManager();
  const memory   = new MemoryManager(50);
  const executor = new ToolExecutor(agents, memory);
  const run      = (tool: string, args: Record<string, unknown> = {}) => executor.execute(tool, args);

  // ── 1. What tab are we on? ──────────────────────────────────────────────────
  await step('Check active tab', async () => {
    const r = JSON.parse(await run('browser_get_info'));
    return `URL:   ${r.url}\nTitle: ${r.title}`;
  });

  // ── 2. Navigate to example.com ──────────────────────────────────────────────
  await step('Navigate → example.com', async () => {
    const r = JSON.parse(await run('browser_navigate', { url: 'https://example.com' }));
    return `Landed on: ${r.url}`;
  });

  // ── 3. Extract page content ─────────────────────────────────────────────────
  await step('Extract page content (title, text, links)', async () => {
    const r = JSON.parse(await run('browser_extract'));
    return `Title:    ${r.title}\nText:     ${r.text.slice(0, 120)}…\nLinks:    ${r.links.length} found`;
  });

  // ── 4. Run JavaScript in the page ──────────────────────────────────────────
  await step('Evaluate JS → count elements on page', async () => {
    const r = JSON.parse(await run('browser_evaluate', {
      code: 'return `${document.querySelectorAll("*").length} elements, ${document.querySelectorAll("a").length} links, title="${document.title}"`',
    }));
    return r.result;
  });

  // ── 5. Screenshot ───────────────────────────────────────────────────────────
  await step('Take a screenshot', async () => {
    const r = JSON.parse(await run('browser_screenshot'));
    return `Captured ${Math.round(r.base64.length / 1024)} KB PNG (${r.mimeType})`;
  });

  // ── 6. Navigate to GitHub ───────────────────────────────────────────────────
  await step('Navigate → github.com', async () => {
    const r = JSON.parse(await run('browser_navigate', { url: 'https://github.com' }));
    return `Landed on: ${r.url}`;
  });

  // ── 7. Extract GitHub headings ──────────────────────────────────────────────
  await step('Extract headings from GitHub', async () => {
    const r = JSON.parse(await run('browser_extract'));
    const headings = r.headings?.slice(0, 4).map((h: {level: string; text: string}) => `[${h.level}] ${h.text}`).join('\n');
    return headings || 'No headings found';
  });

  // ── 8. Open new tab → DuckDuckGo ───────────────────────────────────────────
  await step('Open new tab → duckduckgo.com', async () => {
    const r = JSON.parse(await run('browser_new_tab', { url: 'https://duckduckgo.com' }));
    return `New tab ID: ${r.id}`;
  });

  // ── 9. Wait for search box ──────────────────────────────────────────────────
  await step('Wait for search input to appear', async () => {
    const r = JSON.parse(await run('browser_wait_for', {
      selector: 'input[name="q"], #searchbox_input',
      timeout: 8000,
    }));
    return `Found: ${r.selector ?? 'search input'}`;
  });

  // ── 10. Click the search box ────────────────────────────────────────────────
  await step('Click the search box', async () => {
    await run('browser_click', { selector: 'input[name="q"], #searchbox_input' });
    return 'Clicked';
  });

  // ── 11. Type a search query ─────────────────────────────────────────────────
  await step('Type search query: "NEXUS AI agent macOS"', async () => {
    const r = JSON.parse(await run('browser_type', { text: 'NEXUS AI agent macOS' }));
    return `Typed: "${r.typed}"`;
  });

  await sleep(1200);

  // ── 12. Scroll the page ─────────────────────────────────────────────────────
  await step('Scroll down 400px', async () => {
    await run('browser_scroll', { y: 400 });
    return 'Scrolled';
  });

  // ── 13. List all open tabs ──────────────────────────────────────────────────
  await step('List all open tabs', async () => {
    const tabs = JSON.parse(await run('browser_get_tabs'));
    return tabs.map((t: {id: number; title: string; url: string}) =>
      `[${t.id}] ${t.title?.slice(0, 50) ?? '(no title)'}`
    ).join('\n');
  });

  // ── 14. Go back in history ──────────────────────────────────────────────────
  await step('Go back in history', async () => {
    await run('browser_back');
    await sleep(800);
    const r = JSON.parse(await run('browser_get_info'));
    return `Now on: ${r.url}`;
  });

  // ── 15. Close the extra tab ─────────────────────────────────────────────────
  await step('Close this tab', async () => {
    const r = JSON.parse(await run('browser_close_tab'));
    return `Closed tab ${r.closed}`;
  });

  // ── Done ────────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`${PAD}${chalk.dim('─'.repeat(50))}`);
  console.log(`${PAD}${EMERALD('◆')} ${chalk.bold('Demo complete')}  ${chalk.dim('All browser_* tools exercised')}`);
  console.log('');

  browserBridge.stop();
  process.exit(0);
}

main().catch(err => {
  console.error(ROSE(`\nFatal: ${err.message}`));
  browserBridge.stop();
  process.exit(1);
});
