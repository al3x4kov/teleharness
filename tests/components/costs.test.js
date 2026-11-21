// FEAT-20.6: «Расходы» (Настройки), лист «Расход чата» из полоски контекста, «Расход запуска»,
// формат денег — по макету epic20-api-equivalent-cost (T-1, T-3, T-4, T-5, T-6, T-7, T-9, T-11, T-14, T-15).
// Run: node --test --test-timeout=60000 tests/components/costs.test.js
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    SettingsView: "src/components/views/SettingsView.jsx",
    sectionsFor: "src/components/views/SettingsView.jsx#sectionsFor",
    CostsSection: "src/components/views/CostsSection.jsx",
    priceFieldError: "src/components/views/CostsSection.jsx#priceFieldError",
    usdFieldError: "src/components/views/CostsSection.jsx#usdFieldError",
    ModelBar: "src/components/chat/ModelBar.jsx",
    RunCost: "src/components/temporal/RunCost.jsx#RunCost",
    fmtCost: "src/lib/costs.js#fmtCost",
    paybackText: "src/lib/costs.js#paybackText",
    onCostEvent: "src/lib/costs.js#onCostEvent",
    costTick: "src/lib/costs.js#costTick",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.me.value = null;
  ui.store.sessions.value = [];
  ui.store.providerCfg.value = null;
  installFetch();
});
const text = (el) => el.textContent.replace(/\u00a0/g, " ");
const PV = { version: 14, createdAt: Date.UTC(2026, 10, 20), createdBy: "admin" };
const SUMMARY = (extra = {}) => ({
  period: { kind: "month", from: "2026-11-01", to: "2026-11-30", month: "2026-11" }, tz: "Europe/Moscow", priceVersion: PV, admin: true,
  totals: { turns: 3312, subscriptionMicro: 1_638_100_000, apiPaidMicro: 4_120_000, subscriptionTurns: 2847, apiTurns: 12, freeTurns: 3, engineEstimateTurns: 0, pricedLateTurns: 0, longCtxTurns: 0, partialTurns: 0 },
  noData: { count: 465, byReason: { legacy: 440, "no-price": 25 } },
  subscriptions: { configured: true, costMicro: 330_000_000, prorated: false, savedMicro: 1_308_100_000, payback: 5, items: [{ id: "s1", title: "Claude Max", providers: ["anthropic"], costMicro: 100e6, apiMicro: 1_200e6, savedMicro: 1_100e6, payback: 12 }] },
  byEngine: [{ engine: "claude", title: "Claude", micro: 1_200e6, turns: 2000, noData: 0 }],
  byModel: [{ model: "claude-opus-5-5", title: "Claude Opus 5.5", billing: "subscription", micro: 1_100e6, turns: 1800, noData: 0, noPrice: false }, { model: "gpt-6.3-nova", title: "gpt-6.3-nova", billing: "subscription", micro: 0, turns: 25, noData: 25, noPrice: true }],
  byProject: [{ project: "/srv/teleharness-portal", micro: 412e6, turns: 118, runs: 6 }],
  topChats: [{ sid: "ses_1", title: "=HYPERLINK(\"x\")", micro: 31_050_000, turns: 46, noData: 1, step: false, deleted: false }, { sid: "ses_gone", title: "старый", micro: 2e6, turns: 3, noData: 0, deleted: true }],
  runs: [{ runId: "wf-1", micro: 2_170_000, turns: 4, maxAttempt: 2 }],
  byDay: [{ day: "2026-11-02", micro: 80e6, noData: 3, turns: 40 }, { day: "2026-11-03", micro: 84e6, noData: 0, turns: 30 }],
  budget: null, ledger: { ok: true }, backfill: [], noPriceModels: 1,
  ...extra,
});

test("формат денег: итог ≥ $100 — целые, строки — центы, < $0,01, нет данных ≠ $0, EN", () => {
  assert.equal(text({ textContent: ui.fmtCost(1_638_100_000, { total: true, approx: true }) }), "≈ $1 638");
  assert.equal(text({ textContent: ui.fmtCost(1_284_600_000) }), "$1 284,60");
  assert.equal(text({ textContent: ui.fmtCost(31_050_000) }), "$31,05");
  assert.equal(text({ textContent: ui.fmtCost(400) }), "< $0,01");
  assert.equal(ui.fmtCost(0), "$0");
  assert.equal(ui.fmtCost(null), "нет данных");
  assert.equal(ui.fmtCost(1_638_100_000, { lang: "en" }), "$1,638.10");
  assert.equal(ui.fmtCost(400, { lang: "en" }), "< $0.01");
  assert.equal(text({ textContent: ui.paybackText(5) }), "окупилась в 5,0 раза");
  assert.equal(ui.priceFieldError("-3", true), "Не меньше 0");
  assert.equal(ui.priceFieldError("", true), "Заполните поле");
  assert.equal(ui.priceFieldError("abc", false), "Нужно число");
  assert.match(ui.usdFieldError("1990 ₽"), /долларах США/);
  assert.equal(ui.usdFieldError("100"), null);
});

test("раздел «Расходы» есть у всех; admin — сводка T-1: по ценам API, подписки, сэкономлено, нет данных, нет цены", async () => {
  assert.ok(ui.sectionsFor({ admin: false }).some((s) => s.id === "costs" && s.title === "Расходы"));
  installFetch([{ method: "GET", path: "/teleharness/api/costs/summary", reply: () => SUMMARY() }]);
  ui.store.me.value = { id: "admin", name: "admin", role: "admin" };
  const { root } = t$.mount(ui.CostsSection, {});
  await t$.waitFor(() => $(root, ".cost-tile.is-main"));
  const t = text(root);
  assert.match(t, /По ценам API · подписочные ходы\s*≈ \$1 638/);
  assert.match(t, /2847 ходов · ещё 465 без данных ›/);
  assert.match(t, /Подписки, факт\s*\$330/);
  assert.match(t, /✓ Сэкономлено\s*≈ \$1 308\s*окупилась в 5,0 раза/);
  assert.match(t, /Оплачено по API\s*\$4,12/);
  assert.match(t, /Нет цены у 1 модели\s*Добавить цену/);
  assert.match(t, /1–30 ноября · пояс Europe\/Moscow · прайс v14 от 20 ноября/);
  assert.match(t, /Удалённый чат/);
  assert.deepEqual($$(root, ".cost-tabs .seg-btn").map((b) => b.textContent), ["Обзор", "Люди", "Прайс", "Подписки", "Бюджеты"]);
  const svg = $(root, "svg.cost-chart");
  assert.equal(svg.getAttribute("role"), "img");
  assert.match(svg.getAttribute("aria-label"), /Есть таблица/);
  $$(root, ".cost-link").find((b) => b.textContent === "Таблицей").click();
  await t$.waitFor(() => $(root, ".cost-table"));
  assert.match(text($(root, ".cost-table")), /2 ноября\s*\$80,00\s*40\s*3/);
  $$(root, ".cost-link").find((b) => /без данных ›/.test(b.textContent)).click();
  await t$.waitFor(() => /Ходы до учёта\s*440/.test(text(root)));
  assert.match(text(root), /не превращаются в \$0/);
});

test("тенант T-6: только свой обзор — без вкладок admin, без подписок и «сэкономлено»; бюджет 86 %", async () => {
  installFetch([{ method: "GET", path: "/teleharness/api/costs/summary", reply: () => ({ ...SUMMARY({ admin: false, budget: { usdMonthMicro: 100e6, spentMicro: 86e6, pct: 86, month: "2026-11" } }), subscriptions: undefined, noPriceModels: undefined }) }]);
  ui.store.me.value = { id: "u_m", name: "marina", role: "user" };
  const { root } = t$.mount(ui.CostsSection, {});
  await t$.waitFor(() => $(root, ".cost-tile.is-main"));
  const t = text(root);
  assert.equal($(root, ".cost-tabs"), null);
  assert.match(t, /Мой расход по ценам API/);
  assert.match(t, /с вас ничего не списывается/);
  assert.match(t, /Вы израсходовали 86 % месячного бюджета по ценам API\. Ходы не ограничиваются/);
  assert.doesNotMatch(t, /Сэкономлено|Подписки, факт|Нет цены/);
});

test("BUG-277: без ходов за период — строка вместо пустого графика; домашняя папка — «Домашняя папка»; легенда парами", async () => {
  installFetch([{ method: "GET", path: "/teleharness/api/costs/summary", reply: () => ({ ...SUMMARY({ admin: false, byDay: [], byProject: [] }), subscriptions: undefined, noPriceModels: undefined }) }]);
  ui.store.me.value = { id: "u_m", name: "marina", role: "user" };
  const empty = t$.mount(ui.CostsSection, {});
  await t$.waitFor(() => $(empty.root, ".cost-tile.is-main"));
  assert.equal($(empty.root, ".cost-chart"), null, "пустой график не рисуется");
  assert.equal($(empty.root, ".cost-chart-empty").textContent, "За период ходов нет.");
  assert.doesNotMatch(text(empty.root), /в среднем \$0 в день/);
  t$.cleanup();
  installFetch([{ method: "GET", path: "/teleharness/api/costs/summary", reply: () => SUMMARY({ byProject: [{ project: "C:\\Users\\USER", micro: 5e6, turns: 3, runs: 0 }, { project: "/home/al", micro: 1e6, turns: 1, runs: 0 }] }) }]);
  ui.store.me.value = { id: "u_a", name: "admin", role: "admin" };
  const { root } = t$.mount(ui.CostsSection, {});
  await t$.waitFor(() => $(root, ".cost-legend"));
  const proj = $$(root, ".cost-card").find((c) => $(c, "h3")?.textContent === "Проекты");
  assert.deepEqual($$(proj, ".cost-row-title").map((x) => x.textContent), ["Домашняя папка", "Домашняя папка"]);
  assert.deepEqual($$(root, ".cost-legend-item").map((x) => x.textContent), ["по ценам API", "есть ходы без данных"]);
});

test("без подписок T-7 — приглашение; учёт истории; журнал недоступен T-9 (admin / тенант)", async () => {
  installFetch([{ method: "GET", path: "/teleharness/api/costs/summary", reply: () => SUMMARY({ subscriptions: { configured: false, items: [], costMicro: 0, savedMicro: null, payback: null }, backfill: [{ source: "claude", done: false, progress: 312, total: 692 }, { source: "opencode", done: false, error: "сервер opencode не отвечает", progress: 0, total: 0 }] }) }]);
  ui.store.me.value = { id: "admin", role: "admin" };
  let { root } = t$.mount(ui.CostsSection, {});
  await t$.waitFor(() => $(root, ".cost-tile.is-invite"));
  assert.match(text(root), /Сколько вы платите за подписки\?.*Указать подписки/s);
  assert.match(text(root), /Считаем историю: 312 из 692 ходов/);
  assert.match(text(root), /История opencode не загружена: сервер opencode не отвечает\. Повторим через 10 мин\./);
  t$.cleanup();
  installFetch([{ method: "GET", path: "/teleharness/api/costs/summary", reply: () => ({ status: 503, body: { error: "ledger-unavailable" } }) }]);
  ({ root } = t$.mount(ui.CostsSection, {}));
  await t$.waitFor(() => $(root, ".cost-banner.is-error"));
  assert.match(text(root), /Журнал расхода недоступен.*Чаты и запуски работают как обычно/s);
  t$.cleanup();
  ui.store.me.value = { id: "u_m", role: "user" };
  ({ root } = t$.mount(ui.CostsSection, {}));
  await t$.waitFor(() => $(root, ".cost-banner.is-error"));
  assert.match(text(root), /Расходы временно недоступны\. Ваши ходы и чаты не пострадали/);
});

test("подписка в рублях не сохраняется (T-14); прайс: правка -3 — ошибка у поля, «Сохранить» недоступно (T-11)", async () => {
  const PRICES = { ...PV, models: [{ id: "glm-5.3", title: "GLM-5.3", usdPerMTok: { input: 1.4, output: 4.4, cacheRead: 0.26 }, source: "https://docs.z.ai/guides/overview/pricing", checkedAt: "2026-07-22" }], versions: [{ version: 14, createdAt: PV.createdAt, createdBy: "admin", note: "правка" }], warnings: { noPrice: [{ model: "gpt-6.3-nova", turns: 32 }], stale: [{ id: "glm-5.3", title: "GLM-5.3", checkedAt: "2026-07-22", days: 121 }], mismatch: [{ model: "claude-opus-5-5", title: "Claude Opus 5.5", pct: 27 }] }, staleDays: 90 };
  installFetch([
    { method: "GET", path: "/teleharness/api/costs/prices", reply: () => PRICES },
    { method: "GET", path: "/teleharness/api/costs/subscriptions", reply: () => ({ version: 1, items: [] }) },
  ]);
  ui.store.me.value = { id: "admin", role: "admin" };
  const { root } = t$.mount(ui.CostsSection, { initialTab: "prices" });
  await t$.waitFor(() => /GLM-5\.3/.test(text(root)));
  const t = text(root);
  assert.match(t, /Нет цены у 1 модели: gpt-6\.3-nova \(32 хода\)/);
  assert.match(t, /оценка Claude Code выше прайса на 27 % за 7 дней\. Проверьте цену/);
  assert.match(t, /проверено 22 июля — 121 день/);
  $$(root, ".cost-row.is-link")[0].click();
  await t$.waitFor(() => document.querySelector(".modal .cost-form"));
  const modal = document.querySelector(".modal");
  const input = [...modal.querySelectorAll(".cost-field")].find((l) => /Вход, \$ за 1 млн/.test(l.textContent)).querySelector("input");
  input.value = "-3";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await t$.waitFor(() => /Не меньше 0/.test(modal.textContent));
  const saveBtn = [...modal.querySelectorAll("button")].find((b) => b.textContent === "Сохранить");
  assert.equal(saveBtn.disabled, true);
});

test("лист «Расход чата» T-3/T-4 из полоски контекста: модели после Relay, субагенты, служебные, нет данных; без «$» в полоске", async () => {
  const CHAT = { sid: "ses_c", turns: 20, totalMicro: 4_460_000, priced: 19, billing: "subscription", byModel: [{ model: "claude-opus-5-5", title: "Claude Opus 5.5", engine: "claude", micro: 3_840_000, turns: 14, noData: 0, tokens: 1_200_000 }, { model: "gpt-6.1-sol", title: "GPT-6.1 Sol", engine: "codex", micro: 620_000, turns: 6, noData: 1, tokens: 300_000 }], subagents: { count: 1, micro: 60_000, noData: 0 }, service: { count: 3, micro: 10_000, noData: 0 }, tokens: { in: 1000, out: 2000, reason: 300, cacheRead: 900_000, w5m: 1000, w1h: 2000 }, noData: { count: 1, byReason: { interrupted: 1 }, last: { reason: "interrupted", at: Date.UTC(2026, 10, 20, 11, 32), engine: "claude" } }, partialTurns: 0, longCtxTurns: 0, pricedLateTurns: 0, engineEstimateTurns: 0, cacheSavingPct: 71, priceVersion: PV, banner: null };
  installFetch([{ method: "GET", path: "/teleharness/api/costs/chat/ses_c", reply: () => CHAT }]);
  ui.store.providerCfg.value = { models: [{ id: "claude-opus-5-5", providerID: "anthropic", label: "Claude Opus 5.5", contextLimit: 1_000_000 }] };
  ui.store.sessions.value = [{ id: "ses_c", title: "t", directory: "/w", time: { created: 1, updated: 1 }, teleharness: { model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent: null, prompted: true, engine: "claude" } }];
  const msgs = [{ info: { id: "u1", role: "user", time: { created: 1 } }, parts: [] }, { info: { id: "a1", role: "assistant", providerID: "anthropic", modelID: "claude-opus-5-5", tokens: { input: 10, output: 10, cache: { read: 420_000, write: 0 }, context: 420_000 }, cost: 3.2, time: { created: 2, completed: 3 } }, parts: [] }];
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_c", hasMessages: true, messages: msgs });
  const meter = await t$.waitFor(() => $(root, "button.ctx-meter"));
  assert.doesNotMatch(meter.textContent, /\$/, "в полоске «$» нет (Q1-а, BUG-01.12)");
  meter.click();
  const sheet = await t$.waitFor(() => document.querySelector(".chat-cost-sheet .cost-big"));
  const t = text(sheet.closest(".chat-cost-sheet"));
  assert.match(t, /Расход чата/);
  assert.match(t, /≈ \$4,46/);
  assert.match(t, /по ценам API · 20 ходов · подписка: деньги за них не списывались/);
  assert.match(t, /Claude Opus 5\.5.*\$3,84/s);
  assert.match(t, /GPT-6\.1 Sol.*\$0,62/s);
  assert.match(t, /Субагенты · 1\s*\$0,06/);
  assert.match(t, /Служебные вызовы · 3\s*\$0,01/);
  assert.match(t, /Кэш сократил стоимость входа на 71 %/);
  assert.match(t, /Нет данных: 1 ход — прерван в \d\d:\d\d до отчёта Claude/);
  assert.match(t, /Сумма неполная/);
});

test("баннер бюджета в чате T-18 — один раз: «Понятно» отмечает показ", async () => {
  let seen = 0;
  installFetch([
    { method: "GET", path: "/teleharness/api/costs/chat/ses_c", reply: () => ({ turns: 0, banner: seen ? null : { threshold: 80, pct: 82, month: "2026-11" } }) },
    { method: "POST", path: "/teleharness/api/costs/chat/ses_c/banner-seen", reply: () => { seen += 1; return { ok: true }; } },
  ]);
  ui.store.sessions.value = [{ id: "ses_c", title: "t", directory: "/w", time: { created: 1, updated: 1 }, teleharness: { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: null, prompted: true } }];
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_c", hasMessages: true, messages: [] });
  const b = await t$.waitFor(() => $(root, ".cost-budget-banner"));
  assert.match(text(b), /Вы израсходовали 82 % месячного бюджета по ценам API\. Ходы не ограничиваются/);
  $(b, "button").click();
  await t$.waitFor(() => seen === 1 && !$(root, ".cost-budget-banner"));
});

test("«Расход запуска» T-5: попытки шага отдельными строками; событие teleharness.cost.updated перечитывает", async () => {
  let calls = 0;
  installFetch([{ method: "GET", path: "/teleharness/api/costs/run/wf-1", reply: () => { calls += 1; return { runId: "wf-1", totalMicro: 2_170_000, turns: 4, noData: 0, retries: 1, steps: [{ stepId: "s1", attempt: 1, title: "Claude Opus 5.5", status: "ok", micro: 1e6, turns: 1, noData: 0, retried: false }, { stepId: "s2", attempt: 1, title: "GPT-6.1 Sol", status: "interrupted", micro: 400_000, turns: 1, noData: 0, retried: true }, { stepId: "s2", attempt: 2, title: "GPT-6.1 Sol", status: "ok", micro: 770_000, turns: 2, noData: 0, retried: true }] }; } }]);
  const { root } = t$.mount(ui.RunCost, { workflowId: "wf-1", steps: [{ id: "s1", name: "Анализ" }, { id: "s2", name: "Ревью" }] });
  await t$.waitFor(() => $(root, ".cost-big"));
  const t = text(root);
  assert.match(t, /Расход запуска\s*≈ \$2,17/);
  assert.match(t, /4 хода моделей · 1 повтор/);
  assert.match(t, /Ревью · попытка 1.*прерван, расход учтён.*\$0,40.*Ревью · попытка 2.*\$0,77/s);
  ui.onCostEvent({ type: "teleharness.cost.updated", properties: { runId: "wf-1" } });
  await t$.waitFor(() => calls === 2);
  assert.ok(fetchCalls.every((c) => c.path.startsWith("/teleharness/api/costs/")));
});
