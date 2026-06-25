import { useMemo } from 'react';
import { motion } from 'framer-motion';

interface Node { id: string; label: string; }
interface Edge { from: string; to: string; label?: string; }

const NODE_W = 128;
const NODE_H = 42;
const GAP_X = 76;
const GAP_Y = 24;
const MARGIN = 16;

interface Placed extends Node { x: number; y: number; layer: number; }

function build(payload: Record<string, unknown>) {
  const rawNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const rawEdges = Array.isArray(payload.edges) ? payload.edges : [];
  const layout = String(payload.layout ?? 'flow');

  const mapped: Node[] = rawNodes
    .map((n) => {
      const o = (n ?? {}) as Record<string, unknown>;
      return { id: String(o.id ?? o.label ?? ''), label: String(o.label ?? o.id ?? '') };
    })
    .filter((n) => n.id)
    .slice(0, 18);
  // dedup by (model-controlled) id so React keys stay unique
  const seen = new Set<string>();
  const nodes: Node[] = mapped.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
  const idset = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = rawEdges
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>;
      return { from: String(o.from ?? ''), to: String(o.to ?? ''), label: o.label ? String(o.label) : undefined };
    })
    .filter((e) => idset.has(e.from) && idset.has(e.to));

  // longest-path layering (bounded passes guard against cycles)
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const nl = (layer.get(e.from) ?? 0) + 1;
      if (nl > (layer.get(e.to) ?? 0)) {
        layer.set(e.to, nl);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const placed: Placed[] = [];
  let width = 0;
  let height = 0;

  if (layout === 'radial' && nodes.length > 1) {
    const r = Math.max(90, nodes.length * 22);
    const cx = r + NODE_W / 2 + MARGIN;
    const cy = r + NODE_H / 2 + MARGIN;
    nodes.forEach((n, i) => {
      const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
      placed.push({ ...n, layer: 0, x: cx + Math.cos(a) * r - NODE_W / 2, y: cy + Math.sin(a) * r - NODE_H / 2 });
    });
    width = cx * 2;
    height = cy * 2;
  } else {
    const byLayer = new Map<number, Node[]>();
    for (const n of nodes) {
      const l = layer.get(n.id) ?? 0;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(n);
    }
    const maxRows = Math.max(...[...byLayer.values()].map((a) => a.length), 1);
    const totalH = maxRows * NODE_H + (maxRows - 1) * GAP_Y;
    const centerY = MARGIN + totalH / 2;
    let maxLayer = 0;
    for (const [l, arr] of byLayer) {
      maxLayer = Math.max(maxLayer, l);
      const layH = arr.length * NODE_H + (arr.length - 1) * GAP_Y;
      let y = centerY - layH / 2;
      arr.forEach((n) => {
        placed.push({ ...n, layer: l, x: MARGIN + l * (NODE_W + GAP_X), y });
        y += NODE_H + GAP_Y;
      });
    }
    width = MARGIN * 2 + (maxLayer + 1) * NODE_W + maxLayer * GAP_X;
    height = MARGIN * 2 + totalH;
  }

  const pos = new Map(placed.map((p) => [p.id, p]));
  return { placed, edges, pos, width: Math.max(width, 160), height: Math.max(height, 80) };
}

function edgePath(a: Placed, b: Placed): string {
  const ax = a.x + NODE_W / 2;
  const ay = a.y + NODE_H / 2;
  const bx = b.x + NODE_W / 2;
  const by = b.y + NODE_H / 2;
  const mx = (ax + bx) / 2;
  return `M ${ax} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${bx} ${by}`;
}

export function Diagram({ payload }: { payload: Record<string, unknown> }) {
  const { placed, edges, pos, width, height } = useMemo(() => build(payload), [payload]);
  if (!placed.length) return <div className="md">No diagram data.</div>;

  return (
    <svg className="diagram-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="dg-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="rgba(255,138,60,0.7)" />
        </marker>
      </defs>

      {edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const delay = 0.18 + a.layer * 0.16;
        const mx = (a.x + b.x) / 2 + NODE_W / 2;
        const my = (a.y + b.y) / 2 + NODE_H / 2;
        return (
          <g key={`e${i}`}>
            <motion.path
              className="dg-edge"
              d={edgePath(a, b)}
              markerEnd="url(#dg-arrow)"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] }}
            />
            {e.label ? (
              <motion.text
                className="dg-edge-label"
                x={mx}
                y={my - 4}
                textAnchor="middle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: delay + 0.4 }}
              >
                {e.label}
              </motion.text>
            ) : null}
          </g>
        );
      })}

      {placed.map((n, i) => (
        <motion.g
          key={n.id}
          className="dg-node"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.45, delay: n.layer * 0.16 + i * 0.04, ease: [0.16, 1, 0.3, 1] }}
          style={{ transformOrigin: `${n.x + NODE_W / 2}px ${n.y + NODE_H / 2}px` }}
        >
          <rect x={n.x} y={n.y} width={NODE_W} height={NODE_H} rx={10} />
          <text x={n.x + NODE_W / 2} y={n.y + NODE_H / 2 + 4} textAnchor="middle">
            {n.label.length > 16 ? `${n.label.slice(0, 15)}…` : n.label}
          </text>
        </motion.g>
      ))}
    </svg>
  );
}
