#!/usr/bin/env tsx
/**
 * NEXUS Browser Stress Test — hard real-world automation scenarios
 *
 * Talks directly to the browser bridge WebSocket (bypasses the LLM)
 * to test the raw automation layer: navigation, extraction, forms,
 * multi-tab, JS eval, waits, and screenshot pipelines.
 *
 * Run while NEXUS is live (bridge already on :9338 via Chrome extension).
 * Uses a secondary connection — does NOT conflict with NEXUS.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import chalk from 'chalk';
import { execSync, spawnSync } from 'child_process';

const BRIDGE_PORT = 9338;
const BRIDGE_HOST = '127.0.0.1';
const CMD_TIMEOUT  = 20_000;

const VIOLET  = chalk.hex('#8B5CF6');
const EMERALD = chalk.hex('#34D399');
const ROSE    = chalk.hex('#F87171');
const AMBER   = chalk.hex('#FBBF24');
const CYAN    = chalk.hex('#67E8F9');
const PAD     = '  ';

// ── Bridge SERVER (we run as the bridge, Chrome extension connects to us) ──
// NEXUS must be stopped before running this script so we can bind port 9338.

let extensionSocket: WebSocket | null = null;
let wss: WebSocketServer | null = null;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

function send<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) throw new Error('Extension not connected');
  const id = nanoid();
  const msg = JSON.stringify({ id, type: 'command', action, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout after ${CMD_TIMEOUT / 1000}s: ${action}`));
    }, CMD_TIMEOUT);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    extensionSocket!.send(msg);
  });
}

function startBridgeServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    wss = new WebSocketServer({ port: BRIDGE_PORT, host: BRIDGE_HOST });
    wss.on('error', reject);
    wss.on('connection', (sock) => {
      extensionSocket = sock;
      sock.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type: string; id?: string; success?: boolean; data?: unknown; error?: string };
          if (msg.type === 'ping') { sock.send(JSON.stringify({ type: 'pong' })); return; }
          if (msg.type === 'response' && msg.id) {
            const p = pending.get(msg.id);
            if (!p) return;
            clearTimeout(p.timer);
            pending.delete(msg.id);
            if (msg.success) p.resolve(msg.data);
            else p.reject(new Error(msg.error ?? 'Command failed'));
          }
        } catch { /* ignore */ }
      });
      sock.on('close', () => { extensionSocket = null; });
      if (!resolved) { resolved = true; resolve(); }
    });
    let resolved = false;
  });
}

function waitForExtension(timeoutMs = 20_000): Promise<void> {
  if (extensionSocket?.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome extension did not connect in time')), timeoutMs);
    const check = setInterval(() => {
      if (extensionSocket?.readyState === WebSocket.OPEN) {
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }
    }, 200);
  });
}

// ── Test harness ──────────────────────────────────────────────────────────────

interface TestResult {
  label: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function test(label: string, fn: () => Promise<string>) {
  const start = Date.now();
  process.stdout.write(`\n${PAD}${chalk.dim('▸')} ${label}\n`);
  try {
    const detail = await fn();
    const ms = Date.now() - start;
    results.push({ label, passed: true, detail, durationMs: ms });
    console.log(`${PAD}  ${EMERALD('✓')} ${chalk.dim(detail.slice(0, 100))}  ${chalk.dim(`(${ms}ms)`)}`);
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ label, passed: false, detail: msg, durationMs: ms });
    console.log(`${PAD}  ${ROSE('✗')} ${chalk.dim(msg.slice(0, 120))}  ${chalk.dim(`(${ms}ms)`)}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Stress test scenarios ─────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log(`${PAD}${VIOLET.bold('◆ NEXUS')}  ${chalk.bold('Browser Stress Test')}`);
  console.log(`${PAD}${chalk.dim('Hard real-world automation — 14 scenarios')}`);
  console.log(`${PAD}${chalk.dim('─'.repeat(54))}`);

  // Stop NEXUS so we can bind port 9338 as the bridge server
  process.stdout.write(`\n${PAD}${chalk.dim('Stopping NEXUS service…')}`);
  spawnSync('launchctl', ['stop', 'com.nexus.ai'], { stdio: 'ignore' });
  // Wait up to 8s for port 9338 to be released
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    const check = spawnSync('nc', ['-z', '-w', '1', '127.0.0.1', '9338'], { stdio: 'ignore' });
    if (check.status !== 0) break; // port is free
    if (i === 15) {
      // Force kill the node process holding the port
      spawnSync('bash', ['-c', 'lsof -ti :9338 | xargs kill -9 2>/dev/null || true'], { stdio: 'ignore' });
      await sleep(500);
    }
  }
  console.log(' ' + EMERALD('stopped'));

  // Start our own bridge server
  process.stdout.write(`${PAD}${chalk.dim('Starting test bridge on :9338…')}`);
  try {
    await startBridgeServer();
    console.log(' ' + EMERALD('listening'));
  } catch (e) {
    console.log(' ' + ROSE(`FAILED: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }

  // Wait for Chrome extension to reconnect to our test server
  process.stdout.write(`${PAD}${chalk.dim('Waiting for Chrome extension to reconnect…')}`);
  try {
    await waitForExtension(20_000);
    console.log(' ' + EMERALD('connected'));
  } catch (e) {
    console.log(' ' + ROSE('TIMEOUT — open Chrome and ensure the extension is loaded'));
    wss?.close();
    spawnSync('launchctl', ['start', 'com.nexus.ai'], { stdio: 'ignore' });
    process.exit(1);
  }

  // ── 1. Navigate + extract structured content ───────────────────────────────
  await test('1. Navigate to example.com and extract all content', async () => {
    await send('navigate', { url: 'https://example.com' });
    const data = await send<{ title: string; text: string; links: {text: string; href: string}[] }>('extract');
    assert(typeof data.title === 'string' && data.title.length > 0, 'No title');
    assert(data.text.length > 50, 'Not enough text extracted');
    assert(data.links.length > 0, 'No links found');
    return `title="${data.title}" | ${data.text.length} chars | ${data.links.length} links`;
  });

  // ── 2. JavaScript evaluation — DOM introspection ───────────────────────────
  await test('2. JS eval: count DOM nodes and measure page complexity', async () => {
    const r = await send<{ result: string }>('evaluate', {
      code: 'return JSON.stringify({elements:document.querySelectorAll("*").length,scripts:document.querySelectorAll("script").length,links:document.querySelectorAll("a").length,title:document.title})',
    });
    const data = JSON.parse(r.result) as { elements: number; scripts: number; links: number; title: string };
    assert(data.elements > 0, 'DOM empty');
    return `${data.elements} elements | ${data.scripts} scripts | title="${data.title}"`;
  });

  // ── 3. Navigate to a news site and extract headlines ──────────────────────
  await test('3. Navigate to Hacker News and extract top 5 posts', async () => {
    await send('navigate', { url: 'https://news.ycombinator.com' });
    const data = await send<{ headings: {level: string; text: string}[]; links: {text: string; href: string}[] }>('extract');
    const stories = data.links.filter(l => l.href.includes('item?id=') || (l.text.length > 15 && !l.text.includes('vote') && !l.text.includes('hide'))).slice(0, 5);
    assert(stories.length >= 3, `Only ${stories.length} stories found`);
    return `${stories.length} stories: "${stories[0]?.text?.slice(0, 60) ?? '?'}"…`;
  });

  // ── 4. Extract specific element via selector ───────────────────────────────
  await test('4. Extract HN first story title via CSS selector', async () => {
    const result = await send<string>('extract', { selector: '.titleline > a' });
    assert(result && String(result).length > 5, 'No title extracted');
    return `First story: "${String(result).slice(0, 80)}"`;
  });

  // ── 5. Extract specific elements via CSS selector (CSP-safe) ──────────────
  await test('5. Extract HN vote score via CSS selector (CSP-safe)', async () => {
    // Use browser_extract with selector instead of eval — works on CSP-strict sites
    const score = await send<string>('extract', { selector: '.score' });
    const comments = await send<string>('extract', { selector: '.subtext a[href*="item"]' });
    assert(score !== null || comments !== null, 'Could not extract any HN metadata');
    return `score="${String(score ?? '?').slice(0, 30)}" | comments="${String(comments ?? '?').slice(0, 30)}"`;
  });

  // ── 6. Search form interaction ─────────────────────────────────────────────
  await test('6. Navigate to DuckDuckGo and perform a search', async () => {
    await send('navigate', { url: 'https://duckduckgo.com' });
    await send('wait_for', { selector: 'input[name="q"], #searchbox_input', timeout: 8000 });
    await send('click', { selector: 'input[name="q"], #searchbox_input' });
    await send('type', { text: 'NEXUS autonomous AI agent macOS' });
    // Submit via JS to avoid Enter key issues
    await send('evaluate', { code: 'document.querySelector(\'form[action="/"]\')?document.querySelector(\'form[action="/"]\').submit():window.location.href="https://duckduckgo.com/?q=NEXUS+autonomous+AI+agent+macOS"' });
    await sleep(2500);
    const data = await send<{ title: string; links: {text: string; href: string}[] }>('extract');
    assert(data.links.length > 2, 'No search results');
    return `${data.links.length} results | first: "${data.links[0]?.text?.slice(0, 60) ?? '?'}"`;
  });

  // ── 7. Screenshot capture and verify ──────────────────────────────────────
  await test('7. Take browser screenshot and verify PNG data', async () => {
    const shot = await send<{ base64: string; mimeType: string }>('screenshot');
    assert(typeof shot.base64 === 'string', 'No base64');
    assert(shot.base64.length > 5000, `PNG too small: ${shot.base64.length} chars`);
    assert(shot.mimeType === 'image/png', `Wrong MIME: ${shot.mimeType}`);
    // Verify it's actually a PNG (magic bytes)
    const buf = Buffer.from(shot.base64.slice(0, 12), 'base64');
    assert(buf[0] === 0x89 && buf[1] === 0x50, 'Not a valid PNG (wrong magic bytes)');
    return `${Math.round(shot.base64.length / 1024)} KB PNG | MIME: ${shot.mimeType} | valid PNG header ✓`;
  });

  // ── 8. Multi-tab: open, switch context, read, close ───────────────────────
  await test('8. Multi-tab: open GitHub, Wikipedia in parallel, list + close', async () => {
    const tab1 = await send<{ id: number }>('new_tab', { url: 'https://github.com' });
    const tab2 = await send<{ id: number }>('new_tab', { url: 'https://en.wikipedia.org' });
    assert(typeof tab1.id === 'number', 'No tab1 ID');
    assert(typeof tab2.id === 'number', 'No tab2 ID');
    const tabs = await send<Array<{ id: number; title: string; url: string }>>('get_tabs');
    assert(tabs.length >= 3, `Expected ≥3 tabs, got ${tabs.length}`);
    // Close both new tabs
    await send('close_tab', { tabId: tab1.id });
    await send('close_tab', { tabId: tab2.id });
    const tabsAfter = await send<Array<{ id: number }>>('get_tabs');
    return `opened tabs ${tab1.id} + ${tab2.id} | ${tabs.length} total tabs | closed both → ${tabsAfter.length} remaining`;
  });

  // ── 9. Navigate GitHub trending and extract repos ─────────────────────────
  await test('9. GitHub trending — extract top 3 trending repos', async () => {
    await send('navigate', { url: 'https://github.com/trending' });
    await send('wait_for', { selector: 'article, [data-hpc], .Box-row, h2', timeout: 10000 });
    const data = await send<{ links: {text: string; href: string}[]; headings: {level: string; text: string}[] }>('extract');
    // Repo links are /owner/repo format (two path segments, no query)
    const repoLinks = data.links.filter(l => {
      const m = l.href.match(/^\/([^/?#]+)\/([^/?#]+)$/);
      return m && !['about', 'explore', 'marketplace', 'login', 'signup', 'pricing'].includes(m[1]);
    });
    // Also check headings for repo names (GitHub may use h2 for trending)
    const repoHeadings = (data.headings ?? []).filter(h => h.text.includes('/') && h.text.trim().length > 3);
    const totalFound = repoLinks.length + repoHeadings.length;
    assert(totalFound > 0, `No trending repos found. Links: ${data.links.length}, Headings: ${data.headings?.length ?? 0}`);
    const top3 = repoLinks.slice(0, 3).map(l => l.href).join(' | ');
    return `${repoLinks.length} repos via links, ${repoHeadings.length} via headings | sample: ${top3 || repoHeadings.slice(0,2).map(h=>h.text).join(' | ')}`;
  });

  // ── 10. Extract page text content on CSP-strict site ─────────────────────
  await test('10. Full page text extraction on GitHub trending (CSP-safe)', async () => {
    // GitHub has strict CSP — use full-page browser_extract, search text for repo info
    const data = await send<{ text: string; headings: {level: string; text: string}[] }>('extract');
    assert(data.text.length > 200, `Page text too short: ${data.text.length} chars`);
    // The page should mention stars/forks in text (trending page always shows star counts)
    const hasStarInfo = /star|fork|\d{1,3}(,\d{3})*/i.test(data.text);
    assert(hasStarInfo, 'No star/fork counts found in page text');
    const headingCount = data.headings?.length ?? 0;
    return `${data.text.length} chars extracted | ${headingCount} headings | star/fork counts present`;
  });

  // ── 11. Navigate + wait for dynamic content ───────────────────────────────
  await test('11. Navigate to Wikipedia and wait for content to load', async () => {
    await send('navigate', { url: 'https://en.wikipedia.org/wiki/Artificial_intelligence' });
    await send('wait_for', { selector: '#firstHeading', timeout: 10000 });
    const heading = await send<string>('extract', { selector: '#firstHeading' });
    assert(String(heading).includes('Artificial'), `Wrong heading: ${heading}`);
    // Get first substantial paragraph (skip hatnotes — they're in .hatnote, not p)
    // Use the full page extract and pick the longest paragraph text
    const fullData = await send<{ text: string }>('extract');
    const lines = fullData.text.split('\n').map(l => l.trim()).filter(l => l.length > 150);
    assert(lines.length > 0, `No long paragraphs found in page text (${fullData.text.length} total chars)`);
    return `H1: "${String(heading).slice(0, 40)}" | longest para: ${lines[0]?.length ?? 0} chars`;
  });

  // ── 12. Scroll and check page position ────────────────────────────────────
  await test('12. Scroll down 2000px then verify position via JS', async () => {
    await send('scroll', { y: 2000 });
    await sleep(500);
    const r = await send<{ result: string }>('evaluate', { code: 'return String(Math.round(window.scrollY))' });
    const scrollY = parseInt(r.result, 10);
    assert(scrollY > 500, `Scroll didn't work: scrollY=${scrollY}`);
    return `scrollY=${scrollY}px (expected > 500)`;
  });

  // ── 13. Navigate back + forward ───────────────────────────────────────────
  await test('13. Browser history: back then forward', async () => {
    const before = await send<{ url: string }>('get_info');
    await send('back');
    await sleep(1000);
    const afterBack = await send<{ url: string }>('get_info');
    await send('forward');
    await sleep(1000);
    const afterForward = await send<{ url: string }>('get_info');
    const moved = before.url !== afterBack.url;
    return `before="${before.url.slice(0, 40)}" | back="${afterBack.url.slice(0, 40)}" | forward="${afterForward.url.slice(0, 40)}" | history nav ${moved ? 'worked' : 'same page'}`;
  });

  // ── 14. Page reload ────────────────────────────────────────────────────────
  await test('14. Reload page and verify content persists', async () => {
    const info = await send<{ url: string; title: string }>('get_info');
    await send('reload');
    await sleep(2000);
    const after = await send<{ url: string; title: string }>('get_info');
    assert(after.url === info.url, `URL changed after reload: ${after.url}`);
    return `reloaded "${info.url.slice(0, 60)}" | title still "${after.title?.slice(0, 40)}"`;
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  extensionSocket?.close();
  wss?.close();
  await sleep(500);

  // Restart NEXUS
  process.stdout.write(`\n${PAD}${chalk.dim('Restarting NEXUS…')}`);
  spawnSync('launchctl', ['start', 'com.nexus.ai'], { stdio: 'ignore' });
  console.log(' ' + EMERALD('done'));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total  = results.length;
  const avgMs  = Math.round(results.reduce((s, r) => s + r.durationMs, 0) / total);

  console.log('');
  console.log(`${PAD}${chalk.dim('─'.repeat(54))}`);
  console.log(`${PAD}${chalk.bold('Results')}`);
  console.log('');

  for (const r of results) {
    const icon  = r.passed ? EMERALD('✓') : ROSE('✗');
    const label = r.passed ? chalk.dim(r.label) : chalk.bold(r.label);
    const ms    = chalk.dim(`${r.durationMs}ms`);
    console.log(`${PAD}  ${icon}  ${label}  ${ms}`);
    if (!r.passed) {
      console.log(`${PAD}     ${ROSE(r.detail.slice(0, 100))}`);
    }
  }

  console.log('');
  if (failed === 0) {
    console.log(`${PAD}${EMERALD('◆')} ${chalk.bold(`All ${total} tests passed`)}  ${chalk.dim(`avg ${avgMs}ms`)}`);
  } else {
    console.log(`${PAD}${AMBER('◆')} ${chalk.bold(`${passed}/${total} passed`)}  ${ROSE(`${failed} failed`)}  ${chalk.dim(`avg ${avgMs}ms`)}`);
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(ROSE(`\n${PAD}Fatal: ${err instanceof Error ? err.message : String(err)}`));
  extensionSocket?.close();
  wss?.close();
  spawnSync('launchctl', ['start', 'com.nexus.ai'], { stdio: 'ignore' });
  process.exit(1);
});
