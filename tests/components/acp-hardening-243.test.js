// BUG-279, BUG-280, BUG-281, BUG-282 — фронтенд-тесты релиза 2.4.3
import test from "node:test";
import assert from "node:assert/strict";
import { $, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch, fetchCalls } from "./helpers/dom.mjs";
import { permModeChoices, defaultBinding, bindingLine } from "../../src/lib/engine.js";
import { engineLabel } from "../../src/lib/attention.js";
import { isSubscription } from "../../src/lib/context-cost.js";
import { agentRun } from "../../src/lib/subagents.js";

test("BUG-279: AntigravityLogin не рендерит форму платного Gemini API-ключа", async (t) => {
  const ui = await loadUI({ AntigravityLogin: "src/components/views/AntigravityLogin.jsx" });
  const h = createHarness(ui);
  t.after(() => h.cleanup());
  installFetch([{ method: "GET", path: "/teleharness/api/acp/antigravity/login", reply: () => ({ status: "idle" }) }]);
  const { root } = h.mount(ui.AntigravityLogin);
  await h.waitFor(() => root.textContent.includes("Нужен вход"));
  assert.equal(root.textContent.includes("API-ключ"), false, "формы API-ключа быть не должно");
  assert.equal($(root, "input[type=password]"), null);
});

test("BUG-280/282: ModelBar для Copilot (acp) скрывает OpenCode-пилюлю, ставит is-acp и исключает edits", async (t) => {
  const ui = await loadUI({ ModelBar: "src/components/chat/ModelBar.jsx" });
  const h = createHarness(ui);
  t.after(() => h.cleanup());
  const model = { providerID: "acp-github-copilot-cli", modelID: "acp-github-copilot-cli" };
  ui.store.me.value = { id: "admin", role: "admin" };
  ui.store.providerCfg.value = {
    connected: ["acp-github-copilot-cli"],
    models: [{ id: "acp-github-copilot-cli", providerID: "acp-github-copilot-cli", label: "GitHub Copilot CLI" }],
  };
  ui.store.sessions.value = [{ id: "s1", teleharness: { model, agent: null, prompted: false } }];
  const { root } = h.mount(ui.ModelBar, { sessionId: "s1", hasMessages: false });
  assert.ok($(root, ".engine-dot.is-acp"), "у ACP должна быть точка .is-acp");
  assert.equal(root.textContent.includes("агент opencode"), false, "не должно быть пилюли opencode");
  assert.deepEqual(permModeChoices({ admin: true, engine: "acp" }).map((m) => m.id), ["ask", "full"]);
  assert.equal(defaultBinding({ model, agent: "Sisyphus" }).agent, null);
  assert.match(bindingLine({ engine: "acp", model, agent: null }, ui.store.providerCfg.value), /Copilot/);
});

test("BUG-280: session.js не держит сообщения ACP в клиентской очереди OpenCode и не шлёт OpenCode agent", async (t) => {
  const ui = await loadUI({ ModelBar: "src/components/chat/ModelBar.jsx" });
  const h = createHarness(ui);
  t.after(() => h.cleanup());
  installFetch([
    { method: "POST", path: /\/prompt$/, reply: () => ({}) },
  ]);
  const model = { providerID: "acp-github-copilot-cli", modelID: "acp-github-copilot-cli" };
  ui.store.me.value = { id: "admin", role: "admin" };
  ui.store.sessions.value = [{ id: "s-acp", directory: "/tmp", stableTurnIds: true, teleharness: { model, agent: null, prompted: true } }];
  ui.store.active.value = { id: "s-acp", status: "busy", messages: [{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "question", state: { status: "running" } }] }] };
  await ui.store.send({ text: "follow-up" });
  const post = fetchCalls.find((c) => c.method === "POST" && /\/prompt$/.test(c.path));
  assert.ok(post, "сообщение ACP должно уйти сразу, без OpenCode hold");
  assert.equal("agent" in post.body, false, "OpenCode agent не должен уходить в ACP-ход");
});

test("BUG-280: ChatCost, attention, subagents, context-cost корректно обрабатывают engine=acp", async (t) => {
  const ui = await loadUI({ ChatCostSheet: "src/components/chat/ChatCost.jsx#ChatCostSheet" });
  const h = createHarness(ui);
  t.after(() => h.cleanup());
  assert.equal(engineLabel("acp"), "ACP");
  assert.equal(isSubscription("acp-antigravity"), true);
  assert.equal(isSubscription("acp-github-copilot-cli"), true);
  const run = agentRun({ type: "tool", tool: "Agent", callID: "c1", state: { status: "completed", metadata: { teleharnessRun: { status: "completed", steps: [{ tool: "read", status: "done" }] } } } }, { engine: "acp" });
  assert.equal(run.steps.length, 1);
  installFetch([
    {
      method: "GET",
      path: /\/teleharness\/api\/costs\/chat\//,
      reply: () => ({
        totalMicro: 0, byModel: [], subagents: { count: 0, micro: 0 }, service: { count: 0, micro: 0 },
        tokens: { in: 0, out: 0, reason: 0, cacheRead: 0, w5m: 0, w1h: 0 }, cacheSavingPct: 0,
        noData: { count: 1, byReason: { interrupted: 1 }, last: { engine: "acp", at: Date.now() } },
      }),
    },
  ]);
  h.mount(ui.ChatCostSheet, { sid: "s-acp", onClose: () => {} });
  await h.waitFor(() => document.body.textContent.includes("Нет данных"));
  assert.equal(document.body.textContent.includes("до отчёта Claude"), false, "прерванный ACP не должен подписываться Claude");
  assert.ok(document.body.textContent.includes("до отчёта ACP"));
});
