// FEAT-18.4 / FEAT-18.3 server e2e: the REAL server.js, the fake opencode and
// the fake claude CLI (tests/fixtures/claude-fake.mjs) + a fake push service.
//   - the chat's permission mode lives in the binding (PATCH …/binding
//     {permMode}); a tenant cannot set «Без вопросов» (403), nobody changes it
//     mid-turn (409), opencode chats outside the 2.x API refuse it (400);
//   - «Спрашивать» on Claude: the CLI request is a dialog in GET /dialogs and
//     a Web Push «Нужен ваш ответ»; POST /permission/:id/reply answers the
//     live CLI; a stop closes the request and frees the chat.
// Run: node --test --test-concurrency=1 tests/permmode-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { makeTmpRoot } from "./helpers/env.mjs";
import { decryptPayload, makeUaKeys } from "./helpers/push-decrypt.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE_CLI = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const ADMIN = "m".repeat(24) + "-permmode-e2e-" + "4".repeat(24);
const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 15_000, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await sleep(80);
  }
}

async function startFakePushService() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) };
}

async function fakeUpstream() {
  const up = await startFakeOpencode({ sessions: [] });
  let n = 0;
  up.route("POST", "/session", (req, body, url) => {
    const s = { id: `ses_pm${++n}`, directory: url.searchParams.get("directory"), title: `Чат ${n}`, time: { created: Date.now(), updated: Date.now() } };
    up.state.sessions.push(s);
    return { json: s };
  });
  up.route("GET", "/config", () => ({ json: { model: "zai-coding-plan/glm-5.3" } }));
  up.route("GET", "/agent", () => ({ json: [{ name: "ask", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "deny" }] }] }));
  up.route("POST", "/instance/dispose", () => ({ json: true }));
  return up;
}

let tmp, up, srv, pushSvc, tenant, tdir;
const ua = makeUaKeys();
function api(p, { method = "GET", body, token = ADMIN } = {}) {
  return fetch(`${srv.base}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const newChat = async (model, token = ADMIN) => {
  const r = await api("/teleharness/api/session", { method: "POST", token, body: { model } });
  assert.equal(r.status, 200);
  return r.json();
};
const setMode = (id, permMode, token = ADMIN) => api(`/teleharness/api/session/${id}/binding`, { method: "PATCH", token, body: { permMode } });
const prompt = (id, text, token = ADMIN) => api(`/teleharness/api/session/${id}/prompt`, { method: "POST", token, body: { parts: [{ type: "text", text }] } });
const dialogs = async (token = ADMIN) => (await api("/teleharness/api/dialogs", { token })).json();
const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n");

before(async () => {
  tmp = makeTmpRoot("teleharness-permmode-");
  pushSvc = await startFakePushService();
  up = await fakeUpstream();
  srv = await spawnPortal({ upstream: up.url, tmp, env: { TELEHARNESS_ADMIN_TOKEN: ADMIN, TELEHARNESS_CLAUDE_BIN: FAKE_CLI, TELEHARNESS_PUSH_EXTRA_ORIGINS: pushSvc.origin } });
  await up.waitForSubscription(tmp.home);
  const created = await (await api("/teleharness/api/admin/users", { method: "POST", body: { name: "tperm" } })).json();
  tenant = created.token;
  tdir = created.user.directories[0];
  assert.equal((await api("/teleharness/api/admin/users/tperm", { method: "PATCH", body: { engines: ["opencode", "claude"] } })).status, 200);
});
after(async () => {
  await srv?.stop();
  await up?.close();
  await pushSvc?.close();
});

test("binding: permMode stored and shown; bad value 400; tenant «Без вопросов» 403; opencode outside 2.x 400", async () => {
  const s = await newChat(OPUS);
  assert.equal(s.teleharness.permMode, undefined, "no mode chosen — the role default");
  let r = await setMode(s.id, "ask");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).teleharness.permMode, "ask");
  const list = await (await api("/teleharness/api/session")).json();
  assert.equal(list.find((x) => x.id === s.id).teleharness.permMode, "ask", "the list carries the mode");
  assert.equal((await setMode(s.id, "bogus")).status, 400);
  r = await setMode(s.id, null);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).teleharness.permMode, undefined, "null → back to the default");
  assert.equal((await setMode(s.id, "full")).status, 200, "admin may pick «Без вопросов»");

  const t = await newChat(OPUS, tenant);
  r = await setMode(t.id, "full", tenant);
  assert.equal(r.status, 403, "decision 3А: tenants never get «Без вопросов»");
  assert.equal((await setMode(t.id, "ask", tenant)).status, 200);
  assert.equal((await setMode(t.id, "edits", tenant)).status, 200);

  // opencode on the 1.x API (this fake): the mode is not available
  const o = await newChat(GLM);
  assert.equal((await setMode(o.id, "ask")).status, 400);
});

test("«Спрашивать»: the CLI request → dialog + push «Нужен ваш ответ»; mode locked mid-turn; «Разрешить» writes the file", async () => {
  assert.equal((await api("/teleharness/api/push/subscribe", { method: "POST", body: { endpoint: `${pushSvc.origin}/ok-admin`, keys: { p256dh: ua.p256dh, auth: ua.auth }, expirationTime: null } })).status, 200);
  const s = await newChat(OPUS);
  assert.equal((await setMode(s.id, "ask")).status, 200);
  assert.equal((await prompt(s.id, "ASKWRITE perm-note.txt hello")).status, 204);
  const d = await waitFor(async () => (await dialogs()).find((x) => x.sessionID === s.id), { what: "bridge dialog" });
  assert.equal(d.kind, "permission");
  assert.equal(d.permission, "Write");
  assert.ok(d.metadata.command.endsWith("perm-note.txt"));
  // FEAT-18.3: push «нужно ваше решение» for a Claude chat
  const hit = await waitFor(() => pushSvc.hits.find((h) => h.path === "/ok-admin" && JSON.parse(decryptPayload(h.body, ua).text).kind === "ask"), { what: "ask push" });
  const msg = JSON.parse(decryptPayload(hit.body, ua).text);
  assert.ok(msg.title.startsWith("Нужен ваш ответ"), msg.title);
  assert.equal(msg.url, `/teleharness/#/chat/${s.id}`);
  assert.equal(hit.headers.urgency, "high");
  // a tenant neither sees nor answers the admin's request
  assert.equal((await dialogs(tenant)).some((x) => x.id === d.id), false);
  assert.equal((await api(`/teleharness/api/permission/${d.id}/reply`, { method: "POST", token: tenant, body: { reply: "once" } })).status, 404);
  // 409: the mode never changes during a turn
  assert.equal((await setMode(s.id, "full")).status, 409);
  assert.equal((await api(`/teleharness/api/permission/${d.id}/reply`, { method: "POST", body: { reply: "maybe" } })).status, 400);
  assert.equal((await api(`/teleharness/api/permission/${d.id}/reply`, { method: "POST", body: { reply: "once" } })).status, 200);
  await waitFor(() => existsSync(path.join(tmp.home, "perm-note.txt")) && readFileSync(path.join(tmp.home, "perm-note.txt"), "utf8").length > 0, { what: "file written" });
  assert.equal(readFileSync(path.join(tmp.home, "perm-note.txt"), "utf8"), "hello");
  const msgs = await waitFor(async () => {
    const m = await (await api(`/teleharness/api/session/${s.id}/message`)).json();
    return m.length >= 2 && m[1].info.time?.completed ? m : null;
  }, { what: "answer stored" });
  assert.equal(textOf(msgs[1]), "Файл perm-note.txt записан.");
  assert.equal((await dialogs()).some((x) => x.id === d.id), false);
  assert.equal((await api(`/teleharness/api/permission/${d.id}/reply`, { method: "POST", body: { reply: "once" } })).status, 404, "an answered request is gone");
  // a push per request, not a stream of them
  assert.equal(pushSvc.hits.filter((h) => h.path === "/ok-admin" && JSON.parse(decryptPayload(h.body, ua).text).kind === "ask").length, 1);
});

test("«Спрашивать» in a tenant chat: its own dialog, «Запретить» → the agent hears the refusal", async () => {
  const t = await newChat(OPUS, tenant);
  assert.equal((await setMode(t.id, "ask", tenant)).status, 200);
  assert.equal((await prompt(t.id, "ASKWRITE t-note.txt x", tenant)).status, 204);
  const d = await waitFor(async () => (await dialogs(tenant)).find((x) => x.sessionID === t.id), { what: "tenant dialog" });
  assert.equal((await api(`/teleharness/api/permission/${d.id}/reply`, { method: "POST", token: tenant, body: { reply: "reject", message: "нельзя" } })).status, 200);
  const msgs = await waitFor(async () => {
    const m = await (await api(`/teleharness/api/session/${t.id}/message`, { token: tenant })).json();
    return m.length >= 2 && m[1].info.time?.completed ? m : null;
  }, { what: "answer stored" });
  assert.ok(textOf(msgs[1]).includes("Отказано: нельзя"));
});

test("«Спрашивать»: a stop with an open request — the dialog closes, the chat is free", async () => {
  const s = await newChat(OPUS);
  assert.equal((await setMode(s.id, "ask")).status, 200);
  assert.equal((await prompt(s.id, "ASKWRITE stop-note.txt x")).status, 204);
  const d = await waitFor(async () => (await dialogs()).find((x) => x.sessionID === s.id), { what: "dialog" });
  assert.equal((await api(`/teleharness/api/session/${s.id}/abort`, { method: "POST" })).status, 200);
  await waitFor(async () => !(await dialogs()).some((x) => x.id === d.id), { what: "dialog closed" });
  await waitFor(async () => {
    const m = await (await api(`/teleharness/api/session/${s.id}/message`)).json();
    return m.length >= 2 && m[1].info.teleharness?.interrupted === "user";
  }, { what: "interrupted answer" });
  assert.equal(existsSync(path.join(tmp.home, "stop-note.txt")), false);
  // the chat is free: the mode can change again
  assert.equal((await setMode(s.id, "edits")).status, 200);
});
