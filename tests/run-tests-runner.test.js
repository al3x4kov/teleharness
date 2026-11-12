// @suite: server — сам спавнит раннер дочерним процессом (BUG-222/QA-05)
// BUG-222 (QA-04/QA-05): таймауты раннера тестов и классификация наборов.
// Классификация — чистая функция classifySuite, проверяется напрямую;
// зависший after-хук — реальным запуском раннера (режим files) над
// tests/fixtures/hanging-after.fixture.mjs с 3-секундным дедлайном.
// Run: node --test --test-concurrency=1 tests/run-tests-runner.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifySuite } from "./run-tests.mjs";
import { cleanEnv } from "./helpers/env.mjs";
import { waitFor } from "./helpers/wait.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("classifySuite: spawnSync → server; метка unit — исключение; обычный файл — unit", () => {
  // QA-05: старый regex ловил только spawn( — spawnSync( просачивался в unit.
  assert.equal(classifySuite('import { spawnSync } from "node:child_process";\nconst r = spawnSync("x", []);'), "server");
  // Явное исключение: spawnSync быстрого чистого скрипта остаётся unit.
  assert.equal(classifySuite('// @suite: unit — spawnSync чистого скрипта (BUG-222)\nconst r = spawnSync(process.execPath, ["-e", "1"]);'), "unit");
  // Обычный файл без спавна — unit.
  assert.equal(classifySuite('// обычный файл\nimport { test } from "node:test";\ntest("x", () => {});'), "unit");
  // Старые признаки server остаются в силе.
  assert.equal(classifySuite("const c = spawn(process.execPath, []);"), "server");
  assert.equal(classifySuite("http.createServer((q, s) => {});"), "server");
  assert.equal(classifySuite('import { EventHub } from "../lib/hub.js";'), "server");
  assert.equal(classifySuite("// @suite: server — ни одного спавна в файле"), "server");
  // Метка ищется только в первых 5 строках файла.
  assert.equal(classifySuite("\n\n\n\n\n// @suite: server — слишком глубоко"), "unit");
});

test("зависший after-хук: раннер рвёт по таймауту, называет файл, убивает дерево, код ≠ 0", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "zai-runner-hang-"));
  const pidFile = path.join(tmp, "grandchild.pid");
  const t0 = Date.now();
  const child = spawn(process.execPath, ["tests/run-tests.mjs", "files", "tests/fixtures/hanging-after.fixture.mjs"], {
    cwd: ROOT,
    env: cleanEnv({ ZAI_TEST_TIMEOUT_SERVER_MS: "3000", HANGING_FIXTURE_PID_FILE: pidFile }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  // Страховка от регрессии: если раннер завис навсегда — добиваем его сами
  // по pid (taskkill /T /F), чтобы не вешать весь серверный набор.
  const guard = setTimeout(() => {
    if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    else child.kill("SIGKILL");
  }, 30_000);
  try {
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.ok(Date.now() - t0 < 20_000, `раннер завершился за разумное время (${Date.now() - t0} мс)`);
    assert.notEqual(code, 0, `код возврата раннера при таймауте: ${code}`);
    assert.match(out, /ТАЙМАУТ/);
    assert.match(out, /hanging-after\.fixture\.mjs/, "строка ТАЙМАУТ называет файл набора");
    // QA-04: kill/spawnSync без /T оставил бы внука из фикстуры сиротой —
    // дерево обязано быть добито целиком.
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 0, `pid внука в ${pidFile}: ${pid}`);
    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      { timeoutMs: 5000, stepMs: 100, label: "внук фикстуры убит вместе с деревом процессов" },
    );
  } finally {
    clearTimeout(guard);
    rmSync(tmp, { recursive: true, force: true });
  }
});
