import { useEffect, useRef } from 'react';
import { orbSignal, effectiveOrbState } from '../lib/signals';
import type { OrbState } from '../lib/protocol';

// A simple, light line-drawing of a globe (canvas2d). A sparse wireframe — a few thin
// parallels + meridians + the silhouette rim — drawn dim with only a faint glow. No
// bloom, no particle field, no heavy render: clean, restrained, lots of black space.
// Rotates slowly; lifts very subtly with the voice level. Muted, calm orange.
// Design rule (do not regress): thin > thick, sparse > dense, subtle > glowing.

type Rgb = [number, number, number];
const WARM: Rgb = [224, 134, 72];
const COOL: Rgb = [150, 140, 220];
const HOT: Rgb = [226, 96, 70];

function colorFor(state: OrbState): Rgb {
  if (state === 'dreaming') return COOL;
  if (state === 'alert') return HOT;
  return WARM;
}

type Ring = Float32Array; // flat x,y,z triples around one unit-sphere circle

function ringParallel(latDeg: number, seg = 90): Ring {
  const lat = (latDeg * Math.PI) / 180;
  const cy = Math.sin(lat);
  const cr = Math.cos(lat);
  const out = new Float32Array(seg * 3);
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    out[k * 3] = Math.cos(a) * cr;
    out[k * 3 + 1] = cy;
    out[k * 3 + 2] = Math.sin(a) * cr;
  }
  return out;
}

function ringMeridian(lonDeg: number, seg = 90): Ring {
  const lon = (lonDeg * Math.PI) / 180;
  const cl = Math.cos(lon);
  const sl = Math.sin(lon);
  const out = new Float32Array(seg * 3);
  for (let k = 0; k < seg; k++) {
    const t = (k / seg) * Math.PI * 2;
    const c = Math.cos(t);
    out[k * 3] = c * cl;
    out[k * 3 + 1] = Math.sin(t);
    out[k * 3 + 2] = c * sl;
  }
  return out;
}

export function Orb({ onActivate }: { onActivate?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      if (fallbackRef.current) fallbackRef.current.style.display = 'block';
      return;
    }

    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;
    const resize = () => {
      W = Math.max(1, Math.floor(canvas.clientWidth * DPR));
      H = Math.max(1, Math.floor(canvas.clientHeight * DPR));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // Sparse wireframe: equator + two parallels, a handful of meridians. That's it.
    const parallels = [-30, 0, 30].map((d) => ringParallel(d));
    const meridians = [0, 36, 72, 108, 144].map((d) => ringMeridian(d));
    const TILT = 0.34;

    const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
    let curCx = 0;
    let curCy = 0;
    let curScale = 1;
    let raf = 0;
    let last = 0;
    const MIN = 1000 / 40; // 40fps is plenty for a calm rotation
    const t0 = performance.now();

    const strokeRing = (
      ring: Ring,
      R: number,
      cx: number,
      cy: number,
      sSpin: number,
      cSpin: number,
      sTilt: number,
      cTilt: number,
    ) => {
      const n = ring.length / 3;
      ctx.beginPath();
      for (let k = 0; k <= n; k++) {
        const i = (k % n) * 3;
        const x0 = ring[i];
        const y0 = ring[i + 1];
        const z0 = ring[i + 2];
        const x1 = x0 * cSpin + z0 * sSpin; // rotate around Y
        const z1 = -x0 * sSpin + z0 * cSpin;
        const y1 = y0 * cTilt - z1 * sTilt; // tilt around X
        const x = cx + x1 * R;
        const y = cy + y1 * R;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    const render = () => {
      raf = requestAnimationFrame(render);
      const now = performance.now();
      if (now - last < MIN) return;
      last = now;
      const t = (now - t0) / 1000;

      // level eases toward the audio/mic target — kept gentle so it stays calm
      const tgt = orbSignal.target;
      orbSignal.level += (tgt - orbSignal.level) * (tgt > orbSignal.level ? 0.3 : 0.08);
      const level = orbSignal.level;

      if (curCx === 0 && curCy === 0) {
        curCx = W * 0.5;
        curCy = H * 0.5;
      }
      curCx = lerp(curCx, orbSignal.dock ? W * 0.84 : W * 0.5, 0.09);
      curCy = lerp(curCy, orbSignal.dock ? H * 0.76 : H * 0.5, 0.09);
      curScale = lerp(curScale, orbSignal.dock ? 0.42 : 1.0, 0.09);

      const [r, g, b] = colorFor(effectiveOrbState(now));
      // small radius → lots of empty black space around it
      const R = Math.min(W, H) * 0.13 * curScale * (1 + level * 0.05);
      const spin = t * 0.16; // slow
      const sSpin = Math.sin(spin);
      const cSpin = Math.cos(spin);
      const sTilt = Math.sin(TILT);
      const cTilt = Math.cos(TILT);

      ctx.clearRect(0, 0, W, H); // transparent over the page's near-black — no opaque repaint
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, DPR * 0.8); // thin, delicate
      ctx.shadowBlur = 3 * DPR; // a faint halo, not bloom
      ctx.shadowColor = `rgba(${r},${g},${b},0.4)`;

      const a = 0.24 + level * 0.18; // dim at rest, a touch brighter while speaking
      ctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(0.55, a)})`;
      for (const ring of parallels) strokeRing(ring, R, curCx, curCy, sSpin, cSpin, sTilt, cTilt);
      for (const ring of meridians) strokeRing(ring, R, curCx, curCy, sSpin, cSpin, sTilt, cTilt);

      // silhouette rim — only a hair brighter, to seat the sphere
      ctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(0.62, a + 0.1)})`;
      ctx.beginPath();
      ctx.arc(curCx, curCy, R, 0, Math.PI * 2);
      ctx.stroke();

      ctx.shadowBlur = 0;
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="orb-canvas"
        onClick={onActivate}
        style={onActivate ? { cursor: 'pointer' } : undefined}
      />
      <div ref={fallbackRef} className="orb-fallback" style={{ display: 'none' }} />
    </>
  );
}
