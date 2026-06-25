import { motion } from 'framer-motion';

const EASE = [0.16, 1, 0.3, 1] as const;

interface StepItem { label: string; detail?: string; status?: string; order: number }

/** A process / flow — connector grows step→step, each with a status. */
export function Steps(
  { payload, revealUpTo = 999, highlight = -1 }:
  { payload: Record<string, unknown>; revealUpTo?: number; highlight?: number },
) {
  const raw = Array.isArray(payload.steps) ? payload.steps : [];
  const steps: StepItem[] = raw
    .map((s, i) => {
      const o = (s ?? {}) as Record<string, unknown>;
      return {
        label: String(o.label ?? ''),
        detail: o.detail ? String(o.detail) : undefined,
        status: o.status ? String(o.status) : undefined,
        order: Number.isFinite(Number(o.order)) ? Number(o.order) : i,
      };
    })
    .filter((s) => s.label)
    .slice(0, 12)
    .sort((a, b) => a.order - b.order)
    .map((s, i) => ({ ...s, order: i })); // contiguous narration rank — matches the Stage's index-based reveal
  if (!steps.length) return <div className="md">No steps.</div>;
  return (
    <div className="w-steps">
      {steps.map((s, i) => s.order <= revealUpTo && (
        <motion.div
          key={i}
          className={`w-step st-${s.status ?? 'todo'}${s.order === highlight ? ' w-active' : ''}`}
          initial={{ opacity: 0, x: -14 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.42, ease: EASE }}
        >
          <div className="w-step-dot">{i + 1}</div>
          <div className="w-step-body">
            <div className="w-step-label">{s.label}</div>
            {s.detail ? <div className="w-step-detail">{s.detail}</div> : null}
          </div>
        </motion.div>
      ))}
    </div>
  );
}

/** Defensive fallback for visual types without a bespoke renderer yet (list,
 *  comparison, timeline, stat_dashboard, code, custom). Renders the title's main
 *  array as a clean readable list (or code as a <pre>). All content is rendered
 *  AS TEXT — never HTML — so a hostile spec can't inject anything. */
export function Fallback({ payload }: { payload: Record<string, unknown> }) {
  const code = typeof payload.code === 'string' ? payload.code : '';
  if (code) return <pre className="w-code">{code.slice(0, 4000)}</pre>;

  const arrKey = ['items', 'events', 'stats', 'rows', 'steps', 'shapes'].find((k) => Array.isArray(payload[k]));
  const items = arrKey ? (payload[arrKey] as unknown[]) : [];
  if (!items.length && typeof payload.body === 'string') return <div className="md">{String(payload.body).slice(0, 1200)}</div>;

  return (
    <div className="w-list">
      {items.slice(0, 16).map((it, i) => {
        const o = (it ?? {}) as Record<string, unknown>;
        const label = String(o.label ?? o.at ?? o.name ?? (typeof it === 'string' ? it : JSON.stringify(it)));
        const detail = o.detail ?? o.value ?? o.at;
        return (
          <motion.div
            key={i}
            className="w-list-row"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: i * 0.05, ease: EASE }}
          >
            <span className="w-list-label">{label.slice(0, 80)}</span>
            {detail !== undefined ? <span className="w-list-detail">{String(detail).slice(0, 40)}</span> : null}
          </motion.div>
        );
      })}
    </div>
  );
}
