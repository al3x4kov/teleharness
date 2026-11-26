// + регрессия UI, a11y, тёмного контраста,
// мобильных полей ввода, экрана 404 несуществующего чата и дедупликации сетевых запросов.
import { readFileSync } from "node:fs";
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    MenuButton: "src/components/Menu.jsx#MenuButton",
    WorktreesView: "src/components/views/WorktreesView.jsx",
    SettingsView: "src/components/views/SettingsView.jsx",
    TemporalView: "src/components/views/TemporalView.jsx",
    ReviewView: "src/components/views/ReviewView.jsx",
    Sheet: "src/components/views/ReviewView.jsx#Sheet",
    BoardView: "src/components/views/BoardView.jsx",
    ChatView: "src/components/views/ChatView.jsx",
    AppShell: "src/components/AppShell.jsx",
    refreshSessions: "src/lib/store/catalog.js#refreshSessions",
    api: "src/lib/api.js#api",
  });
  t$ = createHarness(ui);
});

afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  ui.store.me.value = null;
  ui.store.active.value = null;
  installFetch();
});

test("/ ISSUE-003: .btn-danger в тёмной теме использует контрастный красный фон (≥ 4.5:1 с #fff), а не светлый --error #f58a80", () => {
  const css = readFileSync(new URL("../../src/claude-look.css", import.meta.url), "utf8");
  const dangerMatch = css.match(/\.btn-danger\s*\{([^}]*)\}/);
  assert.ok(dangerMatch, ".btn-danger rule must exist");
  assert.doesNotMatch(dangerMatch[1], /background\s*:\s*var\(--error\)\s*;/, ".btn-danger не должен брать светлый --error в тёмной теме");
  assert.match(css, /--danger-bg\s*:\s*#b8332e|background\s*:\s*var\(--danger-bg,\s*#b8332e\)|background\s*:\s*#b8332e/i, "должен задаваться контрастный фон #b8332e (6.14:1)");
});

test("/ ISSUE-004 & ISSUE-012: WorktreesView ведёт на /temporal/run/:id и удаляет ветку через портальный role=dialog без confirm()", async () => {
  const deleted = [];
  installFetch([
    {
      path: "/teleharness/api/worktrees",
      reply: () => ({
        repo: true,
        limits: { max: 20 },
        items: [{ id: "wt1", kind: "run", runId: "wf-abc/1", title: "Release", branch: "wt/release", base: "main", ahead: 1, filesCount: 2, size: 1024, state: "ready" }],
        branches: [{ name: "wt/orphan-1", subject: "WIP commit" }],
      }),
    },
    { path: "/teleharness/api/me/worktrees", reply: () => ({ mergeMethod: "squash", testTimeoutMin: 10 }) },
    { path: "/teleharness/api/worktrees/test-cmd", reply: () => ({ cmd: "npm test" }) },
    {
      method: "DELETE",
      path: "/teleharness/api/worktrees/branches",
      reply: (req) => { deleted.push(req.url); return { ok: true }; },
    },
  ]);

  let confirmCalled = false;
  const origConfirm = globalThis.confirm;
  globalThis.confirm = () => { confirmCalled = true; return true; };
  try {
    location.hash = "#/worktrees?directory=%2Frepo";
    const h = t$.mount(ui.WorktreesView, {});
    await t$.waitFor(() => $(h.root, ".wt-card"));

    // Клик «Открыть запуск» → #/temporal/run/<encoded>
    const openRun = [...$$(h.root, "button")].find((b) => b.textContent.includes("Открыть запуск"));
    assert.ok(openRun, "кнопка «Открыть запуск» должна существовать");
    t$.click(openRun);
    await t$.flush();
    assert.equal(location.hash, "#/temporal/run/wf-abc%2F1", "ссылка должна вести на /temporal/run/:id (не /temporal/runs/:id)");

    // Клик «Удалить ветку» → портальная модалка без window.confirm
    const delBtn = [...$$(h.root, "button")].find((b) => b.textContent.includes("Удалить ветку"));
    assert.ok(delBtn, "кнопка «Удалить ветку» должна существовать");
    t$.click(delBtn);
    await t$.flush();
    assert.equal(confirmCalled, false, "браузерный confirm() не должен вызываться");
    const dlg = $(document.body, '[role="dialog"]');
    assert.ok(dlg, "должен открыться портальный role=dialog в document.body");
    const okBtn = [...$$(dlg, "button")].find((b) => /Удалить/i.test(b.textContent));
    assert.ok(okBtn, "в диалоге должна быть кнопка подтверждения удаления");
    t$.click(okBtn);
    await t$.waitFor(() => deleted.length > 0);
    assert.equal(deleted.length, 1);
    h.unmount();
  } finally {
    globalThis.confirm = origConfirm;
  }
});

test("/ ISSUE-005 & / ISSUE-011: SettingsView рендерит ровно 1 <h1> на корне и на подмаршруте и не вызывает /teleharness/api/usage", async () => {
  const calls = [];
  installFetch([
    { path: "/teleharness/api/usage", reply: () => { calls.push("/teleharness/api/usage"); return { ok: true }; } },
    { path: "/teleharness/api/mcp", reply: () => { calls.push("/teleharness/api/mcp"); return { ctx: { status: "connected" } }; } },
    { path: /^\/zai\/api\//, reply: (req) => { calls.push(req.path); return {}; } },
  ]);
  ui.store.me.value = { id: "admin", name: "Admin", role: "admin", engines: ["opencode", "claude"] };

  location.hash = "#/settings";
  const hRoot = t$.mount(ui.SettingsView, { section: null });
  await t$.flush();
  assert.equal($$(hRoot.root, "h1").length, 1, "в корне #/settings ровно один <h1>");
  assert.equal($(hRoot.root, "h1").textContent.trim(), "Настройки");
  hRoot.unmount();

  location.hash = "#/settings/appearance";
  const hSub = t$.mount(ui.SettingsView, { section: "appearance" });
  await t$.flush();
  const subH1s = $$(hSub.root, "h1");
  assert.equal(subH1s.length, 1, `на подмаршруте #/settings/appearance должен быть ровно 1 <h1>, найдено ${subH1s.length}`);
  assert.equal(subH1s[0].textContent.trim(), "Оформление");
  hSub.unmount();

  assert.equal(calls.includes("/teleharness/api/usage"), false, "SettingsView не должен делать неиспользуемый запрос /teleharness/api/usage");
});

test("/ ISSUE-006 & ISSUE-015: TemporalView — ровно 1 <h1> на #/temporal/schedules/new и точка в тексте пустого состояния", async () => {
  installFetch([
    {
      path: "/teleharness/api/temporal/capabilities",
      reply: () => ({
        pipelineAvailable: true,
        runListAvailable: false,
        schedulesAvailable: true,
        execution: { reason: "Воркер не запущен" },
        engines: ["opencode"],
      }),
    },
    { path: "/teleharness/api/temporal/definitions", reply: () => [] },
    { path: "/teleharness/api/temporal/commands", reply: () => ({ items: [] }) },
    { path: "/teleharness/api/temporal/schedules", reply: () => [] },
  ]);
  ui.store.me.value = { id: "admin", name: "Admin", role: "admin", engines: ["opencode"] };

  const hNewEmpty = t$.mount(ui.TemporalView, { section: "schedules", id: "new" });
  await t$.waitFor(() => hNewEmpty.root.textContent.includes("Сначала опубликуйте пайп"));
  assert.equal($$(hNewEmpty.root, "h1").length, 1, "#/temporal/schedules/new (пустой список) должен иметь ровно 1 <h1>");
  hNewEmpty.unmount();

  installFetch([
    {
      path: "/teleharness/api/temporal/capabilities",
      reply: () => ({
        pipelineAvailable: true,
        runListAvailable: true,
        schedulesAvailable: true,
        engines: ["opencode"],
      }),
    },
    {
      path: "/teleharness/api/temporal/definitions",
      reply: () => ([{ id: "def-1", name: "Утренняя сводка", latestVersion: 1 }]),
    },
    { path: "/teleharness/api/temporal/commands", reply: () => ({ items: [] }) },
  ]);
  const hNewForm = t$.mount(ui.TemporalView, { section: "schedules", id: "new" });
  await t$.waitFor(() => $(hNewForm.root, ".t-form"));
  assert.equal($$(hNewForm.root, "h1").length, 1, "#/temporal/schedules/new (с опубликованным пайпом) должен иметь ровно 1 <h1>");
  hNewForm.unmount();

  installFetch([
    {
      path: "/teleharness/api/temporal/capabilities",
      reply: () => ({
        pipelineAvailable: true,
        runListAvailable: false,
        schedulesAvailable: true,
        execution: { reason: "Воркер не запущен" },
        engines: ["opencode"],
      }),
    },
  ]);
  const hRuns = t$.mount(ui.TemporalView, { section: "runs", id: null });
  await t$.waitFor(() => hRuns.root.textContent.includes("Запуски не подключены"));
  assert.match(hRuns.root.textContent, /Воркер не запущен\.\s+Пайпы и их версии можно подготовить заранее\./, "после reason должна быть точка");
  hRuns.unmount();
});

test("/ ISSUE-009: поля ввода .gh-token input и .wt-field input/select/textarea имеют font-size: 16px", () => {
  const gitCss = readFileSync(new URL("../../src/components/git/git.css", import.meta.url), "utf8");
  const ghInput = gitCss.match(/\.gh-token input\s*\{([^}]*)\}/);
  assert.ok(ghInput, ".gh-token input rule exists");
  assert.match(ghInput[1], /font-size\s*:\s*16px/i, ".gh-token input должен иметь font-size: 16px");

  const wtCss = readFileSync(new URL("../../src/components/worktree.css", import.meta.url), "utf8");
  const wtInputs = wtCss.match(/\.wt-field select[^{]*\{([^}]*)\}/);
  assert.ok(wtInputs, ".wt-field inputs rule exists");
  assert.match(wtInputs[1], /font-size\s*:\s*16px/i, ".wt-field select/input/textarea должны иметь font-size: 16px");
});

test("/ ISSUE-012: MenuButton на десктопе (≥900px) имеет aria-hidden='true' и tabIndex=-1; Sheet и BoardView.Confirm рендерятся порталом в document.body", async () => {
  const origW = window.innerWidth;
  try {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    const hDesktop = t$.mount(ui.MenuButton, {});
    await t$.flush();
    const btnDesktop = $(hDesktop.root, "button.menu-btn");
    assert.equal(btnDesktop.getAttribute("aria-hidden"), "true");
    assert.equal(btnDesktop.tabIndex, -1);
    hDesktop.unmount();

    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    const hMobile = t$.mount(ui.MenuButton, {});
    await t$.flush();
    const btnMobile = $(hMobile.root, "button.menu-btn");
    assert.equal(btnMobile.getAttribute("aria-hidden"), null);
    assert.notEqual(btnMobile.tabIndex, -1);
    hMobile.unmount();
  } finally {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: origW });
  }

  // Sheet из ReviewView рендерится порталом прямо в document.body (не внутри hSheet.root)
  const hSheet = t$.mount(ui.Sheet, { title: "Проверка портала", onClose: () => {} });
  await t$.flush();
  assert.equal($(hSheet.root, ".rv-scrim"), null, "Sheet не должен оставаться внутри контейнера корня");
  assert.ok($(document.body, ".rv-scrim .rv-sheet[role='dialog']"), "Sheet должен рендериться в document.body");
  hSheet.unmount();
});

test("/ ISSUE-007: несуществующий чат не вызывает /teleharness/api/worktrees, рендерит <h1 class='hero'>Чат не найден</h1> и скрывает RightPanel", async () => {
  const wtCalls = [];
  installFetch([
    { path: "/teleharness/api/worktrees", reply: (req) => { wtCalls.push(req.url); return { status: 404, body: { error: "not found" } }; } },
    { path: "/teleharness/api/session/ses_missing_ui/message", reply: () => ({ status: 404, body: { error: "not found" } }) },
    { path: "/teleharness/api/session/ses_missing_ui/plan", reply: () => ({ status: 404, body: { error: "not found" } }) },
    { path: "/teleharness/api/session", reply: () => [] },
    { path: /^\/zai\/api\//, reply: () => ({}) },
  ]);
  ui.store.me.value = { id: "admin", name: "Admin", role: "admin", engines: ["opencode"] };
  ui.store.sessions.value = [];
  ui.store.active.value = { id: "ses_missing_ui", messages: [], loading: false, loadError: "404", loadErrorDetail: { status: 404 } };

  const h = t$.mount(ui.ChatView, { id: "ses_missing_ui" });
  await t$.flush();
  assert.equal(wtCalls.length, 0, "на 404 чата запрос /teleharness/api/worktrees не должен выполняться");
  const h1s = $$(h.root, "h1");
  assert.equal(h1s.length, 1, "на экране 404 ровно один <h1>");
  assert.equal(h1s[0].textContent.trim(), "Чат не найден");
  h.unmount();
});

test("/ ISSUE-011: параллельные refreshSessions() и api.getMcp() коалесцируются в 1 запрос", async () => {
  let sessionCount = 0;
  let mcpCount = 0;
  installFetch([
    {
      path: "/teleharness/api/session",
      reply: async () => {
        sessionCount += 1;
        await new Promise((r) => setTimeout(r, 15));
        return [];
      },
    },
    {
      path: "/teleharness/api/mcp",
      reply: async () => {
        mcpCount += 1;
        await new Promise((r) => setTimeout(r, 15));
        return {};
      },
    },
  ]);

  await Promise.all([ui.refreshSessions(), ui.refreshSessions(), ui.refreshSessions()]);
  assert.equal(sessionCount, 1, `параллельные refreshSessions должны слать 1 запрос, послано ${sessionCount}`);

  await Promise.all([ui.api.getMcp(), ui.api.getMcp(null), ui.api.getMcp("")]);
  assert.equal(mcpCount, 1, `параллельные api.getMcp() для одного directory должны слать 1 запрос, послано ${mcpCount}`);
});
