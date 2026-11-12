// L1 (TASK-14.9): src/lib/engine.js целиком — engineOf, ярлыки, bindingOf
// (запись zai сервера → фолбэк на model/agent самой сессии), defaultBinding,
// modelName, bindingLine (BUG-11.1 / BUG-11.2).
// Run: node --test tests/engine.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_PROVIDER,
  ENGINE_LABEL,
  ENGINE_SHORT,
  bindingLine,
  bindingOf,
  defaultBinding,
  engineOf,
  modelName,
  prettyModelId,
} from "../src/lib/engine.js";

const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const SIS = "Sisyphus - ultraworker";

test("CLAUDE_PROVIDER = anthropic; engineOf: только anthropic → claude, всё прочее → opencode", () => {
  assert.equal(CLAUDE_PROVIDER, "anthropic");
  assert.equal(engineOf("anthropic"), "claude");
  for (const p of ["zai-coding-plan", "Anthropic", "", undefined, null, 1]) assert.equal(engineOf(p), "opencode", String(p));
});

test("ENGINE_LABEL / ENGINE_SHORT покрывают оба движка", () => {
  assert.deepEqual(Object.keys(ENGINE_LABEL).sort(), ["claude", "opencode"]);
  assert.deepEqual(Object.keys(ENGINE_SHORT).sort(), ["claude", "opencode"]);
  assert.equal(ENGINE_LABEL.opencode, "opencode"); // TASK-01.84
  assert.equal(ENGINE_LABEL.claude, "Claude · подписка");
  assert.equal(ENGINE_SHORT.opencode, "z.ai");
  assert.equal(ENGINE_SHORT.claude, "Claude");
});

// ---- bindingOf -----------------------------------------------------------------

test("bindingOf: запись zai сервера (opencode) → engine/model/agent/prompted", () => {
  const b = bindingOf({ zai: { model: GLM, agent: SIS, prompted: 1 } });
  assert.deepEqual(b, { engine: "opencode", model: GLM, agent: SIS, prompted: true });
  assert.equal(bindingOf({ zai: { model: GLM } }).agent, null, "нет агента → null");
  assert.equal(bindingOf({ zai: { model: GLM } }).prompted, false);
});

test("bindingOf: claude-привязка никогда не несёт агента (BUG-11.2)", () => {
  assert.deepEqual(bindingOf({ zai: { model: OPUS, agent: SIS, prompted: true } }), {
    engine: "claude",
    model: OPUS,
    agent: null,
    prompted: true,
  });
});

test("bindingOf: modelID может прийти как id; лишние поля модели отбрасываются", () => {
  const b = bindingOf({ zai: { model: { providerID: "zai-coding-plan", id: "glm-5.3", extra: 1 } } });
  assert.deepEqual(b.model, { providerID: "zai-coding-plan", modelID: "glm-5.3" });
  const pref = bindingOf({ zai: { model: { providerID: "p", modelID: "m", id: "other" } } });
  assert.equal(pref.model.modelID, "m", "modelID приоритетнее id");
});

test("bindingOf: битая zai-модель → фолбэк на model/agent самой сессии (prompted=true)", () => {
  const s = { zai: { model: { providerID: "", modelID: "x" }, agent: "ignored" }, model: GLM, agent: "build" };
  assert.deepEqual(bindingOf(s), { engine: "opencode", model: GLM, agent: "build", prompted: true });
  assert.deepEqual(bindingOf({ model: OPUS, agent: SIS }), { engine: "claude", model: OPUS, agent: null, prompted: true });
  assert.equal(bindingOf({ model: GLM }).agent, null);
});

test("bindingOf: нечего взять → null (нестроковые/пустые поля не считаются моделью)", () => {
  for (const s of [
    undefined,
    null,
    {},
    { zai: null },
    { zai: { model: null } },
    { zai: { model: { providerID: 1, modelID: "m" } } },
    { zai: { model: { providerID: "p", modelID: 2 } } },
    { model: { providerID: "p" } },
    { model: { modelID: "m" } },
    { model: "glm-5.3-flash" },
  ]) {
    assert.equal(bindingOf(s), null, JSON.stringify(s));
  }
});

// ---- defaultBinding --------------------------------------------------------------

test("defaultBinding: prefs → новая (непривязанная) привязка, prompted=false", () => {
  assert.deepEqual(defaultBinding({ model: GLM, agent: SIS }), { engine: "opencode", model: GLM, agent: SIS, prompted: false });
  assert.deepEqual(defaultBinding({ model: OPUS, agent: SIS }), { engine: "claude", model: OPUS, agent: null, prompted: false });
  assert.equal(defaultBinding({ model: GLM }).agent, null);
});

test("defaultBinding: без валидной модели → null", () => {
  for (const p of [undefined, null, {}, { agent: SIS }, { model: {} }, { model: { providerID: "p" } }]) {
    assert.equal(defaultBinding(p), null, JSON.stringify(p));
  }
});

// ---- modelName / bindingLine -------------------------------------------------------

const CFG = {
  models: [
    { id: "glm-5.3-flash", providerID: "zai-coding-plan", label: "GLM-5.3 Flash (zai-coding-plan)" },
    { id: "claude-opus-5-5", providerID: "anthropic", label: "Claude Opus 5.5" },
    { id: "nolabel", providerID: "zai-coding-plan" },
  ],
};

test("modelName: срезает суффикс «(provider)», без суффикса — label как есть", () => {
  assert.equal(modelName(CFG, GLM), "GLM-5.3 Flash");
  assert.equal(modelName(CFG, OPUS), "Claude Opus 5.5");
});

test("modelName: каталог не загружен / нет совпадения / нет label → человекочитаемый id (ISSUE-008)", () => {
  assert.equal(modelName(null, GLM), "GLM-5.3-Flash");
  assert.equal(modelName({}, GLM), "GLM-5.3-Flash");
  assert.equal(modelName(null, OPUS), "Claude Opus 5.5", "известный id — имя из словаря claude");
  assert.equal(modelName(CFG, { providerID: "other", modelID: "glm-5.3-flash" }), "GLM-5.3-Flash", "провайдер тоже должен совпасть");
  assert.equal(modelName(CFG, { providerID: "zai-coding-plan", modelID: "nolabel" }), "Nolabel");
});

test("prettyModelId: словарь → форматирование id, сырой id не мигает (ISSUE-008)", () => {
  assert.equal(prettyModelId("glm-5.3-flash"), "GLM-5.3-Flash");
  assert.equal(prettyModelId("glm-4.5-air"), "GLM-4.5-Air");
  assert.equal(prettyModelId("gpt-oss-120b"), "GPT-OSS-120B");
  assert.equal(prettyModelId("claude-haiku-4-5"), "Claude Haiku 4.5");
  assert.equal(prettyModelId("MyModel-X"), "MyModel-X", "смешанный регистр не трогаем");
  assert.equal(prettyModelId(""), "");
  assert.equal(prettyModelId(null), "");
});

test("modelName: нет модели → пустая строка", () => {
  assert.equal(modelName(CFG, null), "");
  assert.equal(modelName(CFG, undefined), "");
});

test("bindingLine: opencode «агент · модель», без агента — только модель", () => {
  assert.equal(bindingLine({ engine: "opencode", model: GLM, agent: SIS }, CFG), `${SIS} · GLM-5.3 Flash`);
  assert.equal(bindingLine({ engine: "opencode", model: GLM, agent: null }, CFG), "GLM-5.3 Flash");
  assert.equal(bindingLine({ engine: "opencode", model: GLM, agent: "" }, null), "GLM-5.3-Flash");
});

test("bindingLine: claude «модель · Claude Code», агент игнорируется (BUG-11.2)", () => {
  assert.equal(bindingLine({ engine: "claude", model: OPUS, agent: SIS }, CFG), "Claude Opus 5.5 · Claude Code");
});

test("FEAT-13.17: bindingLine claude с агентом — «модель · Workflow» (имя из каталога, до загрузки — id)", () => {
  const cat = [{ id: "workflow", name: "Workflow" }];
  assert.equal(bindingLine({ engine: "claude", model: OPUS, agent: "workflow" }, CFG, cat), "Claude Opus 5.5 · Workflow");
  assert.equal(bindingLine({ engine: "claude", model: OPUS, agent: "workflow" }, CFG), "Claude Opus 5.5 · workflow");
  assert.equal(bindingLine({ engine: "claude", model: OPUS, agent: null }, CFG, cat), "Claude Opus 5.5 · Claude Code");
});

test("FEAT-13.17: bindingOf/defaultBinding — Claude-агент только id каталога, по умолчанию null", () => {
  assert.equal(bindingOf({ zai: { model: OPUS, agent: "workflow", prompted: true } }).agent, "workflow");
  assert.equal(bindingOf({ zai: { model: OPUS, agent: SIS } }).agent, null, "opencode-имя не проходит (BUG-11.2)");
  assert.equal(bindingOf({ model: { providerID: "anthropic", id: "claude-opus-5-5" }, agent: "workflow" }).agent, null, "из upstream — никогда");
  assert.equal(defaultBinding({ model: OPUS, agent: SIS }).agent, null, "нет pref claudeAgent → без агента");
  assert.equal(defaultBinding({ model: OPUS, agent: SIS, claudeAgent: "workflow" }).agent, "workflow");
  assert.equal(defaultBinding({ model: GLM, agent: SIS, claudeAgent: "workflow" }).agent, SIS);
});

test("bindingLine: нет привязки → пустая строка", () => {
  assert.equal(bindingLine(null, CFG), "");
  assert.equal(bindingLine(undefined), "");
});

test("сквозной сценарий: bindingOf → bindingLine для записи сервера", () => {
  const s = { id: "ses_1", zai: { model: GLM, agent: SIS, prompted: false } };
  assert.equal(bindingLine(bindingOf(s), CFG), `${SIS} · GLM-5.3 Flash`);
});

// Ревью 212 (ретест прода FEAT-01.29, находка N-1): opencode вплетает досланное сообщение в
// текущий ход (агент читает его на ближайшем шаге), Claude ставит в очередь до конца хода —
// подписи пузыря и кнопки «Отправить» не должны обещать opencode-чату очередь.
test("queuedLabel/queuedSendLabel: Claude — очередь после хода, opencode — учтёт на ближайшем шаге", async () => {
  const { queuedLabel, queuedSendLabel } = await import("../src/lib/engine.js");
  assert.equal(queuedLabel("claude"), "В очереди — отправится после текущего хода");
  assert.equal(queuedSendLabel("claude"), "Отправить — встанет в очередь за текущим ходом");
  for (const e of ["opencode", null, undefined]) {
    assert.equal(queuedLabel(e), "Доставлено — агент учтёт его на ближайшем шаге");
    assert.equal(queuedSendLabel(e), "Отправить — агент учтёт на ближайшем шаге");
    assert.doesNotMatch(queuedLabel(e), /после текущего хода/);
  }
});
