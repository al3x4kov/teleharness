// Observability for server.js (ADR-007, TASK-12.20). Zero-dep.
//
//   accessLogger({dir, enabled}) → log(entry): one JSON line per request in
//     <dir>/access-YYYYMMDD.log; a file over 10 MB rolls to .1, .2 …; files
//     older than 14 days are pruned once per day. Never logs query strings,
//     cookies, tokens or bodies — the caller passes the bare path.
//   errLog(place, err): `[zai-err] <place>: <message>` on stderr, throttled
//     to one line per place per minute (a dead upstream must not flood).
import { appendFile, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP_DAYS = 14;

export function requestId() {
  return randomBytes(6).toString("hex");
}

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

export function accessLogger({ dir, enabled = true, prefix = "access", now = () => new Date() } = {}) {
  if (!enabled || !dir) return () => {};
  let ready = false;
  let prunedOn = "";
  let current = { day: "", file: "", size: 0, part: 0 };

  function prune(day) {
    if (prunedOn === day) return;
    prunedOn = day;
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(prefix + "-")) continue;
        const f = path.join(dir, name);
        try {
          if (statSync(f).mtimeMs < cutoff) unlinkSync(f);
        } catch {}
      }
    } catch {}
  }

  function target() {
    const day = ymd(now());
    if (current.day !== day) {
      current = { day, file: path.join(dir, `${prefix}-${day}.log`), size: 0, part: 0 };
      try {
        current.size = statSync(current.file).size;
      } catch {}
      prune(day);
    }
    if (current.size > MAX_BYTES) {
      current.part += 1;
      current.file = path.join(dir, `${prefix}-${day}.${current.part}.log`);
      try {
        current.size = statSync(current.file).size;
      } catch {
        current.size = 0;
      }
    }
    return current.file;
  }

  return function log(entry) {
    try {
      if (!ready) {
        mkdirSync(dir, { recursive: true });
        ready = true;
      }
      const line = JSON.stringify(entry) + "\n";
      const file = target();
      current.size += Buffer.byteLength(line);
      appendFile(file, line, () => {});
    } catch {}
  };
}

const lastErr = new Map();
export function errLog(place, err, { throttleMs = 60_000, now = Date.now() } = {}) {
  // TASK-12.29: engine failures are counted before throttling — the counter
  // measures failure frequency, the throttle only quiets the log line.
  if (UPSTREAM_PLACE_RE.test(place)) {
    upstreamTs.push(now);
    if (upstreamTs.length > UPSTREAM_TS_CAP) upstreamTs.shift();
  }
  if (now - (lastErr.get(place) ?? 0) < throttleMs) return;
  lastErr.set(place, now);
  const msg = err?.stack && /internal|handler/i.test(place) ? err.stack : (err?.message ?? String(err));
  console.error(`[zai-err] ${place}: ${msg}`);
}

// TASK-12.29: engine (opencode upstream) failure places — errLog calls that
// fire when a call to the engine itself fails: the proxy face of handleApi
// (upstreamError/ocUpstreamError pass the route as place), the metadata
// readers (session index, agent/command catalogs) and the turn machinery
// around the engine. Internal bookkeeping (gc, config, static) is not here.
const UPSTREAM_PLACE_RE = /^(upstream|message|prompt|abort|session\.|commandTurn|fetchSessionIndex|agentList|commandNames|captureResponse|prepareForPrompt|instanceHealth|instance\.dispose)/;

// Sliding 5-minute window of engine errors for healthz (`errors.upstream5m`).
// Timestamps only, hard cap so memory cannot grow without bound (the window
// itself prunes on read; healthz reads it on every probe).
const UPSTREAM_WINDOW_MS = 5 * 60_000;
const UPSTREAM_TS_CAP = 5000;
const upstreamTs = [];

export function upstreamErrors5m(now = Date.now()) {
  while (upstreamTs.length > 0 && now - upstreamTs[0] >= UPSTREAM_WINDOW_MS) upstreamTs.shift();
  return upstreamTs.length;
}

// The client IP as seen by the edge (ADR-009: the edge overwrites
// x-forwarded-for; server.js listens on loopback only, so the header is
// trusted). Direct loopback callers fall back to the socket address.
export function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return xff || req.socket?.remoteAddress || "";
}
