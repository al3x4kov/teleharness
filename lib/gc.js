// Server-side garbage report (TASK-12.22). DRY-RUN ONLY: planGc() reads and
// lists, it never deletes. Pure apart from read-only fs calls.
//
// Candidates:
//   - orphanBindings: session-bindings.json records whose session no longer
//     exists upstream;
//   - orphanClaude: claude-sessions.json histories without an upstream session;
//   - staleUploads: files in <session dir>/.zai-uploads older than N days;
//   - emptyChats: NOT computed here — the dry-run report uses the very same
//     rule and threshold as the APPLY sweep (runEmptyChatGc with dryRun:true,
//     ZAI_GC_EMPTY_MIN), so the report never disagrees with what POST deletes.
//
// APPLY mode exists for exactly two categories (bugfix-1.7.2):
//   - empty chats (BUG-01.48 / BUG-078): selectEmptyChats() + an async
//     message-count confirm in runEmptyChatGc() — only sessions with NO
//     message at all, a default title, older than ZAI_GC_EMPTY_MIN, not busy,
//     no open dialog, not a claude chat;
//   - tenant folders that could not be removed when the account was deleted
//     (BUG-04.6 / BUG-077): retryPendingRemovals().
// Everything else stays dry-run.
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pathKey } from "./paths.js";
import { isDefaultTitle } from "../shared/title.js";
import { readJsonStore, writeJsonAtomic } from "./json-store.js";

const UPLOAD_DIR = ".zai-uploads";

function readKeys(file, field) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const obj = raw?.[field];
    return obj && typeof obj === "object" ? Object.keys(obj) : [];
  } catch {
    return [];
  }
}

export function planGc({ sessions = [], bindingsFile, claudeFile, uploadMaxAgeDays = 30, now = Date.now() } = {}) {
  const ids = new Set(sessions.map((s) => s?.id).filter((x) => typeof x === "string"));
  const orphanBindings = bindingsFile ? readKeys(bindingsFile, "sessions").filter((id) => !ids.has(id)) : [];
  const orphanClaude = claudeFile ? readKeys(claudeFile, "sessions").filter((id) => !ids.has(id)) : [];

  const dirs = [...new Set(sessions.map((s) => s?.directory).filter((d) => typeof d === "string" && d))];
  const cutoff = now - uploadMaxAgeDays * 86_400_000;
  const staleUploads = [];
  for (const d of dirs) {
    const up = path.join(d, UPLOAD_DIR);
    let names = [];
    try {
      names = readdirSync(up);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const st = statSync(path.join(up, name));
        if (st.isFile() && st.mtimeMs < cutoff) staleUploads.push({ path: path.join(up, name), size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
      } catch {}
    }
  }

  return {
    orphanBindings,
    orphanClaude,
    staleUploads,
    staleUploadBytes: staleUploads.reduce((n, f) => n + f.size, 0),
  };
}

// ---- empty chats: APPLY (BUG-01.48 / BUG-078) ---------------------------------

const ms = (t) => {
  const n = Number(t);
  if (!Number.isFinite(n)) return NaN;
  return n < 1e12 ? n * 1000 : n;
};

// Pure first pass over the upstream session list: candidates that MAY be
// deleted (the message-count confirm happens in runEmptyChatGc).
//   busy / dialogs / claude: Set<sessionID> to protect.
export function selectEmptyChats({ sessions = [], minAgeMs, now = Date.now(), busy = new Set(), dialogs = new Set(), claude = new Set() } = {}) {
  if (!(minAgeMs > 0)) return [];
  const cut = now - minAgeMs;
  const out = [];
  for (const s of sessions) {
    if (typeof s?.id !== "string" || s.parentID) continue;
    if (!isDefaultTitle(s.title)) continue;
    const created = ms(s.time?.created);
    if (!Number.isFinite(created) || created > cut) continue;
    const updated = ms(s.time?.updated ?? s.time?.created);
    if (Number.isFinite(updated) && updated > cut) continue; // touched recently
    if (busy.has(s.id) || dialogs.has(s.id) || claude.has(s.id)) continue;
    out.push({ id: s.id, directory: s.directory ?? null, created: new Date(created).toISOString() });
  }
  return out;
}

// One sweep: candidates → confirm «no message at all» upstream → delete.
// Dependencies are injected (server.js wires the real ones):
//   countMessages(id, dir) → number | null (null = unknown → keep)
//   isBusy(id) → bool (re-checked right before the delete)
//   deleteSession(id, dir) → bool
// Returns {checked, deleted: [ids], kept: [{id, reason}]}.
// dryRun: same selection + same message-count confirm, but nothing is deleted;
// the would-be deletions come back as `wouldDelete: [{id, directory, created}]`
// (the GET /admin/gc report — one rule, one threshold for report and sweep).
export async function runEmptyChatGc({ sessions, minAgeMs, now = Date.now(), busy, dialogs, claude, countMessages, isBusy = () => false, deleteSession, dryRun = false, log = () => {} } = {}) {
  const cand = selectEmptyChats({ sessions, minAgeMs, now, busy, dialogs, claude });
  const deleted = [];
  const kept = [];
  const wouldDelete = [];
  for (const c of cand) {
    let n = null;
    try {
      n = await countMessages(c.id, c.directory);
    } catch {}
    if (n !== 0) {
      kept.push({ id: c.id, reason: n == null ? "unknown" : "has-messages" });
      continue;
    }
    if (isBusy(c.id)) {
      kept.push({ id: c.id, reason: "busy" });
      continue;
    }
    if (dryRun) {
      wouldDelete.push(c);
      continue;
    }
    let ok = false;
    try {
      ok = await deleteSession(c.id, c.directory);
    } catch {}
    if (ok) {
      deleted.push(c.id);
      log(`[zai-gc] deleted empty chat ${c.id} (${c.directory ?? "-"}, created ${c.created})`);
    } else kept.push({ id: c.id, reason: "delete-failed" });
  }
  return dryRun ? { checked: cand.length, deleted, kept, wouldDelete } : { checked: cand.length, deleted, kept };
}

// ---- tenant folders left behind (BUG-04.6 / BUG-077) ---------------------------

// data/pending-removals.json: [{path, userId, reason, since, attempts}].
export class PendingRemovals {
  #file;
  #list;

  constructor(file) {
    this.#file = file;
    const raw = file
      ? readJsonStore(file, { fallback: () => ({ version: 1, items: [] }), validate: (r) => Boolean(r && Array.isArray(r.items)) })
      : { version: 1, items: [] };
    this.#list = raw.items.filter((x) => typeof x?.path === "string" && x.path);
  }

  list() {
    return this.#list.map((x) => ({ ...x }));
  }

  add(items) {
    for (const it of items ?? []) {
      if (typeof it?.path !== "string" || !it.path) continue;
      const cur = this.#list.find((x) => pathKey(x.path) === pathKey(it.path));
      if (cur) Object.assign(cur, { reason: it.reason ?? cur.reason });
      else this.#list.push({ path: it.path, userId: it.userId ?? null, reason: it.reason ?? null, since: new Date().toISOString(), attempts: 0 });
    }
    this.#flush();
  }

  // Retry every pending folder. isReferenced(path) → true when a CURRENT
  // user owns it again (a recreated account): dropped, never deleted.
  // beforeRemove(path) → optional async hook (opencode instance dispose).
  async retry({ isReferenced = () => false, beforeRemove = null, rm = (p) => rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }), log = () => {} } = {}) {
    const removed = [];
    const left = [];
    const next = [];
    for (const it of this.#list) {
      if (isReferenced(it.path)) {
        log(`[zai-gc] pending removal dropped (owned again): ${it.path}`);
        continue;
      }
      let st = null;
      try {
        st = lstatSync(it.path);
      } catch {}
      if (!st || !existsSync(it.path)) {
        removed.push(it.path); // already gone
        continue;
      }
      if (!st.isDirectory() || st.isSymbolicLink()) {
        log(`[zai-gc] pending removal dropped (not a plain directory): ${it.path}`);
        continue;
      }
      try {
        if (beforeRemove) await beforeRemove(it.path);
      } catch {}
      try {
        rm(it.path);
        if (existsSync(it.path)) throw new Error("still exists after removal");
        removed.push(it.path);
        log(`[zai-gc] removed leftover tenant folder ${it.path}`);
      } catch (err) {
        const reason = `${err?.code ?? "ERR"}: ${err?.message ?? err}`;
        next.push({ ...it, attempts: (it.attempts ?? 0) + 1, reason, lastTry: new Date().toISOString() });
        left.push({ path: it.path, reason });
      }
    }
    const changed = next.length !== this.#list.length || removed.length > 0 || left.length > 0;
    this.#list = next;
    if (changed) this.#flush();
    return { removed, left };
  }

  #flush() {
    if (this.#file) writeJsonAtomic(this.#file, { version: 1, items: this.#list });
  }
}

// ---- ownerless tenant folders (BUG-089) ----------------------------------------
// Direct subfolders of ZAI_TENANT_HOME that no current account references
// (probe/smoke accounts deleted by hand, kcprobe*, smokecheck). Reported by the
// dry-run; the APPLY sweep removes only those with NO file anywhere inside
// (empty subfolders allowed), no chat folder in them, older than minAgeMs —
// via rmdir bottom-up, which can never delete a file.
function scanTree(dir, depth = 0) {
  let files = 0;
  let latest = 0;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files: 1, latest: Date.now() }; // unreadable → treat as non-empty
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink() && depth < 32) {
      const sub = scanTree(p, depth + 1);
      files += sub.files;
      latest = Math.max(latest, sub.latest);
    } else files += 1;
  }
  try {
    latest = Math.max(latest, statSync(dir).mtimeMs);
  } catch {}
  return { files, latest };
}

// TASK-17.1: ключ сравнения папок — регистр учитывается на Linux (pathKey, lib/paths.js)
const lowerWin = (p) => pathKey(p);
const SEP = process.platform === "win32" ? "\\" : "/";

export function findOwnerlessTenantDirs({ home, isReferenced = () => true, sessionDirs = [], minAgeMs = 3_600_000, now = Date.now() } = {}) {
  if (!home || !existsSync(home)) return [];
  let entries = [];
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const chats = (sessionDirs ?? []).filter((d) => typeof d === "string" && d).map(lowerWin);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const p = path.join(home, e.name);
    if (isReferenced(p)) continue;
    const n = lowerWin(p);
    const hasChats = chats.some((c) => c === n || c.startsWith(n + SEP));
    const { files, latest } = scanTree(p);
    const old = now - latest >= minAgeMs;
    out.push({ path: p, files, hasChats, modified: latest ? new Date(latest).toISOString() : null, removable: files === 0 && !hasChats && old });
  }
  return out;
}

// rmdir bottom-up: only empty folders go; a file anywhere → throws ENOTEMPTY.
export function removeEmptyTree(dir, depth = 0) {
  if (depth > 32) throw new Error("too deep");
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink()) throw Object.assign(new Error(`not empty: ${e.name}`), { code: "ENOTEMPTY" });
    removeEmptyTree(path.join(dir, e.name), depth + 1);
  }
  rmdirSync(dir);
}

export async function sweepOwnerlessTenantDirs(candidates, { beforeRemove = null, remove = removeEmptyTree, log = () => {} } = {}) {
  const removed = [];
  const left = [];
  for (const c of candidates ?? []) {
    if (!c?.removable) continue;
    try {
      if (beforeRemove) await beforeRemove(c.path);
    } catch {}
    try {
      remove(c.path);
      removed.push(c.path);
      log(`[zai-gc] removed ownerless empty tenant folder ${c.path}`);
    } catch (err) {
      left.push({ path: c.path, reason: `${err?.code ?? "ERR"}: ${err?.message ?? err}` });
    }
  }
  return { removed, left };
}

// FEAT-01.58: file backups of Claude turns (data/turn-undo/<sid>/<turnId>/).
// Only the last turn of a chat is undoable and the runner drops older turns
// itself; this sweep removes what is left: folders of chats the runner no
// longer knows (deleted chats) and turns older than maxAgeMs (an old last
// turn nobody will undo). keep: Set of live chat ids. → {removed: [path]}.
export function sweepTurnUndo({ root, keep = new Set(), maxAgeMs = 14 * 86_400_000, now = Date.now(), log = () => {} } = {}) {
  const removed = [];
  let sids = [];
  try {
    sids = readdirSync(root);
  } catch {
    return { removed };
  }
  const drop = (p) => {
    try {
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch (err) {
      log(`[zai-gc] turn-undo ${p}: ${err?.code ?? err?.message ?? err}`);
    }
  };
  for (const sid of sids) {
    const dir = path.join(root, sid);
    if (!keep.has(sid)) {
      drop(dir);
      continue;
    }
    let turns = [];
    try {
      turns = readdirSync(dir);
    } catch {}
    for (const t of turns) {
      try {
        if (now - statSync(path.join(dir, t)).mtimeMs > maxAgeMs) drop(path.join(dir, t));
      } catch {}
    }
  }
  if (removed.length > 0) log(`[zai-gc] turn-undo: removed ${removed.length} backup folder(s)`);
  return { removed };
}
