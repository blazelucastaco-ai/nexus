import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { nowISO } from '../utils/helpers.js';

const execFileAsync = promisify(execFile);

function stripHtml(html: string): string {
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

export class ResearchAgent extends BaseAgent {
  constructor() {
    super('research', 'Searches the web, summarizes URLs, and performs multi-query deep research', [
      { name: 'web_search', description: 'Open a web search for a given query' },
      { name: 'summarize_url', description: 'Fetch a URL and extract a text summary' },
      { name: 'deep_research', description: 'Perform deep research by combining multiple queries and sources' },
    ]);
  }

  async execute(action: string, params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    this.log.info({ action, params }, 'ResearchAgent executing');

    try {
      switch (action) {
        case 'web_search':
          return await this.webSearch(params, start);
        case 'summarize_url':
          return await this.summarizeUrl(params, start);
        case 'deep_research':
          return await this.deepResearch(params, start);
        default:
          return this.createResult(false, null, `Unknown action: ${action}`, start);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ action, error: msg }, 'ResearchAgent failed');
      return this.createResult(false, null, msg, start);
    }
  }

  private async webSearch(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const query = String(params.query);
    const engine = String(params.engine ?? 'google');

    const urls: Record<string, string> = {
      google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      duckduckgo: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    };

    const searchUrl = urls[engine] ?? urls.google;
    await execFileAsync('open', [searchUrl], { timeout: 5_000 });

    return this.createResult(
      true,
      { query, engine, url: searchUrl, openedAt: nowISO() },
      undefined,
      start,
    );
  }

  private async summarizeUrl(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const url = String(params.url);
    const maxLength = Number(params.maxLength ?? 10_000);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'NEXUS-AI/1.0 (Research agent)',
          Accept: 'text/html,application/xhtml+xml,*/*',
        },
      });

      if (!response.ok) {
        return this.createResult(false, null, `HTTP ${response.status}: ${response.statusText}`, start);
      }

      const html = await response.text();
      const title = extractTitle(html);
      let text = stripHtml(html);

      if (text.length > maxLength) {
        text = text.slice(0, maxLength) + '... [truncated]';
      }

      // Extract first meaningful paragraph as a quick summary
      const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 30);
      const quickSummary = sentences.slice(0, 5).join(' ');

      return this.createResult(
        true,
        {
          url,
          title,
          contentLength: text.length,
          quickSummary,
          fullText: text,
          fetchedAt: nowISO(),
        },
        undefined,
        start,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async deepResearch(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const topic = String(params.topic);
    const urls = (params.urls as string[]) ?? [];
    const queries = (params.queries as string[]) ?? [topic];

    // Open search for each query
    const searchUrls: string[] = [];
    for (const query of queries) {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      searchUrls.push(searchUrl);
      await execFileAsync('open', [searchUrl], { timeout: 5_000 }).catch(() => {});
    }

    // Fetch and summarize all provided URLs
    const summaries: Array<{ url: string; title: string | null; summary: string }> = [];

    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);

        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'NEXUS-AI/1.0', Accept: 'text/html,*/*' },
        });
        clearTimeout(timeout);

        if (response.ok) {
          const html = await response.text();
          const title = extractTitle(html);
          const text = stripHtml(html);
          const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 30);

          summaries.push({
            url,
            title,
            summary: sentences.slice(0, 8).join(' '),
          });
        }
      } catch {
        summaries.push({ url, title: null, summary: 'Failed to fetch' });
      }
    }

    return this.createResult(
      true,
      {
        topic,
        queriesSearched: queries,
        searchUrls,
        sourcesFetched: summaries.length,
        summaries,
        researchedAt: nowISO(),
        note: 'Search tabs opened in browser. Summaries extracted from provided URLs. Pass this data to AI for synthesis.',
      },
      undefined,
      start,
    );
  }
}
