// FEAT-13.17 (L2): агенты Claude-чатов в Настройках и в шапке чата —
// «Агент для новых чатов · Claude: Без агента» по умолчанию, выбор Workflow
// в шите, тенант строки не видит; шапка «Claude Opus 5.5 · Workflow».
// Макеты: model-binding.html кадры 12–13, pickers.html кадр 11.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    SettingsView: "src/components/views/SettingsView.jsx",
    ChatView: "src/components/views/ChatView.jsx",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.me.value = null;
  s.sessions.value = [];
  s.active.value = null;
  s.claudeAgents.value = null;
  s.claudeAgentsError.value = false;
  s.providerCfg.value = null;
  s.setPrefs({ claudeAgent: null });
  s.setActiveId(null);
  installFetch();
});

const AGENTS = { agents: [{ id: "workflow", name: "Workflow", description: "Задача по полному флоу разработки — трекер, openspec, макеты, код с тестами, стенд, прод, отчёт" }] };
const ADMIN = { id: "admin", name: "Админ", role: "admin" };
const claudeRow = (root) => [...root.querySelectorAll(".set-row")].find((r) => /Агент для новых чатов\s*· Claude/.test(r.querySelector(".row-title")?.textContent ?? ""));

test("Настройки (admin): «Агент для новых чатов · Claude» — «Без агента» по умолчанию, отдельно от агента z.ai", async () => {
  installFetch([{ method: "GET", path: "/zai/api/claude/agents", reply: () => AGENTS }]);
  ui.store.me.value = ADMIN;
  // FEAT-03.23: the rows live in the «Модель и агенты» section
  const { root } = t$.mount(ui.SettingsView, { section: "models" });
  await t$.flush(3);
  const row = claudeRow(root);
  assert.ok(row, "строка Claude есть");
  assert.equal(row.querySelector(".set-value").textContent, "Без агента");
  assert.equal(row.querySelector(".set-hint").textContent, "Новые Claude-чаты начинаются без агента. Агента можно выбрать в самом чате.");
  const zai = [...root.querySelectorAll(".set-row")].find((r) => /· z\.ai/.test(r.querySelector(".row-title")?.textContent ?? ""));
  assert.equal(zai.querySelector(".set-hint").textContent, "Для Claude-чатов — строка ниже.");
  assert.equal(ui.store.prefs.value.claudeAgent, null);
});

test("Настройки: «Модель и агенты › Агент Claude» — выбор Workflow сохраняется в prefs, раздел показывает имя", async () => {
  installFetch([{ method: "GET", path: "/zai/api/claude/agents", reply: () => AGENTS }]);
  ui.store.me.value = ADMIN;
  const models = t$.mount(ui.SettingsView, { section: "models" });
  await t$.flush(3);
  assert.equal(claudeRow(models.root).getAttribute("href"), "#/settings/models/claude-agent", "строка ведёт на вложенный экран (П32.У1)");
  models.unmount();
  const h = t$.mount(ui.SettingsView, { section: "models", sub: "claude-agent" });
  await t$.waitFor(() => h.root.querySelectorAll("button.picker-row").length === 2);
  assert.equal($(h.root, ".settings-section-title-h").textContent, "Агент Claude");
  const rows = [...h.root.querySelectorAll("button.picker-row")];
  assert.equal(rows[0].getAttribute("aria-pressed"), "true", "«Без агента» выбрана по умолчанию");
  t$.click(rows.find((r) => r.textContent.includes("Workflow")));
  assert.equal(ui.store.prefs.value.claudeAgent, "workflow");
  assert.equal(location.hash, "#/settings/models", "после выбора — назад к «Модель и агенты»");
  h.rerender({ section: "models", sub: null });
  await t$.waitFor(() => claudeRow(h.root).querySelector(".set-value").textContent === "Workflow");
});

test("Настройки (участник): строки агента Claude нет, каталог Claude-агентов не запрашивается", async () => {
  ui.store.me.value = { id: "u_t", name: "Тенант", role: "user" };
  const { root } = t$.mount(ui.SettingsView, { section: "models" });
  await t$.flush(3);
  assert.equal(claudeRow(root), undefined);
  assert.equal(fetchCalls.some((c) => c.path === "/zai/api/claude/agents"), false);
});

test("шапка Claude-чата: «Claude Opus 5.5 · Workflow» с агентом, «… · Claude Code» без него", async () => {
  const SID = "ses_ca";
  const NOW = Date.now();
  let agent = "workflow";
  const record = () => ({ id: SID, title: "Агенты", directory: "C:\\Home", time: { created: NOW, updated: NOW }, zai: { model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent, prompted: true } });
  // openSession refreshes the list — the fake server answers the same record.
  installFetch([
    { method: "GET", path: `/zai/api/session/${SID}/message`, reply: () => [] },
    { method: "GET", path: "/zai/api/session", reply: () => [record()] },
  ]);
  ui.store.claudeAgents.value = AGENTS.agents;
  ui.store.providerCfg.value = { models: [{ id: "claude-opus-5-5", providerID: "anthropic", label: "Claude Opus 5.5 (anthropic)" }] };
  ui.store.sessions.value = [record()];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  const sub = await t$.waitFor(() => $(root, ".chat-sub"));
  assert.equal(sub.textContent, "Claude Opus 5.5 · Workflow");
  assert.equal($$(root, ".model-bar .model-pill").map((p) => p.textContent.trim())[1], "Workflow");
  await t$.flush(10); // the list refresh of openSession lands first
  agent = null;
  ui.store.sessions.value = [record()];
  await t$.waitFor(() => $(root, ".chat-sub").textContent === "Claude Opus 5.5 · Claude Code");
  assert.ok(byText(root, ".model-bar .model-pill", "Без агента"));
});

test("агент пропал из каталога: событие zai.notice показывает notice только в открытом чате, сброс привязки — через session.updated", () => {
  const SID = "ses_gone";
  ui.store.notice.value = null;
  ui.store.sessions.value = [{ id: SID, title: "x", directory: "C:\Home", time: { created: 1, updated: 1 }, zai: { model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent: "workflow", prompted: true } }];
  ui.store.active.value = { id: "other", messages: [], status: "idle" };
  ui.store.handleEvent({ type: "zai.notice", properties: { sessionID: SID, text: "Агент «Workflow» больше недоступен — ответ без агента." } });
  assert.equal(ui.store.notice.value, null, "чужой чат — без notice");
  ui.store.active.value = { id: SID, messages: [], status: "idle" };
  ui.store.handleEvent({ type: "zai.notice", properties: { sessionID: SID, text: "Агент «Workflow» больше недоступен — ответ без агента." } });
  assert.equal(ui.store.notice.value, "Агент «Workflow» больше недоступен — ответ без агента.");
  ui.store.handleEvent({ type: "session.updated", properties: { sessionID: SID, info: { id: SID, zai: { engine: "claude", model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent: null, prompted: true } } } });
  assert.equal(ui.store.sessions.value[0].zai.agent, null);
  assert.equal(ui.store.sessions.value[0].title, "x", "частичная запись не теряет полей");
  ui.store.notice.value = null;
});
