import type { ReactNode } from 'react';

// Minimal, safe markdown → React (no innerHTML). Headings, bullet lists,
// `inline code`, **bold**, paragraphs. Anything else renders as text.
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) nodes.push(<code key={key++}>{tok.slice(1, -1)}</code>);
    else nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
    m = re.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderMarkdown(body: string): ReactNode[] {
  const out: ReactNode[] = [];
  let list: ReactNode[] | null = null;
  const flush = () => {
    if (list) {
      out.push(<ul key={`ul${out.length}`}>{list}</ul>);
      list = null;
    }
  };
  body.split(/\r?\n/).forEach((ln, i) => {
    const t = ln.trim();
    if (!t) { flush(); return; }
    if (/^###\s+/.test(t)) { flush(); out.push(<h3 key={i}>{inline(t.replace(/^###\s+/, ''))}</h3>); }
    else if (/^##\s+/.test(t)) { flush(); out.push(<h2 key={i}>{inline(t.replace(/^##\s+/, ''))}</h2>); }
    else if (/^#\s+/.test(t)) { flush(); out.push(<h1 key={i}>{inline(t.replace(/^#\s+/, ''))}</h1>); }
    else if (/^[-*]\s+/.test(t)) { if (!list) list = []; list.push(<li key={i}>{inline(t.replace(/^[-*]\s+/, ''))}</li>); }
    else { flush(); out.push(<p key={i}>{inline(t)}</p>); }
  });
  flush();
  return out;
}

export function Panel({ payload }: { payload: Record<string, unknown> }) {
  const body = String(payload.body ?? '');
  return <div className="md">{renderMarkdown(body)}</div>;
}
