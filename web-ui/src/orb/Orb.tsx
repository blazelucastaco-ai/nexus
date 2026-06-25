import { useEffect, useRef } from 'react';
import { orbSignal, effectiveOrbState } from '../lib/signals';
import type { OrbState } from '../lib/protocol';

// Full-screen, OPAQUE shader: it renders the entire scene (black field + molten
// orb + halo) itself, so it can never composite over a light background and wash
// out. Normal blending, clears to black, outputs alpha = 1 everywhere.

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2  uRes;
uniform float uTime;
uniform float uLevel;
uniform float uChurn;
uniform float uSpeed;
uniform float uBright;
uniform float uScale;
uniform float uRim;
uniform vec3  uCore;
uniform vec3  uMid;
uniform vec3  uEdge;
uniform vec2  uCenter;     // orb center in render px — eases to a corner when docked
uniform float uDockScale;  // 1.0 centered, ~0.36 when docked small to make room

float hash(vec2 p){ p = fract(p*vec2(123.34, 345.45)); p += dot(p, p+34.345); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = hash(i), b = hash(i+vec2(1.,0.));
  float c = hash(i+vec2(0.,1.)), d = hash(i+vec2(1.,1.));
  vec2 u = f*f*(3.-2.*f);
  return mix(a,b,u.x) + (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y;
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i=0;i<2;i++){ v += a*noise(p); p = p*2.03 + vec2(11.3, 7.7); a *= 0.5; }
  return v;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - uCenter) / (min(uRes.x, uRes.y) * uDockScale);
  float t = uTime * uSpeed;
  float d = length(uv);

  float breathe = 0.5 + 0.5*sin(uTime*0.7);
  float R = 0.16 * (1.0 + 0.03*breathe + uScale);   // contained focal orb

  vec2 q = uv*4.0;
  vec2 warp = vec2(fbm(q + t*0.6), fbm(q + vec2(5.2,1.3) - t*0.5));
  float n    = fbm(q + warp*uChurn*1.5 + t*0.3);
  float gran = fbm(uv*9.0 + warp*0.7 - t*0.35);
  float turb = mix(n, gran, 0.4);

  float edge = R + (turb-0.5)*0.035*uChurn;
  float body = smoothstep(edge+0.006, edge-0.05, d);   // crisp edge
  float r = clamp(d / max(edge, 0.001), 0.0, 1.0);

  // deep-orange shell, hotter amber core — never white-hot
  float shade = clamp(turb*0.8 + 0.3*(1.0-r), 0.0, 1.0);
  vec3 col = mix(uMid, uCore, shade);
  col += uCore * pow(gran, 2.0) * 0.20;              // granulation
  col *= 0.82 + 0.38*(1.0-r);                         // core a touch brighter

  vec3 scene = col * body * uBright;

  float rim = max(smoothstep(edge, edge-0.03, d) - smoothstep(edge-0.03, edge-0.085, d), 0.0) * uRim;
  scene += uEdge * rim * 0.55;                        // thin bright limb

  // TIGHT halo — decays to nothing well before the screen edge, so the field stays BLACK
  float g = max(d - edge, 0.0);
  float halo = exp(-g*7.0)*0.18;
  scene += uEdge * halo * (0.5 + 0.4*uLevel);

  scene *= 0.96 + 0.04*sin(uTime*26.0)*uLevel;        // gentle flicker

  scene = min(scene, vec3(1.0));                      // clamp, no white-mid lift
  gl_FragColor = vec4(scene, 1.0);                    // OPAQUE — black where no orb
}
`;

type Vec3 = [number, number, number];
interface Params { churn: number; speed: number; bright: number; scale: number; rim: number; core: Vec3; mid: Vec3; edge: Vec3; }

const WARM = { core: [1.0, 0.72, 0.34] as Vec3, mid: [0.92, 0.30, 0.06] as Vec3, edge: [1.0, 0.44, 0.13] as Vec3 };
const COOL = { core: [0.72, 0.66, 1.0] as Vec3, mid: [0.40, 0.30, 0.95] as Vec3, edge: [0.46, 0.32, 1.0] as Vec3 };
const HOT  = { core: [1.0, 0.62, 0.28] as Vec3, mid: [1.0, 0.24, 0.07] as Vec3, edge: [1.0, 0.30, 0.10] as Vec3 };

function paramsFor(state: OrbState): Params {
  switch (state) {
    case 'listening': return { churn: 0.6, speed: 0.52, bright: 1.06, scale: 0.03, rim: 1.06, ...WARM };
    // thinking = mostly STILL: a slow, calm simmer (just above idle), so it reads
    // as "considering" rather than frantic. The user wanted it to settle here.
    case 'thinking':  return { churn: 0.54, speed: 0.32, bright: 0.9, scale: 0.0, rim: 0.92, ...WARM };
    case 'speaking':  return { churn: 0.85, speed: 0.62, bright: 1.02, scale: 0.05, rim: 1.0, ...WARM };
    case 'tool':      return { churn: 0.95, speed: 0.85, bright: 0.98, scale: 0.02, rim: 0.98, ...WARM };
    case 'task':      return { churn: 1.05, speed: 0.72, bright: 0.98, scale: 0.02, rim: 0.98, ...WARM };
    case 'dreaming':  return { churn: 0.5, speed: 0.16, bright: 0.78, scale: 0.0, rim: 0.9, ...COOL };
    case 'alert':     return { churn: 1.1, speed: 1.18, bright: 1.12, scale: 0.04, rim: 1.15, ...HOT };
    default:          return { churn: 0.48, speed: 0.24, bright: 0.92, scale: 0.0, rim: 0.95, ...WARM };
  }
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('orb shader error:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function Orb({ onActivate }: { onActivate?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = (canvas.getContext('webgl', { alpha: false, antialias: true }) ??
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) {
      if (fallbackRef.current) fallbackRef.current.style.display = 'block';
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('orb link error:', gl.getProgramInfoLog(prog));
      if (fallbackRef.current) fallbackRef.current.style.display = 'block';
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const u = {
      res: gl.getUniformLocation(prog, 'uRes'), time: gl.getUniformLocation(prog, 'uTime'),
      level: gl.getUniformLocation(prog, 'uLevel'), churn: gl.getUniformLocation(prog, 'uChurn'),
      speed: gl.getUniformLocation(prog, 'uSpeed'), bright: gl.getUniformLocation(prog, 'uBright'),
      scale: gl.getUniformLocation(prog, 'uScale'), rim: gl.getUniformLocation(prog, 'uRim'),
      core: gl.getUniformLocation(prog, 'uCore'), mid: gl.getUniformLocation(prog, 'uMid'),
      edge: gl.getUniformLocation(prog, 'uEdge'),
      center: gl.getUniformLocation(prog, 'uCenter'), dockScale: gl.getUniformLocation(prog, 'uDockScale'),
    };

    gl.clearColor(0, 0, 0, 1); // opaque black scene

    // Render at a low internal resolution — the orb is soft, so upscaling is
    // invisible, and this is the biggest perf lever on a weak GPU. Lowered for
    // guaranteed smoothness with widgets animating on top. NEVER multiply by
    // devicePixelRatio (it would quadruple cost on retina for no visible gain).
    const RENDER_SCALE = window.innerHeight < 900 ? 0.46 : 0.5;
    const resize = () => {
      const w = Math.max(1, Math.floor(canvas.clientWidth * RENDER_SCALE));
      const h = Math.max(1, Math.floor(canvas.clientHeight * RENDER_SCALE));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h);
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const cur: Params = paramsFor('idle');
    const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
    const lerp3 = (a: Vec3, b: Vec3, k: number): Vec3 => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
    // Eased orb dock position (render px) + scale: glides to a bottom-right corner
    // when a primary visual holds the Stage, back to center when it clears.
    let curCx = 0, curCy = 0, curDock = 1;

    let raf = 0;
    let lastFrame = 0;
    const MIN_FRAME_MS = 1000 / 30; // 30fps is plenty for a slow orb; halves GPU load
    const t0 = performance.now();
    const render = () => {
      raf = requestAnimationFrame(render);
      const now = performance.now();
      if (now - lastFrame < MIN_FRAME_MS) return;
      lastFrame = now;
      const time = (now - t0) / 1000;

      const tgt = orbSignal.target;
      orbSignal.level += (tgt - orbSignal.level) * (tgt > orbSignal.level ? 0.35 : 0.07);

      const p = paramsFor(effectiveOrbState(now));
      const k = 0.06;
      cur.churn = lerp(cur.churn, p.churn, k); cur.speed = lerp(cur.speed, p.speed, k);
      cur.bright = lerp(cur.bright, p.bright, k); cur.scale = lerp(cur.scale, p.scale, k);
      cur.rim = lerp(cur.rim, p.rim, k);
      cur.core = lerp3(cur.core, p.core, k); cur.mid = lerp3(cur.mid, p.mid, k); cur.edge = lerp3(cur.edge, p.edge, k);

      const W = canvas.width, H = canvas.height;
      if (curCx === 0 && curCy === 0) { curCx = W * 0.5; curCy = H * 0.5; } // snap to center on first frame
      curCx = lerp(curCx, orbSignal.dock ? W * 0.80 : W * 0.5, 0.09);
      curCy = lerp(curCy, orbSignal.dock ? H * 0.26 : H * 0.5, 0.09); // gl_FragCoord.y is bottom-up → low y = bottom
      curDock = lerp(curDock, orbSignal.dock ? 0.36 : 1.0, 0.09);

      const lvl = orbSignal.level;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(u.res, canvas.width, canvas.height);
      gl.uniform1f(u.time, time);
      gl.uniform1f(u.level, lvl);
      gl.uniform1f(u.churn, cur.churn + lvl * 0.25);
      gl.uniform1f(u.speed, cur.speed + lvl * 0.2);
      gl.uniform1f(u.bright, cur.bright + lvl * 0.28);
      gl.uniform1f(u.scale, cur.scale + lvl * 0.06);
      gl.uniform1f(u.rim, cur.rim);
      gl.uniform3fv(u.core, cur.core);
      gl.uniform3fv(u.mid, cur.mid);
      gl.uniform3fv(u.edge, cur.edge);
      gl.uniform2f(u.center, curCx, curCy);
      gl.uniform1f(u.dockScale, curDock);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteBuffer(buf);
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
