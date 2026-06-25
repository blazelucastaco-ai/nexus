import { motion } from 'framer-motion';

// The custom escape hatch: a SAFE freeform "shapes" renderer. The model lays out
// typed shapes on a 100x100 normalized canvas and we draw them to SVG OURSELVES
// (labels as <text>, never HTML/foreignObject), so there is zero script-execution
// or injection surface even with a hostile spec. The executor sanitizes server-side
// too (defense in depth); this clamps + allowlists again on the client.

const EASE = [0.16, 1, 0.3, 1] as const;

const ACCENTS: Record<string, string> = {
  amber: '#ff7a1c', orange: '#ff8a3c', red: '#ff5a4d', green: '#5fe0a0',
  blue: '#5aa9ff', violet: '#8e5cff', cyan: '#46d6e0', gray: '#9aa0a6', white: '#e8e6e3',
};
function color(a: unknown): string {
  const s = String(a ?? '').trim().toLowerCase();
  if (ACCENTS[s]) return ACCENTS[s];
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  return ACCENTS.amber;
}
const clamp = (v: unknown, lo = 0, hi = 100): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
};

interface RawShape { kind?: string; [k: string]: unknown }

export function Custom(
  { payload, revealUpTo = 999 }: { payload: Record<string, unknown>; revealUpTo?: number },
) {
  const prim = (payload.primitive ?? {}) as Record<string, unknown>;
  const shapes = (Array.isArray(prim.shapes) ? prim.shapes : []).slice(0, 40) as RawShape[];
  if (!shapes.length) return <div className="md">No shapes.</div>;

  return (
    <svg className="w-custom" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
      {shapes.map((sh, i) => {
        if (i > revealUpTo) return null;
        const kind = String(sh.kind ?? '');
        const c = color(sh.accent);
        const anim = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.4, delay: i * 0.04, ease: EASE } };
        if (kind === 'box') {
          const x = clamp(sh.x), y = clamp(sh.y), w = clamp(sh.w), h = clamp(sh.h);
          return (
            <motion.g key={i} {...anim}>
              <rect x={x} y={y} width={w} height={h} rx={2} fill={`${c}22`} stroke={c} strokeWidth={0.5} />
              {sh.label ? <text x={x + w / 2} y={y + h / 2} className="w-custom-text" textAnchor="middle" dominantBaseline="middle">{String(sh.label).slice(0, 40)}</text> : null}
            </motion.g>
          );
        }
        if (kind === 'circle') {
          const cx = clamp(sh.x), cy = clamp(sh.y), r = clamp(sh.r, 0, 50);
          return (
            <motion.g key={i} {...anim}>
              <circle cx={cx} cy={cy} r={r} fill={`${c}22`} stroke={c} strokeWidth={0.5} />
              {sh.label ? <text x={cx} y={cy} className="w-custom-text" textAnchor="middle" dominantBaseline="middle">{String(sh.label).slice(0, 40)}</text> : null}
            </motion.g>
          );
        }
        if (kind === 'line') {
          return <motion.line key={i} {...anim} x1={clamp(sh.x1)} y1={clamp(sh.y1)} x2={clamp(sh.x2)} y2={clamp(sh.y2)} stroke={c} strokeWidth={0.5} />;
        }
        if (kind === 'text') {
          return (
            <motion.text key={i} {...anim} x={clamp(sh.x)} y={clamp(sh.y)} fill={c} className="w-custom-text" textAnchor="middle" dominantBaseline="middle">
              {String(sh.label ?? sh.text ?? '').slice(0, 60)}
            </motion.text>
          );
        }
        return null; // unknown kind → dropped
      })}
    </svg>
  );
}
