// Workspace file serving for chat artifact preview/download:
// GET /zai/api/file?directory=<dir>&path=<rel-or-abs>[&download=1].
// The target may be relative to the directory (".zai-uploads/x.xlsx") or an
// absolute path — but it MUST resolve strictly INSIDE the directory or one of
// the extra allowed roots, so a crafted path cannot read arbitrary files.
// Extra roots exist because the agent works across the whole machine (vault
// D:\Obsidian, repos D:\Portal) while chat sessions usually live in HOME:
// strict session-dir containment 403'd every artifact preview for files the
// agent wrote outside the chat folder (live 2026-10-31). Override with
// ZAI_FILE_ROOTS (semicolon-separated) if the workspaces move.
import { createReadStream, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { pathInside } from "./paths.js";

const DEFAULT_EXTRA_ROOTS = config.ZAI_FILE_ROOTS;

// BUG-12.7: documents that a browser would EXECUTE when opened top-level in
// the portal origin (agent- or tenant-written HTML/SVG with script → admin
// cookie theft). They are served with a CSP sandbox: an opaque origin, no
// access to the portal's cookies or storage. The policy mirrors the iframe
// the FileViewer already uses (allow-scripts allow-popups allow-forms), so
// the in-app preview keeps working.
const ACTIVE_EXT = new Set([".html", ".htm", ".xhtml", ".svg", ".xml"]);
const SANDBOX_CSP = "sandbox allow-scripts allow-popups allow-forms; default-src 'self' data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'";
const SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yml": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  // FV-10 / FV-14: formats the FileViewer plays or shows as text.
  ".m4v": "video/mp4",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/ogg; codecs=opus",
  ".oga": "audio/ogg",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".ini": "text/plain; charset=utf-8",
  ".conf": "text/plain; charset=utf-8",
  ".env": "text/plain; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".go": "text/plain; charset=utf-8",
  ".rs": "text/plain; charset=utf-8",
  ".java": "text/plain; charset=utf-8",
  ".c": "text/plain; charset=utf-8",
  ".h": "text/plain; charset=utf-8",
  ".cpp": "text/plain; charset=utf-8",
  ".cs": "text/plain; charset=utf-8",
  ".diff": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".bat": "text/plain; charset=utf-8",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
};

export function mimeFor(filePath) {
  const ext = path.extname(String(filePath ?? "")).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

// resolveInside(directory, target, extraRoots?) -> absolute path strictly
// inside the directory or one of extraRoots, or null. path.resolve()
// collapses ../ segments and lets an absolute target replace the base
// entirely; the path.relative() check then rejects anything that escapes (or
// IS the base). Windows paths are case-insensitive, so the containment check
// is too. Every base is tried; the first containing base wins.
function within(base, full) {
  let rel;
  try {
    rel = path.relative(base, full);
  } catch {
    return false;
  }
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  if (process.platform === "win32") {
    // path.relative is a string compare: "C:\Users" vs "c:\users" would
    // wrongly produce "..\". Re-verify case-insensitively on win32.
    if (!pathInside(full, base, "win32")) return false; // BUG-17.14: сравнение — lib/paths.js
  }
  return true;
}

export function resolveInside(directory, target, extraRoots = DEFAULT_EXTRA_ROOTS) {
  if (typeof target !== "string" || !target.trim()) return null;
  const bases = [directory, ...(Array.isArray(extraRoots) ? extraRoots : [])];
  for (const base of bases) {
    if (typeof base !== "string" || !base.trim()) continue;
    let resolvedBase;
    let full;
    try {
      resolvedBase = path.resolve(base);
      full = path.resolve(resolvedBase, target);
    } catch {
      continue;
    }
    if (within(resolvedBase, full)) return full;
  }
  return null;
}

// RFC 6266/5987 Content-Disposition: ASCII fallback + encoded filename.
function contentDisposition(kind, filePath) {
  const raw = path.basename(String(filePath ?? "file"));
  const ascii = raw.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function realOrNull(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

// BUG-12.7: the lexical check above is a string compare — a junction or
// symlink INSIDE an allowed root (`mklink /J jx C:\`) pointed anywhere on the
// disk. The real path of the target must lie inside the real path of one of
// the allowed bases. Returns the real path, null (escape) or undefined
// (target missing).
export function realInside(full, bases) {
  const real = realOrNull(full);
  if (real === null) return undefined;
  for (const base of bases) {
    if (typeof base !== "string" || !base.trim()) continue;
    const rb = realOrNull(path.resolve(base));
    if (rb && within(rb, real)) return real;
  }
  return null;
}

// BUG-090 (BUG-05.16): does a workspace file exist and may it be served?
// Same containment as serveWorkspaceFile (lexical + realpath); forbidden,
// missing and directories are all `false` — the answer never tells a
// forbidden path from a missing one. Used by GET /zai/api/file/exists so the
// client checks a GUESSED picture before it inserts an <img> (a 404 of an
// <img> is logged by the browser and cannot be silenced on the client).
export function workspaceFileExists(directory, target, extraRoots) {
  const roots = Array.isArray(extraRoots) ? extraRoots : DEFAULT_EXTRA_ROOTS;
  const full = resolveInside(directory, target, roots);
  if (!full) return false;
  const real = realInside(full, [directory, ...roots]);
  if (!real) return false;
  try {
    return statSync(real).isFile();
  } catch {
    return false;
  }
}

// Streams the file once resolveInside() approved it. Answers 404 for
// missing paths and directories alike (no filesystem shape disclosure).
export function serveWorkspaceFile(req, res, { directory, target, download = false, extraRoots }) {
  const roots = Array.isArray(extraRoots) ? extraRoots : DEFAULT_EXTRA_ROOTS;
  const full = resolveInside(directory, target, roots);
  if (!full) return sendJson(res, 403, { error: "forbidden" });
  const real = realInside(full, [directory, ...roots]);
  if (real === undefined) return sendJson(res, 404, { error: "not found" });
  if (real === null) return sendJson(res, 403, { error: "forbidden" });
  let stat;
  try {
    stat = statSync(real);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: "not found" });
  const ext = path.extname(full).toLowerCase();
  const headers = {
    "content-type": mimeFor(full),
    "content-length": stat.size,
    "content-disposition": contentDisposition(download ? "attachment" : "inline", full),
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  };
  if (ACTIVE_EXT.has(ext)) headers["content-security-policy"] = ext === ".svg" ? SVG_CSP : SANDBOX_CSP;
  res.writeHead(200, headers);
  if (req.method === "HEAD") return void res.end();
  createReadStream(real)
    .on("error", () => res.destroy()) // headers sent already; nothing else to say
    .pipe(res);
}
