// ..компонентные тесты UI исправлений Temporal и фоновых агентов.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch, fetchCalls } from "./helpers/dom.mjs";

let ui, h;
before(async () => {
  ui = await loadUI({
    RunDetail: "src/components/temporal/RunDetail.jsx",
    RunsList: "src/components/temporal/RunsList.jsx",
    StartRun: "src/components/temporal/StartRun.jsx",
    Schedules: "src/components/temporal/Schedules.jsx",
    TriggersList: "src/components/temporal/TriggersList.jsx",
    TriggerForm: "src/components/temporal/TriggerForm.jsx",
    TriggerCard: "src/components/temporal/TriggerCard.jsx",
    CommandsList: "src/components/temporal/CommandsList.jsx",
    ExternalWorkflowsList: "src/components/temporal/ExternalWorkflowsList.jsx",
    ExternalWorkflowDetail: "src/components/temporal/ExternalWorkflowDetail.jsx",
    DefinitionEditor: "src/components/temporal/DefinitionEditor.jsx",
    Sheet: "src/components/temporal/ui.jsx#Sheet",
    formatDurationStr: "src/components/temporal/ui.jsx#formatDurationStr",
  });
  h = createHarness(ui);
  ui.store.me.value = { id: "admin", role: "admin" };
});

afterEach(() => {
  h.cleanup();
  installFetch();
  ui.store.me.value = { id: "admin", role: "admin" };
  if (typeof location !== "undefined") location.hash = "";
});

// ---------- & RunDetail, StartRun, RunsList ----------

test("& RunDetail скрывает путь хоста от тенанта, показывает step.command и исправленный текст PR", async () => {
  ui.store.me.value = { id: "t1", role: "tenant" };
  const payload = {
    workflowId: "wf-rd-1",
    runId: "r1",
    status: "RUNNING",
    name: "Деплой",
    version: 1,
    definitionId: "p1",
    source: "manual",
    startTime: new Date().toISOString(),
    steps: [
      { id: "c1", name: "Скрипт", type: "command", command: "my-cmd-id" },
      { id: "pr1", name: "PR", type: "pull_request" },
    ],
    resultSteps: [],
    state: { steps: { c1: "completed", pr1: "waiting" }, pending: ["pr1"], paused: false },
    commandMeta: {
      c1: {
        commandId: "my-cmd-id",
        state: "completed",
        exitCode: 0,
        durationMs: 500,
        files: [{ path: "/etc/shadow.txt", allowed: false }],
      },
    },
    summary: { kind: "wait" },
  };
  installFetch([{ path: "/teleharness/api/temporal/runs/wf-rd-1", reply: () => payload }]);
  const { root } = h.mount(ui.RunDetail, { workflowId: "wf-rd-1" });
  await h.waitFor(() => $(root, '[data-testid="command-step-c1"]'));
  assert.ok(root.textContent.includes("my-cmd-id"), "в таймлайне отображается step.command");
  assert.ok(root.textContent.includes("shadow.txt (вне разрешённых папок)"));
  assert.ok(!root.textContent.includes("/etc/shadow.txt"), "полный путь хоста не утекает тенанту");
  assert.ok(root.textContent.includes("чтобы PR был открыт"), "опечатка исправлена");
});

test("StartRun отправляет false для нетронутого обязательного boolean-входа", async () => {
  const bodies = [];
  const rec = {
    id: "p1",
    draft: { name: "BoolPipe", directory: "/work", inputs: [], steps: [] },
    versions: [{
      version: 1,
      definition: {
        name: "BoolPipe",
        directory: "/work",
        inputs: [{ name: "confirm", type: "boolean", required: true }],
        steps: [{ id: "t1", type: "timer", name: "Ждать", seconds: 5, dependsOn: [] }],
      },
    }],
  };
  installFetch([
    { path: "/teleharness/api/temporal/definitions", reply: () => [{ id: "p1", name: "BoolPipe", latestVersion: 1 }] },
    { path: "/teleharness/api/temporal/definitions/p1", reply: () => rec },
    { path: "/teleharness/api/temporal/commands", reply: () => ({ items: [] }) },
    { method: "POST", path: "/teleharness/api/temporal/runs", reply: (c) => { bodies.push(c.body); return { workflowId: "wf-b1", version: 1 }; } },
  ]);
  const { root } = h.mount(ui.StartRun, {
    definitionId: "p1",
    initialVersion: 1,
    capabilities: { engines: [], subscriptionModels: {}, ledger: "none", pipelineAvailable: true },
  });
  await h.waitFor(() => $(root, '[data-action="start"]'));
  h.click($(root, '[data-action="start"]'));
  await h.waitFor(() => bodies.length === 1);
  assert.deepEqual(bodies[0].inputs, { confirm: false });
});

test("RunsList включает статус slot в группу «Идут»", async () => {
  installFetch([
    {
      path: "/teleharness/api/temporal/runs",
      reply: () => [
        {
          workflowId: "wf-slot-1",
          name: "Слотовый запуск",
          version: 1,
          status: "RUNNING",
          startTime: new Date().toISOString(),
          summary: { kind: "slot", current: "Скрипт", done: 0, total: 1 },
        },
      ],
    },
  ]);
  const { root } = h.mount(ui.RunsList, {});
  await h.waitFor(() => root.textContent.includes("Слотовый запуск"));
  h.click(byText(root, "button", "Идут"));
  await h.flush();
  assert.ok(root.textContent.includes("Слотовый запуск"), "запуск с kind=slot остаётся в фильтре «Идут»");
});

// ---------- Schedules delete + no leading dot, TriggersList create 2+, TriggerForm tenant/nightly-deps/rollback, TriggerCard ----------

test("Schedules отображает кнопку «Удалить» (включая pipeDeleted) без ведущей точки перед timezone", async () => {
  let deleted = [];
  const items = [
    {
      id: "sched-1",
      definitionId: "def-gone",
      name: "Старый пайп",
      version: 1,
      cron: "0 9 * * *",
      timezone: "Europe/Moscow",
      paused: true,
      pipeDeleted: true,
      blocked: "Пайп удалён — возобновить расписание нельзя",
    },
  ];
  installFetch([
    { method: "GET", path: "/teleharness/api/temporal/schedules", reply: () => items.filter((x) => !deleted.includes(x.id)) },
    { method: "GET", path: "/teleharness/api/temporal/runs", reply: () => [] },
    { method: "DELETE", path: "/teleharness/api/temporal/schedules/sched-1", reply: () => { deleted.push("sched-1"); return { ok: true, id: "sched-1" }; } },
  ]);
  const { root } = h.mount(ui.Schedules, { capabilities: { schedulesAvailable: true } });
  await h.waitFor(() => root.textContent.includes("Старый пайп"));
  const card = $(root, ".t-card");
  assert.ok(!card.textContent.includes("· Europe/Moscow"), "перед timezone нет ведущей точки");
  assert.ok(card.textContent.includes("Europe/Moscow"));
  const delBtn = $(root, '[data-action="delete-schedule"]');
  assert.ok(delBtn, "кнопка удаления расписания присутствует даже для pipeDeleted");
  h.click(delBtn);
  await h.waitFor(() => $(document.body, '[data-action="confirm-delete-schedule"]'));
  h.click($(document.body, '[data-action="confirm-delete-schedule"]'));
  await h.waitFor(() => deleted.includes("sched-1"));
  assert.equal(deleted.length, 1);
});

test("TriggersList показывает «＋ Новый триггер» при непустом списке и открывает шторку шаблонов", async () => {
  installFetch([
    {
      path: "/teleharness/api/temporal/triggers",
      reply: () => [{ id: "tr-1", repo: "org/a", kinds: ["issue_labeled"], enabled: true, delivery: "poll", filters: {} }],
    },
    {
      path: "/teleharness/api/temporal/templates",
      reply: () => ({
        templates: [
          { id: "task-to-pr", name: "Задача в PR", description: "По метке" },
          { id: "nightly-deps", name: "Ночное обновление", description: "Каждую ночь" },
        ],
      }),
    },
  ]);
  const { root } = h.mount(ui.TriggersList, { capabilities: { triggersAvailable: true, triggers: { available: true } } });
  await h.waitFor(() => root.textContent.includes("org/a"));
  const addBtn = $(root, '[data-action="new-trigger"]');
  assert.ok(addBtn, "кнопка «＋ Новый триггер» видна при наличии триггеров");
  h.click(addBtn);
  await h.waitFor(() => byText(document.body, ".t-sheet", "Ночное обновление"));
  assert.ok(byText(document.body, ".t-sheet", "Ночное обновление"));
  assert.ok(byText(document.body, ".t-sheet", "Свой триггер для пайпа"));
});

test("TriggerForm для тенанта выбирает opencode; nightly-deps шлёт skip/3600 и откатывает пайп при ошибке", async () => {
  ui.store.me.value = { id: "t1", role: "tenant" };
  location.hash = "#/temporal/triggers/new?tpl=nightly-deps";
  const calls = { readiness: [], schedule: [], deleted: [] };
  let failSchedule = true;
  installFetch([
    { method: "GET", path: "/teleharness/api/temporal/projects", reply: () => ({ projects: [{ directory: "/srv/app", name: "app" }], default: "/srv/app" }) },
    { method: "POST", path: "/teleharness/api/temporal/templates/nightly-deps/readiness", reply: (c) => { calls.readiness.push(c.body); return { ready: true, problems: [] }; } },
    { method: "POST", path: "/teleharness/api/temporal/definitions", reply: () => ({ id: "pipe-orphan", revision: 1 }) },
    { method: "POST", path: "/teleharness/api/temporal/definitions/pipe-orphan/publish", reply: () => ({ id: "pipe-orphan", versions: [{ version: 1 }] }) },
    {
      method: "POST",
      path: "/teleharness/api/temporal/schedules",
      reply: (c) => {
        calls.schedule.push(c.body);
        if (failSchedule) return { status: 500, body: { error: "Temporal error" } };
        return { status: 201, body: { id: "sch-1" } };
      },
    },
    { method: "DELETE", path: "/teleharness/api/temporal/definitions/pipe-orphan", reply: () => { calls.deleted.push("pipe-orphan"); return { ok: true }; } },
  ]);
  const { root } = h.mount(ui.TriggerForm, {
    capabilities: {
      engines: ["opencode"],
      subscriptionModels: { claude: ["claude-opus-4-6"], opencode: ["glm-5"] },
      triggersAvailable: true,
      triggers: { available: true },
    },
  });
  await h.waitFor(() => $(root, 'input[placeholder="owner/repo"]'));
  h.typeInto($(root, 'input[placeholder="owner/repo"]'), "org/app");
  await new Promise((r) => setTimeout(r, 650));
  h.act(() => {});
  await h.waitFor(() => calls.readiness.length > 0);
  assert.equal(calls.readiness.at(-1).engine, "opencode", "для тенанта выбирается opencode, не claude");
  assert.equal(calls.readiness.at(-1).model, "glm-5");

  // При падении создания расписания пайп откатывается (DELETE)
  h.click(byText(root, "button", "Создать"));
  await h.waitFor(() => calls.deleted.includes("pipe-orphan"));
  assert.equal(calls.schedule[0].overlap, "skip");
  assert.equal(calls.schedule[0].catchupSeconds, 3600);
});

test("TriggerCard показывает pipe.draft.name, ротацию секрета, удаление и баннер ошибки журнала", async () => {
  let deleted = false;
  installFetch([
    {
      method: "GET",
      path: "/teleharness/api/temporal/triggers/tr-9",
      reply: () => ({ id: "tr-9", revision: 3, definitionId: "def-9", repo: "org/app", kinds: ["issue_labeled"], filters: {}, enabled: true, delivery: "webhook", hookId: 55 }),
    },
    { method: "GET", path: "/teleharness/api/temporal/definitions/def-9", reply: () => ({ id: "def-9", draft: { name: "Авто-ревью" }, versions: [] }) },
    { method: "GET", path: "/teleharness/api/temporal/triggers/tr-9/journal", reply: () => ({ status: 500, body: { error: "БД недоступна" } }) },
    { method: "POST", path: "/teleharness/api/temporal/triggers/tr-9/webhook/rotate", reply: () => ({ id: "tr-9", revision: 4, definitionId: "def-9", repo: "org/app", kinds: ["issue_labeled"], filters: {}, enabled: true, delivery: "webhook", hookId: 55, secret: "NEW_SECRET_XYZ", note: "Секрет заменён" }) },
    { method: "DELETE", path: "/teleharness/api/temporal/triggers/tr-9", reply: () => { deleted = true; return { ok: true }; } },
  ]);
  const { root } = h.mount(ui.TriggerCard, { id: "tr-9" });
  await h.waitFor(() => root.textContent.includes("Авто-ревью"));
  assert.ok(root.textContent.includes("Авто-ревью"), "имя пайпа берётся из pipe.draft.name");
  await h.waitFor(() => root.textContent.includes("Не удалось загрузить журнал"));

  // Ротация секрета
  h.click(byText(root, "button", "Ротировать секрет"));
  await h.waitFor(() => $(document.body, '[data-action="confirm-rotate"]'));
  h.click($(document.body, '[data-action="confirm-rotate"]'));
  await h.waitFor(() => $(document.body, '[data-testid="rotated-secret"]'));
  assert.equal($(document.body, '[data-testid="rotated-secret"]').textContent, "NEW_SECRET_XYZ");
  h.click(byText(document.body, "button", "Готово"));
  await h.flush();

  // Удаление триггера
  h.click(byText(root, "button", "Удалить…"));
  await h.waitFor(() => $(document.body, '[data-action="confirm-delete-trigger"]'));
  h.click($(document.body, '[data-action="confirm-delete-trigger"]'));
  await h.waitFor(() => deleted === true);
});

// ---------- ExternalWorkflows h1 + duration, CommandsList placeholder, Sheet Escape, DefinitionEditor ----------

test("formatDurationStr, ExternalWorkflows h1/длительность и CommandsList placeholder", async () => {
  assert.equal(ui.formatDurationStr("120.027871682s"), "2 мин");
  assert.equal(ui.formatDurationStr("65.4s"), "1 мин 5 с");
  assert.equal(ui.formatDurationStr("0.45s"), "< 1 с");
  assert.equal(ui.formatDurationStr("3665s"), "1 ч 1 мин");

  installFetch([
    {
      path: "/teleharness/api/admin/temporal-workflows",
      reply: () => ({
        address: "127.0.0.1:7233",
        namespace: "default",
        items: [{
          workflowId: "ext-1", runId: "r1", workflowType: "SyncWf", taskQueue: "q",
          status: "COMPLETED", startTime: "2026-11-26T10:00:00Z", executionDuration: "120.027871682s", historyLength: 5,
        }],
      }),
    },
  ]);
  const listMount = h.mount(ui.ExternalWorkflowsList, {});
  await h.waitFor(() => listMount.root.textContent.includes("ext-1"));
  assert.equal($(listMount.root, "h1").textContent, "Внешние workflow");
  assert.ok(listMount.root.textContent.includes("2 мин"));
  assert.ok(!listMount.root.textContent.includes("120.027871682s"));
  h.cleanup();

  installFetch([
    {
      path: "/teleharness/api/admin/temporal-commands",
      reply: () => ({
        status: "ok",
        items: [{ id: "cmd-1", name: "Demo", kind: "exec", exec: { file: "/srv/demo.sh", argv: [] }, params: [] }],
        errors: [],
        allowedRoots: ["/srv"],
      }),
    },
  ]);
  const cmdMount = h.mount(ui.CommandsList, {});
  await h.waitFor(() => $(cmdMount.root, 'input[type="search"]'));
  assert.equal($(cmdMount.root, 'input[type="search"]').placeholder, "Найти по названию, ID или пути…");
});

test("Sheet Escape вызывает актуальный onClose после ререндера", async () => {
  let called = null;
  const first = () => { called = "first"; };
  const second = () => { called = "second"; };
  const { rerender } = h.mount(ui.Sheet, { title: "Окно", onClose: first });
  rerender({ title: "Окно", onClose: second });
  h.act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(called, "second");
});

test("DefinitionEditor не портит timeoutSeconds при очистке поля и сериализует save перед publish", async () => {
  let resolveSave;
  const saveCalls = [];
  const publishCalls = [];
  const rec = {
    id: "pipe-ed-1",
    revision: 1,
    draft: {
      name: "Пайп",
      directory: "/work",
      inputs: [],
      steps: [{ id: "c1", type: "command", name: "Шаг", command: "demo", args: {}, timeoutSeconds: 300, maxAttempts: 1, successWhen: "exit0", dependsOn: [] }],
    },
    versions: [],
  };
  installFetch([
    { path: "/teleharness/api/temporal/projects", reply: () => ({ projects: [{ directory: "/work", name: "work" }], default: "/work" }) },
    { path: "/teleharness/api/temporal/commands", reply: () => ({ items: [{ id: "demo", name: "Demo", kind: "exec", timeoutSeconds: 300 }] }) },
    {
      method: "PUT",
      path: "/teleharness/api/temporal/definitions/pipe-ed-1",
      reply: (c) => {
        saveCalls.push(c.body);
        return new Promise((r) => {
          resolveSave = () => r({ ...rec, revision: 2, draft: c.body.draft });
        });
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/temporal/definitions/pipe-ed-1/publish",
      reply: (c) => {
        publishCalls.push(c.body);
        return { ...rec, revision: 3, draft: saveCalls.at(-1).draft, versions: [{ version: 1, definition: saveCalls.at(-1).draft }] };
      },
    },
  ]);

  const { root } = h.mount(ui.DefinitionEditor, { record: rec, engines: [], subscriptionModels: {}, ledger: "none", pipelineAvailable: true });
  await h.waitFor(() => $(root, ".t-stepc-head"));
  // Открываем шаг команды и очищаем поле таймаута — не должно сброситься в 0
  h.click($(root, ".t-stepc-head"));
  await h.flush();
  const numInput = $(root, '[aria-label="Таймаут шага команды"]');
  h.typeInto(numInput, "");
  assert.equal(numInput.value, "");
  h.fire(numInput, "focusout");
  await h.flush();
  assert.equal(numInput.value, "300", "при потере фокуса пустое поле восстанавливает прошлое валидное значение");

  // Вносим правку, дожидаемся начала autosave (1.2 с) и жмём «Опубликовать» пока save в полёте
  h.typeInto($(root, '[aria-label="Название пайпа"]'), "Пайп обновлённый");
  await new Promise((r) => setTimeout(r, 1300));
  h.act(() => {});
  assert.equal(saveCalls.length, 1, "autosave запущен и находится в полёте");

  h.click($(root, '[data-action="publish"]'));
  await h.flush();
  // Пока первый save не завершился, publish ещё не отправлен и второй параллельный save не ушёл
  assert.equal(saveCalls.length, 1, "второй параллельный save не запускается");
  assert.equal(publishCalls.length, 0, "publish ждёт завершения активного save");

  resolveSave();
  await h.waitFor(() => publishCalls.length === 1);
  assert.equal(publishCalls[0].revision, 2, "publish отправлен с актуальной ревизией после autosave");
});
