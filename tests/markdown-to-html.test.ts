import { describe, it, expect } from 'vitest';
import { markdownToHtml } from '../src/telegram/messages.js';

// markdownToHtml is the chat-mode reply formatter (mirror of
// cleanMarkdownForTelegram on the task-runner side). On 2026-05-06 it was
// extended to handle headings, horizontal rules, pipe tables, Markdown
// images, Markdown links, and blockquotes — all of which previously
// leaked through as literal text in the Telegram client.

describe('markdownToHtml', () => {
  // ── Existing behavior — keep covered so future edits don't regress ──

  it('escapes raw HTML special characters', () => {
    expect(markdownToHtml('a & <b> "c"')).toBe('a &amp; &lt;b&gt; &quot;c&quot;');
  });

  it('renders inline code as <code>', () => {
    expect(markdownToHtml('use `npm run build`')).toBe('use <code>npm run build</code>');
  });

  it('renders **bold** and __bold__ as <b>', () => {
    expect(markdownToHtml('**hi** and __there__')).toBe('<b>hi</b> and <b>there</b>');
  });

  it('renders *italic* and _italic_ as <i>', () => {
    expect(markdownToHtml('*hi* and _there_')).toBe('<i>hi</i> and <i>there</i>');
  });

  it('wraps fenced code blocks in <pre> with content escaped', () => {
    const out = markdownToHtml('```\nconst x = 1 < 2;\n```');
    expect(out).toBe('<pre>const x = 1 &lt; 2;</pre>');
  });

  it('does not process Markdown inside fenced code blocks', () => {
    const out = markdownToHtml('```\n**not bold** and `not code`\n```');
    expect(out).toContain('**not bold**');
    expect(out).not.toContain('<b>');
  });

  // ── 2026-05-06 additions: structural Markdown ──

  it('converts Markdown headings to <b> (no <h1> in Telegram HTML)', () => {
    expect(markdownToHtml('# Title')).toBe('<b>Title</b>');
    expect(markdownToHtml('### Sub')).toBe('<b>Sub</b>');
  });

  it('drops horizontal rules', () => {
    expect(markdownToHtml('above\n---\nbelow')).toBe('above\n\nbelow');
    expect(markdownToHtml('above\n***\nbelow')).toBe('above\n\nbelow');
  });

  it('flattens pipe tables into space-separated rows', () => {
    const out = markdownToHtml('| Path | Status |\n|------|--------|\n| a.txt | ok |');
    expect(out).toContain('Path');
    expect(out).toContain('Status');
    expect(out).toContain('a.txt');
    expect(out).toContain('ok');
    expect(out).not.toMatch(/\|/);
  });

  it('strips Markdown images down to alt text', () => {
    expect(markdownToHtml('![chart](https://i.imgur.com/x.png)')).toBe('chart');
    expect(markdownToHtml('![](u)')).toBe('');
  });

  it('converts Markdown links to <a href> for click-targets', () => {
    expect(markdownToHtml('see [the docs](https://example.com)')).toBe(
      'see <a href="https://example.com">the docs</a>',
    );
  });

  it('handles image-then-link without leaking `!`', () => {
    const out = markdownToHtml('![logo](a.png) [Link](https://b.com)');
    expect(out).toBe('logo <a href="https://b.com">Link</a>');
    expect(out).not.toContain('!');
  });

  it('strips blockquote markers (after escapeHtml turns > into &gt;)', () => {
    expect(markdownToHtml('> a quote\n> continued')).toBe('a quote\ncontinued');
  });

  it('preserves combinations: heading + bold + link', () => {
    const out = markdownToHtml('## **Notes** see [here](https://e.com)');
    expect(out).toBe('<b><b>Notes</b> see <a href="https://e.com">here</a></b>');
  });
});
