// Media Understanding — Link crawler using cheerio
// Fetches a URL and extracts clean readable text content
//
// SSRF hardening: refuses http(s) requests to private / link-local / loopback
// / multicast / reserved IP ranges, and to the obvious IPv6 equivalents. This
// blocks the most common attacks where the LLM is steered to fetch
// 127.0.0.1:9338 (the browser bridge), 169.254.169.254 (cloud metadata), etc.
// Full DNS-rebinding defense would require binding to a fixed IP after
// resolution — this check is belt-and-suspenders, not a cryptographic mitigation.

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createLogger } from '../utils/logger.js';

const log = createLogger('LinkCrawler');

// IPv4 ranges that must never be reached by the LLM
const PRIVATE_IPV4_RULES: Array<(o: number[]) => boolean> = [
  (o) => o[0] === 127,                              // loopback
  (o) => o[0] === 10,                               // RFC1918 10/8
  (o) => o[0] === 172 && o[1] >= 16 && o[1] <= 31,  // RFC1918 172.16/12
  (o) => o[0] === 192 && o[1] === 168,              // RFC1918 192.168/16
  (o) => o[0] === 169 && o[1] === 254,              // link-local (metadata!)
  (o) => o[0] === 0,                                 // "this network"
  (o) => o[0] >= 224 && o[0] <= 239,                // multicast
  (o) => o[0] >= 240,                                // reserved
];

function ipv4Private(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  return PRIVATE_IPV4_RULES.some((rule) => rule(parts));
}

function ipv6Private(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1 loopback; fc00::/7 unique-local; fe80::/10 link-local; ff00::/8 multicast
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true;
  if (lower.startsWith('ff')) return true;
  // ::ffff:A.B.C.D (IPv4-mapped) — strip and check v4
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return ipv4Private(mapped[1]!);
  return false;
}

async function assertUrlIsPublic(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url.slice(0, 120)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refused to fetch non-http(s) URL: ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  // Literal IP check first
  const v = isIP(host);
  if (v === 4) {
    if (ipv4Private(host)) throw new Error(`Refused to fetch private/reserved IPv4 ${host}`);
    return;
  }
  if (v === 6) {
    // hostname may or may not have brackets; isIP returns 6 for bracketless form
    if (ipv6Private(host)) throw new Error(`Refused to fetch private/reserved IPv6 ${host}`);
    return;
  }
  // Quick hostname blocklist (before DNS)
  const hLower = host.toLowerCase();
  if (hLower === 'localhost' || hLower.endsWith('.localhost') ||
      hLower.endsWith('.local') || hLower.endsWith('.internal') ||
      hLower.endsWith('.lan') || hLower.endsWith('.home.arpa')) {
    throw new Error(`Refused to fetch internal hostname ${host}`);
  }
  // DNS resolve and re-check (best-effort — DNS rebinding can still slip past)
  try {
    const res = await lookup(host, { all: true });
    for (const { address, family } of res) {
      if (family === 4 && ipv4Private(address)) {
        throw new Error(`Refused — ${host} resolves to private IPv4 ${address}`);
      }
      if (family === 6 && ipv6Private(address)) {
        throw new Error(`Refused — ${host} resolves to private IPv6 ${address}`);
      }
    }
  } catch (err) {
    // If the error IS our "Refused", re-throw. Otherwise DNS failed; let fetch() handle it.
    if (err instanceof Error && err.message.startsWith('Refused')) throw err;
  }
}

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
  await assertUrlIsPublic(url);
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

  // Cap response size to prevent OOM on enormous HTML pages or misreported Content-Type
  const MAX_HTML_BYTES = 10 * 1024 * 1024; // 10 MB
  const contentLength = resp.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_HTML_BYTES) {
    throw new Error(`HTML response too large: ${contentLength} bytes (max ${MAX_HTML_BYTES})`);
  }

  const html = await resp.text();
  if (html.length > MAX_HTML_BYTES) {
    throw new Error(`HTML response too large: ${html.length} bytes (max ${MAX_HTML_BYTES})`);
  }
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
  $('a[href]').each(function(this: AnyNode) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const el = this;
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
