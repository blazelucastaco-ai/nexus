// Enhanced Web Crawling — content extraction using cheerio
// Strips HTML noise and returns clean, readable text with structure.

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ContentExtractor');

export interface ExtractedContent {
  title: string;
  description: string;
  mainContent: string;
  links: Array<{ text: string; href: string }>;
  images: Array<{ alt: string; src: string }>;
  wordCount: number;
  truncated: boolean;
}

const REMOVE_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'object', 'embed',
  'nav', 'footer', 'header', 'aside', '.sidebar', '.navigation',
  '.ad', '.ads', '.advertisement', '.cookie-banner', '.popup',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '.social-share', '.comment-section', '#comments',
];

const CONTENT_SELECTORS = [
  'article', 'main', '[role="main"]', '.post-content', '.article-content',
  '.entry-content', '.content-body', '#content', '.content', 'section',
];

const MAX_CHARS = 15_000;

/**
 * Extract clean content from raw HTML using cheerio.
 */
export function extractContent(html: string, baseUrl = ''): ExtractedContent {
  const $ = cheerio.load(html);

  // Extract meta
  const title = $('title').text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text().trim() || '';

  const description =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') || '';

  // Remove noise
  for (const sel of REMOVE_SELECTORS) {
    $(sel).remove();
  }

  // Find main content
  let mainContent = '';
  for (const sel of CONTENT_SELECTORS) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 200) {
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

  const truncated = mainContent.length > MAX_CHARS;
  if (truncated) mainContent = mainContent.slice(0, MAX_CHARS) + '\n[...content truncated]';

  // Extract links
  const links: Array<{ text: string; href: string }> = [];
  $('a[href]').each(function(this: AnyNode) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const el = this;
    const href = $(el).attr('href') ?? '';
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (href && text && !href.startsWith('#') && !href.startsWith('javascript:') && links.length < 25) {
      let fullHref = href;
      if (baseUrl && !href.startsWith('http')) {
        try { fullHref = new URL(href, baseUrl).toString(); } catch { fullHref = href; }
      }
      links.push({ text: text.slice(0, 100), href: fullHref });
    }
  });

  // Extract images
  const images: Array<{ alt: string; src: string }> = [];
  $('img[src]').each(function(this: AnyNode) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const el = this;
    const src = $(el).attr('src') ?? '';
    const alt = $(el).attr('alt') ?? '';
    if (src && images.length < 10) {
      let fullSrc = src;
      if (baseUrl && !src.startsWith('http') && !src.startsWith('data:')) {
        try { fullSrc = new URL(src, baseUrl).toString(); } catch { fullSrc = src; }
      }
      images.push({ alt: alt.slice(0, 80), src: fullSrc });
    }
  });

  const wordCount = mainContent.split(/\s+/).filter(Boolean).length;
  log.debug({ titleLen: title.length, wordCount, links: links.length, truncated }, 'Content extracted');

  return { title, description, mainContent, links, images, wordCount, truncated };
}
