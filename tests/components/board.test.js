// FEAT-20.2: «Доска внимания» — компонентные тесты на каждое состояние макета
// (design/mockups-v2/epic20-attention-board.html): четыре секции, порядок и
// время по часам сервера, ответ на разрешение (один запрос, устаревший ответ),
// «Отметить все» с подтверждением, сводка «Пока вас не было», пусто / загрузка /
// нет связи / источник недоступен / «удалён или недоступен», вкладка «Ждёт
// ревью» без источника, счётчик меню и «!», полоса на «Чатах», «(N)» во вкладке,
// «Ещё N» на телефоне, фильтр и поиск, меню «⋯», отметка просмотра открытием.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    BoardView: "src/components/views/BoardView.jsx",
    Drawer: "src/components/Drawer.jsx",
    MenuButton: "src/components/Menu.jsx#MenuButton",
    BoardStrip: "src/components/views/HomeView.jsx#BoardStrip",
    PushKindsRow: "src/components/views/NotificationsRow.jsx#PushKindsRow",
    attn: "src/lib/attention.js#board",
    attnStatus: "src/lib/attention.js#boardStatus",
    attnOffset: "src/lib/attention.js#boardOffset",
    refreshBoard: "src/lib/attention.js#refreshBoard",
    startBoard: "src/lib/attention.js#startBoard",
    stopBoard: "src/lib/attention.js#stopBoard",
    boardCounter: "src/lib/attention.js#boardCounter",
    titleWithCount: "src/lib/attention.js#titleWithCount",
    syncTitleBadge: "src/lib/attention.js#syncTitleBadge",
    timeText: "src/lib/attention.js#timeText",
    reasonText: "src/lib/attention.js#reasonText",
    shortPath: "src/lib/attention.js#shortPath",
    timeShort: "src/lib/attention.js#timeShort",
    modelLabel: "src/lib/attention.js#modelLabel",
    projectLabel: "src/lib/attention.js#projectLabel",
    ADMIN_NOTE_KEY: "src/components/views/BoardView.jsx#ADMIN_NOTE_KEY",
    plural: "src/lib/attention.js#plural",
    seenAfterVisible: "src/lib/attention.js#seenAfterVisible",
    onBoardEvent: "src/lib/attention.js#onBoardEvent",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.attn.value = null;
  ui.attnStatus.value = { loading: false, error: null, at: null };
  ui.attnOffset.value = 0;
  ui.store.connection.value = { state: "online", restoredAt: null };
  installFetch();
});

const NOW = Date.now();
const MIN = 60_000;
const it = (key, state, extra = {}) => ({
  key, kind: key.split(":")[0] === "run" ? "run" : "chat", state, reason: "turn", title: "Чат " + key, project: { name: "teleharness", dir: "/p/teleharness" },
  engine: "claude", model: "claude-opus-5-5", since: NOW - 5 * MIN, at: NOW - 5 * MIN, snippet: null, pinned: false, bgAgents: 0, silentMs: null,
  permission: null, href: "#/chat/" + key.split(":")[1], ...extra,
});
const counts = (items) => {
  const c = { needs: 0, review: 0, working: 0, done: 0, failed: 0, unknown: 0, snoozed: 0, older: 0 };
  for (const x of items) c[x.state] += 1;
  return c;
};
const answer = (items, extra = {}) => ({ now: NOW, epoch: "e1", counts: counts(items), items, sources: { opencode: "ok", claude: "ok", temporal: "ok", reviews: "off" }, projects: [{ dir: "/p/teleharness", name: "teleharness" }], truncated: null, reviews: null, away: null, admin: false, ...extra });
const FULL = [
  it("chat:old", "needs", { reason: "permission", since: NOW - 40 * MIN, at: NOW - 40 * MIN, title: "Миграция базы", permission: { id: "per_1", tool: "Bash", summary: "npm run migrate" } }),
  it("chat:new", "needs", { reason: "question", since: NOW - 3 * MIN, at: NOW - 3 * MIN }),
  it("run:wf1", "needs", { reason: "decision", engine: "temporal", title: "Ночное обновление", href: "#/temporal/run/wf1" }),
  it("chat:w1", "working", { reason: "bg", bgAgents: 2, since: NOW - 41 * MIN }),
  it("chat:w2", "working", { reason: "quiet", silentMs: 9 * MIN }),
  it("chat:d1", "done", { snippet: "Отчёт готов" }),
  it("chat:f1", "failed", { reason: "restart", at: new Date(2026, 10, 20, 3, 12).getTime() }),
];
const mountBoard = async (items, extra = {}, props = {}) => {
  installFetch([{ path: "/teleharness/api/attention", reply: () => answer(items, extra) }]);
  ui.attn.value = answer(items, extra);
  const h = t$.mount(ui.BoardView, props);
  await t$.flush();
  return h;
};

test("кр. 2, P-1: четыре секции с числами, значок и слово состояния, заголовки уровня 2", async () => {
  const { root } = await mountBoard(FULL);
  const heads = $$(root, ".bd-section h2").map((h) => h.getAttribute("aria-label"));
  assert.deepEqual(heads, ["Ждёт вас: 3", "Работает: 2", "Готово — не просмотрено: 1", "Упало или остановлено: 1"]);
  for (const li of $$(root, ".bd-item")) {
    assert.ok($(li, ".bd-icon svg"), "значок");
    assert.ok($(li, ".bd-state b").textContent.trim().length > 0, "слово состояния");
  }
  assert.equal($(root, '[data-key="chat:w1"] .bd-state b').textContent, "Фоном: 2 агента");
  assert.equal($(root, '[data-key="chat:w2"] .bd-state b').textContent, "Нет вестей 9 мин");
  assert.equal($(root, '[data-key="chat:f1"] .bd-state b').textContent, "Остановлен перезапуском сервера в 03:12");
  assert.equal($(root, '[data-key="run:wf1"] a.bd-main').getAttribute("href"), "#/temporal/run/wf1", "кр. 4: решение пайпа → экран запуска");
});

test("кр. 2, N-29: «ждёт 12 мин» — по часам сервера, а не телефона", async () => {
  ui.attnOffset.value = -2 * 3600_000; // телефон спешит на 2 ч
  const x = it("chat:p", "needs", { since: Date.now() - 2 * 3600_000 - 12 * MIN });
  assert.equal(ui.timeText(x, Date.now() + ui.attnOffset.value), "ждёт 12 мин");
  assert.equal(ui.timeText(it("chat:w", "working", { since: NOW - 41 * MIN }), NOW), "идёт 41 мин");
});

test("кр. 7, P-6, N-18: «Разрешить один раз» — один запрос при двойном нажатии", async () => {
  let calls = 0;
  let release;
  const { root } = await mountBoard(FULL);
  installFetch([
    { path: "/teleharness/api/attention", reply: () => answer(FULL) },
    { method: "POST", path: "/teleharness/api/permission/per_1/reply", reply: () => { calls += 1; return new Promise((r) => { release = () => r({ status: 200, body: true }); }); } },
  ]);
  const btn = $$(root, '[data-key="chat:old"] .bd-actions button')[0];
  assert.equal(btn.textContent, "Разрешить один раз");
  t$.click(btn);
  t$.click(btn);
  await t$.flush();
  assert.equal($$(root, '[data-key="chat:old"] .bd-actions button')[0].textContent, "Отправляю…");
  release();
  await t$.flush();
  assert.equal(calls, 1, "серверу ушёл один ответ");
  const sent = fetchCalls.find((c) => c.path === "/teleharness/api/permission/per_1/reply");
  assert.deepEqual(sent.body, { reply: "once" });
  assert.equal(sent.query.directory, "/p/teleharness");
  assert.equal($(root, '[data-key="chat:new"] .bd-actions a').textContent, "Ответить в чате", "вопрос — только в чате");
  assert.ok(!root.textContent.includes("Разрешить всегда"), "«всегда» — только в чате");
});

test("N-4: устаревший ответ (404) — «Уже ответили на другом устройстве», повтора нет", async () => {
  const { root } = await mountBoard(FULL);
  installFetch([
    { path: "/teleharness/api/attention", reply: () => answer(FULL.slice(1)) },
    { method: "POST", path: "/teleharness/api/permission/per_1/reply", reply: () => ({ status: 404, body: { error: "not found" } }) },
  ]);
  t$.click($$(root, '[data-key="chat:old"] .bd-actions button')[1]);
  await t$.flush();
  await t$.flush();
  assert.match(ui.store.notice.value, /Уже ответили на другом устройстве — «Миграция базы»/);
  assert.equal(fetchCalls.filter((c) => c.path.includes("/reply")).length, 1);
  ui.store.setNotice(null);
});

test("кр. 5, N-11: «Отметить все» > 5 — подтверждение с числом и upTo = версия доски", async () => {
  const many = Array.from({ length: 7 }, (_, i) => it("chat:d" + i, "done", { at: NOW - i * 1000 }));
  const { root } = await mountBoard(many);
  installFetch([{ path: "/teleharness/api/attention", reply: () => answer([]) }, { method: "POST", path: "/teleharness/api/attention/seen", reply: () => ({ ok: true, marked: 7 }) }]);
  t$.click($(root, ".is-done .bd-markall"));
  await t$.flush();
  const dlg = $(document.body, ".bd-dialog") ?? $(root, ".bd-dialog");
  assert.equal($(dlg, "h2").textContent, "Отметить 7 как просмотренные?");
  assert.equal(fetchCalls.filter((c) => c.path === "/teleharness/api/attention/seen").length, 0, "до подтверждения — ничего");
  t$.click($$(dlg, "button").find((b) => b.textContent === "Отметить 7"));
  await t$.flush();
  const call = fetchCalls.find((c) => c.path === "/teleharness/api/attention/seen");
  assert.deepEqual(call.body, { section: "done", upTo: NOW });
});

test("кр. 6, P-5: сводка «Пока вас не было» — числа, хронология по «Подробнее», «Понятно» на всех устройствах", async () => {
  const away = { since: NOW - 6 * 3600_000 - 20 * MIN, until: NOW, durationMs: 6 * 3600_000 + 20 * MIN, counts: { done: 4, failed: 1, needs: 0, runs: 1, limit: 1, relay: 1, restart: 0, crash: 0 },
    events: [{ at: NOW - 3 * 3600_000, kind: "relay", text: "Relay: «Отчёт» автоматически продолжен на GPT-6.1 Sol" }] };
  const { root } = await mountBoard(FULL, { away });
  const card = $(root, ".bd-away");
  assert.equal($(card, "h2").textContent, "Пока вас не было · 6 ч 20 мин");
  assert.deepEqual($$(card, ".bd-pill").map((p) => p.textContent), ["Готово 4", "Упало 1", "Пайпов завершено 1"]);
  t$.click($$(card, "button").find((b) => b.textContent.startsWith("Подробнее")));
  await t$.flush();
  assert.match($(card, ".bd-events").textContent, /GPT-6\.1 Sol/);
  installFetch([{ method: "POST", path: "/teleharness/api/attention/away-ack", reply: () => ({ ok: true }) }]);
  t$.click($$(card, "button").find((b) => b.textContent === "Понятно"));
  await t$.flush();
  assert.deepEqual(fetchCalls[0].body, { until: NOW });
  assert.equal($(root, ".bd-away"), null);
  assert.equal($$(root, ".is-done .bd-item").length, 1, "готовые остались непросмотренными");
});

test("N-1: пустая доска — «Всё спокойно», «Новый чат» и «Все чаты»", async () => {
  const { root } = await mountBoard([]);
  assert.equal($(root, ".bd-empty h2").textContent, "Всё спокойно");
  assert.ok($$(root, ".bd-empty button").some((b) => b.textContent === "Новый чат"));
  assert.equal($(root, '.bd-empty a[href="#/"]').textContent, "Все чаты");
});

test("N-2: загрузка — скелеты секций, без пустого состояния", async () => {
  let release;
  installFetch([{ path: "/teleharness/api/attention", reply: () => new Promise((r) => { release = () => r(answer([])); }) }]);
  const { root } = t$.mount(ui.BoardView, {});
  await t$.flush();
  assert.ok($(root, ".bd-skeleton[role=status]"));
  assert.equal($(root, ".bd-empty"), null);
  release(); // запрос доски не должен висеть для следующих тестов
  await t$.flush();
});

test("кр. 11, N-3: нет связи — прежние данные «данные на ЧЧ:ММ», приглушено, ответ недоступен; счётчик не обнулён", async () => {
  const { root } = await mountBoard(FULL);
  installFetch([{ path: "/teleharness/api/attention", reply: "network" }]);
  await ui.refreshBoard();
  ui.store.connection.value = { state: "offline", restoredAt: null };
  await t$.flush();
  assert.ok($(root, ".board-view.is-offline"));
  assert.match($(root, ".bd-banner.is-offline").textContent, /данные на \d\d:\d\d/);
  assert.equal($$(root, '[data-key="chat:old"] .bd-actions button')[0].getAttribute("aria-disabled"), "true");
  assert.equal(ui.attn.value.counts.needs, 3, "данные и счётчик прежние");
  const d = t$.mount(ui.Drawer, { view: "board", chatId: null }).root;
  assert.equal($(d, ".drawer-board").textContent, "3");
});

test("кр. 13, N-10, N-24: источник недоступен — пояснение; «Неизвестно — нет связи с opencode»", async () => {
  const items = [it("chat:oc", "unknown", { engine: "opencode", reason: "source-down" })];
  const { root } = await mountBoard(items, { sources: { opencode: "down", claude: "ok", temporal: "down", reviews: "off" } });
  assert.match(root.textContent, /Нет связи с opencode — состояние его чатов неизвестно/);
  assert.match(root.textContent, /Запуски Temporal сейчас недоступны/);
  assert.equal($(root, '[data-key="chat:oc"] .bd-state b').textContent, "Нет связи с opencode");
});

test("кр. 14, N-15: старая ссылка на чужой/удалённый элемент — «Чат удалён или недоступен» и «На доску»", async () => {
  location.hash = "#/board?item=chat:foreign";
  const { root } = await mountBoard(FULL);
  assert.equal($(root, ".bd-gone h2").textContent, "Чат удалён или недоступен");
  assert.equal($(root, '.bd-gone a[href="#/board"]').textContent, "На доску");
  location.hash = "#/board";
});

test("кр. 21, N-31: источник ревью выключен — вкладок нет; #/board/review объясняет причину, а не «Нечего проверять»", async () => {
  const { root } = await mountBoard(FULL);
  assert.equal($(root, ".bd-tabs"), null, "без FEAT-20.1 вкладка «Ждёт ревью» скрыта");
  t$.cleanup();
  const r = (await mountBoard(FULL, {}, { section: "review" })).root;
  assert.equal($(r, ".bd-gone h2").textContent, "Очередь ревью недоступна");
  assert.ok(!r.textContent.includes("Нечего проверять"));
});

test("кр. 21: при источнике ревью — вкладки «Всё / Ждёт ревью N»", async () => {
  const { root } = await mountBoard(FULL, { reviews: [], sources: { opencode: "ok", reviews: "ok" }, counts: { ...counts(FULL), review: 2 } });
  const tabs = $$(root, ".bd-tabs a").map((a) => a.textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(tabs, ["Всё", "Ждёт ревью 2"]);
  assert.equal($(root, ".bd-tabs a").getAttribute("aria-current"), "page");
});

// BUG-275 (BUG-20.13): вкладки были последним ребёнком .page-header — общее правило
// шапки (claude-look.css «> :last-child → колонка 3», 48 px) зажимало их в правый угол.
test("BUG-275: вкладки «Всё / Ждёт ревью N» — своей строкой под шапкой, не в колонке кнопки; подпись без переноса", async () => {
  const { readFileSync } = await import("node:fs");
  const { root } = await mountBoard(FULL, { reviews: [], sources: { opencode: "ok", reviews: "ok" }, counts: { ...counts(FULL), review: 1 } });
  const tabs = $(root, ".bd-tabs");
  assert.ok(tabs, "вкладки есть");
  assert.equal(tabs.closest(".page-header"), null, "вкладки вне сетки шапки (48px | 1fr | 48px)");
  assert.ok(tabs.previousElementSibling?.classList.contains("page-header"), "сразу под шапкой");
  assert.equal(tabs.getAttribute("role"), null);
  const css = readFileSync(new URL("../../src/components/board.css", import.meta.url), "utf8");
  const rule = /\.bd-tabs a \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /white-space:\s*nowrap/, "«Ждёт ревью N» не переносится");
  assert.match(rule, /min-height:\s*44px/, "тап-цель ≥ 44 px");
  assert.match(/\.bd-tabs \{([^}]*)\}/.exec(css)?.[1] ?? "", /justify-content:\s*center/);
});

test("кр. 9: на телефоне — 5 элементов секции и «Ещё N»; фильтр по проекту и поиск", async () => {
  const many = Array.from({ length: 8 }, (_, i) => it("chat:d" + i, "done", { at: NOW - i * 1000, title: i === 3 ? "Отчёт по продажам" : "Чат " + i, project: i < 2 ? { name: "other", dir: "/p/other" } : { name: "teleharness", dir: "/p/teleharness" } }));
  const prev = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  try {
    const { root } = await mountBoard(many, { projects: [{ dir: "/p/teleharness", name: "teleharness" }, { dir: "/p/other", name: "other" }] });
    assert.equal($$(root, ".is-done .bd-item").length, 5);
    const more = $(root, ".is-done .bd-moreitems");
    assert.equal(more.textContent, "Ещё 3");
    t$.click(more);
    await t$.flush();
    assert.equal($$(root, ".is-done .bd-item").length, 8);
    const sel = $(root, ".bd-select");
    sel.value = "/p/other";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await t$.flush();
    assert.equal($$(root, ".is-done .bd-item").length, 2);
    sel.value = "";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    const q = $(root, ".bd-search");
    q.value = "отчёт";
    q.dispatchEvent(new Event("input", { bubbles: true }));
    await t$.flush();
    assert.deepEqual($$(root, ".bd-item").map((li) => li.dataset.key), ["chat:d3"]);
  } finally {
    globalThis.matchMedia = prev;
  }
});

test("кр. 9, N-21: «Показаны 200 из 412 — уточните фильтр или поиск»", async () => {
  const { root } = await mountBoard(FULL, { truncated: { shown: 200, total: 412 } });
  assert.match(root.textContent, /Показаны 200 из 412 — уточните фильтр или поиск/);
});

test("кр. 8, P-8, P-14: меню «⋯» — отложить, закрепить, остановить ход с подтверждением", async () => {
  const { root } = await mountBoard(FULL);
  installFetch([
    { path: "/teleharness/api/attention", reply: () => answer(FULL) },
    { method: "POST", path: "/teleharness/api/attention/snooze", reply: () => ({ ok: true }) },
    { method: "POST", path: /\/abort$/, reply: () => ({ ok: true }) },
  ]);
  t$.click($(root, '[data-key="chat:d1"] .bd-more'));
  await t$.flush();
  const labels = $$(root, '[data-key="chat:d1"] .bd-menu [role=menuitem]').map((x) => x.textContent);
  assert.deepEqual(labels, ["Открыть", "Отметить просмотренным", "Отложить на 1 час", "Отложить до завтра 09:00", "Закрепить"]);
  t$.click($$(root, '[data-key="chat:d1"] .bd-menu [role=menuitem]').find((x) => x.textContent === "Отложить на 1 час"));
  await t$.flush();
  const sn = fetchCalls.find((c) => c.path === "/teleharness/api/attention/snooze");
  assert.equal(sn.body.key, "chat:d1");
  assert.ok(Math.abs(sn.body.until - (Date.now() + 3600_000)) < 5000);
  t$.click($(root, '[data-key="chat:w1"] .bd-more'));
  await t$.flush();
  t$.click($$(root, '[data-key="chat:w1"] .bd-menu [role=menuitem]').find((x) => x.textContent === "Остановить ход…"));
  await t$.flush();
  const dlg = $(document.body, ".bd-dialog") ?? $(root, ".bd-dialog");
  assert.equal($(dlg, "h2").textContent, "Остановить ход?");
  assert.match($(dlg, ".bd-dialog-text").textContent, /Фоновые агенты \(2\) тоже остановятся/);
  assert.equal(fetchCalls.filter((c) => c.path.endsWith("/abort")).length, 0);
  t$.click($$(dlg, "button").find((b) => b.textContent === "Остановить"));
  await t$.flush();
  assert.equal(fetchCalls.filter((c) => c.path === "/teleharness/api/session/w1/abort").length, 1);
});

test("кр. 12, N-7: «Продолжить» — чат с готовым сообщением, без автоотправки", async () => {
  const { root } = await mountBoard(FULL);
  installFetch([]);
  t$.click($$(root, '[data-key="chat:f1"] .bd-actions button').find((b) => b.textContent === "Продолжить"));
  await t$.flush();
  assert.equal(ui.store.loadDraft("f1"), "Продолжай с места остановки");
  assert.equal(location.hash, "#/chat/f1");
  assert.equal(fetchCalls.filter((c) => c.method === "POST").length, 0, "ничего не отправлено");
  ui.store.saveDraft("f1", "");
  location.hash = "#/board";
});

test("кр. 1, 21: пункт «Доска» первым, счётчик «ждёт вас»; при 0 и упавших — «!» с подписью; при 0/0 — нет", async () => {
  ui.attn.value = answer(FULL);
  let d = t$.mount(ui.Drawer, { view: "home", chatId: null }).root;
  const first = $(d, ".drawer-nav .drawer-item");
  assert.equal(first.getAttribute("href"), "#/board");
  assert.equal($(first, ".drawer-board").textContent, "3");
  assert.equal($(first, ".drawer-board").getAttribute("aria-label"), "3 ждут вас");
  assert.ok(!$$(d, ".drawer-nav .drawer-item").some((a) => a.textContent.includes("Ревью")), "пункта «Ревью» нет");
  t$.cleanup();
  ui.attn.value = answer([it("chat:f", "failed"), it("chat:g", "failed")]);
  d = t$.mount(ui.Drawer, { view: "home", chatId: null }).root;
  assert.equal($(d, ".drawer-board").textContent, "! 2");
  assert.equal($(d, ".drawer-board").getAttribute("aria-label"), "2 упало");
  assert.ok($(d, ".drawer-board.is-failed"));
  t$.cleanup();
  ui.attn.value = answer([]);
  d = t$.mount(ui.Drawer, { view: "home", chatId: null }).root;
  assert.equal($(d, ".drawer-board"), null);
  const btn = t$.mount(ui.MenuButton).root;
  assert.equal($(btn, ".menu-badge"), null);
});

test("кр. 16: заголовок вкладки «(N) …» и значок приложения", async () => {
  assert.equal(ui.titleWithCount("Чаты · Teleharness", 3), "(3) Чаты · Teleharness");
  assert.equal(ui.titleWithCount("(3) Чаты · Teleharness", 0), "Чаты · Teleharness");
  assert.equal(ui.titleWithCount("(3) Чаты", 5), "(5) Чаты");
  let badge = null;
  navigator.setAppBadge = async (n) => { badge = n; };
  navigator.clearAppBadge = async () => { badge = 0; };
  document.title = "Teleharness";
  ui.attn.value = answer(FULL);
  ui.syncTitleBadge();
  assert.equal(document.title, "(3) Teleharness");
  assert.equal(badge, 3);
  ui.attn.value = answer([]);
  ui.syncTitleBadge();
  assert.equal(document.title, "Teleharness");
  assert.equal(badge, 0);
  delete navigator.setAppBadge;
  delete navigator.clearAppBadge;
});

test("кр. 17, P-13: полоса на «Чатах» «Ждут вас 3 · Упало 1» → доска; при 0/0 — нет", async () => {
  let r = t$.mount(ui.BoardStrip, { counts: { needs: 3, failed: 1 } }).root;
  assert.equal($(r, "a.bd-strip").getAttribute("href"), "#/board");
  assert.match($(r, "a.bd-strip").textContent, /Ждут вас 3 · Упало 1/);
  t$.cleanup();
  r = t$.mount(ui.BoardStrip, { counts: { needs: 0, failed: 0 } }).root;
  assert.equal($(r, "a.bd-strip"), null);
});

test("кр. 5: отметка просмотра — открытие в видимом окне ≥ 2 с, только для «Готово»/«Упало»", async () => {
  ui.stopBoard();
  ui.attn.value = answer(FULL);
  const seen = new Set();
  installFetch([
    { path: "/teleharness/api/attention", reply: () => answer(FULL.filter((x) => !seen.has(x.key))) },
    { method: "POST", path: "/teleharness/api/attention/seen", reply: ({ body }) => { for (const k of body?.keys ?? []) seen.add(k); return { ok: true }; } },
  ]);
  const cancel = ui.seenAfterVisible("chat:d1", { delayMs: 30 });
  for (let i = 0; i < 40 && ui.attn.value.items.some((x) => x.key === "chat:d1"); i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.deepEqual(fetchCalls.find((c) => c.path === "/teleharness/api/attention/seen")?.body, { keys: ["chat:d1"] });
  assert.equal(ui.attn.value.items.some((x) => x.key === "chat:d1"), false);
  cancel();
  fetchCalls.length = 0;
  const c2 = ui.seenAfterVisible("chat:d1", { delayMs: 30 }); // уже отмечен локально — ушёл с доски
  const c3 = ui.seenAfterVisible("chat:w1", { delayMs: 30 }); // работает — не отмечается
  const c4 = ui.seenAfterVisible("chat:f1", { delayMs: 50 });
  c4(); // ушёл раньше 2 с — не отмечается
  await new Promise((r) => setTimeout(r, 80));
  c2();
  c3();
  assert.equal(fetchCalls.filter((c) => c.path === "/teleharness/api/attention/seen").length, 0);
});

test("кр. 10: доска перечитывается по событиям SSE (антидребезг), посторонние события — нет", async () => {
  ui.stopBoard();
  installFetch([{ path: "/teleharness/api/attention", reply: () => answer(FULL) }]);
  // До startBoard — молчит
  ui.onBoardEvent({ type: "session.idle", properties: { sessionID: "x" } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchCalls.length, 0, "до startBoard события игнорируются");

  try {
    ui.startBoard(60_000);
    await t$.waitFor(() => fetchCalls.some((c) => c.path === "/teleharness/api/attention"));
    fetchCalls.length = 0;

    // Постороннее событие SSE не запускает перечитку
    ui.onBoardEvent({ type: "message.part.updated", properties: { sessionID: "x" } });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(fetchCalls.length, 0, "посторонние события не триггерят /teleharness/api/attention");

    // Серия событий teleharness.attention схлопывается антидребезгом (200 мс) в один запрос
    ui.onBoardEvent({ type: "teleharness.attention", properties: { reason: "seen" } });
    ui.onBoardEvent({ type: "teleharness.attention", properties: { reason: "snooze" } });
    ui.onBoardEvent({ type: "teleharness.attention", properties: { reason: "done" } });
    await new Promise((r) => setTimeout(r, 280));
    const hits = fetchCalls.filter((c) => c.path === "/teleharness/api/attention");
    assert.equal(hits.length, 1, "три события подряд должны схлопнуться в один запрос");
  } finally {
    ui.stopBoard();
  }
});

test("кр. 15, P-11: «О чём сообщать» — три вида и тихие часы, сохранение для всех устройств", async () => {
  let saved = null;
  const prefs = { needs: true, failed: true, done: true, quiet: { on: false, from: "23:00", to: "08:00", tz: null } };
  const { root } = t$.mount(ui.PushKindsRow, { load: async () => prefs, save: async (p) => (saved = p) });
  await t$.flush();
  await t$.flush();
  const sw = $$(root, "button[role=switch]");
  assert.equal(sw.length, 4);
  assert.match(root.textContent, /Для всех ваших устройств/);
  t$.click(sw[2]); // «Готово»
  await t$.flush();
  assert.equal(saved.done, false);
  t$.click($$(root, "button[role=switch]")[3]); // тихие часы
  await t$.flush();
  assert.equal(saved.quiet.on, true);
  assert.match(root.textContent, /23:00–08:00 · «Готово» и «Упало» придут одной сводкой в 08:00/);
});

test("формы числа и тексты состояния; путь проекта режется с начала", () => {
  assert.deepEqual([1, 2, 5, 11, 21, 22].map((n) => ui.plural(n, "чат", "чата", "чатов")), ["чат", "чата", "чатов", "чатов", "чат", "чата"]);
  assert.equal(ui.reasonText(it("chat:a", "needs", { reason: "permission", agent: "Explore" })), "Разрешение у агента Explore");
  assert.equal(ui.reasonText(it("chat:a", "failed", { reason: "stalled" })), "Остановлен: ход завис");
  assert.equal(ui.reasonText(it("chat:a", "failed", { reason: "auth", engine: "claude", snippet: "Движок недоступен — сообщите администратору" })), "Движок Claude недоступен");
  assert.equal(ui.reasonText(it("chat:a", "failed", { reason: "auth", engine: "claude", snippet: "Нужен вход" })), "Нужен вход в Claude");
  assert.equal(ui.shortPath("/srv/projects/very/long/path/packages/epic20/attention-board", 28), "…/epic20/attention-board");
  assert.equal(ui.boardCounter({ needs: 0, failed: 0 }), null);
});

test("кр. 10 (dogfood 2026-11-20): доска, открытая первым экраном, поднимает поток событий и списки (init)", async () => {
  installFetch([{ path: "/teleharness/api/attention", reply: () => answer(FULL) }, { path: "/teleharness/api/session", reply: () => [] }]);
  t$.mount(ui.BoardView, {});
  await t$.flush();
  assert.ok(fetchCalls.some((c) => c.path === "/teleharness/api/session"), "init() вызван — SSE и список чатов подняты");
});

test("время: меньше минуты — словами, а не «0 мин»", () => {
  assert.equal(ui.timeText({ state: "needs", since: NOW - 10_000 }, NOW), "ждёт меньше минуты");
});

// ---- BUG-277: вёрстка доски (скриншот прода 2.3.0, «Шо это за треш с версткой») ----
const boardCss = () => readFileSync(new URL("../../src/components/board.css", import.meta.url), "utf8");

test("BUG-277: мета карточки — человеческое имя модели, без домашней папки, копия → репозиторий", async () => {
  const items = [
    it("chat:h", "working", { reason: "bg", bgAgents: 1, project: { name: "USER", dir: "C:\\Users\\USER" }, model: "claude-opus-5-5" }),
    it("chat:p", "done", { project: { name: "teleharness", dir: "/p/teleharness" }, model: "glm-5.3-flash", engine: "opencode" }),
    it("chat:w", "done", { project: { name: "v-fayle-src-orders-js-dobav-meis", dir: "/p/.teleharness-worktrees/shop/v-fayle-src-orders-js-dobav-meis" }, model: "claude-haiku-4-5" }),
  ];
  const { root } = await mountBoard(items);
  assert.equal($(root, '[data-key="chat:h"] .bd-meta').textContent, "Claude Opus 5.5");
  assert.equal($(root, '[data-key="chat:p"] .bd-meta').textContent, "teleharness · GLM-5.3-Flash");
  assert.equal($(root, '[data-key="chat:w"] .bd-meta').textContent, "shop · Claude Haiku 4.5");
  assert.doesNotMatch($(root, ".bd-columns").textContent, /claude-opus-5-5|USER|v-fayle/);
});

test("BUG-277: время на карточке — коротко и без глагола; полное — в подписи", async () => {
  const { root } = await mountBoard([it("chat:x", "working", { since: NOW - (10 * 60 + 16) * MIN })]);
  assert.equal($(root, '[data-key="chat:x"] .bd-time').textContent, "10 ч 16");
  assert.match($(root, '[data-key="chat:x"] a.bd-main').getAttribute("aria-label"), /идёт 10 ч 16 мин/);
  assert.equal(ui.timeShort({ state: "needs", since: NOW - 12 * MIN }, NOW), "12 мин");
  assert.equal(ui.timeShort({ state: "working", since: NOW - 65 * MIN }, NOW), "1 ч 05");
  assert.equal(ui.modelLabel("claude-sonnet-5"), "Claude Sonnet 5");
  assert.equal(ui.projectLabel({ name: "al", dir: "/home/al" }), "");
  assert.match(boardCss(), /\.bd-time \{[^}]*white-space: nowrap/);
  assert.match(boardCss(), /\.bd-meta \{[^}]*text-overflow: ellipsis; white-space: nowrap/);
});

test("BUG-277: «Пока вас не было» без чисел — нет пустого блока; длительность не переносится; кнопки одним рядом", async () => {
  const away = { since: NOW - 616 * MIN, until: NOW, durationMs: 616 * MIN, counts: { done: 0, failed: 0, needs: 0, runs: 0, restart: 8, crash: 1 },
    events: [{ at: NOW - 300 * MIN, kind: "restart", text: "Сервер перезапущен в 11:32" }] };
  const { root } = await mountBoard(FULL, { away });
  const card = $(root, ".bd-away");
  assert.equal($(card, ".bd-pills"), null, "пустой ряд чисел не рендерится");
  assert.equal($(card, "h2 .bd-nowrap").textContent, "10 ч 16 мин");
  assert.deepEqual($$(card, ".bd-away-foot button").map((b) => b.textContent), ["Подробнее (1)", "Понятно"]);
  assert.match(boardCss(), /\.bd-nowrap \{ white-space: nowrap; \}/);
});

test("BUG-277: подсказка admin «Доска показывает только ваше…» — один раз, «Понятно» скрывает навсегда", async () => {
  localStorage.removeItem(ui.ADMIN_NOTE_KEY);
  const tenant = await mountBoard(FULL, { admin: false });
  assert.equal($(tenant.root, ".bd-note-admin"), null, "тенанту не показывается");
  t$.cleanup();
  const { root } = await mountBoard(FULL, { admin: true });
  assert.match($(root, ".bd-note-admin").textContent, /Мониторинге/);
  t$.click($(root, ".bd-note-admin button"));
  await t$.flush();
  assert.equal($(root, ".bd-note-admin"), null);
  assert.equal(localStorage.getItem(ui.ADMIN_NOTE_KEY), "1");
  t$.cleanup();
  const again = await mountBoard(FULL, { admin: true });
  assert.equal($(again.root, ".bd-note-admin"), null, "после «Понятно» не возвращается");
  localStorage.removeItem(ui.ADMIN_NOTE_KEY);
});

test("BUG-277: на ≤ 360 px кнопки ответа в столбце — без flex-basis (иначе кнопка-овал 140 px высотой)", () => {
  const css = boardCss();
  const phone = css.indexOf("@media (max-width: 767px)");
  const narrowAfter = css.indexOf("@media (max-width: 360px)", phone);
  assert.ok(phone > 0 && narrowAfter > phone, "правило ≤ 360 стоит после правила телефона");
  assert.match(css.slice(narrowAfter), /\.bd-actions \.bd-btn \{ flex: none; \}/);
});

test("TASK-20.34 п.2 / FEAT-20.2: на ≥ 768 px клик по карточке открывает preview pane справа без авто-markSeen", async () => {
  const { root } = await mountBoard(FULL);
  installFetch([
    { path: "/teleharness/api/attention", reply: () => answer(FULL) },
    { method: "POST", path: "/teleharness/api/attention/seen", reply: () => ({ ok: true, marked: 1 }) },
  ]);
  assert.equal($(root, ".bd-preview"), null);
  t$.click($(root, '[data-key="chat:d1"] a.bd-main'));
  await t$.flush();
  const pv = $(root, ".bd-preview");
  assert.ok(pv, "панель предпросмотра открыта");
  assert.match(pv.textContent, /Отчёт готов/);
  assert.equal($(pv, "a.bd-primary").textContent, "Открыть чат");
  assert.equal($(pv, "a.bd-primary").getAttribute("href"), "#/chat/d1");
  assert.equal(fetchCalls.filter((c) => c.path === "/teleharness/api/attention/seen").length, 0, "предпросмотр не вызывает markSeen");
  assert.ok($(root, '[data-key="chat:d1"]').classList.contains("is-selected"));
  const seenBtn = $$(pv, "button").find((b) => b.textContent === "Отметить просмотренным");
  t$.click(seenBtn);
  await t$.flush();
  assert.equal(fetchCalls.filter((c) => c.path === "/teleharness/api/attention/seen").length, 1);
  t$.click($(pv, ".bd-preview-close"));
  await t$.flush();
  assert.equal($(root, ".bd-preview"), null);
});

test("TASK-20.34 п.2 / FEAT-20.2: на телефоне (< 768 px) preview pane не открывается; на вкладке «Ждёт ревью» на десктопе работает", async () => {
  const prevMM = globalThis.matchMedia;
  try {
    globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    const { root } = await mountBoard(FULL);
    t$.click($(root, '[data-key="chat:d1"] a.bd-main'));
    await t$.flush();
    assert.equal($(root, ".bd-preview"), null, "на телефоне предпросмотр не открывается");
  } finally {
    globalThis.matchMedia = prevMM;
    t$.cleanup();
  }
  const reviews = [{ id: "rv_1", key: "review:rv_1", status: "waiting", revision: 2, title: "Править парсер", source: "chat", project: { name: "app", dir: "/p/app" }, turns: 2, files: 3, additions: 14, deletions: 5, drafts: 1, model: "claude-sonnet-5", since: NOW - 10 * MIN, href: "#/review/rv_1" }];
  const { root } = await mountBoard([], { sources: { opencode: "ok", claude: "ok", temporal: "ok", reviews: "ok" }, reviews, counts: { ...counts([]), review: 1 } }, { section: "review" });
  t$.click($(root, ".rq-item"));
  await t$.flush();
  const pv = $(root, ".bd-preview");
  assert.ok(pv, "предпросмотр ревью открыт");
  assert.match(pv.textContent, /Править парсер/);
  assert.equal($(pv, "a.bd-primary").textContent, "Открыть ревью");
  assert.equal($(pv, "a.bd-primary").getAttribute("href"), "#/review/rv_1");
});
