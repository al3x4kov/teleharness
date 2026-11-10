// BUG-090 (BUG-05.16): a picture name only GUESSED from the answer text (or a
// command's arguments) is checked on the server BEFORE its <img> is inserted.
// A failed <img> load is logged by the browser as «Failed to load resource:
// 404» and cannot be silenced on the client — so an unconfirmed guessed
// picture never gets an <img> at all. Used while the server's per-turn file
// list (turn-files.js, closed turns only) is not known: a running turn, an
// old server.
//
// probed.value: Map("dir|path" lowercased → true | false). Unknown → no key.
// One batched GET /zai/api/file/exists per tick and folder; a failed request
// leaves the paths unknown (the card stays hidden, never a 404).
import { signal } from "@preact/signals";
import { api } from "./api.js";

export const probed = signal(new Map());
const MAX_BATCH = 100;
const keyOf = (dir, p) => `${String(dir ?? "").toLowerCase()}|${String(p ?? "").toLowerCase()}`;
const inflight = new Set();
let queue = new Map(); // dir → Set(paths)
let scheduled = false;

// true / false when the server answered, undefined while unknown.
export function probeState(dir, p) {
  return probed.value.get(keyOf(dir, p));
}

async function flush(fetcher) {
  scheduled = false;
  const jobs = queue;
  queue = new Map();
  for (const [dir, set] of jobs) {
    const all = [...set];
    for (let i = 0; i < all.length; i += MAX_BATCH) {
      const batch = all.slice(i, i + MAX_BATCH);
      try {
        const res = await fetcher(dir, batch);
        const next = new Map(probed.value);
        batch.forEach((p, k) => next.set(keyOf(dir, p), res?.exists?.[k] === true));
        probed.value = next;
      } catch {
        // unknown stays unknown: no card, no <img>, no 404
      } finally {
        for (const p of batch) inflight.delete(keyOf(dir, p));
      }
    }
  }
}

// Ask the server about the paths not known yet (deduplicated, batched).
export function requestProbe(dir, paths, { fetcher = api.filesExist } = {}) {
  if (!dir) return;
  for (const p of Array.isArray(paths) ? paths : []) {
    const k = keyOf(dir, p);
    if (!p || probed.value.has(k) || inflight.has(k)) continue;
    inflight.add(k);
    if (!queue.has(dir)) queue.set(dir, new Set());
    queue.get(dir).add(p);
  }
  if (!scheduled && queue.size > 0) {
    scheduled = true;
    queueMicrotask(() => flush(fetcher));
  }
}

// Tests: forget everything.
export function resetProbes() {
  probed.value = new Map();
  inflight.clear();
  queue = new Map();
  scheduled = false;
}
