// FEAT-19.32: end-to-end backend tests for pipeline resume (artifacts, runtime, prepare-bridge, routes).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DefinitionStore } from "../lib/temporal/definitions.js";
import { pipelineRuntime } from "../lib/temporal/runtime.js";
import { pipelineArtifacts } from "../lib/temporal/artifacts.js";
import { prepareRun } from "../lib/temporal/prepare-bridge.js";
import { temporalRoutes } from "../routes/temporal.js";

function makeDraft(dir, steps, inputs = [{ name: "version", type: "string", required: true }]) {
  return { name: "Release Pipe", directory: dir, inputs, steps };
}

function makeHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), "teleharness-resume-"));
  const store = new DefinitionStore({ file: path.join(dir, "defs.json") });
  const artDir = path.join(dir, "artifacts");
  const cliCalls = [];
  const workflowStates = new Map();
  const runtime = pipelineRuntime(":memory:", {
    namespace: "qa",
    address: "unused",
    taskQueue: "qa-q",
    execute: async (_cli, args) => {
      cliCalls.push(args);
      if (args[1] === "start") return { stdout: "{}" };
      if (args[1] === "describe") {
        const wfId = args[args.indexOf("-w") + 1];
        const st = workflowStates.get(wfId) ?? { status: "FAILED", state: null };
        return {
          stdout: JSON.stringify({
            workflowExecutionInfo: {
              type: { name: "TeleharnessPipelineV1" },
              execution: { runId: "11111111-1111-4111-8111-111111111111" },
              status: "WORKFLOW_EXECUTION_STATUS_" + st.status,
              startTime: "2026-11-23T07:00:00Z",
              closeTime: st.status === "RUNNING" ? undefined : "2026-11-23T07:05:00Z",
            },
            ...(st.status === "COMPLETED" && st.state ? { result: st.state } : {}),
          }),
        };
      }
      if (args[1] === "query") {
        const wfId = args[args.indexOf("-w") + 1];
        const st = workflowStates.get(wfId) ?? { state: null };
        return { stdout: JSON.stringify({ queryResult: [st.state] }) };
      }
      return { stdout: "{}" };
    },
  });
  const artifacts = pipelineArtifacts(runtime.db, artDir);
  const users = {
    admin: { id: "admin", role: "admin", disabled: false },
    alice: { id: "alice", role: "user", disabled: false },
  };
  let allowedEngines = new Set(["claude", "codex", "opencode", "acp"]);
  const deps = {
    store,
    ...runtime,
    resumePipeline: (params) => runtime.resumePipeline({ ...params, inheritArtifacts: artifacts.inheritFrom }),
    results: artifacts,
    validatePipeline: () => {},
    dirAllowed: () => true,
    engineAllowed: (_u, e) => allowedEngines.has(e),
    sendJson: (res, status, data) => {
      res.status = status;
      res.data = data;
    },
    readJsonBody: async (req) => req.body,
  };
  const routes = temporalRoutes(deps);
  async function call(method, url, { user = users.admin, body = undefined } = {}) {
    const r = routes.find((x) => x.method === method && (typeof x.path === "string" ? x.path === url : x.path.test(url)));
    assert.ok(r, `route not found: ${method} ${url}`);
    const match = typeof r.path === "string" ? null : url.match(r.path);
    const res = { status: 0, data: null };
    await r.handler({ req: { body }, res, user, match });
    return res;
  }
  return {
    dir, artDir, store, runtime, artifacts, cliCalls, workflowStates, users, call,
    setAllowedEngines: (set) => { allowedEngines = set; },
    close: () => runtime.db.close(),
  };
}

describe("Temporal resume from step (FEAT-19.32)", () => {
  it("resumes failed run from first uncompleted step, inherits folder/results/chats, and passes safe seed to prepareRun", async () => {
    const h = makeHarness();
    try {
      const def1 = makeDraft(h.dir, [
        { id: "s1", name: "Шаг 1", type: "model", dependsOn: [], engine: "claude", model: "sonnet", instruction: "SECRET_PROMPT_1", timeoutSeconds: 60, maxAttempts: 1 },
        { id: "s2", name: "Шаг 2", type: "model", dependsOn: ["s1"], engine: "claude", model: "sonnet", instruction: "Use {{steps.s1}}", timeoutSeconds: 60, maxAttempts: 1 },
        { id: "s3", name: "Шаг 3", type: "timer", dependsOn: ["s2"], seconds: 10 },
      ]);
      const rec = h.store.create("admin", def1);
      h.store.publish("admin", rec.id, rec.revision);

      const started = await h.call("POST", "/teleharness/api/temporal/runs", {
        body: { definitionId: rec.id, version: 1, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", inputs: { version: "2.6.0" } },
      });
      assert.equal(started.status, 202);
      const srcId = started.data.workflowId;

      // Simulate s1 completed + artifacts saved + s2 failed.
      h.artifacts.remember(srcId, "s1", "receipt-s1");
      h.artifacts.remember(srcId, "s2", "receipt-s2-partial");
      h.artifacts.rememberChat(srcId, "s1", "chat-s1");
      h.artifacts.rememberChat(srcId, "s2", "chat-s2");
      h.artifacts.runFolder(srcId, () => "20261123-0700-src1");
      h.workflowStates.set(srcId, {
        status: "FAILED",
        state: { steps: { s1: "completed", s2: "running", s3: "waiting" } },
      });

      // GET source run exposes resumeOptions with defaultFromStepId=s2
      const detail = await h.call("GET", `/teleharness/api/temporal/runs/${srcId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.data.resumeOptions.versions.length, 1);
      assert.deepEqual(detail.data.resumeOptions.versions[0].reusableSteps, ["s1"]);
      assert.equal(detail.data.resumeOptions.versions[0].defaultFromStepId, "s2");

      // Resume via API
      const reqId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const resumed = await h.call("POST", `/teleharness/api/temporal/runs/${srcId}/resume`, {
        body: { requestId: reqId },
      });
      assert.equal(resumed.status, 202);
      const newId = resumed.data.workflowId;
      assert.notEqual(newId, srcId);
      assert.equal(resumed.data.resumedFrom, srcId);
      assert.equal(resumed.data.fromStepId, "s2");
      assert.deepEqual(resumed.data.reusedSteps, ["s1"]);

      // Inherited folder + ONLY s1 result and chat (NOT s2!)
      assert.equal(h.artifacts.runFolder(newId), "20261123-0700-src1");
      assert.deepEqual(h.artifacts.steps(newId), ["s1"]);
      assert.deepEqual(h.artifacts.chats(newId), { s1: "chat-s1" });

      // Idempotent retry with same requestId returns same workflowId
      const retry = await h.call("POST", `/teleharness/api/temporal/runs/${srcId}/resume`, {
        body: { requestId: reqId },
      });
      assert.equal(retry.status, 202);
      assert.equal(retry.data.workflowId, newId);

      // Conflicting requestId with different fromStepId returns 409
      const conflict = await h.call("POST", `/teleharness/api/temporal/runs/${srcId}/resume`, {
        body: { requestId: reqId, fromStepId: "s1" },
      });
      assert.equal(conflict.status, 409);

      // prepareRun returns safe seed without prompts/secrets
      const plan = await prepareRun({
        db: h.runtime.db,
        getUser: async (id) => h.users[id],
        store: h.store,
        dirAllowed: () => true,
        engineAllowed: () => true,
      }, { launchRef: newId, workflowId: newId, runId: "22222222-2222-4222-8222-222222222222" });
      assert.deepEqual(plan.seed, {
        steps: { s1: "completed" },
        conditions: {},
        files: {},
        pr: {},
        reworks: {},
      });
      assert.ok(!JSON.stringify(plan).includes("SECRET_PROMPT_1"));

      // GET resumed run exposes resumedFrom, resumeFromStep, resumedSteps
      h.workflowStates.set(newId, { status: "RUNNING", state: { steps: { s1: "completed", s2: "running", s3: "waiting" } } });
      const newDetail = await h.call("GET", `/teleharness/api/temporal/runs/${newId}`);
      assert.equal(newDetail.status, 200);
      assert.equal(newDetail.data.resumedFrom, srcId);
      assert.equal(newDetail.data.resumeFromStep, "s2");
      assert.deepEqual(newDetail.data.resumedSteps, ["s1"]);
      assert.equal(newDetail.data.resumeOptions, undefined, "RUNNING run has no resumeOptions");
    } finally {
      h.close();
    }
  });

  it("resumes on latest published version v2 while reusing compatible v1 steps", async () => {
    const h = makeHarness();
    try {
      const def1 = makeDraft(h.dir, [
        { id: "s1", name: "Шаг 1", type: "timer", dependsOn: [], seconds: 5 },
        { id: "s2", name: "Шаг 2", type: "timer", dependsOn: ["s1"], seconds: 5 },
      ], []);
      const rec = h.store.create("admin", def1);
      const p1 = h.store.publish("admin", rec.id, rec.revision);
      const def2 = makeDraft(h.dir, [
        { id: "s1", name: "Шаг 1", type: "timer", dependsOn: [], seconds: 5 },
        { id: "s2", name: "Шаг 2 исправленный", type: "timer", dependsOn: ["s1"], seconds: 10 },
        { id: "s3", name: "Новый шаг 3", type: "timer", dependsOn: ["s2"], seconds: 5 },
      ], []);
      const saved = h.store.save("admin", rec.id, p1.revision, def2);
      h.store.publish("admin", rec.id, saved.revision);

      const started = await h.call("POST", "/teleharness/api/temporal/runs", {
        body: { definitionId: rec.id, version: 1, requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", inputs: {} },
      });
      const srcId = started.data.workflowId;
      h.workflowStates.set(srcId, { status: "FAILED", state: { steps: { s1: "completed", s2: "running" } } });

      // Default resume picks latest version (v2)
      const resumed = await h.call("POST", `/teleharness/api/temporal/runs/${srcId}/resume`, {
        body: { requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      });
      assert.equal(resumed.status, 202);
      assert.equal(resumed.data.version, 2);
      assert.equal(resumed.data.fromStepId, "s2");
      assert.deepEqual(resumed.data.reusedSteps, ["s1"]);

      // Explicit original version (v1) also works
      const resumedV1 = await h.call("POST", `/teleharness/api/temporal/runs/${srcId}/resume`, {
        body: { requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", version: 1, fromStepId: "s1" },
      });
      assert.equal(resumedV1.status, 202);
      assert.equal(resumedV1.data.version, 1);
      assert.equal(resumedV1.data.fromStepId, "s1");
      assert.deepEqual(resumedV1.data.reusedSteps, []);
    } finally {
      h.close();
    }
  });

  it("enforces 409 on RUNNING, 404 on foreign owner and deleted pipe, 403 on disallowed engine", async () => {
    const h = makeHarness();
    try {
      const def1 = makeDraft(h.dir, [
        { id: "s1", name: "Шаг 1", type: "timer", dependsOn: [], seconds: 5 },
      ], []);
      const rec = h.store.create("admin", def1);
      const p1 = h.store.publish("admin", rec.id, rec.revision);
      const started = await h.call("POST", "/teleharness/api/temporal/runs", {
        body: { definitionId: rec.id, version: 1, requestId: "11111111-2222-4333-8444-555555555555", inputs: {} },
      });
      const srcId = started.data.workflowId;

      // 1. RUNNING -> 409
      h.workflowStates.set(srcId, { status: "RUNNING", state: { steps: { s1: "running" } } });
      const rRunning = await h.call("POST", `/teleharness/api/temporal/runs/${srcId}/resume`, {
        body: { requestId: "22222222-2222-4333-8444-555555555555" },
      });
      assert.equal(rRunning.status, 409);

      // 2. Foreign user -> 404
      h.workflowStates.set(srcId, { status: "FAILED", state: { steps: { s1: "running" } } });
      const rForeign = await h.call("POST", `/teleharness/api/temporal/runs/${srcId}/resume`, {
        user: h.users.alice,
        body: { requestId: "33333333-2222-4333-8444-555555555555" },
      });
      assert.equal(rForeign.status, 404);

      // 3. Disallowed engine on target v2 -> 403
      const def2 = makeDraft(h.dir, [
        { id: "s1", name: "Шаг 1", type: "timer", dependsOn: [], seconds: 5 },
        { id: "s2", name: "Шаг 2", type: "model", dependsOn: ["s1"], engine: "opencode", model: "glm", instruction: "hi", timeoutSeconds: 60, maxAttempts: 1 },
      ], []);
      const s2 = h.store.save("admin", rec.id, p1.revision, def2);
      h.store.publish("admin", rec.id, s2.revision);
      h.setAllowedEngines(new Set(["claude"]));
      const rEngine = await h.call("POST", `/teleharness/api/temporal/runs/${srcId}/resume`, {
        body: { requestId: "44444444-2222-4333-8444-555555555555", version: 2 },
      });
      assert.equal(rEngine.status, 403);

      // 4. Deleted pipe -> 404
      h.setAllowedEngines(new Set(["claude", "opencode"]));
      h.store.remove("admin", rec.id);
      const rDeleted = await h.call("POST", `/teleharness/api/temporal/runs/${srcId}/resume`, {
        body: { requestId: "55555555-2222-4333-8444-555555555555", version: 1 },
      });
      assert.equal(rDeleted.status, 404);
    } finally {
      h.close();
    }
  });
});
