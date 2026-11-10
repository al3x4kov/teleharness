// Tests for lib/proxy.js against a fake upstream HTTP server spun up in
// process. No live network calls. Covers: passthrough, POST body streaming,
// 413 over limit, 502 on refused/hanging upstream, and the provider cache.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { proxyRequest, resetProxyCache, paginateMessages, pageParams } from "../lib/proxy.js";

const socketsToNuke = [];
const servers = [];
after(async () => {
  for (const s of socketsToNuke) s.destroy();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

// Fake upstream: counts hits per pathname, delegates behavior to a handler.
function startUpstream(handler) {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const key = req.url.split("?")[0];
    hits.set(key, (hits.get(key) || 0) + 1);
    handler(req, res);
  });
  servers.push(server);
  const basePromise = listen(server).then(() => `http://127.0.0.1:${server.address().port}`);
  return { hits, base: basePromise };
}

// Wraps proxyRequest in a front server so tests can use fetch against it.
async function startProxy(opts) {
  const upstreamBase = await (opts._upstreamBase || opts._upstream.base);
  const o = { ...opts };
  delete o._upstreamBase;
  delete o._upstream;
  const server = http.createServer((req, res) => {
    proxyRequest(req, res, req.url, { upstreamBase, ...o });
  });
  servers.push(server);
  await listen(server);
  return `http://127.0.0.1:${server.address().port}`;
}

test("passes through status, content-type and body, adds X-Accel-Buffering", async () => {
  const upstream = startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions: [{ id: "ses_1", title: "hello" }] }));
  });
  const base = await startProxy({ _upstream: upstream });
  const res = await fetch(`${base}/session`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  assert.deepEqual(await res.json(), { sessions: [{ id: "ses_1", title: "hello" }] });
  assert.equal(upstream.hits.get("/session"), 1);
});

test("streams a large POST body to upstream unchanged", async () => {
  const upstream = startUpstream((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      res.writeHead(200, { "content-type": "application/octet-stream", "x-received": String(body.length) });
      res.end(body);
    });
  });
  const base = await startProxy({ _upstream: upstream });
  const payload = Buffer.alloc(200_000);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const res = await fetch(`${base}/echo`, { method: "POST", body: payload });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-received"), "200000");
  const echoed = Buffer.from(await res.arrayBuffer());
  assert.equal(echoed.length, payload.length);
  assert.ok(echoed.equals(payload));
});

test("responds 413 when the body exceeds the limit, without hitting upstream", async () => {
  const upstream = startUpstream((req, res) => {
    res.writeHead(200);
    res.end("{}");
  });
  const base = await startProxy({ _upstream: upstream, bodyLimit: 1024 });
  const res = await fetch(`${base}/echo`, { method: "POST", body: Buffer.alloc(4096, 1) });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(typeof body.error, "string");
  assert.equal(upstream.hits.get("/echo"), undefined);
});

test("responds 502 when upstream refuses the connection", async () => {
  // Occupy an ephemeral port, then close it so dialing fails.
  const holder = http.createServer(() => {});
  await listen(holder);
  const deadBase = `http://127.0.0.1:${holder.address().port}`;
  await new Promise((r) => holder.close(r));
  const base = await startProxy({ _upstreamBase: deadBase });
  const res = await fetch(`${base}/session`);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(typeof body.error, "string");
});

test("responds 502 when upstream hangs past the timeout", async () => {
  const server = http.createServer(() => {
    /* never respond */
  });
  servers.push(server);
  server.on("connection", (sock) => socketsToNuke.push(sock));
  await listen(server);
  const deadBase = `http://127.0.0.1:${server.address().port}`;
  const base = await startProxy({ _upstreamBase: deadBase, timeoutMs: 200 });
  const res = await fetch(`${base}/session`);
  assert.equal(res.status, 502);
  assert.equal(typeof (await res.json()).error, "string");
});

test("caches GET provider for 60s: one upstream hit, ETag, then 304", async () => {
  resetProxyCache();
  const upstream = startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ providers: [{ id: "anthropic" }, { id: "openai" }] }));
  });
  const base = await startProxy({ _upstream: upstream, cacheKey: "provider" });

  const first = await fetch(`${base}/provider`);
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.ok(etag, "first response must carry an ETag");
  const firstBody = await first.json();
  assert.equal(upstream.hits.get("/provider"), 1);

  const second = await fetch(`${base}/provider`);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("etag"), etag);
  assert.deepEqual(await second.json(), firstBody);
  assert.equal(upstream.hits.get("/provider"), 1, "second request must come from cache");

  const third = await fetch(`${base}/provider`, { headers: { "if-none-match": etag } });
  assert.equal(third.status, 304);
  assert.equal(await third.text(), "");
  assert.equal(upstream.hits.get("/provider"), 1, "304 revalidation must not re-hit upstream");
});

// ---- BUG-08.8: idle timeout instead of a total deadline; limit/before -------

test("BUG-08.8: a slow but steadily streaming body is NOT cut by the total deadline", async () => {
  // 6 chunks × 80 ms = ~480 ms total, far past timeoutMs=200, but never idle
  // for 200 ms: the old total deadline destroyed such responses mid-body.
  const upstream = startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    let i = 0;
    const tick = setInterval(() => {
      if (i === 0) res.write("[");
      res.write(`${i ? "," : ""}${i}`);
      i += 1;
      if (i === 6) {
        clearInterval(tick);
        res.end("]");
      }
    }, 80);
  });
  const base = await startProxy({ _upstream: upstream, timeoutMs: 200 });
  const res = await fetch(`${base}/session/s/message`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [0, 1, 2, 3, 4, 5]);
});

test("BUG-08.8: a body that stalls past idleTimeoutMs is torn down", async () => {
  const upstream = startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("[1,"); // then silence forever
    socketsToNuke.push(res.socket);
  });
  const base = await startProxy({ _upstream: upstream, timeoutMs: 1000, idleTimeoutMs: 150 });
  const res = await fetch(`${base}/x`);
  assert.equal(res.status, 200, "headers already went out");
  await assert.rejects(res.text(), "the stalled body must be aborted, not hang");
});

test("BUG-08.8: paginateMessages slices newest-first pages with a before cursor", () => {
  const list = Array.from({ length: 7 }, (_, i) => ({ info: { id: `m${i}` }, parts: [] }));
  const ids = (r) => r.page.map((m) => m.info.id);
  let r = paginateMessages(list, { limit: 3 });
  assert.deepEqual(ids(r), ["m4", "m5", "m6"]);
  assert.equal(r.hasMore, true);
  assert.equal(r.nextBefore, "m4");
  r = paginateMessages(list, { limit: 3, before: r.nextBefore });
  assert.deepEqual(ids(r), ["m1", "m2", "m3"]);
  r = paginateMessages(list, { limit: 3, before: r.nextBefore });
  assert.deepEqual(ids(r), ["m0"]);
  assert.equal(r.hasMore, false);
  assert.equal(r.nextBefore, null);
  assert.deepEqual(paginateMessages(list, { before: "nope" }), { error: "unknown before cursor" });
  assert.equal(paginateMessages(list, { before: "m6" }).page.length, 6, "default page is 50, capped by what exists");
  assert.equal(pageParams("/session/s/message?directory=D%3A%5Cx"), null, "no paging params → plain proxy");
  assert.equal(pageParams("/m?limit=0").error, "limit must be a positive integer");
  assert.equal(pageParams("/m?limit=100000").limit, 500, "limit is capped");
});

test("BUG-08.8: paginate=true strips limit/before from the upstream call and answers the page", async () => {
  const seen = [];
  const list = Array.from({ length: 5 }, (_, i) => ({ info: { id: `m${i}` }, parts: [] }));
  const upstream = startUpstream((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(list));
  });
  const base = await startProxy({ _upstream: upstream, paginate: true });
  const res = await fetch(`${base}/session/s/message?directory=D%3A%5Cp&limit=2&before=m3`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).map((m) => m.info.id), ["m1", "m2"]);
  assert.equal(res.headers.get("x-zai-has-more"), "1");
  assert.equal(res.headers.get("x-zai-next-before"), "m1");
  assert.equal(seen[0], "/session/s/message?directory=D%3A%5Cp", "upstream (400 on before) never sees limit/before");

  const bad = await fetch(`${base}/session/s/message?before=ghost`);
  assert.equal(bad.status, 400);
  const plain = await fetch(`${base}/session/s/message`);
  assert.equal((await plain.json()).length, 5, "no paging params → the full history as before");
});
