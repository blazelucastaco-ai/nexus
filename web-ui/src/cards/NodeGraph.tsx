import { useMemo } from 'react';
import { motion } from 'framer-motion';

// A node-and-edge graph that builds in piece-by-piece. Generalizes the side-rail
// Diagram with a `hub` layout (a core node with spokes around it) and, crucially,
// an `order`/`revealUpTo` mechanism so the Stage can draw it in as NEXUS narrates —
// name the brain, it forms; name a channel, its line draws out to it.

interface Node { id: string; label: string; order: number; group?: string }
interface Edge { from: string; to: string; label?: string; order: number }
interface Placed extends Node { x: number; y: number; layer: number }

const NODE_W = 134;
const NODE_H = 46;
const GAP_X = 80;
const GAP_Y = 26;
const MARGIN = 22;
const EASE = [0.16, 1, 0.3, 1] as const;

function build(payload: Record<string, unknown>) {
  const rawNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const rawEdges = Array.isArray(payload.edges) ? payload.edges : [];
  const layout = String(payload.layout ?? 'flow');

  const mapped: Node[] = rawNodes
    .map((n, i) => {
      const o = (n ?? {}) as Record<string, unknown>;
      return {
        id: String(o.id ?? o.label ?? ''),
        label: String(o.label ?? o.id ?? ''),
        group: o.group ? String(o.group) : undefined,
        order: Number.isFinite(Number(o.order)) ? Number(o.order) : i,
      };
    })
    .filter((n) => n.id)
    .slice(0, 18);
  // Dedup by (model-controlled) id so React keys are unique, then make `order` a
  // CONTIGUOUS narration rank (0,1,2…). The Stage's reveal advances by integer
  // index, so sparse/duplicate model `order` values would otherwise leave pieces
  // hidden until speech ends — this keeps the build-as-it-speaks in lockstep.
  const seen = new Set<string>();
  const nodes: Node[] = mapped
    .filter((n) => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    })
    .sort((a, b) => a.order - b.order)
    .map((n, i) => ({ ...n, order: i }));
  const idset = new Set(nodes.map((n) => n.id));
  const rank = new Map(nodes.map((n) => [n.id, n.order]));
  const edges: Edge[] = rawEdges
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>;
      return { from: String(o.from ?? ''), to: String(o.to ?? ''), label: o.label ? String(o.label) : undefined, order: 0 };
    })
    .filter((e) => idset.has(e.from) && idset.has(e.to))
    // an edge appears once BOTH endpoints have → its rank is the later node's rank
    .map((e) => ({ ...e, order: Math.max(rank.get(e.from) ?? 0, rank.get(e.to) ?? 0) }));

  const placed: Placed[] = [];
  let width = 0;
  let height = 0;

  if ((layout === 'hub' || layout === 'radial') && nodes.length > 1) {
    // First node, or the one tagged group:'core', sits in the center; the rest ring it.
    const coreIdx = Math.max(0, nodes.findIndex((n) => n.group === 'core'));
    const core = nodes[coreIdx] ?? nodes[0]!;
    const spokes = nodes.filter((n) => n.id !== core.id);
    const r = Math.max(150, spokes.length * 30); // more breathing room so nodes don't crowd
    const cx = r + NODE_W / 2 + MARGIN;
    const cy = r + NODE_H / 2 + MARGIN;
    placed.push({ ...core, layer: 0, x: cx - NODE_W / 2, y: cy - NODE_H / 2 });
    spokes.forEach((n, i) => {
      const a = (i / spokes.length) * Math.PI * 2 - Math.PI / 2;
      placed.push({ ...n, layer: 1, x: cx + Math.cos(a) * r - NODE_W / 2, y: cy + Math.sin(a) * r - NODE_H / 2 });
    });
    width = cx * 2;
    height = cy * 2;
  } else {
    // longest-path layering (flow / tree), bounded passes guard against cycles
    const layer = new Map(nodes.map((n) => [n.id, 0]));
    for (let pass = 0; pass < nodes.length; pass++) {
      let changed = false;
      for (const e of edges) {
        const nl = (layer.get(e.from) ?? 0) + 1;
        if (nl > (layer.get(e.to) ?? 0)) { layer.set(e.to, nl); changed = true; }
      }
      if (!changed) break;
    }
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
      arr.forEach((n) => { placed.push({ ...n, layer: l, x: MARGIN + l * (NODE_W + GAP_X), y }); y += NODE_H + GAP_Y; });
    }
    width = MARGIN * 2 + (maxLayer + 1) * NODE_W + maxLayer * GAP_X;
    height = MARGIN * 2 + totalH;
  }

  const pos = new Map(placed.map((p) => [p.id, p]));
  const radial = layout === 'hub' || layout === 'radial';
  return { placed, edges, pos, radial, width: Math.max(width, 200), height: Math.max(height, 120) };
}

function edgePath(a: Placed, b: Placed): string {
  const ax = a.x + NODE_W / 2;
  const ay = a.y + NODE_H / 2;
  const bx = b.x + NODE_W / 2;
  const by = b.y + NODE_H / 2;
  const mx = (ax + bx) / 2;
  return `M ${ax} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${bx} ${by}`;
}

// For a hub/radial layout, spokes read cleanest as straight lines from the core —
// consistent and uncluttered (the nodes drawn on top hide the ends).
function straightPath(a: Placed, b: Placed): string {
  return `M ${a.x + NODE_W / 2} ${a.y + NODE_H / 2} L ${b.x + NODE_W / 2} ${b.y + NODE_H / 2}`;
}

export function NodeGraph(
  { payload, revealUpTo = 999, highlight = -1 }:
  { payload: Record<string, unknown>; revealUpTo?: number; highlight?: number },
) {
  const { placed, edges, pos, radial, width, height } = useMemo(() => build(payload), [payload]);
  if (!placed.length) return <div className="md">No diagram data.</div>;

  return (
    <svg className="diagram-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="ng-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="rgba(255,138,60,0.7)" />
        </marker>
      </defs>

      {edges.map((e, i) => {
        if (e.order > revealUpTo) return null;
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const mx = (a.x + b.x) / 2 + NODE_W / 2;
        const my = (a.y + b.y) / 2 + NODE_H / 2;
        return (
          <g key={`e${i}`}>
            <motion.path
              className="dg-edge"
              d={radial ? straightPath(a, b) : edgePath(a, b)}
              markerEnd={radial ? undefined : 'url(#ng-arrow)'}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 0.6, ease: EASE }}
            />
            {e.label ? (
              <motion.text className="dg-edge-label" x={mx} y={my - 4} textAnchor="middle"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}>
                {e.label}
              </motion.text>
            ) : null}
          </g>
        );
      })}

      {placed.filter((n) => n.order <= revealUpTo).map((n) => {
        const active = n.order === highlight;
        return (
          <motion.g
            key={n.id}
            className={`dg-node${active ? ' dg-node-active' : ''}`}
            initial={{ opacity: 0, scale: 0.55 }}
            animate={{ opacity: 1, scale: active ? 1.05 : 1 }}
            transition={{ duration: 0.5, ease: EASE }}
            style={{ transformOrigin: `${n.x + NODE_W / 2}px ${n.y + NODE_H / 2}px` }}
          >
            <rect x={n.x} y={n.y} width={NODE_W} height={NODE_H} rx={11} />
            <text x={n.x + NODE_W / 2} y={n.y + NODE_H / 2 + 4} textAnchor="middle">
              {n.label.length > 17 ? `${n.label.slice(0, 16)}…` : n.label}
            </text>
          </motion.g>
        );
      })}
    </svg>
  );
}
