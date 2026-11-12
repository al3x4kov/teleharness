// Run-state bookkeeping (TASK-12.29): <dataDir>/run-state.json remembers
// whether the previous run of the portal ended cleanly.
//   markStarted()  — on boot: {pid, startedAt, clean:false};
//   markClean()    — on a graceful stop (SIGINT/SIGTERM): clean:true;
//   readPrevious() — on boot: a file with clean:false means the previous run
//                    was killed or died on uncaughtException (the handler
//                    deliberately does NOT mark clean) → log + owner push.
// No file = no crash (first boot or wiped data). A corrupt file is treated
// as "no evidence": writeJsonAtomic makes half-written files impossible, so
// garbage means external tampering, not a crash.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./json-store.js";

const stateFile = (dataDir) => path.join(dataDir, "run-state.json");

export function readPrevious(dataDir) {
  const f = stateFile(dataDir);
  if (!existsSync(f)) return { crashed: false, startedAt: null, pid: null };
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(f, "utf8"));
  } catch {}
  if (!raw || typeof raw !== "object") return { crashed: false, startedAt: null, pid: null };
  return {
    crashed: raw.clean !== true,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    pid: Number.isFinite(raw.pid) ? raw.pid : null,
  };
}

export function markStarted(dataDir) {
  writeJsonAtomic(stateFile(dataDir), { pid: process.pid, startedAt: new Date().toISOString(), clean: false });
}

// Keeps startedAt of this run (set by markStarted) so healthz/log timelines
// stay continuous; pid follows the writer.
export function markClean(dataDir) {
  const prev = readPrevious(dataDir);
  writeJsonAtomic(stateFile(dataDir), {
    pid: process.pid,
    startedAt: prev.startedAt ?? new Date().toISOString(),
    clean: true,
  });
}
