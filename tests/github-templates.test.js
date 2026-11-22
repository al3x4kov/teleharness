// FEAT-20.3 (1.15): шаблоны фоновых агентов — валидные черновики, лицо без
// секретов, маршрут /teleharness/api/temporal/templates с «Готовностью».
import { test } from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES, templateFace, templateDraft, templateById } from "../shared/temporal-templates.js";
import { validDraftShape, validateDefinition } from "../shared/temporal-definition.js";
import { triggerRoutes } from "../routes/temporal-triggers.js";

test("FEAT-20.3 1.15: каждый шаблон — валидный черновик пайпа (после подстановки папки) и известный триггер", () => {
  assert.ok(TEMPLATES.length >= 3, "три шаблона design §9");
  for (const t of TEMPLATES) {
    const draft = templateDraft(t, "/proj/hello");
    assert.ok(validDraftShape(draft), `${t.id}: форма черновика`);
    const verdict = validateDefinition(draft);
    assert.deepEqual(verdict, { valid: true, errors: [] }, `${t.id}: ${JSON.stringify(verdict.errors)}`);
    const pr = t.pipe.steps.find((s) => s.type === "pull_request");
    assert.ok(pr?.source, `${t.id}: PR-шаг ссылается на модельный`);
    if (t.trigger) {
      assert.ok(Array.isArray(t.trigger.kinds) && t.trigger.kinds.length > 0, `${t.id}: виды событий`);
      assert.ok(t.trigger.limits?.perHour > 0, `${t.id}: лимиты`);
    } else {
      assert.match(t.schedule?.cron ?? "", /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/, `${t.id}: cron расписания`);
    }
  }
  assert.equal(templateById("nope"), null);
});

test("FEAT-20.3 1.15: лицо шаблона — без инструкций и папки, с потребностями готовности", () => {
  for (const t of TEMPLATES) {
    const face = JSON.stringify(templateFace(t));
    assert.ok(!face.includes("instruction") && !face.includes("directory"), `${t.id}: лицо без инструкций`);
    assert.ok(t.needs.includes("github"), `${t.id}: нуждается в подключении GitHub`);
  }
});

test("FEAT-20.3 1.15: GET /teleharness/api/temporal/templates — готовность по движкам и подключению", async () => {
  const routes = triggerRoutes({
    sendJson: (res, status, body) => { routes.__body = { status, body }; },
    readJsonBody: async () => ({}),
    store: { list: () => [] },
    connections: { get: () => ({ login: "octo", status: "ok" }) },
    engineModels: () => ({ claude: ["claude-haiku-4-5", "claude-opus-5-5"], codex: [] }),
    pipelinesEnabled: () => true,
  });
  const route = routes.find((r) => r.method === "GET" && r.path === "/teleharness/api/temporal/templates");
  assert.ok(route, "маршрут шаблонов объявлен");
  routes.__body = null;
  await route.handler({ res: {}, user: { id: "u1" }, url: new URL("http://x/teleharness/api/temporal/templates") });
  const { status, body } = routes.__body;
  assert.equal(status, 200);
  assert.equal(body.templates.length, TEMPLATES.length);
  assert.deepEqual(body.readiness.github, { ok: true, login: "octo" });
  const task = body.templates.find((t) => t.id === "task-to-pr");
  assert.deepEqual(task.ready, { ok: true, missing: [] }, "claude-модель из каталога — готов");
  assert.deepEqual(body.templates.find((t) => t.id === "nightly-deps").schedule, { cron: "0 3 * * 1-5" });
  // нет подключения GitHub и модели — не готов с перечнем причин
  const poor = triggerRoutes({
    sendJson: (res, status, body) => { poor.__body = { status, body }; },
    readJsonBody: async () => ({}),
    store: { list: () => [] },
    connections: { get: () => null },
    engineModels: () => ({}),
    pipelinesEnabled: () => false,
  });
  const poorRoute = poor.find((r) => r.method === "GET" && r.path === "/teleharness/api/temporal/templates");
  poor.__body = null;
  await poorRoute.handler({ res: {}, user: { id: "u2" }, url: new URL("http://x/teleharness/api/temporal/templates") });
  const ready = poor.__body.body.templates.map((t) => t.ready);
  assert.ok(ready.every((r) => !r.ok), "без GitHub и движков ничего не готово");
  assert.ok(ready[0].missing.includes("github"), "причина — подключение");
  assert.ok(ready[0].missing.some((m) => m.startsWith("claude:")), "причина — модель");
});

test("FEAT-20.3 1.18: POST /templates/:id/readiness — blocking-проблемы: подключение, модель, папка, репозиторий, Codex тенанта", async () => {
  const mk = ({ connections = { get: () => ({ login: "octo", status: "ok" }) }, engineModels = () => ({ claude: ["claude-haiku-4-5", "claude-opus-5-5"] }), dirAllowed = () => true } = {}) => {
    const out = {};
    const routes = triggerRoutes({
      sendJson: (res, status, body) => { out.body = { status, body }; },
      readJsonBody: async () => out.requested ?? {},
      store: { list: () => [] }, connections, engineModels, dirAllowed, pipelinesEnabled: () => true,
    });
    return { routes, out };
  };
  const call = async (rig, user, id, body) => {
    rig.out.requested = body ?? {};
    const route = rig.routes.find((r) => r.method === "POST" && typeof r.path.test === "function" && r.path.test(`/teleharness/api/temporal/templates/${id}/readiness`));
    await route.handler({ res: {}, user, url: new URL(`http://x/teleharness/api/temporal/templates/${id}/readiness`), match: [id, id] });
    return rig.out.body.body;
  };
  const rig = mk();
  const ok = await call(rig, { id: "u1", role: "admin" }, "task-to-pr", { directory: "/proj", repo: "octo/hello" });
  assert.deepEqual(ok, { ready: true, problems: [] });
  const poor = await call(rig, { id: "u1", role: "admin" }, "task-to-pr", {});
  const fields = poor.problems.map((p) => p.field);
  assert.deepEqual(fields.sort(), ["directory", "repo"]);
  assert.ok(poor.problems.every((p) => p.blocking === true), "все проблемы blocking");
  const tenant = await call(rig, { id: "u1", role: "tenant" }, "task-to-pr", { directory: "/proj", repo: "octo/hello", engine: "codex" });
  assert.ok(tenant.problems.some((p) => p.field === "model" && p.message.includes("Codex")), "текстовый Codex блокирует шаблон тенанта");
  const stranger = mk({ dirAllowed: () => false });
  const denied = await call(stranger, { id: "u2", role: "tenant" }, "fix-ci", { directory: "/chuzhaya", repo: "octo/hello" });
  assert.ok(denied.problems.some((p) => p.field === "directory"), "чужая папка — blocking");
  const missing = mk();
  const res404 = missing.routes.find((r) => r.method === "POST" && typeof r.path.test === "function" && r.path.test("/teleharness/api/temporal/templates/nope/readiness"));
  missing.out.body = null;
  await res404.handler({ res: {}, user: { id: "u1", role: "admin" }, url: new URL("http://x/z"), match: ["nope", "nope"] });
  assert.equal(missing.out.body?.status, 404, "неизвестный шаблон — 404");
});

test("FEAT-20.3 2.5: предел попыток «Починить CI» — одно число для сервера и экрана запуска", async () => {
  const { CI_ATTEMPTS_MAX: shared } = await import("../shared/temporal-templates.js");
  const { CI_ATTEMPTS_MAX } = await import("../lib/github/triggers.js");
  assert.equal(shared, CI_ATTEMPTS_MAX, "сервер берёт предел из shared");
  assert.equal(shared, 2, "кр. 15: не более 2 попыток");
});
