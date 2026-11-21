// FEAT-20.2 server e2e: доска внимания — НАСТОЯЩИЙ server.js против фейкового
// opencode. Только своё (тенант / admin), одинаковый 404 для чужого и
// несуществующего ключа, идемпотентная отметка, «Отметить все» до версии,
// отложение, личное событие только своим подключениям, удалённый чат,
// настройки push, сводка «Пока вас не было» после перезапуска.
// Run: node --test --test-concurrency=1 tests/attention-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { makeTmpRoot } from "./helpers/env.mjs";

const ADMIN = "a".repeat(24) + "-attention-e2e-" + "9".repeat(24);
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

let tmp, up, srv, alice, bob;
function api(p, { method = "GET", body, token = ADMIN } = {}) {
  return fetch(`${srv.base}${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const boardOf = async (token, q = "") => (await api(`/teleharness/api/attention${q}`, { token })).json();
const keysOf = (b) => b.items.map((it) => it.key).sort();
const turn = (sid, end = [{ type: "session.idle", properties: { sessionID: sid } }]) => {
  up.emit({ type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } });
  for (const e of end) up.emit(e);
};

// SSE-подписка портала: собирает кадры teleharness.attention.
function listen(token) {
  const ctl = new AbortController();
  const got = [];
  const ready = fetch(`${srv.base}/teleharness/api/event`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal }).then(async (r) => {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const s = dec.decode(value);
          for (const m of s.matchAll(/data: (\{.*"teleharness\.attention".*\})/g)) got.push(JSON.parse(m[1]));
        }
      } catch {}
    })();
  });
  return { got, ready, close: () => ctl.abort() };
}

before(async () => {
  tmp = makeTmpRoot("teleharness-attn-e2e-");
  up = await startFakeOpencode({ sessions: [{ id: "ses_adm", directory: tmp.home, title: "Админский чат" }, { id: "ses_adm2", directory: tmp.home, title: "Второй админский" }] });
  srv = await spawnPortal({ upstream: up.url, tmp, env: { TELEHARNESS_ADMIN_TOKEN: ADMIN } });
  await up.waitForSubscription(tmp.home);
  alice = await (await api("/teleharness/api/admin/users", { method: "POST", body: { name: "attn-alice" } })).json();
  bob = await (await api("/teleharness/api/admin/users", { method: "POST", body: { name: "attn-bob" } })).json();
  up.state.sessions.push(
    { id: "ses_a1", directory: alice.user.directories[0], title: "Отчёт по продажам" },
    { id: "ses_a2", directory: alice.user.directories[0], title: "Миграция" },
    { id: "ses_b1", directory: bob.user.directories[0], title: "Чат Боба" },
  );
  up.fallback((req, _body, url) => {
    const m = /^\/session\/([^/]+)$/.exec(url.pathname);
    if (!m || req.method !== "DELETE") return null;
    const i = up.state.sessions.findIndex((s) => s.id === decodeURIComponent(m[1]));
    if (i < 0) return { status: 404, json: { error: "not found" } };
    up.state.sessions.splice(i, 1);
    return { json: true };
  });
  // индекс чатов сервера подхватывает новые записи (TTL 10 с) — форсируем через список
  await api("/teleharness/api/session");
  await sleep(50);
});
after(async () => {
  await srv?.stop();
  await up?.close();
});

test("GET: 401 без входа; пустая доска; форма ответа (now, counts, sources, epoch)", async () => {
  assert.equal((await api("/teleharness/api/attention", { token: null })).status, 401);
  const b = await boardOf(alice.token);
  assert.equal(typeof b.now, "number");
  assert.deepEqual(b.items, []);
  assert.equal(b.counts.needs, 0);
  // FEAT-20.1 (2.2.0): источник ревью подключён — вкладка «Ждёт ревью» есть, у нового пользователя пуста
  assert.equal(b.sources.reviews, "ok");
  assert.deepEqual(b.reviews, []);
  assert.equal(b.counts.review, 0);
  assert.equal(b.sources.temporal, "off");
  assert.equal(b.away, null);
});

test("кр. 18, N-15: тенант видит только свои чаты, admin — только ничьи папки; чужой запрос — не на доске", async () => {
  await waitFor(async () => (await api("/teleharness/api/session")).ok);
  turn("ses_a1");
  turn("ses_b1");
  turn("ses_adm");
  up.emit({ type: "permission.asked", properties: { sessionID: "ses_b1", id: "per_b", permission: "bash", patterns: ["rm -rf"] } });
  const a = await waitFor(async () => { const b = await boardOf(alice.token); return b.counts.done === 1 && b; }, { what: "alice done" });
  assert.deepEqual(keysOf(a), ["chat:ses_a1"]);
  assert.equal(a.items[0].state, "done");
  assert.equal(a.items[0].title, "Отчёт по продажам");
  const adm = await waitFor(async () => { const b = await boardOf(ADMIN); return b.counts.done >= 1 && b; }, { what: "admin done" });
  assert.deepEqual(keysOf(adm), ["chat:ses_adm"], "admin не видит чатов тенантов (и запроса Боба)");
  assert.equal(adm.admin, true);
  const b = await waitFor(async () => { const x = await boardOf(bob.token); return x.counts.needs === 1 && x; }, { what: "bob needs" });
  assert.equal(b.items[0].permission.id, "per_b");
  assert.equal(b.items[0].reason, "permission");
});

test("кр. 5, N-19, кр. 18: отметка просмотра — идемпотентна; чужой и выдуманный ключ — одинаковый 404, ничего не меняется", async () => {
  const foreign = await api("/teleharness/api/attention/seen", { method: "POST", token: alice.token, body: { keys: ["chat:ses_b1"] } });
  const unknown = await api("/teleharness/api/attention/seen", { method: "POST", token: alice.token, body: { keys: ["chat:ses_nope"] } });
  assert.equal(foreign.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await foreign.json(), await unknown.json());
  assert.equal((await boardOf(bob.token)).counts.needs, 1, "состояние Боба не тронуто");
  const admForeign = await api("/teleharness/api/attention/seen", { method: "POST", body: { keys: ["chat:ses_a1"] } });
  assert.equal(admForeign.status, 404, "admin тоже не отмечает чужое на своей доске");
  assert.equal((await api("/teleharness/api/attention/seen", { method: "POST", token: alice.token, body: { keys: "x" } })).status, 400);
  const r1 = await api("/teleharness/api/attention/seen", { method: "POST", token: alice.token, body: { keys: ["chat:ses_a1"] } });
  assert.equal(r1.status, 200);
  const r2 = await api("/teleharness/api/attention/seen", { method: "POST", token: alice.token, body: { keys: ["chat:ses_a1"] } });
  assert.equal(r2.status, 200, "повтор — успех");
  assert.equal((await boardOf(alice.token)).counts.done, 0);
});

test("N-28: снова готово после просмотра", async () => {
  await sleep(5);
  turn("ses_a1");
  await waitFor(async () => (await boardOf(alice.token)).counts.done === 1, { what: "done again" });
});

test("кр. 5, N-11: «Отметить все» отмечает только известное на версии upTo", async () => {
  const before = await boardOf(alice.token);
  const upTo = before.now;
  await sleep(10);
  turn("ses_a2");
  await waitFor(async () => (await boardOf(alice.token)).counts.done === 2, { what: "two done" });
  const r = await api("/teleharness/api/attention/seen", { method: "POST", token: alice.token, body: { section: "done", upTo } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).marked, 1);
  const after = await boardOf(alice.token);
  assert.deepEqual(keysOf(after), ["chat:ses_a2"], "новый результат остался непросмотренным");
});

test("кр. 8: отложить — вне счётчиков; чужой ключ — 404; срок > 7 дней — 400", async () => {
  assert.equal((await api("/teleharness/api/attention/snooze", { method: "POST", token: alice.token, body: { key: "chat:ses_b1", until: Date.now() + 3600_000 } })).status, 404);
  assert.equal((await api("/teleharness/api/attention/snooze", { method: "POST", token: alice.token, body: { key: "chat:ses_a2", until: Date.now() + 8 * 86400_000 } })).status, 400);
  assert.equal((await api("/teleharness/api/attention/snooze", { method: "POST", token: alice.token, body: { key: "chat:ses_a2", until: Date.now() + 3600_000 } })).status, 200);
  const b = await boardOf(alice.token);
  assert.equal(b.counts.done, 0);
  assert.equal(b.counts.snoozed, 1);
  assert.equal((await api("/teleharness/api/attention/snooze", { method: "POST", token: alice.token, body: { key: "chat:ses_a2", until: null } })).status, 200);
  assert.equal((await boardOf(alice.token)).counts.done, 1, "снято отложение");
});

test("кр. 10, 18: личное событие teleharness.attention получают только подключения этого пользователя", async () => {
  const la = listen(alice.token);
  const lb = listen(bob.token);
  await Promise.all([la.ready, lb.ready]);
  await sleep(200);
  await api("/teleharness/api/attention/seen", { method: "POST", token: alice.token, body: { keys: ["chat:ses_a2"] } });
  await waitFor(() => la.got.some((e) => e.properties?.reason === "seen"), { what: "alice event" });
  await sleep(200);
  assert.equal(lb.got.length, 0, "Боб не получает событие Алисы");
  la.close();
  lb.close();
});

test("кр. 15: настройки push — у пользователя (GET/PUT), неверное — 400", async () => {
  const d = await (await api("/teleharness/api/me/push-prefs", { token: alice.token })).json();
  assert.deepEqual(d, { needs: true, failed: true, done: true, quiet: { on: false, from: "23:00", to: "08:00", tz: null } });
  const r = await api("/teleharness/api/me/push-prefs", { method: "PUT", token: alice.token, body: { done: false, quiet: { on: true, from: "23:00", to: "08:00" } } });
  assert.equal(r.status, 200);
  assert.equal((await (await api("/teleharness/api/me/push-prefs", { token: alice.token })).json()).done, false);
  assert.equal((await (await api("/teleharness/api/me/push-prefs", { token: bob.token })).json()).done, true, "у каждого свои");
  assert.equal((await api("/teleharness/api/me/push-prefs", { method: "PUT", token: alice.token, body: { done: "x" } })).status, 400);
});

test("кр. 13, N-27: ошибка хода — «Упало» с типом; остановка пользователем — не «упало»", async () => {
  turn("ses_adm2", [
    { type: "session.error", properties: { sessionID: "ses_adm2", error: { name: "APIError", data: { message: "Rate limit 429" } } } },
    { type: "session.idle", properties: { sessionID: "ses_adm2" } },
  ]);
  const b = await waitFor(async () => { const x = await boardOf(ADMIN); return x.counts.failed === 1 && x; }, { what: "failed" });
  const it = b.items.find((x) => x.key === "chat:ses_adm2");
  assert.equal(it.reason, "limit");
  assert.equal(it.errorKind, "limit");
  await api("/teleharness/api/attention/seen", { method: "POST", body: { keys: ["chat:ses_adm2"] } });
  up.emit({ type: "session.status", properties: { sessionID: "ses_adm2", status: { type: "busy" } } });
  await sleep(150);
  await api("/teleharness/api/session/ses_adm2/abort", { method: "POST" });
  up.emit({ type: "session.error", properties: { sessionID: "ses_adm2", error: { name: "MessageAbortedError" } } });
  up.emit({ type: "session.idle", properties: { sessionID: "ses_adm2" } });
  await sleep(400);
  const after = await boardOf(ADMIN);
  assert.equal(after.items.find((x) => x.key === "chat:ses_adm2"), undefined, "остановили сами — не «Упало»");
});

test("кр. 14, N-5: удалённый чат исчезает с доски и его отметки удаляются", async () => {
  turn("ses_a2");
  await waitFor(async () => (await boardOf(alice.token)).items.some((x) => x.key === "chat:ses_a2"), { what: "a2 back" });
  const del = await api("/teleharness/api/session/ses_a2", { method: "DELETE", token: alice.token });
  assert.ok(del.ok, `delete ${del.status}`);
  await api("/teleharness/api/session");
  const b = await waitFor(async () => { const x = await boardOf(alice.token); return !x.items.some((i) => i.key === "chat:ses_a2") && x; }, { what: "gone" });
  assert.ok(b);
  assert.equal((await api("/teleharness/api/attention/seen", { method: "POST", token: alice.token, body: { keys: ["chat:ses_a2"] } })).status, 404, "удалённый = несуществующий");
});

test("кр. 9: фильтр по проекту и поиск — на сервере", async () => {
  turn("ses_a1");
  await waitFor(async () => (await boardOf(alice.token)).counts.done >= 1, { what: "a1 done" });
  const hit = await boardOf(alice.token, "?q=" + encodeURIComponent("отчёт"));
  assert.deepEqual(keysOf(hit), ["chat:ses_a1"]);
  const miss = await boardOf(alice.token, "?q=zzz");
  assert.equal(miss.items.length, 0);
  const proj = await boardOf(alice.token, "?project=" + encodeURIComponent("/nope"));
  assert.equal(proj.items.length, 0);
});

test("кр. 6: «Понятно» — 200; away-ack идемпотентен", async () => {
  assert.equal((await api("/teleharness/api/attention/away-ack", { method: "POST", token: alice.token, body: {} })).status, 200);
  assert.equal((await api("/teleharness/api/attention/away-ack", { method: "POST", token: alice.token, body: {} })).status, 200);
  assert.equal((await boardOf(alice.token, "?active=1")).away, null);
});
