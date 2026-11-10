// Contract tests for the zai mock server: spawn server.js with ZAI_MOCK=1 on
// an ephemeral port and exercise the /zai/api/* routes the real proxy will serve.
//
// TASK-14.4: сервер спавнится через tests/helpers/spawn-server.mjs — белый
// список env, свой tmp ZAI_DATA_DIR/ZAI_HOME (раньше писал в боевой data/), и
// своя КОПИЯ фикстур (ZAI_FIXTURES): _captured.jsonl больше не трогает общий с
// мок-стендом :4171 файл fixtures/_captured.jsonl.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnPortal, ROOT } from "./helpers/spawn-server.mjs";
import { makeTmpRoot } from "./helpers/env.mjs";

const FIXTURES = path.join(ROOT, "fixtures");
const tmp = makeTmpRoot("zai-mock-test-");
const FIXTURES_COPY = path.join(tmp.root, "fixtures");
cpSync(FIXTURES, FIXTURES_COPY, { recursive: true, filter: (src) => !src.endsWith("_captured.jsonl") });
const CAPTURED = path.join(FIXTURES_COPY, "_captured.jsonl");

const srv = await spawnPortal({ mock: true, tmp, env: { ZAI_FIXTURES: FIXTURES_COPY } });
after(() => srv.stop());
const base = srv.base;

test("GET /zai/api/session returns the sessions fixture", async () => {
  const res = await fetch(`${base}/zai/api/session`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, "sessions.json"), "utf8"));
  assert.deepEqual(body, fixture);
});

test("GET /zai/api/session/:id/message returns the message fixture", async () => {
  const sessions = JSON.parse(readFileSync(path.join(FIXTURES, "sessions.json"), "utf8"));
  const withFixture = sessions.find((s) => existsSync(path.join(FIXTURES, `messages-${s.id}.json`)));
  assert.ok(withFixture, "no recorded session has a messages fixture");

  const res = await fetch(`${base}/zai/api/session/${withFixture.id}/message`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, `messages-${withFixture.id}.json`), "utf8"));
  assert.deepEqual(body, fixture);
});

test("GET /zai/api/mcp returns the mcp fixture", async () => {
  const res = await fetch(`${base}/zai/api/mcp`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, "mcp.json"), "utf8"));
  assert.deepEqual(body, fixture);
});

test("GET /zai/api/host returns the host fixture", async () => {
  const res = await fetch(`${base}/zai/api/host`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, "host.json"), "utf8"));
  assert.deepEqual(body, fixture);
});

test("POST /zai/api/upload answers with the stored name (mock)", async () => {
  const res = await fetch(`${base}/zai/api/upload?directory=D%3A%5CX&name=doc.xlsx`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: "12345",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, "doc.xlsx");
  assert.equal(body.size, 5);
});

test("POST /zai/api/* answers {mock:true} and records to _captured.jsonl", async () => {
  rmSync(CAPTURED, { force: true });
  const payload = { parts: [{ type: "text", text: "hello from the test" }] };
  const res = await fetch(`${base}/zai/api/session/x/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { mock: true });

  const lines = readFileSync(CAPTURED, "utf8").trimEnd().split("\n");
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.url, "/zai/api/session/x/message");
  assert.deepEqual(last.body, payload);
  assert.equal(typeof last.ts, "number");
});

test("GET /zai/api/event streams text/event-stream with data frames", async () => {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(new Error("no data frame within 5s")), 5000);
  try {
    const res = await fetch(`${base}/zai/api/event`, { signal: ac.signal });
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

test("GET /zai/api/dialogs returns the dialogs fixture", async () => {
  const res = await fetch(`${base}/zai/api/dialogs`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, "dialogs.json"), "utf8"));
  assert.deepEqual(body, fixture);
});
