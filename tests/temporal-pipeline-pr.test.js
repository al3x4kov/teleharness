// @suite: unit
// FEAT-20.3 (2.5): шаг «Открыть PR» в python-воркере — правила шага без Temporal
// (temporalio подменён стабом): ожидание GitHub до 24 ч, решение человека, итог шага.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const pythonBin = ["python3", "python"].find((b) => { try { execFileSync(b, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } }) ?? null;
const hasPython = Boolean(pythonBin);

test("FEAT-20.3 2.5: воркер — шаг «Открыть PR»: github_wait 5 мин × 288 → 24 ч, решение человека, поля итога", { skip: !hasPython && "нужен python3" }, () => {
  const out = execFileSync(pythonBin, ["tests/temporal-worker/pipeline_pr_unit.py"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
  assert.match(out, /ALL OK/, out);
});
