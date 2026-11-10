// Live stream + connection face + resync (BUG-07.11, R-20, ADR-005).
import { api, onEpoch, onReachable, openEvents } from "../api.js";
import { active, connection, dialogs, sessions } from "./state.js";
import { handleEvent } from "./events.js";
import { seedDialogs } from "./dialogs.js";
import { mergeSessionList } from "../normalize.js";
import { pollBusy, refreshMessages } from "./session.js";

// SSE errors shorter than this are normal reconnects — no offline bar.
const OFFLINE_GRACE_MS = 3000;
const RESTORED_FLASH_MS = 4000;

let stream = null;
let offlineTimer = null;
let restoredTimer = null;
let windowHooks = false;

function markOffline() {
  clearTimeout(offlineTimer);
  offlineTimer = null;
  if (connection.value.state !== "offline") connection.value = { state: "offline", restoredAt: null };
}

function markOnline() {
  // BUG-096: while the browser itself says «no network», a stray stream event
  // or a cached answer is not proof of life — no false «Связь восстановлена».
  if (globalThis.navigator?.onLine === false) return;
  clearTimeout(offlineTimer);
  offlineTimer = null;
  if (connection.value.state === "offline") {
    const at = Date.now();
    connection.value = { state: "online", restoredAt: at };
    clearTimeout(restoredTimer);
    restoredTimer = setTimeout(() => {
      if (connection.value.restoredAt === at) connection.value = { state: "online", restoredAt: null };
    }, RESTORED_FLASH_MS);
    restoredTimer?.unref?.();
  }
}

// The stream status callback (exported for tests).
export function onStreamStatus(status) {
  if (status === "open") {
    markOnline();
    return;
  }
  // error/closed: a blip is normal (proxy idle, browser reconnect) — the bar
  // shows only when the stream stays down past the grace window.
  if (!offlineTimer && connection.value.state !== "offline") {
    offlineTimer = setTimeout(markOffline, OFFLINE_GRACE_MS);
    offlineTimer?.unref?.();
  }
  if (status === "closed") {
    // A CLOSED stream may be a 401 (token revoked/overwritten): /auth/me
    // tells; on 401 the api hook drops to the login screen and we stop.
    api.me().catch((err) => {
      if (err?.status === 401) closeEventStream();
    });
  }
}

// Server epoch bookkeeping, per source (SSE ids vs the x-zai-epoch header):
// a change means the portal restarted → refetch everything.
const knownEpoch = {};
export function noteEpoch(epoch, source = "sse") {
  if (!epoch) return;
  const prev = knownEpoch[source];
  knownEpoch[source] = epoch;
  if (prev && prev !== epoch) resync();
}
onEpoch(noteEpoch);

// ISSUE-004: the bar used to drop only on the EventSource `open` — a stream
// that survived the blip never re-opens, so the bar hung for minutes over a
// live chat. ANY proof of life clears it: a live event, a successful API
// answer, the browser's `online`.
export function noteAlive() {
  markOnline();
}
onReachable(noteAlive);

function onLiveEvent(evt) {
  markOnline();
  handleEvent(evt);
}

// window «online»: the network is back — drop the bar and replace a stream
// that is not open right away (no waiting for the backoff timer).
export function onBrowserOnline() {
  markOnline();
  stream?.reconnectNow?.();
}

export function installEventStream() {
  // No-op outside browsers (node has no EventSource): node consumers drive
  // handleEvent directly.
  if (stream || typeof globalThis.EventSource !== "function") return;
  stream = openEvents({ onEvent: onLiveEvent, onResync: () => resync(), onStatus: onStreamStatus, onEpoch: noteEpoch });
  if (!windowHooks && typeof globalThis.addEventListener === "function") {
    windowHooks = true;
    globalThis.addEventListener("offline", markOffline);
    globalThis.addEventListener("online", onBrowserOnline);
  }
}

export function closeEventStream() {
  stream?.close();
  stream = null;
}

async function refreshSessionList() {
  try {
    sessions.value = mergeSessionList(sessions.value, (await api.listSessions()) ?? []); // BUG-088
  } catch {}
}

// Full refetch after a reconnect / server epoch change / zai.resync.
// Coalesced: bursts (reconnect + resync frame + epoch) run at most twice.
let resyncing = null;
let resyncAgain = false;

export function resync() {
  if (resyncing) {
    resyncAgain = true;
    return resyncing;
  }
  resyncing = (async () => {
    do {
      resyncAgain = false;
      await doResync();
    } while (resyncAgain);
  })().finally(() => {
    resyncing = null;
  });
  return resyncing;
}

async function doResync() {
  await Promise.all([
    refreshSessionList(),
    seedDialogs(), // a reconnect may have missed .asked events
    active.value ? refreshMessages(active.value.id) : Promise.resolve(),
  ]);
  await pollBusy(); // status truth both ways (missed session.idle)
  // Stale-dialog guard (merge-only seed never drops): a dialog whose session
  // no longer exists can never be answered — it would keep the blocking
  // backdrop over the whole portal until a reload («страница темнее и ничего
  // нельзя нажать», user report 2026-10-31). Skip the sweep when the sessions
  // fetch failed — an empty list must not wipe live dialogs.
  if (sessions.value.length > 0) {
    const ids = new Set(sessions.value.map((s) => s.id));
    dialogs.value = dialogs.value.filter((d) => !d.sessionID || ids.has(d.sessionID));
  }
}
