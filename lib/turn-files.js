// BUG-092 (BUG-05.18): files an agent made or changed in the chat folder
// during a turn — whatever the way (write/edit, a python script, a shell
// command, subfolders), whichever the engine (opencode or Claude CLI).
// GET /zai/api/turn-files?directory=<dir>&w=<start>-<end>[,<start>-<end>…]
// → { files: [[abs, …], …] } — one list per turn window (ms since epoch),
// by modification time inside [start - SLACK_BEFORE, end + SLACK_AFTER].
// Stateless: the client derives windows from the turn's own timestamps, so
// old chats work too. A file changed again later moves to the later turn.
//
// Guard rails (the chat folder is often HOME): no hidden entries («.git»,
// «.zai-uploads», «.zai-tenants» — other tenants!), no junctions/symlinks,
// no tool caches (node_modules, AppData, __pycache__, venv), no lock/temp
// files; bounded depth, entry count and per-window list; the walk result is
// cached per folder for a few seconds (every open of a chat asks once).
import { readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { fsKey } from "./paths.js";

export const LIMITS = { depth: 4, entries: 20000, perWindow: 40, windows: 300, cacheMs: 5000 };
const SLACK_BEFORE = 2000;
const SLACK_AFTER = 5000;
const SKIP_DIRS = new Set([
  "node_modules", "appdata", "application data", "$recycle.bin", "__pycache__", "venv",
  "site-packages", "system volume information", "onedrive", "graphify-out",
]);
const SKIP_EXT = new Set(["tmp", "temp", "lock", "pid", "lnk", "swp", "crdownload", "part", "db-journal", "pyc"]);
const SKIP_NAMES = /^(ntuser\.|desktop\.ini$|thumbs\.db$|~\$)/i;

const cache = new Map(); // dir → { at, list: [{ path, mtime, depth }] }

// BUG-181: a turn that makes many working files (scripts, extracted pictures,
// previews) still lists its RESULT — when the per-window cap bites, deliverables
// (documents, media, archives) in the folder root go first, then deliverables
// in subfolders, then everything else (scripts, data dumps); later files first
// inside a group. The result of a turn is usually written last.
const DELIVERABLE = new Set([
  "pptx", "ppt", "docx", "doc", "xlsx", "xls", "pdf", "odt", "ods", "odp", "rtf", "csv", "txt", "md",
  "html", "htm", "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "zip", "7z", "rar", "mp3", "wav", "mp4", "webm",
]);
export function cardRank(f) {
  const ext = path.extname(f.path).slice(1).toLowerCase();
  if (!DELIVERABLE.has(ext)) return 2;
  return f.depth === 0 ? 0 : 1;
}

function walk(root) {
  const out = [];
  let seen = 0;
  const visit = (dir, depth) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (++seen > LIMITS.entries) return;
      const name = e.name;
      if (name.startsWith(".") || SKIP_NAMES.test(name)) continue;
      if (e.isSymbolicLink()) continue; // Windows junctions included
      const p = path.join(dir, name);
      if (e.isDirectory()) {
        if (depth < LIMITS.depth && !SKIP_DIRS.has(name.toLowerCase())) visit(p, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(name).slice(1).toLowerCase();
      if (SKIP_EXT.has(ext)) continue;
      try {
        out.push({ path: p, mtime: lstatSync(p).mtimeMs, depth });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  };
  visit(root, 0);
  return out;
}

function listing(dir, now = Date.now()) {
  const key = fsKey(path.resolve(dir)); // BUG-17.14: регистр значим на POSIX
  const hit = cache.get(key);
  if (hit && now - hit.at < LIMITS.cacheMs) return hit.list;
  const list = walk(path.resolve(dir));
  cache.set(key, { at: now, list });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return list;
}

// "1730640000000-1730640060000,…" → [[start, end], …]; junk pairs dropped.
export function parseWindows(raw) {
  const out = [];
  for (const piece of String(raw ?? "").split(",").slice(0, LIMITS.windows)) {
    const m = /^(\d{10,16})-(\d{10,16})$/.exec(piece.trim());
    if (!m) {
      out.push(null);
      continue;
    }
    const a = Number(m[1]);
    const b = Number(m[2]);
    out.push(b >= a ? [a, b] : null);
  }
  return out;
}

// Every file lands in ONE window: strict containment first, then the slack
// margins (clock skew, a write flushed right after «completed»).
export function turnFiles(dir, windows, { now } = {}) {
  const list = [...listing(dir, now)].sort((x, y) => x.mtime - y.mtime);
  const out = windows.map(() => []);
  const taken = new Set();
  const pass = (before, after) => {
    windows.forEach((w, i) => {
      if (!w) return;
      const room = LIMITS.perWindow - out[i].length;
      if (room <= 0) return;
      const hits = list.filter((f) => !taken.has(f.path) && f.mtime >= w[0] - before && f.mtime <= w[1] + after);
      hits.sort((x, y) => cardRank(x) - cardRank(y) || y.mtime - x.mtime);
      for (const f of hits.slice(0, room)) {
        taken.add(f.path);
        out[i].push(f);
      }
    });
  };
  pass(0, 0);
  pass(SLACK_BEFORE, SLACK_AFTER);
  return out.map((fs) => fs.sort((x, y) => x.mtime - y.mtime).map((f) => f.path));
}

export function _clearCache() {
  cache.clear();
}
