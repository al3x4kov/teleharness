// Streaming reverse proxy to the upstream opencode server (node stdlib only).
// Request bodies stream end to end (no buffering except for cached routes),
// oversized uploads get 413 after draining, dead or hanging upstreams get 502
// without ever crashing the server process.
import http from "node:http";
import { createHash } from "node:crypto";

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024; // 2 MB for everything except prompts
const CACHE_TTL_MS = 60_000;

// Hop-by-hop headers must not be forwarded in either direction.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// In-memory response cache for the big, rarely-changing catalog routes
// (provider is ~7MB). Keyed by cacheKey ("provider" / "agent"), value holds
// the body so we can hash it into an ETag and serve 304s without re-dialing.
const cache = new Map();

export function resetProxyCache() {
  cache.clear();
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json", "x-accel-buffering": "no" });
  res.end(JSON.stringify(obj));
}

// BUG-12.12: the upstream address / socket error stays in the log; the
// client gets a generic Russian text.
function upstreamFailed(res, err) {
  console.error(`[zai-proxy] upstream: ${err?.message ?? err}`);
  sendJson(res, 502, { error: "Сервер агента недоступен" });
}

function etagMatches(headerValue, etag) {
  if (!headerValue) return false;
  return headerValue.trim() === "*" || headerValue.split(",").map((s) => s.trim()).includes(etag);
}

// Copy client headers minus hop-by-hop junk, the original Host, and
// accept-encoding (we want deterministic identity bytes, esp. for the cache).
function forwardedHeaders(req) {
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "host" || lower === "accept-encoding") continue;
    // The portal's own credentials never reach opencode (Г1 coordination).
    if (lower === "cookie" || lower === "authorization") continue;
    out[name] = value;
  }
  return out;
}

// Keep reading (and discarding) the request body so the client can finish its
// upload and actually see our error response instead of a connection reset.
function drain(req) {
  return new Promise((resolve) => {
    if (req.readableEnded || req.destroyed) return resolve();
    req.resume();
    req.on("end", resolve, { once: true });
    req.on("close", resolve, { once: true });
    req.on("error", resolve, { once: true });
  });
}

function rejectTooLarge(req, res) {
  return drain(req).then(() => sendJson(res, 413, { error: "body too large" }));
}

// --- message history pagination (BUG-08.8) -----------------------------------
// opencode 1.19.5 answers 400 to every `before` format, so the portal pages
// the history itself: the upstream list (oldest → newest) is fetched whole
// and sliced here. Contract for GET /zai/api/session/:id/message:
//   ?limit=N            → the N newest messages
//   ?before=<msgID>     → messages strictly older than msgID (default N=50)
//   both                → the N newest of those older than msgID
// Response stays a plain JSON array (old clients unaffected) plus headers
//   x-zai-has-more: 1|0       — older messages exist beyond this page
//   x-zai-next-before: <id>   — cursor for the next (older) page, when has-more
// An unknown `before` id → 400 {error:"unknown before cursor"}.
export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 500;

const messageId = (m) => m?.info?.id ?? m?.id ?? null;

// Pure slice: returns {page, hasMore, nextBefore} or {error}.
export function paginateMessages(list, { limit = null, before = null } = {}) {
  if (!Array.isArray(list)) return { error: "upstream did not return a list" };
  let end = list.length;
  if (before) {
    end = list.findIndex((m) => messageId(m) === before);
    if (end < 0) return { error: "unknown before cursor" };
  }
  const n = limit ?? PAGE_DEFAULT;
  const start = Math.max(0, end - n);
  const page = list.slice(start, end);
  const hasMore = start > 0;
  return { page, hasMore, nextBefore: hasMore && page.length ? messageId(page[0]) : null };
}

// Split limit/before off an upstream path. null → no paging requested.
export function pageParams(upstreamPath) {
  const u = new URL(upstreamPath, "http://x");
  const rawLimit = u.searchParams.get("limit");
  const before = u.searchParams.get("before");
  if (rawLimit === null && before === null) return null;
  let limit = null;
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n <= 0) return { error: "limit must be a positive integer" };
    limit = Math.min(n, PAGE_MAX);
  }
  if (before !== null && !before) return { error: "before must be a message id" };
  u.searchParams.delete("limit");
  u.searchParams.delete("before");
  return { limit, before: before || null, path: `${u.pathname}${u.search}` };
}

export async function proxyRequest(req, res, upstreamPath, opts = {}) {
  const {
    method = req.method,
    // timeoutMs: deadline until upstream response HEADERS arrive. After that
    // the exchange is bounded by idleTimeoutMs (no bytes for that long), not
    // by a total deadline: a big history on a slow line used to be cut at
    // 30 s mid-body (BUG-08.8 / code-correctness #28). Defaults to timeoutMs.
    timeoutMs = 30_000,
    idleTimeoutMs = timeoutMs,
    bodyLimit = DEFAULT_BODY_LIMIT,
    cacheKey = null,
    upstreamBase = process.env.ZAI_UPSTREAM || "http://127.0.0.1:4096",
    body = null, // Buffer: send this body instead of streaming the client's
    paginate = false, // true: honor limit/before locally (message history)
    mapList = null, // paged path only: (list) => list applied before slicing
  } = opts;

  if (paginate && method === "GET") {
    const pp = pageParams(upstreamPath);
    if (pp?.error) {
      drain(req);
      return sendJson(res, 400, { error: pp.error });
    }
    if (pp) return proxyPaged(req, res, pp, { timeoutMs, idleTimeoutMs, upstreamBase, mapList });
  }

  // Fast path: the declared length already exceeds the limit - don't dial.
  const declared = Number(req.headers["content-length"]);
  if (bodyLimit && Number.isFinite(declared) && declared > bodyLimit) {
    return rejectTooLarge(req, res);
  }

  if (cacheKey && method === "GET") {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      if (etagMatches(req.headers["if-none-match"], hit.etag)) {
        res.writeHead(304, { etag: hit.etag, "x-accel-buffering": "no" });
        return void res.end();
      }
      res.writeHead(200, {
        "content-type": hit.contentType,
        etag: hit.etag,
        "x-accel-buffering": "no",
      });
      return void res.end(hit.body);
    }
  }

  await new Promise((resolve) => {
    let upReq;
    let finished = false;
    let timer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = (err) => {
      if (finished) return;
      upReq?.destroy();
      if (!res.headersSent) upstreamFailed(res, err);
      else res.destroy();
      finish();
    };
    if (timeoutMs) {
      // Deadline until the upstream answers with headers; unref so it can't
      // hold the loop. Replaced by the idle timer once the response starts.
      timer = setTimeout(() => fail(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      timer.unref();
    }
    // Idle timer: re-armed on every upstream chunk and every client drain.
    const touch = () => {
      if (finished || !idleTimeoutMs) return;
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error(`idle for ${idleTimeoutMs}ms`)), idleTimeoutMs);
      timer.unref();
    };

    try {
      const fwd = forwardedHeaders(req);
      if (Buffer.isBuffer(body)) {
        // A replaced body changes the length; stale client headers must go.
        fwd["content-length"] = String(body.length);
        delete fwd["transfer-encoding"];
      }
      upReq = http.request(new URL(upstreamPath, upstreamBase), {
        method,
        headers: fwd,
      });
    } catch (err) {
      fail(err);
      return;
    }
    upReq.on("error", fail);
    upReq.on("response", (upRes) => {
      clearTimeout(timer);
      timer = null;
      touch();
      upRes.on("data", touch);
      res.on("drain", touch);
      if (cacheKey && upRes.statusCode === 200) {
        // Buffered route: hash the body once, store, serve (possibly 304 if
        // the client's If-None-Match matches the freshly computed etag).
        const chunks = [];
        upRes.on("data", (c) => chunks.push(c));
        upRes.on("error", fail);
        upRes.on("end", () => {
          const body = Buffer.concat(chunks);
          const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
          cache.set(cacheKey, {
            body,
            etag,
            contentType: upRes.headers["content-type"] || "application/json",
            expiresAt: Date.now() + CACHE_TTL_MS,
          });
          if (finished || res.destroyed) return finish();
          if (etagMatches(req.headers["if-none-match"], etag)) {
            // BUGFIX 2026-10-31: 304 without res.end() left the response open
            // forever — the browser hung on "Загрузка…" whenever the cache
            // had expired and it sent If-None-Match (i.e. any reload after
            // 60s). Fast path already ended correctly; this path didn't.
            res.writeHead(304, { etag, "x-accel-buffering": "no" });
            res.end();
          } else {
            res.writeHead(200, {
              "content-type": upRes.headers["content-type"] || "application/json",
              etag,
              "x-accel-buffering": "no",
            });
            res.end(body);
          }
          finish();
        });
        return;
      }

      const headers = { ...upRes.headers, "x-accel-buffering": "no" };
      for (const h of HOP_BY_HOP) delete headers[h];
      res.writeHead(upRes.statusCode, headers);
      upRes.on("error", () => res.destroy()); // mid-stream: nothing to send but RST
      upRes.pipe(res);
      res.on("close", finish);
    });

    // Stream the client body to upstream, enforcing the size limit on the fly.
    // With a replaced body (opts.body) the client stream was already consumed
    // by the caller — just end the upstream request with the new payload.
    if (Buffer.isBuffer(body)) {
      upReq.end(body);
      return;
    }
    let sent = 0;
    let overLimit = false;
    req.on("data", (chunk) => {
      if (overLimit) return; // already rejected; drain() consumes the rest
      sent += chunk.length;
      if (bodyLimit && sent > bodyLimit) {
        overLimit = true;
        upReq.destroy();
        rejectTooLarge(req, res).then(finish);
        return;
      }
      upReq.write(chunk);
    });
    req.on("end", () => {
      if (!overLimit) upReq.end();
    });
    req.on("error", (err) => {
      upReq.destroy();
      if (!res.headersSent) sendJson(res, 400, { error: `client: ${err.message}` });
      finish();
    });
    req.on("close", () => {
      // 'close' also fires after a normal 'end'; only a half-sent body means
      // the client vanished and the upstream exchange must be torn down.
      if (!req.readableEnded && !overLimit) {
        upReq.destroy();
        finish();
      }
    });
  });
}

// Paged GET: fetch the whole list (headers deadline + idle timer, like the
// streamed path), slice it, answer the page. Non-200 upstream answers pass
// through verbatim.
function proxyPaged(req, res, pp, { timeoutMs, idleTimeoutMs, upstreamBase, mapList = null }) {
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    let upReq;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = (err) => {
      if (finished) return;
      upReq?.destroy();
      if (!res.headersSent) upstreamFailed(res, err);
      else res.destroy();
      done();
    };
    const arm = (ms, label) => {
      clearTimeout(timer);
      if (!ms) return;
      timer = setTimeout(() => fail(new Error(`${label} ${ms}ms`)), ms);
      timer.unref();
    };
    arm(timeoutMs, "timeout after");
    try {
      const fwd = forwardedHeaders(req);
      delete fwd["if-none-match"]; // the page is computed here, never 304'd upstream
      upReq = http.request(new URL(pp.path, upstreamBase), { method: "GET", headers: fwd });
    } catch (err) {
      fail(err);
      return;
    }
    upReq.on("error", fail);
    upReq.on("response", (upRes) => {
      arm(idleTimeoutMs, "idle for");
      const chunks = [];
      upRes.on("data", (c) => {
        chunks.push(c);
        arm(idleTimeoutMs, "idle for");
      });
      upRes.on("error", fail);
      upRes.on("end", () => {
        if (finished) return;
        const raw = Buffer.concat(chunks);
        if (upRes.statusCode !== 200) {
          res.writeHead(upRes.statusCode, {
            "content-type": upRes.headers["content-type"] || "application/json",
            "x-accel-buffering": "no",
          });
          res.end(raw);
          return done();
        }
        let list;
        try {
          list = JSON.parse(raw.toString("utf8"));
        } catch {
          sendJson(res, 502, { error: "upstream: invalid JSON" });
          return done();
        }
        if (mapList && Array.isArray(list)) {
          try {
            list = mapList(list);
          } catch {}
        }
        const r = paginateMessages(list, pp);
        if (r.error) {
          sendJson(res, r.error === "unknown before cursor" ? 400 : 502, { error: r.error });
          return done();
        }
        const headers = {
          "content-type": "application/json",
          "x-accel-buffering": "no",
          "x-zai-has-more": r.hasMore ? "1" : "0",
        };
        if (r.nextBefore) headers["x-zai-next-before"] = r.nextBefore;
        res.writeHead(200, headers);
        res.end(JSON.stringify(r.page));
        done();
      });
    });
    res.on("close", () => {
      if (!finished) {
        upReq.destroy();
        done();
      }
    });
    upReq.end();
  });
}
