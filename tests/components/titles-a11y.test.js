// zai 1.7.2 (openspec bugfix-1.7.2), L2: chat titles live in the list and the
// header (BUG-01.27 / BUG-083 client half), quiet loadError (BUG-01.19),
// accessibility (BUG-01.38: one h1, live regions, modal focus) and the Tab
// order of row actions (BUG-01.44).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    HomeView: "src/components/views/HomeView.jsx",
    SessionRow: "src/components/views/HomeView.jsx#SessionRow",
    ChatView: "src/components/views/ChatView.jsx",
    dialogAnnouncement: "src/components/views/ChatView.jsx#dialogAnnouncement",
    MessageList: "src/components/chat/MessageList.jsx",
    PickerSheet: "src/components/Pickers.jsx#PickerSheet",
    DeleteModal: "src/components/views/HomeView.jsx#DeleteModal",
    TokenModal: "src/components/views/AccessSection.jsx#TokenModal",
    FileViewer: "src/components/chat/FileViewer.jsx",
    ProjectsView: "src/components/views/ProjectsView.jsx",
    ProjectView: "src/components/views/ProjectView.jsx",
    SettingsView: "src/components/views/SettingsView.jsx",
    LoginView: "src/components/views/LoginView.jsx",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.sessions.value = [];
  s.dialogs.value = [];
  s.firstTexts.value = {};
  s.active.value = null;
  installFetch();
});

const NOW = Date.now();
const DIR = "C:\\Users\\USER";
const ses = (id, title, extra = {}) => ({ id, title, directory: DIR, time: { created: NOW, updated: NOW }, ...extra });
const msg = (sid, id, role, text) => ({
  info: { id, role, sessionID: sid, time: { created: NOW, completed: role === "assistant" ? NOW : undefined } },
  parts: [{ id: `p_${id}`, type: "text", text }],
});
const rowTitles = (root) => $$(root, ".session-title").map((el) => el.textContent);

async function mountHome(list) {
  installFetch([{ method: "GET", path: "/zai/api/session", reply: () => list }]);
  ui.store.sessions.value = list;
  const h = t$.mount(ui.HomeView);
  await t$.waitFor(() => $$(h.root, ".session-title").length >= list.length);
  return h;
}

// ---- BUG-01.27 / BUG-083: titles ------------------------------------------------

test("список: заголовок сервера; без заголовка — начало первого вопроса (если известен), иначе «Без названия»", async () => {
  ui.store.firstTexts.value = { ses_b: "Посчитай выручку за март по филиалам" };
  const { root } = await mountHome([
    ses("ses_a", "Отчёт по продажам"),
    ses("ses_b", ""),
    ses("ses_c", "New session - 2026-11-03T10:00:00.000Z"),
  ]);
  assert.deepEqual(rowTitles(root).sort(), ["Без названия", "Отчёт по продажам", "Посчитай выручку за март по филиалам"].sort());
});

test("список: заголовок, пересказывающий снапшот кэша, заменяется началом вопроса (как в шапке)", async () => {
  const injected =
    "[obsidian-cache] Активный кэш проекта «user», собран 2026-11-02 07:02.\n\nzai.home.example.net HTTPS IPv6\n\n---\n\nОтветь одним словом: столица Италии?";
  ui.store.firstTexts.value = { ses_s: injected };
  const { root } = await mountHome([ses("ses_s", "zai.home.example.net HTTPS IPv6")]);
  assert.deepEqual(rowTitles(root), ["Ответь одним словом: столица Италии?"]);
});

test("список: новый заголовок по SSE (session.updated и zai.session.title) виден без перезагрузки", async () => {
  const { root } = await mountHome([ses("ses_a", ""), ses("ses_b", "")]);
  assert.deepEqual(rowTitles(root), ["Без названия", "Без названия"]);
  t$.act(() => ui.store.handleEvent({ type: "session.updated", properties: { info: { ...ses("ses_a", "Сводка продаж") } } }));
  t$.act(() => ui.store.handleEvent({ type: "zai.session.title", properties: { sessionID: "ses_b", title: "Столица Италии" } }));
  await t$.flush();
  assert.deepEqual(rowTitles(root).sort(), ["Сводка продаж", "Столица Италии"]);
  // aria-label действий строки тоже с новым именем
  assert.equal(!!$$(root, "button").find((b) => b.getAttribute("aria-label") === "Переименовать чат «Столица Италии»"), true);
});

test("ручное переименование уходит PATCH-ем с title, как раньше", async () => {
  const patches = [];
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => [ses("ses_a", "Отчёт")] },
    { method: "PATCH", path: "/zai/api/session/ses_a", reply: (c) => (patches.push(c.body), { ...ses("ses_a", c.body.title) }) },
  ]);
  ui.store.sessions.value = [ses("ses_a", "Отчёт")];
  const { root } = t$.mount(ui.HomeView);
  const btn = await t$.waitFor(() => $$(root, "button").find((b) => /^Переименовать чат/.test(b.getAttribute("aria-label") ?? "")));
  t$.click(btn);
  t$.typeInto(await t$.waitFor(() => $(root, ".modal-input")), "Квартал");
  t$.click(byText(root, ".modal button", "Сохранить"));
  await t$.waitFor(() => !$(root, ".modal"));
  assert.deepEqual(patches, [{ title: "Квартал" }]);
  assert.deepEqual(rowTitles(root), ["Квартал"]);
});

const SID = "ses_cv";
function chatRoutes({ list = [ses(SID, "")], messages = [msg(SID, "m1", "user", "Сколько стоит доставка?"), msg(SID, "m2", "assistant", "500 ₽")], msgStatus = 200 } = {}) {
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => list },
    { method: "GET", path: `/zai/api/session/${SID}/message`, reply: () => (msgStatus === 200 ? messages : { status: msgStatus, body: { error: "not found" } }) },
  ]);
}

test("шапка: без заголовка — первый вопрос; заголовок от сервера (zai.session.title) заменяет его сразу; вкладка браузера тоже", async () => {
  chatRoutes();
  ui.store.sessions.value = [ses(SID, "")];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length >= 2);
  assert.equal($(root, "h1.chat-title").textContent, "Сколько стоит доставка?");
  assert.equal(ui.store.firstTexts.value[SID], "Сколько стоит доставка?", "первый вопрос запомнен для списка");
  t$.act(() => ui.store.handleEvent({ type: "zai.session.title", properties: { sessionID: SID, title: "Стоимость доставки" } }));
  await t$.flush();
  assert.equal($(root, "h1.chat-title").textContent, "Стоимость доставки");
  assert.equal(document.title, "Стоимость доставки · Teleharness");
});

test("BUG-099: перезагрузка чата — пока список чатов не пришёл, шапка не показывает ни «Без названия», ни первый вопрос, ни сырой id модели", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const withModel = [msg(SID, "m1", "user", "Сколько стоит доставка?"), { ...msg(SID, "m2", "assistant", "500 ₽"), info: { ...msg(SID, "m2", "assistant", "500 ₽").info, modelID: "glm-5.3-flash" } }];
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: async () => { await gate; return [ses(SID, "Стоимость доставки")]; } },
    { method: "GET", path: `/zai/api/session/${SID}/message`, reply: () => withModel },
  ]);
  ui.store.sessions.value = [];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  // BUG-01.19: a chat not yet in the list waits for the list before its
  // history — the header stays blank all that time.
  await t$.flush(10);
  const h1 = $(root, "h1.chat-title").textContent.trim();
  assert.equal(h1, "", "до списка — пустой заголовок (без мигания)");
  assert.ok(!$(root, ".chat-sub").textContent.includes("glm-5.3-flash"), "без сырого id модели");
  release();
  await t$.waitFor(() => $$(root, ".msg").length >= 2);
  assert.equal($(root, "h1.chat-title").textContent, "Стоимость доставки");
});

// ---- BUG-01.19: quiet loadError --------------------------------------------------

async function watchConsole(fn) {
  const errors = [];
  const rejections = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...a) => errors.push(a.map(String).join(" "));
  console.warn = (...a) => errors.push(a.map(String).join(" "));
  const onRej = (r) => rejections.push(String(r?.message ?? r));
  process.on("unhandledRejection", onRej);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    console.error = origError;
    console.warn = origWarn;
    process.off("unhandledRejection", onRej);
  }
  return { errors, rejections };
}

test("BUG-01.19: 404 истории (чат удалён) → «Чат не найден» без console.error и необработанных reject", async () => {
  const { errors, rejections } = await watchConsole(async () => {
    chatRoutes({ list: [], msgStatus: 404 });
    const { root } = t$.mount(ui.ChatView, { id: SID });
    await t$.waitFor(() => byText(root, "h2.hero", "Чат не найден"));
    t$.cleanup();
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(rejections, []);
});

test("BUG-01.19: история упала (чат в списке) → «История не загрузилась»; «Повторить» с той же 404 — тоже тихо", async () => {
  const { errors, rejections } = await watchConsole(async () => {
    chatRoutes({ list: [ses(SID, "Отчёт")], msgStatus: 404 });
    ui.store.sessions.value = [ses(SID, "Отчёт")];
    const { root } = t$.mount(ui.ChatView, { id: SID });
    await t$.waitFor(() => byText(root, "h2.hero", "История не загрузилась"));
    t$.click(byText(root, "button.empty-cta", "Повторить"));
    await t$.flush(10);
    await t$.waitFor(() => byText(root, "h2.hero", "История не загрузилась"));
    t$.cleanup();
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(rejections, []);
});

// The browser itself logs every 404 response as a raw console error — no
// console.* hook catches it; the only quiet 404 is the one never asked.
const historyAsks = () => fetchCalls.filter((c) => c.path === `/zai/api/session/${SID}/message`);

test("BUG-01.19: открытие удалённого чата по ссылке — история не запрашивается (нет 404 в консоли браузера), «Чат не найден»", async () => {
  chatRoutes({ list: [ses("ses_other", "Другой")], msgStatus: 404 });
  ui.store.sessions.value = [];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => byText(root, "h2.hero", "Чат не найден"));
  assert.deepEqual(historyAsks(), [], "GET …/message не было");
  // resync/idle по SSE тоже не переспрашивает историю удалённого чата
  await ui.store.resync();
  await t$.flush(10);
  assert.deepEqual(historyAsks(), []);
  assert.equal(!!byText(root, "h2.hero", "Чат не найден"), true);
});

test("BUG-01.19: чат, которого ещё нет в локальном списке (создан в другой вкладке), — список обновляется, история грузится", async () => {
  chatRoutes({ list: [ses(SID, "Из другой вкладки")] });
  ui.store.sessions.value = [ses("ses_other", "Другой")];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length >= 2);
  assert.equal(historyAsks().length, 1);
  assert.equal($(root, "h1.chat-title").textContent, "Из другой вкладки");
});

test("BUG-01.19: список не загрузился — нельзя сказать, что чата нет: история запрашивается как раньше", async () => {
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => ({ status: 503, body: { error: "down" } }) },
    { method: "GET", path: `/zai/api/session/${SID}/message`, reply: () => [msg(SID, "m1", "user", "Привет"), msg(SID, "m2", "assistant", "Здравствуйте")] },
  ]);
  ui.store.sessions.value = [];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length >= 2);
  assert.equal(historyAsks().length, 1);
});

// ---- BUG-01.38: one h1, live regions, focus ----------------------------------------

test("BUG-01.38: один h1 на экране — «Чаты» и экран чата", async () => {
  const home = await mountHome([ses("ses_a", "Отчёт")]);
  assert.equal($$(home.root, "h1").length, 1);
  t$.cleanup();
  chatRoutes();
  ui.store.sessions.value = [ses(SID, "Отчёт")];
  const chat = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(chat.root, ".msg").length >= 2);
  assert.equal($$(chat.root, "h1").length, 1);
  assert.equal($$(document, "h1").length, 1, "и во всём документе");
});

test("BUG-01.38: лента — постоянный polite-регион: «Агент работает над ответом» → «Агент ответил»; сама лента не live", async () => {
  const user = msg(SID, "u1", "user", "Привет");
  const asst = msg(SID, "a1", "assistant", "Здравствуйте");
  const h = t$.mount(ui.MessageList, { sessionId: SID, messages: [user], streamingId: null, busy: false });
  const region = $(h.root, '.chat-scroll-wrap > .sr-only[role="status"][aria-live="polite"]');
  assert.equal(!!region, true, "регион есть до события");
  assert.equal(region.textContent, "");
  assert.equal($(h.root, ".chat-messages").hasAttribute("aria-live"), false, "дельты стрима не зачитываются");
  h.rerender({ busy: true });
  await t$.waitFor(() => region.textContent === "Агент работает над ответом");
  assert.equal($(h.root, ".chat-scroll-wrap > .sr-only"), region, "тот же узел");
  // FEAT-03.19: по умолчанию («Детализация выполнения» выкл.) индикатор хода —
  // прелоадер; точки набора (режим «вкл.») проверяет tests/components/exec-detail.test.js.
  assert.equal(!!$(h.root, '.turn-preloader[role="status"]'), true, "индикатор хода — status");
  h.rerender({ busy: false, messages: [user, asst] });
  await t$.waitFor(() => region.textContent === "Агент ответил");
});

test("BUG-01.38: копирование своего сообщения озвучивается постоянным регионом; визуальная плашка aria-hidden", async () => {
  const user = msg(SID, "u1", "user", "Привет");
  const h = t$.mount(ui.MessageList, { sessionId: SID, messages: [user], streamingId: null, busy: false });
  const region = $(h.root, '.msg-user .sr-only[role="status"]');
  assert.equal(!!region, true, "регион есть до копирования");
  assert.equal(region.textContent, "");
  t$.fire($(h.root, ".msg-user"), "contextmenu", {}, MouseEvent);
  await t$.waitFor(() => /Скопировано|Не удалось скопировать/.test(region.textContent));
  assert.equal($(h.root, ".copy-flash").getAttribute("aria-hidden"), "true");
});

test("BUG-01.38: карточка разрешения/вопроса озвучивается постоянным регионом экрана чата", async () => {
  assert.equal(ui.dialogAnnouncement(null), "");
  assert.equal(ui.dialogAnnouncement({ kind: "permission", command: "rm -rf build" }), "Агент просит разрешение: rm -rf build");
  assert.equal(ui.dialogAnnouncement({ kind: "question", questions: [{ question: "Какой формат?" }] }), "Вопрос агента: Какой формат?");
  chatRoutes();
  ui.store.sessions.value = [ses(SID, "Отчёт")];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length >= 2);
  const region = $(root, '.chat > .sr-only[role="status"][aria-live="polite"]');
  assert.equal(!!region, true);
  assert.equal(region.textContent, "");
  t$.act(() => {
    ui.store.dialogs.value = [{ kind: "permission", id: "per_1", sessionID: SID, permission: "bash", command: "npm test", patterns: [], always: [] }];
  });
  await t$.flush();
  assert.equal(region.textContent, "Агент просит разрешение: npm test");
  assert.equal(!!$(root, ".dlg-card"), true);
});

test("BUG-01.38: модалка переименования — Tab по кругу внутри, Escape закрывает и возвращает фокус на ✎", async () => {
  const { root } = await mountHome([ses("ses_a", "Отчёт")]);
  const pencil = $$(root, "button").find((b) => b.getAttribute("aria-label") === "Переименовать чат «Отчёт»");
  pencil.focus();
  t$.click(pencil);
  const input = await t$.waitFor(() => $(root, ".modal-input"));
  await t$.flush();
  assert.equal(document.activeElement, input, "фокус в поле");
  const modal = $(root, ".modal");
  const inside = [...modal.querySelectorAll("input, button:not([disabled])")];
  const last = inside.at(-1);
  // Shift+Tab с первого → последний; Tab с последнего → первый
  input.focus();
  t$.key(input, "Tab", { shiftKey: true });
  assert.equal(document.activeElement, last);
  t$.key(last, "Tab");
  assert.equal(document.activeElement, input);
  // фокус «под фоном» возвращается внутрь
  pencil.focus();
  t$.key(pencil, "Tab");
  assert.equal(modal.contains(document.activeElement), true);
  t$.key(input, "Escape");
  await t$.waitFor(() => !$(root, ".modal"));
  await t$.flush();
  assert.equal(document.activeElement, pencil, "фокус вернулся на вызвавшую кнопку");
});

test("BUG-01.38: шит выбора — фон inert, Tab удерживается, закрытие возвращает фокус", async () => {
  const shell = document.createElement("div");
  shell.className = "shell";
  const opener = document.createElement("button");
  opener.textContent = "Модель";
  shell.appendChild(opener);
  document.body.appendChild(shell);
  opener.focus();
  let open = true;
  const close = () => (open = false);
  const h = t$.mount(ui.PickerSheet, { title: "Модель чата", onClose: close, children: ui.h("button", { type: "button", class: "pick" }, "GLM") });
  await t$.flush();
  assert.equal(shell.hasAttribute("inert"), true, "фон inert");
  const sheet = $(document.body, ".sheet");
  const btns = [...sheet.querySelectorAll("button")];
  btns.at(-1).focus();
  t$.key(btns.at(-1), "Tab");
  assert.equal(document.activeElement, btns[0], "Tab с последнего — на первый");
  h.unmount();
  await t$.flush();
  assert.equal(shell.hasAttribute("inert"), false);
  assert.equal(document.activeElement, opener, "фокус вернулся");
  assert.equal(open, true);
  shell.remove();
});

test("BUG-01.38: один h1 и на остальных экранах — Проекты, проект, Настройки, вход", async () => {
  ui.store.me.value = { id: "u1", name: "Владелец", role: "admin" };
  const screens = [
    [ui.ProjectsView, {}],
    [ui.ProjectView, { id: encodeURIComponent(DIR) }],
    [ui.SettingsView, {}],
    [ui.LoginView, {}],
  ];
  for (const [View, props] of screens) {
    const h = t$.mount(View, props);
    await t$.flush(10);
    assert.equal($$(document, "h1").length, 1, `${View.name || "экран"}: h1 ровно один`);
    h.unmount();
  }
  ui.store.me.value = null;
});

// The shell behind a modal: an opener button inside `.shell`, focused.
function shellWithOpener(label) {
  const shell = document.createElement("div");
  shell.className = "shell";
  const opener = document.createElement("button");
  opener.textContent = label;
  shell.appendChild(opener);
  document.body.appendChild(shell);
  opener.focus();
  return { shell, opener };
}

test("BUG-01.38: модалка удаления чата — фокус внутри, Tab по кругу, Escape возвращает фокус на 🗑", async () => {
  const { opener } = shellWithOpener("🗑");
  let open = true;
  const h = t$.mount(ui.DeleteModal, { session: ses("ses_a", "Отчёт"), onConfirm: () => {}, onClose: () => (open = false) });
  await t$.flush();
  const modal = $(document.body, ".modal");
  assert.equal(modal.contains(document.activeElement), true, "фокус в модалке");
  const btns = [...modal.querySelectorAll("button")];
  btns.at(-1).focus();
  t$.key(btns.at(-1), "Tab");
  assert.equal(document.activeElement, btns[0]);
  t$.key(btns[0], "Tab", { shiftKey: true });
  assert.equal(document.activeElement, btns.at(-1));
  t$.key(btns.at(-1), "Escape");
  assert.equal(open, false, "Escape закрывает");
  h.unmount();
  await t$.flush();
  assert.equal(document.activeElement, opener, "фокус вернулся");
});

test("BUG-01.38: модалка токена — фон inert, Tab удерживается, «Готово» возвращает фокус на «Создать»", async () => {
  const { shell, opener } = shellWithOpener("Создать");
  const h = t$.mount(ui.TokenModal, { title: "Токен для «Анна»", token: "zai_tok_123", autoCopied: true, kind: "create", userName: "Анна", onClose: () => {} });
  await t$.flush();
  const box = $(document.body, ".access-modal");
  assert.equal(box.getAttribute("role"), "dialog");
  assert.equal(box.getAttribute("aria-modal"), "true");
  assert.equal(shell.hasAttribute("inert"), true, "фон inert");
  assert.equal(box.contains(document.activeElement), true, "фокус в модалке");
  const btns = [...box.querySelectorAll("button")];
  btns.at(-1).focus();
  t$.key(btns.at(-1), "Tab");
  assert.equal(document.activeElement, btns[0]);
  opener.focus(); // «под фоном»
  t$.key(opener, "Tab");
  assert.equal(box.contains(document.activeElement), true, "фокус возвращается внутрь");
  h.unmount();
  await t$.flush();
  assert.equal(shell.hasAttribute("inert"), false);
  assert.equal(document.activeElement, opener, "фокус вернулся на «Создать»");
});

test("BUG-01.38: просмотр файла — диалог, фон inert, фокус на «Закрыть», Escape закрывает, фокус на карточку", async () => {
  const { shell, opener } = shellWithOpener("отчёт.txt");
  let closed = false;
  const h = t$.mount(ui.FileViewer, { file: { name: "отчёт.txt", path: "C:\\Users\\USER\\отчёт.txt" }, onClose: () => (closed = true) });
  await t$.flush();
  const panel = $(document.body, ".file-panel");
  assert.equal(panel.getAttribute("role"), "dialog");
  assert.equal(panel.getAttribute("aria-modal"), "true");
  assert.equal(shell.hasAttribute("inert"), true);
  assert.equal(panel.contains(document.activeElement), true, "фокус в панели");
  t$.key(document.activeElement, "Escape");
  assert.equal(closed, true);
  h.unmount();
  await t$.flush();
  assert.equal(shell.hasAttribute("inert"), false);
  assert.equal(document.activeElement, opener, "фокус вернулся на карточку файла");
});

// ---- BUG-01.44: Tab order of row actions ---------------------------------------------

test("BUG-01.44: Tab вперёд со строки чата доходит до ✎ и 🗑 (они после ссылки в DOM, не выключены)", async () => {
  const { root } = await mountHome([ses("ses_a", "Отчёт"), ses("ses_b", "План")]);
  const FOCUSABLE = "a[href], button:not([disabled]), input, [tabindex]";
  const order = $$(root, FOCUSABLE)
    .filter((el) => el.tabIndex >= 0 && el.closest(".swipe"))
    .map((el) => (el.matches("a.session-row") ? `row:${el.textContent.includes("Отчёт") ? "a" : "b"}` : el.getAttribute("aria-label").split(" ")[0]));
  // Строки в группе идут по времени; для каждой: ссылка → Переименовать → Удалить.
  assert.equal(order.length, 6);
  for (let i = 0; i < 6; i += 3) {
    assert.match(order[i], /^row:/);
    assert.equal(order[i + 1], "Переименовать");
    assert.equal(order[i + 2], "Удалить");
  }
});
