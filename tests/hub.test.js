// Tests for lib/hub.js: one upstream SSE subscription fanned out to many
// browser clients with per-hub sequencing, replay via Last-Event-ID / ?last=,
// ring buffer capping, and zai.resync on reconnect or replay gap.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventHub } from "../lib/hub.js";

const cleanups = [];
after(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

// Fake opencode upstream: one SSE endpoint, tests drive it via emit()/killClients().
function startSseUpstream() {
  const responses = [];
  let connects = 0;
  const waiters = [];
  const server = http.createServer((req, res) => {
    connects += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    // flushHeaders matters: without a write the response event on the hub
    // side would never fire, which the reconnect test depends on.
    res.flushHeaders();
    responses.push(res);
    res.on("close", () => {
      const i = responses.indexOf(res);
      if (i >= 0) responses.splice(i, 1);
    });
    for (const w of waiters.splice(0)) w();
  });
  const basePromise = listen(server).then(() => `http://127.0.0.1:${server.address().port}`);
  return {
    get connectCount() {
      return connects;
    },
    base: basePromise,
    emit(data) {
      for (const r of responses) r.write(`data: ${data}\n\n`);
    },
    killClients() {
      for (const r of responses.splice(0)) r.destroy();
    },
    waitForConnect(n = 1) {
      if (connects >= n) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    async close() {
      this.killClients();
      await new Promise((r) => server.close(r));
    },
  };
}

// Minimal browser-side SSE client: collects parsed frames, ignores comments.
class SseClient {
  constructor(port, { path = "/zai/api/event", headers = {} } = {}) {
    this.frames = [];
    this.#text = "";
    // handleClient() is synchronous from writeHead to set-add, so once the
    // client sees response headers the hub has the client registered.
    this.opened = new Promise((resolve) => {
      this.req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
        this.status = res.statusCode;
        res.setEncoding("utf8");
        res.on("data", (chunk) => this.#feed(chunk));
        resolve();
      });
    });
    // A destroyed socket must not throw an unhandled error into some other test.
    this.req.on("error", (err) => {
      this.error = err;
    });
  }

  #text;

  #feed(chunk) {
    this.#text += chunk;
    let i;
    while ((i = this.#text.indexOf("\n\n")) >= 0) {
      const raw = this.#text.slice(0, i);
      this.#text = this.#text.slice(i + 2);
      // Wire ids are `<epoch>.<seq>` (ADR-005): `id` is the seq number,
      // `rawId` the full wire id a browser would send back as Last-Event-ID.
      let id = null;
      let rawId = null;
      const data = [];
      for (const line of raw.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("id:")) {
          rawId = line.slice(3).trim();
          id = Number(rawId.split(".").pop());
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (id !== null || data.length > 0) this.frames.push({ id, rawId, data: data.join("\n") });
    }
  }

  async waitFor(pred, ms = 5000) {
    const found = this.frames.find(pred);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for frame; have ${JSON.stringify(this.frames)}`)),
        ms,
      );
      const poll = setInterval(() => {
        const f = this.frames.find(pred);
        if (f) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(f);
        }
      }, 20);
    });
  }

  dataFrames() {
    return this.frames.filter((f) => f.data.length > 0);
  }

  close() {
    this.req.destroy();
  }
}

// One full stack (fake upstream + hub + client-facing server) per test, so
// every test starts from seq 1 with an empty ring.
async function startStack({ ringSize, stallAbortMs, stallTickMs } = {}) {
  const upstream = startSseUpstream();
  const hub = new EventHub({ ringSize, stallAbortMs, stallTickMs });
  hub.start(await upstream.base);
  await upstream.waitForConnect(1);
  const server = http.createServer((req, res) => hub.handleClient(req, res));
  await listen(server);
  return {
    upstream,
    hub,
    port: server.address().port,
    client(opts) {
      return new SseClient(server.address().port, opts);
    },
    async stop() {
      hub.stop();
      // A failed test may leak a client socket; closeAllConnections keeps
      // server.close() from hanging the suite on it.
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await upstream.close();
    },
  };
}

test("broadcasts upstream events to all clients with increasing seq ids", async () => {
  const s = await startStack();
  cleanups.push(() => s.stop());
  const a = s.client();
  const b = s.client();
  await a.opened;
  await b.opened;
  const events = [1, 2, 3].map((n) => JSON.stringify({ type: "test", n }));
  for (const e of events) s.upstream.emit(e);

  await a.waitFor((f) => f.id === 3);
  await b.waitFor((f) => f.id === 3);
  for (const c of [a, b]) {
    const frames = c.dataFrames();
    assert.deepEqual(
      frames.map((f) => f.data),
      events,
    );
    const ids = frames.map((f) => f.id);
    assert.deepEqual(ids, [1, 2, 3]);
  }
  a.close();
  b.close();
});

test("Last-Event-ID replays only the events the client missed", async () => {
  const s = await startStack();
  cleanups.push(() => s.stop());
  for (const n of [1, 2, 3]) s.upstream.emit(JSON.stringify({ type: "test", n }));

  const c = s.client({ headers: { "Last-Event-ID": `${s.hub.epoch}.2` } });
  await c.waitFor((f) => f.id === 3 && f.data.includes('"n":3'));
  await new Promise((r) => setTimeout(r, 150)); // let any wrongly-replayed frame arrive
  const frames = c.dataFrames();
  assert.equal(frames.length, 1, `expected exactly the replayed event, got ${JSON.stringify(frames)}`);
  assert.equal(frames[0].id, 3);
  c.close();
});

test("FEAT-12.16: transform rewrites live and replayed frames per client; null drops", async () => {
  const upstream = startSseUpstream();
  const hub = new EventHub({});
  hub.start(await upstream.base);
  await upstream.waitForConnect(1);
  const redact = (data) => (data.includes('"drop"') ? null : data.replace(/secret/g, "***"));
  const server = http.createServer((req, res) => hub.handleClient(req, res, req.url.includes("t=1") ? { transform: redact } : {}));
  await listen(server);
  cleanups.push(async () => {
    hub.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await upstream.close();
  });
  const port = server.address().port;
  const raw = new SseClient(port);
  const red = new SseClient(port, { path: "/zai/api/event?t=1" });
  await raw.opened;
  await red.opened;
  upstream.emit(JSON.stringify({ type: "x", v: "secret" }));
  upstream.emit(JSON.stringify({ type: "drop" }));
  upstream.emit(JSON.stringify({ type: "x", v: "end" }));
  await raw.waitFor((f) => f.id === 3);
  await red.waitFor((f) => f.id === 3);
  assert.deepEqual(raw.dataFrames().map((f) => f.id), [1, 2, 3]);
  assert.deepEqual(red.dataFrames().map((f) => f.id), [1, 3], "a null transform drops the frame");
  assert.ok(raw.dataFrames()[0].data.includes("secret"));
  assert.ok(red.dataFrames()[0].data.includes("***") && !red.dataFrames()[0].data.includes("secret"));
  const replay = new SseClient(port, { path: "/zai/api/event?t=1", headers: { "Last-Event-ID": `${hub.epoch}.0` } });
  await replay.waitFor((f) => f.id === 3);
  assert.deepEqual(replay.dataFrames().map((f) => f.id), [1, 3], "ring replay is transformed too");
  assert.ok(!replay.dataFrames()[0].data.includes("secret"));
  for (const c of [raw, red, replay]) c.close();
});

test("?last= query works like Last-Event-ID", async () => {
  const s = await startStack();
  cleanups.push(() => s.stop());
  for (const n of [1, 2, 3]) s.upstream.emit(JSON.stringify({ type: "test", n }));

  const c = s.client({ path: `/zai/api/event?last=${s.hub.epoch}.2` });
  const frame = await c.waitFor((f) => f.id === 3);
  assert.ok(frame.data.includes('"n":3'));
  c.close();
});

test("client caught up to latest seq gets live events only, no replay", async () => {
  const s = await startStack();
  cleanups.push(() => s.stop());
  for (const n of [1, 2, 3]) s.upstream.emit(JSON.stringify({ type: "test", n }));

  const c = s.client({ headers: { "Last-Event-ID": `${s.hub.epoch}.3` } });
  await c.opened;
  s.upstream.emit(JSON.stringify({ type: "test", n: 4 }));
  const frame = await c.waitFor((f) => f.id === 4);
  assert.ok(frame.data.includes('"n":4'));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.dataFrames().length, 1);
  c.close();
});

test("upstream drop reconnects (backoff) and pushes zai.resync, then live again", async () => {
  const s = await startStack();
  cleanups.push(() => s.stop());
  const c = s.client();
  await c.opened;
  s.upstream.emit(JSON.stringify({ type: "test", n: 1 }));
  await c.waitFor((f) => f.id === 1);

  s.upstream.killClients();
  await s.upstream.waitForConnect(2); // hub retries at 1s backoff
  const resync = await c.waitFor((f) => f.data.includes("zai.resync"), 6000);
  assert.deepEqual(JSON.parse(resync.data), { type: "zai.resync", properties: {} });

  s.upstream.emit(JSON.stringify({ type: "test", n: 2 }));
  await c.waitFor((f) => f.data.includes('"n":2'));
  c.close();
});

test("small ring drops old events; too-old Last-Event-ID yields resync then live", async () => {
  const s = await startStack({ ringSize: 2 });
  cleanups.push(() => s.stop());
  for (const n of [1, 2, 3, 4, 5]) s.upstream.emit(JSON.stringify({ type: "test", n }));
  // ring now holds only seq 4 and 5.

  const stale = s.client({ headers: { "Last-Event-ID": `${s.hub.epoch}.1` } });
  const resync = await stale.waitFor((f) => f.data.includes("zai.resync"));
  assert.deepEqual(JSON.parse(resync.data), { type: "zai.resync", properties: {} });
  assert.equal(resync.rawId, `${s.hub.epoch}.5`, "gap resync carries the CURRENT position, so the next reconnect resumes from here");

  s.upstream.emit(JSON.stringify({ type: "test", n: 6 }));
  await stale.waitFor((f) => f.id === 6 && f.data.includes('"n":6'));

  const fresh = s.client({ headers: { "Last-Event-ID": `${s.hub.epoch}.4` } });
  const replayed = await fresh.waitFor((f) => f.id === 5);
  assert.ok(replayed.data.includes('"n":5'));

  stale.close();
  fresh.close();
});

test("handles CRLF, multi-line data and comment lines from upstream", async () => {
  // Feed raw bytes with \r\n endings, a comment heartbeat and a two-line data
  // frame; the hub must dispatch the joined payload as one event.
  const raw = {
    responses: [],
    server: null,
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    raw.responses.push(res);
  });
  const base = await listen(server).then(() => `http://127.0.0.1:${server.address().port}`);
  const hub = new EventHub();
  hub.start(base);
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (raw.responses.length > 0) {
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });
  const clientServer = http.createServer((req, res) => hub.handleClient(req, res));
  await listen(clientServer);
  cleanups.push(async () => {
    hub.stop();
    clientServer.closeAllConnections();
    await new Promise((r) => clientServer.close(r));
    for (const r of raw.responses) r.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const c = new SseClient(clientServer.address().port);
  await c.opened;
  raw.responses[0].write(": heartbeat\r\n\r\n");
  raw.responses[0].write('data: {"type":"multiline",\r\ndata: "part":"two"}\r\n\r\n');
  const frame = await c.waitFor((f) => f.data.includes("multiline"));
  assert.equal(frame.id, 1);
  assert.deepEqual(JSON.parse(frame.data), { type: "multiline", part: "two" });
  c.close();
});

test("multi-directory: syncDirectories subscribes new dirs, pinned dir survives", async () => {
  // Upstream filters /event per directory (live 1.19.5 behavior): each
  // directory needs its own subscription. /session answers the JSON list.
  //
  // The fixture answers every REST route syncDirectories() touches
  // (/session/status, /permission, /question, message lists) with JSON:
  // the old SSE-on-any-path fixture made each of those fetches hang until
  // the 8 s AbortSignal.timeout (32 s per run) AND satisfied waitForConn
  // with a /session/status request instead of a real /event subscription
  // (tests.md §1.3, §3.1-1). Only /event counts as a subscription now.
  const connsByDir = new Map(); // directory -> res[]
  let sessionList = [{ directory: "C:\\Home" }];
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessionList));
      return;
    }
    if (url.pathname !== "/event") {
      const empty = url.pathname === "/session/status" ? {} : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(empty));
      return;
    }
    const dir = url.searchParams.get("directory") ?? "";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    if (!connsByDir.has(dir)) connsByDir.set(dir, []);
    connsByDir.get(dir).push(res);
  });
  const base = await listen(upstream).then(() => `http://127.0.0.1:${upstream.address().port}`);
  const hub = new EventHub();
  hub.start(base, { directory: "C:\\Home" });
  const clientServer = http.createServer((req, res) => hub.handleClient(req, res));
  await listen(clientServer);
  cleanups.push(async () => {
    hub.stop();
    clientServer.closeAllConnections();
    await new Promise((r) => clientServer.close(r));
    for (const list of connsByDir.values()) for (const r of list) r.destroy();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  });

  const waitForConn = async (dir) => {
    for (let i = 0; i < 100 && !connsByDir.get(dir)?.length; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(connsByDir.get(dir)?.length, `upstream must hold a connection for ${dir}`);
  };
  const emit = (dir, data) => {
    for (const r of connsByDir.get(dir) ?? []) r.write(`data: ${data}\n\n`);
  };

  await waitForConn("C:\\Home");
  const c = new SseClient(clientServer.address().port);
  await c.opened;

  // sanity: pinned dir events already flow
  emit("C:\\Home", JSON.stringify({ type: "home", n: 1 }));
  await c.waitFor((f) => f.data.includes('"home"'));

  // a session appears in a second directory → sync must subscribe to it
  sessionList = [{ directory: "C:\\Home" }, { directory: "D:\\Proj" }];
  await hub.syncDirectories();
  await waitForConn("D:\\Proj");
  emit("D:\\Proj", JSON.stringify({ type: "proj", n: 2 }));
  await c.waitFor((f) => f.data.includes('"proj"'));
  c.close();

  // the pinned dir is never dropped, even when /session no longer lists it
  sessionList = [{ directory: "D:\\Proj" }];
  await hub.syncDirectories();
  emit("C:\\Home", JSON.stringify({ type: "home", n: 3 }));
  const c2 = new SseClient(clientServer.address().port);
  await c2.opened;
  emit("C:\\Home", JSON.stringify({ type: "home", n: 4 }));
  await c2.waitFor((f) => f.data.includes('"n":4'));
  c2.close();
});

// ---- stall watchdog: busy tracking, auto-abort, per-directory seeding -------
// Live background (2026-10-31): a turn can hang forever (tool future lost or
// provider hang) — opencode 1.19.5 has no watchdog, the queued user message
// never processes, and the chat is dead until an operator aborts it. The hub
// tracks busy sessions from SSE and auto-aborts silent ones.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Richer fake upstream: SSE + POST recording (path AND body) + JSON /session,
// per-directory /session/status, per-directory /permission + /question
// listings (all four are directory-scoped), and per-session message lists
// for GET /session/:id/message (the replay sweep reads tails from there).
function startAbortUpstream({ sessionList = [], statusByDir = {}, permissionByDir = {}, questionByDir = {}, messagesById = {} } = {}) {
  const posts = [];
  const sseResponses = [];
  const sseWaiters = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        posts.push({ url: req.url, path: url.pathname, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("true");
      });
      return;
    }
    if (url.pathname === "/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessionList));
      return;
    }
    if (url.pathname === "/session/status") {
      const dir = url.searchParams.get("directory") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(statusByDir[dir] ?? {}));
      return;
    }
    if (url.pathname === "/permission") {
      const dir = url.searchParams.get("directory") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(permissionByDir[dir] ?? []));
      return;
    }
    if (url.pathname === "/question") {
      const dir = url.searchParams.get("directory") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(questionByDir[dir] ?? []));
      return;
    }
    // GET /session/:id/message — the entries are {info, parts} pairs, the
    // live 1.19.5 shape the hub's tail reader must tolerate.
    if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/message")) {
      const sid = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(messagesById[sid] ?? []));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    sseResponses.push(res);
    res.on("close", () => {
      const i = sseResponses.indexOf(res);
      if (i >= 0) sseResponses.splice(i, 1);
    });
    for (const w of sseWaiters.splice(0)) w();
  });
  const basePromise = listen(server).then(() => `http://127.0.0.1:${server.address().port}`);
  return {
    posts,
    base: basePromise,
    emitSse(data) {
      for (const r of sseResponses) r.write(`data: ${data}\n\n`);
    },
    async close() {
      for (const r of sseResponses.splice(0)) r.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

test("busy tracking: status frames fill the snapshot, idle shapes clear it", async () => {
  const s = await startStack();
  cleanups.push(() => s.stop());
  const sid = "ses_busy1";
  const busy = (t) => JSON.stringify({ type: "session.status", properties: { sessionID: sid, status: t } });

  s.upstream.emit(busy({ type: "busy" }));
  await sleep(60);
  const since = s.hub.busySnapshot()[sid];
  assert.ok(since, "busy frame must register the session");

  s.upstream.emit(busy({ type: "busy" }));
  await sleep(60);
  assert.equal(s.hub.busySnapshot()[sid], since, "repeated busy frames keep the original since");

  s.upstream.emit(busy({ type: "idle" }));
  await sleep(60);
  assert.equal(s.hub.busySnapshot()[sid], undefined, "{type:'idle'} clears (live wire shape is an object)");

  s.upstream.emit(busy({ type: "retry", attempt: 1 }));
  await sleep(60);
  assert.ok(s.hub.busySnapshot()[sid], "retry is a busy flavor, not idle");

  s.upstream.emit(JSON.stringify({ type: "session.idle", properties: { sessionID: sid } }));
  await sleep(60);
  assert.equal(s.hub.busySnapshot()[sid], undefined, "session.idle clears");
});

test("stall watchdog aborts a silent busy session, spares a dialog-parked one", async () => {
  const up = startAbortUpstream();
  const hub = new EventHub({ stallAbortMs: 100, stallTickMs: 40 });
  hub.start(await up.base);
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150); // let the hub SSE connection establish

  up.emitSse(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } }));
  // ses_b goes busy but parks on a permission dialog: legit silence
  up.emitSse(JSON.stringify({ type: "permission.asked", properties: { sessionID: "ses_b", id: "per_1" } }));
  up.emitSse(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_b", status: { type: "busy" } } }));

  await sleep(600);
  assert.equal(
    up.posts.filter((p) => p.path === "/session/ses_a/abort").length,
    1,
    "a busy session silent past the stall window gets exactly one abort",
  );
  assert.equal(
    up.posts.filter((p) => p.path === "/session/ses_b/abort").length,
    0,
    "a session parked on a permission dialog must not be aborted",
  );

  // dialog answered → the stall clock applies to ses_b on a later tick
  up.emitSse(JSON.stringify({ type: "permission.replied", properties: { sessionID: "ses_b", id: "per_1" } }));
  await sleep(600);
  assert.ok(
    up.posts.some((p) => p.path === "/session/ses_b/abort"),
    "once the dialog is gone, silence past the window aborts too",
  );
});

test("stall abort carries the session directory (upstream is directory-scoped)", async () => {
  const up = startAbortUpstream({ sessionList: [{ id: "ses_d", directory: "C:\\Home" }] });
  const hub = new EventHub({ stallAbortMs: 100, stallTickMs: 40 });
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);

  up.emitSse(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_d", status: { type: "busy" } } }));
  await sleep(600);
  const hit = up.posts.find((p) => p.path === "/session/ses_d/abort");
  assert.ok(hit, "stalled session must be aborted");
  assert.equal(
    new URL("http://x" + hit.url).searchParams.get("directory"),
    "C:\\Home",
    "abort must carry the directory it was seen on",
  );
});

test("syncDirectories seeds busy sessions from per-directory /session/status", async () => {
  const up = startAbortUpstream({
    sessionList: [
      { id: "ses_h", directory: "C:\\Home" },
      { id: "ses_p", directory: "D:\\Proj" },
    ],
    statusByDir: {
      "C:\\Home": { ses_h: { type: "busy" } },
      "D:\\Proj": {},
    },
  });
  const hub = new EventHub(); // stallAbortMs unset: seeding only, no auto-abort
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await hub.syncDirectories();
  await sleep(50);
  const snap = hub.busySnapshot();
  assert.ok(snap.ses_h, "a turn hung before the hub started must enter the watchlist via seeding");
  assert.equal(snap.ses_p, undefined, "idle directories contribute nothing");
  assert.deepEqual(
    hub.directories().sort(),
    ["C:\\Home", "D:\\Proj"],
    "directories() exposes the subscription set for the merged status endpoint",
  );
});

// ---- open dialogs: snapshot, timeout auto-deny, REST collection -------------
// 2026-11-01: five sessions were found parked 15-40 minutes on permission
// dialogs. Two root causes: freshly loaded clients never see a past .asked
// (SSE is not state), and nothing ever resolves an unanswered dialog. The hub
// tracks dialogs with payloads, exposes them for the /zai/api/dialogs seed,
// and auto-denies dialogs older than dialogTimeoutMs so the turn continues.

test("open dialogs enter the snapshot with payloads; replies and session.idle clear it", async () => {
  const up = startAbortUpstream();
  const hub = new EventHub();
  hub.start(await up.base);
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);

  up.emitSse(
    JSON.stringify({
      type: "permission.asked",
      properties: { sessionID: "ses_d1", id: "per_1", permission: "bash", metadata: { command: "rm x" } },
    }),
  );
  up.emitSse(JSON.stringify({ type: "question.asked", properties: { sessionID: "ses_d1", id: "que_1" } }));
  await sleep(60);
  let snap = hub.dialogsSnapshot();
  assert.deepEqual(snap.map((d) => d.id).sort(), ["per_1", "que_1"]);
  const perm = snap.find((d) => d.id === "per_1");
  assert.equal(perm.kind, "permission");
  assert.equal(perm.props.metadata.command, "rm x", "the ask payload rides on the snapshot for the REST seed");
  assert.ok(typeof perm.askedAt === "number");

  up.emitSse(JSON.stringify({ type: "permission.replied", properties: { sessionID: "ses_d1", id: "per_1" } }));
  await sleep(60);
  assert.deepEqual(hub.dialogsSnapshot().map((d) => d.id), ["que_1"], "a replied dialog leaves the snapshot");

  up.emitSse(JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_d1" } }));
  await sleep(60);
  assert.equal(hub.dialogsSnapshot().length, 0, "session.idle clears whatever asks remain");
});

test("dialog timeout: an unanswered permission auto-rejects with the seen directory", async () => {
  const up = startAbortUpstream();
  const hub = new EventHub({ dialogTimeoutMs: 120, stallTickMs: 40 });
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);

  up.emitSse(
    JSON.stringify({ type: "permission.asked", properties: { sessionID: "ses_t", id: "per_t", permission: "bash" } }),
  );
  await sleep(500);
  const hit = up.posts.find((p) => p.path === "/permission/per_t/reply");
  assert.ok(hit, "an unanswered permission must be auto-rejected");
  assert.equal(
    new URL("http://x" + hit.url).searchParams.get("directory"),
    "C:\\Home",
    "the reply must reach the instance that owns the request (directory-scoped)",
  );
  assert.deepEqual(JSON.parse(hit.body), { reply: "reject" });
  assert.equal(hub.dialogsSnapshot().length, 0, "the denied dialog leaves the snapshot");
});

test("dialog timeout: an unanswered question is dismissed via /question/:id/reject", async () => {
  const up = startAbortUpstream();
  const hub = new EventHub({ dialogTimeoutMs: 120, stallTickMs: 40 });
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);

  up.emitSse(JSON.stringify({ type: "question.asked", properties: { sessionID: "ses_q", id: "que_t" } }));
  await sleep(500);
  const hit = up.posts.find((p) => p.path === "/question/que_t/reject");
  assert.ok(hit, "an unanswered question must be auto-dismissed");
  assert.equal(new URL("http://x" + hit.url).searchParams.get("directory"), "C:\\Home");
});

test("collectDialogs merges upstream REST asks; local ask times win, unknown age sorts last", async () => {
  const up = startAbortUpstream({
    permissionByDir: {
      "C:\\Home": [
        // per_live also exists upstream (it is the same live ask, listed by
        // the authoritative REST route); per_u is upstream-only (asked while
        // the hub was down, unknown age here).
        { id: "per_live", sessionID: "ses_l", permission: "bash" },
        { id: "per_u", sessionID: "ses_u", permission: "bash", metadata: { command: "rm junk" } },
      ],
    },
  });
  const hub = new EventHub();
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);

  up.emitSse(JSON.stringify({ type: "permission.asked", properties: { sessionID: "ses_l", id: "per_live" } }));
  await sleep(60);
  const list = await hub.collectDialogs();
  assert.deepEqual(
    list.map((d) => d.id),
    ["per_live", "per_u"],
    "locally-known age first, upstream-only (unknown age) last",
  );
  assert.ok(list.find((d) => d.id === "per_live").askedAt > 0, "the snapshot's ask time wins over upstream's unknown");
  assert.equal(list.find((d) => d.id === "per_u").kind, "permission");
  assert.equal(list.find((d) => d.id === "per_u").directory, "C:\\Home");
  assert.equal(list.find((d) => d.id === "per_u").askedAt, null, "upstream alone cannot know the ask time");
});

test("syncDirectories seeds pre-existing upstream dialogs (hub restart must not go blind)", async () => {
  const up = startAbortUpstream({
    permissionByDir: { "C:\\Home": [{ id: "per_pre", sessionID: "ses_pre", permission: "bash" }] },
  });
  const hub = new EventHub();
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await hub.syncDirectories();
  const snap = hub.dialogsSnapshot();
  const seeded = snap.find((d) => d.id === "per_pre");
  assert.ok(seeded, "a pre-existing ask must seed into the snapshot");
  assert.ok(typeof seeded.askedAt === "number", "seeded dialogs get a full timeout window of grace");
});

// ---- unanswered-prompt replay (the idle-poison case) --------------------------
// 2026-11-01, a chat hung with nothing displayed: a run whose fiber
// died (or was aborted) leaves the session IDLE with user prompts persisted
// but never replayed from opencode's queue. No busy flag → the busy killer
// never fires; no spinner → the user sees nothing. The hub tracks the last
// unanswered prompt, exposes it for /zai/api/status, and re-posts it
// upstream (model/agent copied from the latest assistant message).

test("REGRESSION: watchdog options passed to start() activate the killer too", async () => {
  // server.js once constructed `new EventHub()` bare and passed
  // stallAbortMs/dialogTimeoutMs HERE — the old start() signature silently
  // dropped them and the whole auto-unstick layer ran disabled in production.
  const up = startAbortUpstream();
  const hub = new EventHub();
  hub.start(await up.base, { stallAbortMs: 100, stallTickMs: 40 });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);
  up.emitSse(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_w", status: { type: "busy" } } }));
  await sleep(600);
  assert.ok(
    up.posts.some((p) => p.path === "/session/ses_w/abort"),
    "start()-passed stallAbortMs must arm the watchdog (production wiring)",
  );
});

test("pending tracking: user prompt enters, assistant content clears, idle keeps it", async () => {
  const up = startAbortUpstream();
  const hub = new EventHub({ stallReplayMs: 10 * 60_000 }); // window far away: pure tracking assertions
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);

  const userMsg = (id) => JSON.stringify({ type: "message.updated", properties: { sessionID: "ses_p", info: { id, role: "user", time: { created: Date.now() } } } });
  up.emitSse(userMsg("msg_u1"));
  await sleep(60);
  assert.ok(hub.pendingSnapshot().ses_p, "a persisted user prompt must enter the pending map");

  // assistant message shell (0 parts — the dead-turn shape) must NOT count as an answer
  up.emitSse(JSON.stringify({ type: "message.updated", properties: { sessionID: "ses_p", info: { id: "msg_a1", role: "assistant", parts: [] } } }));
  await sleep(60);
  assert.ok(hub.pendingSnapshot().ses_p, "a 0-part assistant shell is not an answer");

  // part traffic on the assistant message means the prompt is being answered
  up.emitSse(JSON.stringify({ type: "message.part.updated", properties: { sessionID: "ses_p", part: { id: "part_1", messageID: "msg_a1", type: "step-start" } } }));
  await sleep(60);
  assert.equal(hub.pendingSnapshot().ses_p, undefined, "assistant part traffic clears the pending prompt");

  // ...and idle must NOT clear a fresh pending (idle + pending is the poison)
  up.emitSse(userMsg("msg_u2"));
  await sleep(60);
  up.emitSse(JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_p" } }));
  await sleep(60);
  assert.ok(hub.pendingSnapshot().ses_p, "session.idle must keep the unanswered prompt visible");
});

test("stalledSnapshot: a fresh queued prompt is not a hang, an aged one is", async () => {
  // Live 2026-11-01: the banner fired on every between-turns gap — a message
  // queued behind a running turn (or a turn still warming up) armed pending
  // and the wire reported it immediately as «Ход завис — попытка 1/2» while
  // nothing was hung. The wire face must age-gate: only prompts that sat past
  // the replay window are the honest banner state.
  const up = startAbortUpstream();
  const hub = new EventHub({ stallReplayMs: 150, stallTickMs: 10 * 60_000 }); // the sweep never fires during the test
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);

  up.emitSse(JSON.stringify({ type: "message.updated", properties: { sessionID: "ses_st", info: { id: "msg_s1", role: "user", time: { created: Date.now() } } } }));
  await sleep(60);
  assert.equal(hub.stalledSnapshot().ses_st, undefined, "a fresh entry is a queued/starting turn — the banner must not lie");
  assert.ok(hub.pendingSnapshot().ses_st, "the tracker still holds it for the sweep");

  await sleep(220); // past the 150ms window; the sweep never fires (huge tick)
  assert.ok(hub.stalledSnapshot().ses_st, "a prompt past the replay window is the honest banner state");
});

test("BUG-016: post-turn message.updated of an ANSWERED prompt does not re-arm pending", async () => {
  // Dogfood 2026-11-02: opencode re-emits message.updated for the same user
  // message after the turn (summary/title) — the tracker re-armed it with
  // at=now and the «Ответ не пришёл» banner showed under a delivered answer.
  const up = startAbortUpstream();
  const hub = new EventHub({ stallReplayMs: 10 * 60_000 });
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);

  const userMsg = (id) => JSON.stringify({ type: "message.updated", properties: { sessionID: "ses_ra", info: { id, role: "user", time: { created: Date.now() } } } });
  up.emitSse(userMsg("msg_u1"));
  await sleep(60);
  up.emitSse(JSON.stringify({ type: "message.part.updated", properties: { sessionID: "ses_ra", part: { id: "p1", messageID: "msg_a1", type: "text" } } }));
  await sleep(60);
  assert.equal(hub.pendingSnapshot().ses_ra, undefined, "answered");
  up.emitSse(JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_ra" } }));
  up.emitSse(userMsg("msg_u1")); // the post-turn re-emit of the SAME user message
  await sleep(60);
  assert.equal(hub.pendingSnapshot().ses_ra, undefined, "an answered prompt must not come back as pending");

  up.emitSse(userMsg("msg_u2")); // a genuinely new prompt still arms
  await sleep(60);
  assert.ok(hub.pendingSnapshot().ses_ra, "a new user message enters pending");
  const at = hub.pendingSnapshot().ses_ra.at;
  await sleep(30);
  up.emitSse(userMsg("msg_u2")); // re-emit of the still-unanswered prompt keeps its clock
  await sleep(60);
  assert.equal(hub.pendingSnapshot().ses_ra.at, at, "the stall clock must not be refreshed by updates of the same prompt");
});

test("BUG-016: maxPromptReplays=0 does not mark a fresh entry exhausted", async () => {
  const up = startAbortUpstream();
  const hub = new EventHub({ stallReplayMs: 150, stallTickMs: 10 * 60_000, maxPromptReplays: 0 });
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);
  up.emitSse(JSON.stringify({ type: "message.updated", properties: { sessionID: "ses_m0", info: { id: "msg_z", role: "user", time: { created: Date.now() } } } }));
  await sleep(60);
  assert.equal(hub.stalledSnapshot().ses_m0, undefined, "max=0 is «no auto-replay», not an instant banner");
  await sleep(220);
  assert.ok(hub.stalledSnapshot().ses_m0, "after the window the honest manual-resend state shows");
});

test("replay sweep re-posts an unanswered prompt with model/agent, capped per episode", async () => {
  const messagesById = {
    ses_r: [
      {
        info: { id: "msg_a0", role: "assistant", providerID: "zai-coding-plan", modelID: "glm-5.3", agent: "Sisyphus - ultraworker", time: { created: 1, completed: 2 } },
        parts: [{ type: "text", text: "prev answer" }],
      },
      {
        info: { id: "msg_u1", role: "user", time: { created: Date.now() - 60_000 } },
        parts: [
          { id: "p1", type: "text", text: "зависший вопрос" },
          { id: "p2", type: "file", mime: "image/png", filename: "x.png", url: "data:image/png;base64,xx" },
        ],
      },
      { info: { id: "msg_a2", role: "assistant", time: { created: Date.now() } }, parts: [] },
    ],
  };
  const up = startAbortUpstream({ messagesById });
  const hub = new EventHub({ stallReplayMs: 100, stallTickMs: 40, maxPromptReplays: 1 });
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);

  up.emitSse(JSON.stringify({ type: "message.updated", properties: { sessionID: "ses_r", info: { id: "msg_u1", role: "user", time: { created: Date.now() } } } }));
  await sleep(700);

  const hits = up.posts.filter((p) => p.path === "/session/ses_r/prompt_async");
  assert.equal(hits.length, 1, "exactly one replay must fire (cap 1)");
  assert.equal(
    new URL("http://x" + hits[0].url).searchParams.get("directory"),
    "C:\\Home",
    "the replay must reach the session's own instance (directory-scoped)",
  );
  const body = JSON.parse(hits[0].body);
  assert.deepEqual(body.parts, [
    { type: "text", text: "зависший вопрос" },
    { type: "file", mime: "image/png", filename: "x.png", url: "data:image/png;base64,xx" },
  ], "the replay carries the sanitized parts of the unanswered prompt");
  assert.deepEqual(body.model, { providerID: "zai-coding-plan", modelID: "glm-5.3" }, "model copied from the latest assistant message");
  assert.equal(body.agent, "Sisyphus - ultraworker", "agent copied from the latest assistant message");
  assert.equal(hub.pendingSnapshot().ses_r.replays, 1, "the snapshot counts the fired replay");
  assert.equal(hub.pendingSnapshot().ses_r.max, 1);
  assert.ok(hub.stalledSnapshot().ses_r, "an exhausted entry stays on the wire for the manual «Отправить снова» exit");

  await sleep(500); // another full window: the cap must hold even though the tail is still unanswered
  assert.equal(
    up.posts.filter((p) => p.path === "/session/ses_r/prompt_async").length,
    1,
    "no second replay inside the same episode",
  );
});

test("pending tracking: a COMPLETED 0-part shell is an answer (provider-failure shells)", async () => {
  // Live 2026-11-01: turns that die on provider failures (ENOTFOUND etc.) end
  // as assistant messages with time.completed set and NO parts — on the event
  // wire parts never ride message.updated at all. Such a shell consumed the
  // prompt; treating it as a hung turn made every finished chat look orphaned
  // and the banner re-armed for minutes after every completed task.
  const up = startAbortUpstream();
  const hub = new EventHub({ stallReplayMs: 10 * 60_000 });
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);

  up.emitSse(JSON.stringify({ type: "message.updated", properties: { sessionID: "ses_pc", info: { id: "msg_u", role: "user", time: { created: Date.now() } } } }));
  await sleep(60);
  assert.ok(hub.pendingSnapshot().ses_pc, "user prompt enters pending");

  up.emitSse(JSON.stringify({ type: "message.updated", properties: { sessionID: "ses_pc", info: { id: "msg_a", role: "assistant", time: { created: Date.now(), completed: Date.now() } } } }));
  await sleep(60);
  assert.equal(hub.pendingSnapshot().ses_pc, undefined, "a completed shell consumed the prompt — pending must clear");
});

test("replay sweep treats a completed 0-part shell as an answer (no replay on provider-failure tails)", async () => {
  const messagesById = {
    ses_cs: [
      { info: { id: "msg_u", role: "user", time: { created: Date.now() - 60_000 } }, parts: [{ type: "text", text: "died turn" }] },
      { info: { id: "msg_a", role: "assistant", time: { created: Date.now() - 30_000, completed: Date.now() - 30_000 } }, parts: [] },
    ],
  };
  const up = startAbortUpstream({ messagesById });
  const hub = new EventHub({ stallReplayMs: 100, stallTickMs: 40 });
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(700);

  assert.equal(
    up.posts.filter((p) => p.path === "/session/ses_cs/prompt_async").length,
    0,
    "a completed shell answered the prompt — no replay may fire",
  );
  assert.equal(hub.pendingSnapshot().ses_cs, undefined, "and nothing may linger in the pending map");
});

test("replay retry is preceded by an abort (dead-queue unstick)", async () => {
  // The first replay lands upstream but nothing answers: the queue is dead.
  // Field playbook (2026-10-31): only an ABORT unsticks it — so attempt 2
  // must be preceded by POST /session/:id/abort.
  const messagesById = {
    ses_ab: [
      { info: { id: "msg_a0", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "old answer" }] },
      { info: { id: "msg_u1", role: "user", time: { created: Date.now() - 60_000 } }, parts: [{ type: "text", text: "stuck prompt" }] },
    ],
  };
  const up = startAbortUpstream({ messagesById });
  const hub = new EventHub({ stallReplayMs: 100, stallTickMs: 40, maxPromptReplays: 2 });
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);
  up.emitSse(JSON.stringify({ type: "message.updated", properties: { sessionID: "ses_ab", info: { id: "msg_u1", role: "user", time: { created: Date.now() } } } }));
  await sleep(2600); // replay #1 → window → abort → replay #2

  const paths = up.posts.map((p) => p.path);
  const r1 = paths.indexOf("/session/ses_ab/prompt_async");
  const ab = paths.indexOf("/session/ses_ab/abort");
  const r2 = paths.lastIndexOf("/session/ses_ab/prompt_async");
  assert.ok(r1 !== -1 && r2 > r1, `two replays expected, got ${JSON.stringify(paths)}`);
  assert.ok(ab > r1 && ab < r2, `abort must sit between the replays, got ${JSON.stringify(paths)}`);
  assert.equal(hub.pendingSnapshot().ses_ab.replays, 2, "both attempts counted");
});

test("replay sweep skips busy sessions and answered tails", async () => {
  const messagesById = {
    ses_busy: [
      { info: { id: "msg_u", role: "user", time: { created: Date.now() - 60_000 } }, parts: [{ type: "text", text: "while busy" }] },
      { info: { id: "msg_a", role: "assistant", time: { created: Date.now() } }, parts: [] },
    ],
    ses_ok: [
      { info: { id: "msg_u2", role: "user", time: { created: Date.now() - 60_000 } }, parts: [{ type: "text", text: "answered one" }] },
      { info: { id: "msg_a2", role: "assistant", providerID: "p", modelID: "m", time: { created: Date.now(), completed: Date.now() } }, parts: [{ type: "text", text: "done" }] },
    ],
  };
  const up = startAbortUpstream({ messagesById });
  const hub = new EventHub({ stallReplayMs: 100, stallTickMs: 40 });
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await sleep(150);

  up.emitSse(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_busy", status: { type: "busy" } } }));
  up.emitSse(JSON.stringify({ type: "message.updated", properties: { sessionID: "ses_busy", info: { id: "msg_u", role: "user", time: { created: Date.now() } } } }));
  await sleep(700);
  assert.equal(
    up.posts.filter((p) => p.path.endsWith("/prompt_async")).length,
    0,
    "a busy session's queued prompt must wait for the abort sweep, not race a replay",
  );

  up.emitSse(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_ok", status: { type: "idle" } } }));
  await sleep(100);
  assert.equal(hub.pendingSnapshot().ses_ok, undefined, "an answered tail is never pending");
});

test("boot seed rebuilds pending for prompts that died before the hub started", async () => {
  // GET /session is sorted NEWEST-first upstream; the seed must keep the
  // newest half, not the oldest (a naive slice(-50) missed every freshly
  // poisoned chat — live 2026-11-01). 60 decoys + the target at the top
  // reproduce that trap cheaply (decoys answer an empty message list).
  const decoys = Array.from({ length: 60 }, (_, i) => ({ id: `ses_d${i}`, directory: "C:\\Home", time: { updated: Date.now() - (i + 1) * 60_000 } }));
  const messagesById = {
    ses_seed: [
      { info: { id: "msg_old_a", role: "assistant", providerID: "p", modelID: "m", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "done" }] },
      { info: { id: "msg_old_u", role: "user", time: { created: Date.now() - 10 * 60_000 } }, parts: [{ type: "text", text: "пропавший вопрос" }] },
      { info: { id: "msg_old_a2", role: "assistant", time: { created: Date.now() - 9 * 60_000 } }, parts: [] },
    ],
    ses_stale: [
      { info: { id: "msg_ancient_u", role: "user", time: { created: Date.now() - 3 * 24 * 60 * 60_000 } }, parts: [{ type: "text", text: "three days old" }] },
      { info: { id: "msg_ancient_a", role: "assistant", time: { created: Date.now() - 3 * 24 * 60 * 60_000 } }, parts: [] },
    ],
  };
  const up = startAbortUpstream({
    sessionList: [{ id: "ses_seed", directory: "C:\\Home", time: { updated: Date.now() - 9 * 60_000 } }, { id: "ses_stale", directory: "C:\\Home", time: { updated: Date.now() - 3 * 24 * 60 * 60_000 } }, ...decoys],
    messagesById,
  });
  const hub = new EventHub({ stallReplayMs: 100, stallTickMs: 40, maxPromptReplays: 2 });
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });

  await hub.syncDirectories();
  const snap = hub.pendingSnapshot();
  assert.ok(snap.ses_seed, "an unanswered prompt from before the restart must seed");
  assert.equal(snap.ses_stale, undefined, "a >24h-old orphan is stale history, not a live hang");

  await sleep(700);
  const hit = up.posts.find((p) => p.path === "/session/ses_seed/prompt_async");
  assert.ok(hit, "the seeded pending prompt gets replayed by the sweep");
  assert.deepEqual(JSON.parse(hit.body).parts, [{ type: "text", text: "пропавший вопрос" }]);
});
