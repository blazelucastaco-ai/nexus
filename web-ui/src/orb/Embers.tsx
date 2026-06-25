import { useEffect, useRef } from 'react';
import { orbSignal } from '../lib/signals';

// A field of slow, glowing embers drifting upward around the orb. Cheap: a
// pre-rendered soft sprite (no per-frame shadowBlur), fewer particles, 30fps.
interface Spark {
  x: number; y: number; vx: number; vy: number; r: number; life: number; max: number;
}

export function Embers() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const N = 32;
    const sparks: Spark[] = [];

    // Pre-render one soft ember once, then drawImage it — far cheaper than a
    // per-spark shadowBlur every frame.
    const SS = 28;
    const sprite = document.createElement('canvas');
    sprite.width = SS;
    sprite.height = SS;
    const sctx = sprite.getContext('2d');
    if (sctx) {
      const g = sctx.createRadialGradient(SS / 2, SS / 2, 0, SS / 2, SS / 2, SS / 2);
      g.addColorStop(0, 'rgba(255,185,95,1)');
      g.addColorStop(0.4, 'rgba(255,120,40,0.5)');
      g.addColorStop(1, 'rgba(255,90,20,0)');
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, SS, SS);
    }

    const reset = (s: Spark, W: number, H: number, seed = false) => {
      s.x = W * (0.36 + 0.28 * Math.random());
      s.y = H * (0.5 + 0.16 * Math.random());
      s.vx = (Math.random() - 0.5) * 0.22;
      s.vy = -(6 + Math.random() * 16) / 60;
      s.r = 3 + Math.random() * 7;
      s.max = 2.6 + Math.random() * 3.2;
      s.life = seed ? Math.random() * s.max * 30 : 0;
    };

    const resize = () => {
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    for (let i = 0; i < N; i++) {
      const s: Spark = { x: 0, y: 0, vx: 0, vy: 0, r: 4, life: 0, max: 3 };
      reset(s, canvas.clientWidth, canvas.clientHeight, true);
      sparks.push(s);
    }

    let raf = 0;
    let last = 0;
    const FRAME = 1000 / 30;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      if (now - last < FRAME) return;
      last = now;

      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';

      const energy = orbSignal.level;
      for (const s of sparks) {
        s.life += 1;
        s.x += s.vx;
        s.y += s.vy * (1 + energy * 0.7);
        s.vx += (Math.random() - 0.5) * 0.01;
        const t = s.life / (s.max * 30);
        if (t >= 1 || s.y < H * 0.08) {
          reset(s, W, H);
          continue;
        }
        ctx.globalAlpha = Math.sin(t * Math.PI) * (0.5 + energy * 0.5);
        const rr = s.r * (0.7 + energy * 0.5);
        ctx.drawImage(sprite, s.x - rr, s.y - rr, rr * 2, rr * 2);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="embers" />;
}
