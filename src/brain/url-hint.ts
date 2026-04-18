// URL-Hint — preprocessing signal that tells the LLM how to handle URLs in
// the current user message.
//
// Without this, the LLM frequently confuses the URL-touching tools:
//   - web_search is described as "search the web" but the LLM has been
//     observed passing raw URLs as the `query` arg when the user shares a link
//   - crawl_url and web_fetch both read URL content but have different
//     sweet spots
//   - browser_navigate drives the real Chrome tab; the LLM sometimes forgets
//     this is an option
//
// Rather than relying solely on the tool descriptions (which sit below the
// rest of the system prompt), we extract URLs from the user message here and
// inject an explicit routing reminder near the top of the prompt. This is
// belt-and-suspenders with the tool-description clarifications.

// ── Regex ──────────────────────────────────────────────────────────────────

// Captures http(s):// URLs. Liberal on the path characters to catch the usual
// set (including #fragments and ?query=strings), stops at whitespace or
// common trailing punctuation a human would write.
const URL_PATTERN = /https?:\/\/[^\s<>"']+?(?=[\s<>"']|[.,;:!?)]*(?:\s|$))/g;

/**
 * Extract the first few http(s) URLs from the user's message.
 * Returns an empty array if none found.
 */
export function extractUrls(text: string, max = 3): string[] {
  if (!text) return [];
  URL_PATTERN.lastIndex = 0;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(text)) !== null && out.length < max) {
    // Strip any punctuation a human would naturally write after a URL:
    // "check out https://foo.com, it's great" → strip the trailing comma.
    const cleaned = match[0].replace(/[.,;:!?)]+$/, '');
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/**
 * If the user message contains one or more URLs, return a short prompt
 * snippet telling the LLM how to route them. Returns null when the message
 * has no URLs (no hint needed).
 */
export function buildUrlHint(text: string): string | null {
  const urls = extractUrls(text);
  if (urls.length === 0) return null;

  const listed = urls.map((u) => `  - ${u}`).join('\n');
  const verb = urls.length === 1 ? 'URL' : 'URLs';
  return [
    `The user's message contains ${urls.length === 1 ? 'a URL' : urls.length + ' URLs'}:`,
    listed,
    '',
    `How to handle ${verb}:`,
    `  • If the user wants to VISIT or OPEN it → browser_navigate (drives Chrome).`,
    `  • If they want you to READ what's on it → crawl_url (article/blog/news/docs).`,
    `  • For plain-text files or API endpoints → web_fetch.`,
    `  • NEVER pass a URL to web_search as a query. web_search is for natural-language queries only.`,
  ].join('\n');
}
