// Компонентные тесты BUG-295 (AutoRelayRow + RelayActions с Gemini/ACP) и BUG-296 (CostsSection Подписки ACP).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    AutoRelayRow: "src/components/views/AutoRelayRow.jsx",
    RelayActions: "src/components/chat/Relay.jsx#RelayActions",
    CostsSection: "src/components/views/CostsSection.jsx",
  });
  t$ = createHarness(ui);
});

afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  ui.store.active.value = null;
  ui.store.providerCfg.value = null;
  ui.store.me.value = null;
  installFetch();
});

const PROVIDERS = {
  all: [
    { id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" } } },
    { id: "acp-antigravity", models: { "gemini-4-neon-medium": { id: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" } } },
  ],
  connected: ["zai-coding-plan", "acp-antigravity"],
  default: { "acp-antigravity": "gemini-4-neon-medium" },
};

test("BUG-295: AutoRelayRow показывает Gemini (а не сырое ACP) и сохраняет модель acp-antigravity", async () => {
  const puts = [];
  const state = { on: true, order: [] };
  installFetch([
    { method: "GET", path: "/teleharness/api/me/auto-relay", reply: () => ({ ...state, max: 3 }) },
    {
      method: "PUT",
      path: "/teleharness/api/me/auto-relay",
      reply: (c) => {
        puts.push(c.body);
        Object.assign(state, c.body);
        return { ...state, max: 3 };
      },
    },
    { method: "GET", path: "/teleharness/api/provider", reply: () => PROVIDERS },
  ]);
  await ui.store.refreshProvider();
  const h = t$.mount(ui.AutoRelayRow);
  await t$.waitFor(() => $(h.root, ".autorelay-add"));
  t$.click($(h.root, ".autorelay-add"));
  const row = await t$.waitFor(() =>
    [...(document.querySelector('.sheet[aria-label="Запасная модель"]')?.querySelectorAll(".picker-row") ?? [])].find((r) =>
      r.textContent.includes("Gemini 4 Neon (Medium)"),
    ),
  );
  t$.click(row);
  await t$.waitFor(() => document.querySelector(".sheet") == null && $(h.root, ".autorelay-item"));

  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].order, [{ providerID: "acp-antigravity", modelID: "gemini-4-neon-medium" }]);
  const itemText = $(h.root, ".autorelay-item .autorelay-name").textContent;
  assert.match(itemText, /Gemini 4 Neon \(Medium\) · Gemini/);
  assert.ok($(h.root, ".autorelay-item .engine-dot.is-acp"));
});

test("BUG-295: RelayActions для цели acp-antigravity подписывает «· Gemini», а не «· acp»", async () => {
  installFetch([{ method: "GET", path: "/teleharness/api/provider", reply: () => PROVIDERS }]);
  await ui.store.refreshProvider();
  ui.store.sessions.value = [{ id: "ses_r1", teleharness: { engine: "opencode", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, prompted: true } }];
  const h = t$.mount(ui.RelayActions, { sessionId: "ses_r1", onPickOther: () => {} });
  const btn = $(h.root, ".relay-primary");
  assert.ok(btn);
  assert.match(btn.textContent, /Продолжить в Gemini 4 Neon \(Medium\) · Gemini/);
});

test("BUG-296: CostsSection → Подписки предлагает провайдеров ACP (Google Antigravity и GitHub Copilot CLI)", async () => {
  installFetch([
    {
      method: "GET",
      path: "/teleharness/api/costs/summary",
      reply: () => ({
        period: { kind: "month", from: "2026-11-01", to: "2026-11-30", month: "2026-11" },
        tz: "Europe/Moscow",
        priceVersion: { version: 1, createdAt: Date.UTC(2026, 10, 20), createdBy: "admin" },
        admin: true,
        totals: { turns: 1, subscriptionMicro: 0, apiPaidMicro: 0, subscriptionTurns: 1, apiTurns: 0, freeTurns: 0, engineEstimateTurns: 0, pricedLateTurns: 0, longCtxTurns: 0, partialTurns: 0 },
        noData: { count: 0, byReason: {} },
        subscriptions: { configured: false, costMicro: 0, prorated: false, savedMicro: 0, payback: null, items: [] },
        byEngine: [{ engine: "acp", title: "ACP", micro: 0, turns: 1, noData: 1 }],
        byModel: [],
        byProject: [],
        topChats: [],
        runs: [],
        byDay: [],
        budget: null,
      }),
    },
    { method: "GET", path: "/teleharness/api/costs/subscriptions", reply: () => ({ version: 1, items: [] }) },
  ]);
  ui.store.me.value = { id: "admin", role: "admin" };
  const h = t$.mount(ui.CostsSection, {});
  await t$.waitFor(() => byText(h.root, ".cost-tabs .seg-btn", "Подписки"));
  t$.click(byText(h.root, ".cost-tabs .seg-btn", "Подписки"));
  await t$.waitFor(() => byText(h.root, "button", "Новая подписка"));
  t$.click(byText(h.root, "button", "Новая подписка"));
  await t$.waitFor(() => document.querySelector(".cost-form select"));
  const options = [...document.querySelectorAll(".cost-form select option")].map((o) => o.value);
  assert.ok(options.includes("acp-antigravity"), "в списке провайдеров подписок должен быть acp-antigravity: " + options.join(", "));
  assert.ok(options.includes("acp-github-copilot-cli"), "в списке провайдеров подписок должен быть acp-github-copilot-cli");
});
