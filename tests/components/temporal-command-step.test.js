// компонентные тесты шага «Команда», админской вкладки «Команды»,
// превью «Что запустится», LEDGER=none, socketPathError, CommandStepBox и mock-temporal.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch, fetchCalls } from "./helpers/dom.mjs";
import { mockTemporal } from "../../lib/mock-temporal.js";

let ui, h;
before(async () => {
  ui = await loadUI({
    TemporalView: "src/components/views/TemporalView.jsx",
    CommandsList: "src/components/temporal/CommandsList.jsx",
    DefinitionEditor: "src/components/temporal/DefinitionEditor.jsx",
    PipesList: "src/components/temporal/PipesList.jsx",
    RunDetail: "src/components/temporal/RunDetail.jsx",
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

const byText = (root, text, sel = "button,a") =>
  [...root.querySelectorAll(sel)].find((b) => b.textContent.includes(text));
const change = (el, v) =>
  h.act(() => {
    el.value = v;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

const capsBase = {
  definitions: true,
  execution: { available: true, reason: "Исполнение подключено" },
  engines: ["claude"],
  subscriptionModels: { claude: ["claude-sonnet-4-6"] },
  pipelineAvailable: true,
  runListAvailable: true,
  schedulesAvailable: true,
  ledger: "postgres",
  commandsAvailable: true,
  socketPathError: null,
};

const adminCmdExec = {
  id: "build-summary",
  name: "Сводка сборки",
  description: "Собирает агрегированный отчёт",
  kind: "exec",
  timeoutSeconds: 120,
  tenantSafe: true,
  allow: { roles: ["admin", "user"], users: [] },
  exec: { file: "/opt/scripts/summary.sh", argv: ["--period", "{{param.period}}"], env: {} },
  params: [{ name: "period", required: true, pattern: "^[a-z0-9-]+$", description: "Период" }],
};

const adminCmdWf = {
  id: "ext-report",
  name: "Внешний workflow",
  description: "Запускает расписание в отдельном Temporal",
  kind: "temporal-workflow",
  timeoutSeconds: 600,
  allow: { roles: ["admin"], users: [] },
  temporal: { address: "127.0.0.1:7233", namespace: "reports", schedule: "weekly-summary", uiBase: "http://127.0.0.1:8233", cancelChild: true },
  params: [],
};

const userCmdExec = {
  id: "build-summary",
  name: "Сводка сборки",
  description: "Собирает агрегированный отчёт",
  kind: "exec",
  timeoutSeconds: 120,
  params: [{ name: "period", required: true, pattern: "^[a-z0-9-]+$", description: "Период" }],
};

// ——— TemporalView: вкладка «Команды» и socketPathError ———

test("admin видит вкладку «Команды» и баннер socketPathError", async () => {
  installFetch([
    { path: "/teleharness/api/temporal/capabilities", reply: () => ({ ...capsBase, socketPathError: "Путь Unix-сокета длиннее 104 байт" }) },
    { path: "/teleharness/api/temporal/runs", reply: () => [] },
  ]);
  const { root } = h.mount(ui.TemporalView);
  await h.waitFor(() => root.textContent.includes("Путь Unix-сокета"));
  assert($(root, 'a[href="#/temporal/commands"]'), "вкладка «Команды» видна admin");
  assert(root.textContent.includes("Команды"));
});

test("тенант не видит вкладку «Команды» и получает отказ на section=commands без запроса к admin API", async () => {
  ui.store.me.value = { id: "u1", role: "user" };
  installFetch([
    { path: "/teleharness/api/temporal/capabilities", reply: () => capsBase },
    { path: "/teleharness/api/temporal/runs", reply: () => [] },
  ]);
  const { root } = h.mount(ui.TemporalView, { section: "commands" });
  await h.waitFor(() => root.textContent.includes("Доступ только администратору"));
  assert.equal($(root, 'a[href="#/temporal/commands"]'), null, "вкладка скрыта для тенанта");
  assert.equal(fetchCalls.filter((c) => c.path.includes("/admin/temporal-commands")).length, 0);
});

// ——— CommandsList: CRUD, расписания, повреждённый каталог ———

test("CommandsList отображает каталог, фильтрует, создаёт temporal-workflow с загрузкой расписаний и удаляет", async () => {
  let items = [adminCmdExec];
  const created = [];
  const deleted = [];
  installFetch([
    { method: "GET", path: "/teleharness/api/admin/temporal-commands", reply: () => ({ status: "ok", allowedRoots: ["/opt/scripts"], items }) },
    {
      method: "GET",
      path: "/teleharness/api/admin/temporal-commands/schedules",
      reply: () => ({ items: [{ scheduleId: "weekly-summary", workflowType: "WeeklySummary", paused: false }], warning: null }),
    },
    {
      method: "POST",
      path: "/teleharness/api/admin/temporal-commands",
      reply: (req) => {
        const entry = { ...req.body, id: req.body.id || "ext-report" };
        created.push(entry);
        items = [...items, entry];
        return { status: 201, body: { item: entry } };
      },
    },
    {
      method: "DELETE",
      path: "/teleharness/api/admin/temporal-commands/build-summary",
      reply: () => {
        deleted.push("build-summary");
        items = items.filter((c) => c.id !== "build-summary");
        return { ok: true };
      },
    },
  ]);

  const { root } = h.mount(ui.CommandsList);
  await h.waitFor(() => root.textContent.includes("Сводка сборки"));
  assert(root.textContent.includes("/opt/scripts/summary.sh"));

  // Открыть форму создания и переключить на temporal-workflow
  h.click($(root, '[data-action="new-command"]'));
  await h.flush();
  const sheet = document.querySelector(".t-sheet");
  h.click(byText(sheet, "Temporal workflow", "button"));
  await h.flush();
  h.typeInto(sheet.querySelector('[aria-label="Название команды"]'), "Внешний workflow");
  h.typeInto(sheet.querySelector('[aria-label="ID команды"]'), "ext-report");
  // Загрузить расписания из внешнего Temporal
  h.click(byText(sheet, "Загрузить", "button"));
  await h.waitFor(() => sheet.querySelector('[aria-label="Выбрать расписание из Temporal"]'));
  assert.equal(sheet.querySelector('[aria-label="ID расписания"]').value, "weekly-summary");
  const uiInput = sheet.querySelector('[aria-label="URL Temporal UI"]');
  assert(uiInput.maxLength >= 256, `URL Temporal UI maxLength должен быть >= 256, получено ${uiInput.maxLength}`);
  h.typeInto(uiInput, "http://127.0.0.1:8233");

  // Сохранить команду
  h.click(sheet.querySelector('[data-action="save-command"]'));
  await h.waitFor(() => created.length === 1);
  assert.equal(created[0].kind, "temporal-workflow");
  assert.equal(created[0].temporal.schedule, "weekly-summary");
  assert.equal(created[0].temporal.uiBase, "http://127.0.0.1:8233");
  await h.waitFor(() => root.textContent.includes("Внешний workflow"));

  // Фильтр по типу «Temporal workflow» скрывает exec
  h.click(byText(root, "Temporal workflow", "button"));
  await h.flush();
  assert(!root.textContent.includes("Сводка сборки"));
  assert(root.textContent.includes("Внешний workflow"));
  h.click(byText(root, "Все", "button"));
  await h.flush();

  // Удаление через шторку подтверждения
  const firstCard = $(root, '[data-cmd-id="build-summary"]');
  h.click(byText(firstCard, "Удалить", "button"));
  await h.flush();
  assert(document.body.textContent.includes("Удалить команду"));
  h.click(document.querySelector('[data-action="confirm-delete-command"]'));
  await h.waitFor(() => deleted.length === 1);
  await h.waitFor(() => !root.textContent.includes("Сводка сборки"));
});

test("CommandsList показывает баннер при повреждённом каталоге", async () => {
  installFetch([
    {
      path: "/teleharness/api/admin/temporal-commands",
      reply: () => ({ status: "corrupted", error: "JSON каталога повреждён", errors: ["Unexpected token"], items: [] }),
    },
  ]);
  const { root } = h.mount(ui.CommandsList);
  await h.waitFor(() => root.textContent.includes("JSON каталога повреждён"));
  assert(root.textContent.includes("Unexpected token"));
  assert(byText(root, "Перечитать", "button"));
});

// ——— DefinitionEditor: шаг «Команда», превью, права, пустой каталог, LEDGER=none ———

test("DefinitionEditor — превью «Что запустится» для admin vs тенанта, параметры и чипы {{input.*}}", async () => {
  const rec = {
    id: "p1",
    revision: 1,
    draft: {
      name: "Отчёт",
      directory: "/srv/project",
      inputs: [{ name: "range", type: "string", required: true }],
      steps: [
        { id: "c1", type: "command", name: "Собрать", command: "build-summary", args: { period: "" }, timeoutSeconds: 120, maxAttempts: 1, successWhen: "exit0", dependsOn: [] },
      ],
    },
    versions: [],
  };

  // 1) Admin видит файл/argv и кнопку «＋ Новый»
  installFetch([
    { path: "/teleharness/api/temporal/projects", reply: () => ({ projects: [{ directory: "/srv/project", name: "project" }], default: "/srv/project" }) },
    { path: "/teleharness/api/temporal/commands", reply: () => ({ items: [adminCmdExec, adminCmdWf] }) },
  ]);
  const adm = h.mount(ui.DefinitionEditor, { record: rec, engines: ["claude"], subscriptionModels: { claude: ["claude-sonnet-4-6"] } });
  await h.flush();
  h.click($(adm.root, ".t-stepc-head"));
  await h.waitFor(() => adm.root.textContent.includes("Что запустится"));
  assert(adm.root.textContent.includes("/opt/scripts/summary.sh"), "admin видит exec.file в превью");
  assert($(adm.root, '[data-action="quick-new-command"]'), "admin видит быструю кнопку создания команды");

  // Вставка чипа {{input.range}} в параметр period
  h.click(byText(adm.root, "вход «range»", "button"));
  await h.flush();
  assert.equal($(adm.root, '[aria-label="Параметр period"]').value, "{{input.range}}");

  // Добавляем шаг «Артефакт» — шаг «Команда» подхватывается источником
  h.click(byText(adm.root, "Добавить шаг", "button"));
  await h.flush();
  h.click($(adm.root, '[data-type="artifact"]'));
  await h.flush();
  assert(adm.root.textContent.includes("Схема без ошибок"));
  h.cleanup();

  // 2) Тенант видит безопасное описание, НЕ видит путь к файлу и кнопку создания
  ui.store.me.value = { id: "u1", role: "user" };
  installFetch([
    { path: "/teleharness/api/temporal/projects", reply: () => ({ projects: [{ directory: "/srv/project", name: "project" }], default: "/srv/project" }) },
    { path: "/teleharness/api/temporal/commands", reply: () => ({ items: [userCmdExec] }) },
  ]);
  const usr = h.mount(ui.DefinitionEditor, { record: rec, engines: ["claude"], subscriptionModels: { claude: ["claude-sonnet-4-6"] } });
  await h.flush();
  h.click($(usr.root, ".t-stepc-head"));
  await h.waitFor(() => usr.root.textContent.includes("Что запустится"));
  assert(usr.root.textContent.includes("Собирает агрегированный отчёт"));
  assert(!usr.root.textContent.includes("/opt/scripts/summary.sh"), "тенант не видит путь к файлу");
  assert.equal($(usr.root, '[data-action="quick-new-command"]'), null, "тенант не видит кнопку создания команды");
});

test("DefinitionEditor — пустой каталог команд (admin vs тенант)", async () => {
  const rec = {
    id: "p2",
    revision: 1,
    draft: {
      name: "Пустой",
      directory: "/srv/project",
      inputs: [],
      steps: [{ id: "c1", type: "command", name: "Команда", command: "", args: {}, timeoutSeconds: 60, maxAttempts: 1, successWhen: "exit0", dependsOn: [] }],
    },
    versions: [],
  };
  installFetch([
    { path: "/teleharness/api/temporal/projects", reply: () => ({ projects: [{ directory: "/srv/project", name: "project" }], default: "/srv/project" }) },
    { path: "/teleharness/api/temporal/commands", reply: () => ({ items: [] }) },
  ]);
  const adm = h.mount(ui.DefinitionEditor, { record: rec, engines: ["claude"], subscriptionModels: { claude: ["claude-sonnet-4-6"] } });
  await h.flush();
  h.click($(adm.root, ".t-stepc-head"));
  await h.waitFor(() => $(adm.root, '[data-testid="command-empty-catalog"]'));
  assert(adm.root.textContent.includes("Каталог команд пуст"));
  assert($(adm.root, '[data-action="quick-new-command"]'));
  h.cleanup();

  ui.store.me.value = { id: "u1", role: "user" };
  installFetch([
    { path: "/teleharness/api/temporal/projects", reply: () => ({ projects: [{ directory: "/srv/project", name: "project" }], default: "/srv/project" }) },
    { path: "/teleharness/api/temporal/commands", reply: () => ({ items: [] }) },
  ]);
  const usr = h.mount(ui.DefinitionEditor, { record: rec, engines: ["claude"], subscriptionModels: { claude: ["claude-sonnet-4-6"] } });
  await h.flush();
  h.click($(usr.root, ".t-stepc-head"));
  await h.waitFor(() => $(usr.root, '[data-testid="command-empty-catalog"]'));
  assert(usr.root.textContent.includes("Нет доступных команд"));
  assert.equal($(usr.root, '[data-action="quick-new-command"]'), null);
});

test("DefinitionEditor при ledger=none блокирует добавление «Модель» и предупреждает в готовности", async () => {
  const rec = {
    id: "p3",
    revision: 1,
    draft: {
      name: "Локальный",
      directory: "/srv/project",
      inputs: [],
      steps: [{ id: "m1", type: "model", name: "ИИ", engine: "claude", model: "claude-sonnet-4-6", instruction: "Сделай", timeoutSeconds: 300, maxAttempts: 1, dependsOn: [] }],
    },
    versions: [],
  };
  installFetch([
    { path: "/teleharness/api/temporal/projects", reply: () => ({ projects: [{ directory: "/srv/project", name: "project" }], default: "/srv/project" }) },
    { path: "/teleharness/api/temporal/commands", reply: () => ({ items: [adminCmdExec] }) },
  ]);
  const { root } = h.mount(ui.DefinitionEditor, {
    record: rec,
    engines: ["claude"],
    subscriptionModels: { claude: ["claude-sonnet-4-6"] },
    ledger: "none",
  });
  await h.waitFor(() => root.textContent.includes("TELEHARNESS_TEMPORAL_LEDGER=none"));
  h.click(byText(root, "Добавить шаг", "button"));
  await h.flush();
  const modelTile = $(root, '[data-type="model"]');
  assert.equal(modelTile.getAttribute("aria-disabled"), "true", "плитка «Модель» отключена при ledger=none");
  assert($(root, '[data-type="command"]'), "плитка «Команда» доступна при ledger=none");
});

test("PipesList содержит анонимизированный шаблон «Команда → Условие → Артефакт»", async () => {
  installFetch([{ path: "/teleharness/api/temporal/definitions", reply: () => [] }]);
  const { root } = h.mount(ui.PipesList);
  await h.waitFor(() => root.textContent.includes("Команда → Условие → Артефакт"));
  assert(!root.textContent.includes("/Users/"), "нет приватных путей в шаблонах");
});

// ——— RunDetail: CommandStepBox, slot_wait, uncertain ———

test("RunDetail отображает CommandStepBox (код, длительность, Temporal UI, stderr, файлы, stdout + копировать)", async () => {
  const runPayload = {
    workflowId: "wf-cmd-1",
    runId: "r1",
    status: "COMPLETED",
    name: "Отчёт командой",
    version: 1,
    definitionId: "p1",
    source: "manual",
    startTime: new Date().toISOString(),
    closeTime: new Date().toISOString(),
    steps: [
      { id: "c1", name: "Собрать данные", type: "command", commandId: "build-summary" },
      { id: "m1", name: "Суммаризация", type: "model" },
    ],
    resultSteps: ["c1", "m1"],
    state: { steps: { c1: "completed", m1: "completed" }, pending: [], paused: false },
    commandMeta: {
      c1: {
        commandId: "build-summary",
        state: "completed",
        exitCode: 0,
        durationMs: 2500,
        attempt: 1,
        uiUrl: "http://127.0.0.1:8233/namespaces/default/workflows/child-1",
        stderrTail: "warn: minor notice",
        files: [
          { path: "/srv/project/report.md", allowed: true },
          { path: "/etc/outside.txt", allowed: false },
        ],
      },
    },
    summary: { kind: "ok" },
  };
  installFetch([
    { path: "/teleharness/api/temporal/runs/wf-cmd-1", reply: () => runPayload },
    { path: "/teleharness/api/temporal/runs/wf-cmd-1/results/c1", reply: () => ({ text: "Строка вывода команды" }) },
    { path: "/teleharness/api/temporal/runs/wf-cmd-1/results/m1", reply: () => ({ text: "Итоговый ответ модели" }) },
  ]);
  const { root } = h.mount(ui.RunDetail, { workflowId: "wf-cmd-1" });
  await h.waitFor(() => $(root, '[data-testid="command-step-c1"]'));
  const box = $(root, '[data-testid="command-step-c1"]');
  assert(box.textContent.includes("код 0"));
  assert(box.textContent.includes("3 с"));
  assert($(box, 'a[href="http://127.0.0.1:8233/namespaces/default/workflows/child-1"]'));
  assert(box.textContent.includes("warn: minor notice"));
  assert($(box, 'button[title="report.md"]'), "разрешённый файл рендерится как FileCard");
  assert(box.textContent.includes("/etc/outside.txt (только путь)"));

  h.click(byText(box, "Показать stdout", "button"));
  await h.waitFor(() => box.textContent.includes("Строка вывода команды"));
  assert($(box, '[data-action="copy-output"]'), "кнопка «Копировать» отображается при открытом stdout");
});

test("RunDetail отображает slot_wait и uncertain состояния шага команды", async () => {
  // slot_wait
  installFetch([
    {
      path: "/teleharness/api/temporal/runs/wf-slot",
      reply: () => ({
        workflowId: "wf-slot",
        runId: "r2",
        status: "RUNNING",
        name: "Очередь команд",
        version: 1,
        definitionId: "p1",
        source: "manual",
        startTime: new Date().toISOString(),
        steps: [{ id: "c1", name: "Команда", type: "command", commandId: "build-summary" }],
        resultSteps: [],
        state: { generation: "g1", steps: { c1: "slot_wait" }, pending: [], paused: false },
        summary: { kind: "slot" },
      }),
    },
  ]);
  const slotView = h.mount(ui.RunDetail, { workflowId: "wf-slot" });
  await h.waitFor(() => slotView.root.textContent.includes("Шаг ждёт свободного слота команд"));
  assert(slotView.root.textContent.includes("Ждёт слот команды"));
  h.cleanup();

  // uncertain
  installFetch([
    {
      path: "/teleharness/api/temporal/runs/wf-unc",
      reply: () => ({
        workflowId: "wf-unc",
        runId: "r3",
        status: "FAILED",
        name: "Обрыв",
        version: 1,
        definitionId: "p1",
        source: "manual",
        startTime: new Date().toISOString(),
        closeTime: new Date().toISOString(),
        steps: [{ id: "c1", name: "Команда", type: "command", commandId: "build-summary" }],
        resultSteps: [],
        state: { steps: { c1: "running" }, pending: [], paused: false },
        commandMeta: { c1: { commandId: "build-summary", state: "uncertain", stderrTail: "Команда прервана при рестарте" } },
        summary: { kind: "err" },
      }),
    },
  ]);
  const uncView = h.mount(ui.RunDetail, { workflowId: "wf-unc" });
  await h.waitFor(() => uncView.root.textContent.includes("Результат команды неизвестен"));
  assert(uncView.root.textContent.includes("Команда прервана при рестарте"));
});

// ——— Mock Temporal API ———

test("lib/mock-temporal.js обслуживает capabilities, CRUD каталога, расписания, пайп и запуск", async () => {
  const call = (method, pathStr, body = null) =>
    new Promise((resolve) => {
      const url = new URL(pathStr, "http://localhost");
      const res = {
        status: 0,
        body: "",
        writeHead(s) { this.status = s; },
        end(b) { this.body = String(b ?? ""); resolve({ status: this.status, body: this.body ? JSON.parse(this.body) : null }); },
        destroy() { resolve({ status: 500, body: null }); },
      };
      const deps = {
        sendJson: (r, s, text) => { r.writeHead(s); r.end(text); },
        readBody: async () => body ?? {},
      };
      const handled = mockTemporal({ method, url: pathStr }, res, url, url.pathname, deps);
      assert.equal(handled, true, `маршрут ${method} ${pathStr} должен быть обработан`);
    });

  const caps = await call("GET", "/teleharness/api/temporal/capabilities");
  assert.equal(caps.status, 200);
  assert.equal(caps.body.commandsAvailable, true);

  const scheds = await call("GET", "/teleharness/api/admin/temporal-commands/schedules");
  assert.equal(scheds.status, 200);
  assert(scheds.body.items.some((s) => s.scheduleId === "nightly-etl-schedule"));

  const created = await call("POST", "/teleharness/api/admin/temporal-commands", {
    id: "custom-mock",
    name: "Мок-скрипт",
    kind: "exec",
    exec: { file: "/bin/echo", argv: ["ok"] },
  });
  assert.equal(created.status, 201);

  const list = await call("GET", "/teleharness/api/admin/temporal-commands");
  assert(list.body.items.some((c) => c.id === "custom-mock"));

  const del = await call("DELETE", "/teleharness/api/admin/temporal-commands/custom-mock");
  assert.equal(del.status, 200);

  const runRes = await call("GET", "/teleharness/api/temporal/runs/demo-run-done/results/notes");
  assert.equal(runRes.status, 200);
  assert(runRes.body.text.length > 0);
});
