// FEAT-11.18 (шаг А): раздел «Подписки» — карточка на провайдера, вид по данным (макет relay.html, кадры 4–5).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ SettingsView: "src/components/views/SettingsView.jsx", subscriptionNote: "src/components/views/SettingsView.jsx#subscriptionNote", fmtMoney: "src/components/views/SettingsView.jsx#fmtMoney" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.subscriptions.value = null;
  ui.store.me.value = null;
  installFetch();
});

const CARDS = [
  { id: "zai", title: "z.ai", badge: "Coding Plan", state: "ok", plan: "max", fetchedAt: Date.UTC(2026, 10, 12, 11, 31), windows: [{ kind: "hours", number: 5, type: "CREDIT_LIMIT", percent: 5, used: 1448, total: 28000, remaining: 26552, resetAt: Date.UTC(2026, 10, 12, 13, 1) }, { kind: "week", number: 1, type: "CREDIT_LIMIT", percent: 85, used: 119000, total: 140000, remaining: 21000, resetAt: null }] },
  { id: "claude", title: "Claude", badge: "подписка", state: "no-api", hint: "claude-subscription" },
  { id: "openrouter", title: "OpenRouter", badge: "ключ API", state: "ok", fetchedAt: 1, money: { currency: "USD", limit: 100, remaining: 74.5, resetInterval: "monthly", spent: { day: 1.2, week: 9.8, month: 25.5, total: 250 } } },
  { id: "deepseek", title: "DeepSeek", badge: "баланс", state: "ok", fetchedAt: 1, available: true, balances: [{ currency: "CNY", total: 110, granted: 10, toppedUp: 100 }] },
  { id: "openai", title: "OpenAI", badge: "API", state: "ok", fetchedAt: 1, spend: { currency: "USD", amount: 18.42, days: 7 } },
  { id: "moonshot", title: "Moonshot (Kimi)", badge: "баланс", state: "error", reason: "401" },
  { id: "alibaba", title: "Alibaba Qwen", badge: "Coding Plan", state: "no-api", hint: "console-only" },
];

test("FEAT-11.18: обычный пользователь видит раздел «Подписки» с карточками всех провайдеров", async () => {
  installFetch([{ method: "GET", path: "/zai/api/subscriptions", reply: () => ({ providers: CARDS }) }, { method: "GET", path: "/zai/api/mcp", reply: () => ({}) }]);
  ui.store.me.value = { id: "u_t", name: "julia", role: "user" };
  location.hash = "#/settings/subscription";
  const { root } = t$.mount(ui.SettingsView, { section: "subscription" });
  await t$.waitFor(() => $$(root, ".sub-card").length === CARDS.length);
  assert.ok(fetchCalls.some((c) => c.path === "/zai/api/subscriptions"));
  assert.equal(fetchCalls.some((c) => c.path === "/zai/api/usage"), false, "admin-маршрут тенант не трогает");
  const text = (id) => $(root, `.sub-card[data-provider="${id}"]`).textContent.replace(/\u00a0/g, " ");
  assert.match(text("zai"), /z\.ai.*Coding Plan · Max/);
  assert.match(text("zai"), /1 448 \/ 28 000/);
  assert.match(text("zai"), /85%/);
  assert.match(text("claude"), /Остаток подписки Claude порталу недоступен/);
  assert.match(text("openrouter"), /\$74,50.*осталось из \$100,00.*сброс раз в месяц/);
  assert.match(text("openrouter"), /сегодня \$1,20 · неделя \$9,80 · месяц \$25,50/);
  assert.match(text("deepseek"), /¥110,00.*из них бонусных ¥10,00/);
  assert.match(text("openai"), /\$18,42.*потрачено за 7 дн\./);
  assert.match(text("openai"), /Остаток баланса этот провайдер по API не отдаёт/);
  assert.match(text("moonshot"), /ключ не принят \(401\)/);
  assert.match(text("alibaba"), /личном кабинете провайдера/);
  assert.equal(/sk-|Bearer|api\.|https?:/.test(root.textContent), false, "ни ключей, ни адресов на экране");
});

test("FEAT-11.18: тексты причин — без кодов и путей; деньги — с валютой", () => {
  assert.match(ui.subscriptionNote({ state: "need-admin-key" }), /ключу администратора организации/);
  assert.match(ui.subscriptionNote({ state: "no-key" }), /нет ключа/);
  assert.match(ui.subscriptionNote({ state: "error", reason: "network" }), /не ответил/);
  assert.match(ui.subscriptionNote({ state: "no-api", hint: "management-key" }), /ключу управления/);
  assert.equal(ui.subscriptionNote({ state: "ok" }), null);
  assert.equal(ui.fmtMoney(74.5, "USD"), "$74,50");
  assert.equal(ui.fmtMoney(null, "USD"), "—");
  assert.match(ui.fmtMoney(5, "RUB"), /5,00.RUB/);
});

test("FEAT-11.18: сбой загрузки без данных — «Повторить»; пустой список — понятная строка", async () => {
  installFetch([{ method: "GET", path: "/zai/api/subscriptions", reply: () => ({ status: 503, body: { error: "x" } }) }, { method: "GET", path: "/zai/api/mcp", reply: () => ({}) }]);
  ui.store.me.value = { id: "u_t", name: "julia", role: "user" };
  location.hash = "#/settings/subscription";
  const h = t$.mount(ui.SettingsView, { section: "subscription" });
  await t$.waitFor(() => /Повторить/.test(h.root.textContent));
  h.unmount();
  installFetch([{ method: "GET", path: "/zai/api/subscriptions", reply: () => ({ providers: [] }) }, { method: "GET", path: "/zai/api/mcp", reply: () => ({}) }]);
  ui.store.subscriptions.value = null;
  const h2 = t$.mount(ui.SettingsView, { section: "subscription" });
  await t$.waitFor(() => /Нет подключённых провайдеров/.test(h2.root.textContent));
});
