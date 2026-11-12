// Crash-safe JSON files for the portal's own stores (claude-sessions.json,
// claude-runs.json, session-bindings.json). BUG-13.6 / ARCH-R11: a plain
// writeFileSync left half a JSON on a crash, the loader then started EMPTY
// and the next write wiped every chat's history for good.
//
//   readJsonStore  - missing file → fallback; unreadable/corrupt file is
//                    MOVED aside to <file>.corrupt-<ts> (never overwritten),
//                    logged, and the fallback is returned; valid JSON that
//                    fails validate keeps the file and serves the fallback
//                    (SRV-27).
//   writeJsonAtomic - tmp file + rename (atomic replace on NTFS and POSIX),
//                    with a short retry for Windows sharing violations.
//
// Zero runtime dependencies - node stdlib only.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// validate(raw) → true when the parsed value has the expected shape.
export function readJsonStore(file, { fallback, validate = () => true, log = console.error } = {}) {
  if (!file || !existsSync(file)) return fallback();
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      renameSync(file, aside);
      log(`[zai-store] ${path.basename(file)} is corrupt — moved aside to ${path.basename(aside)}, starting empty`);
    } catch (err) {
      log(`[zai-store] ${path.basename(file)} is corrupt and could not be moved aside: ${err?.message ?? err}`);
    }
    return fallback();
  }
  // SRV-27: only UNPARSEABLE JSON is quarantined. A shape rejection (or a
  // validate throw) on valid JSON means a schema mismatch - keep the file
  // (data stay recoverable) and serve the fallback.
  let ok = false;
  let threw = null;
  try {
    ok = Boolean(validate(raw));
  } catch (err) {
    threw = err;
  }
  if (!ok) {
    log(
      threw
        ? `[zai-store] ${path.basename(file)} validate threw: ${threw?.message ?? threw} — starting empty, file kept`
        : `[zai-store] ${path.basename(file)} failed the shape check — starting empty, file kept`,
    );
    return fallback();
  }
  return raw;
}

// Returns true on success. Never throws: a failed write keeps the previous
// file intact (the tmp copy is dropped).
export function writeJsonAtomic(file, data, { log = console.error } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data), "utf8");
  } catch (err) {
    log(`[zai-store] write ${path.basename(file)} failed: ${err?.message ?? err}`);
    return false;
  }
  // A reader holding the target open (antivirus, backup, a concurrent read)
  // makes rename fail with EPERM/EBUSY on Windows for a few ms.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return true;
    } catch (err) {
      if (attempt < 5 && (err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES")) {
        sleepSync(20 * (attempt + 1));
        continue;
      }
      log(`[zai-store] replace ${path.basename(file)} failed: ${err?.message ?? err}`);
      try {
        rmSync(tmp, { force: true });
      } catch {}
      return false;
    }
  }
}

// TASK-13.27: async twin of writeJsonAtomic - tmp + rename with the same
// EPERM/EBUSY/EACCES retry, but an awaited pause instead of sleepSync, so a
// slow store never blocks the event loop. The payload is serialized at call
// time (before the first await): later mutations land in the next write.
export async function writeJsonAtomicAsync(file, data, { log = console.error } = {}) {
  const tmp = `${file}.${process.pid}.async.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(data), "utf8");
  } catch (err) {
    log(`[zai-store] write ${path.basename(file)} failed: ${err?.message ?? err}`);
    return false;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return true;
    } catch (err) {
      if (attempt < 5 && (err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES")) {
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        continue;
      }
      log(`[zai-store] replace ${path.basename(file)} failed: ${err?.message ?? err}`);
      try {
        await rm(tmp, { force: true });
      } catch {}
      return false;
    }
  }
}
