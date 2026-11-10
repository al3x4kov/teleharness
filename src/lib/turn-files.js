// BUG-092 (BUG-05.18): which files the agent made or changed in the chat
// folder during each CLOSED turn — asked from the server by turn time windows
// (GET /zai/api/turn-files), so a script-made file (python, bash, Claude or
// opencode alike) still becomes a file card (FEAT-05.17).
// turnFiles.value = { key, sid, byLast: Map(lastStepId → [abs paths]) | null }
// byLast null = not loaded / old server → MessageBubble keeps the text-based
// guessing it had before.
import { signal } from "@preact/signals";
import { api } from "./api.js";
import { buildTurns, parseTime } from "./normalize.js";

export const turnFiles = signal({ key: null, sid: null, byLast: null });
const MAX_WINDOWS = 300;

// Closed turns → [{ last, start, end }], oldest first, at most MAX_WINDOWS
// (the newest). start = the question (or first step), end = completion.
export function turnWindows(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const created = new Map(list.map((m) => [m?.info?.id, parseTime(m?.info?.time?.created)]));
  const seen = new Set();
  const out = [];
  for (const t of buildTurns(list).values()) {
    if (seen.has(t) || !t.closed || t.completedAt == null) continue;
    seen.add(t);
    const start = t.durationMs != null ? t.completedAt - t.durationMs : created.get(t.first);
    if (!Number.isFinite(start)) continue;
    out.push({ last: t.last, start, end: t.completedAt });
  }
  out.sort((a, b) => a.end - b.end);
  return out.slice(-MAX_WINDOWS);
}

let inflight = null;
export async function loadTurnFiles(sid, dir, messages, { fetcher = api.turnFiles } = {}) {
  if (!sid || !dir) return;
  const wins = turnWindows(messages);
  const key = `${sid}|${dir}|${wins.map((w) => `${w.last}:${w.end}`).join(",")}`;
  if (turnFiles.value.key === key || inflight === key) return;
  if (wins.length === 0) {
    turnFiles.value = { key, sid, byLast: new Map() };
    return;
  }
  inflight = key;
  try {
    const res = await fetcher(dir, wins.map((w) => [w.start, w.end]));
    if (inflight !== key) return;
    const byLast = new Map();
    wins.forEach((w, i) => byLast.set(w.last, Array.isArray(res?.files?.[i]) ? res.files[i] : []));
    turnFiles.value = { key, sid, byLast };
  } catch {
    if (inflight === key) turnFiles.value = { key, sid, byLast: null };
  } finally {
    if (inflight === key) inflight = null;
  }
}

// Files of this turn known to the server, or null (unknown → old behaviour).
export function serverFilesFor(sid, lastId) {
  const v = turnFiles.value;
  if (!lastId || v.sid !== sid || !v.byLast) return null;
  return v.byLast.get(lastId) ?? null;
}

// ISSUE-001 (dogfood прода 2026-11-03, BUG-094): the server picks files by
// modification time only, so in a shared folder (HOME) a file another chat or
// process wrote during this turn would become a card here. A server file is
// shown only when THIS turn names it — in its text, a tool's input, output or
// title (a script-made file the agent lists in its answer still qualifies).
export function turnHaystack(steps) {
  const out = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    for (const p of s?.parts ?? []) {
      if (!p) continue;
      if (typeof p.text === "string") out.push(p.text);
      const st = p.state;
      if (st) {
        if (st.input != null) out.push(typeof st.input === "string" ? st.input : JSON.stringify(st.input));
        if (typeof st.output === "string") out.push(st.output);
        if (typeof st.title === "string") out.push(st.title);
      }
    }
  }
  return out.join("\n").toLowerCase();
}

export function mentionedFiles(files, haystack) {
  const hay = String(haystack ?? "").toLowerCase();
  return (Array.isArray(files) ? files : []).filter((f) => {
    const name = String(f).split(/[\\/]/).pop().toLowerCase();
    return name.length > 0 && hay.includes(name);
  });
}
