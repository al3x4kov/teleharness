// FEAT-01.58: the PreToolUse hook of a Claude turn. The runner passes the
// claude CLI `--settings` with this script on Write|Edit|MultiEdit|
// NotebookEdit:   node turn-undo-hook.mjs <backupDir>
// stdin: the hook payload ({cwd, tool_name, tool_input: {file_path |
// notebook_path}}). Before the tool touches a file, its FIRST state in this
// turn is kept: a copy (<key>.bak) and a record (<key>.json {path, existed,
// complete}); a file that did not exist is remembered as «created». A second
// edit of the same file in the same turn changes nothing (the record exists).
//
// Spike 2026-11-04 (CLI 2.1.316): the hook fires in print mode (-p) for the
// admin profile (bypassPermissions) and for the tenant one (--restricted,
// dontAsk at the time; acceptEdits since BUG-144) — with dontAsk the permission check then
// denies (the copy equals the file; undo skips unchanged files).
//
// Never blocks the tool: every failure is swallowed, exit code is always 0,
// nothing goes to stdout (stdout JSON would be read as a hook decision).
// Zero dependencies.
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bigger files are recorded but not copied: undo reports them as not undoable.
export const MAX_COPY_BYTES = 50 * 1024 * 1024;

export const recordKey = (abs) => createHash("sha1").update(String(abs).toLowerCase()).digest("hex").slice(0, 20);

// The file a tool call is about to change (absolute), or null.
export function targetOf(payload) {
  const input = payload?.tool_input ?? {};
  const raw = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
  if (!raw || !raw.trim()) return null;
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  return path.resolve(cwd, raw);
}

// Keep the state of `abs` before its first change in this turn.
export function backup(dir, abs) {
  mkdirSync(dir, { recursive: true });
  const key = recordKey(abs);
  const rec = path.join(dir, `${key}.json`);
  let fd;
  try {
    fd = openSync(rec, "wx"); // the lock: only the first call of the turn wins
  } catch {
    return false;
  }
  try {
    writeSync(fd, JSON.stringify({ path: abs, complete: false }));
  } finally {
    closeSync(fd);
  }
  let st = null;
  try {
    st = statSync(abs);
  } catch {}
  const out = { path: abs, existed: Boolean(st), complete: true, at: Date.now() };
  if (st && !st.isFile()) out.skipped = "not-a-file";
  else if (st && st.size > MAX_COPY_BYTES) out.skipped = "too-big";
  else if (st) copyFileSync(abs, path.join(dir, `${key}.bak`));
  writeFileSync(rec, JSON.stringify(out));
  return true;
}

function main() {
  const dir = process.argv[2];
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const abs = targetOf(payload);
      if (dir && abs) backup(dir, abs);
    } catch {}
    process.exit(0);
  });
  process.stdin.on("error", () => process.exit(0));
}

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] ?? "").toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
})();
if (isMain) main();
