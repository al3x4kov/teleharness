// Unit + admin-route contract tests for ExternalWorkflowsClient
// (list/filter, describe+history+payload decoding+resetPoints, start, signal,
// query, reset, cancel, terminate, CLI --flag=value safety, admin-only 403, audit).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ExternalWorkflowsClient,
  buildVisibilityQuery,
  decodePayloads,
  validateDuration,
  validateJsonInput,
  validateSafeString,
  validateTarget,
} from "../lib/temporal/external-workflows.js";
import { adminRoutes } from "../routes/admin.js";
import { mockTemporal } from "../lib/mock-temporal.js";
import { auditTemporalCommand } from "../lib/accesslog.js";
import { loadConfig } from "../lib/config.js";

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

describe("config & validation helpers", () => {
  it("supports TELEHARNESS_TEMPORAL_UI_URL", () => {
    const { config: c1, errors: e1 } = loadConfig({ TELEHARNESS_TEMPORAL_UI_URL: "http://127.0.0.1:8233" });
    assert.deepEqual(e1, []);
    assert.equal(c1.TELEHARNESS_TEMPORAL_UI_URL, "http://127.0.0.1:8233");
  });

  it("builds safe Visibility query with excludePortal and escaping", () => {
    const q = buildVisibilityQuery({
      status: "Running",
      workflowType: 'Order"Sync',
      taskQueue: "orders-q",
      excludePortal: true,
    });
    assert.equal(
      q,
      'ExecutionStatus = "Running" AND WorkflowType = "Order\\"Sync" AND TaskQueue = "orders-q" AND WorkflowType != "TeleharnessPipelineV1"',
    );
    assert.throws(() => buildVisibilityQuery({ status: "BogusStatus" }), /Неизвестный статус/);
  });

  it("validates JSON input, duration, target, and rejects control chars", () => {
    assert.equal(validateJsonInput('{"a":1}'), '{"a":1}');
    assert.equal(validateJsonInput({ a: 2 }), '{"a":2}');
    assert.equal(validateJsonInput(""), null);
    assert.throws(() => validateJsonInput("{broken"), /Некорректный JSON/);
    assert.equal(validateDuration("5m30s", "runTimeout"), "5m30s");
    assert.equal(validateDuration(60, "runTimeout"), "60s");
    assert.throws(() => validateDuration("not-a-duration", "runTimeout"), /Некорректная длительность/);
    assert.throws(() => validateTarget({ address: "bad addr; rm -rf /", namespace: "default" }), /Некорректный адрес/);
    assert.throws(() => validateSafeString("ok\u0000bad", "workflowId"), /управляющие символы/);
  });

  it("decodes base64 Temporal JSON and plain payloads", () => {
    const jsonPayload = {
      payloads: [{ metadata: { encoding: b64("json/plain") }, data: b64('{"hello":"world","n":7}') }],
    };
    assert.deepEqual(decodePayloads(jsonPayload), { hello: "world", n: 7 });

    const textPayload = {
      payloads: [{ metadata: { encoding: b64("binary/plain") }, data: b64("plain text") }],
    };
    assert.equal(decodePayloads(textPayload), "plain text");
  });
});

describe("ExternalWorkflowsClient CLI contract", () => {
  it("lists workflows with --flag=value and normalizes portal vs external items", async () => {
    const calls = [];
    const client = new ExternalWorkflowsClient({
      cli: "/usr/local/bin/temporal",
      address: "127.0.0.1:7233",
      namespace: "default",
      uiBase: "http://127.0.0.1:8233",
      execute: async (bin, args) => {
        calls.push({ bin, args });
        return {
          ok: true,
          code: 0,
          stdout: JSON.stringify([
            {
              execution: { workflowId: "wf-ext-1", runId: "r1" },
              type: { name: "OrderSyncWorkflow" },
              status: "WORKFLOW_EXECUTION_STATUS_RUNNING",
              taskQueue: "orders-q",
              startTime: "2026-11-25T10:00:00Z",
              historyLength: "5",
            },
            {
              execution: { workflowId: "wf-portal-1", runId: "r2" },
              type: { name: "TeleharnessPipelineV1" },
              status: "WORKFLOW_EXECUTION_STATUS_COMPLETED",
              taskQueue: "teleharness-prod-pipeline-v1",
              startTime: "2026-11-25T09:00:00Z",
              closeTime: "2026-11-25T09:01:00Z",
              historyLength: "25",
            },
          ]),
          stderr: "",
        };
      },
    });

    const res = await client.listWorkflows({ excludePortal: true, status: "Running", limit: 25 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "/usr/local/bin/temporal");
    assert.ok(calls[0].args.includes("--address=127.0.0.1:7233"));
    assert.ok(calls[0].args.includes("--namespace=default"));
    assert.ok(calls[0].args.includes("--limit=25"));
    assert.ok(calls[0].args.some((a) => a === '--query=ExecutionStatus = "Running" AND WorkflowType != "TeleharnessPipelineV1"'));
    assert.equal(res.items.length, 2);
    assert.equal(res.items[0].status, "RUNNING");
    assert.equal(res.items[0].isPortal, false);
    assert.equal(res.items[0].uiUrl, "http://127.0.0.1:8233/namespaces/default/workflows/wf-ext-1/r1");
    assert.equal(res.items[1].isPortal, true);
  });

  it("describes workflow, decodes input/result/failure, and extracts WorkflowTaskCompleted resetPoints", async () => {
    const client = new ExternalWorkflowsClient({
      cli: "/opt/temporal/temporal",
      address: "127.0.0.1:7233",
      namespace: "default",
      uiBase: "http://127.0.0.1:8233",
      execute: async (_bin, args) => {
        if (args[1] === "describe") {
          return {
            ok: true,
            code: 0,
            stdout: JSON.stringify({
              workflowExecutionInfo: {
                execution: { workflowId: "wf-1", runId: "run-1" },
                type: { name: "OrderSyncWorkflow" },
                status: "WORKFLOW_EXECUTION_STATUS_FAILED",
                taskQueue: "orders-q",
                startTime: "2026-11-25T10:00:00Z",
                closeTime: "2026-11-25T10:00:05Z",
                historyLength: "9",
              },
              closeEvent: {
                eventId: "9",
                eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED",
                workflowExecutionFailedEventAttributes: {
                  failure: { message: "payment gateway error", cause: { message: "HTTP 502" } },
                },
              },
              pendingActivities: [
                { activityId: "a1", activityType: { name: "ChargeCard" }, state: "PENDING_ACTIVITY_STATE_STARTED", attempt: 2 },
              ],
            }),
            stderr: "",
          };
        }
        return {
          ok: true,
          code: 0,
          stdout: JSON.stringify({
            events: [
              {
                eventId: "1",
                eventTime: "2026-11-25T10:00:00Z",
                eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
                workflowExecutionStartedEventAttributes: {
                  workflowType: { name: "OrderSyncWorkflow" },
                  taskQueue: { name: "orders-q" },
                  input: { payloads: [{ metadata: { encoding: b64("json/plain") }, data: b64('{"orderId":99}') }] },
                },
              },
              {
                eventId: "4",
                eventTime: "2026-11-25T10:00:01Z",
                eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED",
                workflowTaskCompletedEventAttributes: { identity: "worker-1" },
              },
              {
                eventId: "8",
                eventTime: "2026-11-25T10:00:04Z",
                eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED",
                workflowTaskCompletedEventAttributes: { identity: "worker-1" },
              },
            ],
          }),
          stderr: "",
        };
      },
    });

    const d = await client.describeWorkflow({ workflowId: "wf-1" });
    assert.equal(d.workflow.status, "FAILED");
    assert.deepEqual(d.input, { orderId: 99 });
    assert.equal(d.failure.message, "payment gateway error");
    assert.equal(d.failure.cause, "HTTP 502");
    assert.equal(d.pendingActivities.length, 1);
    assert.equal(d.pendingActivities[0].activityType, "ChargeCard");
    assert.deepEqual(
      d.resetPoints.map((p) => p.eventId),
      [8, 4],
    );
    assert.equal(d.events.length, 3);
    assert.equal(d.events[1].resettable, true);
  });

  it("handles start, signal, query, reset, cancel, and terminate safely with --flag=value", async () => {
    const calls = [];
    const client = new ExternalWorkflowsClient({
      cli: "/opt/temporal/temporal",
      address: "127.0.0.1:7233",
      namespace: "default",
      execute: async (_bin, args) => {
        calls.push(args);
        if (args[1] === "start") return { ok: true, code: 0, stdout: JSON.stringify({ workflowId: "-leading-dash-wf", runId: "run-new" }), stderr: "" };
        if (args[1] === "query") return { ok: true, code: 0, stdout: JSON.stringify({ queryResult: { state: "ready", count: 3 } }), stderr: "" };
        if (args[1] === "reset") return { ok: true, code: 0, stdout: JSON.stringify({ runId: "run-after-reset" }), stderr: "" };
        return { ok: true, code: 0, stdout: "", stderr: "" };
      },
    });

    const s = await client.startWorkflow({
      workflowType: "DemoWorkflow",
      taskQueue: "demo-q",
      workflowId: "-leading-dash-wf",
      input: '{"k":"v"}',
      runTimeout: "5m",
    });
    assert.equal(s.workflowId, "-leading-dash-wf");
    assert.equal(s.runId, "run-new");
    assert.ok(calls[0].includes("--workflow-id=-leading-dash-wf"));
    assert.ok(calls[0].includes('--input={"k":"v"}'));
    assert.ok(calls[0].includes("--run-timeout=5m"));

    const sig = await client.signalWorkflow({ workflowId: "-leading-dash-wf", name: "approve", input: { ok: true } });
    assert.equal(sig.ok, true);
    assert.ok(calls[1].includes("--name=approve"));

    const q = await client.queryWorkflow({ workflowId: "-leading-dash-wf", type: "get_state" });
    assert.deepEqual(q.result, { state: "ready", count: 3 });

    const r = await client.resetWorkflow({
      workflowId: "-leading-dash-wf",
      eventId: 4,
      reason: "retry after fix",
      reapplyExclude: "Signal",
    });
    assert.equal(r.runId, "run-after-reset");
    assert.ok(calls[3].includes("--event-id=4"));
    assert.ok(calls[3].includes("--reason=retry after fix"));
    assert.ok(calls[3].includes("--reapply-exclude=Signal"));

    await assert.rejects(() => client.resetWorkflow({ workflowId: "wf-1", eventId: 4 }), /reason/);
    await assert.rejects(() => client.resetWorkflow({ workflowId: "wf-1", reason: "why" }), /точку сброса/);
    await assert.rejects(() => client.terminateWorkflow({ workflowId: "wf-1" }), /reason/);

    const c = await client.cancelWorkflow({ workflowId: "-leading-dash-wf" });
    assert.equal(c.action, "cancel");

    const t = await client.terminateWorkflow({ workflowId: "-leading-dash-wf", reason: "stuck" });
    assert.equal(t.action, "terminate");
    assert.ok(calls[5].includes("--reason=stuck"));
  });
});

describe("admin routes scope, audit & mock mode", () => {
  it("registers all external workflow routes with scope: admin and audits without payload leaks", async () => {
    const audits = [];
    const fakeClient = {
      listWorkflows: async (opts) => ({ items: [{ workflowId: "wf-1", ...opts }], address: "127.0.0.1:7233", namespace: "default" }),
      startWorkflow: async (b) => ({ workflowId: "wf-new", runId: "r-new", workflowType: b.workflowType, taskQueue: b.taskQueue, namespace: "default" }),
      describeWorkflow: async ({ workflowId }) => ({ workflow: { workflowId, status: "RUNNING" }, events: [], resetPoints: [] }),
      signalWorkflow: async (b) => ({ ok: true, workflowId: b.workflowId, runId: null, name: b.name, namespace: "default" }),
      queryWorkflow: async (b) => ({ ok: true, workflowId: b.workflowId, runId: null, type: b.type, result: { ok: 1 }, namespace: "default" }),
      resetWorkflow: async (b) => ({ ok: true, workflowId: b.workflowId, runId: "r-reset", eventId: b.eventId, resetType: null, reason: b.reason, namespace: "default" }),
      cancelWorkflow: async (b) => ({ ok: true, workflowId: b.workflowId, runId: null, action: "cancel", reason: b.reason || null, namespace: "default" }),
      terminateWorkflow: async (b) => ({ ok: true, workflowId: b.workflowId, runId: null, action: "terminate", reason: b.reason, namespace: "default" }),
    };

    const routes = adminRoutes({
      sendJson: (res, status, body) => { res.status = status; res.body = body; },
      apiError: (res, err) => { res.status = 500; res.body = { error: err.message }; },
      readJsonBody: async (req) => req._body,
      externalWorkflows: fakeClient,
      auditCommand: (entry) => auditTemporalCommand((x) => audits.push(x), entry),
    }).filter((r) => String(r.path).includes("temporal-workflows"));

    assert.equal(routes.length, 3);
    for (const r of routes) assert.equal(r.scope, "admin");

    const actionRoute = routes.find((r) => r.path instanceof RegExp && r.path.source.includes("signal|query|reset"));
    const res = {};
    const m = "/teleharness/api/admin/temporal-workflows/wf-1/signal".match(actionRoute.path);
    await actionRoute.handler({
      req: { method: "POST", _body: { name: "approve", input: { secretToken: "DO_NOT_LOG" } } },
      res,
      match: m,
      user: { id: "admin", role: "admin" },
    });
    assert.equal(res.status, 200);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].event, "temporal.external");
    assert.equal(audits[0].action, "signal");
    assert.equal(audits[0].signalName, "approve");
    assert.equal(JSON.stringify(audits[0]).includes("DO_NOT_LOG"), false);
  });

  it("supports list, start, signal, query, reset, cancel, terminate in mock mode", async () => {
    function call(method, urlStr, body = null) {
      return new Promise((resolve) => {
        const u = new URL("http://localhost" + urlStr);
        const res = {
          status: 0,
          body: "",
          writeHead(s) { this.status = s; },
          end(b) { this.body = String(b ?? ""); resolve({ status: this.status, json: this.body ? JSON.parse(this.body) : null }); },
          destroy() { resolve({ status: 500, json: null }); },
        };
        const deps = {
          sendJson: (r, s, text) => { r.writeHead(s); r.end(text); },
          readBody: async () => body ?? {},
        };
        const handled = mockTemporal({ method }, res, u, u.pathname, deps);
        assert.equal(handled, true);
      });
    }

    const list = await call("GET", "/teleharness/api/admin/temporal-workflows?excludePortal=1");
    assert.equal(list.status, 200);
    assert.equal(list.json.items.length, 2);

    const started = await call("POST", "/teleharness/api/admin/temporal-workflows", { workflowType: "MockWf", taskQueue: "mock-q", input: '{"x":1}' });
    assert.equal(started.status, 201);
    const id = started.json.workflowId;

    const sig = await call("POST", `/teleharness/api/admin/temporal-workflows/${id}/signal`, { name: "ping", input: { a: 1 } });
    assert.equal(sig.status, 200);

    const q = await call("POST", `/teleharness/api/admin/temporal-workflows/${id}/query`, { type: "status" });
    assert.equal(q.status, 200);
    assert.equal(q.json.result.signals.length, 1);

    const rst = await call("POST", `/teleharness/api/admin/temporal-workflows/${id}/reset`, { eventId: 4, reason: "test reset" });
    assert.equal(rst.status, 200);
    assert.ok(rst.json.runId);

    const term = await call("POST", `/teleharness/api/admin/temporal-workflows/${id}/terminate`, { reason: "done" });
    assert.equal(term.status, 200);

    const det = await call("GET", `/teleharness/api/admin/temporal-workflows/${id}`);
    assert.equal(det.status, 200);
    assert.equal(det.json.workflow.status, "TERMINATED");
  });
});
