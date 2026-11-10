// Contract tests for the REAL proxy path (no mock): server.js is spawned
// against a fake upstream and the test asserts the exact upstream URLs —
// the directory-pinning rules are load-bearing (system32 incident 2026-10-31,
// silent-empty cross-directory reads verified live on 1.19.5).
// Since tenancy landed, every API call rides the admin session cookie: the
// suite logs in first (ZAI_ADMIN_TOKEN) and asserts the same upstream
// contracts as before — tenancy must be transparent for the admin tenant.
// Run: node --test tests/server.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// A REAL directory: the prompt transformation writes uploads into
// <ZAI_HOME>/.zai-uploads, and POST /session mkdirs the directory.
const HOME_DIR = mkdtempSync(path.join(tmpdir(), "zai-server-test-"));
const HOME = HOME_DIR;
const ADMIN_TOKEN = "s".repeat(20) + "-server-test-admin-" + "7".repeat(24);
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "zai-server-data-"));
// a project folder outside HOME (absolute on every OS; the route mkdirs it)
const PROJ = path.join(DATA_DIR, "Proj");

// Fake upstream: records every hit (prompt bodies too), answers JSON. The
// SSE hub will also poll /event here and retry with backoff — assertions
// filter /event out.
const seen = [];
const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // GET /session must answer a REAL array (session list): the hub's
  // syncDirectories early-returns on non-arrays, and its dialog/busy seeding
  // rides on this call.
  if (req.method === "GET" && url.pathname === "/session") {
    seen.push({ url: req.url, method: req.method, body: Buffer.alloc(0) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: "ses_up", directory: HOME }]));
    return;
  }
  // Open-dialog listings (hub seeds/collects from these on start and sync).
  // The hub hit is journaled with a dummy body: assertions only care that
  // the call happened with the right query.
  if (url.pathname === "/permission") {
    seen.push({ url: req.url, method: req.method, body: Buffer.alloc(0) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: "per_up", sessionID: "ses_up", permission: "bash", metadata: { command: "rm junk" } }]));
    return;
  }
  // BUG-08.8: a 5-message history for the pagination contract.
  if (req.method === "GET" && url.pathname === "/session/ses_page/message") {
    seen.push({ url: req.url, method: req.method, body: Buffer.alloc(0) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([1, 2, 3, 4, 5].map((n) => ({ info: { id: `msg_${n}`, role: "user" }, parts: [] }))));
    return;
  }
  if (url.pathname === "/question") {
    seen.push({ url: req.url, method: req.method, body: Buffer.alloc(0) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([]));
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    seen.push({ url: req.url, method: req.method, body: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

// Isolated env (TASK-14.4): no ZAI_* inherited from the shell.
const srv = await spawnPortal({
  upstream: `http://127.0.0.1:${upstream.address().port}`,
  env: { ZAI_HOME: HOME, ZAI_CHAT_DIR: HOME, ZAI_DATA_DIR: DATA_DIR, ZAI_ADMIN_TOKEN: ADMIN_TOKEN },
});
// Same teardown contract as claude-server.test.js: kill the portal FIRST
// (it holds HOME handles — an EPERM in an early after hook makes node:test
// skip the rest, leaving the child alive and the runner hanging forever).
after(async () => {
  await srv.stop();
  upstream.close();
  rmSync(HOME_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const base = srv.base;

// Admin session: everything below rides the login cookie the same way the
// real UI does after the token paste.
const loginRes = await fetch(`${base}/zai/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: ADMIN_TOKEN }),
});
assert.equal(loginRes.status, 200, "admin login must succeed before the contract suite");
const AUTH = (typeof loginRes.headers.getSetCookie === "function" ? loginRes.headers.getSetCookie() : [loginRes.headers.get("set-cookie")].filter(Boolean))
  .join("\n")
  .match(/zai_t=[^;]+/)[0];

// API hits only — the hub's background /event subscription is noise here.
// Every call carries the admin cookie: without it the API answers 401.
// (Named `call` on purpose: several tests declare a local `hit` for the
// upstream journal entry, and shadowing the fetcher would TDZ-crash them.)
function call(p, opts = {}) {
  return fetch(`${base}${p}`, { ...opts, headers: { ...(opts.headers ?? {}), cookie: AUTH } });
}
function apiHits() {
  return seen.filter((h) => !h.url.startsWith("/event"));
}

// Isolate a single test's upstream hits (each test resets the journal first).
function resetHits() {
  seen.length = 0;
}

test("unauthenticated API answers 401", async () => {
  resetHits();
  const res = await fetch(`${base}/zai/api/mcp`);
  assert.equal(res.status, 401);
});

test("GET /zai/api/session proxies upstream /session WITHOUT a pinned directory", async () => {
  resetHits();
  const res = await call("/zai/api/session");
  assert.equal(res.status, 200);
  // The hub's own /session/status?directory=… poll may land in between.
  const hit = apiHits().find((h) => h.method === "GET" && (h.url === "/session" || h.url.startsWith("/session?")));
  assert.ok(hit, "upstream must have received the session list call");
  assert.equal(hit.url, "/session", "cross-directory listing must not get ?directory=HOME");
});

test("POST /zai/api/session without directory falls back to HOME (system32 guard)", async () => {
  resetHits();
  await call("/zai/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const hit = apiHits().find((h) => h.method === "POST" && h.url.startsWith("/session"));
  assert.ok(hit, "upstream must have received the session create call");
  const u = new URL("http://x" + hit.url);
  assert.equal(u.pathname, "/session");
  assert.equal(u.searchParams.get("directory"), HOME);
});

test("POST /zai/api/session?directory=X keeps the client directory (project chat)", async () => {
  resetHits();
  await call("/zai/api/session?directory=" + encodeURIComponent(PROJ), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const hit = apiHits().find((h) => h.method === "POST" && h.url.startsWith("/session"));
  const u = new URL("http://x" + hit.url);
  assert.equal(u.pathname, "/session");
  assert.equal(u.searchParams.get("directory"), PROJ, "client ?directory= must win over HOME");
});

test("session-scoped message route still pins HOME when the client passes none", async () => {
  resetHits();
  await call("/zai/api/session/ses_x/message");
  const hit = apiHits().find((h) => h.url.includes("/session/ses_x/message"));
  assert.ok(hit, "upstream must have received the message call");
  const u = new URL("http://x" + hit.url);
  assert.equal(u.pathname, "/session/ses_x/message");
  assert.equal(u.searchParams.get("directory"), HOME, "regression guard: message reads stay directory-pinned");
});

test("GET /zai/api/mcp asks upstream /mcp for the chats' folder and passes the body through (BUG-183)", async () => {
  resetHits();
  const res = await call("/zai/api/mcp");
  assert.equal(res.status, 200);
  const hit = apiHits().find((h) => h.url.startsWith("/mcp"));
  assert.ok(hit, "upstream must have received the /mcp call");
  const u = new URL("http://x" + hit.url);
  assert.equal(u.pathname, "/mcp");
  assert.equal(u.searchParams.get("directory"), HOME, "never the default instance (serve cwd) — BUG-183");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(new URL("http://x" + body.url).pathname, "/mcp");
});

test("GET /zai/api/host is served locally, never proxied", async () => {
  resetHits();
  const res = await call("/zai/api/host");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body && typeof body === "object", "host stats must be a JSON object");
  assert.ok("cpu" in body && "ram" in body, "cpu and ram must always be present");
  assert.ok(!apiHits().some((h) => h.url.startsWith("/host")), "host stats must not hit the upstream");
});

test("POST /zai/api/upload streams the binary to .zai-uploads with a unique name", async () => {
  resetHits();
  const payload = Buffer.alloc(1024, 7);
  const res = await call(`/zai/api/upload?directory=${encodeURIComponent(HOME)}&name=${encodeURIComponent("..\\evil name.xlsx")}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "content-length": String(payload.length) },
    body: payload,
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.size, 1024);
  assert.ok(!out.name.includes(".."), "path traversal must be stripped: " + out.name);
  assert.ok(out.name.endsWith(".xlsx"), out.name);
  const saved = path.join(HOME, ".zai-uploads", out.name);
  assert.ok(existsSync(saved), "file must be on disk");
  assert.equal(readFileSync(saved).length, 1024);

  const again = await call(`/zai/api/upload?directory=${encodeURIComponent(HOME)}&name=${encodeURIComponent(out.name)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.alloc(10),
  });
  const out2 = await again.json();
  assert.notEqual(out2.name, out.name, "same name must get a numeric suffix");
  assert.ok(existsSync(path.join(HOME, ".zai-uploads", out2.name)));

  assert.ok(!apiHits().some((h) => h.url.startsWith("/upload")), "uploads are local, never proxied");
});

test("POST /zai/api/upload rejects over-size files with 413", async () => {
  // fetch refuses a lying content-length, so dial with raw http: the server
  // must reject on the declared header alone, before reading any body.
  const res = await new Promise((resolve, reject) => {
    const target = new URL(`${base}/zai/api/upload?directory=${encodeURIComponent(HOME)}&name=big.bin`);
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(200 * 1024 * 1024), cookie: AUTH } },
      resolve,
    );
    req.on("error", reject);
    req.end(Buffer.alloc(1));
  });
  assert.equal(res.statusCode, 413);
  res.resume();
});

test("prompt with a non-image attachment is materialized to .zai-uploads", async () => {
  resetHits();
  const payload = {
    agent: "build",
    parts: [
      { type: "text", text: "посмотри" },
      {
        type: "file",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: "report.xlsx",
        url: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBBQAAA==",
      },
      { type: "file", mime: "image/png", filename: "shot.png", url: "data:image/png;base64,aGk=" },
    ],
  };
  const res = await call(`/zai/api/session/ses_x/prompt?directory=${encodeURIComponent(HOME)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  const hit = apiHits().find((h) => h.url.includes("/session/ses_x/prompt_async"));
  assert.ok(hit, "upstream must have received the prompt");
  const sent = JSON.parse(hit.body.toString("utf8"));
  assert.equal(sent.parts.length, 3);
  assert.equal(sent.parts[0].type, "text");
  assert.equal(sent.parts[1].type, "text", "xlsx part must be swapped for a text reference");
  assert.ok(sent.parts[1].text.includes(".zai-uploads/report.xlsx"));
  assert.equal(sent.parts[2].type, "file", "image part must stay inline");
  assert.equal(sent.parts[2].mime, "image/png");
  assert.ok(hit.url.includes(`directory=${encodeURIComponent(HOME)}`), "prompt must keep its directory");
  const saved = path.join(HOME, ".zai-uploads", "report.xlsx");
  assert.ok(existsSync(saved), "the attachment must exist on disk");
  assert.deepEqual(readFileSync(saved), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00]));
});

test("GET /zai/api/status merges per-directory upstream status maps", async () => {
  resetHits();
  const res = await call("/zai/api/status");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body && typeof body === "object" && !Array.isArray(body), "the merged map must be a JSON object");
  const hits = apiHits().filter((h) => h.method === "GET" && h.url.startsWith("/session/status"));
  assert.ok(hits.length >= 1, "upstream /session/status must be consulted");
  assert.ok(
    hits.every((h) => h.url.includes("directory=")),
    "status is silently empty without ?directory= (1.19.5) — every call must pin one",
  );
});

// ---- integration 1.7.0: Г2 patches wired into server.js ----------------------

test("ADR-005 п.5: /status carries the hub epoch (x-zai-epoch)", async () => {
  const res = await call("/zai/api/status");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("x-zai-epoch") ?? "", /^[0-9a-z]+$/);
});

test("FEAT-07.16: GET /zai/api/admin/sessions answers the hub report", async () => {
  const res = await call("/zai/api/admin/sessions");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.sessions));
  assert.equal(typeof body.epoch, "string");
});

test("BUG-08.8: history pages — limit/before cut locally, never sent upstream", async () => {
  resetHits();
  const res = await call("/zai/api/session/ses_page/message?limit=2");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).map((m) => m.info.id), ["msg_4", "msg_5"]);
  assert.equal(res.headers.get("x-zai-has-more"), "1");
  assert.equal(res.headers.get("x-zai-next-before"), "msg_4");
  const hit = apiHits().find((h) => h.url.startsWith("/session/ses_page/message"));
  assert.ok(hit && !/limit=|before=/.test(hit.url), `upstream got ${hit?.url}`);
  const older = await call("/zai/api/session/ses_page/message?limit=2&before=msg_4");
  assert.deepEqual((await older.json()).map((m) => m.info.id), ["msg_2", "msg_3"]);
  assert.equal((await call("/zai/api/session/ses_page/message?before=nope")).status, 400);
  const whole = await call("/zai/api/session/ses_page/message");
  assert.equal((await whole.json()).length, 5, "no params → the whole history, as before");
});

// ---- dialogs: fresh-client seed + directory-pinned replies ------------------
// 2026-11-01: a permission.asked fired before a page load never reached that
// client (SSE carries no state) and the reply route was not directory-pinned,
// so every UI answer 404'd — sessions parked on dialogs all day.

test("GET /zai/api/dialogs merges upstream /permission listings with the directory pinned", async () => {
  resetHits();
  const res = await call("/zai/api/dialogs");
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list), "dialogs must be a JSON array");
  const hit = apiHits().find((h) => h.url.startsWith("/permission"));
  assert.ok(hit, "upstream /permission must be consulted for the seed");
  assert.ok(hit.url.includes("directory="), "the listing is directory-scoped — unpinned it answers empty");
  const rec = list.find((d) => d.id === "per_up");
  assert.ok(rec, "the upstream record must ride through");
  assert.equal(rec.kind, "permission");
  assert.equal(rec.sessionID, "ses_up");
  assert.ok(typeof rec.askedAt === "number", "boot-time seeding gives the record a local ask time");
});

test("permission reply route pins HOME when the client passes no directory (404 incident)", async () => {
  resetHits();
  const res = await call("/zai/api/permission/per_abc/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply: "reject" }),
  });
  assert.equal(res.status, 200);
  const hit = apiHits().find((h) => h.url.includes("/permission/per_abc/reply"));
  assert.ok(hit, "upstream must have received the reply");
  const u = new URL("http://x" + hit.url);
  assert.equal(u.pathname, "/permission/per_abc/reply");
  assert.equal(u.searchParams.get("directory"), HOME, "regression guard: without ?directory= upstream 404s");
  assert.equal(hit.body.toString("utf8"), JSON.stringify({ reply: "reject" }));
});

test("permission reply keeps a client-passed directory (project sessions)", async () => {
  resetHits();
  await call(`/zai/api/permission/per_def/reply?directory=${encodeURIComponent(PROJ)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply: "once" }),
  });
  const hit = apiHits().find((h) => h.url.includes("/permission/per_def/reply"));
  assert.ok(hit, "upstream must have received the reply");
  const u = new URL("http://x" + hit.url);
  assert.equal(u.searchParams.get("directory"), PROJ, "client ?directory= must win over HOME");
});
