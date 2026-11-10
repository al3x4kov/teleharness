// BUG-188, юниты lib/slash.js: разбор «/имя аргументы» и сборка тела
// POST /session/:id/command. Запуск:
//   node --test tests/bug188-slash.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSlash, commandBody, GLM_VARIANTS } from "../lib/slash.js";
import { withGlmVariant } from "../lib/glm-variant.js";

const NAMES = new Set(["as-spec", "review", "deep.plan", "old_cmd", "co-de"]);

test("parseSlash: «/as-spec текст» → имя + остаток аргументов", () => {
  assert.deepEqual(parseSlash("/as-spec утилита считает слова", NAMES), { name: "as-spec", arguments: "утилита считает слова" });
});

test("parseSlash: «/имя» без аргументов → пустой arguments", () => {
  assert.deepEqual(parseSlash("/review", NAMES), { name: "review", arguments: "" });
  assert.deepEqual(parseSlash("  /review  ", NAMES), { name: "review", arguments: "" });
});

test("parseSlash: аргументы с переносами и повторными пробелами сохраняются (кроме краёв)", () => {
  assert.deepEqual(parseSlash("/as-spec  строчка1\n  строчка2  ", NAMES), { name: "as-spec", arguments: "строчка1\n  строчка2" });
});

test("parseSlash: имена с точкой, подчёркиванием и дефисом", () => {
  assert.deepEqual(parseSlash("/deep.plan x", NAMES), { name: "deep.plan", arguments: "x" });
  assert.deepEqual(parseSlash("/old_cmd x", NAMES), { name: "old_cmd", arguments: "x" });
  assert.deepEqual(parseSlash("/co-de x", NAMES), { name: "co-de", arguments: "x" });
});

test("parseSlash: не команда → null", () => {
  assert.equal(parseSlash("обычный текст /as-spec", NAMES), null, "не начинается с /");
  assert.equal(parseSlash("/нетакой текст", NAMES), null, "имени нет в списке команд");
  assert.equal(parseSlash("/нетакой", NAMES), null);
  assert.equal(parseSlash("/привет мир", NAMES), null, "кириллица не входит в имя");
  assert.equal(parseSlash("//as-spec", NAMES), null, "двойной слэш");
  assert.equal(parseSlash("/", NAMES), null);
  assert.equal(parseSlash("", NAMES), null);
  assert.equal(parseSlash(null, NAMES), null);
  assert.equal(parseSlash("/as-spec", null), null, "список команд недоступен → обычный prompt");
});

test("parseSlash: принимает массив имён", () => {
  assert.deepEqual(parseSlash("/review x", ["review"]), { name: "review", arguments: "x" });
});

test("commandBody: обязательные command/arguments и model-строка из привязки", () => {
  const body = commandBody({
    command: "as-spec",
    arguments: "утилита считает слова",
    agent: "orchestrator",
    model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" },
    variantSetting: "max",
  });
  assert.deepEqual(body, {
    command: "as-spec",
    arguments: "утилита считает слова",
    agent: "orchestrator",
    model: "zai-coding-plan/glm-5.3-flash",
    variant: "max",
  });
});

test("commandBody: без агента поля agent нет; без модели — нет model", () => {
  assert.deepEqual(commandBody({ command: "review", arguments: "" }), { command: "review", arguments: "" });
  assert.deepEqual(commandBody({ command: "review", arguments: "", agent: "  " }), { command: "review", arguments: "" });
});

test("commandBody: variant только для GLM-5.3* и валидного не-off значения", () => {
  const glm = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
  const notGlm = { providerID: "anthropic", modelID: "claude-opus-4" };
  assert.equal(commandBody({ command: "c", arguments: "", model: glm, variantSetting: "low" }).variant, "low");
  assert.equal(commandBody({ command: "c", arguments: "", model: glm, variantSetting: "off" }).variant, undefined);
  assert.equal(commandBody({ command: "c", arguments: "", model: glm, variantSetting: "bogus" }).variant, undefined);
  assert.equal(commandBody({ command: "c", arguments: "", model: glm, variantSetting: null }).variant, undefined);
  assert.equal(commandBody({ command: "c", arguments: "", model: notGlm, variantSetting: "max" }).variant, undefined);
  assert.equal(commandBody({ command: "c", arguments: "", model: notGlm, variantSetting: "max" }).model, "anthropic/claude-opus-4");
});

test("commandBody: правило варианта совпадает с prompt-правилом withGlmVariant (BUG-180)", () => {
  const glm = { providerID: "zai-coding-plan", modelID: "glm-5.3-air" };
  for (const setting of GLM_VARIANTS) {
    const viaPrompt = withGlmVariant({ model: glm }, setting).variant ?? null;
    const viaCommand = commandBody({ command: "c", arguments: "", model: glm, variantSetting: setting }).variant ?? null;
    assert.equal(viaCommand, viaPrompt, `setting=${setting}`);
  }
});

test("commandBody: мусор на входе → null, не бросок", () => {
  assert.equal(commandBody(null), null);
  assert.equal(commandBody({}), null);
  assert.equal(commandBody({ command: "", arguments: "x" }), null);
});
