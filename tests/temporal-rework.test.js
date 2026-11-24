// @suite: unit
// TASK-20.34 п.1 / FEAT-20.1 кр. 14: шаблон plan-approve-code-review (plan.md),
// валидация reworkTarget/maxReworks (≤ 3), проекция, запись rework-<step>.md,
// подмешивание замечаний в modelBridge и python-воркер.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLAN_APPROVE_CODE_REVIEW_TEMPLATE } from "../shared/temporal-templates.js";
import { validDraftShape, validateDefinition } from "../shared/temporal-definition.js";
import { projectPlan } from "../lib/temporal/prepare-bridge.js";
import { temporalRoutes } from "../routes/temporal.js";
import { modelBridge } from "../lib/temporal/model-bridge.js";

const pythonBin = ["python3", "python"].find((b) => { try { execFileSync(b, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } }) ?? null;
const hasPython = Boolean(pythonBin);

test("FEAT-20.1 кр. 14: шаблон plan-approve-code-review валиден и содержит plan.md, worktree и rework ≤ 3", () => {
  const draft = {
    name: PLAN_APPROVE_CODE_REVIEW_TEMPLATE.name,
    directory: "/proj/demo",
    inputs: PLAN_APPROVE_CODE_REVIEW_TEMPLATE.inputs,
    steps: PLAN_APPROVE_CODE_REVIEW_TEMPLATE.steps,
  };
  assert.ok(validDraftShape(draft));
  assert.deepEqual(validateDefinition(draft), { valid: true, errors: [] });
  assert.equal(draft.steps.find((s) => s.id === "plan_file")?.filename, "plan.md");
  assert.equal(draft.steps.find((s) => s.id === "code")?.worktree, true);
  assert.equal(draft.steps.find((s) => s.id === "review")?.reworkTarget, "code");
  assert.equal(draft.steps.find((s) => s.id === "review")?.maxReworks, 3);
  const plan = projectPlan(draft);
  const rev = plan.steps.find((s) => s.id === "review");
  assert.deepEqual({ reworkTarget: rev.reworkTarget, maxReworks: rev.maxReworks }, { reworkTarget: "code", maxReworks: 3 });
});

test("FEAT-20.1 кр. 14: validateDefinition отклоняет неверный reworkTarget и maxReworks > 3", () => {
  const base = {
    name: "Test",
    directory: "/proj/demo",
    inputs: [],
    steps: [
      { id: "t1", name: "Таймер", type: "timer", seconds: 10, dependsOn: [] },
      { id: "code", name: "Код", type: "model", engine: "claude", model: "claude-opus-5-5", instruction: "ok", timeoutSeconds: 60, maxAttempts: 1, dependsOn: ["t1"] },
      { id: "review", name: "Ревью", type: "approval", reworkTarget: "t1", maxReworks: 4, dependsOn: ["code"] },
    ],
  };
  const v = validateDefinition(base);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.message.includes("Доработка")));
  assert.ok(v.errors.some((e) => e.message.includes("Лимит доработок")));
});

test("FEAT-20.1 кр. 14: POST /actions rework пишет rework-code.md и modelBridge добавляет замечания в инструкцию", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "teleharness-rework-"));
  try {
    const wfId = "11111111-1111-4111-8111-111111111111";
    const runId = "22222222-2222-4222-8222-222222222222";
    const def = {
      name: "Plan Code Review",
      directory: tmp,
      inputs: [{ name: "task", type: "string", required: true }],
      steps: PLAN_APPROVE_CODE_REVIEW_TEMPLATE.steps,
    };
    const record = { id: "def-1", slug: "plan-code-review", versions: [{ version: 1, definition: def }] };
    const applied = [];
    let out = null;
    const routes = temporalRoutes({
      sendJson: (_res, status, body) => { out = { status, body }; },
      readJsonBody: async () => out.reqBody,
      store: { get: () => record },
      dirAllowed: () => true,
      engineAllowed: () => true,
      lookupRun: async () => ({ workflowId: wfId, definitionId: "def-1", version: 1, inputs: JSON.stringify({ task: "Фича" }) }),
      results: { runFolder: () => "run-001", steps: () => [], read: async () => "План шагов" },
      applyAction: async (owner, id, cmd) => { applied.push({ owner, id, cmd }); return { accepted: true, action: cmd.action }; },
    });
    const actRoute = routes.find((r) => r.method === "POST" && r.path instanceof RegExp && r.path.test(`/teleharness/api/temporal/runs/${wfId}/actions`));
    assert.ok(actRoute);

    // Пустые замечания -> 400
    out = { reqBody: { action: "rework", actionId: "33333333-3333-4333-8333-333333333333", runId, stepId: "review", generation: runId, note: "   " } };
    await actRoute.handler({ req: {}, res: {}, user: { id: "u1", role: "admin" }, match: [wfId, wfId] });
    assert.equal(out.status, 400);

    // Шаг без reworkTarget -> 409
    out = { reqBody: { action: "rework", actionId: "33333333-3333-4333-8333-333333333334", runId, stepId: "approve_plan", generation: runId, note: "Поправь" } };
    await actRoute.handler({ req: {}, res: {}, user: { id: "u1", role: "admin" }, match: [wfId, wfId] });
    assert.equal(out.status, 409);

    // Валидный rework -> пишет rework-code.md и вызывает applyAction
    out = { reqBody: { action: "rework", actionId: "33333333-3333-4333-8333-333333333335", runId, stepId: "review", generation: runId, note: "Добавь проверку на null" } };
    await actRoute.handler({ req: {}, res: {}, user: { id: "u1", role: "admin" }, match: [wfId, wfId] });
    assert.equal(out.status, 200);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].cmd.action, "rework");

    // Проверяем modelBridge: при повторном запуске code он подхватывает rework-code.md
    let seenInstruction = "";
    const invoke = modelBridge({
      lookupStart: async () => ({ owner: "u1", definitionId: "def-1", version: 1, inputs: JSON.stringify({ task: "Фича" }) }),
      getUser: async () => ({ id: "u1", role: "admin", disabled: false }),
      store: { get: () => record },
      dirAllowed: () => true,
      engineAllowed: () => true,
      results: { runFolder: () => "run-001", read: async () => "План шагов" },
      adapters: {
        claude: {
          subscriptionOnly: true, textOnly: true, models: ["claude-opus-5-5"],
          execute: async ({ instruction }) => { seenInstruction = instruction; return { receipt: "rcpt_1" }; },
        },
      },
    });
    const res = await invoke("execute", { workflowId: wfId, stepId: "code" });
    assert.equal(res.receipt, "rcpt_1");
    assert.match(seenInstruction, /Замечания с ревью \(доработка\):/);
    assert.match(seenInstruction, /Добавь проверку на null/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("failed applyAction does not leave rework-<target>.md on disk", async () => {
  const { existsSync } = await import("node:fs");
  const { workspaceOf } = await import("../lib/temporal/workspace.js");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "teleharness-rework-fail-"));
  try {
    const wfId = "11111111-1111-4111-8111-111111111119";
    const runId = "22222222-2222-4222-8222-222222222229";
    const def = {
      name: "Plan Code Review",
      directory: tmp,
      inputs: [{ name: "task", type: "string", required: true }],
      steps: PLAN_APPROVE_CODE_REVIEW_TEMPLATE.steps,
    };
    const record = { id: "def-fail", slug: "plan-code-review", versions: [{ version: 1, definition: def }] };
    const routes = temporalRoutes({
      sendJson: () => {},
      readJsonBody: async () => ({ action: "rework", actionId: "33333333-3333-4333-8333-333333333339", runId, stepId: "review", generation: runId, note: "Rollback" }),
      store: { get: () => record },
      dirAllowed: () => true,
      engineAllowed: () => true,
      lookupRun: async () => ({ workflowId: wfId, definitionId: "def-fail", version: 1, inputs: "{}" }),
      results: { runFolder: () => "run-fail", steps: () => [] },
      applyAction: async () => { throw new Error("Temporal unavailable"); },
    });
    const actRoute = routes.find((r) => r.method === "POST" && r.path instanceof RegExp && r.path.test(`/teleharness/api/temporal/runs/${wfId}/actions`));
    await assert.rejects(() => actRoute.handler({ req: {}, res: {}, user: { id: "u1", role: "admin" }, match: [wfId, wfId] }), /Temporal unavailable/);
    const reworkFile = path.join(workspaceOf(tmp, "plan-code-review"), "runs", "run-fail", "rework-code.md");
    assert.equal(existsSync(reworkFile), false, "rework-code.md must not be created when applyAction fails");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("FEAT-20.1 кр. 14: python-воркер — цикл rework до 3 раз, 4-я попытка отклоняется rework_limit_reached", { skip: !hasPython && "нужен python3" }, () => {
  const out = execFileSync(pythonBin, ["tests/temporal-worker/pipeline_rework_unit.py"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
  assert.match(out, /ALL OK/, out);
});
