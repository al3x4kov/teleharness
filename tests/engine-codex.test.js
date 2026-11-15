// FEAT-18.7: третий движок codex в shared/engine.js и src/lib/engine.js —
// провайдер openai-codex, id моделей Codex, движки раннера (claude + codex).
// Run: node --test tests/engine-codex.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEX_PROVIDER, engineOf, isCodexModelId, isRunnerEngine, normalizeCodexCatalog, runnerEngineOfModel } from "../shared/engine.js";
import { ENGINE_LABEL, ENGINE_SHORT, bindingOf, queuedLabel } from "../src/lib/engine.js";

test("engineOf: openai-codex → codex, anthropic → claude, прочее → opencode", () => {
  assert.equal(CODEX_PROVIDER, "openai-codex");
  assert.equal(engineOf("openai-codex"), "codex");
  assert.equal(engineOf("anthropic"), "claude");
  for (const p of ["openai", "OpenAI-Codex", "zai-coding-plan", "", null]) assert.equal(engineOf(p), "opencode", String(p));
});

test("isRunnerEngine: claude и codex идут через раннер CLI, opencode — нет", () => {
  assert.equal(isRunnerEngine("claude"), true);
  assert.equal(isRunnerEngine("codex"), true);
  for (const e of ["opencode", "", null, undefined]) assert.equal(isRunnerEngine(e), false);
});

test("isCodexModelId: только простые id, ничего похожего на опцию CLI", () => {
  for (const id of ["gpt-6.1-sol", "gpt-6-astra", "o5-mini", "codex-1"]) assert.equal(isCodexModelId(id), true, id);
  for (const id of ["--model", "-c", "gpt 6", "gpt-6;rm", "", null, "a".repeat(81)]) assert.equal(isCodexModelId(id), false, String(id));
});

test("normalizeCodexCatalog: model/list → [{id,name,context,isDefault}], мусор и скрытые отброшены, основная — первой", () => {
  const out = normalizeCodexCatalog([
    { id: "gpt-6-astra", displayName: "GPT-6-Astra", hidden: false },
    { id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true },
    { id: "--bad", displayName: "x" },
    { id: "gpt-old", displayName: "Old", hidden: true },
    null,
  ]);
  assert.deepEqual(out.map((m) => m.id), ["gpt-6.1-sol", "gpt-6-astra"]);
  assert.equal(out[0].name, "GPT-6.1-Sol");
  assert.equal(out[0].isDefault, true);
  assert.ok(out.every((m) => m.context > 0));
  assert.equal(normalizeCodexCatalog([]), null);
  assert.equal(normalizeCodexCatalog("x"), null);
});

test("runnerEngineOfModel: движок раннера по модели хода", () => {
  assert.equal(runnerEngineOfModel({ providerID: "openai-codex", modelID: "gpt-6.1-sol" }), "codex");
  assert.equal(runnerEngineOfModel({ providerID: "anthropic", modelID: "claude-haiku-4-5" }), "claude");
  assert.equal(runnerEngineOfModel({ providerID: "zai-coding-plan", modelID: "glm-5.3" }), null);
});

test("клиент: ярлыки Codex, привязка без агента, очередь как у Claude", () => {
  assert.equal(ENGINE_LABEL.codex, "Codex · подписка");
  assert.equal(ENGINE_SHORT.codex, "Codex");
  const b = bindingOf({ teleharness: { model: { providerID: "openai-codex", modelID: "gpt-6.1-sol" }, agent: "Sisyphus - ultraworker", prompted: true } });
  assert.equal(b.engine, "codex");
  assert.equal(b.agent, null);
  assert.equal(queuedLabel("codex"), queuedLabel("claude"));
});

test("клиент: режим прав доступен в Codex-чате всем, строка чата «модель · Codex», рабочий список включает Codex", async () => {
  const { permModeAvailable, bindingLine, workingModels, defaultBinding } = await import("../src/lib/engine.js");
  assert.equal(permModeAvailable({ engine: "codex", admin: false }), true);
  const b = { engine: "codex", model: { providerID: "openai-codex", modelID: "gpt-6.1-sol" }, agent: null };
  assert.equal(bindingLine(b, { models: [{ id: "gpt-6.1-sol", providerID: "openai-codex", label: "GPT-6.1-Sol" }] }), "GPT-6.1-Sol · Codex");
  assert.equal(defaultBinding({ model: { providerID: "openai-codex", modelID: "gpt-6.1-sol" }, agent: "Sisyphus - ultraworker" }).agent, null);
  const cfg = { connected: ["zai-coding-plan", "openai-codex"], models: [{ id: "glm-5.3", providerID: "zai-coding-plan" }, { id: "gpt-6.1-sol", providerID: "openai-codex" }] };
  const ids = workingModels(cfg).map((m) => m.id);
  assert.ok(ids.includes("gpt-6.1-sol"), JSON.stringify(ids));
});
