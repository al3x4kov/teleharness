import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import { listRunFiles } from "../lib/temporal/run-files.js";
test("FEAT-19.16: файлы папки запуска — вложенные, без скрытых и симлинков", { skip: process.platform === "win32" && "Linux/macOS-only feature (POSIX paths, Unix socket, uid)" }, () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ws-")); const run = path.join(ws, "runs", "r1");
  mkdirSync(path.join(run, "sub"), { recursive: true });
  writeFileSync(path.join(run, "итог.md"), "x"); writeFileSync(path.join(run, "sub", "data.json"), "{}"); writeFileSync(path.join(run, ".secret"), "s");
  symlinkSync("/etc/hostname", path.join(run, "link"));
  const files = listRunFiles(ws, "runs/r1");
  assert.deepEqual(files.map((f) => f.name).sort(), ["sub/data.json", "итог.md"]);
  assert.equal(files.find((f) => f.name === "итог.md").path, "runs/r1/итог.md");
  assert.deepEqual(listRunFiles(ws, "runs/none"), []); assert.deepEqual(listRunFiles(ws, null), []);
});

test("macOS /var → /private/var: папка пайпа через ссылку — пути файлов остаются относительными", () => {
  const real = mkdtempSync(path.join(os.tmpdir(), "ws-real-")); mkdirSync(path.join(real, "runs", "r1"), { recursive: true });
  writeFileSync(path.join(real, "runs", "r1", "a.md"), "x");
  const alias = path.join(mkdtempSync(path.join(os.tmpdir(), "ws-alias-")), "link"); symlinkSync(real, alias);
  assert.deepEqual(listRunFiles(alias, "runs/r1").map((f) => f.path), ["runs/r1/a.md"]);
});
