// регрессия 3 клиентских находок живого QA-прогона gstack:
// 1. ExternalWorkflowsList: семантические карточки <a> с осмысленным aria-label и без @cN на детях.
// 2. Drawer: на десктопе (1280×800) компактные строки (40px), чтобы 8 чатов + «Показать все»
//    помещались без перекрытия/скролла; закрытый мобильный Drawer помечен inert + aria-hidden;
//    кнопка .dark-pill имеет aria-label.
// 3. TemporalView: ровно один <h1> на всех вкладках и в состоянии ошибки/загрузки.
import { readFileSync } from "node:fs";
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    Drawer: "src/components/Drawer.jsx",
    drawerOpen: "src/components/Menu.jsx#drawerOpen",
    openDrawer: "src/components/Menu.jsx#openDrawer",
    closeDrawer: "src/components/Menu.jsx#closeDrawer",
    ExternalWorkflowsList: "src/components/temporal/ExternalWorkflowsList.jsx",
    TemporalView: "src/components/views/TemporalView.jsx",
  });
  t$ = createHarness(ui);
});

afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  ui.store.me.value = null;
  ui.drawerOpen.value = false;
  installFetch();
});

test("/ ISSUE-001: карточки ExternalWorkflowsList — семантические <a> с aria-label, дети с pointer-events: none", async () => {
  installFetch([
    {
      path: "/teleharness/api/admin/temporal-workflows",
      reply: () => ({
        address: "127.0.0.1:7233",
        namespace: "default",
        items: [
          {
            workflowId: "ext-order-sync-001",
            runId: "run-1",
            workflowType: "OrderSyncWorkflow",
            taskQueue: "orders-q",
            status: "RUNNING",
            startTime: new Date().toISOString(),
            historyLength: 6,
            isPortal: false,
          },
        ],
      }),
    },
  ]);

  const { root } = t$.mount(ui.ExternalWorkflowsList, {});
  await t$.waitFor(() => $(root, '[data-testid="ext-wf-ext-order-sync-001"]'));
  const card = $(root, '[data-testid="ext-wf-ext-order-sync-001"]');
  assert.equal(card.tagName, "A", "карточка должна быть ссылкой <a>");
  assert.ok(card.getAttribute("href")?.startsWith("#/temporal/external/"), "ссылка ведёт в детальную карточку");
  const label = card.getAttribute("aria-label") || "";
  assert.match(label, /OrderSyncWorkflow/, "aria-label содержит тип workflow");
  assert.match(label, /ext-order-sync-001/, "aria-label содержит workflowId");

  const css = readFileSync(new URL("../../src/temporal.css", import.meta.url), "utf8");
  assert.match(css, /\.t-ext-row\s*>\s*\*\s*\{[^}]*pointer-events\s*:\s*none/i, "дети .t-ext-row не перехватывают pointer-events");
});

test("/ ISSUE-002: на ПК (≥ 900px) строки сайдбара компактны (40px), чтобы на 1280×800 влезали 8 чатов и «Показать все»", () => {
  const css = readFileSync(new URL("../../src/claude-look.css", import.meta.url), "utf8");
  const desktopBlocks = [...css.matchAll(/@media\s*\(min-width:\s*900px\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  assert.ok(desktopBlocks, "@media (min-width: 900px) block must exist in claude-look.css");
  assert.match(desktopBlocks, /\.drawer-item[\s\S]*min-height\s*:\s*40px/i, "на десктопе .drawer-item min-height: 40px");
  assert.match(css, /\.drawer-foot\s*\{[^}]*background\s*:/i, ".drawer-foot имеет непрозрачный фон");
});

test("/ ISSUE-003 (Drawer): закрытый мобильный Drawer имеет aria-hidden='true' и inert; открытый и десктопный — нет; .dark-pill имеет aria-label", async () => {
  const origW = window.innerWidth;
  try {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    const h = t$.mount(ui.Drawer, { view: "home", chatId: null });
    await t$.flush();
    const nav = $(h.root, "nav.drawer");
    assert.equal(nav.getAttribute("aria-hidden"), "true", "закрытый мобильный Drawer скрыт от screen readers");
    assert.equal(nav.hasAttribute("inert") || nav.inert === true, true, "закрытый мобильный Drawer имеет inert");

    const pill = $(h.root, "button.dark-pill");
    assert.ok((pill.getAttribute("aria-label") || "").trim().length > 0, ".dark-pill имеет непустой aria-label");

    t$.act(() => ui.openDrawer());
    await t$.flush();
    assert.equal(nav.getAttribute("aria-hidden"), null, "открытый мобильный Drawer доступен");
    assert.equal(nav.hasAttribute("inert"), false, "открытый мобильный Drawer не inert");

    t$.act(() => ui.closeDrawer());
    await t$.flush();
    assert.equal(nav.getAttribute("aria-hidden"), "true", "после закрытия aria-hidden возвращается");

    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    window.dispatchEvent(new window.Event("resize"));
    await t$.waitFor(() => nav.getAttribute("aria-hidden") === null);
    assert.equal(nav.hasAttribute("inert"), false, "на десктопе (≥ 900px) Drawer не inert");
    h.unmount();
  } finally {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: origW });
  }
});

test("/ ISSUE-003 (TemporalView): ровно один <h1> на каждой вкладке Temporal и при ошибке загрузки", async () => {
  ui.store.me.value = { id: "admin", name: "QA", role: "admin" };
  installFetch([
    {
      path: "/teleharness/api/temporal/capabilities",
      reply: () => ({
        enabled: true,
        runListAvailable: true,
        pipelineAvailable: true,
        schedulesAvailable: true,
        engines: ["opencode", "claude"],
        modelLabels: {},
      }),
    },
    { path: "/teleharness/api/temporal/runs", reply: () => [] },
    { path: "/teleharness/api/temporal/definitions", reply: () => [] },
    { path: "/teleharness/api/temporal/schedules", reply: () => [] },
    { path: "/teleharness/api/temporal/triggers", reply: () => [] },
    { path: "/teleharness/api/admin/temporal-commands", reply: () => ({ items: [], allowedRoots: [] }) },
    { path: "/teleharness/api/admin/temporal/workflows", reply: () => ({ address: "127.0.0.1:7233", namespace: "default", items: [] }) },
  ]);

  for (const section of ["runs", "pipes", "schedules", "triggers", "commands", "external"]) {
    const h = t$.mount(ui.TemporalView, { section });
    await t$.waitFor(() => !$(h.root, ".t-skel") && ($(h.root, ".t-head h1, .t-wrap h1") || $(h.root, ".t-empty")));
    const h1s = $$(h.root, "h1");
    assert.equal(h1s.length, 1, `section=${section}: должен быть ровно один <h1>, найдено ${h1s.length} (${h1s.map((x) => x.textContent).join(", ")})`);
    h.unmount();
  }

  // В состоянии ошибки (capabilities 500) заголовок шапки остаётся единственным <h1>
  installFetch([
    { path: "/teleharness/api/temporal/capabilities", reply: () => ({ status: 500, body: { error: "boom" } }) },
  ]);
  const hErr = t$.mount(ui.TemporalView, { section: "runs" });
  await t$.waitFor(() => $(hErr.root, ".t-empty"));
  const errH1s = $$(hErr.root, "h1");
  assert.equal(errH1s.length, 1, "в состоянии ошибки должен оставаться ровно один <h1>");
  hErr.unmount();
});
