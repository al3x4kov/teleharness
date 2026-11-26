// Unit & integration tests for command-temporal.js and restart recovery.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildTemporalUiUrl, runTemporalWorkflowCommand } from "../lib/temporal/command-temporal.js";
import { CommandCatalog } from "../lib/temporal/command-catalog.js";
import { pipelineArtifacts } from "../lib/temporal/artifacts.js";
import { createCommandStepRunner } from "../lib/temporal/command-step.js";

test("buildTemporalUiUrl encodes namespace, workflowId and optional runId", () => {
  assert.equal(
    buildTemporalUiUrl("http://127.0.0.1:8233/", "my ns", "wf/1", "run-abc"),
    "http://127.0.0.1:8233/namespaces/my%20ns/workflows/wf%2F1/run-abc",
  );
  assert.equal(
    buildTemporalUiUrl("http://127.0.0.1:8233", "default", "wf-2"),
    "http://127.0.0.1:8233/namespaces/default/workflows/wf-2",
  );
  assert.equal(buildTemporalUiUrl("", "default", "wf-2"), null);
});

test("schedule trigger snapshots recentActions, picks newly started workflow, polls to COMPLETED, and gates files via dirAllowed", async () => {
  const calls = [];
  let describeScheduleCount = 0;
  let describeWfCount = 0;
  let nowVal = Date.parse("2026-11-25T10:00:00Z");

  const execute = async (_bin, args) => {
    calls.push(args);
    if (args[0] === "schedule" && args[1] === "describe") {
      describeScheduleCount += 1;
      if (describeScheduleCount === 1) {
        return {
          ok: true,
          code: 0,
          stdout: JSON.stringify({
            info: {
              recentActions: [
                { actualTime: "2026-11-25T09:00:00Z", startWorkflowResult: { workflowId: "old-wf-1", runId: "old-run" } },
              ],
            },
          }),
          stderr: "",
        };
      }
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          info: {
            recentActions: [
              { actualTime: "2026-11-25T09:00:00Z", startWorkflowResult: { workflowId: "old-wf-1", runId: "old-run" } },
              { actualTime: "2026-11-25T10:00:01Z", startWorkflowResult: { workflowId: "new-wf-42", runId: "run-42" } },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (args[0] === "schedule" && args[1] === "trigger") {
      assert.ok(args.includes("--overlap-policy"));
      assert.ok(args.includes("AllowAll"));
      return { ok: true, code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "workflow" && args[1] === "describe") {
      describeWfCount += 1;
      const status = describeWfCount === 1 ? "WORKFLOW_EXECUTION_STATUS_RUNNING" : "WORKFLOW_EXECUTION_STATUS_COMPLETED";
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({ workflowExecutionInfo: { status, execution: { runId: "run-42" } } }),
        stderr: "",
      };
    }
    if (args[0] === "workflow" && args[1] === "result") {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          summary: "Сводка готова: 3 метрики выросли.",
          report_path: "/allowed/reports/weekly.md",
          files: ["/allowed/reports/chart.png", "/secret/outside/dump.csv"],
        }),
        stderr: "",
      };
    }
    throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
  };

  let startedInfo = null;
  const res = await runTemporalWorkflowCommand({
    entry: {
      id: "weekly-report",
      name: "Еженедельный отчёт",
      kind: "temporal-workflow",
      temporal: {
        address: "127.0.0.1:7233",
        namespace: "default",
        schedule: "weekly-sched",
        uiBase: "http://127.0.0.1:8233",
      },
    },
    workflowId: "teleharness-wf-1",
    stepId: "run_report",
    user: { id: "admin", role: "admin" },
    dirAllowed: (_u, d) => d.startsWith("/allowed"),
    onChildStarted: (info) => {
      startedInfo = info;
    },
    execute,
    pollIntervalMs: 1,
    triggerPollMs: 1,
    now: () => {
      nowVal += 1000;
      return nowVal;
    },
    sleep: async () => {},
  });

  assert.equal(res.state, "done");
  assert.equal(res.childWorkflowId, "new-wf-42");
  assert.equal(res.childRunId, "run-42");
  assert.equal(startedInfo.childWorkflowId, "new-wf-42");
  assert.equal(res.uiUrl, "http://127.0.0.1:8233/namespaces/default/workflows/new-wf-42/run-42");
  assert.match(res.stdout, /# Еженедельный отчёт/);
  assert.match(res.stdout, /Сводка готова: 3 метрики выросли\./);
  assert.match(res.stdout, /Открыть в Temporal UI/);
  assert.deepEqual(res.files, [
    { path: "/allowed/reports/weekly.md", allowed: true },
    { path: "/allowed/reports/chart.png", allowed: true },
    { path: "/secret/outside/dump.csv", allowed: false },
  ]);
});

test("direct workflow start uses deterministic teleharness-cmd ID, handles AlreadyStarted idempotently, and extracts failure cause", async () => {
  const calls = [];
  const execute = async (_bin, args) => {
    calls.push(args);
    if (args[0] === "workflow" && args[1] === "start") {
      assert.ok(args.includes("teleharness-cmd-pipe-9-stepA"));
      assert.ok(args.includes("AllowDuplicateFailedOnly"));
      assert.ok(args.includes("--input"));
      return { ok: false, code: 1, stdout: "", stderr: "WorkflowExecutionAlreadyStarted" };
    }
    if (args[0] === "workflow" && args[1] === "describe") {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          workflowExecutionInfo: { status: "WORKFLOW_EXECUTION_STATUS_FAILED", execution: { runId: "r-99" } },
        }),
        stderr: "",
      };
    }
    if (args[0] === "workflow" && args[1] === "show") {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          events: [
            {
              workflowExecutionFailedEventAttributes: {
                failure: {
                  message: "Activity task failed",
                  cause: { message: "Upstream returned 502" },
                },
              },
            },
          ],
        }),
        stderr: "",
      };
    }
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  };

  const res = await runTemporalWorkflowCommand({
    entry: {
      id: "direct-wf",
      name: "Direct WF",
      kind: "temporal-workflow",
      temporal: {
        address: "127.0.0.1:7233",
        namespace: "reports",
        workflow: "GenerateReportWorkflow",
        taskQueue: "reports-q",
      },
    },
    workflowId: "pipe-9",
    stepId: "stepA",
    params: { period: "2026-W47" },
    user: { id: "admin", role: "admin" },
    execute,
    pollIntervalMs: 1,
    sleep: async () => {},
  });

  assert.equal(res.state, "failed");
  assert.equal(res.nonRetryable, false);
  assert.match(res.error, /FAILED/);
  assert.match(res.error, /Activity task failed/);
  assert.match(res.error, /Upstream returned 502/);
});

test("abort cancels child workflow only when cancelChild !== false", async () => {
  for (const cancelChild of [true, false]) {
    const calls = [];
    const ac = new AbortController();
    const execute = async (_bin, args) => {
      calls.push(args);
      if (args[0] === "workflow" && args[1] === "describe") {
        ac.abort();
        return { ok: true, code: 0, stdout: JSON.stringify({ status: "RUNNING" }), stderr: "" };
      }
      return { ok: true, code: 0, stdout: "", stderr: "" };
    };

    const res = await runTemporalWorkflowCommand({
      entry: {
        id: "cancel-test",
        name: "Cancel",
        kind: "temporal-workflow",
        temporal: {
          address: "127.0.0.1:7233",
          namespace: "default",
          workflow: "LongWf",
          taskQueue: "q",
          cancelChild,
        },
      },
      workflowId: "wf-c",
      stepId: "s1",
      resumeChildWorkflowId: "child-existing",
      signal: ac.signal,
      execute,
      pollIntervalMs: 1,
      sleep: async () => {},
    });

    assert.equal(res.state, "cancelled");
    const cancelCalls = calls.filter((a) => a[0] === "workflow" && a[1] === "cancel");
    assert.equal(cancelCalls.length, cancelChild ? 1 : 0);
  }
});

test("command-step resumes polling temporal-workflow after portal restart when child_workflow_id exists, and marks uncertain when missing", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "teleharness-cmd-twf-")));
  const catalogPath = path.join(dir, "temporal-commands.json");
  const artifactDir = path.join(dir, "artifacts");
  const db = new DatabaseSync(path.join(dir, "test.db"));
  t.after(async () => {
    try { db.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  await writeFile(
    catalogPath,
    JSON.stringify({
      schema: 1,
      items: [
        {
          id: "ext-report",
          name: "External Report",
          kind: "temporal-workflow",
          allow: { roles: ["admin"] },
          temporal: {
            address: "127.0.0.1:7233",
            namespace: "default",
            schedule: "ext-sched",
            uiBase: "http://127.0.0.1:8233",
          },
        },
      ],
    }),
    "utf8",
  );

  const catalog = new CommandCatalog({ file: catalogPath, allowedRoots: [dir] });
  const results = pipelineArtifacts(db, artifactDir);
  let seenResumeId = null;

  const runner = createCommandStepRunner({
    db,
    catalog,
    results,
    artifactDirectory: artifactDir,
    dirAllowed: () => true,
    temporalRunner: async ({ resumeChildWorkflowId }) => {
      seenResumeId = resumeChildWorkflowId;
      return {
        state: "done",
        exitCode: 0,
        durationMs: 1200,
        stdout: "# Resumed OK\n",
        stderr: "",
        childWorkflowId: resumeChildWorkflowId,
        childRunId: "run-resumed",
        childStatus: "COMPLETED",
        uiUrl: "http://127.0.0.1:8233/namespaces/default/workflows/ext-child-77/run-resumed",
        files: [{ path: path.join(dir, "out.md"), allowed: true }],
      };
    },
  });

  // Case 1: running row WITH child_workflow_id -> resumes polling directly
  db.prepare(
    `INSERT INTO command_runs (workflow_id, step, attempt, kind, command_id, state, child_workflow_id, child_run_id, started_at)
     VALUES ('wf-resume', 's1', 1, 'temporal-workflow', 'ext-report', 'running', 'ext-child-77', 'run-resumed', ?)`,
  ).run(Date.now() - 5000);

  const resumed = await runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-resume",
    stepId: "s1",
    definition: { directory: dir },
    step: { id: "s1", type: "command", command: "ext-report" },
  });
  assert.equal(resumed.state, "done");
  assert.equal(seenResumeId, "ext-child-77");
  assert.equal((await results.read("wf-resume", "s1")).trim(), "# Resumed OK");
  assert.equal(runner.commandMeta("wf-resume").s1.files.length, 1);

  // Case 2: running row WITHOUT child_workflow_id -> uncertain (non-retryable)
  db.prepare(
    `INSERT INTO command_runs (workflow_id, step, attempt, kind, command_id, state, started_at)
     VALUES ('wf-nochild', 's1', 1, 'temporal-workflow', 'ext-report', 'running', ?)`,
  ).run(Date.now() - 5000);

  const uncertain = await runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-nochild",
    stepId: "s1",
    definition: { directory: dir },
    step: { id: "s1", type: "command", command: "ext-report" },
  });
  assert.equal(uncertain.state, "failed");
  assert.equal(uncertain.nonRetryable, true);
  assert.equal(runner.commandMeta("wf-nochild").s1.state, "uncertain");
});
