// @suite: unit
// Command step in the Python Temporal worker + replay compatibility for TeleharnessPipelineV1.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const UNIT_PY = fileURLToPath(new URL("./temporal-worker/pipeline_command_unit.py", import.meta.url));
const REPLAY_PY = fileURLToPath(new URL("./temporal-worker/pipeline_command_replay.py", import.meta.url));

const PYTHON_BIN = (() => {
  for (const bin of [process.env.TELEHARNESS_TEMPORAL_PYTHON, "python3", "python"].filter(Boolean)) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {}
  }
  return null;
})();

const TEMPORAL_PY = (() => {
  if (!PYTHON_BIN) return null;
  try {
    execFileSync(PYTHON_BIN, ["-c", "import temporalio"], { stdio: "ignore" });
    return PYTHON_BIN;
  } catch {
    return null;
  }
})();

test("worker: command step (slot_wait, heartbeat, CommandFailed, seed, patched)", { skip: !PYTHON_BIN && "python3 is required" }, () => {
  const out = execFileSync(PYTHON_BIN, [UNIT_PY], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
  assert.match(out, /ALL OK/, out);
});

test("Replayer: backward compatibility of legacy TeleharnessPipelineV1 history without command-step-v1", { skip: !TEMPORAL_PY && "temporalio python package is required" }, () => {
  const out = execFileSync(TEMPORAL_PY, [REPLAY_PY], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
  assert.match(out, /REPLAY OK/, out);
});
