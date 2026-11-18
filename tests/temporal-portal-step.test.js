import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCheck, artifactTarget } from "../lib/temporal/portal-step.js";
test("FEAT-19.16: условие — равно/содержит/не содержит/да/нет, регистр и пробелы не важны", () => {
  assert.equal(evaluateCheck({ op: "contains", value: "ок" }, "Всё ОК, можно"), true);
  assert.equal(evaluateCheck({ op: "not_contains", value: "ошибка" }, "Ошибка в шаге"), false);
  assert.equal(evaluateCheck({ op: "equals", value: "main" }, " Main "), true);
  assert.equal(evaluateCheck({ op: "yes" }, "Да, одобряю"), true);
  assert.equal(evaluateCheck({ op: "yes" }, "Нет"), false);
  assert.equal(evaluateCheck({ op: "no" }, false), true);
  assert.throws(() => evaluateCheck({ op: "regex" }, "x"));
});
test("FEAT-19.16: артефакт — только имя файла в папке запуска, без перезаписи", { skip: process.platform === "win32" && "Linux/macOS-only feature (POSIX paths, Unix socket, uid)" }, () => {
  const have = new Set(["/r/итог.md", "/r/итог (2).md"]);
  assert.equal(artifactTarget("/r", "итог.md", (p) => have.has(p)), "/r/итог (3).md");
  assert.throws(() => artifactTarget("/r", "../x.md", () => false));
  assert.throws(() => artifactTarget("/r", ".env.md", () => false));
});
