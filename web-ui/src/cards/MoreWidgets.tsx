import { motion } from 'framer-motion';

// Bespoke renderers for the structured visual types. Each takes the spec payload
// plus revealUpTo/highlight so it builds in as NEXUS narrates (pieces with an
// array index <= revealUpTo are shown; the highlighted one glows). All content is
// rendered AS TEXT — never HTML — so a hostile spec can't inject anything.

const EASE = [0.16, 1, 0.3, 1] as const;

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map((x) => (x ?? {}) as Record<string, unknown>) : [];
}

/** stat_dashboard — a few key stats as tiles with optional delta/trend. */
export function Stats(
  { payload, revealUpTo = 999, highlight = -1 }:
  { payload: Record<string, unknown>; revealUpTo?: number; highlight?: number },
) {
  const stats = asArray(payload.stats).slice(0, 8);
  if (!stats.length) return <div className="md">No stats.</div>;
  return (
    <div className="w-stats">
      {stats.map((s, i) => i <= revealUpTo && (
        <motion.div
          key={i}
          className={`w-stat trend-${String(s.trend ?? 'flat')}${i === highlight ? ' w-active' : ''}`}
          initial={{ opacity: 0, y: 12, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.45, ease: EASE }}
        >
          <div className="w-stat-value">{String(s.value ?? '—')}</div>
          <div className="w-stat-label">{String(s.label ?? '')}</div>
          {s.delta !== undefined ? <div className="w-stat-delta">{String(s.delta)}</div> : null}
        </motion.div>
      ))}
    </div>
  );
}

/** comparison — columns + rows; boolean cells render as ✓ / ✗. */
export function Comparison(
  { payload, revealUpTo = 999 }: { payload: Record<string, unknown>; revealUpTo?: number },
) {
  const columns = (Array.isArray(payload.columns) ? payload.columns : []).map((c) => String(c)).slice(0, 5);
  const rows = asArray(payload.rows).slice(0, 12);
  if (!columns.length || !rows.length) return <div className="md">No comparison data.</div>;
  const cell = (c: unknown) => (c === true ? '✓' : c === false ? '✗' : String(c ?? ''));
  return (
    <div className="w-cmp">
      <div className="w-cmp-row w-cmp-head">
        <span className="w-cmp-rowlabel" />
        {columns.map((c, i) => <span key={i} className="w-cmp-col">{c}</span>)}
      </div>
      {rows.map((r, i) => i <= revealUpTo && (
        <motion.div
          key={i}
          className="w-cmp-row"
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
        >
          <span className="w-cmp-rowlabel">{String(r.label ?? '')}</span>
          {(Array.isArray(r.cells) ? r.cells : []).slice(0, columns.length).map((c, j) => (
            <span key={j} className={`w-cmp-cell${c === true ? ' yes' : c === false ? ' no' : ''}`}>{cell(c)}</span>
          ))}
        </motion.div>
      ))}
    </div>
  );
}

/** timeline — events along a vertical spine. */
export function Timeline(
  { payload, revealUpTo = 999, highlight = -1 }:
  { payload: Record<string, unknown>; revealUpTo?: number; highlight?: number },
) {
  const events = asArray(payload.events).slice(0, 12);
  if (!events.length) return <div className="md">No timeline events.</div>;
  return (
    <div className="w-timeline">
      {events.map((e, i) => i <= revealUpTo && (
        <motion.div
          key={i}
          className={`w-tl-event${i === highlight ? ' w-active' : ''}`}
          initial={{ opacity: 0, x: -14 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.42, ease: EASE }}
        >
          <div className="w-tl-dot" />
          <div className="w-tl-body">
            <div className="w-tl-at">{String(e.at ?? '')}</div>
            <div className="w-tl-label">{String(e.label ?? '')}</div>
            {e.detail ? <div className="w-tl-detail">{String(e.detail)}</div> : null}
          </div>
        </motion.div>
      ))}
    </div>
  );
}

/** list — items, optionally numbered. */
export function ListView(
  { payload, revealUpTo = 999 }: { payload: Record<string, unknown>; revealUpTo?: number },
) {
  const items = asArray(payload.items).slice(0, 16);
  const ordered = payload.ordered === true;
  if (!items.length) return <div className="md">No items.</div>;
  return (
    <div className="w-listv">
      {items.map((it, i) => i <= revealUpTo && (
        <motion.div
          key={i}
          className="w-listv-row"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: EASE }}
        >
          <span className="w-listv-mark">{ordered ? `${i + 1}` : (it.icon ? String(it.icon).slice(0, 2) : '•')}</span>
          <span className="w-listv-body">
            <span className="w-listv-label">{String(it.label ?? '')}</span>
            {it.detail ? <span className="w-listv-detail">{String(it.detail)}</span> : null}
          </span>
        </motion.div>
      ))}
    </div>
  );
}

/** code — a monospace block, lines revealing top→down. */
export function Code({ payload }: { payload: Record<string, unknown> }) {
  const code = String(payload.code ?? '').slice(0, 4000);
  const language = payload.language ? String(payload.language) : '';
  if (!code.trim()) return <div className="md">No code.</div>;
  return (
    <div className="w-codewrap">
      {language ? <div className="w-code-lang">{language}</div> : null}
      <pre className="w-code">{code}</pre>
    </div>
  );
}
