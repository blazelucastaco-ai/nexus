// Media Understanding — Link crawler using cheerio
// Fetches a URL and extracts clean readable text content

import * as cheerio from 'cheerio';
import { createLogger } from '../utils/logger.js';

const log = createLogger('LinkCrawler');

export interface CrawlResult {
  url: string;
  title: string;
  mainContent: string;
  links: Array<{ text: string; href: string }>;
  wordCount: number;
  truncated: boolean;
}

const ELEMENTS_TO_REMOVE = [
  'script', 'style', 'nav', 'footer', 'header', 'aside',
  'advertisement', '.ad', '.ads', '.advertisement',
  '.nav', '.navigation', '.sidebar', '.cookie', '.popup',
  'noscript', 'iframe',
];

const MAX_CONTENT_CHARS = 12_000;

/**
 * Crawl a URL and extract main readable content using cheerio.
 */
export async function crawlUrl(url: string): Promise<CrawlResult> {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(15_000),
    redirect: 'follow',
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
  }

  const contentType = resp.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
    throw new Error(`Non-HTML content type: ${contentType}`);
  }

  const html = await resp.text();
  const $ = cheerio.load(html);

  // Extract title
  const title = $('title').text().trim() || $('h1').first().text().trim() || url;

  // Remove noise elements
  for (const sel of ELEMENTS_TO_REMOVE) {
    $(sel).remove();
  }

  // Extract main content — prefer semantic elements
  let mainContent = '';
  const contentSelectors = ['main', 'article', '[role="main"]', '.content', '#content', 'body'];
  for (const sel of contentSelectors) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 100) {
      mainContent = el.text();
      break;
    }
  }
  if (!mainContent) mainContent = $('body').text();

  // Clean whitespace
  mainContent = mainContent
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const truncated = mainContent.length > MAX_CONTENT_CHARS;
  if (truncated) mainContent = mainContent.slice(0, MAX_CONTENT_CHARS) + '\n[...truncated]';

  // Extract links
  const links: Array<{ text: string; href: string }> = [];
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    const text = $(el).text().trim();
    if (href && text && !href.startsWith('#') && links.length < 20) {
      const fullHref = href.startsWith('http') ? href : new URL(href, url).toString();
      links.push({ text: text.slice(0, 80), href: fullHref });
    }
  });

  const wordCount = mainContent.split(/\s+/).filter(Boolean).length;
  log.info({ url, wordCount, links: links.length, truncated }, 'URL crawled');

  return { url, title, mainContent, links, wordCount, truncated };
}
