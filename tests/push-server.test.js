// FEAT-07.20 server e2e: the REAL server.js against the fake opencode and a
// fake push service (local http). A subscription gets an encrypted POST with
// correct headers after a turn ends upstream (busy → idle); a permission ask
// goes to the chat's owner only; 410 drops the subscription; a tenant never
// gets notifications about other people's chats.
// Run: node --test --test-concurrency=1 tests/push-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { makeTmpRoot } from "./helpers/env.mjs";
import { checkVapid, decryptPayload, makeUaKeys } from "./helpers/push-decrypt.mjs";

const ADMIN = "p".repeat(24) + "-push-e2e-" + "7".repeat(24);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 10_000, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

// Fake push service: /ok-* → 201, /gone-* → 410. Records every request.
async function startFakePushService() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url.startsWith("/gone-") ? 410 : 201);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, hits, close: () => new Promise((r) => server.close(r)) };
}

let tmp, up, srv, pushSvc, tenant, tdir;
const uaAdmin = makeUaKeys();
const uaAdmin2 = makeUaKeys();
const uaTenant = makeUaKeys();

function api(p, { method = "GET", body, token = ADMIN } = {}) {
  return fetch(`${srv.base}${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const subBody = (endpoint, ua) => ({ endpoint, keys: { p256dh: ua.p256dh, auth: ua.auth }, expirationTime: null });
const hitsTo = (prefix) => pushSvc.hits.filter((h) => h.path.startsWith(prefix));

before(async () => {
  tmp = makeTmpRoot("zai-push-e2e-");
  pushSvc = await startFakePushService();
  up = await startFakeOpencode({
    sessions: [
      { id: "ses_adm", directory: tmp.home, title: "Админский чат" },
      { id: "ses_adm2", directory: tmp.home, title: "Второй чат" },
    ],
  });
  srv = await spawnPortal({ upstream: up.url, tmp, env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_PUSH_EXTRA_ORIGINS: pushSvc.origin } });
  await up.waitForSubscription(tmp.home);
  const created = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "tpush" } })).json();
  tenant = created.token;
  tdir = created.user.directories[0];
  up.state.sessions.push({ id: "ses_ten", directory: tdir, title: "Чат тенанта" });
});
after(async () => {
  await srv?.stop();
  await up?.close();
  await pushSvc?.close();
});

test("routes: 401 without login; key = 65-octet point; a foreign/LAN endpoint or bad keys → 400", async () => {
  assert.equal((await api("/zai/api/push/key", { token: null })).status, 401);
  const k = await (await api("/zai/api/push/key")).json();
  assert.equal(k.enabled, true);
  assert.equal(Buffer.from(k.publicKey, "base64url").length, 65);
  assert.equal((await api("/zai/api/push/subscribe", { method: "POST", body: subBody("https://192.168.0.10/zai/x", uaAdmin) })).status, 400);
  assert.equal((await api("/zai/api/push/subscribe", { method: "POST", body: subBody("http://127.0.0.1:4170/x", uaAdmin) })).status, 400);
  assert.equal((await api("/zai/api/push/subscribe", { method: "POST", body: { endpoint: `${pushSvc.origin}/ok-x`, keys: { p256dh: "AAAA", auth: uaAdmin.auth } } })).status, 400);
  assert.equal((await api("/zai/api/push/test", { method: "POST", body: {} })).status, 409, "no subscription yet");
  // the key is a file in <data>/push, the private part never reaches the log
  const vapid = JSON.parse(readFileSync(path.join(tmp.data, "push", "vapid.json"), "utf8"));
  assert.equal(vapid.publicKey, k.publicKey);
  assert.ok(!srv.log.includes(vapid.privateKey));
});

test("turn end upstream (busy → idle) → encrypted POST to the admin's endpoint with TTL/Urgency/Topic/vapid; the tenant gets nothing", async () => {
  const ep = `${pushSvc.origin}/ok-admin`;
  assert.equal((await api("/zai/api/push/subscribe", { method: "POST", body: subBody(ep, uaAdmin) })).status, 200);
  assert.equal((await api("/zai/api/push/subscribe", { method: "POST", token: tenant, body: subBody(`${pushSvc.origin}/ok-tenant`, uaTenant) })).status, 200);
  const k = await (await api(`/zai/api/push/key?endpoint=${encodeURIComponent(ep)}`)).json();
  assert.equal(k.subscribed, true);

  up.emit({ type: "session.status", properties: { sessionID: "ses_adm", status: { type: "busy" } } });
  up.emit({ type: "session.status", properties: { sessionID: "ses_adm", status: { type: "idle" } } });
  up.emit({ type: "session.idle", properties: { sessionID: "ses_adm" } });
  const hit = await waitFor(() => hitsTo("/ok-admin")[0], { what: "push to /ok-admin" });
  assert.equal(hit.method, "POST");
  assert.equal(hit.headers["content-encoding"], "aes128gcm");
  assert.ok(Number(hit.headers.ttl) > 0);
  assert.equal(hit.headers.urgency, "normal");
  assert.match(hit.headers.topic, /^[A-Za-z0-9_-]{1,32}$/);
  const v = checkVapid(hit.headers.authorization);
  assert.equal(v.valid, true, "VAPID JWT verifies with the portal key");
  assert.equal(v.k, k.publicKey);
  assert.equal(v.claims.aud, pushSvc.origin);
  const msg = JSON.parse(decryptPayload(hit.body, uaAdmin).text);
  assert.equal(msg.title, "Готово: Админский чат");
  assert.equal(msg.url, "/zai/#/chat/ses_adm");
  assert.equal(msg.chat, "ses_adm");
  await sleep(300);
  assert.equal(hitsTo("/ok-admin").length, 1, "one turn end — one push (debounce + busy bookkeeping)");
  assert.equal(hitsTo("/ok-tenant").length, 0, "the tenant is not told about the admin's chat");
});

test("permission asked in the tenant's chat → «Нужен ваш ответ» to the tenant only; the admin's devices get nothing", async () => {
  const before = hitsTo("/ok-admin").length;
  up.emit({ type: "permission.asked", properties: { sessionID: "ses_ten", id: "per_1", permission: "bash", patterns: ["ls"] } });
  const hit = await waitFor(() => hitsTo("/ok-tenant")[0], { what: "push to the tenant" });
  const msg = JSON.parse(decryptPayload(hit.body, uaTenant).text);
  assert.equal(msg.title, "Нужен ваш ответ: Чат тенанта");
  assert.equal(hit.headers.urgency, "high");
  await sleep(300);
  assert.equal(hitsTo("/ok-admin").length, before, "admin not notified about the tenant's chat");
  // the tenant cannot remove the admin's subscription
  const del = await (await api("/zai/api/push/subscribe", { method: "DELETE", token: tenant, body: { endpoint: `${pushSvc.origin}/ok-admin` } })).json();
  assert.equal(del.removed, false);
  // «Проверить» of the tenant goes to its own device
  const n = hitsTo("/ok-tenant").length;
  const t = await api("/zai/api/push/test", { method: "POST", token: tenant, body: {} });
  assert.equal(t.status, 200);
  assert.equal((await t.json()).sent, 1);
  assert.equal(hitsTo("/ok-tenant").length, n + 1);
  assert.equal(JSON.parse(decryptPayload(hitsTo("/ok-tenant").at(-1).body, uaTenant).text).title, "zai: проверка уведомлений");
});

test("410 from the push service drops the subscription (and only it)", async () => {
  const gone = `${pushSvc.origin}/gone-admin2`;
  assert.equal((await api("/zai/api/push/subscribe", { method: "POST", body: subBody(gone, uaAdmin2) })).status, 200);
  const nOk = hitsTo("/ok-admin").length;
  up.emit({ type: "session.status", properties: { sessionID: "ses_adm2", status: { type: "busy" } } });
  up.emit({ type: "session.idle", properties: { sessionID: "ses_adm2" } });
  await waitFor(() => hitsTo("/gone-admin2").length === 1 && hitsTo("/ok-admin").length === nOk + 1, { what: "both admin endpoints hit" });
  await waitFor(async () => (await (await api(`/zai/api/push/key?endpoint=${encodeURIComponent(gone)}`)).json()).subscribed === false, { what: "gone subscription dropped" });
  const ok = await (await api(`/zai/api/push/key?endpoint=${encodeURIComponent(`${pushSvc.origin}/ok-admin`)}`)).json();
  assert.equal(ok.subscribed, true);
  const file = path.join(tmp.data, "push", "subscriptions.json");
  assert.ok(existsSync(file));
  assert.ok(!readFileSync(file, "utf8").includes("gone-admin2"));
});

test("presence: the device that shows this chat is skipped; DELETE unsubscribes", async () => {
  const ep = `${pushSvc.origin}/ok-admin`;
  assert.equal((await (await api("/zai/api/push/presence", { method: "POST", body: { endpoint: ep, chat: "ses_adm" } })).json()).ok, true);
  const n = hitsTo("/ok-admin").length;
  // ses_adm's debounce window (20 s) may still be open — use a fresh chat
  up.state.sessions.push({ id: "ses_adm3", directory: tmp.home, title: "Третий" });
  await api("/zai/api/push/presence", { method: "POST", body: { endpoint: ep, chat: "ses_adm3" } });
  up.emit({ type: "session.status", properties: { sessionID: "ses_adm3", status: { type: "busy" } } });
  up.emit({ type: "session.idle", properties: { sessionID: "ses_adm3" } });
  await sleep(800);
  assert.equal(hitsTo("/ok-admin").length, n, "chat in front — no push");
  const del = await (await api("/zai/api/push/subscribe", { method: "DELETE", body: { endpoint: ep } })).json();
  assert.equal(del.removed, true);
  assert.equal((await (await api(`/zai/api/push/key?endpoint=${encodeURIComponent(ep)}`)).json()).subscribed, false);
});
