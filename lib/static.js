// Traversal-safe static file server for the /zai/ web UI. Owns the /zai
// prefix mapping: "/zai" -> 308 to "/zai/", "/zai/foo" -> public/foo, and
// already-stripped paths ("/foo") also work so callers can pass either form.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ZAI_PUBLIC_DIR: serve a staging copy (isolated test instance next to prod).
const PUBLIC = process.env.ZAI_PUBLIC_DIR
  ? path.resolve(process.env.ZAI_PUBLIC_DIR)
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

export function serveStatic(req, res, urlPath) {
  const rawPath = String(urlPath).split("?")[0];
  if (rawPath === "/zai") {
    res.writeHead(308, { location: "/zai/" });
    return void res.end();
  }
  let pathname = rawPath;
  if (pathname.startsWith("/zai/")) pathname = pathname.slice("/zai".length);

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
  if (notModified(req, stat)) {
    res.writeHead(304, { etag, "last-modified": lastModified });
    return void res.end();
  }
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": ICON_EXT.has(ext) ? "public, max-age=604800, immutable" : "no-cache",
    etag,
    "last-modified": lastModified,
  });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file)
    .on("error", () => res.destroy()) // headers sent already; nothing else to say
    .pipe(res);
}
