// FEAT-18.5: расчёт заполнения контекста и стоимости (src/lib/context-cost.js)
// и подпись расхода в строке хода (normalize.buildTurns / turnMetaLine).
// Run: node --test --test-concurrency=1 tests/context-cost.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_WARN,
  chatContext,
  chatCost,
  contextText,
  contextUsedOf,
  contextWindowOf,
  costLabel,
  fmtUsd,
  isSubscription,
} from "../src/lib/context-cost.js";
import { buildTurns, turnMetaLine } from "../src/lib/normalize.js";

const CFG = {
  models: [
    { id: "glm-5.3", providerID: "zai-coding-plan", contextLimit: 200000 },
    { id: "qwen3.8-27b", providerID: "kosmik", contextLimit: 262144 },
    { id: "no-limit", providerID: "kosmik" },
    { id: "claude-sonnet-4-6", providerID: "anthropic", contextLimit: 200000 },
  ],
};
const user = (id) => ({ info: { id, role: "user", time: { created: 1 } }, parts: [] });
const oc = (id, providerID, modelID, tokens, cost = 0) => ({
  info: { id, role: "assistant", providerID, modelID, tokens, cost, time: { created: 2, completed: 3 } },
  parts: [],
});

test("opencode: занятость = input + cache.read + cache.write ПОСЛЕДНЕГО шага; окно — limit.context каталога", () => {
  const msgs = [
    user("u1"),
    oc("a1", "zai-coding-plan", "glm-5.3", { input: 30082, output: 291, reasoning: 264, cache: { read: 1856, write: 0 } }),
    oc("a2", "zai-coding-plan", "glm-5.3", { input: 2000, output: 70, reasoning: 23, cache: { read: 166000, write: 2000 } }),
  ];
  const ctx = chatContext(msgs, CFG);
  assert.deepEqual(ctx, { used: 170000, window: 200000, pct: 85, warn: true });
  assert.equal(contextText(ctx), "Контекст 85\u00a0% · почти заполнен");
});

test("порог: ровно 80 % — без предупреждения, больше — с ним", () => {
  assert.equal(CONTEXT_WARN, 0.8);
  const at = (used) => chatContext([oc("a", "zai-coding-plan", "glm-5.3", { input: used })], CFG);
  assert.equal(at(160000).warn, false);
  assert.equal(at(160000).pct, 80);
  assert.equal(contextText(at(160000)), "Контекст 80\u00a0%");
  assert.equal(at(160001).warn, true);
  assert.equal(at(84000).pct, 42);
});

test("Claude: tokens.context (последний вызов) важнее суммы хода; окно от CLI важнее каталога", () => {
  const info = { role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-6", tokens: { input: 17, output: 388, cache: { read: 45725, write: 9220 }, context: 27965 }, contextWindow: 1000000 };
  assert.equal(contextUsedOf(info), 27965);
  assert.equal(contextWindowOf(info, CFG), 1000000);
  assert.equal(contextWindowOf({ ...info, contextWindow: undefined }, CFG), 200000, "без contextWindow — каталог Claude");
  const ctx = chatContext([{ info }], CFG);
  assert.equal(ctx.pct, 3);
  assert.equal(ctx.warn, false);
});

test("окно неизвестно — процента нет, только токены; ответов с токенами нет — null", () => {
  const ctx = chatContext([oc("a", "kosmik", "no-limit", { input: 170000 })], CFG);
  assert.deepEqual(ctx, { used: 170000, window: null, pct: null, warn: false });
  assert.equal(contextText(ctx), "Контекст 170k ток");
  assert.equal(chatContext([oc("a", "unknown-prov", "x", { input: 5 })], null).pct, null, "без каталога");
  assert.equal(chatContext([user("u"), oc("a", "kosmik", "qwen3.8-27b", undefined)], CFG), null);
  assert.equal(chatContext([], CFG), null);
  // идущий ход (токенов ещё нет) — берётся прошлый ответ
  const msgs = [oc("a1", "kosmik", "qwen3.8-27b", { input: 1000, cache: { read: 0, write: 0 } }), user("u2"), oc("a2", "kosmik", "qwen3.8-27b", { input: 0, output: 0 })];
  assert.equal(chatContext(msgs, CFG).used, 1000);
});

test("стоимость хода: подписка без денег, cost > 0 — доллары 2–4 знака, cost 0 — «цена неизвестна»", () => {
  assert.equal(isSubscription("anthropic"), true);
  assert.equal(isSubscription("zai-coding-plan"), true);
  assert.equal(isSubscription("kosmik"), false);
  assert.deepEqual(costLabel({ providerID: "anthropic", cost: 0.0558 }), { kind: "subscription", text: "подписка" }, "условная цена API Claude не показывается");
  assert.deepEqual(costLabel({ providerID: "zai-coding-plan", cost: 0 }), { kind: "subscription", text: "подписка" });
  assert.deepEqual(costLabel({ providerID: "zai", cost: 0.00218256 }), { kind: "money", text: "$0,0022" });
  assert.deepEqual(costLabel({ providerID: "kosmik", cost: 0 }), { kind: "unknown", text: "цена неизвестна" });
  assert.equal(fmtUsd(1.234), "$1,23");
  assert.equal(fmtUsd(0.1234), "$0,123");
  assert.equal(fmtUsd(0.01234), "$0,0123");
  assert.equal(fmtUsd(0.00001), "<$0,0001");
  assert.equal(fmtUsd(0), "");
});

test("итог чата: сумма cost платных ответов; только подписка — «подписка»; только cost 0 — «цена неизвестна»", () => {
  const paid = [oc("a1", "zai", "glm-5.3", { input: 10 }, 0.01), oc("a2", "zai", "glm-5.3", { input: 10 }, 0.0234)];
  assert.deepEqual(chatCost(paid), { kind: "money", text: "$0,0334", cost: 0.0334, partial: false });
  const mixed = [...paid, oc("a3", "kosmik", "no-limit", { input: 10 }, 0)];
  assert.equal(chatCost(mixed).partial, true, "часть ответов без цены");
  assert.equal(chatCost([oc("c", "anthropic", "claude-sonnet-4-6", { input: 1, context: 5 }, 0.05)]).kind, "subscription");
  assert.equal(chatCost([oc("k", "kosmik", "no-limit", { input: 10 }, 0)]).text, "цена неизвестна");
  assert.equal(chatCost([user("u")]), null);
  assert.equal(chatCost([oc("k", "kosmik", "no-limit", undefined, 0)]), null, "без токенов — нечего считать");
});

test("строка хода: подпись расхода идёт за токенами; без токенов не ставится", () => {
  const msgs = [
    user("u1"),
    oc("a1", "zai", "glm-5.3", { input: 1000, output: 200, cache: { read: 0, write: 0 } }, 0.004),
    oc("a2", "zai", "glm-5.3", { input: 500, output: 100, cache: { read: 0, write: 0 } }, 0.006),
  ];
  const turn = buildTurns(msgs).get("a2");
  assert.ok(Math.abs(turn.cost - 0.01) < 1e-12);
  assert.equal(turn.providerID, "zai");
  assert.match(turnMetaLine(turn, { cost: costLabel(turn).text }), /^↑1,5k ↓300 · \$0,01 · \d\d:\d\d/);
  const claude = buildTurns([user("u"), oc("c", "anthropic", "claude-sonnet-4-6", { input: 17, output: 388, context: 27965 }, 0.05)]).get("c");
  assert.match(turnMetaLine(claude, { cost: costLabel(claude).text }), /^↑17 ↓388 · подписка · /);
  const bare = buildTurns([user("u"), oc("x", "kosmik", "q", undefined)]).get("x");
  assert.doesNotMatch(turnMetaLine(bare, { cost: costLabel(bare).text }), /цена/, "без токенов подписи расхода нет");
  assert.match(turnMetaLine(turn), /^↑1,5k ↓300 · \d\d:\d\d/, "без cost — как раньше");
});

test("FEAT-18.7: Codex — подписка ChatGPT: ход помечен «подписка», без денег и без «цена неизвестна»", () => {
  assert.equal(isSubscription("openai-codex"), true);
  assert.deepEqual(costLabel({ providerID: "openai-codex", cost: undefined }), { kind: "subscription", text: "подписка" });
});
