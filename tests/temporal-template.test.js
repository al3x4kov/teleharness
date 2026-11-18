// FEAT-19.16: {{input.x}} / {{steps.id}}, condition and artifact validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, templateRefs } from "../shared/temporal-template.js";
import { validateDefinition } from "../shared/temporal-definition.js";

const base = (steps, inputs = []) => ({ name: "P", directory: "/p", inputs, steps });
const model = (id, instruction, dependsOn = []) => ({ id, type: "model", name: id, engine: "claude", model: "haiku", instruction, timeoutSeconds: 60, maxAttempts: 1, dependsOn });

test("подстановки: входы, ответы шагов, списки, неизвестное → пусто", () => {
  assert.equal(renderTemplate("Задача: {{input.task}}; черновик: {{ steps.draft }}; {{input.none}}.", { inputs: { task: "X" }, steps: { draft: "Y" } }), "Задача: X; черновик: Y; .");
  assert.equal(renderTemplate("{{input.list}}", { inputs: { list: ["a", "b"] } }), "a\nb");
  assert.deepEqual(templateRefs("{{input.a}} {{steps.b}} {{other.c}}").map((r) => r.kind + ":" + r.name), ["input:a", "steps:b"]);
});
test("ссылки: только объявленные входы и предыдущие шаги", () => {
  const ok = base([model("draft", "Напиши про {{input.task}}"), model("review", "Проверь: {{steps.draft}}", ["draft"])], [{ name: "task", type: "string", required: true }]);
  assert.equal(validateDefinition(ok).valid, true);
  const bad = base([model("draft", "{{steps.review}} {{input.nope}}"), model("review", "x", ["draft"])]);
  const msgs = validateDefinition(bad).errors.map((e) => e.message).join(" | ");
  assert.match(msgs, /Нет входа «nope»/); assert.match(msgs, /только на шаги, после которых/);
});
test("условие и артефакт", () => {
  const steps = [model("check", "Ответь ОК или НЕТ"), { id: "gate", type: "condition", name: "Если ОК", dependsOn: ["check"], check: { source: "step", ref: "check", op: "contains", value: "ОК" } },
    { id: "save", type: "artifact", name: "Сохранить", dependsOn: ["gate"], source: "check", filename: "итог.md" }];
  assert.equal(validateDefinition(base(steps)).valid, true);
  const wrong = structuredClone(steps); wrong[1].check = { source: "step", ref: "save", op: "contains", value: "" }; wrong[2].filename = "../x.exe";
  const m = validateDefinition(base(wrong)).errors.map((e) => e.message).join(" | ");
  assert.match(m, /Условие проверяет ответ шага/); assert.match(m, /укажите значение/); assert.match(m, /имя файла/);
});
