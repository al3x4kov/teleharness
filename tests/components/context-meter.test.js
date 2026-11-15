// FEAT-18.5 (L2): строка «Контекст N %» под пилюлями модели и подпись расхода
// в строке хода — обычный чат, заполнение > 80 % (предупреждение текстом, не
// только цветом), неизвестное окно (без процента), подписка без денег,
// «цена неизвестна» вместо «$0».
// Run: node --test --test-timeout=60000 tests/components/context-meter.test.js
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, createHarness, loadUI } from "./helpers/load.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ ModelBar: "src/components/chat/ModelBar.jsx", MessageBubble: "src/components/chat/MessageBubble.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  ui.store.providerCfg.value = null;
  ui.store.active.value = null;
});

const CFG = {
  models: [
    { id: "glm-5.3", providerID: "zai-coding-plan", label: "GLM-5.3 (zai-coding-plan)", contextLimit: 200000 },
    { id: "glm-5.3", providerID: "zai", label: "GLM-5.3 (zai)", contextLimit: 200000 },
    { id: "mystery", providerID: "kosmik", label: "Mystery (kosmik)" },
    { id: "claude-sonnet-4-6", providerID: "anthropic", label: "Claude Sonnet 4.6 (anthropic)", contextLimit: 200000 },
  ],
};
const user = { info: { id: "u1", role: "user", time: { created: 1_000 } }, parts: [{ type: "text", text: "вопрос" }] };
const answer = (providerID, modelID, tokens, extra = {}) => ({
  info: { id: "a1", role: "assistant", providerID, modelID, tokens, time: { created: 2_000, completed: 5_000 }, ...extra },
  parts: [{ type: "text", text: "ответ" }],
});

function mountBar(model, messages) {
  ui.store.providerCfg.value = CFG;
  ui.store.sessions.value = [{ id: "ses_c", title: "t", directory: "C:\\Home", time: { created: 1, updated: 1 }, teleharness: { model, agent: null, prompted: true } }];
  return t$.mount(ui.ModelBar, { sessionId: "ses_c", hasMessages: true, messages }).root;
}

test("обычный чат: «Контекст 42 %», полоска, итог чата в долларах, без предупреждения", () => {
  const root = mountBar({ providerID: "zai", modelID: "glm-5.3" }, [user, answer("zai", "glm-5.3", { input: 4000, output: 10, cache: { read: 80000, write: 0 } }, { cost: 0.0123 })]);
  const m = $(root, ".ctx-meter");
  assert.ok(m, "строка контекста есть");
  assert.equal(m.classList.contains("is-warn"), false);
  assert.match($(m, ".ctx-text").textContent, /^Контекст 42\s%$/);
  assert.ok($(m, ".ctx-bar .ctx-fill"));
  assert.equal($(m, ".ctx-cost").textContent, "· чат $0,0123");
  assert.match(m.textContent, /84k из 200k токенов/, "подсказка для чтения с экрана");
  assert.equal($(root, ".model-bar-note"), null, "подсказка «закрепятся» после первого сообщения скрыта");
});

test("> 80 %: «почти заполнен» и ⚠ текстом; Claude-подписка — без денег", () => {
  const root = mountBar(
    { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    [user, answer("anthropic", "claude-sonnet-4-6", { input: 20, output: 300, cache: { read: 300000, write: 2000 }, context: 170000 }, { cost: 0.42 })],
  );
  const m = $(root, ".ctx-meter");
  assert.ok(m.classList.contains("is-warn"));
  assert.match(m.textContent, /Контекст 85\s% · почти заполнен/);
  assert.ok($(m, ".ctx-warn-ico"));
  assert.equal($(m, ".ctx-cost").textContent, "· подписка");
  assert.doesNotMatch(m.textContent, /\$/, "условная цена API подписки не показывается");
});

test("окно модели неизвестно: процента и полоски нет, только токены; cost 0 — «цена неизвестна»", () => {
  const root = mountBar({ providerID: "kosmik", modelID: "mystery" }, [user, answer("kosmik", "mystery", { input: 170000, output: 5 }, { cost: 0 })]);
  const m = $(root, ".ctx-meter");
  assert.doesNotMatch(m.textContent, /%/);
  assert.equal($(m, ".ctx-bar"), null);
  assert.match($(m, ".ctx-text").textContent, /^Контекст 170k ток$/);
  assert.equal($(m, ".ctx-cost").textContent, "· цена неизвестна");
  assert.doesNotMatch(m.textContent, /\$0/);
});

test("нет ответа с токенами — строки нет", () => {
  const root = mountBar({ providerID: "zai", modelID: "glm-5.3" }, [user, answer("zai", "glm-5.3", undefined)]);
  assert.equal($(root, ".ctx-meter"), null);
});

function mountTurn(msg) {
  ui.store.providerCfg.value = CFG;
  ui.store.sessions.value = [{ id: "ses_c", title: "t", directory: "C:\\Home", time: { created: 1, updated: 1 } }];
  ui.store.active.value = { id: "ses_c", messages: [user, msg], status: "idle" };
  return t$.mount(ui.MessageBubble, { msg }).root;
}

test("строка хода: токены + «$0,0123» / «подписка» / «цена неизвестна»", () => {
  const paid = mountTurn(answer("zai", "glm-5.3", { input: 4000, output: 10, cache: { read: 0, write: 0 } }, { cost: 0.0123 }));
  assert.match($(paid, ".msg-meta").textContent, /^↑4k ↓10 · \$0,0123 · /);
  t$.cleanup();
  const sub = mountTurn(answer("zai-coding-plan", "glm-5.3", { input: 4000, output: 10 }, { cost: 0 }));
  assert.match($(sub, ".msg-meta").textContent, /^↑4k ↓10 · подписка · /);
  t$.cleanup();
  const unk = mountTurn(answer("kosmik", "mystery", { input: 4000, output: 10 }, { cost: 0 }));
  assert.match($(unk, ".msg-meta").textContent, /^↑4k ↓10 · цена неизвестна · /);
});
