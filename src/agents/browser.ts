import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { nowISO } from '../utils/helpers.js';
import { browserBridge } from '../browser/bridge.js';

const execFileAsync = promisify(execFile);

// ─── HTML Helpers (fallback path) ─────────────────────────────────────────────

function stripHtmlTags(html: string): string {
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : null;
}

function extractMetaDescription(html: string): string | null {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return match ? match[1].trim() : null;
}

// ─── BrowserAgent ──────────────────────────────────────────────────────────────

export class BrowserAgent extends BaseAgent {
  constructor() {
    super('browser', 'Controls Chrome browser via the NEXUS extension — navigate, click, type, extract, screenshot, and more', [
      // ── Extension-powered (rich automation) ──
      { name: 'navigate',     description: 'Navigate the active Chrome tab to a URL' },
      { name: 'click',        description: 'Click an element by CSS selector or visible text' },
      { name: 'type',         description: 'Type text into a field (selector required or active element)' },
      { name: 'clear',        description: 'Clear the value of an input field' },
      { name: 'select',       description: 'Select a dropdown option by value' },
      { name: 'extract',      description: 'Extract text, links, or element content from the current page' },
      { name: 'screenshot',   description: 'Capture the visible area of the active Chrome tab as a PNG' },
      { name: 'evaluate',     description: 'Execute JavaScript in the context of the active tab' },
      { name: 'scroll',       description: 'Scroll the page (or a specific element) by x/y pixels' },
      { name: 'wait_for',     description: 'Wait for a CSS selector to appear on the page' },
      { name: 'fill_form',    description: 'Fill multiple form fields at once given a selector→value map' },
      { name: 'get_info',     description: 'Get the URL, title, and tab ID of the active tab' },
      { name: 'get_tabs',     description: 'List all open Chrome tabs' },
      { name: 'switch_tab',   description: 'Switch focus to a tab by ID' },
      { name: 'new_tab',      description: 'Open a new Chrome tab, optionally navigating to a URL' },
      { name: 'close_tab',    description: 'Close a tab (defaults to active tab)' },
      { name: 'back',         description: 'Go back in browser history' },
      { name: 'forward',      description: 'Go forward in browser history' },
      { name: 'reload',       description: 'Reload the active tab' },
      // ── Fallback (no extension needed) ──
      { name: 'open_url',       description: 'Open a URL using macOS (any browser)' },
      { name: 'search_web',     description: 'Open a web search in the browser' },
      { name: 'extract_content', description: 'Fetch a URL via HTTP and extract its text (no JS)' },
    ]);
  }

  async execute(action: string, params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    this.log.info({ action, params, bridgeConnected: browserBridge.isConnected }, 'BrowserAgent executing');

    try {
      switch (action) {
        // ── Extension-powered actions ──────────────────────────────────────────
        case 'navigate':
          return await this.bridgeAction('navigate', params, start);
        case 'click':
          return await this.bridgeAction('click', params, start);
        case 'type':
          return await this.bridgeAction('type', params, start);
        case 'clear':
          return await this.bridgeAction('clear', params, start);
        case 'select':
          return await this.bridgeAction('select', params, start);
        case 'extract':
          return await this.bridgeAction('extract', params, start);
        case 'screenshot':
          return await this.bridgeAction('screenshot', params, start);
        case 'evaluate':
          return await this.bridgeAction('evaluate', params, start);
        case 'scroll':
          return await this.bridgeAction('scroll', params, start);
        case 'wait_for':
          return await this.bridgeAction('wait_for', params, start);
        case 'fill_form':
          return await this.bridgeAction('fill_form', params, start);
        case 'get_info':
          return await this.bridgeAction('get_info', params, start);
        case 'get_tabs':
          return await this.bridgeAction('get_tabs', params, start);
        case 'switch_tab':
          return await this.bridgeAction('switch_tab', params, start);
        case 'new_tab':
          return await this.bridgeAction('new_tab', params, start);
        case 'close_tab':
          return await this.bridgeAction('close_tab', params, start);
        case 'back':
          return await this.bridgeAction('back', params, start);
        case 'forward':
          return await this.bridgeAction('forward', params, start);
        case 'reload':
          return await this.bridgeAction('reload', params, start);

        // ── Fallback actions (always available) ───────────────────────────────
        case 'open_url':
          return await this.openUrl(params, start);
        case 'search_web':
          return await this.searchWeb(params, start);
        case 'extract_content':
          return await this.extractContent(params, start);

        default:
          return this.createResult(false, null, `Unknown action: ${action}`, start);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ action, error: msg }, 'BrowserAgent failed');
      return this.createResult(false, null, msg, start);
    }
  }

  // ── Bridge dispatcher ────────────────────────────────────────────────────────

  private async bridgeAction(
    action: string,
    params: Record<string, unknown>,
    start: number,
  ): Promise<AgentResult> {
    if (!browserBridge.isConnected) {
      return this.createResult(
        false,
        null,
        'Chrome extension not connected. Load the NEXUS Bridge extension in Chrome (chrome://extensions → Load unpacked → nexus/chrome-extension).',
        start,
      );
    }

    const data = await browserBridge.send(action as never, params);
    return this.createResult(true, data, undefined, start);
  }

  // ── Fallback: macOS open ──────────────────────────────────────────────────────

  private async openUrl(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const url = String(params.url);
    const browser = params.browser as string | undefined;
    const args: string[] = [];
    if (browser) args.push('-a', browser);
    args.push(url);

    await execFileAsync('open', args, { timeout: 5_000 });
    this.log.info({ url, browser }, 'URL opened via macOS');
    return this.createResult(true, { url, openedAt: nowISO(), browser: browser ?? 'default' }, undefined, start);
  }

  // ── Fallback: web search ──────────────────────────────────────────────────────

  private async searchWeb(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const query = String(params.query);
    const engine = String(params.engine ?? 'google');

    const urls: Record<string, string> = {
      google:     `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      duckduckgo: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      bing:       `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    };

    const searchUrl = urls[engine] ?? urls.google;
    await execFileAsync('open', [searchUrl], { timeout: 5_000 });
    this.log.info({ query, engine }, 'Web search opened');
    return this.createResult(true, { query, engine, url: searchUrl, openedAt: nowISO() }, undefined, start);
  }

  // ── Fallback: HTTP content extraction ────────────────────────────────────────

  private async extractContent(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const url = String(params.url);
    const maxLength = Number(params.maxLength ?? 50_000);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'NEXUS-AI/1.0 (macOS assistant)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response.ok) {
        return this.createResult(false, null, `HTTP ${response.status}: ${response.statusText}`, start);
      }

      const html = await response.text();
      const title = extractTitle(html);
      const description = extractMetaDescription(html);
      let textContent = stripHtmlTags(html);

      if (textContent.length > maxLength) {
        textContent = textContent.slice(0, maxLength) + '... [truncated]';
      }

      return this.createResult(
        true,
        { url, title, description, contentLength: textContent.length, content: textContent, fetchedAt: nowISO() },
        undefined,
        start,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
