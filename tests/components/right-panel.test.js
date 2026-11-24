// FEAT-20.37: правая панель чата — секции MCP/Skills/План, лимит 5 видимых
// строк с «Показать все (N)» / «Свернуть» (aria-expanded), подписи статусов
// из mcpView, состояния пусто/загрузка/ошибка, привязка плана к своей сессии.
// Harness: loadUI + createHarness (tests/components/helpers/load.mjs); сеть —
// фейковый fetch (installFetch), сигналы — через ui.store.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ RightPanel: "src/components/chat/RightPanel.jsx", setLang: "src/lib/i18n.js#setLang" });
  t$ = createHarness(ui);
});

const SID = "ses_panel";

afterEach(() => {
  t$.cleanup();
  ui.store.resetPlans();
  ui.store.sessions.value = [];
  ui.store.me.value = null;
  ui.store.MCP_EMPTY_RETRY.delayMs = 2500;
  installFetch();
});

const mcp = (spec) => Object.fromEntries(Object.entries(spec).map(([name, st]) => [name, { error: null, ...st }]));
const SEVEN = mcp({
  alpha: { status: "connected" },
  bravo: { status: "connected" },
  charlie: { status: "connected" },
  delta: { status: "connected" },
  echo: { status: "connected" },
  foxtrot: { status: "failed", error: "MCP error -32000: Connection closed" },
  golf: { status: "needs_auth" },
});
const skills8 = () => Array.from({ length: 8 }, (_, i) => ({ id: "sk" + i, name: "skill-" + i, description: "Описание " + i }));

function envRoutes({ mcpBody, skillsBody, planBody } = {}) {
  return [
    { method: "GET", path: "/teleharness/api/mcp", reply: () => mcpBody ?? {} },
    { method: "GET", path: "/teleharness/api/skills", reply: () => skillsBody ?? [] },
    { method: "GET", path: /\/teleharness\/api\/session\/.+\/plan$/, reply: () => planBody ?? { sessionID: SID, todos: [] } },
  ];
}

// Монтаж без ожиданий: каждый тест ждёт то, что ему нужно (пустой Skills
// оседает через 12 ретраев, пустой MCP — тоже, поэтому общий wait вводил бы
// в заблуждение).
function mountPanel(extra = {}, props = { id: SID }) {
  installFetch(envRoutes(extra));
  return t$.mount(ui.RightPanel, props);
}

// ---- секции, лимит 5 строк, «Показать все» / «Свернуть» ---------------------

test("FEAT-20.37: секции MCP и Skills рендерятся; 7 серверов — 5 строк + «Показать все (7)», разворот и сворачивание", async () => {
  const { root } = mountPanel({ mcpBody: SEVEN, skillsBody: skills8() });
  await t$.waitFor(() => $$(root, ".rp-mcp").length === 5 && $$(root, ".rp-skill").length === 5);
  assert.ok($(root, 'section[aria-label="MCP — подключённые серверы"]'), "секция MCP");
  assert.ok($(root, 'section[aria-label="Skills — доступные скиллы"]'), "секция Skills");

  const mcpRows = $$(root, ".rp-mcp");
  assert.equal(mcpRows.length, 5, "видимы первые 5 серверов");
  const mcpMore = byText(root, "button", "Показать все (7)");
  assert.ok(mcpMore, "кнопка «Показать все (7)»");
  assert.equal(mcpMore.getAttribute("aria-expanded"), "false");

  t$.click(mcpMore);
  await t$.flush();
  assert.equal($$(root, ".rp-mcp").length, 7, "все 7 серверов");
  const mcpLess = byText(root, "button", "Свернуть");
  assert.ok(mcpLess, "кнопка «Свернуть»");
  assert.equal(mcpLess.getAttribute("aria-expanded"), "true");

  t$.click(mcpLess);
  await t$.flush();
  assert.equal($$(root, ".rp-mcp").length, 5, "свернули — снова 5");
  assert.equal(byText(root, "button", "Показать все (7)").getAttribute("aria-expanded"), "false");

  // те же механики у Skills (8 скиллов)
  assert.equal($$(root, ".rp-skill").length, 5);
  const skMore = byText(root, "button", "Показать все (8)");
  assert.equal(skMore.getAttribute("aria-expanded"), "false");
  t$.click(skMore);
  await t$.flush();
  assert.equal($$(root, ".rp-skill").length, 8);
  const skLess = byText(root, "button", "Свернуть");
  assert.equal(skLess.getAttribute("aria-expanded"), "true");
  t$.click(skLess);
  await t$.flush();
  assert.equal($$(root, ".rp-skill").length, 5);
});

test("FEAT-20.37: подписи статусов из mcpView и тултип «why»", async () => {
  const three = mcp({ a: { status: "connected" }, b: { status: "failed", error: "MCP error -32000: Connection closed" }, c: { status: "needs_auth" } });
  const { root } = mountPanel({ mcpBody: three, skillsBody: [] });
  await t$.waitFor(() => $$(root, ".rp-mcp").length === 3);
  assert.ok(byText(root, ".rp-mcp", "подключён"), "connected → «подключён»");
  assert.ok(byText(root, ".rp-mcp", "ошибка запуска"), "failed → «ошибка запуска»");
  assert.ok(byText(root, ".rp-mcp", "нужна авторизация"), "needs_auth → «нужна авторизация»");
  const bad = byText(root, ".rp-mcp", "b");
  assert.match(bad.getAttribute("title"), /Connection closed/, "why — в тултипе, не в строке");
});

test("FEAT-20.37: пустые секции — «Не настроены» / «Нет доступных скиллов», секции «План» нет", async () => {
  ui.store.MCP_EMPTY_RETRY.delayMs = 0; // ретраи мгновенно: «пусто» после последней попытки
  installFetch(envRoutes({ mcpBody: {}, skillsBody: [], planBody: { sessionID: SID, todos: [] } }));
  const { root } = t$.mount(ui.RightPanel, { id: SID });
  await t$.waitFor(() => byText(root, ".rp-empty", "Не настроены"), { tries: 5000 });
  await t$.waitFor(() => byText(root, ".rp-empty", "Нет доступных скиллов"), { tries: 5000 });
  assert.equal($(root, 'section[aria-label="План текущего запроса"]'), null, "секции «План» нет");
  assert.equal($(root, "aside").getAttribute("aria-label"), "MCP и Skills", "без плана — «MCP и Skills»");
});

test("FEAT-20.37: загрузка — скелетоны role=\"status\" с подписями «Загружаю…»", async () => {
  let releaseMcp, releaseSkills;
  const gateMcp = new Promise((r) => (releaseMcp = r));
  const gateSkills = new Promise((r) => (releaseSkills = r));
  installFetch([
    { method: "GET", path: "/teleharness/api/mcp", reply: async () => { await gateMcp; return SEVEN; } },
    { method: "GET", path: "/teleharness/api/skills", reply: async () => { await gateSkills; return skills8(); } },
    { method: "GET", path: /\/teleharness\/api\/session\/.+\/plan$/, reply: () => ({ sessionID: SID, todos: [] }) },
  ]);
  const { root } = t$.mount(ui.RightPanel, { id: SID });
  assert.ok(byText(root, ".rp-skeleton", "Загружаю список MCP…"), "скелетон MCP с подписью");
  assert.ok(byText(root, ".rp-skeleton", "Загружаю скиллы…"), "скелетон Skills с подписью");
  assert.ok($(root, '.rp-skeleton[role="status"]'), "role=\"status\" у скелетона");
  releaseMcp();
  releaseSkills();
  await t$.waitFor(() => $$(root, ".rp-mcp").length === 5 && $$(root, ".rp-skill").length === 5);
});

test("FEAT-20.37: ошибка секции — «Не удалось загрузить» + «Повторить»; секции перезапрашиваются независимо", async () => {
  installFetch([
    { method: "GET", path: "/teleharness/api/mcp", reply: "network" },
    { method: "GET", path: "/teleharness/api/skills", reply: () => skills8() },
    { method: "GET", path: /\/teleharness\/api\/session\/.+\/plan$/, reply: () => ({ sessionID: SID, todos: [] }) },
  ]);
  const { root } = t$.mount(ui.RightPanel, { id: SID });
  await t$.waitFor(() => byText(root, ".rp-error", "Не удалось загрузить"));
  const mcpSection = $(root, 'section[aria-label="MCP — подключённые серверы"]');
  assert.ok($(mcpSection, '.rp-error[role="status"]'), "role=\"status\" у блока ошибки");
  assert.ok(byText(mcpSection, "button", "Повторить"), "кнопка «Повторить» в секции MCP");
  assert.equal($$(root, ".rp-skill").length, 5, "Skills при этом загружены — секции независимы");

  // повтор: MCP восстановился, Skills не мигал загрузкой
  installFetch(envRoutes({ mcpBody: SEVEN, skillsBody: skills8() }));
  t$.click($(mcpSection, ".rp-retry"));
  await t$.waitFor(() => $$(root, ".rp-mcp").length === 5);
  assert.equal(byText(root, ".rp-error", "Не удалось загрузить"), null, "ошибка ушла");
  assert.equal($$(root, ".rp-skill").length, 5, "Skills не перезагружались");
});

// ---- план хода --------------------------------------------------------------

const PLAN3 = [
  { id: "1", content: "Прочитать файл", status: "completed" },
  { id: "2", content: "Править код", status: "completed" },
  { id: "3", content: "Прогнать тесты", status: "in_progress" },
];

test("FEAT-20.37: план есть — счётчик «выполнено/всего», статусы этапов, подсказка", async () => {
  t$.act(() => ui.store.applyPlan(SID, PLAN3));
  const { root } = mountPanel();
  await t$.waitFor(() => $(root, 'section[aria-label="План текущего запроса"]') != null);
  const planSection = $(root, 'section[aria-label="План текущего запроса"]');
  assert.ok(planSection, "секция «План» появилась");
  assert.ok(byText(root, ".rp-count", "2/3"), "счётчик выполнено/всего");
  const steps = $$(planSection, ".rp-step");
  assert.equal(steps.length, 3);
  assert.equal(steps[0].getAttribute("aria-label"), "выполнен");
  assert.equal(steps[2].getAttribute("aria-label"), "в процессе");
  assert.ok(byText(planSection, ".rp-plan-hint", "План этого запроса — на новом заменится."), "подсказка под списком");
  assert.equal($(root, "aside").getAttribute("aria-label"), "MCP, Skills и план хода", "aria-label панели с планом");
});

test("FEAT-20.37: план чужой сессии не показывается; предстоящий этап — «предстоящий»", async () => {
  t$.act(() => ui.store.applyPlan("ses_other", [{ content: "Чужой шаг", status: "pending" }]));
  const { root } = mountPanel();
  await t$.waitFor(() => $$(root, ".rp-mcp").length > 0 || $(root, "aside") != null);
  assert.equal($(root, 'section[aria-label="План текущего запроса"]'), null, "чужой план не рендерится");
  assert.equal($(root, "aside").getAttribute("aria-label"), "MCP и Skills");
  // pending своей сессии
  t$.act(() => ui.store.applyPlan(SID, [{ content: "Свой шаг", status: "pending" }]));
  await t$.waitFor(() => $(root, 'section[aria-label="План текущего запроса"]') != null);
  const step = $(root, ".rp-step");
  assert.equal(step.getAttribute("aria-label"), "предстоящий");
});

// ---- окружение: папка чата (admin/тенант) и дочитка плана -------------------

test("FEAT-20.37: admin запрашивает MCP/Skills по папке чата, план дочитывается с /plan", async () => {
  ui.store.me.value = { id: "u1", role: "admin" };
  ui.store.sessions.value = [{ id: SID, directory: "D:\\proj x" }];
  installFetch(envRoutes({ mcpBody: SEVEN, skillsBody: skills8(), planBody: { sessionID: SID, todos: [{ content: "С сервера", status: "pending" }] } }));
  const { root } = t$.mount(ui.RightPanel, { id: SID });
  await t$.waitFor(() => $(root, 'section[aria-label="План текущего запроса"]') != null);
  assert.ok(byText(root, ".rp-step-text", "С сервера"), "план дочитан с сервера");
  const mcpCall = fetchCalls.find((c) => c.path === "/teleharness/api/mcp");
  const skillsCall = fetchCalls.find((c) => c.path === "/teleharness/api/skills");
  assert.ok(mcpCall && skillsCall, "окружение запрошено");
  assert.equal(mcpCall.query.directory, "D:\\proj x", "MCP — с ?directory= папки чата");
  assert.equal(skillsCall.query.directory, "D:\\proj x", "Skills — с ?directory= папки чата");
  assert.equal(fetchCalls.filter((c) => /\/plan$/.test(c.path)).length, 1, "план — один запрос на монтаж");
});

test("FEAT-20.37: тенант — запросы окружения без directory (сервер сам считает папку тенанта)", async () => {
  ui.store.me.value = { id: "u2", role: "tenant" };
  ui.store.sessions.value = [{ id: SID, directory: "D:\\proj x" }];
  const { root } = mountPanel({ mcpBody: SEVEN, skillsBody: skills8() });
  await t$.waitFor(() => $$(root, ".rp-mcp").length === 5);
  assert.equal($$(root, ".rp-mcp").length, 5, "окружение загрузилось");
  const mcpCall = fetchCalls.find((c) => c.path === "/teleharness/api/mcp");
  assert.ok(mcpCall, "MCP запрошен");
  assert.equal(mcpCall.query.directory, undefined, "directory не передаётся");
});

test("FEAT-20.37: F5 — когда me, sessions и active.messages доезжают позже монтажа, панель перезапрашивает папку чата и восстанавливает план", async () => {
  ui.store.me.value = null;
  ui.store.sessions.value = [];
  ui.store.active.value = null;
  installFetch(envRoutes({ mcpBody: SEVEN, skillsBody: skills8(), planBody: { sessionID: SID, todos: [] } }));
  const { root } = t$.mount(ui.RightPanel, { id: SID });
  await t$.waitFor(() => fetchCalls.some((c) => /\/plan$/.test(c.path)));
  assert.equal($(root, 'section[aria-label="План текущего запроса"]'), null, "до приезда истории плана нет");

  // Асинхронно доезжают me (admin), sessions (с папкой чата) и история чата с todowrite
  t$.act(() => {
    ui.store.me.value = { id: "u1", role: "admin" };
    ui.store.sessions.value = [{ id: SID, directory: "D:\\proj-f5" }];
    ui.store.active.value = {
      id: SID,
      title: "",
      status: "idle",
      lastEventAt: Date.now(),
      loading: false,
      loadError: false,
      messages: [
        { info: { id: "u1", role: "user", sessionID: SID }, parts: [] },
        { info: { id: "a1", role: "assistant", sessionID: SID }, parts: [{ id: "p1", type: "tool", tool: "todowrite", state: { input: { todos: [{ id: "f5", content: "Восстановлен после F5", status: "completed" }] } } }] },
      ],
    };
  });

  await t$.waitFor(() => $(root, 'section[aria-label="План текущего запроса"]') != null);
  assert.ok(byText(root, ".rp-step-text", "Восстановлен после F5"), "план восстановлен из истории после F5");
  const mcpDirCall = fetchCalls.find((c) => c.path === "/teleharness/api/mcp" && c.query.directory === "D:\\proj-f5");
  const skillsDirCall = fetchCalls.find((c) => c.path === "/teleharness/api/skills" && c.query.directory === "D:\\proj-f5");
  assert.ok(mcpDirCall && skillsDirCall, "окружение перезапрошено по папке открытого чата после приезда me/sessions");
});

test("FEAT-20.37: размонтирование панели отменяет таймеры ретрая MCP/Skills (нет утечки опросов)", async () => {
  const prevDelay = ui.store.MCP_EMPTY_RETRY.delayMs;
  ui.store.MCP_EMPTY_RETRY.delayMs = 30;
  try {
    installFetch(envRoutes({ mcpBody: {}, skillsBody: [] }));
    const { unmount } = t$.mount(ui.RightPanel, { id: SID });
    await t$.waitFor(() => fetchCalls.some((c) => c.path === "/teleharness/api/mcp") && fetchCalls.some((c) => c.path === "/teleharness/api/skills"));
    unmount();
    const afterUnmount = fetchCalls.length;
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(fetchCalls.length, afterUnmount, "после размонтирования новые запросы ретрая не уходят");
  } finally {
    ui.store.MCP_EMPTY_RETRY.delayMs = prevDelay;
  }
});

// ---- FEAT-20.38: поиск по MCP/Skills и модальное окно просмотра Skill -------

test("FEAT-20.38: поиск фильтрует MCP (имя и статус) и Skills (имя/описание), снимает лимит 5, кнопка × сбрасывает, План остаётся", async () => {
  const { root } = mountPanel({ mcpBody: SEVEN, skillsBody: skills8(), planBody: { sessionID: SID, todos: [{ id: "p1", content: "Шаг плана", status: "in_progress" }] } });
  await t$.waitFor(() => $$(root, ".rp-mcp").length === 5 && $$(root, ".rp-skill").length === 5);

  const input = $(root, ".rp-search-input");
  assert.ok(input, "поле поиска рендерится");
  assert.equal($(root, ".rp-search-clear"), null, "кнопка очистки скрыта при пустом запросе");

  // 1) Поиск по имени скилла за пределами первых 5 (skill-7)
  t$.typeInto(input, "skill-7");
  await t$.flush();
  assert.equal($$(root, ".rp-skill").length, 1, "найден 8-й скилл без обрезки лимитом 5");
  assert.match($(root, ".rp-skill").textContent, /skill-7/);
  assert.equal($$(root, ".rp-mcp").length, 0);
  const mcpSec = $(root, 'section[aria-label="MCP — подключённые серверы"]');
  assert.match(mcpSec.textContent, /Ничего не найдено/, "в пустой секции MCP показано «Ничего не найдено»");
  assert.equal(byText(root, "button", "Показать все (8)"), null, "при активном поиске кнопки «Показать все» нет");
  assert.ok($(root, 'section[aria-label="План текущего запроса"]'), "секция «План» не скрывается поиском");

  // 2) Поиск MCP по русскому тексту статуса («ошибка»)
  t$.typeInto(input, "ошибка");
  await t$.flush();
  assert.equal($$(root, ".rp-mcp").length, 1, "найден сервер со статусом «ошибка»");
  assert.match($(root, ".rp-mcp").textContent, /foxtrot/);

  // 3) Очистка кнопкой × возвращает лимит 5 и «Показать все»
  const clearBtn = $(root, ".rp-search-clear");
  assert.ok(clearBtn, "кнопка очистки видна при непустом запросе");
  t$.click(clearBtn);
  await t$.flush();
  assert.equal(input.value, "");
  assert.equal($$(root, ".rp-mcp").length, 5, "вернулся лимит 5 у MCP");
  assert.equal($$(root, ".rp-skill").length, 5, "вернулся лимит 5 у Skills");
  assert.ok(byText(root, "button", "Показать все (8)"), "кнопка «Показать все (8)» вернулась");
});

test("FEAT-20.38: клик по Skill открывает модалку с Markdown (без frontmatter), admin видит path, тенант без path; Escape/подложка/× закрывают", async () => {
  const skills = [
    { id: "teleharness-xlsx", name: "teleharness-xlsx", description: "Excel-таблицы", path: "/skills/teleharness-xlsx/SKILL.md" },
    { id: "simplify", name: "simplify", description: "Упрощение кода" },
  ];
  let detailMode = "admin";
  installFetch([
    ...envRoutes({ mcpBody: SEVEN, skillsBody: skills }),
    {
      method: "GET",
      path: /^\/teleharness\/api\/skills\/(.+)$/,
      reply: () => {
        if (detailMode === "error") return { status: 503, body: { error: "Скиллы временно недоступны" } };
        if (detailMode === "tenant") {
          return {
            id: "teleharness-xlsx",
            name: "teleharness-xlsx",
            description: "Excel-таблицы",
            content: "---\nname: teleharness-xlsx\ndescription: Excel\n---\n# Инструкция\nИспользуй формулы.",
          };
        }
        return {
          id: "teleharness-xlsx",
          name: "teleharness-xlsx",
          description: "Excel-таблицы",
          path: "/skills/teleharness-xlsx/SKILL.md",
          content: "---\nname: teleharness-xlsx\n---\n# Инструкция\nИспользуй формулы.",
        };
      },
    },
  ]);

  const shell = document.createElement("div");
  shell.className = "shell";
  document.body.appendChild(shell);
  try {
    const { root } = t$.mount(ui.RightPanel, { id: SID });
    await t$.waitFor(() => $$(root, ".rp-skill").length === 2);

    // 1) Клик открывает модалку в портале document.body (admin: с path, без YAML frontmatter, фон inert)
    t$.click($$(root, ".rp-skill")[0]);
    await t$.waitFor(() => $(document.body, '.rp-modal[role="dialog"] .rp-modal-md') != null);
    const dialog = $(document.body, '.rp-modal[role="dialog"]');
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.equal(shell.hasAttribute("inert"), true, "BUG-304: .shell становится inert при открытом SkillModal");
    assert.match($(dialog, ".rp-modal-title").textContent, /teleharness-xlsx/);
    assert.match($(dialog, ".rp-modal-desc").textContent, /Excel-таблицы/);
    assert.match($(dialog, ".rp-modal-path").textContent, /\/skills\/teleharness-xlsx\/SKILL\.md/);
    assert.match($(dialog, ".rp-modal-md").textContent, /Инструкция/);
    assert.doesNotMatch($(dialog, ".rp-modal-md").textContent, /name:\s*teleharness-xlsx/, "YAML frontmatter срезан");

    // Закрытие по Escape снимает inert
    t$.act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await t$.flush();
    assert.equal($(document.body, '.rp-modal[role="dialog"]'), null, "Escape закрыл модальное окно");
    assert.equal(shell.hasAttribute("inert"), false, "inert снят после закрытия");

    // 2) Ошибка загрузки → «Повторить» → успех (ветка тенанта без path)
    detailMode = "error";
    t$.click($$(root, ".rp-skill")[1]);
    await t$.waitFor(() => $(document.body, ".rp-modal .rp-error") != null);
    assert.match($(document.body, ".rp-modal .rp-error").textContent, /временно недоступны/);

    detailMode = "tenant";
    t$.click($(document.body, ".rp-modal .rp-retry"));
    await t$.waitFor(() => $(document.body, ".rp-modal .rp-modal-md") != null);
    assert.equal($(document.body, ".rp-modal .rp-modal-path"), null, "тенанту path не отображается");

    // Закрытие по клику на подложку
    t$.click($(document.body, ".rp-modal-backdrop"));
    await t$.flush();
    assert.equal($(document.body, '.rp-modal[role="dialog"]'), null, "клик по подложке закрыл модальное окно");

    // Закрытие по кнопке ×
    t$.click($$(root, ".rp-skill")[0]);
    await t$.waitFor(() => $(document.body, ".rp-modal-close") != null);
    t$.click($(document.body, ".rp-modal-close"));
    await t$.flush();
    assert.equal($(document.body, '.rp-modal[role="dialog"]'), null, "кнопка × закрыла модальное окно");
  } finally {
    shell.remove();
  }
});

test("RightPanel & SkillModal localize into English when lang is en", async () => {
  ui.setLang("en");
  try {
    installFetch([
      ...envRoutes({
        mcpBody: mcp({ context7: { status: "connected" }, github: { status: "disabled" } }),
        skillsBody: [{ id: "teleharness-xlsx", name: "teleharness-xlsx", description: "Excel workbooks" }],
        planBody: { sessionID: "ses_en_1", todos: [{ id: "1", content: "Inspect endpoints", status: "completed" }] },
      }),
      {
        method: "GET",
        path: /^\/teleharness\/api\/skills\/(.+)$/,
        reply: () => ({
          id: "teleharness-xlsx",
          name: "teleharness-xlsx",
          description: "Excel workbooks",
          content: "# Excel\nUse formulas.",
        }),
      },
    ]);
    const { root } = t$.mount(ui.RightPanel, { id: "ses_en_1" });
    await t$.waitFor(() => $$(root, ".rp-mcp").length === 2 && $(root, ".rp-plan") != null);
    assert.equal($(root, ".rp-search-input").getAttribute("placeholder"), "Search MCP and Skills…");
    assert.match(root.textContent, /connected/);
    assert.match(root.textContent, /Plan for this turn/);
    t$.click($(root, ".rp-skill"));
    await t$.waitFor(() => $(document.body, '.rp-modal[role="dialog"] .rp-modal-md') != null);
    assert.equal($(document.body, ".rp-modal-close").getAttribute("aria-label"), "Close");
  } finally {
    ui.setLang("ru");
  }
});
