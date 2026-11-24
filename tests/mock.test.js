// Contract tests for the Teleharness mock server: spawn server.js with TELEHARNESS_MOCK=1 on
// an ephemeral port and exercise the /teleharness/api/* routes the real proxy will serve.
//
// TASK-14.4: сервер спавнится через tests/helpers/spawn-server.mjs — белый
// список env, свой tmp TELEHARNESS_DATA_DIR/TELEHARNESS_HOME (раньше писал в боевой data/), и
// своя КОПИЯ фикстур (TELEHARNESS_FIXTURES): _captured.jsonl больше не трогает общий с
// мок-стендом :4171 файл fixtures/_captured.jsonl.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnPortal, ROOT } from "./helpers/spawn-server.mjs";
import { makeTmpRoot } from "./helpers/env.mjs";

const FIXTURES = path.join(ROOT, "fixtures");
const tmp = makeTmpRoot("teleharness-mock-test-");
const FIXTURES_COPY = path.join(tmp.root, "fixtures");
cpSync(FIXTURES, FIXTURES_COPY, { recursive: true, filter: (src) => !src.endsWith("_captured.jsonl") });
const CAPTURED = path.join(FIXTURES_COPY, "_captured.jsonl");

const srv = await spawnPortal({ mock: true, tmp, env: { TELEHARNESS_FIXTURES: FIXTURES_COPY } });
after(() => srv.stop());
const base = srv.base;

test("GET /teleharness/api/session returns the sessions fixture", async () => {
  const res = await fetch(`${base}/teleharness/api/session`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, "sessions.json"), "utf8"));
  assert.deepEqual(body, fixture);
});

test("GET /teleharness/api/session/:id/message returns the message fixture", async () => {
  const sessions = JSON.parse(readFileSync(path.join(FIXTURES, "sessions.json"), "utf8"));
  const withFixture = sessions.find((s) => existsSync(path.join(FIXTURES, `messages-${s.id}.json`)));
  assert.ok(withFixture, "no recorded session has a messages fixture");

  const res = await fetch(`${base}/teleharness/api/session/${withFixture.id}/message`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, `messages-${withFixture.id}.json`), "utf8"));
  assert.deepEqual(body, fixture);
});

test("GET /teleharness/api/mcp returns the mcp fixture", async () => {
  const res = await fetch(`${base}/teleharness/api/mcp`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, "mcp.json"), "utf8"));
  assert.deepEqual(body, fixture);
});

test("GET /teleharness/api/host returns the host fixture", async () => {
  const res = await fetch(`${base}/teleharness/api/host`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, "host.json"), "utf8"));
  assert.deepEqual(body, fixture);
});

test("POST /teleharness/api/upload answers with the stored name (mock)", async () => {
  const res = await fetch(`${base}/teleharness/api/upload?directory=D%3A%5CX&name=doc.xlsx`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: "12345",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, "doc.xlsx");
  assert.equal(body.size, 5);
});

test("POST /teleharness/api/* answers {mock:true} and records to _captured.jsonl", async () => {
  rmSync(CAPTURED, { force: true });
  const payload = { parts: [{ type: "text", text: "hello from the test" }] };
  const res = await fetch(`${base}/teleharness/api/session/x/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { mock: true });

  const lines = readFileSync(CAPTURED, "utf8").trimEnd().split("\n");
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.url, "/teleharness/api/session/x/message");
  assert.deepEqual(last.body, payload);
  assert.equal(typeof last.ts, "number");
});

test("GET /teleharness/api/event streams text/event-stream with data frames", async () => {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(new Error("no data frame within 5s")), 5000);
  try {
    const res = await fetch(`${base}/teleharness/api/event`, { signal: ac.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream");

    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed before any data frame");
      const text = new TextDecoder().decode(value);
      if (text.includes("data:")) break;
    }
    ac.abort();
  } finally {
    clearTimeout(timeout);
  }
});

test("GET /teleharness/api/dialogs returns the dialogs fixture", async () => {
  const res = await fetch(`${base}/teleharness/api/dialogs`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, "dialogs.json"), "utf8"));
  assert.deepEqual(body, fixture);
});

test("POST /teleharness/api/session creates a chat in memory: listed first, empty history (demo «New chat»)", async () => {
  const res = await fetch(`${base}/teleharness/api/session?directory=%2Fhome%2Fdev`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-opus-5-5" } }),
  });
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.match(s.id, /^ses_demo_new_/);
  assert.equal(s.directory, "/home/dev");
  assert.deepEqual(s.teleharness.model, { providerID: "anthropic", modelID: "claude-opus-5-5" });
  const list = await (await fetch(`${base}/teleharness/api/session`)).json();
  assert.equal(list[0].id, s.id, "the new chat comes first");
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, "sessions.json"), "utf8"));
  assert.equal(list.length, fixture.length + 1);
  const msgs = await (await fetch(`${base}/teleharness/api/session/${s.id}/message`)).json();
  assert.deepEqual(msgs, []);
});

// 2.8.1: the demo shows the background-agent fixes of BUG-319 and BUG-323 p.5.
test("demo 2.8.1 (BUG-319): GET/PUT /teleharness/api/admin/background carry the general limits", async () => {
  const put = (body) => fetch(`${base}/teleharness/api/admin/background`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const g = await (await fetch(`${base}/teleharness/api/admin/background`)).json();
  assert.equal(g.userPerDay, 30);
  assert.equal(g.defaultPerHour, 6);
  assert.equal(g.defaultQueue, 12);
  assert.equal(g.claudePerDay, 20);
  const saved = await put({ userPerDay: 45, defaultPerHour: 9, defaultQueue: 20 });
  assert.equal(saved.status, 200);
  const after = await saved.json();
  assert.equal(after.userPerDay, 45);
  assert.equal(after.defaultPerHour, 9);
  assert.equal(after.defaultQueue, 20);
  try {
    assert.deepEqual(await (await fetch(`${base}/teleharness/api/admin/background`)).json().then((x) => [x.userPerDay, x.defaultPerHour, x.defaultQueue]), [45, 9, 20]);
  } finally {
    const restored = await put({ userPerDay: 30, defaultPerHour: 6, defaultQueue: 12 });
    assert.equal(restored.status, 200);
  }
});

test("demo 2.8.1 (BUG-323 p.5): the GitHub connection and /github/repos report reposTruncated", async () => {
  const conn = await (await fetch(`${base}/teleharness/api/github/connection`)).json();
  assert.equal(conn.reposTruncated, true);
  assert.equal(conn.repos.length, 6);
  const repos = await (await fetch(`${base}/teleharness/api/github/repos`)).json();
  assert.equal(repos.reposTruncated, true);
  assert.deepEqual(repos.repos.map((r) => r.fullName), conn.repos.map((r) => r.fullName));
});
