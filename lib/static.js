// Traversal-safe static file server for the /teleharness/ web UI. Owns the /teleharness
// prefix mapping: "/teleharness" -> 308 to "/teleharness/", "/teleharness/foo" -> public/foo, and
// already-stripped paths ("/foo") also work so callers can pass either form.
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { brotliCompress, constants as zc, gzip } from "node:zlib";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// TELEHARNESS_PUBLIC_DIR: serve a staging copy (isolated test instance next to prod).
const PUBLIC = process.env.TELEHARNESS_PUBLIC_DIR
  ? path.resolve(process.env.TELEHARNESS_PUBLIC_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Assets are not content-hashed, so everything except icons must revalidate
// on every load; icons are stable and safe to cache hard.
const ICON_EXT = new Set([".png", ".svg", ".ico", ".woff2"]);

// TASK-261: текстовая статика сжимается по Accept-Encoding (br, иначе gzip).
// Сжатая копия считается один раз на (файл, ETag, кодировка) в пуле потоков
// zlib и держится в памяти до пересборки файла; ETag — тот же, что у
// несжатого ответа (клиент сравнивает ETag app.js — BUG-179).
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".webmanifest", ".txt", ".map"]);
const MIN_COMPRESS = 1024;
const MAX_COMPRESS = 16 * 1024 * 1024;
const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const packed = new Map(); // `${enc}:${file}` → { etag, p: Promise<Buffer> }

export function pickEncoding(header) {
  const q = new Map();
  for (const part of String(header ?? "").toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    const qp = params.map((x) => x.trim()).find((x) => x.startsWith("q="));
    const v = qp ? Number(qp.slice(2)) : 1;
    q.set(name, Number.isFinite(v) ? v : 0);
  }
  const ok = (n) => (q.has(n) ? q.get(n) > 0 : (q.get("*") ?? 0) > 0);
  if (ok("br")) return "br";
  if (ok("gzip")) return "gzip";
  return null;
}

function compressed(file, etag, enc) {
  const k = `${enc}:${file}`;
  const hit = packed.get(k);
  if (hit && hit.etag === etag) return hit.p;
  const p = readFile(file).then((buf) =>
    enc === "br"
      ? brotliAsync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 9, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length } })
      : gzipAsync(buf, { level: 9 }),
  );
  const rec = { etag, p };
  packed.set(k, rec);
  p.catch(() => {
    if (packed.get(k) === rec) packed.delete(k);
  });
  return p;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Validators for no-cache assets: without ETag/Last-Modified a revalidation
// request has nothing to compare, and some clients then reuse a pinned stale
// bundle after a rebuild (mojibake labels lived through reloads until a hard
// cache-bypass, live 2026-11-01). ETag = mtime+size fingerprint.
function validators(stat) {
  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  return { etag, lastModified: stat.mtime.toUTCString() };
}

function notModified(req, stat) {
  const { etag, lastModified } = validators(stat);
  const inm = req.headers["if-none-match"];
  if (inm) {
    // Weak compare: any listed tag matching ours. Quotes are optional on the
    // wire (some clients/proxies strip them) — compare bare values.
    const bare = etag.replace(/"/g, "");
    return inm
      .split(",")
      .map((t) => t.trim().replace(/^W\//, "").replace(/"/g, ""))
      .includes(bare);
  }
  const ims = req.headers["if-modified-since"];
  if (!ims) return false;
  const since = Date.parse(ims);
  return Number.isFinite(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since;
}

// TASK-12.30: защитные заголовки каждого ответа портала (ставятся на входе запроса;
// writeHead их не стирает). Запрет встраивания — только у HTML самого портала:
// просмотр файлов (/file) показывается во фрейме со своей CSP-песочницей.
export function applySecurityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}
const FRAME_DENY = { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" };

export function serveStatic(req, res, urlPath) {
  const rawPath = String(urlPath).split("?")[0];
  if (rawPath === "/teleharness") {
    res.writeHead(308, { location: "/teleharness/" });
    return void res.end();
  }
  let pathname = rawPath;
  if (pathname.startsWith("/teleharness/")) pathname = pathname.slice("/teleharness".length);

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "bad path" });
  }

  if (decoded === "/" || decoded === "") decoded = "/index.html";
  if (decoded.endsWith("/") || !path.extname(decoded)) decoded += "/index.html";

  // resolve() collapses any remaining ../ or .. segments; the startsWith
  // check then proves the file lives inside public/ before we touch the disk.
  const file = path.resolve(PUBLIC, "." + decoded);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  if (!existsSync(file)) return sendJson(res, 404, { error: "not found" });

  let stat;
  try {
    stat = statSync(file);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }

  const ext = path.extname(file).toLowerCase();
  const { etag, lastModified } = validators(stat);
  const canPack = COMPRESSIBLE.has(ext) && stat.size >= MIN_COMPRESS && stat.size <= MAX_COMPRESS;
  const vary = canPack ? { vary: "Accept-Encoding" } : {};
  if (notModified(req, stat)) {
    res.writeHead(304, { etag, "last-modified": lastModified, ...vary });
    return void res.end();
  }
  const head = {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": ICON_EXT.has(ext) ? "public, max-age=604800, immutable" : "no-cache",
    etag,
    "last-modified": lastModified,
    ...(ext === ".html" ? FRAME_DENY : {}),
    ...vary,
  };
  const enc = canPack ? pickEncoding(req.headers["accept-encoding"]) : null;
  if (enc) {
    compressed(file, etag, enc).then(
      (body) => {
        if (res.destroyed) return;
        res.writeHead(200, { ...head, "content-encoding": enc, "content-length": body.length });
        res.end(req.method === "HEAD" ? undefined : body);
      },
      () => sendPlain(req, res, file, head), // сжатие не удалось — как раньше
    );
    return;
  }
  sendPlain(req, res, file, head);
}

function sendPlain(req, res, file, head) {
  if (res.destroyed) return;
  res.writeHead(200, head);
  if (req.method === "HEAD") return void res.end();
  createReadStream(file)
    .on("error", () => res.destroy()) // headers sent already; nothing else to say
    .pipe(res);
}
