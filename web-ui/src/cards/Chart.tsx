import { useEffect, useMemo, useRef } from 'react';

interface Point { label: string; value: number; }
type ChartType = 'bar' | 'line' | 'area' | 'donut';

function coerce(payload: Record<string, unknown>): { type: ChartType; points: Point[] } {
  const rawType = String(payload.chartType ?? 'bar');
  const type: ChartType = (['bar', 'line', 'area', 'donut'] as const).includes(rawType as ChartType)
    ? (rawType as ChartType)
    : 'bar';
  const arr = Array.isArray(payload.data) ? payload.data : [];
  const points: Point[] = arr
    .map((d) => {
      const o = (d ?? {}) as Record<string, unknown>;
      return { label: String(o.label ?? ''), value: Number(o.value) };
    })
    .filter((p) => Number.isFinite(p.value))
    .slice(0, 24);
  return { type, points };
}

const PAL = ['#ff7a1c', '#ffb163', '#ff5a2a', '#ffd29a', '#ff9248', '#e8541a', '#ffc070', '#ff6a30'];
const easeOut = (t: number) => 1 - (1 - t) ** 3;

export function Chart({ payload }: { payload: Record<string, unknown> }) {
  const { type, points } = useMemo(() => coerce(payload), [payload]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const subtitle = payload.subtitle ? String(payload.subtitle) : '';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const H = 190;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    const start = performance.now();

    const draw = () => {
      const W = canvas.clientWidth || 360;
      if (canvas.width !== Math.floor(W * dpr) || canvas.height !== Math.floor(H * dpr)) {
        canvas.width = Math.floor(W * dpr);
        canvas.height = Math.floor(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const t = Math.min(1, (performance.now() - start) / 950);
      const max = Math.max(...points.map((p) => p.value), 1);
      const pad = 26;
      const plotH = H - pad * 2;
      const plotW = W - pad * 1.4;

      if (type === 'bar') {
        const n = points.length;
        const gap = Math.min(14, plotW / n / 4);
        const bw = (plotW - gap * (n - 1)) / n;
        points.forEach((p, i) => {
          const local = easeOut(Math.max(0, Math.min(1, (t - i * 0.05 / Math.max(1, n)) * 1.4)));
          const h = (p.value / max) * plotH * local;
          const x = pad + i * (bw + gap);
          const y = H - pad - h;
          const g = ctx.createLinearGradient(0, y, 0, H - pad);
          g.addColorStop(0, PAL[i % PAL.length]!);
          g.addColorStop(1, 'rgba(255,90,20,0.15)');
          ctx.fillStyle = g;
          ctx.shadowColor = 'rgba(255,122,28,0.6)';
          ctx.shadowBlur = 16;
          roundRect(ctx, x, y, bw, h, Math.min(6, bw / 2));
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.fillStyle = 'rgba(246,239,231,0.5)';
          ctx.font = '500 10px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(trunc(p.label, 7), x + bw / 2, H - pad + 13);
        });
      } else if (type === 'donut') {
        const total = points.reduce((s, p) => s + Math.max(0, p.value), 0) || 1;
        const cx = W / 2;
        const cy = H / 2;
        const r = Math.min(plotH, plotW) / 2 - 4;
        const inner = r * 0.6;
        let a = -Math.PI / 2;
        const sweep = easeOut(t) * Math.PI * 2;
        points.forEach((p, i) => {
          const frac = Math.max(0, p.value) / total;
          const a2 = a + frac * Math.PI * 2;
          const drawEnd = Math.min(a2, -Math.PI / 2 + sweep);
          if (drawEnd > a) {
            ctx.beginPath();
            ctx.arc(cx, cy, r, a, drawEnd);
            ctx.arc(cx, cy, inner, drawEnd, a, true);
            ctx.closePath();
            ctx.fillStyle = PAL[i % PAL.length]!;
            ctx.shadowColor = 'rgba(255,122,28,0.5)';
            ctx.shadowBlur = 14;
            ctx.fill();
            ctx.shadowBlur = 0;
          }
          a = a2;
        });
      } else {
        // line / area
        const n = points.length;
        const stepX = n > 1 ? plotW / (n - 1) : 0;
        const xy = points.map((p, i) => [pad + i * stepX, H - pad - (p.value / max) * plotH] as const);
        const reveal = easeOut(t) * (n - 1);
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = '#ff9248';
        ctx.shadowColor = 'rgba(255,122,28,0.7)';
        ctx.shadowBlur = 18;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const seg = Math.max(0, Math.min(1, reveal - (i - 1)));
          if (i === 0) {
            ctx.moveTo(xy[0]![0], xy[0]![1]);
          } else if (seg > 0) {
            const px = xy[i - 1]![0] + (xy[i]![0] - xy[i - 1]![0]) * seg;
            const py = xy[i - 1]![1] + (xy[i]![1] - xy[i - 1]![1]) * seg;
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        if (type === 'area') {
          const lastIdx = Math.floor(reveal);
          const fx = xy[Math.min(lastIdx, n - 1)]![0];
          ctx.lineTo(fx, H - pad);
          ctx.lineTo(xy[0]![0], H - pad);
          ctx.closePath();
          const g = ctx.createLinearGradient(0, pad, 0, H - pad);
          g.addColorStop(0, 'rgba(255,122,28,0.32)');
          g.addColorStop(1, 'rgba(255,122,28,0.02)');
          ctx.fillStyle = g;
          ctx.fill();
        }
      }

      if (t < 1) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const ro = new ResizeObserver(() => { raf = requestAnimationFrame(draw); });
    ro.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [type, points]);

  if (!points.length) return <div className="md">No chart data.</div>;
  return (
    <div>
      <canvas ref={canvasRef} className="chart-canvas" style={{ height: 190 }} />
      {subtitle ? <div className="chart-legend"><span>{subtitle}</span></div> : null}
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function trunc(s: string, n: number) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
