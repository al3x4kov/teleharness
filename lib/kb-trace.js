// BUG-177 (2026-11-05): device trace of the iOS keyboard transition. The owner's
// iPhone records per-frame visualViewport / scroll / layout numbers for ~1,5 s
// after focus/blur of the composer and posts them here; we store them as JSON
// lines in <logDir>/kb-trace-YYYYMMDD.jsonl (no message text — numbers only).
// Admin only, at most MAX_PER_DAY traces a day, at most MAX_BYTES per trace.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const MAX_PER_DAY = 50;
export const MAX_BYTES = 128 * 1024;

const day = (now = new Date()) => now.toISOString().slice(0, 10).replace(/-/g, "");

// → { status, error? }. trace: { kind, ver, ua, frames: [...], events: [...] }
export function storeKbTrace(logDir, trace, { now = new Date() } = {}) {
  if (!trace || typeof trace !== "object" || !Array.isArray(trace.frames)) return { status: 400, error: "bad trace" };
  const line = JSON.stringify({ at: now.toISOString(), ...trace });
  if (Buffer.byteLength(line) > MAX_BYTES) return { status: 413, error: "trace too large" };
  mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `kb-trace-${day(now)}.jsonl`);
  const count = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  if (count >= MAX_PER_DAY) return { status: 429, error: "daily trace limit" };
  appendFileSync(file, line + "\n");
  return { status: 204 };
}
