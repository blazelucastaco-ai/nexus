import { describe, it, expect } from 'vitest';
import { extractUrls, buildUrlHint } from '../src/brain/url-hint.js';

describe('extractUrls', () => {
  it('returns [] for a message with no URL', () => {
    expect(extractUrls('just a normal message')).toEqual([]);
    expect(extractUrls('')).toEqual([]);
  });

  it('extracts a single plain URL', () => {
    expect(extractUrls('check out https://example.com please')).toEqual(['https://example.com']);
  });

  it('extracts URL with path, query, fragment', () => {
    const urls = extractUrls('read https://foo.com/blog/post?id=42#section here');
    expect(urls).toEqual(['https://foo.com/blog/post?id=42#section']);
  });

  it('strips trailing punctuation a human would write', () => {
    expect(extractUrls('see https://foo.com.')).toEqual(['https://foo.com']);
    expect(extractUrls('check https://foo.com,')).toEqual(['https://foo.com']);
    expect(extractUrls('(https://foo.com)')).toEqual(['https://foo.com']);
    expect(extractUrls('https://foo.com!')).toEqual(['https://foo.com']);
  });

  it('extracts multiple URLs up to max', () => {
    const text = 'compare https://a.com with https://b.com and https://c.com';
    expect(extractUrls(text, 3)).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
    expect(extractUrls(text, 2)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('accepts http and https', () => {
    expect(extractUrls('check http://legacy.com and https://modern.com')).toEqual([
      'http://legacy.com',
      'https://modern.com',
    ]);
  });

  it('does not match bare-host references without a scheme', () => {
    expect(extractUrls('I use example.com a lot')).toEqual([]);
    expect(extractUrls('see www.foo.com')).toEqual([]);
  });
});

describe('buildUrlHint', () => {
  it('returns null when no URL is present', () => {
    expect(buildUrlHint('what is your current status?')).toBeNull();
  });

  it('includes the URL, the four routing rules, and the singular verb', () => {
    const hint = buildUrlHint('check out https://hackernews.com for me');
    expect(hint).not.toBeNull();
    expect(hint).toContain('https://hackernews.com');
    expect(hint).toContain('browser_navigate');
    expect(hint).toContain('crawl_url');
    expect(hint).toContain('web_fetch');
    expect(hint).toContain('NEVER pass a URL to web_search');
    expect(hint).toContain('a URL');
  });

  it('uses plural verb for multiple URLs', () => {
    const hint = buildUrlHint('compare https://a.com and https://b.com');
    expect(hint).toContain('2 URLs');
    expect(hint).toContain('https://a.com');
    expect(hint).toContain('https://b.com');
  });
});
