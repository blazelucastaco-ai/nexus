import { nanoid } from 'nanoid';

export function generateId(): string {
  return nanoid();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

/**
 * Safe JSON.parse — returns `fallback` on any parse error instead of throwing.
 * Use this everywhere DB rows or external data are parsed.
 */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Strip markdown code fences, LLM prose, and escape sequences from raw
 * file content so only clean code/text is written to disk.
 *
 * Handles:
 *   - content='```python\nimport...\n```'   → extracts inner code
 *   - content with literal \n escape sequences → decoded to real newlines
 *   - content starting with prose like "Here's the code:\n..." → strips prose
 */
export function extractCleanContent(raw: string): string {
  // Decode escape sequences only when content has no real newlines yet.
  // If real newlines are already present (triple-quote extraction, etc.),
  // the remaining \n sequences are intentional string literals — don't break them.
  let content = raw;
  if (!raw.includes('\n')) {
    content = raw
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"');
  }

  // Extract from markdown code fence block
  const fenceMatch = content.match(/```(?:\w*)\n?([\s\S]*?)```/);
  if (fenceMatch) {
    const inner = fenceMatch[1]!;
    return inner.endsWith('\n') ? inner : inner + '\n';
  }

  // Strip leading prose lines (sentences before actual code starts)
  // A prose line: starts with an uppercase word and doesn't look like code
  const lines = content.split('\n');
  const codePattern =
    /^(#!|#\s|import\s|from\s|\/\/|\/\*|\*\s*[/@]|def\s|class\s|function\s|async\s|const\s|let\s|var\s|export\s|<!|<\?|<[a-zA-Z]|package\s|require\s|use\s|\{|\[|@|<script|<style|\s+\S|\w+\s*[=:(])/;

  let firstCode = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (codePattern.test(line)) {
      firstCode = i;
      break;
    }
    // If line ends with ':' it's likely prose introducing code — keep looking
    if (/^[A-Z].*[^:]$/.test(line.trim())) {
      firstCode = i;
      break;
    }
  }

  if (firstCode > 0) {
    return lines.slice(firstCode).join('\n');
  }

  return content;
}
