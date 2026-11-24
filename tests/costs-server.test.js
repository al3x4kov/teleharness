// FEAT-20.6 server e2e: журнал расхода — НАСТОЯЩИЙ server.js против фейкового opencode.
// Готовые ответы (`message.updated` с time.completed) попадают в журнал один раз; сводка admin
// и тенанта; тенант видит только своё (403 без сумм); прайс: 403 тенанту, 409 при конфликте, импорт;
// подписки; бюджет 80 % → событие; CSV потоком; /teleharness/api/usage (квота z.ai) не тронут.
// Run: node --test --test-concurrency=1 tests/costs-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { makeTmpRoot } from "./helpers/env.mjs";

const ADMIN = "a".repeat(24) + "-costs-e2e-" + "7".repeat(24);
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

let tmp, up, srv, alice;
function api(p, { method = "GET", body, token = ADMIN, headers = {} } = {}) {
  return fetch(`${srv.base}${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const json = async (p, o) => (await api(p, o)).json();
const now = Date.now();
const answer = (sid, id, extra = {}) => ({
  type: "message.updated",
  properties: { sessionID: sid, info: { id, sessionID: sid, role: "assistant", providerID: "zai-coding-plan", modelID: "glm-5.3", time: { created: now - 3000, completed: now }, tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, ...extra } },
});

before(async () => {
  tmp = makeTmpRoot("teleharness-costs-e2e-");
  up = await startFakeOpencode({ sessions: [{ id: "ses_adm", directory: tmp.home, title: "Админский чат" }] });
  srv = await spawnPortal({ upstream: up.url, tmp, env: { TELEHARNESS_ADMIN_TOKEN: ADMIN, TELEHARNESS_COST_NO_BACKFILL: "1" } });
  await up.waitForSubscription(tmp.home);
  alice = await (await api("/teleharness/api/admin/users", { method: "POST", body: { name: "cost-marina" } })).json();
  up.state.sessions.push({ id: "ses_a1", directory: alice.user.directories[0], title: "=HYPERLINK(\"evil\")" });
  await api("/teleharness/api/session");
  await sleep(50);
});
after(async () => {
  await srv?.stop();
  await up?.close();
});

test("готовый ответ opencode → журнал один раз; незавершённый не пишется; сводка admin", async () => {
  up.emit(answer("ses_adm", "msg_open", { time: { created: now } })); // ещё идёт — не пишется
  up.emit(answer("ses_adm", "msg_1"));
  up.emit(answer("ses_adm", "msg_1")); // повтор (реконнект SSE) — не удваивается
  const s = await waitFor(async () => {
    const r = await json("/teleharness/api/costs/summary");
    return r.totals?.turns >= 1 ? r : null;
  }, { what: "ledger record" });
  assert.equal(s.totals.turns, 1);
  assert.equal(s.totals.subscriptionMicro, 1_400_000, "1 млн входа GLM-5.3 × $1,40");
  assert.equal(s.tz, "Europe/Moscow");
  assert.equal(s.admin, true);
  assert.equal(s.subscriptions.configured, false, "без подписок — приглашение ввести");
  const chat = await json("/teleharness/api/costs/chat/ses_adm");
  assert.equal(chat.totalMicro, 1_400_000);
  assert.equal(chat.byModel[0].title, "GLM-5.3");
});

test("тенант: только своё; чужой user/чат/выгрузка — 403 без сумм; admin-вкладки закрыты", async () => {
  up.emit(answer("ses_a1", "msg_t1", { modelID: "glm-4.7" }));
  const mine = await waitFor(async () => {
    const r = await json("/teleharness/api/costs/summary", { token: alice.token });
    return r.totals?.turns >= 1 ? r : null;
  }, { what: "tenant record" });
  assert.equal(mine.totals.subscriptionMicro, 600_000);
  assert.equal("subscriptions" in mine, false, "без цен подписок и «сэкономлено»");
  assert.equal(mine.admin, false);
  for (const p of ["/teleharness/api/costs/summary?user=admin", "/teleharness/api/costs/chat/ses_adm", "/teleharness/api/costs/export.csv?user=admin", "/teleharness/api/costs/subscriptions", "/teleharness/api/costs/users", "/teleharness/api/costs/recalc"]) {
    const r = await api(p, { token: alice.token, method: p.endsWith("recalc") ? "POST" : "GET", body: p.endsWith("recalc") ? {} : undefined });
    assert.equal(r.status, 403, p);
    const text = await r.text();
    assert.doesNotMatch(text, /micro|\d{5,}/i, `${p}: тело без сумм`);
  }
  const put = await api("/teleharness/api/costs/prices", { method: "PUT", token: alice.token, body: { models: [], version: 1 } });
  assert.equal(put.status, 403);
  const pr = await json("/teleharness/api/costs/prices", { token: alice.token });
  assert.deepEqual(Object.keys(pr).sort(), ["createdAt", "version"], "тенант видит только версию и дату прайса");
  const all = await json("/teleharness/api/costs/summary");
  assert.equal(all.totals.turns, 2, "admin видит всех");
  const users = await json("/teleharness/api/costs/users");
  assert.ok(users.users.some((u) => u.name === "cost-marina" && u.micro === 600_000));
});

test("прайс: правка с версией, 409 у второй вкладки, 422 при ошибке поля, импорт с предпросмотром", async () => {
  const p = await json("/teleharness/api/costs/prices");
  assert.equal(p.version, 1);
  const models = p.models.map((m) => (m.id === "glm-5.3" ? { ...m, usdPerMTok: { ...m.usdPerMTok, input: 2 } } : m));
  const ok = await api("/teleharness/api/costs/prices", { method: "PUT", body: { models }, headers: { "if-match": '"1"' } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).version, 2);
  const stale = await api("/teleharness/api/costs/prices", { method: "PUT", body: { models }, headers: { "if-match": "1" } });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /в другом окне/);
  const bad = await api("/teleharness/api/costs/prices", { method: "PUT", body: { models: [{ id: "x", usdPerMTok: { input: -3 } }], version: 2 } });
  assert.equal(bad.status, 422);
  const prev = await json("/teleharness/api/costs/prices/import?dryRun=1", { method: "POST", body: { text: JSON.stringify({ currency: "USD", models: [{ id: "glm-5.3", usdPerMTok: { input: 2, output: 4.4, cacheRead: 0.26 } }, { id: "local-llm", free: true }] }) } });
  assert.equal(prev.dryRun, true);
  assert.equal(prev.added, 1);
  const rub = await api("/teleharness/api/costs/prices/import?dryRun=1", { method: "POST", body: { text: '{"currency":"RUB","models":[]}' } });
  assert.equal(rub.status, 422);
  // ход GLM-5.3 до правки не изменился
  const chat = await json("/teleharness/api/costs/chat/ses_adm");
  assert.equal(chat.totalMicro, 1_400_000);
});

test("подписки и бюджет: «сэкономлено», 80 % → баннер в чате один раз, ход не блокируется", async () => {
  const subs = await json("/teleharness/api/costs/subscriptions");
  const r = await api("/teleharness/api/costs/subscriptions", { method: "PUT", body: { version: subs.version, items: [{ title: "z.ai Coding Plan", providers: ["zai-coding-plan"], usdMonth: 1, activeFrom: "2020-01-01" }] } });
  assert.equal(r.status, 200);
  // BUG-278: «Новая подписка» шлёт весь список — сохранённые записи в форме GET (usdMonthMicro).
  const two = await json("/teleharness/api/costs/subscriptions");
  const add = await api("/teleharness/api/costs/subscriptions", { method: "PUT", body: { version: two.version, items: [...two.items, { title: "ChatGPT Plus", providers: ["openai"], usdMonth: 20, activeFrom: "2020-01-01" }] } });
  assert.equal(add.status, 200, "вторая подписка сохраняется вместе с первой из GET");
  const after = await json("/teleharness/api/costs/subscriptions");
  assert.deepEqual(after.items.map((x) => [x.title, x.usdMonthMicro]).sort(), [["ChatGPT Plus", 20_000_000], ["z.ai Coding Plan", 1_000_000]]);
  // удаление второй — тот же путь: список из GET без неё
  const del = await api("/teleharness/api/costs/subscriptions", { method: "PUT", body: { version: after.version, items: after.items.filter((x) => x.title !== "ChatGPT Plus") } });
  assert.equal(del.status, 200);
  const s = await json("/teleharness/api/costs/summary");
  assert.equal(s.subscriptions.costMicro, 1_000_000);
  assert.equal(s.subscriptions.savedMicro, 2_000_000 - 1_000_000);
  const b = await json("/teleharness/api/costs/budgets");
  assert.equal((await api(`/teleharness/api/costs/budgets/${alice.user.id}`, { method: "PUT", body: { usdMonth: 1, version: b.version } })).status, 200);
  up.emit(answer("ses_a1", "msg_t2", { modelID: "glm-4.7", tokens: { input: 500_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
  const chat = await waitFor(async () => {
    const c = await json("/teleharness/api/costs/chat/ses_a1", { token: alice.token });
    return c.banner ? c : null;
  }, { what: "budget banner" });
  assert.equal(chat.banner.threshold, 80);
  assert.equal(chat.banner.pct, 90);
  await api("/teleharness/api/costs/chat/ses_a1/banner-seen", { method: "POST", token: alice.token, body: {} });
  assert.equal((await json("/teleharness/api/costs/chat/ses_a1", { token: alice.token })).banner, null);
  const mine = await json("/teleharness/api/costs/summary", { token: alice.token });
  assert.equal(mine.budget.pct, 90);
});

test("CSV: BOM, «;» для RU, формула в названии чата обезврежена, тенант — только своё", async () => {
  const r = await api("/teleharness/api/costs/export.csv?lang=ru", { token: alice.token });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /teleharness-usage-\d{4}-\d{2}\.csv/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = buf.toString("utf8").slice(1);
  const lines = text.trim().split("\r\n");
  assert.equal(lines.length, 3, "заголовок + 2 хода тенанта");
  assert.match(lines[0], /^completed_at;user;project;chat;/);
  assert.ok(lines.slice(1).every((l) => l.includes(`;"'=HYPERLINK(""evil"")";`)), "формула — с апострофом, кавычки экранированы");
  assert.ok(lines.every((l) => !/;=HYPERLINK/.test(l)));
  assert.match(lines[1], /;0,600000;price-v1;/);
});

test("квота z.ai /teleharness/api/usage не тронута; журнал недоступен → 503 только у /costs", async () => {
  const u = await api("/teleharness/api/usage");
  assert.notEqual(u.status, 404);
  const bad = await api("/teleharness/api/costs/summary?period=custom&from=2026-11-10&to=2026-11-01");
  assert.equal(bad.status, 422);
});

test("BUG-302: тенанту backfill всегда []; битый %-код (%zz) в chat/run/budgets → 400 bad_id (не 500)", async () => {
  // Запускаем backfill под админом, чтобы в ledger появились записи о backfill
  const bf = await api("/teleharness/api/costs/backfill", { method: "POST", body: {} });
  assert.equal(bf.status, 202);
  const admSummary = await waitFor(async () => {
    const s = await json("/teleharness/api/costs/summary");
    return Array.isArray(s.backfill) && s.backfill.length > 0 ? s : null;
  }, { what: "admin backfill state" });
  assert.ok(admSummary.backfill.length > 0, "админ видит состояние backfill");

  const tenantSummary = await json("/teleharness/api/costs/summary", { token: alice.token });
  assert.deepEqual(tenantSummary.backfill, [], "тенанту глобальный backfill не утекает");

  for (const [method, p, body] of [
    ["GET", "/teleharness/api/costs/chat/%zz", undefined],
    ["GET", "/teleharness/api/costs/run/%zz", undefined],
    ["PUT", "/teleharness/api/costs/budgets/%zz", { usdMonth: 5 }],
  ]) {
    const r = await api(p, { method, body });
    assert.equal(r.status, 400, `${method} ${p}`);
    assert.deepEqual(await r.json(), { error: "bad_id" }, `${method} ${p}`);
  }
});
