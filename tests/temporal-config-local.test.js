// Tests for TELEHARNESS_TEMPORAL_* config, CLI resolver, Unix socket length check,
// and local mode TELEHARNESS_TEMPORAL_LEDGER=none without hardcoded CLI/address/namespace.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../lib/config.js";
import { resolveTemporalCli, socketPathProblem, expandTilde, DEFAULT_TEMPORAL_CLI } from "../lib/temporal/cli.js";
import { pipelineRuntime } from "../lib/temporal/runtime.js";
import { scheduleService } from "../lib/temporal/schedules.js";
import { stageTimerStarter } from "../lib/temporal/stage-timer.js";

test("lib/config.js validates TELEHARNESS_TEMPORAL_* and stand/prod defaults", () => {
  const prod = loadConfig({ TELEHARNESS_ENV: "prod" });
  assert.deepEqual(prod.errors, []);
  assert.equal(prod.config.TELEHARNESS_TEMPORAL_CLI, "");
  assert.equal(prod.config.TELEHARNESS_TEMPORAL_ADDRESS, "127.0.0.1:17235");
  assert.equal(prod.config.TELEHARNESS_TEMPORAL_NAMESPACE, "teleharness-production");
  assert.equal(prod.config.TELEHARNESS_TEMPORAL_QUEUE, "teleharness-prod-pipeline-v1");
  assert.equal(prod.config.TELEHARNESS_TEMPORAL_LEDGER, "postgres");
  assert.equal(prod.config.TELEHARNESS_TEMPORAL_COMMAND_SLOTS, 2);
  assert.deepEqual(prod.config.TELEHARNESS_TEMPORAL_COMMAND_ROOTS, []);
  assert.equal(prod.config.TELEHARNESS_TEMPORAL_MODEL_SOCKET, "");
  assert.equal(prod.config.TELEHARNESS_TEMPORAL_UI_URL, "");

  const stand = loadConfig({ TELEHARNESS_ENV: "stand" });
  assert.deepEqual(stand.errors, []);
  assert.equal(stand.config.TELEHARNESS_TEMPORAL_ADDRESS, "127.0.0.1:17233");
  assert.equal(stand.config.TELEHARNESS_TEMPORAL_NAMESPACE, "teleharness-stage");
  assert.equal(stand.config.TELEHARNESS_TEMPORAL_QUEUE, "teleharness-stage-pipeline-v1");

  const custom = loadConfig({
    TELEHARNESS_TEMPORAL_CLI: "~/.local/bin/temporal",
    TELEHARNESS_TEMPORAL_ADDRESS: "127.0.0.1:7233",
    TELEHARNESS_TEMPORAL_NAMESPACE: "teleharness-local",
    TELEHARNESS_TEMPORAL_QUEUE: "teleharness-local-pipeline-v1",
    TELEHARNESS_TEMPORAL_LEDGER: "none",
    TELEHARNESS_TEMPORAL_COMMAND_SLOTS: "4",
    TELEHARNESS_TEMPORAL_COMMAND_ROOTS: "/opt/scripts;/srv/scripts",
    TELEHARNESS_TEMPORAL_MODEL_SOCKET: path.join(os.tmpdir(), "teleharness-temporal", "worker.sock"),
    TELEHARNESS_TEMPORAL_UI_URL: "http://127.0.0.1:8233",
  });
  assert.deepEqual(custom.errors, []);
  assert.equal(custom.config.TELEHARNESS_TEMPORAL_LEDGER, "none");
  assert.equal(custom.config.TELEHARNESS_TEMPORAL_COMMAND_SLOTS, 4);
  assert.deepEqual(custom.config.TELEHARNESS_TEMPORAL_COMMAND_ROOTS, ["/opt/scripts", "/srv/scripts"]);
  assert.equal(custom.config.TELEHARNESS_TEMPORAL_UI_URL, "http://127.0.0.1:8233");

  const bad = loadConfig({ TELEHARNESS_TEMPORAL_LEDGER: "sqlite", TELEHARNESS_TEMPORAL_COMMAND_SLOTS: "0" });
  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors[0], /TELEHARNESS_TEMPORAL_LEDGER/);
  assert.match(bad.errors[1], /TELEHARNESS_TEMPORAL_COMMAND_SLOTS/);
});

test("resolveTemporalCli: explicit path with ~, PATH lookup, and fallback /opt/temporal/temporal", () => {
  assert.equal(expandTilde("~/.local/bin/temporal", "/home/alice"), path.join("/home/alice", ".local/bin/temporal"));
  assert.equal(
    resolveTemporalCli("~/.local/bin/temporal", { homedir: "/home/alice" }),
    path.join("/home/alice", ".local/bin/temporal"),
  );

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "teleharness-cli-test-")));
  try {
    const binName = process.platform === "win32" ? "temporal.exe" : "temporal";
    const fakeBin = path.join(tmp, binName);
    fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(
      resolveTemporalCli("", { env: { PATH: tmp }, platform: process.platform }),
      fakeBin,
    );
    assert.equal(
      resolveTemporalCli("", { env: { PATH: "/nonexistent-dir-xyz" }, platform: "linux" }),
      DEFAULT_TEMPORAL_CLI,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("socketPathProblem: enforces 103-byte limit on macOS and 107-byte limit on POSIX", () => {
  assert.equal(socketPathProblem("/tmp/teleharness-temporal/worker.sock", "darwin"), null);
  const p104 = "/" + "a".repeat(103);
  assert.equal(Buffer.byteLength(p104, "utf8"), 104);
  assert.match(socketPathProblem(p104, "darwin") ?? "", /103/);
  assert.equal(socketPathProblem(p104, "linux"), null);
  const p108 = "/" + "a".repeat(107);
  assert.match(socketPathProblem(p108, "linux") ?? "", /107/);
  assert.equal(socketPathProblem(p108, "win32"), null);
});

test("runtime, schedules, stage-timer pass custom cli/address/namespace without hardcodes", async () => {
  const seen = [];
  const fakeExec = async (bin, args) => {
    seen.push({ bin, args });
    if (args.includes("describe") && args[0] === "schedule") {
      return { stdout: JSON.stringify({ schedule: { state: { paused: false } }, info: { futureActionTimes: [] } }) };
    }
    if (args.includes("describe")) {
      return { stdout: JSON.stringify({ workflowExecutionInfo: { status: "WORKFLOW_EXECUTION_STATUS_RUNNING", execution: { runId: "r1" }, type: { name: "TeleharnessTimerStepV1" } } }) };
    }
    return { stdout: "{}" };
  };
  const rt = pipelineRuntime(":memory:", {
    cli: "/custom/temporal",
    address: "127.0.0.1:7233",
    namespace: "teleharness-local",
    taskQueue: "teleharness-local-pipeline-v1",
    execute: fakeExec,
  });
  await rt.startPipeline({
    owner: "u1",
    definitionId: "def1",
    version: 1,
    requestId: "11111111-1111-4111-8111-111111111111",
  });

  const sched = scheduleService(":memory:", {
    cli: "/custom/temporal",
    address: "127.0.0.1:7233",
    namespace: "teleharness-local",
    taskQueue: "teleharness-local-pipeline-v1",
    execute: fakeExec,
  });
  await sched.create("u1", {
    definitionId: "def1",
    version: 1,
    cron: "0 9 * * *",
    timezone: "UTC",
    overlap: "skip",
    catchupSeconds: 60,
    requestId: "22222222-2222-4222-8222-222222222222",
  });

  const timer = stageTimerStarter(":memory:", {
    cli: "/custom/temporal",
    address: "127.0.0.1:7233",
    namespace: "teleharness-local",
    execute: fakeExec,
  });
  await timer.describeRun("wf-1");

  assert.ok(seen.length >= 4);
  for (const call of seen) {
    assert.equal(call.bin, "/custom/temporal");
    assert.ok(call.args.includes("127.0.0.1:7233"), `address missing in ${call.args.join(" ")}`);
    assert.ok(call.args.includes("teleharness-local"), `namespace missing in ${call.args.join(" ")}`);
  }
});
