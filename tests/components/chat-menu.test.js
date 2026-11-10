// FEAT-01.69 — меню чата «⋯» (П31): шапка только с «⋯», меню из трёх
// пунктов, закрытие (Esc / мимо / повторный «⋯»), ветки ошибок Н1, Н2, Н4,
// Н5, Н6, Н7, Н8, Н9, Н12; группа «Закреплённые» на главной и в боковой
// панели, «Ещё N» (Н14), «⋯» строки боковой панели (У3).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    ChatView: "src/components/views/ChatView.jsx",
    HomeView: "src/components/views/HomeView.jsx",
    Drawer: "src/components/Drawer.jsx",
    menuItems: "src/components/ChatMenu.jsx#menuItems",
    menuPlacement: "src/components/ChatMenu.jsx#menuPlacement",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.sessions.value = [];
  s.pins.value = [];
  s.pinBusy.value = null;
  s.busyMap.value = {};
  s.active.value = null;
  s.setNotice(null);
  s.connection.value = { state: "online", restoredAt: null };
  s.me.value = null;
  installFetch();
});

const SID = "ses_menu";
const NOW = Date.now();
const SESSION = { id: SID, title: "Ремонт спойлера Audi", directory: "C:\\Users\\USER", time: { created: NOW, updated: NOW } };
const msg = (id, role, text) => ({
  info: { id, role, sessionID: SID, time: { created: NOW, completed: role === "assistant" ? NOW : undefined } },
  parts: [{ id: `p_${id}`, type: "text", text }],
});
const HISTORY = [msg("m1", "user", "Где купить привод спойлера?"), msg("m2", "assistant", "Нашёл три варианта")];

function routes(extra = [], { messages = HISTORY, list = () => [SESSION] } = {}) {
  installFetch([
    ...extra,
    { method: "GET", path: "/zai/api/session", reply: list },
    { method: "GET", path: `/zai/api/session/${SID}/message`, reply: () => messages },
    { method: "GET", path: "/zai/api/me/pins", reply: () => ({ ids: [], max: 200 }) },
  ]);
}

async function openChat(opts) {
  ui.store.sessions.value = [SESSION];
  const h = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(h.root, ".msg").length >= 2 || (opts?.empty && $(h.root, ".chat-greeting")));
  return h;
}
const dots = (root) => $(root, '.chat-header button[aria-label="Действия с чатом"]');
const menu = () => document.querySelector('.chat-menu[role="menu"]');
const item = (act) => menu()?.querySelector(`[data-act="${act}"]`);

test("menuItems: пустой чат — «Закрепить»/«Переименовать» неактивны с подсказкой; без сети — все с «Нет связи»; закреплённый — «Открепить»", () => {
  let it = ui.menuItems({ empty: true });
  assert.deepEqual(it.map((x) => x.label), ["Закрепить", "Переименовать", "Удалить"]);
  assert.equal(it[0].disabled, true);
  assert.equal(it[0].note, "Сначала отправьте сообщение");
  assert.equal(it[1].disabled, true);
  assert.equal(it[2].disabled, false, "пустой чат удалить можно (E3)");
  it = ui.menuItems({ offline: true });
  assert.ok(it.every((x) => x.disabled && x.note === "Нет связи"));
  it = ui.menuItems({ pinned: true });
  assert.equal(it[0].label, "Открепить");
  assert.equal(ui.menuItems({ pinning: true })[0].label, "…");
  assert.equal(ui.menuItems({ pinning: true })[0].disabled, true, "Н8: повторный тап во время запроса — без второго запроса");
});

test("menuPlacement: на 320 px меню не выходит за экран; внизу экрана — над кнопкой", () => {
  const p = ui.menuPlacement({ left: 268, right: 312, top: 8, bottom: 52 }, { vw: 320, vh: 640, width: 248, height: 168 });
  assert.ok(p.left >= 8 && p.left + p.width <= 312);
  assert.equal(p.top, 58);
  const up = ui.menuPlacement({ left: 268, right: 312, top: 600, bottom: 640 }, { vw: 320, vh: 660, height: 168 });
  assert.ok(up.top + 168 <= 600);
});

test("шапка: справа только «⋯» (≥ 40 px); стопа в шапке нет — он в композере; набран текст во время хода → «Стоп» слева от «⋯»", async () => {
  routes();
  const { root } = await openChat();
  assert.ok(dots(root));
  assert.equal($(root, ".chat-header .stop-btn"), null);
  assert.equal($(root, '.chat-header [aria-label="Новый чат"]'), null, "без «+ Новый чат»");
  ui.store.active.value = { ...ui.store.active.value, status: "busy" };
  await t$.flush();
  assert.equal($(root, ".chat-header .stop-btn"), null, "во время хода стоп — в композере");
  assert.ok($(root, '.composer button.send-btn[aria-label="Остановить"]'), "стоп в композере есть");
  t$.typeInto($(root, "textarea.composer-ta"), "досылка");
  await t$.flush();
  assert.ok($(root, '.chat-header .stop-btn[aria-label="Остановить"]'), "стоп композера уступил «Отправить» — шапка показывает «Стоп»");
});

test("У1: «⋯» открывает меню из трёх пунктов; Esc закрывает и возвращает фокус; повторный «⋯» и тап мимо закрывают", async () => {
  routes();
  const { root } = await openChat();
  t$.click(dots(root));
  assert.ok(menu(), "меню открыто");
  assert.deepEqual($$(menu(), '[role="menuitem"] .chat-menu-label').map((e) => e.textContent), ["Закрепить", "Переименовать", "Удалить"]);
  assert.ok(item("delete").classList.contains("is-danger"));
  assert.equal(dots(root).getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, item("pin"), "фокус на первом пункте");
  t$.key(document.activeElement, "ArrowDown");
  assert.equal(document.activeElement, item("rename"));
  t$.key(document.activeElement, "Escape");
  assert.equal(menu(), null);
  assert.equal(document.activeElement, dots(root));
  t$.click(dots(root));
  t$.click(dots(root));
  assert.equal(menu(), null, "повторный «⋯»");
  t$.click(dots(root));
  t$.fire(document.body, "pointerdown");
  assert.equal(menu(), null, "тап мимо");
});

test("У2: «Закрепить» → PUT /me/pins, в меню «Открепить»; Н1: сбой → откат + «Повторить», повтор закрепляет", async () => {
  let fail = true;
  routes([{ method: "PUT", path: "/zai/api/me/pins", reply: (c) => (fail ? { status: 500, body: { error: "x" } } : { ids: c.body.ids, max: 200 }) }]);
  const { root } = await openChat();
  t$.click(dots(root));
  t$.click(item("pin"));
  await t$.waitFor(() => ui.store.notice.value);
  assert.deepEqual(ui.store.pins.value, [], "булавка откатилась");
  assert.match(ui.store.notice.value, /Не удалось закрепить чат/);
  assert.equal(ui.store.noticeAction.value?.label, "Повторить");
  fail = false;
  ui.store.noticeAction.value.run();
  await t$.waitFor(() => ui.store.pins.value.includes(SID) && ui.store.pinBusy.value === null);
  assert.deepEqual(fetchCalls.filter((c) => c.method === "PUT").at(-1).body, { ids: [SID] });
  t$.click(dots(root));
  assert.match(item("pin").textContent, /Открепить/);
});

test("Н2: закрепление чата, удалённого на другом устройстве → 404 → «уже удалён», строка и закрепление исчезают, переход на главную", async () => {
  routes([{ method: "PUT", path: "/zai/api/me/pins", reply: () => ({ status: 404, body: { error: "chat not found" } }) }]);
  location.hash = "#/chat/" + SID;
  const { root } = await openChat();
  t$.click(dots(root));
  t$.click(item("pin"));
  await t$.waitFor(() => /уже удалён/.test(ui.store.notice.value ?? ""));
  assert.match(ui.store.notice.value, /«Ремонт спойлера Audi» уже удалён на другом устройстве/);
  assert.equal(ui.store.sessions.value.some((s) => s.id === SID), false);
  assert.deepEqual(ui.store.pins.value, []);
});

test("Н4: пустой новый чат — «Закрепить» и «Переименовать» неактивны, «Удалить» доступно", async () => {
  routes([], { messages: [] });
  const { root } = await openChat({ empty: true });
  t$.click(dots(root));
  assert.equal(item("pin").disabled, true);
  assert.match(item("pin").textContent, /Сначала отправьте сообщение/);
  assert.equal(item("rename").disabled, true);
  assert.equal(item("delete").disabled, false);
});

test("Н9: без сети пункты неактивны с пометкой «Нет связи»", async () => {
  routes();
  const { root } = await openChat();
  ui.store.connection.value = { state: "offline", restoredAt: null };
  t$.click(dots(root));
  assert.ok($$(menu(), '[role="menuitem"]').every((b) => b.disabled && /Нет связи/.test(b.textContent)));
});

test("Н5 + У5: удаление во время хода — предупреждение, сначала стоп, потом один DELETE; переход без записи в истории", async () => {
  routes([
    { method: "POST", path: `/zai/api/session/${SID}/abort`, reply: () => true },
    { method: "DELETE", path: `/zai/api/session/${SID}`, reply: () => true },
  ]);
  location.hash = "#/chat/" + SID;
  const { root } = await openChat();
  ui.store.active.value = { ...ui.store.active.value, status: "busy" };
  await t$.flush();
  t$.click(dots(root));
  t$.click(item("delete"));
  const dlg = await t$.waitFor(() => document.querySelector('.modal[aria-label="Удалить чат?"]'));
  assert.match(dlg.textContent, /«Ремонт спойлера Audi» будет удалён/);
  assert.match(dlg.textContent, /Ответ ещё идёт — он будет остановлен/);
  const del = byText(dlg, "button", "Удалить");
  t$.click(del);
  t$.click(del); // Н8: двойной тап
  await t$.waitFor(() => location.hash === "#/");
  const calls = fetchCalls.filter((c) => (c.method === "DELETE" || c.method === "POST") && c.path.startsWith(`/zai/api/session/${SID}`));
  assert.deepEqual(calls.map((c) => c.method), ["POST", "DELETE"], "abort → delete, одно удаление");
});

test("Н6: удаление не прошло — подтверждение закрылось, чат открыт и в списке, причина плашкой", async () => {
  routes([{ method: "DELETE", path: `/zai/api/session/${SID}`, reply: () => ({ status: 500, body: { error: "x" } }) }]);
  const { root } = await openChat();
  t$.click(dots(root));
  t$.click(item("delete"));
  t$.click(byText(document.querySelector(".modal"), "button", "Удалить"));
  await t$.waitFor(() => /Не удалось удалить чат/.test(ui.store.notice.value ?? ""));
  await t$.waitFor(() => !document.querySelector(".modal"));
  assert.match(ui.store.notice.value, /код 500/);
  assert.ok(ui.store.sessions.value.some((s) => s.id === SID), "чат в списке");
  assert.equal(ui.store.active.value?.id, SID, "чат остался открытым");
  assert.ok($$(root, ".msg").length >= 2, "лента на месте");
});

test("Н7: «Переименовать» — модалка с текущим именем; то же имя — без запроса; > 200 символов — счётчик и запрет; сбой — ошибка в модалке, имя на месте", async () => {
  routes([{ method: "PATCH", path: `/zai/api/session/${SID}`, reply: () => ({ status: 500, body: { error: "x" } }) }]);
  const { root } = await openChat();
  t$.click(dots(root));
  t$.click(item("rename"));
  const dlg = await t$.waitFor(() => document.querySelector('.modal[aria-label="Переименовать чат"]'));
  const input = $(dlg, "input");
  assert.equal(input.value, "Ремонт спойлера Audi");
  t$.click(byText(dlg, "button", "Сохранить"));
  await t$.flush();
  assert.equal(fetchCalls.some((c) => c.method === "PATCH"), false, "то же имя — без запроса");
  t$.click(dots(root));
  t$.click(item("rename"));
  const d2 = await t$.waitFor(() => document.querySelector('.modal[aria-label="Переименовать чат"]'));
  t$.typeInto($(d2, "input"), "я".repeat(201));
  assert.match($(d2, ".modal-count").textContent, /201 \/ 200/);
  assert.equal(byText(d2, "button", "Сохранить").disabled, true);
  t$.typeInto($(d2, "input"), "Привод спойлера");
  t$.click(byText(d2, "button", "Сохранить"));
  await t$.waitFor(() => $(d2, ".modal-error"));
  assert.match($(d2, ".modal-error").textContent, /Не удалось переименовать чат/);
  assert.equal($(d2, "input").value, "Привод спойлера", "введённое не потерялось");
});

test("Н2 (переименование): чат уже удалён — 404 → модалка закрыта, «уже удалён»", async () => {
  routes([{ method: "PATCH", path: `/zai/api/session/${SID}`, reply: () => ({ status: 404, body: { error: "session not found" } }) }]);
  const { root } = await openChat();
  t$.click(dots(root));
  t$.click(item("rename"));
  const dlg = await t$.waitFor(() => document.querySelector(".modal"));
  t$.typeInto($(dlg, "input"), "Новое имя");
  t$.click(byText(dlg, "button", "Сохранить"));
  await t$.waitFor(() => /уже удалён/.test(ui.store.notice.value ?? ""));
  assert.equal(document.querySelector(".modal"), null);
});

test("Н12: у «не найденного» чата «⋯» нет", async () => {
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => [] },
    { method: "GET", path: /\/zai\/api\/session\/[^/]+\/message$/, reply: () => ({ status: 404, body: { error: "nf" } }) },
  ]);
  const { root } = t$.mount(ui.ChatView, { id: "ses_gone" });
  await t$.waitFor(() => byText(root, "h2.hero", "Чат не найден"));
  assert.equal(dots(root), null);
});

const S = (id, title, ago = 0) => ({ id, title, directory: "C:\\Users\\USER", time: { created: NOW - ago, updated: NOW - ago } });

test("У2/Н3: главная — группа «Закреплённые» сверху с булавкой, в датах их нет; запись закрепления без чата не рисуется", async () => {
  const list = [S("s1", "Кто такой джейсон"), S("s2", "Ремонт спойлера Audi", 1000), S("s3", "Ревью и выкатка", 2000)];
  installFetch([{ method: "GET", path: "/zai/api/session", reply: () => list }]);
  ui.store.sessions.value = list;
  ui.store.pins.value = ["s3", "ghost", "s2"];
  const { root } = t$.mount(ui.HomeView);
  const groups = await t$.waitFor(() => $$(root, "section.group").length >= 2 && $$(root, "section.group"));
  assert.equal($(groups[0], ".group-label").textContent, "Закреплённые");
  assert.deepEqual($$(groups[0], ".session-title").map((e) => e.textContent), ["Ревью и выкатка", "Ремонт спойлера Audi"], "порядок закрепления, «призрака» нет");
  assert.equal($$(groups[0], ".row-pin").length, 2);
  const rest = groups.slice(1).flatMap((g) => $$(g, ".session-title").map((e) => e.textContent));
  assert.deepEqual(rest, ["Кто такой джейсон"]);
});

test("Н14: больше 6 закреплённых — первые 5 и «Ещё N»", async () => {
  const list = Array.from({ length: 9 }, (_, i) => S(`p${i}`, `Чат ${i}`, i * 1000));
  installFetch([{ method: "GET", path: "/zai/api/session", reply: () => list }]);
  ui.store.sessions.value = list;
  ui.store.pins.value = list.map((s) => s.id);
  const { root } = t$.mount(ui.HomeView);
  const g = await t$.waitFor(() => $(root, "section.group-pinned"));
  assert.equal($$(g, ".session-row").length, 5);
  const more = byText(g, "button", "Ещё 4");
  assert.ok(more);
  t$.click(more);
  assert.equal($$(g, ".session-row").length, 9);
});

test("боковая панель: «Закреплённые» над «Недавними», у строк — «⋯» с тем же меню (У3)", async () => {
  ui.store.me.value = { id: "admin", name: "admin", role: "admin" };
  ui.store.sessions.value = [S("s1", "Кто такой джейсон"), S("s2", "Ремонт спойлера Audi", 1000)];
  ui.store.pins.value = ["s2"];
  const { root } = t$.mount(ui.Drawer, { view: "home", chatId: null });
  const labels = $$(root, ".drawer-label").map((e) => e.textContent);
  assert.deepEqual(labels, ["Закреплённые", "Недавние"]);
  const pinned = $(root, ".drawer-pinned");
  assert.match(pinned.textContent, /Ремонт спойлера Audi/);
  assert.equal($(root, '.drawer-recent:not(.drawer-pinned)').textContent.includes("Ремонт"), false);
  const btn = $(pinned, '.drawer-row button.row-menu-btn[aria-haspopup="menu"]');
  assert.ok(btn);
  t$.click(btn);
  assert.equal(item("pin").textContent.includes("Открепить"), true);
  t$.key(document.activeElement, "Escape");
});
