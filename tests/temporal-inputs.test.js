import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanInputs } from "../lib/temporal/inputs.js";
const decl = [{ name: "task", type: "string", required: true }, { name: "n", type: "number", required: false }, { name: "ok", type: "boolean", required: false }, { name: "list", type: "array", required: false }];
test("FEAT-19.16: входы проверяются по схеме версии", () => {
  assert.deepEqual(cleanInputs(decl, { task: "X", n: "2,5", ok: true, list: "a\n\nb" }), { task: "X", n: 2.5, ok: true, list: ["a", "b"] });
  assert.throws(() => cleanInputs(decl, {}), /Заполните вход «task»/);
  assert.throws(() => cleanInputs(decl, { task: "X", extra: 1 }), /Неизвестный вход/);
  assert.throws(() => cleanInputs(decl, { task: "X", n: "abc" }), /нужно число/);
  assert.throws(() => cleanInputs(decl, { task: "X", ok: "да" }), /да или нет/);
  assert.deepEqual(cleanInputs([], undefined), {});
});
