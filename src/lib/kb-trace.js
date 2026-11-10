// BUG-177 (2026-11-05): the iOS keyboard jerk survived a fix built on an emulated
// keyboard — we need the DEVICE's numbers. For admin only: on focus/blur of a text
// field, record every animation frame for ~1,5 s (visualViewport, window scroll,
// where the shell / header / composer are) plus the events Safari fired, then POST
// them to /zai/api/diag/kb. Numbers only, no text. At most MAX_TRACES per page load.
import { api } from "./api.js";
import { VERSION } from "./version.js";

export const MAX_TRACES = 6;
let sent = 0;
let running = false;

const rect = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return [Math.round(r.top), Math.round(r.height)];
};

// One frame of what the user sees — pure DOM read.
export function frameSnapshot(t0) {
  const vv = window.visualViewport;
  const root = document.documentElement;
  return {
    t: Math.round(performance.now() - t0),
    vvH: vv ? Math.round(vv.height) : null,
    vvTop: vv ? Math.round(vv.offsetTop) : null,
    vvPage: vv && "pageTop" in vv ? Math.round(vv.pageTop) : null,
    sy: Math.round(window.scrollY),
    ih: window.innerHeight,
    ch: root.clientHeight,
    cssH: root.style.getPropertyValue("--vvh") || null,
    cssTop: root.style.getPropertyValue("--vv-top") || null,
    kb: root.classList.contains("kb"),
    shell: rect(".shell"),
    head: rect(".chat-header"),
    comp: rect(".composer"),
    feedTop: (() => { const v = document.querySelector(".chat-scroll, .msg-list, .view"); return v ? Math.round(v.scrollTop) : null; })(),
  };
}

// → Promise<payload|null>. send(payload) is injectable for tests.
export function startKbTrace(kind, { ms = 1500, send = (p) => api.kbTrace(p) } = {}) {
  if (running || sent >= MAX_TRACES || !window.visualViewport) return Promise.resolve(null);
  running = true;
  sent++;
  const t0 = performance.now();
  const frames = [];
  const events = [];
  const vv = window.visualViewport;
  const log = (name) => () => events.push([name, Math.round(performance.now() - t0), Math.round(vv.height), Math.round(vv.offsetTop), Math.round(window.scrollY)]);
  const handlers = [["vv.resize", vv, "resize"], ["vv.scroll", vv, "scroll"], ["win.resize", window, "resize"], ["win.scroll", window, "scroll"]].map(([n, target, type]) => {
    const fn = log(n);
    target.addEventListener(type, fn);
    return () => target.removeEventListener(type, fn);
  });
  return new Promise((resolve) => {
    const tick = () => {
      frames.push(frameSnapshot(t0));
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else {
        for (const off of handlers) off();
        running = false;
        const payload = { kind, ver: VERSION, ua: navigator.userAgent, standalone: navigator.standalone === true, dpr: window.devicePixelRatio, frames, events };
        Promise.resolve(send(payload)).catch(() => {}).finally(() => resolve(payload));
      }
    };
    requestAnimationFrame(tick);
  });
}


export function resetKbTrace() {
  sent = 0;
  running = false;
}
