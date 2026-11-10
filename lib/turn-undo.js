// FEAT-01.57 / FEAT-01.58: the Claude side of «Изменить», «Сгенерировать
// заново» and «Отменить ход».
//
// 1. File backups of a turn (TurnUndo). The runner gives the claude CLI a
//    PreToolUse hook (lib/turn-undo-hook.mjs) on Write|Edit|MultiEdit|
//    NotebookEdit; it keeps the state of every file before its first change
//    in data/turn-undo/<sid>/<turnId>/. Undo restores the copies and deletes
//    the files the turn created; «Вернуть» puts the turn's result back.
//    Changes made by shell commands are NOT tracked (the user is told so).
//    Only the LAST turn of a chat can be undone: a new turn drops the
//    backups of the previous ones; lib/gc.js sweeps what chats left behind.
//
// 2. The CLI transcript cut (transcript helpers). A turn records where the
//    CLI history stood before it ({claudeSid, bytes}); rewinding copies the
//    transcript (~/.claude/projects/<slug cwd>/<claudeSid>.jsonl) up to
//    that point into a new file and the next turn runs
//    `--resume <copy> --fork-session` — the model never sees the dropped
//    turn (spike 2026-11-04, CLI 2.1.316: the cut copy resumes, the fork gets
//    a new self-contained session file).
//
// Zero dependencies.
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordKey } from "./turn-undo-hook.mjs";

export const HOOK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "turn-undo-hook.mjs");
export const HOOK_MATCHER = "Write|Edit|MultiEdit|NotebookEdit";

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const fwd = (p) => String(p).replace(/\\/g, "/");

function hashOf(file) {
  try {
    return createHash("sha1").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isInside(file, dir) {
  const rel = path.relative(path.resolve(dir).toLowerCase(), path.resolve(file).toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export class TurnUndo {
  // root: data/turn-undo. nodePath/hookPath: what the hook command runs.
  constructor({ root, nodePath = process.execPath, hookPath = HOOK_PATH } = {}) {
    this.root = root;
    this.nodePath = nodePath;
    this.hookPath = hookPath;
  }

  dirOf(sid, turnId) {
    if (!this.root || !SAFE.test(String(sid)) || !SAFE.test(String(turnId))) return null;
    return path.join(this.root, sid, turnId);
  }

  // The `hooks` block for the CLI --settings of this turn (null = no undo).
  hookSettings(sid, turnId) {
    const dir = this.dirOf(sid, turnId);
    if (!dir) return null;
    const command = `"${fwd(this.nodePath)}" "${fwd(this.hookPath)}" "${fwd(dir)}"`;
    return { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command }] }] };
  }

  // A new turn starts: its folder exists, every older turn of the chat is
  // no longer undoable (only the last turn is).
  startTurn(sid, turnId) {
    const dir = this.dirOf(sid, turnId);
    if (!dir) return null;
    try {
      for (const name of readdirSync(path.join(this.root, sid))) {
        if (name !== turnId) rmSync(path.join(this.root, sid, name), { recursive: true, force: true });
      }
    } catch {}
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
    return dir;
  }

  // Complete records of a turn: [{key, path, existed, skipped?, after?}].
  records(sid, turnId) {
    const dir = this.dirOf(sid, turnId);
    if (!dir) return [];
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      const m = /^([0-9a-f]{20})\.json$/.exec(n);
      if (!m) continue;
      const r = readJson(path.join(dir, n));
      if (!r?.complete || typeof r.path !== "string") continue;
      out.push({ ...r, key: m[1], after: readJson(path.join(dir, `${m[1]}.after.json`)) });
    }
    return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  }

  // The turn ended: remember what it left in every file — undo refuses to
  // clobber a file changed after the turn (by a person or another chat).
  seal(sid, turnId) {
    const dir = this.dirOf(sid, turnId);
    for (const r of this.records(sid, turnId)) {
      const exists = existsSync(r.path);
      try {
        writeFileSync(path.join(dir, `${r.key}.after.json`), JSON.stringify({ exists, hash: exists ? hashOf(r.path) : null }));
      } catch {}
    }
  }

  // What undo would do: [{path, action: "restore"|"delete", skipped?}].
  // Unchanged files are left out. within(path) → false hides a record
  // (a tenant sees only its own folder).
  preview(sid, turnId, { within = null } = {}) {
    return this.#plan(sid, turnId, within).map(({ path: p, action, skipped }) => ({ path: p, action, ...(skipped ? { skipped } : {}) }));
  }

  #plan(sid, turnId, within) {
    const dir = this.dirOf(sid, turnId);
    const out = [];
    for (const r of this.records(sid, turnId)) {
      if (within && !within(r.path)) continue;
      const action = r.existed ? "restore" : "delete";
      if (r.skipped) {
        out.push({ ...r, action, skipped: r.skipped });
        continue;
      }
      const exists = existsSync(r.path);
      const now = exists ? hashOf(r.path) : null;
      const before = r.existed ? hashOf(path.join(dir, `${r.key}.bak`)) : null;
      if (exists === Boolean(r.existed) && now === before) continue; // unchanged
      if (r.after && (r.after.exists !== exists || (exists && r.after.hash !== now))) {
        out.push({ ...r, action, skipped: "changed-after" });
        continue;
      }
      out.push({ ...r, action });
    }
    return out;
  }

  // Undo: the result of the turn is kept for «Вернуть», then every file
  // gets its state before the turn. → {files: [{path, action}], skipped}.
  revert(sid, turnId, { within = null } = {}) {
    const dir = this.dirOf(sid, turnId);
    const files = [];
    const skipped = [];
    for (const r of this.#plan(sid, turnId, within)) {
      if (r.skipped) {
        skipped.push({ path: r.path, action: r.action, skipped: r.skipped });
        continue;
      }
      try {
        const exists = existsSync(r.path);
        if (exists) copyFileSync(r.path, path.join(dir, `${r.key}.redo`));
        writeFileSync(path.join(dir, `${r.key}.redo.json`), JSON.stringify({ path: r.path, existed: exists }));
        if (r.existed) {
          mkdirSync(path.dirname(r.path), { recursive: true });
          copyFileSync(path.join(dir, `${r.key}.bak`), r.path);
        } else if (exists) unlinkSync(r.path);
        files.push({ path: r.path, action: r.action });
      } catch (err) {
        skipped.push({ path: r.path, action: r.action, skipped: "error", error: err?.code ?? String(err?.message ?? err) });
      }
    }
    return { files, skipped };
  }

  // «Вернуть»: the files get the turn's result back.
  unrevert(sid, turnId) {
    const dir = this.dirOf(sid, turnId);
    const files = [];
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return { files };
    }
    for (const n of names) {
      const m = /^([0-9a-f]{20})\.redo\.json$/.exec(n);
      if (!m) continue;
      const r = readJson(path.join(dir, n));
      if (typeof r?.path !== "string" || recordKey(r.path) !== m[1]) continue;
      try {
        if (r.existed) {
          mkdirSync(path.dirname(r.path), { recursive: true });
          copyFileSync(path.join(dir, `${m[1]}.redo`), r.path);
        } else if (existsSync(r.path)) unlinkSync(r.path);
        files.push({ path: r.path });
        rmSync(path.join(dir, `${m[1]}.redo`), { force: true });
        rmSync(path.join(dir, n), { force: true });
      } catch {}
    }
    return { files };
  }

  drop(sid, turnId) {
    const dir = this.dirOf(sid, turnId);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  forget(sid) {
    if (this.root && SAFE.test(String(sid))) rmSync(path.join(this.root, sid), { recursive: true, force: true });
  }
}

export { isInside };

// --- the CLI transcript -----------------------------------------------------

// ~/.claude/projects (CLAUDE_CONFIG_DIR moves it, like the CLI does).
export function projectsRoot(env = process.env) {
  const cfg = env?.CLAUDE_CONFIG_DIR;
  return cfg ? path.join(cfg, "projects") : path.join(os.homedir(), ".claude", "projects");
}

// The CLI's folder name for a working directory: every non-alphanumeric
// character becomes «-» (D:\zai-stage\tmp → D--zai-stage-tmp).
export const slugOf = (dir) => String(dir ?? "").replace(/[^A-Za-z0-9]/g, "-");

// The transcript file of a CLI session, or null: the cwd's folder first,
// then any project folder (a chat whose folder was renamed).
export function findTranscript(root, dir, claudeSid) {
  if (!root || !SAFE.test(String(claudeSid ?? ""))) return null;
  const first = path.join(root, slugOf(dir), `${claudeSid}.jsonl`);
  if (existsSync(first)) return first;
  try {
    for (const d of readdirSync(root)) {
      const f = path.join(root, d, `${claudeSid}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch {}
  return null;
}

export function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

// A real prompt of the person (not a tool result, not a CLI meta line, not a
// subagent's).
function isPromptLine(e) {
  if (e?.type !== "user" || e.isMeta || e.isSidechain) return false;
  const c = e.message?.content;
  if (typeof c === "string") return true;
  return Array.isArray(c) && c.length > 0 && !c.some((b) => b?.type === "tool_result");
}

// Byte offset of the start of the last prompt (and the queue lines right in
// front of it) — the cut for a turn recorded before FEAT-01.57. null = none.
export function lastPromptOffset(buf) {
  let off = 0;
  let cut = null;
  let lead = null; // start of a run of queue-operation lines
  for (const raw of buf.toString("utf8").split("\n")) {
    const len = Buffer.byteLength(raw, "utf8") + 1;
    let e = null;
    try {
      e = raw.trim() ? JSON.parse(raw) : null;
    } catch {}
    if (e?.type === "queue-operation") lead ??= off;
    else if (e) {
      if (isPromptLine(e)) cut = lead ?? off;
      lead = null;
    }
    off += len;
  }
  return cut;
}

// Copy of a transcript cut at `bytes` (null → before its last prompt) under
// a fresh session id in the cwd's project folder. → {resume, file} | null.
export function cutCopy({ root, dir, from, bytes = null }) {
  const src = findTranscript(root, dir, from);
  if (!src) return null;
  let buf;
  try {
    buf = readFileSync(src);
  } catch {
    return null;
  }
  const n = Number.isFinite(bytes) && bytes >= 0 ? Math.min(bytes, buf.length) : lastPromptOffset(buf);
  if (n == null) return null;
  const id = randomUUID();
  const outDir = path.join(root, slugOf(dir));
  const file = path.join(outDir, `${id}.jsonl`);
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(file, buf.subarray(0, n));
  } catch {
    return null;
  }
  return { resume: id, file };
}
