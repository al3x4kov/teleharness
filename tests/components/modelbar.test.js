// C4 ModelBar (L2, TASK-14.7; FEAT-11.4/11.5, BUG-11.2, FEAT-13.17): пилюли
// модель/агент пустого чата, агент Claude-чата («Без агента» по умолчанию,
// Workflow из каталога), закрепление движка после первого сообщения, откат
// выбора при PATCH 409.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ ModelBar: "src/components/chat/ModelBar.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  ui.store.providerCfg.value = null;
  ui.store.notice.value = null;
  ui.store.claudeAgents.value = null;
  ui.store.claudeAgentsError.value = false;
  installFetch();
});

const CFG = {
  models: [
    { id: "glm-5.3-flash", providerID: "zai-coding-plan", label: "GLM-5.3 Flash (zai-coding-plan)" },
    { id: "glm-5.3", providerID: "zai-coding-plan", label: "GLM-5.3 (zai-coding-plan)" },
    { id: "claude-opus-5-5", providerID: "anthropic", label: "Claude Opus 5.5 (anthropic)" },
  ],
};
const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };

function seed(session) {
  ui.store.providerCfg.value = CFG;
  ui.store.sessions.value = [{ id: "ses_m", title: "", directory: "C:\\Home", time: { created: 1, updated: 1 }, ...session }];
}
const pills = (root) => $$(root, ".model-bar .model-pill").map((p) => p.textContent.trim());

test("пустой чат без привязки: пилюли = дефолты Настроек + подсказка «закрепятся»", () => {
  ui.store.setPrefs?.({ model: GLM, agent: "Sisyphus - ultraworker" });
  seed({});
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m", hasMessages: false });
  const p = pills(root);
  assert.equal(p.length, 2);
  assert.equal(p[0], "GLM-5.3 Flash", "имя модели без суффикса провайдера");
  assert.equal(p[1], "Sisyphus - ultraworker");
  assert.match($(root, ".model-bar-note").textContent, /Модель и агент закрепятся за чатом после первого сообщения/);
});

const CLAUDE_AGENTS = [{ id: "workflow", name: "Workflow", description: "Задача по полному флоу разработки — трекер, openspec, макеты, код с тестами, стенд, прод, отчёт" }];

test("Claude-модель: пилюля агента «Без агента» по умолчанию, opencode-агент не показывается (FEAT-13.17, BUG-11.2)", () => {
  seed({ zai: { model: OPUS, agent: "Sisyphus - ultraworker", prompted: false } });
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m" });
  assert.deepEqual(pills(root), ["Claude Opus 5.5", "Без агента"]);
  assert.equal($$(root, "button.model-pill").length, 2, "пилюля агента — кнопка");
  assert.equal(root.textContent.includes("Sisyphus"), false);
  assert.equal($$(root, "button.model-pill")[1].getAttribute("aria-label"), "Агент Claude-чата: без агента. Выбрать");
  assert.ok($(root, ".engine-dot.is-claude"));
  assert.match($(root, ".model-bar-note").textContent, /Модель и агент закрепятся за чатом после первого сообщения\. Агента Claude можно сменить и потом\./);
});

test("шит агента Claude-чата: «Без агента» с галочкой, Workflow с описанием; выбор Workflow → PATCH {agent}", async () => {
  installFetch([{ method: "PATCH", path: /\/binding$/, reply: (c) => ({ zai: { engine: "claude", model: OPUS, agent: c.body.agent ?? null, prompted: false } }) }]);
  ui.store.claudeAgents.value = CLAUDE_AGENTS;
  seed({ zai: { model: OPUS, agent: null, prompted: false } });
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m" });
  t$.click($$(root, "button.model-pill")[1]);
  await t$.flush();
  const sheet = document.querySelector(".sheet");
  assert.equal(sheet.getAttribute("aria-label"), "Агент чата");
  const rows = [...sheet.querySelectorAll("button.picker-row")];
  assert.deepEqual(rows.map((r) => r.querySelector(".picker-row-title").textContent), ["Без агента", "Workflow"]);
  assert.equal(rows[0].getAttribute("aria-pressed"), "true");
  assert.ok(rows[0].querySelector(".picker-check"), "галочка у «Без агента»");
  assert.equal(rows[0].querySelector(".picker-row-desc").textContent, "Claude Code как есть — по умолчанию");
  assert.equal(rows[1].getAttribute("aria-pressed"), "false");
  assert.match(rows[1].querySelector(".picker-row-desc").textContent, /^Задача по полному флоу разработки/);
  assert.ok(byText(sheet, ".agent-group-label", "Агенты портала · Claude"));
  assert.match(sheet.querySelector(".picker-foot").textContent, /можно сменить в любой момент/);
  t$.click(rows[1]);
  await t$.waitFor(() => fetchCalls.some((c) => c.method === "PATCH"));
  const call = fetchCalls.find((c) => c.method === "PATCH");
  assert.deepEqual(call.body, { agent: "workflow" });
  await t$.waitFor(() => pills(root)[1] === "Workflow");
});

test("Claude-чат с историей и Workflow: пилюля «Workflow»; смена на «Без агента» → PATCH {agent:null} без 409", async () => {
  installFetch([{ method: "PATCH", path: /\/binding$/, reply: (c) => ({ zai: { engine: "claude", model: OPUS, agent: c.body.agent ?? null, prompted: true } }) }]);
  ui.store.claudeAgents.value = CLAUDE_AGENTS;
  seed({ zai: { model: OPUS, agent: "workflow", prompted: true } });
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m", hasMessages: true });
  assert.deepEqual(pills(root), ["Claude Opus 5.5", "Workflow"]);
  assert.equal(!!$(root, ".model-bar-note"), false);
  t$.click($$(root, "button.model-pill")[1]);
  await t$.flush();
  const none = [...document.querySelectorAll(".sheet button.picker-row")].find((b) => b.textContent.includes("Без агента"));
  assert.equal(none.getAttribute("aria-pressed"), "false");
  t$.click(none);
  await t$.waitFor(() => fetchCalls.some((c) => c.method === "PATCH"));
  assert.deepEqual(fetchCalls.find((c) => c.method === "PATCH").body, { agent: null });
  await t$.waitFor(() => pills(root)[1] === "Без агента");
  assert.equal(ui.store.notice.value, null);
});

test("каталог Claude-агентов недоступен: «Без агента» есть всегда, ошибка с «Повторить»", async () => {
  installFetch([{ method: "GET", path: "/zai/api/claude/agents", reply: () => ({ status: 500, body: { error: "x" } }) }]);
  seed({ zai: { model: OPUS, agent: null, prompted: false } });
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m" });
  t$.click($$(root, "button.model-pill")[1]);
  await t$.waitFor(() => document.querySelector(".sheet .picker-fail"));
  const sheet = document.querySelector(".sheet");
  assert.match(sheet.querySelector(".picker-fail").textContent, /Не удалось получить список агентов/);
  assert.ok(byText(sheet, "button", "Повторить"));
  assert.ok([...sheet.querySelectorAll("button.picker-row")].some((b) => b.textContent.includes("Без агента")));
});

test("после первого сообщения движок закреплён: подсказки нет, в шите — только свой движок + LOCK_NOTE", async () => {
  seed({ zai: { model: GLM, agent: "Sisyphus - ultraworker", prompted: true } });
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m", hasMessages: true });
  assert.equal(!!$(root, ".model-bar-note"), false, "подсказки «закрепятся» нет");
  t$.click($$(root, "button.model-pill")[0]);
  await t$.flush();
  const text = document.body.textContent;
  assert.match(text, /Движок чата закреплён/);
  assert.equal(text.includes("Claude Opus 5.5"), false, "Claude-модели в закреплённом opencode-чате не предлагаются");
});

test("смена модели до первого сообщения → PATCH /binding; через движок — агент сбрасывается", async () => {
  installFetch([{ method: "PATCH", path: /\/binding$/, reply: (c) => ({ zai: { model: c.body.model, agent: c.body.agent ?? null, prompted: false } }) }]);
  seed({ zai: { model: GLM, agent: "Sisyphus - ultraworker", prompted: false } });
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m" });
  t$.click($$(root, "button.model-pill")[0]);
  await t$.flush();
  const opus = [...document.querySelectorAll("button.picker-row")].find((b) => b.textContent.includes("Claude Opus 5.5"));
  assert.equal(!!opus, true, "до первого сообщения доступны модели любого движка");
  t$.click(opus);
  await t$.waitFor(() => fetchCalls.some((c) => c.method === "PATCH"));
  const call = fetchCalls.find((c) => c.method === "PATCH");
  assert.equal(call.path, "/zai/api/session/ses_m/binding");
  assert.deepEqual(call.body.model, OPUS);
  assert.equal(call.body.agent, null, "Claude — без агента (дефолт Настроек)");
  await t$.waitFor(() => pills(root)[1] === "Без агента");
});

test("PATCH 409 → выбор откатывается, notice «Движок чата уже закреплён…»", async () => {
  installFetch([{ method: "PATCH", path: /\/binding$/, reply: () => ({ status: 409, body: { error: "locked" } }) }]);
  seed({ zai: { model: GLM, agent: "Sisyphus - ultraworker", prompted: false } });
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m" });
  t$.click($$(root, "button.model-pill")[0]);
  await t$.flush();
  const other = [...document.querySelectorAll("button.picker-row")].find((b) => b.textContent.includes("GLM-5.3") && !b.textContent.includes("Flash"));
  assert.equal(!!other, true);
  t$.click(other);
  await t$.waitFor(() => ui.store.notice.value);
  assert.match(ui.store.notice.value, /Движок чата уже закреплён/);
  await t$.flush();
  assert.equal(pills(root)[0], "GLM-5.3 Flash", "пилюля вернулась к прежней модели");
});

test("каталог моделей ещё не загружен: пилюля — человекочитаемое имя, не сырой id (ISSUE-008)", () => {
  seed({ zai: { model: GLM, agent: "Sisyphus - ultraworker", prompted: true } });
  ui.store.providerCfg.value = null;
  const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m", hasMessages: true });
  const p = pills(root);
  assert.equal(p[0], "GLM-5.3-Flash");
  assert.ok(!p.includes("glm-5.3-flash"), "сырой id не показывается");
});

test("UI-ISSUE-01 (BUG-160): тенант в Claude-чате — только пилюля модели, каталог агентов не запрашивается", () => {
  ui.store.me.value = { id: "t1", name: "tenant", role: "user" };
  try {
    seed({ zai: { model: OPUS, agent: null, prompted: false } });
    const { root } = t$.mount(ui.ModelBar, { sessionId: "ses_m" });
    assert.deepEqual(pills(root), ["Claude Opus 5.5"], "пилюли агента нет");
    assert.match($(root, ".model-bar-note").textContent, /^Модель закрепится за чатом после первого сообщения\.$/);
    assert.equal(root.textContent.includes("claude-agents"), false);
    assert.equal(fetchCalls.some((c) => /\/claude\/agents/.test(c.url ?? c.path ?? String(c))), false, "нет запроса /claude/agents (403 у тенанта)");
  } finally {
    ui.store.me.value = null;
  }
});
