// FEAT-19.14: «ждут вашего решения» counter for the Drawer and the Temporal tab.
// One poll for the whole app (30 s, paused in a background tab); failures keep
// the last known value — a badge never lies «0» because of a network blip.
import { signal } from "@preact/signals";
import { api } from "./api.js";

export const temporalAttention = signal(0);
let timer = null;
export async function refreshTemporalAttention() {
  try { temporalAttention.value = Number((await api.temporalAttention()).waiting) || 0; } catch { /* keep */ }
}
export function startTemporalAttention(ms = 30000) {
  if (timer || typeof setInterval === "undefined") return;
  refreshTemporalAttention();
  timer = setInterval(() => {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") refreshTemporalAttention();
  }, ms);
  timer.unref?.(); // never keeps a Node process (tests, SSR) alive
}
export function stopTemporalAttention() { clearInterval(timer); timer = null; }
