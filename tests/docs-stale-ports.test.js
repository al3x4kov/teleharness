// Точка входа агента не должна описывать выведенный opencode 1.x как действующий
// (TASK-15.9, ops.md OPS-01). Строки AGENTS.md и README.md с :4096, :4097, :4172,
// 1.19.5, stand.ps1, stand.cmd, zai-opencode-serve допустимы только если в той же
// строке есть «выведен» (в любой форме) или «истори». Иначе тест падает и печатает
// файл, строку и её начало.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STALE = [":4096", ":4097", ":4172", "1.19.5", "stand.ps1", "stand.cmd", "zai-opencode-serve"];
const HISTORIC = /вывед|истори|legacy|1\.x/i;

test("AGENTS.md и README.md: порты/службы opencode 1.x — только как история", () => {
  const bad = [];
  for (const rel of ["AGENTS.md", "README.md"]) {
    const lines = readFileSync(path.join(ROOT, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      const hit = STALE.find((s) => line.includes(s));
      if (hit && !HISTORIC.test(line)) bad.push(`${rel}:${i + 1} (${hit}): ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(bad, [], "строки с выведенными портами/службами 1.x без пометки «выведен»/«истори»");
});
