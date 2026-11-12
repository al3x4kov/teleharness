// TASK-01.79: сборка стилей без предупреждений. Комментарий с «звёздочка + косая черта» внутри
// (например «.sa-*/.bg-bar») обрывает комментарий, и следующее правило молча теряется —
// так в 1.17.0 пропала раскладка сводки агентов (.sa-sum). esbuild об этом предупреждает.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const cssFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? cssFiles(path.join(dir, e.name)) : e.name.endsWith(".css") ? [path.join(dir, e.name)] : []));

test("стили: esbuild разбирает каждый css-файл src/ без предупреждений", async () => {
  const esbuild = await import("esbuild");
  const bad = [];
  for (const f of cssFiles(path.join(ROOT, "src"))) {
    const r = await esbuild.transform(readFileSync(f, "utf8"), { loader: "css", logLevel: "silent" });
    for (const w of r.warnings) bad.push(`${path.relative(ROOT, f)}:${w.location?.line ?? "?"} ${w.text}`);
  }
  assert.deepEqual(bad, []);
});
