// ..автотесты по итогам dogfood Temporal и фоновых агентов.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { dispatchRoute } from "../routes/router.js";
import { temporalRoutes } from "../routes/temporal.js";
import { scheduleRoutes } from "../routes/temporal-schedules.js";
import { adminRoutes } from "../routes/admin.js";
import { triggerRoutes } from "../routes/temporal-triggers.js";
import { scheduleService } from "../lib/temporal/schedules.js";
import { ExternalWorkflowsClient } from "../lib/temporal/external-workflows.js";
import { listenModelBridge, modelBridge } from "../lib/temporal/model-bridge.js";
import { prStepRunner } from "../lib/temporal/pr-step.js";
import { TEMPLATES, templateDraft } from "../shared/temporal-templates.js";
import { validateDefinition } from "../shared/temporal-definition.js";
import { DefinitionError } from "../lib/temporal/definitions.js";
import { triggerService } from "../lib/github/triggers.js";

const sendJson = (res, status, body) => Object.assign(res, { status, body });

// ---------- RBAC commandAllowed на resume / resumeOptions / schedules + скрытие пути ----------

test("POST /runs/:id/resume и GET /runs/:id resumeOptions проверяют commandAllowed", async () => {
  const def = {
    name: "Пайп с командой",
    directory: "/work",
    inputs: [],
    steps: [
      { id: "c1", type: "command", name: "Скрипт", command: "admin-script", args: {}, timeoutSeconds: 60, maxAttempts: 1, dependsOn: [] },
      { id: "t1", type: "timer", name: "Пауза", seconds: 10, dependsOn: ["c1"] },
    ],
  };
  const record = { id: "def-1", slug: "pipe-cmd", versions: [{ version: 1, definition: def }] };
  const ref = {
    workflowId: "wf-cmd-resume-1",
    owner: "alice",
    definitionId: "def-1",
    version: 1,
    runFolder: "2026-11-26-abc",
    workspace: "/work",
    inputs: {},
    steps: def.steps,
  };
  let allowed = false;
  const rawMeta = {
    c1: {
      commandId: "admin-script",
      state: "completed",
      files: [
        { path: "/work/report.md", allowed: true },
        { path: "/etc/secret/creds.txt", allowed: false },
      ],
    },
  };
  const deps = {
    store: { get: () => record },
    lookupRun: async () => ref,
    describeRun: async () => ({
      workflowId: ref.workflowId,
      runId: "r-1",
      status: "FAILED",
      state: { steps: { c1: "completed", t1: "failed" }, pending: [], paused: false },
    }),
    resumePipeline: async () => ({ workflowId: "wf-new", version: 1 }),
    commandMeta: () => rawMeta,
    commandCatalog: { get: (id) => (id === "admin-script" ? { id: "admin-script", allow: { roles: allowed ? ["admin", "tenant"] : ["admin"], users: [] }, tenantSafe: allowed } : null) },
    dirAllowed: () => true,
    engineAllowed: () => true,
    readJsonBody: (r) => r.body,
    sendJson,
  };
  const routes = temporalRoutes(deps);

  // 1) GET /runs/:id как tenant: resumeOptions блокирует v1, а путь !f.allowed редуцирован до basename
  const getTenant = {};
  await dispatchRoute(routes, {
    req: { method: "GET" },
    res: getTenant,
    url: new URL("http://localhost/teleharness/api/temporal/runs/wf-cmd-resume-1"),
    user: { id: "alice", role: "tenant" },
  }, deps);
  assert.equal(getTenant.status, 200);
  const v1Opt = getTenant.body.resumeOptions.versions.find((v) => v.version === 1);
  assert.equal(v1Opt.available, false, "версия с отозванной командой недоступна в resumeOptions");
  assert.match(v1Opt.unavailableReason, /admin-script|команд/i);
  const files = getTenant.body.commandMeta.c1.files;
  assert.equal(files[0].path, "/work/report.md");
  assert.equal(files[1].path, "creds.txt", "сырой путь хоста не утекает тенанту");
  assert.ok(!files[1].path.includes("/etc/secret"));

  // 2) GET /runs/:id как admin: полный путь виден админу
  const getAdmin = {};
  await dispatchRoute(routes, {
    req: { method: "GET" },
    res: getAdmin,
    url: new URL("http://localhost/teleharness/api/temporal/runs/wf-cmd-resume-1"),
    user: { id: "alice", role: "admin" },
  }, deps);
  assert.equal(getAdmin.status, 200);
  assert.equal(getAdmin.body.commandMeta.c1.files[1].path, "/etc/secret/creds.txt");

  // 3) POST /runs/:id/resume как tenant при отозванной команде → 403
  const postResume = {};
  await dispatchRoute(routes, {
    req: { method: "POST", body: { version: 1, fromStepId: "t1", requestId: "4ae8da84-a0f5-47c9-9151-c008247510e1" } },
    res: postResume,
    url: new URL("http://localhost/teleharness/api/temporal/runs/wf-cmd-resume-1/resume"),
    user: { id: "alice", role: "tenant" },
  }, deps);
  assert.equal(postResume.status, 403);
  assert.match(postResume.body.error, /admin-script|команд/i);
});

test("schedules проверяют commandAllowed при POST, GET (blocked) и POST /:id/resume", async () => {
  const entry = {
    id: "4ae8da84-a0f5-47c9-9151-c008247510e1",
    definitionId: "def-cmd",
    version: 1,
    cron: "0 9 * * *",
    timezone: "UTC",
    overlap: "skip",
    catchupSeconds: 3600,
  };
  const createBody = {
    requestId: "5ae8da84-a0f5-47c9-9151-c008247510e2",
    definitionId: "def-cmd",
    version: 1,
    cron: "0 9 * * *",
    timezone: "UTC",
    overlap: "skip",
    catchupSeconds: 3600,
  };
  let cmdAllowed = false;
  const deps = {
    schedules: {
      create: async () => entry,
      get: () => entry,
      list: () => [entry],
      describe: async (x) => ({ ...x, paused: false }),
      setPaused: async () => entry,
    },
    store: {
      get: () => ({
        versions: [{
          version: 1,
          definition: {
            name: "Ночной скрипт",
            directory: "/work",
            inputs: [],
            steps: [{ id: "c1", type: "command", name: "Run", command: "deploy-job", args: {}, timeoutSeconds: 60, maxAttempts: 1, dependsOn: [] }],
          },
        }],
      }),
    },
    commandCatalog: { get: (id) => (id === "deploy-job" ? { id: "deploy-job", allow: { roles: cmdAllowed ? ["admin", "tenant"] : ["admin"], users: [] }, tenantSafe: cmdAllowed } : null) },
    dirAllowed: () => true,
    engineAllowed: () => true,
    readJsonBody: (r) => r.body,
    sendJson,
  };
  const call = async (method, suffix = "", body = createBody) => {
    const res = {};
    await dispatchRoute(scheduleRoutes(deps), {
      req: { method, body },
      res,
      url: new URL("http://localhost/teleharness/api/temporal/schedules" + suffix),
      user: { id: "alice", role: "tenant" },
    }, deps);
    return res;
  };

  assert.equal((await call("POST")).status, 403);
  assert.equal((await call("POST", "/" + entry.id + "/resume", {})).status, 403);
  const listed = await call("GET");
  assert.equal(listed.status, 200);
  assert.match(listed.body[0].blocked, /deploy-job|команд/i);

  cmdAllowed = true;
  assert.equal((await call("POST")).status, 201);
});

// ---------- reload response, RUNNING external workflow failure, Unix socket cascade cancel ----------

test("POST /teleharness/api/admin/temporal-commands/reload возвращает полный ответ каталога", async () => {
  const catalogItems = [{ id: "demo", name: "Demo", kind: "exec" }];
  const deps = {
    commandCatalog: {
      reload: () => ({ ok: true, status: "ok", items: catalogItems, errors: [] }),
      listAdmin: () => ({ status: "ok", items: catalogItems, errors: [], allowedRoots: ["/srv/scripts"] }),
    },
    auditCommand: () => {},
    sendJson,
    apiError: (res, err) => sendJson(res, 500, { error: String(err) }),
    readJsonBody: (r) => r.body,
  };
  const res = {};
  await dispatchRoute(adminRoutes(deps), {
    req: { method: "POST" },
    res,
    url: new URL("http://localhost/teleharness/api/admin/temporal-commands/reload"),
    user: { id: "admin", role: "admin" },
    admin: true,
  }, deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.count, 1);
  assert.deepEqual(res.body.items, catalogItems);
  assert.deepEqual(res.body.allowedRoots, ["/srv/scripts"]);
});

test("ExternalWorkflowsClient.describeWorkflow не ставит failure для RUNNING workflow после Reset", async () => {
  const client = new ExternalWorkflowsClient({
    cli: "temporal",
    execute: async (_cli, args) => {
      if (args[1] === "describe") {
        return {
          ok: true,
          stdout: JSON.stringify({
            workflowExecutionInfo: {
              execution: { workflowId: "wf-reset", runId: "run-new" },
              type: { name: "DogfoodWorkflow" },
              status: "WORKFLOW_EXECUTION_STATUS_RUNNING",
              taskQueue: "dogfood-q",
              startTime: "2026-11-26T10:00:00Z",
              historyLength: "5",
            },
          }),
          stderr: "",
        };
      }
      // История сброшенного RUNNING workflow может содержать resetReason или failure старой активности
      return {
        ok: true,
        stdout: JSON.stringify({
          events: [
            {
              eventId: "1",
              eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
              workflowExecutionStartedEventAttributes: { workflowType: { name: "DogfoodWorkflow" } },
            },
            {
              eventId: "4",
              eventType: "EVENT_TYPE_WORKFLOW_TASK_FAILED",
              workflowTaskFailedEventAttributes: { failure: { message: "Old transient failure" } },
            },
          ],
        }),
        stderr: "",
      };
    },
  });
  const running = await client.describeWorkflow({ workflowId: "wf-reset" });
  assert.equal(running.workflow.status, "RUNNING");
  assert.equal(running.failure, null, "у RUNNING workflow не должно быть верхнеуровневого failure");

  // А у FAILED workflow failure по-прежнему извлекается
  const failedClient = new ExternalWorkflowsClient({
    cli: "temporal",
    execute: async (_cli, args) => {
      if (args[1] === "describe") {
        return {
          ok: true,
          stdout: JSON.stringify({
            workflowExecutionInfo: {
              execution: { workflowId: "wf-fail", runId: "run-f" },
              type: { name: "DogfoodWorkflow" },
              status: "WORKFLOW_EXECUTION_STATUS_FAILED",
              taskQueue: "dogfood-q",
            },
          }),
          stderr: "",
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify({
          events: [
            {
              eventId: "5",
              eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED",
              workflowExecutionFailedEventAttributes: { failure: { message: "Boom" } },
            },
          ],
        }),
        stderr: "",
      };
    },
  });
  const failed = await failedClient.describeWorkflow({ workflowId: "wf-fail" });
  assert.equal(failed.workflow.status, "FAILED");
  assert.equal(failed.failure?.message, "Boom");
});

test("model-bridge немедленно прерывает AbortSignal при закрытии Unix-сокета клиентом", { skip: process.platform === "win32" }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "teleharness-mb-cancel-"));
  fs.chmodSync(tmpDir, 0o700);
  const sockPath = path.join(tmpDir, "bridge.sock");
  const wfId = "4ae8da84-a0f5-47c9-9151-c008247510e1";
  let abortedAt = null;
  let startedResolve;
  const started = new Promise((r) => { startedResolve = r; });

  const invoke = modelBridge({
    lookupStart: async () => ({ workflowId: wfId, owner: "admin", definitionId: "d1", version: 1, inputs: "{}" }),
    getUser: async () => ({ id: "admin", role: "admin" }),
    store: {
      get: () => ({
        versions: [{
          version: 1,
          definition: {
            name: "CancelTest",
            directory: tmpDir,
            inputs: [],
            steps: [{ id: "c1", type: "command", name: "Slow", command: "slow-cmd", args: {}, timeoutSeconds: 120, maxAttempts: 1, dependsOn: [] }],
          },
        }],
      }),
    },
    dirAllowed: () => true,
    engineAllowed: () => true,
    commandStep: {
      runStep: ({ signal }) => new Promise((resolve) => {
        startedResolve();
        signal.addEventListener("abort", () => {
          abortedAt = Date.now();
          resolve({ state: "failed", error: "Отменено", nonRetryable: true });
        }, { once: true });
      }),
    },
  });
  const server = await listenModelBridge(sockPath, invoke);

  try {
    const req = http.request({
      socketPath: sockPath,
      path: "/step",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-teleharness-deadline-ms": String(Date.now() + 60_000),
      },
    });
    req.on("error", () => {});
    req.end(JSON.stringify({ workflowId: wfId, stepId: "c1" }));
    await started;
    const t0 = Date.now();
    req.destroy();
    // Ждём срабатывания abort (должно быть < 500 мс)
    const deadline = Date.now() + 1500;
    while (abortedAt === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(abortedAt !== null, "AbortSignal должен сработать при обрыве Unix-сокета");
    assert.ok(abortedAt - t0 < 500, `AbortSignal сработал слишком поздно: ${abortedAt - t0}ms`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------- DELETE schedule, nightly-deps template + step.repo, triggers Claude ban & queuedCount ----------

test("scheduleService.remove() удаляет в Temporal и SQLite и терпит NotFound; DELETE route работает для pipeDeleted", async () => {
  const calls = [];
  let failNotFound = false;
  const service = scheduleService(":memory:", {
    execute: async (_cli, args) => {
      calls.push(args);
      if ((args[1] === "delete" || args[1] === "describe") && failNotFound) {
        const err = new Error("schedule not found");
        err.stderr = "rpc error: code = NotFound desc = schedule not found";
        throw err;
      }
      return { stdout: JSON.stringify({ schedule: { state: { paused: false } }, info: { futureActionTimes: [] } }) };
    },
  });
  const s1 = await service.create("alice", {
    definitionId: "d1", version: 1, cron: "0 9 * * *", timezone: "UTC",
    overlap: "skip", catchupSeconds: 3600, requestId: "4ae8da84-a0f5-47c9-9151-c008247510e1",
  });
  const s2 = await service.create("alice", {
    definitionId: "d2", version: 1, cron: "0 10 * * *", timezone: "UTC",
    overlap: "skip", catchupSeconds: 3600, requestId: "5ae8da84-a0f5-47c9-9151-c008247510e2",
  });

  // Активное удаление
  await service.remove("alice", s1.id);
  assert.throws(() => service.get("alice", s1.id), { status: 404 });
  assert.ok(calls.some((c) => c[1] === "delete" && c.includes("teleharness-schedule-" + s1.id)));

  // Чтение и удаление, когда в Temporal уже NotFound (сирота не ломает весь GET /schedules 503-й ошибкой)
  failNotFound = true;
  const orphanDesc = await service.describe(s2);
  assert.equal(orphanDesc.missingInTemporal, true);
  assert.equal(orphanDesc.paused, true);
  await service.remove("alice", s2.id);
  assert.throws(() => service.get("alice", s2.id), { status: 404 });
  failNotFound = false;

  // DELETE маршрут работает даже для расписания удалённого пайпа и не даёт удалить чужое
  const s3 = await service.create("alice", {
    definitionId: "deleted-def", version: 1, cron: "0 11 * * *", timezone: "UTC",
    overlap: "skip", catchupSeconds: 3600, requestId: "6ae8da84-a0f5-47c9-9151-c008247510e3",
  });
  const deps = {
    schedules: service,
    store: { get: () => { throw new DefinitionError(404, "Пайп удалён"); } },
    dirAllowed: () => true,
    engineAllowed: () => true,
    readJsonBody: (r) => r.body,
    sendJson,
  };
  const bobDel = {};
  await dispatchRoute(scheduleRoutes(deps), {
    req: { method: "DELETE" },
    res: bobDel,
    url: new URL("http://localhost/teleharness/api/temporal/schedules/" + s3.id),
    user: { id: "bob", role: "tenant" },
  }, deps);
  assert.equal(bobDel.status, 404);

  const aliceDel = {};
  await dispatchRoute(scheduleRoutes(deps), {
    req: { method: "DELETE" },
    res: aliceDel,
    url: new URL("http://localhost/teleharness/api/temporal/schedules/" + s3.id),
    user: { id: "alice", role: "tenant" },
  }, deps);
  assert.equal(aliceDel.status, 200);
  assert.equal(aliceDel.body.ok, true);
  assert.throws(() => service.get("alice", s3.id), { status: 404 });
});

test("nightly-deps templateDraft поддерживает engine/model/repo и проходит валидацию; openPullRequest берёт step.repo", async () => {
  const tpl = TEMPLATES.find((t) => t.id === "nightly-deps");
  assert.ok(tpl);
  const draft = templateDraft(tpl, "/srv/project", { engine: "opencode", model: "glm-5", repo: "org/app" });
  const repoInput = draft.inputs.find((i) => i.name === "repo");
  assert.equal(repoInput.required, false, "repo вход у nightly-deps необязателен для расписания");
  const modelStep = draft.steps.find((s) => s.type === "model");
  assert.equal(modelStep.engine, "opencode");
  assert.equal(modelStep.model, "glm-5");
  const prStep = draft.steps.find((s) => s.type === "pull_request");
  assert.equal(prStep.repo, "org/app");
  const v = validateDefinition(draft);
  assert.equal(v.valid, true, JSON.stringify(v.errors));

  // prStepRunner использует fallback step.repo, когда inputs.repo не передан (запуск по расписанию)
  let worktreeCalled = false;
  const runPr = prStepRunner({
    prepareWorktree: async () => { worktreeCalled = true; return { state: "removed" }; },
  });
  await assert.rejects(
    runPr({ user: { id: "alice", role: "admin" }, workflowId: "wf-sched-1", workspace: "/srv/project", inputs: {}, repo: "org/app" }),
    (e) => e.code === "worktree",
    "при переданном step.repo проходит проверку no_repo и доходит до prepareWorktree",
  );
  assert.equal(worktreeCalled, true);
  // Без inputs.repo и без step.repo падает с code=no_repo
  await assert.rejects(
    runPr({ user: { id: "alice", role: "admin" }, workflowId: "wf-sched-2", workspace: "/srv/project", inputs: {} }),
    (e) => e.code === "no_repo",
  );
});

test("triggers enable/replay запрещают Claude тенанту (403), enable/disable возвращают queuedCount и stormAt", async () => {
  const box = { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") };
  const store = triggerService(":memory:", { secrets: box });
  const created = store.create("alice", {
    definitionId: "def-claude",
    repo: "org/repo",
    kinds: ["issue_labeled"],
    filters: {},
    delivery: "poll",
    pollSeconds: 120,
    limits: { perHour: 6, queue: 10 },
  });
  // Записываем replayable-запись в журнал
  store.record({
    triggerId: created.id,
    eventKey: "ev-1",
    kind: "issue_labeled",
    repo: "org/repo",
    number: 42,
    actor: "alice",
    decision: "trigger_disabled",
    reason: "выключен",
    eventJson: JSON.stringify({ kind: "issue_labeled", repo: "org/repo", number: 42, actor: "alice", title: "Fix" }),
  });
  const entry = store.journal("alice", created.id)[0];

  let isClaude = true;
  const deps = {
    store,
    readJsonBody: (r) => r.body,
    sendJson,
    usesClaude: () => isClaude,
    defs: { get: () => ({ versions: [{ version: 1, definition: { name: "P", directory: "/w", steps: [{ id: "s1", type: "model", engine: "claude" }] } }] }) },
    connectionToken: () => "tok",
    connections: { get: () => ({ status: "ok", login: "alice" }) },
    pipelinesEnabled: () => true,
    launch: async () => ({ workflowId: "wf-r1" }),
    runs: { cancel: async () => {} },
    dirAllowed: () => true,
  };
  const routes = triggerRoutes(deps);

  // 1) Tenant disable → 200 с queuedCount и stormAt
  const disRes = {};
  await dispatchRoute(routes, {
    req: { method: "POST", body: { mode: "keep" } },
    res: disRes,
    url: new URL(`http://localhost/teleharness/api/temporal/triggers/${created.id}/disable`),
    user: { id: "alice", role: "tenant" },
  }, deps);
  assert.equal(disRes.status, 200);
  assert.equal(typeof disRes.body.queuedCount, "number");
  assert.ok("stormAt" in disRes.body);

  // 2) Tenant enable Claude-пайпа → 403
  const enTenant = {};
  await dispatchRoute(routes, {
    req: { method: "POST", body: {} },
    res: enTenant,
    url: new URL(`http://localhost/teleharness/api/temporal/triggers/${created.id}/enable`),
    user: { id: "alice", role: "tenant" },
  }, deps);
  assert.equal(enTenant.status, 403);

  // 3) Tenant replay Claude-пайпа → 403
  const repTenant = {};
  await dispatchRoute(routes, {
    req: { method: "POST", body: {} },
    res: repTenant,
    url: new URL(`http://localhost/teleharness/api/temporal/triggers/${created.id}/journal/${entry.id}/replay`),
    user: { id: "alice", role: "tenant" },
  }, deps);
  assert.equal(repTenant.status, 403);

  // 4) Non-Claude enable → 200 с queuedCount и stormAt
  isClaude = false;
  const enOk = {};
  await dispatchRoute(routes, {
    req: { method: "POST", body: {} },
    res: enOk,
    url: new URL(`http://localhost/teleharness/api/temporal/triggers/${created.id}/enable`),
    user: { id: "alice", role: "tenant" },
  }, deps);
  assert.equal(enOk.status, 200);
  assert.equal(typeof enOk.body.queuedCount, "number");
  assert.ok("stormAt" in enOk.body);
});

// ---------- workflowId с подчёркиванием ----------

test("маршруты /teleharness/api/temporal/runs/:workflowId принимают символ '_'", async () => {
  const ref = { workflowId: "wf_with_underscore_1", owner: "alice", definitionId: "d1", version: 1, steps: [] };
  const deps = {
    store: { get: () => ({ id: "d1", versions: [{ version: 1, definition: { name: "P", directory: "/w", inputs: [], steps: [] } }] }) },
    lookupRun: async (_o, id) => (id === ref.workflowId ? ref : null),
    describeRun: async () => ({ workflowId: ref.workflowId, runId: "r1", status: "COMPLETED", state: { steps: {}, pending: [] } }),
    dirAllowed: () => true,
    engineAllowed: () => true,
    sendJson,
  };
  const res = {};
  await dispatchRoute(temporalRoutes(deps), {
    req: { method: "GET" },
    res,
    url: new URL("http://localhost/teleharness/api/temporal/runs/wf_with_underscore_1"),
    user: { id: "alice", role: "tenant" },
  }, deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.workflowId, "wf_with_underscore_1");
});
