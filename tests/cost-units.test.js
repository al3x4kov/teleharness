// FEAT-20.6: журнал расхода по ценам API — нормализация движков, прайс, сумма хода, «нет данных»,
// версии прайса, пересчёт, подписки, бюджеты, пояс отчётов, попытки шагов, учёт истории, CSV.
// Run: node --test tests/cost-units.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeTurnUsage, translateEvent } from "../lib/claude.js";
import { codexTurnModelUsage } from "../lib/codex-shim.mjs";
import { normalizeAnswer, statusOf } from "../lib/cost/normalize.js";
import { builtinTable, diffTables, findPrice, normModelId, parseImport, priceTurn, validateTable } from "../lib/cost/prices.js";
import { CostError, CostLedger, dayMonth } from "../lib/cost/ledger.js";
import { CostRecorder, engineOfAnswer } from "../lib/cost/recorder.js";
import { CostReports, resolvePeriod, subscriptionCost } from "../lib/cost/report.js";
import { CostBackfill } from "../lib/cost/backfill.js";
import { csvCell, csvRow, microToUsd, streamCsv } from "../lib/cost/csv.js";
import { resultRecord } from "../lib/oneshot.js";

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "claude-stream-subagent-2.1.322.jsonl");
const results = () => readFileSync(FIX, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "result");
const T0 = Date.UTC(2026, 10, 20, 9, 0, 0); // 20 ноя 2026 12:00 MSK

function mk({ now = () => T0, owner = { id: "u_adm", name: "admin" } } = {}) {
  const ledger = new CostLedger({ file: ":memory:", now, log: () => {} });
  const rec = new CostRecorder({ ledger, deps: { ownerOf: () => owner, titleOf: (sid) => `чат ${sid}` } });
  const rep = new CostReports({ ledger, now });
  return { ledger, rec, rep };
}
const claudeInfo = (id, extra = {}) => ({ id, sessionID: "ses_c", role: "assistant", providerID: "anthropic", modelID: "claude-opus-5-5", time: { created: T0 - 5000, completed: T0 }, ...extra });
const ocInfo = (id, extra = {}) => ({ id, sessionID: "ses_o", role: "assistant", providerID: "zai-coding-plan", modelID: "glm-5.3", time: { created: T0 - 5000, completed: T0 }, tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 4000, write: 0 } }, cost: 0, ...extra });

// --- нормализация ---------------------------------------------------------------------

test("Claude: сумма хода — по приросту model_usage_since_last_result (с субагентом), кэш 5m/1h раздельно; совпадает с costUSD CLI", () => {
  const [r0] = results();
  const u = claudeTurnUsage(translateEvent(r0), null, "claude-haiku-4-5");
  assert.equal(u.tokens.output, 388, "в ленте — по-прежнему основной разговор (FEAT-18.5 не меняется)");
  assert.deepEqual(u.usageByModel.map((e) => [e.model, e.in, e.out, e.cacheRead, e.w5m, e.w1h]), [["claude-haiku-4-5", 45, 931, 90560, 17917, 9846]]);
  const n = normalizeAnswer("claude", { modelID: "claude-haiku-4-5", ...u });
  assert.equal(n.engineCostMicro, 55844);
  const p = priceTurn(builtinTable(), n.byModel, { context: n.tokens.context });
  assert.equal(p.costMicro, 55844, "встроенный прайс Haiku 4.5 = оценка Claude Code до микродоллара");
});

test("Claude: второй `result` того же процесса — накопительный modelUsage не удваивается (пустой прирост)", () => {
  const [, r1] = results();
  const u = claudeTurnUsage(translateEvent(r1), null, "claude-haiku-4-5");
  assert.deepEqual(u.usageByModel, []);
  assert.equal(r1.total_cost_usd, results()[0].total_cost_usd, "total_cost_usd накопительный — для хода не годится");
});

test("Claude без прироста (старый CLI / история): result.usage, пометка «без субагентов», кэш без деления — 5 мин", () => {
  const n = normalizeAnswer("claude", claudeInfo("m1", { tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 1000, write: 500 } }, cost: 157.13 }));
  assert.equal(n.partial, true);
  assert.equal(n.engineCostMicro, null, "info.cost накопительный — не цена хода");
  assert.deepEqual([n.tokens.in, n.tokens.out, n.tokens.cacheRead, n.tokens.w5m, n.tokens.w1h], [10, 100, 1000, 500, 0]);
});

test("Codex: прирост хода — вход без кэша, кэш отдельно, reasoning внутри выхода (сценарий spec 15 590 / 12 288 / 113)", () => {
  const mu = codexTurnModelUsage({ inputTokens: 15590, cachedInputTokens: 12288, cacheWriteInputTokens: 0, outputTokens: 113, reasoningOutputTokens: 64 });
  const u = claudeTurnUsage({ usage: { input_tokens: 3302, output_tokens: 113 }, sinceLast: { "gpt-6.1-sol": mu } }, null, "gpt-6.1-sol");
  const n = normalizeAnswer("codex", { modelID: "gpt-6.1-sol", ...u });
  assert.deepEqual([n.tokens.in, n.tokens.cacheRead, n.tokens.out, n.tokens.reason], [3302, 12288, 113, 64]);
  assert.equal(n.engineCostMicro, null, "Codex цену не сообщает");
  // 3302 × $2 + 12288 × $0,10 + 113 × $10 = 6604 + 1228,8 + 1130 = 8962,8 µ$
  assert.equal(priceTurn(builtinTable(), n.byModel).costMicro, 8963);
});

test("opencode: reasoning оплачивается как выход; cost платного провайдера — реальные траты", () => {
  const n = normalizeAnswer("opencode", ocInfo("o1"));
  assert.equal(n.tokens.out, 250);
  assert.equal(n.tokens.reason, 50);
  const paid = normalizeAnswer("opencode", ocInfo("o2", { providerID: "openrouter", cost: 0.08 }));
  assert.equal(paid.engineCostMicro, 80000);
});

test("статус хода: прерван / сбой / ошибка / готов", () => {
  assert.equal(statusOf({ teleharness: { interrupted: "user" } }), "interrupted");
  assert.equal(statusOf({ teleharness: { interrupted: "restart" } }), "crash");
  assert.equal(statusOf({ turnError: true }), "error");
  assert.equal(statusOf({ error: { name: "APIError" } }), "error");
  assert.equal(statusOf({}), "ok");
  assert.equal(engineOfAnswer({ id: "msgc_a_1", providerID: "openai-codex" }), "codex");
  assert.equal(engineOfAnswer({ id: "msgc_a_1", providerID: "anthropic" }), "claude");
  assert.equal(engineOfAnswer({ id: "msg_x", providerID: "anthropic" }), "opencode");
});

test("служебный вызов: запись `result` одноразового CLI читается и для is_error", () => {
  const out = JSON.stringify({ type: "result", is_error: false, result: "feat: x", usage: { input_tokens: 5, output_tokens: 7 } });
  assert.equal(resultRecord(out).usage.output_tokens, 7);
  assert.equal(resultRecord("мусор"), null);
});

// --- прайс ----------------------------------------------------------------------------

test("прайс: встроенные цены проверены и с источником; моделей без проверенной цены нет", () => {
  const t = builtinTable();
  for (const m of t.models) {
    assert.match(m.source, /^https:\/\/(platform\.claude\.com|developers\.openai\.com|docs\.z\.ai)\//, m.id);
    assert.match(m.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.deepEqual(validateTable(t), []);
  assert.equal(findPrice(t, "anthropic/claude-opus-5-5[1m]")?.id, "claude-opus-5-5");
  assert.equal(normModelId(" GPT-6.1-Sol "), "gpt-6.1-sol");
  assert.equal(findPrice(t, "gpt-6.3-nova"), null, "выдуманных моделей в прайсе нет");
});

test("длинный контекст (Haiku 5.5 > 100 тыс.) и быстрый режим; бесплатная модель ≠ модель без цены", () => {
  const t = builtinTable();
  const e = { model: "claude-haiku-5-5", in: 1_000_000, out: 0, cacheRead: 0, w5m: 0, w1h: 0 };
  assert.equal(priceTurn(t, [e], { context: 90_000 }).costMicro, 100_000);
  const long = priceTurn(t, [e], { context: 140_000 });
  assert.equal(long.costMicro, 500_000);
  assert.equal(long.longCtx, true);
  assert.equal(priceTurn(t, [{ model: "claude-opus-5-5", in: 0, out: 1_000_000 }], { speed: "fast" }).costMicro, 40_000_000);
  const free = priceTurn(t, [{ model: "glm-4.7-flash", in: 5000, out: 10 }]);
  assert.deepEqual([free.costMicro, free.free], [0, true]);
  const unknown = priceTurn(t, [{ model: "llama3:8b", in: 5000, out: 10 }]);
  assert.equal(unknown.costMicro, null, "нет цены — не $0");
  assert.deepEqual(unknown.noPrice, ["llama3:8b"]);
});

test("проверка полей прайса и импорт: -3, пусто, > $500 без подтверждения, RUB, битый JSON — со строкой", () => {
  const bad = validateTable({ models: [{ id: "x", usdPerMTok: { input: -3 } }] });
  assert.deepEqual(bad.map((e) => [e.field, e.code]), [["input", "negative"], ["output", "required"]]);
  const hi = validateTable({ models: [{ id: "x", usdPerMTok: { input: 2000, output: 1 } }] });
  assert.equal(hi[0].code, "confirm-high");
  assert.deepEqual(validateTable({ models: [{ id: "x", usdPerMTok: { input: 2000, output: 1 } }] }, { confirmHigh: true }), []);
  const rub = parseImport('{\n "currency": "RUB",\n "models": []\n}');
  assert.equal(rub.error.line, 2);
  assert.match(rub.error.message, /currency.*RUB.*только USD/);
  const broken = parseImport('{\n "models": [\n  {"id": "a",\n }\n]}');
  assert.equal(broken.error.message, "Битый JSON");
  assert.ok(broken.error.line >= 3);
  const ok = parseImport(JSON.stringify({ currency: "USD", models: [{ id: "glm-5.3", usdPerMTok: { input: 1.5, output: 4.4 }, extra: "x" }, { id: "new-model", usdPerMTok: { input: 1, output: 2 } }] }));
  const d = diffTables(builtinTable(), ok.table);
  assert.deepEqual([d.changed, d.added, d.same], [1, 1, 0]);
  assert.equal("extra" in ok.table.models[0], false);
});

// --- журнал ---------------------------------------------------------------------------

test("кр. 1: повторное событие того же ответа не удваивает сумму (ключ движок + id ответа)", () => {
  const { ledger, rec, rep } = mk();
  const info = ocInfo("msg_1");
  rec.answer(info);
  rec.answer(info);
  const c = rep.chat("ses_o");
  assert.equal(c.turns, 1);
  // 1000 × 1,4 + 250 × 4,4 + 4000 × 0,26 = 1400 + 1100 + 1040
  assert.equal(c.totalMicro, 3540);
  assert.equal(ledger.db.prepare("SELECT COUNT(*) c FROM usage_turns").get().c, 1);
});

test("кр. 3: сумма фиксируется по версии прайса на момент хода; пересчёт периода — явно, одной транзакцией, повтор тот же", () => {
  const { ledger, rec, rep } = mk();
  rec.answer(ocInfo("msg_1"));
  const before = rep.chat("ses_o").totalMicro;
  const models = ledger.table().models.map((m) => (m.id === "glm-5.3" ? { ...m, usdPerMTok: { ...m.usdPerMTok, input: 2.8 } } : m));
  assert.throws(() => ledger.savePrices(models, { ifMatch: 7 }), (e) => e instanceof CostError && e.status === 409);
  const v = ledger.savePrices(models, { ifMatch: 1, by: "admin" });
  assert.equal(v.version, 2);
  assert.throws(() => ledger.savePrices(models, { ifMatch: 1 }), (e) => e.status === 409 && e.extra.version === 2, "вторая вкладка — 409, правка первой цела");
  rec.answer(ocInfo("msg_1")); // повтор события после правки — сумма та же
  assert.equal(rep.chat("ses_o").totalMicro, before, "прошлый ход не изменился");
  rec.answer(ocInfo("msg_2"));
  assert.equal(rep.chat("ses_o").totalMicro, before + 3540 + 1400, "новый ход — по версии 2");
  const dry = ledger.recalc({ from: "2026-11-01", to: "2026-11-30", dryRun: true });
  assert.deepEqual([dry.turns, dry.beforeMicro, dry.afterMicro, dry.applied], [2, before * 2 + 1400, (3540 + 1400) * 2, false]);
  const a = ledger.recalc({ from: "2026-11-01", to: "2026-11-30" });
  const b = ledger.recalc({ from: "2026-11-01", to: "2026-11-30" });
  assert.equal(a.afterMicro, b.afterMicro);
  assert.equal(b.beforeMicro, b.afterMicro, "повторный пересчёт ничего не меняет");
});

test("кр. 4: «нет данных» с причиной, не $0; цена добавлена позже; бесплатно — только по отметке", () => {
  const { ledger, rec, rep } = mk();
  rec.answer(ocInfo("n1", { providerID: "ollama", modelID: "llama3:8b" }));
  rec.answer(claudeInfo("msgc_a_legacy"), { source: "backfill" }); // история до учёта: без токенов
  rec.answer(claudeInfo("msgc_a_stop", { teleharness: { interrupted: "user" } }));
  rec.answer(claudeInfo("msgc_a_err", { turnError: true }));
  rec.answer(claudeInfo("msgc_a_nova", { modelID: "gpt-6.3-nova", providerID: "openai-codex", usageByModel: [{ model: "gpt-6.3-nova", in: 100, out: 10, reason: 0, cacheRead: 0, w5m: 0, w1h: 0, engineCostMicro: null }] }));
  const s = rep.summary({ period: resolvePeriod({ period: "month" }, ledger.tz(), T0), withSubs: true });
  assert.deepEqual(s.noData.byReason, { "no-price": 2, legacy: 1, interrupted: 1 });
  assert.equal(s.noData.count, 4);
  const err = ledger.db.prepare("SELECT cost_micro, status FROM usage_turns WHERE answer_id = 'msgc_a_err'").get();
  assert.deepEqual({ ...err }, { cost_micro: 0, status: "error" }, "ошибка без токенов — $0 и не «нет данных»");
  assert.deepEqual(ledger.noPriceModels().map((m) => m.model).sort(), ["gpt-6.3-nova", "llama3:8b"]);
  // admin отметил ollama «бесплатно» и добавил цену модели
  const models = [...ledger.table().models, { id: "llama3:8b", free: true, usdPerMTok: {} }, { id: "gpt-6.3-nova", usdPerMTok: { input: 1, output: 2 }, source: "https://example.org", checkedAt: "2026-11-20" }];
  const r = ledger.savePrices(models, { ifMatch: 1 });
  assert.equal(r.pricedLate, 2);
  const late = ledger.db.prepare("SELECT cost_micro, priced_late, billing FROM usage_turns WHERE answer_id IN ('n1','msgc_a_nova') ORDER BY answer_id").all().map((x) => ({ ...x }));
  assert.deepEqual(late, [{ cost_micro: 120, priced_late: 1, billing: "subscription" }, { cost_micro: 0, priced_late: 1, billing: "free" }]);
});

test("Claude без цены модели: запасная оценка Claude Code (подпись), но не для неподписочных", () => {
  const { ledger, rec } = mk();
  rec.answer(claudeInfo("msgc_a_x", { modelID: "claude-new-6", usageByModel: [{ model: "claude-new-6", in: 10, out: 10, cacheRead: 0, w5m: 0, w1h: 0, engineCostMicro: 777 }] }));
  const r = ledger.db.prepare("SELECT cost_micro, price_source, no_data_reason FROM usage_turns").get();
  assert.deepEqual({ ...r }, { cost_micro: 777, price_source: "engine", no_data_reason: null });
});

test("P-14: платный API отдельно от «по ценам API для подписок»", () => {
  const { ledger, rec, rep } = mk();
  rec.answer(ocInfo("o_paid", { providerID: "openrouter", modelID: "some/model", cost: 0.08 }));
  rec.answer(ocInfo("o_sub"));
  const s = rep.summary({ period: resolvePeriod({}, ledger.tz(), T0), withSubs: true });
  assert.equal(s.totals.apiPaidMicro, 80000);
  assert.equal(s.totals.subscriptionMicro, 3540);
});

test("кр. 7: попытки шага пайпа — отдельные строки, хотя step_chats хранит последнюю", () => {
  const { ledger, rec, rep } = mk();
  assert.equal(ledger.registerStep({ sid: "ses_s1", runId: "wf-1", stepId: "review", userId: "u_t" }), 1);
  assert.equal(ledger.registerStep({ sid: "ses_s2", runId: "wf-1", stepId: "review", userId: "u_t" }), 2);
  assert.equal(ledger.registerStep({ sid: "ses_s2", runId: "wf-1", stepId: "review" }), 2, "повторная регистрация — та же попытка");
  rec.answer(ocInfo("a1", { sessionID: "ses_s1", teleharness: { interrupted: "timeout" } }));
  rec.answer(ocInfo("a2", { sessionID: "ses_s2" }));
  const r = rep.run("wf-1");
  assert.deepEqual(r.steps.map((s) => [s.stepId, s.attempt, s.status, s.micro]), [["review", 1, "interrupted", 3540], ["review", 2, "ok", 3540]]);
  assert.equal(r.totalMicro, 7080);
  assert.equal(r.retries, 1);
  assert.equal(ledger.db.prepare("SELECT user_id FROM usage_turns WHERE answer_id = 'a1'").get().user_id, "u_t", "владелец — пользователь запуска");
});

test("кр. 14: ход относится к дню окончания в поясе отчётов; смена пояса перестраивает месяц", () => {
  const end = Date.UTC(2026, 10, 30, 21, 10); // 1 дек 00:10 MSK
  assert.deepEqual(dayMonth(end, "Europe/Moscow"), { day: "2026-12-01", month: "2026-12" });
  const { ledger, rec } = mk({ now: () => end });
  rec.answer(ocInfo("b1", { time: { created: end - 20 * 60_000, completed: end } }));
  assert.equal(ledger.db.prepare("SELECT month FROM usage_turns").get().month, "2026-12");
  assert.throws(() => ledger.saveSettings({ tz: "Mars/Olympus" }, { ifMatch: 1 }), (e) => e.status === 422);
  ledger.saveSettings({ tz: "UTC" }, { ifMatch: 1 });
  assert.equal(ledger.db.prepare("SELECT month FROM usage_turns").get().month, "2026-11");
  assert.throws(() => ledger.saveSettings({ tz: "UTC" }, { ifMatch: 1 }), (e) => e.status === 409);
});

test("кр. 10: подписки — USD, проверка «1990 ₽», стоимость периода (месяц целиком / пропорционально), сэкономлено и окупаемость", () => {
  const { ledger, rec, rep } = mk();
  assert.throws(() => ledger.saveSubscriptions([{ title: "Claude Max", providers: ["anthropic"], usdMonth: "1990 ₽", activeFrom: "2026-11-01" }], { ifMatch: 1 }), (e) => e.status === 422 && /долларах США/.test(e.message));
  ledger.saveSubscriptions([{ title: "Claude Max", providers: ["anthropic"], usdMonth: 100, activeFrom: "2026-11-01" }, { title: "z.ai Coding Plan", providers: ["zai-coding-plan"], usdMonth: "30", activeFrom: "2026-11-16" }], { ifMatch: 1 });
  assert.throws(() => ledger.saveSubscriptions([], { ifMatch: 1 }), (e) => e.status === 409);
  assert.deepEqual(subscriptionCost({ usdMonthMicro: 30e6, activeFrom: "2026-11-16" }, "2026-11-01", "2026-11-30"), { micro: 15e6, prorated: true });
  assert.deepEqual(subscriptionCost({ usdMonthMicro: 100e6, activeFrom: "2026-01-01" }, "2026-11-01", "2026-11-30"), { micro: 100e6, prorated: false });
  rec.answer(claudeInfo("msgc_a_big", { usageByModel: [{ model: "claude-opus-5-5", in: 0, out: 25_000_000, cacheRead: 0, w5m: 0, w1h: 0 }] })); // $500
  const s = rep.summary({ period: resolvePeriod({}, ledger.tz(), T0), withSubs: true });
  assert.equal(s.subscriptions.costMicro, 115e6);
  assert.equal(s.subscriptions.savedMicro, 500e6 - 115e6);
  assert.equal(s.subscriptions.payback, 4.3);
  assert.equal(s.subscriptions.items[0].payback, 5);
});

test("кр. 12: бюджет 80/100 % — одно предупреждение на порог за месяц, ходы не блокируются; баннер чата один раз", () => {
  const { ledger, rec } = mk({ owner: { id: "u_t", name: "marina" } });
  ledger.saveBudget("u_t", 100, { ifMatch: 1 });
  const turn = (id, usd) => rec.answer(claudeInfo(id, { usageByModel: [{ model: "claude-opus-5-5", in: 0, out: (usd * 1e6) / 20, cacheRead: 0, w5m: 0, w1h: 0 }] }));
  assert.deepEqual(turn("msgc_a_1", 79).alerts, []);
  assert.deepEqual(turn("msgc_a_2", 3).alerts.map((a) => [a.threshold, a.pct]), [[80, 82]]);
  assert.deepEqual(turn("msgc_a_3", 1).alerts, [], "80 % не повторяется");
  assert.deepEqual(turn("msgc_a_4", 21).alerts.map((a) => a.threshold), [100]);
  assert.ok(turn("msgc_a_5", 1).row, "ход после 100 % записан — не заблокирован");
  assert.equal(ledger.pendingBanner("u_t", "2026-11").threshold, 100);
  ledger.markBannerSeen("u_t", "2026-11");
  assert.equal(ledger.pendingBanner("u_t", "2026-11"), null);
  assert.equal(ledger.pendingBanner("u_t", "2026-12"), null, "новый месяц — с чистого листа");
});

test("кр. 16: журнал недоступен — запись не бросает, ход идёт; ошибка видна", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "teleharness-cost-"));
  try {
    const blocker = path.join(dir, "file");
    writeFileSync(blocker, "x");
    const ledger = new CostLedger({ file: path.join(blocker, "ledger.sqlite"), log: () => {} });
    assert.equal(ledger.db, null);
    assert.ok(ledger.error);
    const rec = new CostRecorder({ ledger, deps: {} });
    assert.equal(rec.answer(ocInfo("x")), null);
    assert.equal(ledger.missed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("кр. 15: учёт истории продолжается после рестарта с отметки, без дублей; живые записи не перетираются", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "teleharness-cost-bf-"));
  try {
    const file = path.join(dir, "l.sqlite");
    const sessions = {};
    for (let i = 0; i < 50; i++) sessions[`ses_${String(i).padStart(2, "0")}`] = { directory: "/w", messages: [{ info: { role: "user", id: `u${i}` } }, { info: claudeInfo(`msgc_a_${i}`, { sessionID: `ses_${i}`, ...(i % 3 ? {} : { tokens: { input: 10, output: 10, cache: { read: 0, write: 0 } } }) }) }] };
    let l1 = new CostLedger({ file, log: () => {} });
    let r1 = new CostRecorder({ ledger: l1, deps: { ownerOf: () => ({ id: "u_adm" }) } });
    r1.answer({ ...claudeInfo("msgc_a_0"), tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } }); // живая запись
    // «рестарт» на середине: учли 2 пачки по 10 сессий
    const bf1 = new CostBackfill({ ledger: l1, recorder: r1, deps: { claudeSessions: () => sessions, batch: 10 } });
    l1.setBackfill("claude", { cursor: 20, total: 50, progress: 20 });
    for (const sid of Object.keys(sessions).sort().slice(0, 20)) for (const m of sessions[sid].messages) if (m.info.role === "assistant") r1.answer(m.info, { source: "backfill" });
    void bf1;
    l1.close();
    const l2 = new CostLedger({ file, log: () => {} });
    const r2 = new CostRecorder({ ledger: l2, deps: { ownerOf: () => ({ id: "u_adm" }) } });
    await new CostBackfill({ ledger: l2, recorder: r2, deps: { claudeSessions: () => sessions, batch: 10 } }).start();
    assert.equal(l2.db.prepare("SELECT COUNT(*) c FROM usage_turns").get().c, 50);
    assert.equal(l2.db.prepare("SELECT COUNT(*) c FROM usage_turns WHERE no_data_reason = 'legacy'").get().c, 33);
    assert.equal(l2.db.prepare("SELECT source FROM usage_turns WHERE answer_id = 'msgc_a_0'").get().source, "live");
    const st = l2.backfillState("claude");
    assert.deepEqual([st.done, st.progress, st.total], [1, 50, 50]);
    l2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N-31: opencode не отвечает — ошибка источника и повтор, Claude учтён", async () => {
  const { ledger, rec } = mk();
  const bf = new CostBackfill({ ledger, recorder: rec, deps: { claudeSessions: () => ({ s: { directory: "/w", messages: [{ info: claudeInfo("msgc_a_q") }] } }), ocSessions: async () => { throw new Error("ECONNREFUSED"); }, ocMessages: async () => [] } });
  await bf.start();
  bf.stop();
  const st = Object.fromEntries(bf.state().map((s) => [s.source, s]));
  assert.equal(st.claude.done, true);
  assert.match(st.opencode.error, /не отвечает/);
  assert.ok(st.opencode.retryAt > 0);
});

// --- округление и CSV ------------------------------------------------------------------

test("кр. 17 / N-21: $0,0004 × 3 000 ходов — итог $1,20 без потерь округления; CSV 0.000400", () => {
  const { ledger, rec, rep } = mk();
  // 40 токенов выхода Haiku 4.5 ($5) = 200 µ$; 2 таких выхода... берём 80 токенов = 400 µ$ = $0,0004
  for (let i = 0; i < 3000; i++) rec.answer(claudeInfo(`msgc_a_${i}`, { usageByModel: [{ model: "claude-haiku-4-5", in: 0, out: 80, cacheRead: 0, w5m: 0, w1h: 0 }] }));
  const s = rep.summary({ period: resolvePeriod({}, ledger.tz(), T0) });
  assert.equal(s.totals.subscriptionMicro, 1_200_000);
  assert.equal(microToUsd(400), "0.000400");
  assert.equal(microToUsd(400, ","), "0,000400");
  assert.equal(microToUsd(null), "", "нет данных — пустая ячейка, не 0");
  const rows = [...rep.iterate({ period: resolvePeriod({}, ledger.tz(), T0), page: 700 })];
  assert.equal(rows.length, 3000, "постраничная выгрузка без пропусков и дублей");
  assert.equal(new Set(rows.map((r) => r.answer_id)).size, 3000);
});

test("CSV: обезвреживание формул, разделитель по языку, BOM, поток с отменой", async () => {
  assert.equal(csvCell("=HYPERLINK(\"x\")", ";"), "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(csvCell("+1", ","), "'+1");
  assert.equal(csvCell("a;b", ";"), '"a;b"');
  const row = { completed_at: T0, user_id: "u", project: "/p", title: "@cmd", sid: "s", kind: "chat", engine: "claude", provider_id: "anthropic", model_id: "m", status: "ok", t_in: 1, t_out: 2, t_reason: 0, t_cache_read: 0, t_cache_w5m: 0, t_cache_w1h: 0, cost_micro: 1234567, price_source: "table", price_version: 3, billing: "subscription" };
  const line = csvRow(row, { delim: ";", tz: "Europe/Moscow" });
  assert.match(line, /^2026-11-20 12:00:00;u;\/p;'@cmd;s;chat;/);
  assert.match(line, /;1,234567;price-v3;\r\n$/);
  const chunks = [];
  const res = { headers: null, writeHead(s, h) { this.headers = h; }, write(c) { chunks.push(c); return true; }, end(c) { if (c) chunks.push(c); }, on() {}, once() {} };
  const out = await streamCsv(res, [row, { ...row, cost_micro: null, no_data_reason: "legacy" }], { lang: "en", tz: "UTC", filename: "teleharness-usage-2026-11.csv" });
  assert.equal(out.rows, 2);
  assert.ok(chunks[0].startsWith("﻿completed_at,user,"));
  assert.match(res.headers["content-disposition"], /teleharness-usage-2026-11\.csv/);
  assert.match(chunks.join(""), /,1\.234567,price-v3,/);
  let closeCb;
  const res2 = { writeHead() {}, write() { return true; }, end() { throw new Error("отменённая выгрузка не дописывается"); }, on(e, cb) { if (e === "close") closeCb = cb; }, once() {} };
  const many = (function* () { for (let i = 0; i < 5000; i++) { if (i === 1500) closeCb(); yield row; } })();
  const r2 = await streamCsv(res2, many, { lang: "ru", tz: "UTC", filename: "x.csv" });
  assert.equal(r2.cancelled, true);
});

test("периоды: этот месяц, прошлый (январь → декабрь), 30 дней, свой; неверный — null", () => {
  const jan = Date.UTC(2027, 0, 10, 12);
  assert.deepEqual(resolvePeriod({ period: "prev" }, "Europe/Moscow", jan), { kind: "prev", from: "2026-12-01", to: "2026-12-31", month: "2026-12" });
  assert.equal(resolvePeriod({ period: "30d" }, "UTC", jan).from, "2026-12-12");
  assert.equal(resolvePeriod({ period: "custom", from: "2026-11-10", to: "2026-11-01" }, "UTC", jan), null);
  assert.equal(resolvePeriod({}, "UTC", T0).month, "2026-11");
});

test("10 000 ходов за месяц: сводка ≤ 1,5 с (кр. 5)", () => {
  const { ledger, rec, rep } = mk();
  ledger.db.exec("BEGIN");
  for (let i = 0; i < 10_000; i++) rec.answer(ocInfo(`m${i}`, { sessionID: `ses_${i % 300}`, modelID: i % 7 ? "glm-5.3" : "glm-5.3-flash", time: { created: T0 - 1000, completed: T0 - (i % 19) * 86_400_000 } }));
  ledger.db.exec("COMMIT");
  const t = performance.now();
  const s = rep.summary({ period: resolvePeriod({}, ledger.tz(), T0), withSubs: true });
  const ms = performance.now() - t;
  assert.equal(s.totals.turns, 10_000);
  assert.ok(ms < 1500, `сводка ${ms.toFixed(0)} мс`);
});

test("opencode v2 (2.2.6): шаг-ответ из session.step.started/ended (без message.updated) → запись; повтор не удваивает", () => {
  const { ledger, rec, rep } = mk();
  const fx = JSON.parse(readFileSync(path.join(path.dirname(FIX), "v2-turn-events.json"), "utf8"));
  const events = (Array.isArray(fx) ? fx : fx.events).filter((e) => /^session\.step\.(started|ended)$/.test(e.type)).map((e) => ({ type: e.type, properties: e.data }));
  assert.ok(events.some((e) => e.type === "session.step.ended"));
  for (const e of events) rec.observe(JSON.stringify(e));
  const ended = events.find((e) => e.type === "session.step.ended");
  rec.observe(JSON.stringify(ended)); // повтор события
  const row = ledger.db.prepare("SELECT * FROM usage_turns").all();
  assert.equal(row.length, 1);
  assert.deepEqual([row[0].engine, row[0].provider_id, row[0].model_id, row[0].t_in, row[0].t_out, row[0].t_cache_read], ["opencode", "zai-coding-plan", "glm-5.3-flash", 15418, 18, 64]);
  assert.ok(rep.chat(ended.properties.sessionID).totalMicro > 0);
});
