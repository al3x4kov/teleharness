// / ISSUE-004: все фоновые маршруты клиента в режиме TELEHARNESS_MOCK=1
// возвращают 200 JSON без шумовых 404 в консоли.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mockHandler } from "../lib/mock.js";

function callMock(method, url, body = null) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { "content-type": "application/json" };
    req[Symbol.asyncIterator] = async function* () {
      if (body !== null) yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    };

    let status = 0;
    let headers = {};
    let payload = "";
    const res = new EventEmitter();
    res.writeHead = (s, h = {}) => { status = s; headers = h; };
    res.write = (chunk) => { payload += String(chunk); };
    res.end = (chunk = "") => {
      payload += String(chunk);
      let json = null;
      try { json = JSON.parse(payload); } catch {}
      resolve({ handled: true, status, headers, payload, json });
    };
    res.destroy = () => resolve({ handled: true, status: 500, headers, payload, json: null });

    const handled = mockHandler(req, res);
    if (!handled) resolve({ handled: false, status: 404, headers: {}, payload: "", json: null });
  });
}

test("/ ISSUE-004: GET /teleharness/api/attention?active=1 отдаёт 200 с валидной доской внимания", async () => {
  const r = await callMock("GET", "/teleharness/api/attention?active=1");
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json?.items));
  assert.equal(typeof r.json?.counts?.needs, "number");
  assert.equal(typeof r.json?.sources?.opencode, "string");
});

test("/ ISSUE-004: GET /teleharness/api/claude/agents отдаёт 200 { agents: [] }", async () => {
  const r = await callMock("GET", "/teleharness/api/claude/agents");
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json?.agents));
});

test("/ ISSUE-004: GET /teleharness/api/github/connection отдаёт 200 { connected: false }", async () => {
  const r = await callMock("GET", "/teleharness/api/github/connection");
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  assert.equal(typeof r.json?.connected, "boolean");
});

test("/ ISSUE-004: GET и PUT /teleharness/api/me/pins отдают 200 { ids, max }", async () => {
  const g = await callMock("GET", "/teleharness/api/me/pins");
  assert.equal(g.handled, true);
  assert.equal(g.status, 200);
  assert.ok(Array.isArray(g.json?.ids));
  assert.equal(typeof g.json?.max, "number");

  const p = await callMock("PUT", "/teleharness/api/me/pins", { ids: ["ses_1"] });
  assert.equal(p.handled, true);
  assert.equal(p.status, 200);
  assert.ok(Array.isArray(p.json?.ids));
});

test("/ ISSUE-004: GET /teleharness/api/push/key отдаёт 200 { enabled: false, publicKey: null }", async () => {
  const r = await callMock("GET", "/teleharness/api/push/key");
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  assert.equal(r.json?.enabled, false);
  assert.equal(r.json?.publicKey, null);
});

test("/ ISSUE-004: GET /teleharness/api/voice отдаёт 200 { enabled: false, ready: false, voices: [], stt: false }", async () => {
  const r = await callMock("GET", "/teleharness/api/voice");
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  assert.equal(r.json?.enabled, false);
  assert.equal(r.json?.ready, false);
  assert.ok(Array.isArray(r.json?.voices));
  assert.equal(r.json?.stt, false);
});

test("/ ISSUE-010: POST /teleharness/api/session создаёт мок-сессию, видимую в GET /session и GET /session/:id/message", async () => {
  const created = await callMock("POST", "/teleharness/api/session", { title: "Новый мок-чат", directory: "/mock/proj" });
  assert.equal(created.handled, true);
  assert.equal(created.status, 200);
  assert.equal(typeof created.json?.id, "string");
  assert.ok(/^ses_(?:mock|demo)_/.test(String(created.json.id)), `id должен начинаться с ses_mock_, получено ${created.json?.id}`);
  assert.equal(created.json.title, "Новый мок-чат");
  assert.equal(created.json.directory, "/mock/proj");

  const list = await callMock("GET", "/teleharness/api/session");
  assert.equal(list.status, 200);
  assert.ok(list.json.some((s) => s.id === created.json.id), "созданная сессия должна присутствовать в списке");

  const msgs = await callMock("GET", `/teleharness/api/session/${created.json.id}/message`);
  assert.equal(msgs.status, 200);
  assert.deepEqual(msgs.json, []);

  // Убираем за собой, чтобы не засорять модульный список для других тестов
  const del = await callMock("DELETE", `/teleharness/api/session/${created.json.id}`);
  assert.equal(del.status, 200);
});

test("/ ISSUE-010: GET /teleharness/api/about возвращает opencodeVersion 2.2.6", async () => {
  const r = await callMock("GET", "/teleharness/api/about");
  assert.equal(r.status, 200);
  assert.equal(r.json?.opencodeVersion, "2.2.6");
});

test("/ ISSUE-010: все 13 недостающих SPA-маршрутов в TELEHARNESS_MOCK=1 отвечают 200 JSON", async () => {
  const routes = [
    ["GET", "/teleharness/api/worktrees?dir=%2Fmock"],
    ["GET", "/teleharness/api/worktrees/plan?dir=%2Fmock"],
    ["GET", "/teleharness/api/me/worktrees"],
    ["PUT", "/teleharness/api/me/worktrees", { mergeMethod: "squash", testTimeoutMin: 10 }],
    ["GET", "/teleharness/api/costs/chat/ses_1"],
    ["GET", "/teleharness/api/costs/summary"],
    ["GET", "/teleharness/api/skills"],
    ["GET", "/teleharness/api/session/ses_1/plan"],
    ["GET", "/teleharness/api/turn-files?sid=ses_1"],
    ["GET", "/teleharness/api/review/chat/ses_1"],
    ["GET", "/teleharness/api/review"],
    ["GET", "/teleharness/api/me/auto-relay"],
    ["PUT", "/teleharness/api/me/auto-relay", { enabled: true, order: [] }],
    ["GET", "/teleharness/api/me/push-prefs"],
    ["PUT", "/teleharness/api/me/push-prefs", { enabled: false, kinds: {} }],
    ["GET", "/teleharness/api/me/git"],
    ["PUT", "/teleharness/api/me/git", { authorName: "Test", authorEmail: "t@e.x" }],
    ["GET", "/teleharness/api/acp/registry"],
    ["GET", "/teleharness/api/acp/catalog"],
    ["GET", "/teleharness/api/admin/users"],
    ["GET", "/teleharness/api/admin/background"],
  ];
  for (const [method, url, body] of routes) {
    const r = await callMock(method, url, body ?? null);
    assert.equal(r.handled, true, `${method} ${url} должен обрабатываться mockHandler`);
    assert.equal(r.status, 200, `${method} ${url} должен возвращать 200, получено ${r.status}`);
    assert.notEqual(r.json, null, `${method} ${url} должен возвращать валидный JSON`);
  }
});

