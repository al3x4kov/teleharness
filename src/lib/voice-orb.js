// FEAT-06.2 voice-mode orb — concept B «Рой частиц» (picked
// 2026-11-05 from the voice-orb mockups, setupB), ported 1:1: ~1000
// points on a Fibonacci sphere in 3D, rotation, noise displacement by the
// voice level, think → 5 orbital bands, speak → radial waves, mute → grey
// and almost still, error → red-amber jitter; palettes blend smoothly,
// additive blending, round dots, a core glow.
//
// createOrb(canvas, {getLevel, reduced}) → {setState, start, stop, destroy}
// getLevel(state) → 0..1 or null (null = the concept's simulated envelope).
// reduced (prefers-reduced-motion): one static frame per state change.
// The loop pauses while the page is hidden.

export const ORB_PALETTES = Object.freeze({
  listen: [[0.2, 0.75, 1.0], [0.35, 0.45, 1.0], [0.75, 0.95, 1.0]],
  think: [[0.55, 0.3, 1.0], [0.25, 0.2, 0.75], [0.9, 0.7, 1.0]],
  speak: [[0.1, 0.95, 0.85], [0.25, 0.55, 1.0], [0.85, 1.0, 0.95]],
  mute: [[0.45, 0.48, 0.55], [0.25, 0.27, 0.32], [0.7, 0.72, 0.78]],
  error: [[1.0, 0.35, 0.25], [0.65, 0.12, 0.1], [1.0, 0.75, 0.35]],
});

// Voice-mode state → orb state.
export function orbStateOf(state) {
  if (state === "thinking" || state === "sending") return "think";
  if (state === "speaking") return "speak";
  if (state === "muted") return "mute";
  if (state === "error") return "error";
  return "listen";
}

// The concept's simulated voice envelope (syllables + phrase gaps).
export function simLevel(state, t) {
  if (state === "mute" || state === "error") return 0;
  if (state === "think") return 0.08 + 0.04 * Math.sin(t * 1.3);
  const phrase = Math.sin(t * 0.55) + Math.sin(t * 0.31 + 1) > -0.6 ? 1 : 0.05;
  const syl = Math.pow(Math.abs(Math.sin(t * (state === "speak" ? 7.5 : 5.2)) * Math.sin(t * 2.1 + 0.5)), 0.7);
  return Math.min(1, phrase * (0.25 + 0.75 * syl) * (state === "speak" ? 0.9 : 0.75));
}

function setupB(cv, view) {
  const g = cv.getContext("2d");
  if (!g) return null;
  const N = 1000;
  const P = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const rr = Math.sqrt(1 - y * y);
    const th = ga * i;
    P.push({ x: Math.cos(th) * rr, y, z: Math.sin(th) * rr, ph: Math.random() * 6.28, band: Math.floor(Math.random() * 5) });
  }
  const rgb = (c, a) => `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;
  let think = 0;
  return (t) => {
    const { state, level, col } = view;
    const W = cv.width;
    const H = cv.height;
    const s = Math.min(W, H);
    const cx = W / 2;
    const cy = H / 2;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, W, H);
    const halo = g.createRadialGradient(cx, cy, s * 0.05, cx, cy, s * 0.5);
    halo.addColorStop(0, rgb(col[0], 0.18 + level * 0.25));
    halo.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = halo;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = "lighter";
    think += ((state === "think" ? 1 : 0) - think) * (view.reduced ? 1 : 0.04);
    const rotY = t * (state === "mute" ? 0.08 : 0.35 + think * 0.6);
    const rotX = 0.35 + Math.sin(t * 0.2) * 0.15;
    const cy1 = Math.cos(rotY);
    const sy1 = Math.sin(rotY);
    const cx1 = Math.cos(rotX);
    const sx1 = Math.sin(rotX);
    const R = s * (state === "mute" ? 0.3 : 0.36 + level * 0.05);
    for (const p of P) {
      const amp = state === "mute" ? 0.01 : 0.05 + level * 0.22;
      let d = Math.sin(p.x * 3.1 + t * 1.3) * Math.sin(p.y * 2.7 - t * 1.1) * Math.sin(p.z * 3.3 + t * 0.9);
      if (state === "speak") d += Math.sin(Math.acos(Math.max(-1, Math.min(1, p.y))) * 9 - t * 7) * 0.5 * level;
      if (state === "error" && !view.reduced) d += (Math.random() - 0.5) * 0.15;
      let x = p.x;
      let y = p.y;
      let z = p.z;
      if (think > 0.01) {
        // pull into orbital bands
        const by = -0.8 + p.band * 0.4;
        const rr = Math.sqrt(1 - by * by);
        const a = Math.atan2(p.z, p.x) + t * (0.6 + p.band * 0.25) * (p.band % 2 ? 1 : -1);
        x += (Math.cos(a) * rr - x) * think;
        y += (by - y) * think;
        z += (Math.sin(a) * rr - z) * think;
      }
      const k = 1 + d * amp;
      x *= k;
      y *= k;
      z *= k;
      const X = x * cy1 + z * sy1;
      const Z0 = -x * sy1 + z * cy1;
      const Y = y * cx1 - Z0 * sx1;
      const Z = y * sx1 + Z0 * cx1;
      const persp = 1.6 / (2.6 - Z);
      const px = cx + X * R * persp;
      const py = cy + Y * R * persp;
      const depth = (Z + 1) / 2;
      const c = depth > 0.5 ? col[2] : col[0];
      const tw = 0.6 + 0.4 * Math.sin(t * 3 + p.ph);
      g.fillStyle = rgb(c, (0.15 + depth * 0.75) * tw);
      const sz = (0.9 + depth * 2.1) * (s / 300) * (1 + level * 0.6);
      g.beginPath();
      g.arc(px, py, sz / 2, 0, 6.283);
      g.fill();
    }
    // core
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.55);
    core.addColorStop(0, rgb(col[2], 0.35 + level * 0.4));
    core.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = core;
    g.beginPath();
    g.arc(cx, cy, R * 0.55, 0, 6.283);
    g.fill();
  };
}

export function createOrb(canvas, { getLevel = () => null, reduced = false } = {}) {
  const view = { state: "listen", level: 0, col: ORB_PALETTES.listen.map((v) => v.slice()), reduced };
  let draw = null;
  try {
    draw = setupB(canvas, view);
  } catch {
    draw = null;
  }
  let raf = 0;
  let running = false;
  let last = 0;
  let t0 = 0;
  const raf_ = globalThis.requestAnimationFrame?.bind(globalThis);
  const caf_ = globalThis.cancelAnimationFrame?.bind(globalThis);

  function fit() {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.round((canvas.clientWidth || 300) * dpr);
    const h = Math.round((canvas.clientHeight || 300) * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  function step(t) {
    let target = null;
    try {
      target = getLevel(view.state);
    } catch {
      target = null;
    }
    if (target == null || !Number.isFinite(target)) target = simLevel(view.state, t);
    if (view.reduced) {
      view.level = view.state === "mute" || view.state === "error" ? 0 : Math.min(0.3, target);
      const pal = ORB_PALETTES[view.state];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) view.col[i][j] = pal[i][j];
    } else {
      view.level += (target - view.level) * (target > view.level ? 0.35 : 0.08);
      const pal = ORB_PALETTES[view.state];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) view.col[i][j] += (pal[i][j] - view.col[i][j]) * 0.06;
    }
    try {
      draw?.(t);
    } catch {}
  }

  function frame(now) {
    if (!running) return;
    if (!last) {
      last = now;
      t0 = now;
    }
    last = now;
    step((now - t0) / 1000);
    raf = raf_ ? raf_(frame) : 0;
  }

  function staticFrame() {
    fit();
    step(1.5);
  }

  const onVis = () => {
    if (view.reduced) return;
    if (globalThis.document?.hidden) {
      if (raf && caf_) caf_(raf);
      raf = 0;
    } else if (running && !raf && raf_) {
      last = 0;
      raf = raf_(frame);
    }
  };
  const onResize = () => (view.reduced ? staticFrame() : fit());

  return {
    get state() {
      return view.state;
    },
    setState(st) {
      const next = ORB_PALETTES[st] ? st : "listen";
      if (next === view.state) return;
      view.state = next;
      if (view.reduced && running) staticFrame();
    },
    start() {
      if (running || !draw) return;
      running = true;
      fit();
      globalThis.document?.addEventListener?.("visibilitychange", onVis);
      globalThis.addEventListener?.("resize", onResize);
      if (view.reduced) staticFrame();
      else if (raf_ && !globalThis.document?.hidden) raf = raf_(frame);
    },
    stop() {
      running = false;
      if (raf && caf_) caf_(raf);
      raf = 0;
      globalThis.document?.removeEventListener?.("visibilitychange", onVis);
      globalThis.removeEventListener?.("resize", onResize);
    },
    destroy() {
      this.stop();
      draw = null;
    },
  };
}
