// portal-server.js — node replacement for the WDAC-blocked caddy.exe on port 80.
// Mirrors D:\Portal\Caddyfile exactly:
//   /tv/api/*  -> reverse_proxy 127.0.0.1:8099  (Host: {upstream_hostport}, X-Orig-Host: {host})
//   /zai/*     -> reverse_proxy 127.0.0.1:4170  (strip prefix, streaming/SSE)
//   /          -> 302 /tv/   |  /tv -> 302 /tv/
//   else       -> file_server root D:\Portal (no browse, index.html, hide list)
// Zero dependencies. Signed node.exe passes Smart App Control where unsigned
// caddy.exe cannot start again (running instance predates the policy).
// TLS (2026-10-31): voice input needs a SECURE CONTEXT — iOS Safari exposes
// SpeechRecognition/getUserMedia only on https, and a LAN IP over http never
// qualifies. When the mkcert files exist (ops/certs/), the same handler also
// listens on :443; /zai/ca.pem serves the root CA for one-time install on
// iPhone (Settings → Profile Downloaded → install → enable full trust).
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { appendFile, createReadStream, mkdirSync, readdirSync, statSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ADR-006 п.7: the edge stays import-free (no lib/), with the same
// discipline — every env value is validated at start, a bad one exits 1.
// Defaults are the production values; the overrides exist so tests run a
// COPY of the edge on free ports against fake upstreams.
const cfgErrors = [];
function envPort(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!/^\d+$/.test(String(raw).trim()) || n > 65535) {
    cfgErrors.push(`${name}: ожидался порт 0..65535, получено \`${raw}\``);
    return def;
  }
  return n;
}
function envHostPort(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const m = String(raw).trim().match(/^(?:https?:\/\/)?([\w.-]+):(\d{1,5})\/?$/);
  if (!m) {
    cfgErrors.push(`${name}: ожидалось host:port, получено \`${raw}\``);
    return def;
  }
  return { host: m[1], port: Number(m[2]) };
}

const PORT = envPort("PORT", 80);
const TLS_PORT = envPort("TLS_PORT", 443);
const TV_API = envHostPort("ZAI_EDGE_TV_UPSTREAM", { host: "127.0.0.1", port: 8099 });
const ZAI = envHostPort("ZAI_EDGE_UPSTREAM", { host: "127.0.0.1", port: 4170 });
// Defaults relative to the checkout: static root = the folder that holds the
// checkout (only its tv/ subtree is ever served), certs in ops/certs, logs in data/logs.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CERTS = path.join(REPO, "ops", "certs");
const ROOT = process.env.ZAI_EDGE_ROOT || path.dirname(REPO);
const TLS_CERT = process.env.ZAI_TLS_CERT || path.join(CERTS, "192.168.0.10.pem");
const TLS_KEY = process.env.ZAI_TLS_KEY || path.join(CERTS, "192.168.0.10-key.pem");
const TLS_CA = process.env.ZAI_TLS_CA || path.join(CERTS, "ca", "rootCA.pem");
// Public domain: some mobile networks drop TLS by SNI for the router's DNS
// name, so the portal can also be published under its own domain. Clients
// asking for one of ZAI_TLS_PUBLIC_NAMES get the public CA cert (full chain);
// every other SNI (LAN IP, no SNI) keeps the
// mkcert cert above. Missing files → the public context is simply skipped.
const TLS_PUBLIC_CERT = process.env.ZAI_TLS_PUBLIC_CERT || path.join(CERTS, "example.org-fullchain.pem");
const TLS_PUBLIC_KEY = process.env.ZAI_TLS_PUBLIC_KEY || path.join(CERTS, "example.org-key.pem");
const TLS_PUBLIC_NAMES = new Set(
  (process.env.ZAI_TLS_PUBLIC_NAMES ?? "example.org,www.example.org").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);
// Access log (TASK-12.20): ZAI_EDGE_LOG_DIR, "0" disables.
const LOG_DIR = process.env.ZAI_EDGE_LOG_DIR ?? path.join(REPO, "data", "logs");
// The portal cookie name(s) cut from /tv/api requests (ADR-009 п.1).
const PORTAL_COOKIES = new Set((process.env.ZAI_EDGE_PORTAL_COOKIES || "zai_t,zai_t_stage").split(",").map((s) => s.trim()).filter(Boolean));
if (!path.isAbsolute(ROOT)) cfgErrors.push(`ZAI_EDGE_ROOT: ожидался абсолютный путь, получено \`${ROOT}\``);
if (cfgErrors.length > 0) {
  for (const e of cfgErrors) console.error(`[edge-config] ${e}`);
  process.exit(1);
}
console.log(`[edge-config] ${JSON.stringify({ PORT, TLS_PORT, TV_API, ZAI, ROOT, LOG_DIR: LOG_DIR || "off" })}`);

// --- access log (one JSON line per request; path only, no query/cookies) ---
const LOG_MAX = 10 * 1024 * 1024;
let logState = { day: "", file: "", size: 0, part: 0, ready: false };
function logAccess(entry) {
  if (!LOG_DIR || LOG_DIR === "0") return;
  try {
    if (!logState.ready) {
      mkdirSync(LOG_DIR, { recursive: true });
      logState.ready = true;
    }
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    if (logState.day !== day) {
      logState = { ...logState, day, part: 0, file: path.join(LOG_DIR, `edge-${day}.log`), size: 0 };
      try {
        logState.size = statSync(logState.file).size;
      } catch {}
      // 14-day retention, checked once per day.
      const cutoff = Date.now() - 14 * 86_400_000;
      try {
        for (const n of readdirSync(LOG_DIR)) {
          if (!n.startsWith("edge-")) continue;
          const f = path.join(LOG_DIR, n);
          if (statSync(f).mtimeMs < cutoff) unlinkSync(f);
        }
      } catch {}
    }
    if (logState.size > LOG_MAX) {
      logState.part += 1;
      logState.file = path.join(LOG_DIR, `edge-${day}.${logState.part}.log`);
      logState.size = 0;
    }
    const line = JSON.stringify(entry) + "\n";
    logState.size += Buffer.byteLength(line);
    appendFile(logState.file, line, () => {});
  } catch {}
}

// Basenames hidden from static serving (same list as the Caddyfile + ops guard).
const HIDE = new Set([
  "secrets", "api.ps1", "api.log", "status.ps1", "watchdog.ps1", "watchdog.log",
  "watchdog.state", "prepare.ps1", "prepare.log", "prepare.state.json",
  "Caddyfile", "caddy.exe", "Caddyfile.bak-20261031-zai", "tune_backup.json",
  "index.html.bak-2026-10-30", "index.html.bak-before-restore", "prepare.ffblocked",
  "Universal Media Server.lnk.disabled",
].map((n) => n.toLowerCase()));
// Security (full review 2026-11-02): NTFS is case-insensitive, so EVERY hide
// check compares lower-cased names — /SECRETS/qb.json and /WATCHDOG.PS1 used
// to slip past this exact-case Set and were served publicly.
const isHidden = (name) => HIDE.has(String(name).toLowerCase());

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t", ".vtt": "text/vtt", ".pdf": "application/pdf",
  ".woff2": "font/woff2", ".map": "application/json", ".zip": "application/zip",
};

// ADR-009 п.1: the client's own forwarding headers are never trusted — they
// are removed and rebuilt from the listener (proto) and the socket (ip).
function forwardHeaders(req, headers) {
  delete headers["x-forwarded-proto"];
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-host"];
  delete headers["forwarded"];
  delete headers["x-real-ip"];
  headers["x-forwarded-proto"] = req.socket?.encrypted ? "https" : "http";
  headers["x-forwarded-for"] = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;
  headers["x-request-id"] = req.edgeRid;
}

// /tv/api must not see the portal's session cookie or bearer token.
function stripPortalCredentials(headers) {
  delete headers["authorization"];
  if (typeof headers.cookie === "string") {
    const kept = headers.cookie
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s && !PORTAL_COOKIES.has(s.split("=")[0].trim()));
    if (kept.length > 0) headers.cookie = kept.join("; ");
    else delete headers.cookie;
  }
}

function proxy(req, res, target, { stripPrefix = "", hostRewrite = null, hsts = false, pathOverride = null, stripCredentials = false } = {}) {
  const u = new URL(req.url, "http://x");
  let p = pathOverride ?? (u.pathname + u.search);
  if (stripPrefix && p.startsWith(stripPrefix)) p = p.slice(stripPrefix.length) || "/";
  const headers = { ...req.headers };
  delete headers["connection"];
  delete headers["keep-alive"];
  forwardHeaders(req, headers);
  if (stripCredentials) stripPortalCredentials(headers);
  if (hostRewrite) {
    headers["x-orig-host"] = headers.host || "";
    headers.host = hostRewrite;
  }
  const up = http.request(
    { host: target.host, port: target.port, path: p, method: req.method, headers },
    (ur) => {
      const h = { ...ur.headers };
      delete h["connection"];
      delete h["transfer-encoding"]; // we re-chunk ourselves
      if (hsts) h["strict-transport-security"] = "max-age=31536000";
      res.writeHead(ur.statusCode, h);
      ur.pipe(res, { flush: true }); // immediate flush: SSE + streaming video friendly
    },
  );
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("upstream unavailable");
  });
  req.pipe(up, { flush: true });
}

function serveFile(res, file, method) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not Found");
  }
  if (!stat.isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not Found");
  }
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file);
  if (isHidden(base)) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not Found");
  }
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": stat.size,
    "accept-ranges": "none",
    "last-modified": stat.mtime.toUTCString(),
  });
  if (method === "HEAD") return res.end();
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res, { flush: true });
}

function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    return res.end("bad path");
  }
  // Security (full review 2026-11-02, CRITICAL): Windows path aliases defeat
  // name lists — NTFS streams (/zai::$INDEX_ALLOCATION/data/admin-token.txt
  // served the prod admin token), 8.3 short names (ZAI-ST~1), trailing dots/
  // spaces. Refuse every alias shape, then ALLOW-LIST: the only static tree
  // this edge serves is D:\Portal\tv (the TV admin page + status.json).
  if (/[:~*?"<>|\\\x00-\x1f]/.test(decoded) || /[. ]($|\/)/.test(decoded.replace(/\/+$/, ""))) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not Found");
  }
  const firstSeg = decoded.split("/").filter(Boolean)[0] ?? "";
  if (firstSeg !== "tv") {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not Found");
  }
  if (decoded.endsWith("/")) decoded += "index.html";
  const file = path.resolve(ROOT, "." + decoded);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  // hide-listed top-level names and any path through hidden dirs
  const rel = path.relative(ROOT, file);
  const parts = rel.split(path.sep);
  // BUG-001 (security): NTFS resolves paths case-insensitively, URL routing is case-sensitive.
  // These trees must NEVER be file-served from the edge, regardless of URL case.
  // zai-stage holds the stand launcher, its admin token and stand data — it
  // was file-served publicly until the 2026-11-02 review.
  const SEGMENT_BLOCK = new Set(["zai", "zai-qa", "zai-stage", ".git"]);
  if (parts.some((seg) => isHidden(seg) || SEGMENT_BLOCK.has(seg.toLowerCase()))) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not Found");
  }
  // directory without trailing slash -> serve its index if present, else 404
  if (!path.extname(file)) {
    const idx = path.join(file, "index.html");
    if (existsSync(idx) && statSync(idx).isFile()) return serveFile(res, idx, req.method);
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not Found");
  }
  serveFile(res, file, req.method);
}

// HTTPS-only for /zai (2026-11-01, user request): plain-http hits on /zai*
// bounce (308, method-preserving) to the same URL on https, EXCEPT /zai/ca.pem
// — device bootstrap must fetch the root CA over plain http before it can
// trust https at all. Active only while the TLS listener is actually up
// (cert files present); ZAI_HTTPS_ONLY=0 reverts to the old open-http behavior.
const TLS_UP = existsSync(TLS_CERT) && existsSync(TLS_KEY);
const HTTPS_ONLY = TLS_UP && process.env.ZAI_HTTPS_ONLY !== "0";

function zaiToHttps(req, res) {
  const u = new URL(req.url, "http://x");
  const host = (req.headers.host || "").split(":")[0] || "192.168.0.10";
  const p = u.pathname === "/zai" ? "/zai/" : u.pathname;
  res.writeHead(308, { location: `https://${host}${p}${u.search}` });
  res.end();
}

const httpHandler = HTTPS_ONLY
  ? (req, res) => {
      let p;
      try {
        p = new URL(req.url, "http://x").pathname;
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        return res.end("bad request");
      }
      const pl = p.toLowerCase(); // BUG-001: /ZAI/... must hit the same rule as /zai/...
      if ((pl === "/zai" || pl.startsWith("/zai/")) && pl !== "/zai/ca.pem") return zaiToHttps(req, res);
      return handler(req, res);
    }
  : handler;
const server = http.createServer(httpHandler);
server.on("error", (err) => {
  console.error(`portal-http error: ${err.message}`);
  process.exit(1); // die loudly so the watchdog's :80 check restarts the task
});

// Every request goes through this guard: a malformed request target
// (`GET http://%zz/`) made `new URL` throw and took the whole edge down for
// everyone, unauthenticated (security review 2026-11-02).
function handler(req, res) {
  const started = Date.now();
  req.edgeRid = randomBytes(6).toString("hex");
  res.on("close", () => {
    let p = "";
    try {
      p = new URL(req.url, "http://x").pathname;
    } catch {
      p = "(bad url)";
    }
    logAccess({
      ts: new Date(started).toISOString(),
      rid: req.edgeRid,
      ip: String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, ""),
      tls: Boolean(req.socket?.encrypted),
      method: req.method,
      path: p.slice(0, 300),
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });
  try {
    return routeRequest(req, res);
  } catch (err) {
    console.error(`portal: bad request ${JSON.stringify(String(req.url).slice(0, 200))}: ${err.message}`);
    if (!res.headersSent) res.writeHead(400, { "content-type": "text/plain" });
    return res.end("bad request");
  }
}

function routeRequest(req, res) {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  const pl = p.toLowerCase(); // BUG-001: routing decisions are case-insensitive (NTFS would resolve /ZAI/* as real files)

  // mkcert root CA for device profiles (public cert only; the key stays here).
  if (pl === "/zai/ca.pem") {
    let stat;
    try {
      stat = statSync(TLS_CA);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("no CA on this box");
    }
    res.writeHead(200, {
      "content-type": "application/x-x509-ca-cert",
      "content-length": stat.size,
      "content-disposition": 'inline; filename="zai-rootCA.pem"',
      "strict-transport-security": "max-age=31536000",
    });
    if (req.method === "HEAD") return res.end();
    return createReadStream(TLS_CA).on("error", () => res.destroy()).pipe(res);
  }

  if (pl === "/tv/api" || pl.startsWith("/tv/api/")) {
    return proxy(req, res, TV_API, {
      hostRewrite: `${TV_API.host}:${TV_API.port}`,
      stripCredentials: true,
    });
  }
  if (pl === "/zai" || pl.startsWith("/zai/")) {
    if (pl === "/zai") {
      res.writeHead(308, { location: "/zai/" });
      return res.end();
    }
    // ADR-007: the health probe is for the local watchdog only.
    if (pl.replace(/\/+$/, "") === "/zai/api/healthz") {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not Found");
    }
    // Forward the ORIGINAL path: dynamic segments are case-sensitive upstream
    // (opencode session IDs — lowercase them and every message/prompt 404s,
    // live 2026-11-02). Only the literal /zai prefix is normalized, so /ZAI/…
    // aliases still hit server.js's case-sensitive /zai/* routes (BUG-001).
    return proxy(req, res, ZAI, { hsts: true, pathOverride: "/zai" + p.slice(4) + u.search });
  }
  if (p === "/" || p === "") {
    res.writeHead(302, { location: "/tv/" });
    return res.end();
  }
  if (p === "/tv") {
    res.writeHead(302, { location: "/tv/" });
    return res.end();
  }
  serveStatic(req, res, p);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`portal-node listening on 0.0.0.0:${PORT} (/tv static+api, /zai -> ${ZAI.port}${HTTPS_ONLY ? ", /zai http->https 308" : ""})`);
});

// Optional TLS listener: flips the portal into a secure context (voice input,
// PWA niceties) without touching the http surface. Failures here must not
// take the plain-http portal down.
if (TLS_UP) {
  try {
    let publicCtx = null;
    if (TLS_PUBLIC_NAMES.size > 0 && existsSync(TLS_PUBLIC_CERT) && existsSync(TLS_PUBLIC_KEY)) {
      try {
        publicCtx = tls.createSecureContext({ cert: readFileSync(TLS_PUBLIC_CERT), key: readFileSync(TLS_PUBLIC_KEY) });
        console.log(`portal-tls public cert for ${[...TLS_PUBLIC_NAMES].join(", ")}`);
      } catch (err) {
        console.error(`portal-tls public cert skipped: ${err.message}`);
      }
    }
    const tlsServer = https.createServer(
      {
        cert: readFileSync(TLS_CERT),
        key: readFileSync(TLS_KEY),
        ...(publicCtx && {
          SNICallback: (servername, cb) =>
            cb(null, TLS_PUBLIC_NAMES.has(String(servername).toLowerCase()) ? publicCtx : undefined),
        }),
      },
      handler,
    );
    tlsServer.on("error", (err) => console.error(`portal-tls error: ${err.message} (http still on :${PORT})`));
    tlsServer.listen(TLS_PORT, "0.0.0.0", () => {
      console.log(`portal-tls listening on 0.0.0.0:${TLS_PORT} (secure context; CA at /zai/ca.pem)`);
    });
  } catch (err) {
    console.error(`portal-tls init failed: ${err.message} (http still on :${PORT})`);
  }
}
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
