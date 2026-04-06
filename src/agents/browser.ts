import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { nowISO } from '../utils/helpers.js';

const execFileAsync = promisify(execFile);

function stripHtmlTags(html: string): string {
  // Remove script and style blocks entirely
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  // Collapse whitespace
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

export class BrowserAgent extends BaseAgent {
  constructor() {
    super('browser', 'Opens URLs, searches the web, and extracts content from web pages', [
      { name: 'open_url', description: 'Open a URL in the default browser' },
      { name: 'search_web', description: 'Search the web using a query' },
      { name: 'extract_content', description: 'Fetch a URL and extract its text content' },
    ]);
  }

  async execute(action: string, params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    this.log.info({ action, params }, 'BrowserAgent executing');

    try {
      switch (action) {
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

  private async openUrl(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const url = String(params.url);
    const browser = params.browser as string | undefined;

    const args: string[] = [];
    if (browser) {
      args.push('-a', browser);
    }
    args.push(url);

    await execFileAsync('open', args, { timeout: 5_000 });

    this.log.info({ url, browser }, 'URL opened');
    return this.createResult(true, { url, openedAt: nowISO(), browser: browser ?? 'default' }, undefined, start);
  }

  private async searchWeb(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const query = String(params.query);
    const engine = String(params.engine ?? 'google');

    const engineUrls: Record<string, string> = {
      google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      duckduckgo: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    };

    const searchUrl = engineUrls[engine] ?? engineUrls.google;

    await execFileAsync('open', [searchUrl], { timeout: 5_000 });

    this.log.info({ query, engine, searchUrl }, 'Web search opened');
    return this.createResult(
      true,
      { query, engine, url: searchUrl, openedAt: nowISO() },
      undefined,
      start,
    );
  }

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
        {
          url,
          title,
          description,
          contentLength: textContent.length,
          content: textContent,
          fetchedAt: nowISO(),
        },
        undefined,
        start,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
