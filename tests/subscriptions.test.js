// FEAT-11.18 (шаг А): расход подписок по провайдерам. Нормализаторы проверяются на примерах
// ответов из ОФИЦИАЛЬНОЙ документации (docs/research/2026-11-12-subscription-usage-apis.md);
// вживую проверяем только z.ai — ключей остальных провайдеров на портале нет.
// Run: node --test tests/subscriptions.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAnthropicCosts,
  normalizeDeepSeek,
  normalizeMoonshot,
  normalizeOpenAICosts,
  normalizeOpenRouter,
  normalizeSiliconFlow,
  subscriptionCards,
} from "../lib/subscriptions.js";

test("OpenRouter: лимит ключа, остаток, период сброса, расход по периодам (GET /api/v1/key)", () => {
  const card = normalizeOpenRouter({ data: { label: "k", limit: 100, limit_remaining: 74.5, limit_reset: "monthly", usage: 250.25, usage_daily: 1.2, usage_weekly: 9.8, usage_monthly: 25.5, is_free_tier: false } });
  assert.deepEqual(card.money, { currency: "USD", limit: 100, remaining: 74.5, resetInterval: "monthly", spent: { day: 1.2, week: 9.8, month: 25.5, total: 250.25 } });
  assert.equal(card.state, "ok");
  // ключ без лимита: limit и limit_remaining = null
  const free = normalizeOpenRouter({ data: { limit: null, limit_remaining: null, limit_reset: null, usage: 3, usage_daily: 0, usage_weekly: 1, usage_monthly: 3, is_free_tier: true } });
  assert.equal(free.money.limit, null);
  assert.equal(free.money.remaining, null);
  assert.equal(free.freeTier, true);
  assert.equal(normalizeOpenRouter({}), null, "чужая форма ответа — не карточка");
});

test("DeepSeek: баланс по валютам, числа приходят строками (GET /user/balance)", () => {
  const card = normalizeDeepSeek({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }] });
  assert.deepEqual(card.balances, [{ currency: "CNY", total: 110, granted: 10, toppedUp: 100 }]);
  assert.equal(card.available, true);
  assert.equal(normalizeDeepSeek({ is_available: false, balance_infos: [] }).available, false);
  assert.equal(normalizeDeepSeek({ error: "x" }), null);
});

test("Moonshot / Kimi: доступный, бонусный и денежный баланс в USD (GET /v1/users/me/balance)", () => {
  const card = normalizeMoonshot({ code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }, scode: "0x0", status: true });
  assert.deepEqual(card.balances, [{ currency: "USD", total: 49.58894, granted: 46.58893, toppedUp: 3.00001 }]);
  assert.equal(card.available, true);
  assert.equal(normalizeMoonshot({ code: 0, data: { available_balance: 0, voucher_balance: 0, cash_balance: -2 } }).available, false, "нулевой доступный баланс — вызовы не пройдут");
  assert.equal(normalizeMoonshot({ code: 5, data: {} }), null);
});

test("SiliconFlow: общий, пополненный и бонусный баланс (GET /v1/user/info)", () => {
  const card = normalizeSiliconFlow({ code: 20000, message: "OK", status: true, data: { balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88", status: "normal" } });
  assert.deepEqual(card.balances, [{ currency: "USD", total: 88.88, granted: 0.88, toppedUp: 88 }]);
  assert.equal(normalizeSiliconFlow({ code: 50000, status: false }), null);
});

test("OpenAI: только траты за период, остатка нет (GET /v1/organization/costs)", () => {
  const raw = { object: "page", data: [
    { object: "bucket", start_time: 1, end_time: 2, results: [{ amount: { value: 10.5, currency: "usd" }, line_item: null }, { amount: { value: 0.25, currency: "usd" } }] },
    { object: "bucket", start_time: 2, end_time: 3, results: [] },
    { object: "bucket", start_time: 3, end_time: 4, results: [{ amount: { value: 7.67, currency: "usd" } }] },
  ], has_more: false };
  const card = normalizeOpenAICosts(raw, 7);
  assert.equal(card.spend.currency, "USD");
  assert.equal(card.spend.days, 7);
  assert.ok(Math.abs(card.spend.amount - 18.42) < 1e-9);
  assert.equal(normalizeOpenAICosts({ error: {} }, 7), null);
});

test("Anthropic API: траты в центах строкой → доллары (GET /v1/organizations/cost_report)", () => {
  const raw = { data: [{ starting_at: "2025-08-01T00:00:00Z", ending_at: "2025-08-02T00:00:00Z", results: [{ amount: "123.78912", currency: "USD" }, { amount: "76.21088", currency: "USD" }] }], has_more: false };
  const card = normalizeAnthropicCosts(raw, 7);
  assert.ok(Math.abs(card.spend.amount - 2) < 1e-9, "200 центов = $2");
  assert.equal(card.spend.currency, "USD");
});

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

test("subscriptionCards: карточка на каждого подключённого провайдера; сбой одного не роняет остальные", async () => {
  const asked = [];
  const fetchImpl = async (url, opts) => {
    asked.push([String(url), opts?.headers?.authorization ?? opts?.headers?.Authorization ?? ""]);
    if (String(url).includes("openrouter.ai")) return okJson({ data: { limit: 100, limit_remaining: 74.5, limit_reset: "monthly", usage: 25.5, usage_daily: 1, usage_weekly: 2, usage_monthly: 25.5 } });
    if (String(url).includes("deepseek.com")) return { ok: false, status: 401, json: async () => ({}) };
    throw new Error("сеть");
  };
  const cards = await subscriptionCards({
    connected: ["zai-coding-plan", "anthropic", "openrouter", "deepseek", "moonshotai", "openai", "github-copilot", "alibaba", "какой-то-новый"],
    keys: { openrouter: "sk-or-1", deepseek: "sk-ds-1", moonshotai: "sk-ms-1", openai: "sk-plain" },
    env: {},
    zai: async () => ({ ok: true, plan: "max", fetchedAt: 5, windows: [{ kind: "hours", number: 5, percent: 5 }] }),
    fetchImpl,
    now: () => 1000,
    cache: new Map(),
  });
  const by = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.deepEqual(cards.map((c) => c.id), ["zai", "claude", "openrouter", "deepseek", "moonshot", "openai", "github-copilot", "alibaba", "какой-то-новый"]);
  assert.equal(by.zai.state, "ok");
  assert.equal(by.zai.plan, "max");
  assert.equal(by.zai.windows.length, 1);
  assert.equal(by.claude.state, "no-api", "неофициальный адрес подписки Claude не вызывается (решение владельца)");
  assert.equal(by.openrouter.state, "ok");
  assert.equal(by.openrouter.money.remaining, 74.5);
  assert.equal(by.deepseek.state, "error");
  assert.equal(by.deepseek.reason, "401");
  assert.equal(by.moonshot.state, "error");
  assert.equal(by.moonshot.reason, "network");
  assert.equal(by.openai.state, "need-admin-key", "обычный ключ трат не отдаёт — нужен ключ администратора");
  assert.equal(by["github-copilot"].state, "no-api");
  assert.equal(by.alibaba.state, "no-api");
  assert.equal(by["какой-то-новый"].state, "no-api", "неизвестный провайдер — честная карточка «расход недоступен»");
  // секреты не попадают в карточки
  assert.ok(!JSON.stringify(cards).includes("sk-"), "ключей в ответе нет");
  // официальные адреса и авторизация
  const or = asked.find(([u]) => u.includes("openrouter"));
  assert.equal(or[0], "https://openrouter.ai/api/v1/key");
  assert.equal(or[1], "Bearer sk-or-1");
  assert.ok(asked.some(([u]) => u === "https://api.deepseek.com/user/balance"));
  assert.ok(asked.some(([u]) => u === "https://api.moonshot.ai/v1/users/me/balance"));
  assert.ok(!asked.some(([u]) => /anthropic\.com\/api\/oauth|chatgpt\.com|copilot_internal/.test(u)), "неофициальные адреса не вызываются");
});

test("subscriptionCards: ключ администратора из окружения включает траты OpenAI и Anthropic API; кэш 60 с", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (String(url).includes("api.openai.com/v1/organization/costs")) return okJson({ data: [{ results: [{ amount: { value: 3, currency: "usd" } }] }] });
    if (String(url).includes("api.anthropic.com/v1/organizations/cost_report")) return okJson({ data: [{ results: [{ amount: "250", currency: "USD" }] }] });
    throw new Error("неожиданный адрес " + url);
  };
  const cache = new Map();
  let t = 1000;
  const args = { connected: ["openai", "anthropic"], keys: {}, env: { ZAI_OPENAI_ADMIN_KEY: "sk-admin-1", ZAI_ANTHROPIC_ADMIN_KEY: "sk-ant-admin-1" }, zai: async () => null, fetchImpl, now: () => t, cache };
  const cards = await subscriptionCards(args);
  const by = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(by.openai.spend.amount, 3);
  assert.equal(by["anthropic-api"].spend.amount, 2.5);
  assert.equal(by.claude.state, "no-api", "подписка Claude — отдельная карточка");
  const before = calls;
  await subscriptionCards(args);
  assert.equal(calls, before, "повтор в пределах 60 с — из кэша");
  t += 61_000;
  await subscriptionCards(args);
  assert.ok(calls > before, "после 60 с — свежий запрос");
});

test("subscriptionCards: у подключённого провайдера нет ключа — «no-key», запрос не уходит", async () => {
  let calls = 0;
  const cards = await subscriptionCards({ connected: ["openrouter"], keys: {}, env: {}, zai: async () => null, fetchImpl: async () => { calls++; return okJson({}); }, now: () => 1, cache: new Map() });
  assert.equal(cards[0].state, "no-key");
  assert.equal(calls, 0);
});
