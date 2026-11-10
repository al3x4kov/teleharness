// FEAT-07.20: Web Push on the client — support check, service worker
// registration (scope /zai/), subscribe/unsubscribe, «Проверить», presence.
// Browser globals are read lazily (node imports this module in tests).
import { api } from "./api.js";

export const SW_URL = "/zai/sw.js";
export const SW_SCOPE = "/zai/";

const nav = () => (typeof navigator !== "undefined" ? navigator : {});
const win = () => (typeof window !== "undefined" ? window : {});

export function isIOS() {
  const n = nav();
  const ua = String(n.userAgent || "");
  return /iPhone|iPad|iPod/.test(ua) || (n.platform === "MacIntel" && Number(n.maxTouchPoints) > 1);
}

export function isStandalone() {
  const n = nav();
  if (n.standalone === true) return true;
  try {
    return Boolean(win().matchMedia?.("(display-mode: standalone)")?.matches);
  } catch {
    return false;
  }
}

// → {ok:true} | {ok:false, reason: "ios-browser" | "insecure" | "unsupported"}
export function pushSupport() {
  if (isIOS() && !isStandalone()) return { ok: false, reason: "ios-browser" };
  const w = win();
  if (w.isSecureContext === false) return { ok: false, reason: "insecure" };
  if (!("serviceWorker" in nav()) || typeof w.PushManager === "undefined" || typeof w.Notification === "undefined") {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: true };
}

export function permission() {
  return typeof win().Notification !== "undefined" ? win().Notification.permission : "default";
}

// App boot: the worker must exist before a push arrives and for the
// notification tap. Never throws.
export async function registerServiceWorker() {
  try {
    if (!("serviceWorker" in nav())) return null;
    return await nav().serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  } catch {
    return null;
  }
}

// The tap of a notification while a window is open: the worker posts
// {type:"zai.open", url:"/zai/#/chat/<id>"} and the app switches the hash.
// The worker also asks «which chat is in front?» before showing a push
// (Client.url misses hash navigations — BUG-150): answered on the port.
export function listenServiceWorker() {
  try {
    const sw = nav().serviceWorker;
    sw?.addEventListener?.("message", (e) => {
      const d = e?.data;
      if (d?.type === "zai.which-chat") {
        e.ports?.[0]?.postMessage({ chat: chatInFront() });
        return;
      }
      if (d?.type !== "zai.open" || typeof d.url !== "string") return;
      const hash = d.url.slice(d.url.indexOf("#"));
      if (d.url.startsWith("/zai/") && hash.startsWith("#/") && location.hash !== hash) location.hash = hash;
    });
    // addEventListener («message») does not start the queue by itself.
    sw?.startMessages?.();
  } catch {}
}

async function registration() {
  const sw = nav().serviceWorker;
  const reg = (await sw.getRegistration?.(SW_SCOPE)) || (await registerServiceWorker());
  if (!reg) throw Object.assign(new Error("sw"), { code: "sw" });
  return sw.ready ? await sw.ready : reg;
}

export function keyBytes(b64u) {
  const s = String(b64u).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(sub, keyB64u) {
  try {
    const k = sub?.options?.applicationServerKey;
    if (!k) return true; // unknown → keep
    const a = new Uint8Array(k);
    const b = keyBytes(keyB64u);
    return a.length === b.length && a.every((x, i) => x === b[i]);
  } catch {
    return true;
  }
}

export async function currentSubscription() {
  try {
    const reg = await nav().serviceWorker?.getRegistration?.(SW_SCOPE);
    return (await reg?.pushManager?.getSubscription?.()) ?? null;
  } catch {
    return null;
  }
}

// → "on" | "off" | "denied" | "server-off" (+ the browser support reasons).
export async function pushState() {
  const sup = pushSupport();
  if (!sup.ok) return sup.reason;
  if (permission() === "denied") return "denied";
  const sub = await currentSubscription();
  let key;
  try {
    key = await api.pushKey(sub?.endpoint);
  } catch {
    return "server-off";
  }
  if (!key?.enabled) return "server-off";
  return sub && key.subscribed && permission() === "granted" ? "on" : "off";
}

// Must run straight from the tap: iOS grants the permission prompt only
// inside a user gesture, so requestPermission() is the first await.
export async function enablePush() {
  const perm = await win().Notification.requestPermission();
  if (perm !== "granted") throw Object.assign(new Error("denied"), { code: perm === "denied" ? "denied" : "dismissed" });
  const key = await api.pushKey().catch(() => null);
  if (!key?.enabled || !key.publicKey) throw Object.assign(new Error("server-off"), { code: "server-off" });
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key.publicKey)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key.publicKey) });
    } catch (err) {
      // «push service not available» / «Push API in incognito»: the browser's
      // own push service, not the portal.
      throw Object.assign(new Error(String(err?.message ?? err)), { code: "push-service" });
    }
  }
  await api.pushSubscribe(sub.toJSON());
  return "on";
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return "off";
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => {});
  return "off";
}

export const testPush = () => api.pushTest();

// ---- presence: «this chat is in front of me» -------------------------------

let presenceTimer = null;
let lastSent = null;

export function chatInFront() {
  if (typeof document === "undefined") return null;
  if (document.visibilityState === "hidden") return null;
  if (typeof document.hasFocus === "function" && !document.hasFocus()) return null;
  const m = /^#\/chat\/([^/?#]+)/.exec(String(location.hash || ""));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

async function reportPresence(force = false) {
  const chat = chatInFront();
  if (!force && chat === lastSent && chat === null) return;
  const sub = await currentSubscription();
  if (!sub) return;
  lastSent = chat;
  api.pushPresence(sub.endpoint, chat).catch(() => {});
}

// Every 30 s while a chat is in front, and at once on hash/focus/visibility changes.
export function startPresence() {
  if (presenceTimer || typeof addEventListener !== "function" || !pushSupport().ok) return;
  const now = () => void reportPresence(true);
  for (const ev of ["hashchange", "focus", "blur", "pagehide"]) addEventListener(ev, now);
  document.addEventListener?.("visibilitychange", now);
  presenceTimer = setInterval(() => {
    if (chatInFront()) void reportPresence(true);
  }, 30_000);
  now();
}
