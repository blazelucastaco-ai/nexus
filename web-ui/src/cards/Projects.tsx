import { motion } from 'framer-motion';

function rel(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function Projects({ payload }: { payload: Record<string, unknown> }) {
  const arr = Array.isArray(payload.projects) ? payload.projects : [];
  if (!arr.length) return <div className="md">No tracked projects yet.</div>;
  return (
    <div>
      {arr.map((p, i) => {
        const o = (p ?? {}) as Record<string, unknown>;
        const ok = o.lastTaskOk;
        const color = ok === 1 ? 'var(--ok)' : ok === 0 ? 'var(--bad)' : 'var(--text-faint)';
        const active = o.lastActive ? rel(String(o.lastActive)) : '';
        return (
          <motion.div
            key={i}
            className="proj"
            initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ delay: i * 0.06, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="proj-name">{String(o.name ?? '')}</div>
            <div className="proj-meta">
              <span>{Number(o.taskCount ?? 0)} tasks</span>
              {active ? <span>{active}</span> : null}
            </div>
            {o.lastTask ? (
              <div className="proj-last">
                <span className="proj-dot" style={{ background: color }} />
                {String(o.lastTask)}
              </div>
            ) : null}
          </motion.div>
        );
      })}
    </div>
  );
}
