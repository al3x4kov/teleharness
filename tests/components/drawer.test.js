// FEAT-09.20: боковое меню в стиле приложения Claude вместо таббара/рейла.
// Открытие по ☰, закрытие затемнением / Esc / сменой экрана, «Недавние»
// (фильтры как у «Чатов», порядок по активности, лимит), подсветка открытого
// чата, инициалы, приветствие по времени суток.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    Drawer: "src/components/Drawer.jsx",
    MenuButton: "src/components/Menu.jsx#MenuButton",
    drawerOpen: "src/components/Menu.jsx#drawerOpen",
    openDrawer: "src/components/Menu.jsx#openDrawer",
    greetingText: "src/components/Menu.jsx#greetingText",
    initials: "src/components/Drawer.jsx#initials",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  ui.drawerOpen.value = false;
  installFetch();
});

const NOW = Date.now();
const ses = (id, title, ago, extra = {}) => ({ id, title, directory: "C:\\Users\\USER", time: { created: NOW - ago, updated: NOW - ago }, ...extra });

test("☰ открывает панель, затемнение и Esc закрывают", async () => {
  const btn = t$.mount(ui.MenuButton).root;
  const { root } = t$.mount(ui.Drawer, { view: "home", chatId: null });
  assert.equal($(root, "nav.drawer.is-open"), null, "закрыта по умолчанию");
  t$.click($(btn, ".menu-btn"));
  await t$.flush();
  assert.ok($(root, "nav.drawer.is-open"), "открыта после ☰");
  t$.click($(root, ".drawer-scrim"));
  await t$.flush();
  assert.equal($(root, "nav.drawer.is-open"), null, "закрыта затемнением");
  t$.act(() => ui.openDrawer());
  await t$.flush();
  t$.key(document, "Escape");
  await t$.flush();
  assert.equal(ui.drawerOpen.value, false, "закрыта по Esc");
});

test("смена экрана закрывает панель", async () => {
  const h = t$.mount(ui.Drawer, { view: "home", chatId: null });
  t$.act(() => ui.openDrawer());
  await t$.flush();
  h.rerender({ view: "settings", chatId: null });
  await t$.flush();
  assert.equal(ui.drawerOpen.value, false);
});

test("разделы: Чаты / Проекты / Настройки, активный отмечен", async () => {
  const { root } = t$.mount(ui.Drawer, { view: "projects", chatId: null });
  const items = $$(root, ".drawer-nav .drawer-item").map((a) => a.textContent.trim());
  assert.deepEqual(items, ["Чаты", "Проекты", "Настройки"]);
  assert.equal($(root, '.drawer-nav [aria-current="page"]').textContent.trim(), "Проекты");
});

test("«Недавние»: по активности, без системных и сабагентских, лимит 8, открытый подсвечен", async () => {
  const list = [
    ses("a", "Старый", 9_000),
    ses("b", "Свежий", 1_000),
    ses("sys", "Системный", 500, { directory: "C:\\Windows\\System32" }),
    ...Array.from({ length: 8 }, (_, i) => ses("n" + i, "Чат " + i, 2_000 + i)),
  ];
  t$.act(() => { ui.store.sessions.value = list; });
  const { root } = t$.mount(ui.Drawer, { view: "chat", chatId: "b" });
  const titles = $$(root, ".drawer-recent .drawer-chat-title").map((e) => e.textContent);
  assert.equal(titles.length, 8, "не больше 8");
  assert.equal(titles[0], "Свежий", "сначала последний по активности");
  assert.ok(!titles.includes("Системный"), "системные папки скрыты");
  assert.ok(!titles.includes("Старый"), "девятый по свежести не влез");
  assert.equal($(root, '.drawer-recent [aria-current="page"]').getAttribute("href"), "#/chat/b");
  assert.ok($(root, ".drawer-more"), "«Показать все»");
});

test("пустой список чатов — без блока «Недавние»; пилюля «Новый чат» есть", async () => {
  const { root } = t$.mount(ui.Drawer, { view: "home", chatId: null });
  assert.equal($(root, ".drawer-recent"), null);
  assert.match($(root, ".drawer-foot .dark-pill").textContent, /Новый чат/);
});

test("инициалы и приветствие", () => {
  assert.equal(ui.initials("Anna Kim"), "AK");
  assert.equal(ui.initials("admin"), "AD");
  assert.equal(ui.initials(""), "?");
  const g = ui.greetingText;
  assert.equal(g(9, "Саша"), "Доброе утро, Саша");
  assert.equal(g(14, "Саша"), "Добрый день, Саша");
  assert.equal(g(19, "Саша"), "Добрый вечер, Саша");
  assert.equal(g(2, "Саша"), "Доброй ночи, Саша");
  assert.equal(g(23, ""), "Доброй ночи");
  assert.equal(g(5, null), "Доброе утро");
});

test("BUG-095: тап по пункту текущего экрана («Чаты» на Чатах, «Показать все», знак zai) закрывает меню", async () => {
  ui.store.sessions.value = [ses("ses_a", "Первый", 1000)];
  const { root } = t$.mount(ui.Drawer, { view: "home", chatId: null });
  for (const sel of [".drawer-nav .drawer-item.is-active", ".drawer-more", ".drawer-brand", ".drawer-avatar"]) {
    t$.act(() => ui.openDrawer());
    await t$.flush();
    const a = $(root, sel);
    assert.ok(a, sel);
    a.addEventListener("click", (e) => e.preventDefault(), { once: true }); // без смены хэша
    t$.click(a);
    await t$.flush();
    assert.equal(ui.drawerOpen.value, false, `закрыто после ${sel}`);
  }
});

test("BUG-097: открытое меню модально — role=dialog, aria-modal, Tab не уходит из панели", async () => {
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  const { root } = t$.mount(ui.Drawer, { view: "home", chatId: null });
  assert.equal($(root, "nav.drawer").getAttribute("role"), null, "закрытое/закреплённое меню — не диалог");
  t$.act(() => ui.openDrawer());
  await t$.flush();
  const nav = $(root, "nav.drawer");
  assert.equal(nav.getAttribute("role"), "dialog");
  assert.equal(nav.getAttribute("aria-modal"), "true");
  const items = [...nav.querySelectorAll("a[href], button:not([disabled])")];
  items[items.length - 1].focus();
  t$.key(document, "Tab");
  await t$.flush();
  assert.equal(document.activeElement, items[0], "с последнего — на первый");
  t$.key(document, "Tab", { shiftKey: true });
  await t$.flush();
  assert.equal(document.activeElement, items[items.length - 1], "Shift+Tab с первого — на последний");
  outside.focus();
  t$.key(document, "Tab");
  await t$.flush();
  assert.ok(nav.contains(document.activeElement), "фокус снаружи возвращается в панель");
  outside.remove();
});

test("BUG-01.38: закрытие меню (Esc, затемнение, ✕) возвращает фокус на ☰; переход по ссылке — не перехватывает", async () => {
  const btnRoot = t$.mount(ui.MenuButton).root;
  const menu = $(btnRoot, ".menu-btn");
  const { root } = t$.mount(ui.Drawer, { view: "home", chatId: null });
  const openFrom = async () => {
    menu.focus();
    t$.click(menu);
    await t$.flush();
    assert.ok($(root, "nav.drawer").contains(document.activeElement), "фокус в панели");
  };
  await openFrom();
  t$.key(document, "Escape");
  await t$.flush();
  assert.equal(document.activeElement, menu, "Esc → фокус на ☰");
  await openFrom();
  document.activeElement.blur(); // клик по затемнению уводит фокус на body
  t$.click($(root, ".drawer-scrim"));
  await t$.flush();
  assert.equal(document.activeElement, menu, "затемнение → фокус на ☰");
  await openFrom();
  t$.click($(root, ".drawer-close"));
  await t$.flush();
  assert.equal(document.activeElement, menu, "✕ → фокус на ☰");
  await openFrom();
  const link = $(root, 'a.drawer-item[href="#/settings"]');
  link.focus();
  location.hash = "#/settings"; // переход случился раньше закрытия
  t$.click(link);
  await t$.flush();
  assert.notEqual(document.activeElement, menu, "новый экран сам решает, где фокус");
  location.hash = "";
});
