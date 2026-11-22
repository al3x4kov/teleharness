// @suite server
// FEAT-20.3 (1.4/1.5/1.10): CRUD триггеров GitHub на реальном сервере и
// публичный приёмник /teleharness/hooks/github/:key — подпись, лимиты, дедупликация,
// журнал решений. Запуски в стенд уходит отдельно; здесь запуск подтверждается
// решением журнала (у тестового пользователя нет подключения GitHub →
// «Нет подключения», детерминированный путь без Temporal).
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "github-trg-admin-" + "a".repeat(40);
const GH_TOKEN = "ghtest_alice_token_0123456789abcdefghijklmnop";
// Локальный GitHub: /user и хуки octo/hello; octo/locked — нет права Webhooks.
function startFakeGithub() {
  const srv = http.createServer((req, res) => {
    const ok = (req.headers.authorization ?? "") === `Bearer ${GH_TOKEN}`;
    const p = (req.url ?? "").split("?")[0]; // pathname без query
    res.setHeader("x-ratelimit-limit", "5000");
    res.setHeader("x-ratelimit-remaining", "4900");
    res.setHeader("x-ratelimit-reset", "1790000000");
    const json = (status, data, extra = {}) => { res.writeHead(status, { "content-type": "application/json", ...extra }); res.end(JSON.stringify(data)); };
    if (p === "/user") return ok ? json(200, { login: "octo" }, { "github-authentication-token-expiration": "2027-01-01 12:00:00 UTC", etag: 'W/"u1"' }) : json(401, { message: "Bad credentials" });
    if (p === "/user/repos") return ok ? json(200, [{ full_name: "octo/hello", private: false, permissions: { pull: true, push: true, admin: true } }]) : json(401, { message: "Bad credentials" });
    if (p === "/repos/octo/hello/hooks" && req.method === "GET") return json(ok ? 200 : 401, []);
    if (p === "/repos/octo/locked/hooks") return json(403, { message: "Forbidden" });
    if (p === "/repos/octo/hello/hooks" && req.method === "POST") return json(ok ? 201 : 401, { id: 77, active: true, config: { url: "u" } });
    if (p === "/repos/octo/hello/hooks/77/pings") return res.writeHead(204), res.end();
    if (p === "/repos/octo/hello/hooks/77" && req.method === "GET") return json(200, { id: 77, active: true, config: { url: "u" } });
    if (p === "/repos/octo/hello/hooks/77" && req.method === "PATCH") { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => json(200, { id: 77, active: true, config: JSON.parse(b || "{}").config ?? {} })); return; }
    if (p === "/repos/octo/hello/hooks/77" && req.method === "DELETE") return res.writeHead(204), res.end();
    if (p.startsWith("/repos/octo/hello/issues") || p.includes("actions/runs") || p.includes("issues/comments")) return json(200, p.includes("actions/runs") ? { total_count: 0, workflow_runs: [] } : [], { etag: 'W/"empty"' });
    json(404, { message: "Not Found" });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

let up, srv, gh, alice, bob, pipeId;
const base = "/teleharness/api/temporal/triggers";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(100);
  }
}
function api(route, { token = ADMIN, method = "GET", body } = {}) {
  return fetch(srv.base + route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const sign = (secret, body) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
// Доставка в приёмник: без Bearer — приёмник публичный, защита HMAC.
function hook(key, body, { secret, event = "issues", delivery = `d-${Math.random()}` } = {}) {
  const headers = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery };
  if (secret) headers["x-hub-signature-256"] = sign(secret, body);
  return fetch(`${srv.base}/teleharness/hooks/github/${key}`, { method: "POST", headers, body });
}
const labeled = (n = 101) => JSON.stringify({ action: "labeled", repository: { full_name: "octo/hello" }, sender: { login: "octo" }, issue: { number: n, title: "T", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] }, label: { name: "agent" } });

describe("FEAT-20.3: triggers server", { skip: process.platform === "win32" && "Linux/macOS-only feature (POSIX paths, Unix socket, uid)" }, () => {
before(async () => {
  up = await startFakeOpencode();
  gh = await startFakeGithub();
  srv = await spawnPortal({ upstream: up.url, env: { TELEHARNESS_ADMIN_TOKEN: ADMIN, TELEHARNESS_TEMPORAL_PIPELINES: "1", TELEHARNESS_PUBLIC_URL: "http://127.0.0.1:1/teleharness", TELEHARNESS_GITHUB_API: gh.url } });
  alice = await (await api("/teleharness/api/admin/users", { method: "POST", body: { name: "github-alice" } })).json();
  bob = await (await api("/teleharness/api/admin/users", { method: "POST", body: { name: "github-bob" } })).json();
  // Опубликованный пайп — цель триггера (черновик с шагом согласования + publish).
  const draft = { name: "Реагер", directory: alice.user.directories[0], inputs: [], steps: [{ id: "wait", name: "Решение", type: "approval", dependsOn: [] }] };
  const created = await (await api("/teleharness/api/temporal/definitions", { token: alice.token, method: "POST", body: { draft } })).json();
  await api(`/teleharness/api/temporal/definitions/${created.id}/publish`, { token: alice.token, method: "POST", body: { revision: 1 } });
  pipeId = created.id;
});
after(async () => { await srv?.stop(); await up?.close(); gh?.srv.close(); });

let trig, secret;
test("CRUD: создание показывает ключ/секрет/адрес один раз; списки их не отдают", async () => {
  const bad = await api(base, { token: alice.token, method: "POST", body: { definitionId: pipeId, repo: "не репозиторий" } });
  assert.equal(bad.status, 422);
  const badKind = await api(base, { token: alice.token, method: "POST", body: { definitionId: pipeId, repo: "octo/hello", kinds: ["звезда"] } });
  assert.equal(badKind.status, 422);

  const created = await api(base, { token: alice.token, method: "POST", body: { definitionId: pipeId, repo: "octo/hello", kinds: ["issue_labeled"], filters: { label: "agent", trustedAuthors: ["carol"] } } });
  assert.equal(created.status, 201, await created.clone().text());
  const body = await created.json();
  assert.match(body.key, /^[A-Za-z0-9_-]{43}$/);
  assert.match(body.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.hookUrl, `http://127.0.0.1:1/teleharness/hooks/github/${body.key}`);
  trig = body; secret = body.secret;

  const list = await (await api(base, { token: alice.token })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].repo, "octo/hello");
  assert.ok(!("key" in list[0]) && !("secret" in list[0]), "ключ и секрет не отдаются списком");
  const one = await (await api(`${base}/${trig.id}`, { token: alice.token })).json();
  assert.ok(!("secret" in one) && !("key" in one));
  assert.equal(one.enabled, true);
  assert.equal(one.revision, 1);
  assert.equal(one.hookConfigured, false);
});

test("CRUD: чужой не видит и не создаёт; ревизия CAS; enable/disable; журнал; ротация", async () => {
  assert.equal((await api(`${base}/${trig.id}`, { token: bob.token })).status, 404);
  // bob указывает чужой пайп — 404, не 403 (не раскрываем существование)
  const foreign = await api(base, { token: bob.token, method: "POST", body: { definitionId: pipeId, repo: "octo/other" } });
  assert.equal(foreign.status, 404);

  const patched = await api(`${base}/${trig.id}`, { token: alice.token, method: "PATCH", body: { revision: 1, pollSeconds: 300 } });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).revision, 2);
  const stale = await api(`${base}/${trig.id}`, { token: alice.token, method: "PATCH", body: { revision: 1, pollSeconds: 60 } });
  assert.equal(stale.status, 409);

  const disabled = await (await api(`${base}/${trig.id}/disable`, { token: alice.token, method: "POST", body: {} })).json();
  assert.equal(disabled.enabled, false);
  const enabled = await (await api(`${base}/${trig.id}/enable`, { token: alice.token, method: "POST", body: {} })).json();
  assert.equal(enabled.enabled, true);

  assert.deepEqual(await (await api(`${base}/${trig.id}/journal`, { token: alice.token })).json(), []);
  assert.equal((await api(`${base}/${trig.id}/journal`, { token: bob.token })).status, 404);

  const rotated = await (await api(`${base}/${trig.id}/webhook/rotate`, { token: alice.token, method: "POST", body: {} })).json();
  assert.notEqual(rotated.secret, secret);
  assert.equal(rotated.hookConfigured, false);
  secret = rotated.secret;

  // второй триггер: удалить можно без ревизии, чужой — нельзя
  const extra = await (await api(base, { token: alice.token, method: "POST", body: { definitionId: pipeId, repo: "octo/hello", kinds: ["ci_failed"] } })).json();
  assert.equal((await api(`${base}/${extra.id}`, { token: bob.token, method: "DELETE", body: { revision: 1 } })).status, 404);
  assert.equal((await api(`${base}/${extra.id}`, { token: alice.token, method: "DELETE" })).status, 200);
  assert.equal((await api(`${base}/${extra.id}`, { token: alice.token })).status, 404);
});

test("приёмник: ping 200 по подписи; 404 на чужой ключ; 401 без подписи; 413 на крупное тело", async () => {
  assert.equal((await hook("x".repeat(43), "{}")).status, 404, "ключ не найден");
  assert.equal((await hook(trig.key, labeled(), { secret: secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A") })).status, 401, " неверная подпись");
  assert.equal((await hook(trig.key, labeled())).status, 401, "подписи нет");
  assert.equal((await hook(trig.key, "{}", { secret, event: "ping" })).status, 200);
  const pong = await (await hook(trig.key, "{}", { secret, event: "ping" })).json();
  assert.equal(pong.pong, true);
  assert.equal((await hook(trig.key, "x".repeat(1024 * 1024 + 2), { secret })).status, 413);
});

test("приёмник: событие 202, решение в журнале; повтор доставки и повтор события — дедупликация", async () => {
  const first = await hook(trig.key, labeled(), { secret, delivery: "dv-1" });
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { ok: true, queued: true });
  const entry = await until(async () => (await (await api(`${base}/${trig.id}/journal`, { token: alice.token })).json()).find((r) => r.decision === "no_connection"));
  assert.ok(entry, "решение появилось в журнале");
  assert.equal(entry.kind, "issue_labeled");
  assert.equal(entry.via, "webhook");

  // та же доставка (тот же delivery id) — не обрабатывается второй раз
  const replayed = await hook(trig.key, labeled(), { secret, delivery: "dv-1" });
  assert.equal(replayed.status, 202);
  assert.deepEqual(await replayed.json(), { ok: true, duplicate: true });

  // то же событие под новой доставкой — duplicate по event_key
  await hook(trig.key, labeled(), { secret, delivery: "dv-2" });
  const dup = await until(async () => (await (await api(`${base}/${trig.id}/journal`, { token: alice.token })).json()).find((r) => r.decision === "duplicate"));
  assert.ok(dup, "повтор события отмечен дубликатом");

  // неверная подпись попадает в журнал без тела события
  await hook(trig.key, labeled(), { secret: "n" + secret.slice(1), delivery: "dv-bad" });
  const bad = await until(async () => (await (await api(`${base}/${trig.id}/journal`, { token: alice.token, method: "GET" })).json()).filter((r) => r.decision === "bad_signature").length > 0);
  assert.ok(bad, "bad_signature в журнале");
  const errors = await (await api(`${base}/${trig.id}/journal?filter=errors`, { token: alice.token })).json();
  assert.ok(errors.every((r) => ["bad_signature", "too_large", "error"].includes(r.decision)));
});

test("приёмник: выключенный триггер пишет «выключен», запуск не делается", async () => {
  await api(`${base}/${trig.id}/disable`, { token: alice.token, method: "POST", body: {} });
  await hook(trig.key, labeled(202), { secret, delivery: "dv-off" });
  const entry = await until(async () => (await (await api(`${base}/${trig.id}/journal`, { token: alice.token })).json()).find((r) => r.decision === "trigger_disabled" && r.kind === "issue_labeled"));
  assert.ok(entry, "trigger_disabled в журнале");
  await api(`${base}/${trig.id}/enable`, { token: alice.token, method: "POST", body: {} });
});

test("приёмник: лимит 120 запросов в минуту на ключ — 429", async () => {
  const fast = await (await api(base, { token: alice.token, method: "POST", body: { definitionId: pipeId, repo: "octo/hello", kinds: ["issue_opened"] } })).json();
  let last;
  for (let i = 0; i < 121; i++) last = await hook(fast.key, "{}", { secret: fast.secret, event: "ping" });
  assert.equal(last.status, 429);
});

// Последний в файле: сохранение подключения меняет решения событий
// (без подключения — «Нет подключения», с подключением — путь запуска).
test("webhook: setup/ping/recheck/delete на стороне GitHub; право и чужой", async () => {
  const put = await api("/teleharness/api/github/connection", { token: alice.token, method: "PUT", body: { token: GH_TOKEN } });
  assert.equal(put.status, 200, await put.clone().text());

  // нет права Webhooks (fake отдаёт 403 на hooks) → 403
  const locked = await (await api(base, { token: alice.token, method: "POST", body: { definitionId: pipeId, repo: "octo/locked", kinds: ["issue_labeled"] } })).json();
  assert.equal((await api(`${base}/${locked.id}/webhook`, { token: alice.token, method: "POST", body: { key: locked.key } })).status, 403);

  // bob без подключения и не владелец → 404 (чужой не отличим от несуществующего)
  assert.equal((await api(`${base}/${trig.id}/webhook`, { token: bob.token, method: "POST", body: {} })).status, 404);

  // неверный ключ → 422 (ключ хранится только хэшем)
  assert.equal((await api(`${base}/${trig.id}/webhook`, { token: alice.token, method: "POST", body: { key: "z".repeat(43) } })).status, 422);

  const setup = await api(`${base}/${trig.id}/webhook`, { token: alice.token, method: "POST", body: { key: trig.key } });
  assert.equal(setup.status, 200, await setup.clone().text());
  const s = await setup.json();
  assert.equal(s.hookId, 77);
  assert.equal(s.hookConfigured, true);
  assert.equal(s.pinged, true);
  assert.equal(s.hookUrl, `http://127.0.0.1:1/teleharness/hooks/github/${trig.key}`);

  const recheck = await api(`${base}/${trig.id}/webhook/recheck`, { token: alice.token, method: "POST", body: {} });
  assert.equal(recheck.status, 200);
  assert.equal((await recheck.json()).active, true);

  // ротация секрета дообновляет GitHub (fake отвечает 200 на PATCH) —
  // старый секрет сразу не принимается, новый работает
  const rotated = await api(`${base}/${trig.id}/webhook/rotate`, { token: alice.token, method: "POST", body: {} });
  assert.equal(rotated.status, 200);
  const r = await rotated.json();
  assert.equal(r.githubUpdated, true);
  assert.equal((await hook(trig.key, labeled(303), { secret })).status, 401, "старый секрет не принимается");
  assert.equal((await hook(trig.key, labeled(303), { secret: r.secret })).status, 202);
  secret = r.secret;

  const del = await api(`${base}/${trig.id}/webhook`, { token: alice.token, method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).hookConfigured, false);
  // хука больше нет — recheck честно отвечает 422
  assert.equal((await api(`${base}/${trig.id}/webhook/recheck`, { token: alice.token, method: "POST", body: {} })).status, 422);
});

test("список отдаёт сводку: последнее срабатывание, ошибки, неверные подписи (UI 2.2)", async () => {
  const made = await api(base, { token: alice.token, method: "POST", body: { definitionId: pipeId, repo: "octo/hello", kinds: ["issue_labeled"] } });
  assert.equal(made.status, 201, await made.clone().text());
  const t = await made.json();

  const fresh = await (await api(base, { token: alice.token })).json();
  assert.equal(fresh.find((r) => r.id === t.id).lastAt, null, "без событий — lastAt пустой");

  await hook(t.key, labeled(401), { secret: (t.secret[0] === "n" ? "m" : "n") + t.secret.slice(1), delivery: "sv-bad" });
  await hook(t.key, labeled(402), { secret: t.secret, delivery: "sv-ok" });
  await until(async () => (await (await api(`${base}/${t.id}/journal`, { token: alice.token })).json()).some((r) => r.decision === "bad_signature"));
  const list = await (await api(base, { token: alice.token })).json();
  const row = list.find((r) => r.id === t.id);
  assert.ok(row.lastAt > 0, "последнее срабатывание отмечено");
  assert.ok(row.badSignature >= 1, "счётчик неверных подписей");
  assert.ok(row.errors >= 1, "bad_signature входит в ошибки");
  assert.equal(row.ciAttempts, 0);
  assert.equal(row.stormAt, null);
});

test("FEAT-20.3 (2.6, кр. 20): GET/PUT /teleharness/api/admin/background — только admin, общий выключатель, лимит Claude, без утечки токенов", async () => {
  // Тенант получает 403
  assert.equal((await api("/teleharness/api/admin/background", { token: alice.token })).status, 403);
  assert.equal((await api("/teleharness/api/admin/background", { token: alice.token, method: "PUT", body: { adminStopped: true } })).status, 403);

  // Admin читает состояние и список подключений без токенов
  const g1 = await api("/teleharness/api/admin/background", { token: ADMIN });
  assert.equal(g1.status, 200);
  const raw1 = await g1.text();
  assert.ok(!raw1.includes("tokenEnc"), "шифротокен не отдаётся");
  assert.ok(!raw1.includes("ghtest_alice_token_"), "исходный токен не отдаётся");
  const d1 = JSON.parse(raw1);
  assert.equal(d1.adminStopped, false);
  assert.equal(d1.claudePerDay, 10);
  assert.ok(Array.isArray(d1.connections));

  // Валидация 422 на неверный лимит
  assert.equal((await api("/teleharness/api/admin/background", { token: ADMIN, method: "PUT", body: { claudePerDay: -1 } })).status, 422);
  assert.equal((await api("/teleharness/api/admin/background", { token: ADMIN, method: "PUT", body: { adminStopped: "yes" } })).status, 422);

  // Включаем общий выключатель и меняем лимит Claude
  const p1 = await api("/teleharness/api/admin/background", { token: ADMIN, method: "PUT", body: { adminStopped: true, claudePerDay: 25 } });
  assert.equal(p1.status, 200);
  const d2 = await p1.json();
  assert.equal(d2.adminStopped, true);
  assert.equal(d2.claudePerDay, 25);

  // Событие при включённом общем выключателе пишется в журнал как admin_stopped
  const made = await api(base, { token: alice.token, method: "POST", body: { definitionId: pipeId, repo: "octo/hello", kinds: ["issue_labeled"] } });
  const t = await made.json();
  const got = await (await api(`${base}/${t.id}`, { token: alice.token })).json();
  assert.equal(got.activeCount, 0);

  assert.equal((await hook(t.key, labeled(901), { secret: t.secret, delivery: "adm-stop-1" })).status, 202);
  await until(async () => (await (await api(`${base}/${t.id}/journal`, { token: alice.token })).json()).some((r) => r.decision === "admin_stopped"));

  // Снимаем общий выключатель
  const p2 = await api("/teleharness/api/admin/background", { token: ADMIN, method: "PUT", body: { adminStopped: false, claudePerDay: 10 } });
  assert.equal(p2.status, 200);
  assert.equal((await p2.json()).adminStopped, false);
});

});
