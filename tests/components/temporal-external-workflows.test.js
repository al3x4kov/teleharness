// компонентные тесты просмотра и управления сторонними workflow Temporal
// (TemporalView admin vs tenant изоляция, ExternalWorkflowsList фильтры + Start sheet,
// ExternalWorkflowDetail Signal / Query / Reset / Cancel / Terminate + payload/history).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch, fetchCalls } from "./helpers/dom.mjs";

let ui, h;
before(async () => {
  ui = await loadUI({
    TemporalView: "src/components/views/TemporalView.jsx",
    ExternalWorkflowsList: "src/components/temporal/ExternalWorkflowsList.jsx",
    ExternalWorkflowDetail: "src/components/temporal/ExternalWorkflowDetail.jsx",
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
  ledger: "none",
  commandsAvailable: true,
  socketPathError: null,
};

const sampleItems = [
  {
    workflowId: "ext-order-sync-001",
    runId: "run-ext-1",
    workflowType: "OrderSyncWorkflow",
    taskQueue: "orders-q",
    status: "RUNNING",
    startTime: "2026-11-25T10:00:00Z",
    closeTime: null,
    historyLength: 7,
    isPortal: false,
    uiUrl: "http://127.0.0.1:8233/namespaces/default/workflows/ext-order-sync-001/run-ext-1",
  },
  {
    workflowId: "ext-report-fail-003",
    runId: "run-ext-3",
    workflowType: "ReportExportWorkflow",
    taskQueue: "reports-q",
    status: "FAILED",
    startTime: "2026-11-25T09:00:00Z",
    closeTime: "2026-11-25T09:01:00Z",
    historyLength: 9,
    isPortal: false,
    uiUrl: null,
  },
];

const sampleDetail = {
  address: "127.0.0.1:7233",
  namespace: "default",
  workflow: {
    workflowId: "ext-order-sync-001",
    runId: "run-ext-1",
    workflowType: "OrderSyncWorkflow",
    taskQueue: "orders-q",
    status: "RUNNING",
    startTime: "2026-11-25T10:00:00Z",
    closeTime: null,
    executionDuration: "12s",
    historyLength: 7,
    isPortal: false,
    uiUrl: "http://127.0.0.1:8233/namespaces/default/workflows/ext-order-sync-001/run-ext-1",
  },
  input: { orderId: "ORD-77", retries: 2 },
  result: null,
  failure: null,
  pendingActivities: [
    { activityId: "act-1", activityType: "FetchInventory", state: "STARTED", attempt: 2, lastFailure: "timeout" },
  ],
  events: [
    { eventId: 1, eventTime: "2026-11-25T10:00:00Z", eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED", shortType: "WorkflowExecutionStarted", summary: "OrderSyncWorkflow · orders-q", resettable: false },
    { eventId: 4, eventTime: "2026-11-25T10:00:01Z", eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", shortType: "WorkflowTaskCompleted", summary: "worker-1", resettable: true },
    { eventId: 7, eventTime: "2026-11-25T10:00:03Z", eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", shortType: "WorkflowTaskCompleted", summary: "worker-1", resettable: true },
  ],
  resetPoints: [
    { eventId: 7, eventTime: "2026-11-25T10:00:03Z", label: "#7 · WorkflowTaskCompleted" },
    { eventId: 4, eventTime: "2026-11-25T10:00:01Z", label: "#4 · WorkflowTaskCompleted" },
  ],
  totalEvents: 7,
};

// ——— TemporalView: изоляция admin vs tenant ———

test("admin видит вкладку «Внешние» и открывает список внешних workflow", async () => {
  installFetch([
    { path: "/teleharness/api/temporal/capabilities", reply: () => capsBase },
    { path: "/teleharness/api/admin/temporal-workflows", reply: () => ({ address: "127.0.0.1:7233", namespace: "default", items: sampleItems }) },
  ]);
  const { root } = h.mount(ui.TemporalView, { section: "external" });
  await h.waitFor(() => root.textContent.includes("OrderSyncWorkflow"));
  assert($(root, 'a[href="#/temporal/external"]'), "вкладка «Внешние» видна admin");
  assert(root.textContent.includes("ext-order-sync-001"));
});

test("не-admin тенант не видит вкладку «Внешние» и не шлёт запросов в admin API", async () => {
  ui.store.me.value = { id: "qa", role: "user" };
  installFetch([
    { path: "/teleharness/api/temporal/capabilities", reply: () => capsBase },
  ]);
  const { root } = h.mount(ui.TemporalView, { section: "external" });
  await h.waitFor(() => root.textContent.includes("Доступ только администратору"));
  assert.equal($(root, 'a[href="#/temporal/external"]'), null, "вкладка «Внешние» скрыта для тенанта");
  assert.equal(fetchCalls.filter((c) => c.path.includes("/admin/temporal-workflows")).length, 0);

  h.cleanup();
  const det = h.mount(ui.TemporalView, { section: "external", id: "ext-order-sync-001" });
  await h.waitFor(() => det.root.textContent.includes("Доступ только администратору"));
  assert.equal(fetchCalls.filter((c) => c.path.includes("/admin/temporal-workflows")).length, 0);
});

// ——— ExternalWorkflowsList: фильтры, StartWorkflowSheet ———

const submitForm = (sheet) => h.fire(sheet.querySelector("form"), "submit");

test("ExternalWorkflowsList фильтрует список и запускает workflow с проверкой JSON", async () => {
  const startedPayloads = [];
  installFetch([
    {
      method: "GET",
      path: "/teleharness/api/admin/temporal-workflows",
      reply: (req) => {
        const st = req.query.status || "";
        const items = st === "Failed" ? sampleItems.filter((x) => x.status === "FAILED") : sampleItems;
        return { address: "127.0.0.1:7233", namespace: "default", items };
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/admin/temporal-workflows",
      reply: (req) => {
        startedPayloads.push(req.body);
        return { status: 201, body: { workflowId: req.body.workflowId || "wf-started-1", runId: "run-new-1" } };
      },
    },
  ]);

  const { root } = h.mount(ui.ExternalWorkflowsList);
  await h.waitFor(() => root.textContent.includes("OrderSyncWorkflow"));
  assert(root.textContent.includes("ReportExportWorkflow"));

  // Переключение фильтра статуса на «Ошибки»
  h.click(byText(root, "С ошибкой", "button"));
  await h.waitFor(() => !root.textContent.includes("OrderSyncWorkflow"));
  assert(root.textContent.includes("ReportExportWorkflow"));
  assert(fetchCalls.some((c) => c.query.status === "Failed" && c.query.excludePortal === "1"));

  // Снимаем чекбокс «Только сторонние» → excludePortal=0
  const toggle = $(root, 'input[type="checkbox"]');
  h.act(() => {
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await h.waitFor(() => fetchCalls.some((c) => c.query.excludePortal === "0"));

  // Открываем шторку «Запустить workflow»
  h.click($(root, '[data-action="open-start-workflow"]'));
  await h.flush();
  const sheet = document.querySelector(".t-sheet");
  assert(sheet, "шторка запуска открыта");
  h.typeInto(sheet.querySelector('input[name="workflowType"]'), "DemoExternalWorkflow");
  h.typeInto(sheet.querySelector('input[name="taskQueue"]'), "demo-q");
  h.typeInto(sheet.querySelector('input[name="workflowId"]'), "demo-wf-1");
  h.typeInto(sheet.querySelector('textarea[name="input"]'), "{invalid json");
  submitForm(sheet);
  await h.waitFor(() => sheet.textContent.includes("Некорректный JSON"));
  assert.equal(startedPayloads.length, 0);

  // Исправляем JSON и отправляем
  h.typeInto(sheet.querySelector('textarea[name="input"]'), '{"step":1}');
  submitForm(sheet);
  await h.waitFor(() => startedPayloads.length === 1);
  assert.equal(startedPayloads[0].workflowType, "DemoExternalWorkflow");
  assert.equal(startedPayloads[0].taskQueue, "demo-q");
  assert.equal(startedPayloads[0].workflowId, "demo-wf-1");
  assert.equal(startedPayloads[0].input, '{"step":1}');
});

// ——— ExternalWorkflowDetail: Signal, Query, Reset, Cancel, Terminate ———

test("ExternalWorkflowDetail отображает данные и выполняет Signal, Query, Reset, Cancel, Terminate", async () => {
  const actions = [];
  let currentDetail = structuredClone(sampleDetail);

  installFetch([
    {
      method: "GET",
      path: "/teleharness/api/admin/temporal-workflows/ext-order-sync-001",
      reply: () => currentDetail,
    },
    {
      method: "POST",
      path: "/teleharness/api/admin/temporal-workflows/ext-order-sync-001/signal",
      reply: (req) => {
        actions.push({ kind: "signal", body: req.body });
        return { ok: true, workflowId: "ext-order-sync-001", name: req.body.name };
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/admin/temporal-workflows/ext-order-sync-001/query",
      reply: (req) => {
        actions.push({ kind: "query", body: req.body });
        return { ok: true, type: req.body.type, result: { stage: "approved", notes: ["ok"] } };
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/admin/temporal-workflows/ext-order-sync-001/reset",
      reply: (req) => {
        actions.push({ kind: "reset", body: req.body });
        currentDetail = {
          ...currentDetail,
          workflow: { ...currentDetail.workflow, runId: "run-after-reset-2" },
        };
        return { ok: true, workflowId: "ext-order-sync-001", runId: "run-after-reset-2" };
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/admin/temporal-workflows/ext-order-sync-001/cancel",
      reply: (req) => {
        actions.push({ kind: "cancel", body: req.body });
        return { ok: true, action: "cancel" };
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/admin/temporal-workflows/ext-order-sync-001/terminate",
      reply: (req) => {
        actions.push({ kind: "terminate", body: req.body });
        currentDetail = {
          ...currentDetail,
          workflow: { ...currentDetail.workflow, status: "TERMINATED" },
        };
        return { ok: true, action: "terminate" };
      },
    },
  ]);

  const { root } = h.mount(ui.ExternalWorkflowDetail, { workflowId: "ext-order-sync-001" });
  await h.waitFor(() => root.textContent.includes("OrderSyncWorkflow"));
  assert(root.textContent.includes("ORD-77"), "показан input payload");
  assert(root.textContent.includes("FetchInventory"), "показана ожидающая активность");
  assert(root.textContent.includes("Temporal UI ↗"), "показана ссылка на Temporal UI");
  assert(root.textContent.includes("↺ Reset сюда"), "у WorkflowTaskCompleted есть кнопка быстрого Reset");

  // 1) Signal
  h.click($(root, '[data-action="open-signal"]'));
  await h.flush();
  let sheet = document.querySelector(".t-sheet");
  h.typeInto(sheet.querySelector('input[name="signalName"]'), "approve");
  h.typeInto(sheet.querySelector('textarea[name="signalInput"]'), '{"by":"owner"}');
  submitForm(sheet);
  await h.waitFor(() => actions.some((a) => a.kind === "signal"));
  assert.equal(actions.find((a) => a.kind === "signal").body.name, "approve");
  await h.waitFor(() => root.textContent.includes("Сигнал «approve» отправлен"));

  // 2) Query
  h.click($(root, '[data-action="open-query"]'));
  await h.flush();
  sheet = document.querySelector(".t-sheet");
  h.typeInto(sheet.querySelector('input[name="queryType"]'), "get_state");
  submitForm(sheet);
  await h.waitFor(() => $(root, '[data-testid="query-result-card"]'));
  const qCard = $(root, '[data-testid="query-result-card"]');
  assert(qCard.textContent.includes('"stage": "approved"'));
  assert($(qCard, '[data-action="copy-query-result"]'));

  // 3) Reset (кнопка submit disabled пока reason пустой; после ввода reason отправляет eventId)
  h.click($(root, '[data-action="open-reset"]'));
  await h.flush();
  sheet = document.querySelector(".t-sheet");
  assert.equal(sheet.querySelector('[data-action="submit-reset"]').disabled, true);
  change(sheet.querySelector('select[name="resetEventId"]'), "4");
  change(sheet.querySelector('select[name="reapplyExclude"]'), "Signal");
  h.typeInto(sheet.querySelector('input[name="resetReason"]'), "Повтор после фикса");
  await h.flush();
  assert.equal(sheet.querySelector('[data-action="submit-reset"]').disabled, false);
  submitForm(sheet);
  await h.waitFor(() => actions.some((a) => a.kind === "reset"));
  const resetReq = actions.find((a) => a.kind === "reset").body;
  assert.equal(resetReq.eventId, 4);
  assert.equal(resetReq.reason, "Повтор после фикса");
  assert.equal(resetReq.reapplyExclude, "Signal");
  await h.waitFor(() => root.textContent.includes("run-after-reset-2"));

  // 4) Cancel
  h.click($(root, '[data-action="open-cancel"]'));
  await h.flush();
  sheet = document.querySelector(".t-sheet");
  h.typeInto(sheet.querySelector('input[name="cancelReason"]'), "Отмена проверки");
  submitForm(sheet);
  await h.waitFor(() => actions.some((a) => a.kind === "cancel"));
  assert.equal(actions.find((a) => a.kind === "cancel").body.reason, "Отмена проверки");
  await h.waitFor(() => root.textContent.includes("Запрос на отмену отправлен"));

  // 5) Terminate (требует reason, после завершения кнопки Signal/Cancel/Terminate становятся disabled)
  h.click($(root, '[data-action="open-terminate"]'));
  await h.flush();
  sheet = document.querySelector(".t-sheet");
  assert.equal(sheet.querySelector('[data-action="submit-terminate"]').disabled, true);
  h.typeInto(sheet.querySelector('input[name="terminateReason"]'), "Зависшая активность");
  await h.flush();
  submitForm(sheet);
  await h.waitFor(() => actions.some((a) => a.kind === "terminate"));
  await h.waitFor(() => root.textContent.includes("Workflow завершён — доступны Query и Reset"));
  assert.equal($(root, '[data-action="open-signal"]').disabled, true);
  assert.equal($(root, '[data-action="open-cancel"]').disabled, true);
  assert.equal($(root, '[data-action="open-terminate"]').disabled, true);
  assert.equal($(root, '[data-action="open-query"]').disabled, false);
  assert.equal($(root, '[data-action="open-reset"]').disabled, false);
});
