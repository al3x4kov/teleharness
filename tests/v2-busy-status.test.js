// BUG-211 (BUG-16.28): тип v2 «running» адаптер переводит в «busy» языка 1.x.
// TASK-16.7: скрипты выката (RealBusy: type === "busy"), /zai/api/status и пробы
// ждут busy; без перевода выкат видел 0 занятых и мог рестартовать портал посреди
// хода. Юнит на фейковом fetchImpl — без сети (в стиле tests/oc-client.test.js).
// Run: node --test tests/v2-busy-status.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOcClient } from "../lib/oc-client.js";

const PWD = "oc2-secret";
const BASE = "http://127.0.0.1:9"; // адрес не используется: сеть подменяет fetchImpl

// Фейковый fetchImpl: конверт v2 {data} на GET /api/session/active + проверка транспорта.
const fakeFetch = (active) => async (url, opts = {}) => {
  assert.equal(opts.method, "GET", "карта занятости — GET");
  assert.ok(String(url).startsWith(`${BASE}/api/session/active`), `ожидали /api/session/active, пришли ${url}`);
  assert.equal(new URL(url).search, "", "карта глобальная: без location[directory]");
  assert.equal(opts.headers.authorization, `Basic ${Buffer.from(`opencode:${PWD}`).toString("base64")}`, "пароль только в Basic");
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: active }) };
};

test("BUG-211: GET /api/session/active отдаёт сессию с типом running → busyMap() отдаёт её с типом busy (язык 1.x)", async () => {
  const c = createOcClient({ api: "v2", base: BASE, password: PWD, fetchImpl: fakeFetch({ ses_run: { type: "running" } }) });
  assert.deepEqual(await c.busyMap(), { ses_run: { type: "busy" } });
});

test("BUG-211: прочие поля записи сохраняются, меняется только тип", async () => {
  const c = createOcClient({ api: "v2", base: BASE, password: PWD, fetchImpl: fakeFetch({ ses_run: { type: "running", since: 42, sessionID: "ses_run" } }) });
  assert.deepEqual(await c.busyMap(), { ses_run: { type: "busy", since: 42, sessionID: "ses_run" } });
});

test("BUG-211: тип не «running» — как в ответе upstream (не busy); сессии не в работе в карте нет", async () => {
  const c = createOcClient({
    api: "v2", base: BASE, password: PWD,
    fetchImpl: fakeFetch({ ses_retry: { type: "retry" }, ses_idle: { type: "idle" } }),
  });
  const map = await c.busyMap();
  assert.deepEqual(map.ses_retry, { type: "retry" }, "retry не превращается в busy");
  assert.deepEqual(map.ses_idle, { type: "idle" }, "idle не превращается в busy");
  assert.equal(map.ses_run, undefined, "сессии не в работе в карте нет");
});

test("BUG-211: пустой active → пустая карта занятости", async () => {
  const c = createOcClient({ api: "v2", base: BASE, password: PWD, fetchImpl: fakeFetch({}) });
  assert.deepEqual(await c.busyMap(), {});
});
