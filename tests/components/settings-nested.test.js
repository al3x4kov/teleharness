// FEAT-03.23 — вложенные настройки (П32): корень с группами, разделы по
// адресу #/settings/<раздел>, «‹» к родителю, свайп от края, admin-разделы
// у пользователя отсутствуют (строк нет, адрес = неизвестный раздел, текста
// «администратор» нет), ошибка раздела (E6), «Выйти без сохранения?» (E8).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    SettingsView: "src/components/views/SettingsView.jsx",
    resolveSettings: "src/components/views/SettingsView.jsx#resolveSettings",
    sectionsFor: "src/components/views/SettingsView.jsx#sectionsFor",
    ADMIN_SECTIONS: "src/components/views/SettingsView.jsx#ADMIN_SECTIONS",
    promptState: "src/components/views/SystemPromptRow.jsx#promptState",
    leaveAllowed: "src/lib/router.js#leaveAllowed",
    match: "src/lib/router.js#match",
    backIsHistory: "src/lib/router.js#backIsHistory",
    accessTarget: "src/lib/router.js#accessTarget",
    appVersionLabel: "src/components/views/SettingsView.jsx#appVersionLabel",
    aboutLine: "src/components/views/SettingsView.jsx#aboutLine",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.me.value = null;
  s.mcp.value = null;
  s.mcpError.value = false;
  s.host.value = null;
  s.usage.value = null;
  s.voiceInfo.value = null;
  s.connection.value = { state: "online", restoredAt: null };
  ui.promptState.value = { status: "idle", text: "" };
  installFetch();
});

const ADMIN = { id: "admin", name: "admin", role: "admin" };
const USER = { id: "u_n", name: "Carol", role: "user" };
const ADMIN_TITLES = ["Подписка z.ai", "Компьютер", "Пользователи", "Активные ходы", "Администрирование"];

test("router: #/settings/<раздел> и #/settings/<раздел>/<глубже> — экран настроек", () => {
  assert.deepEqual(ui.match("/settings/models").params, { section: "models" });
  assert.deepEqual(ui.match("/settings/models/agent").params, { section: "models", sub: "agent" });
  assert.equal(ui.match("/settings/models/agent").view, "settings");
});

test("resolveSettings: известный раздел, неизвестный, admin-раздел у пользователя = неизвестный; голос выключен на сервере = неизвестный", () => {
  assert.deepEqual(ui.resolveSettings("models", null, { admin: false }), { section: "models", sub: null });
  assert.equal(ui.resolveSettings("xyz", null, { admin: true }), "unknown");
  for (const id of ui.ADMIN_SECTIONS) {
    assert.equal(ui.resolveSettings(id, null, { admin: false }), "unknown", id);
    assert.deepEqual(ui.resolveSettings(id, null, { admin: true }), { section: id, sub: null });
  }
  assert.equal(ui.resolveSettings("models", "claude-agent", { admin: false }), "unknown");
  assert.equal(ui.resolveSettings("models", "nope", { admin: true }), "unknown");
  assert.equal(ui.resolveSettings("voice", null, { voice: false }), "unknown");
  assert.equal(ui.resolveSettings(null, null), null);
  assert.deepEqual(ui.ADMIN_SECTIONS.sort(), ["active", "computer", "subscription", "users"]);
});

test("П32.У1 корень admin: группы «Чаты · Приложение · Возможности · Администрирование», строки ведут в разделы, детализация — переключатель в строке", async () => {
  ui.store.me.value = ADMIN;
  installFetch([{ method: "GET", path: "/zai/api/voice", reply: () => ({ enabled: true, voices: [{ id: "irina", name: "Ирина" }], defaultVoice: "irina" }) }]);
  const { root } = t$.mount(ui.SettingsView);
  await t$.waitFor(() => $(root, 'a[href="#/settings/voice"]'));
  assert.deepEqual($$(root, ".set-group-title").map((e) => e.textContent), ["Чаты", "Приложение", "Возможности", "Администрирование"]);
  const hrefs = $$(root, "a.set-link").map((a) => a.getAttribute("href"));
  for (const id of ["models", "prompt", "voice", "appearance", "notifications", "mcp", "subscription", "computer", "users", "active", "about"]) {
    assert.ok(hrefs.includes("#/settings/" + id), id);
  }
  assert.match($(root, ".set-account").textContent, /admin.*администратор · Teleharness \d+\.\d+\.\d+/);
  const sw = $(root, 'button[role="switch"][aria-labelledby="exec-detail-title"]');
  const was = sw.getAttribute("aria-checked");
  t$.click(sw);
  assert.notEqual(sw.getAttribute("aria-checked"), was, "П32.У5: применяется сразу, без захода в раздел");
  t$.click(sw);
  assert.ok(byText(root, ".set-row", "Выйти"));
  assert.ok(root.querySelector(".settings-pane .settings-empty"), "справа — подсказка (два столбца на ≥ 1024)");
});

test("П32.Н2 пользователь: в корне нет admin-строк и слова «администратор»; admin-адрес → тихо корень, адрес заменён на #/settings", async () => {
  ui.store.me.value = USER;
  installFetch([{ method: "GET", path: "/zai/api/mcp", reply: () => ({ m: { status: "connected" } }) }]);
  const top = t$.mount(ui.SettingsView);
  await t$.flush(5);
  for (const t of ADMIN_TITLES) assert.equal(top.root.textContent.includes(t), false, `нет «${t}»`);
  assert.equal(/администратор/i.test(top.root.textContent), false);
  top.unmount();
  for (const id of ["users", "computer", "subscription", "active"]) {
    location.hash = "#/settings/" + id;
    const h = t$.mount(ui.SettingsView, { section: id });
    assert.equal(h.root.querySelector(".settings-section"), null, `${id}: содержимое не рендерится ни на миг`);
    assert.ok(h.root.querySelector(".settings-page.at-root"));
    await t$.flush();
    assert.equal(location.hash, "#/settings", `${id}: адрес как у неизвестного раздела`);
    assert.equal(/администратор|только администрат|Администрирование/i.test(document.body.textContent), false);
    h.unmount();
  }
  const paths = fetchCalls.map((c) => c.path);
  for (const p of ["/zai/api/host", "/zai/api/usage", "/zai/api/admin/users", "/zai/api/status"]) assert.equal(paths.includes(p), false, `тенант не спрашивает ${p}`);
});

test("П32.Н1: неизвестный раздел → корень, адрес #/settings, без белого экрана", async () => {
  ui.store.me.value = ADMIN;
  location.hash = "#/settings/xyz";
  const { root } = t$.mount(ui.SettingsView, { section: "xyz" });
  assert.ok($(root, ".settings-root"));
  await t$.flush();
  assert.equal(location.hash, "#/settings");
});

test("раздел: заголовок в фокусе; «‹ Настройки» ведёт к родителю; глубже — «‹ Модель и агенты»", async () => {
  ui.store.me.value = ADMIN;
  location.hash = "#/settings/models";
  const h = t$.mount(ui.SettingsView, { section: "models" });
  const title = $(h.root, ".settings-section-title-h");
  assert.equal(title.textContent, "Модель и агенты");
  assert.equal(document.activeElement, title, "У1: фокус на заголовке раздела");
  assert.equal($(h.root, ".set-back-label").textContent, "Настройки");
  assert.ok($(h.root, '.settings-page.has-section'));
  assert.deepEqual($$(h.root, ".set-crumbs a").map((a) => a.textContent), ["Настройки"]);
  h.rerender({ section: "models", sub: "agent" });
  assert.equal($(h.root, ".settings-section-title-h").textContent, "Агент z.ai");
  assert.equal($(h.root, ".set-back-label").textContent, "Модель и агенты");
  assert.deepEqual($$(h.root, ".set-crumbs a").map((a) => a.getAttribute("href")), ["#/settings", "#/settings/models"]);
  t$.click($(h.root, ".set-back"));
  await t$.flush();
  assert.equal(location.hash, "#/settings/models");
});

test("П32.Н9/У2: свайп от левых 20 px — назад; свайп из середины экрана — нет", async () => {
  ui.store.me.value = ADMIN;
  const realW = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 402, configurable: true });
  try {
    location.hash = "#/settings/appearance";
    const { root } = t$.mount(ui.SettingsView, { section: "appearance" });
    const pane = $(root, ".settings-pane");
    t$.touch(pane, "touchstart", 120, 300);
    t$.fire(pane, "touchend", {}, Event, { changedTouches: [{ clientX: 300, clientY: 305 }] });
    await t$.flush();
    assert.equal(location.hash, "#/settings/appearance", "не от края — не назад");
    t$.touch(pane, "touchstart", 8, 300);
    t$.fire(pane, "touchend", {}, Event, { changedTouches: [{ clientX: 160, clientY: 310 }] });
    await t$.flush();
    assert.equal(location.hash, "#/settings");
  } finally {
    Object.defineProperty(window, "innerWidth", { value: realW, configurable: true });
  }
});

test("П32.Н3 (E6): раздел не загрузился — «Не удалось загрузить» + «Повторить», в корне «—»; повтор загружает", async () => {
  ui.store.me.value = ADMIN;
  let down = true;
  installFetch([{ method: "GET", path: "/zai/api/mcp", reply: () => (down ? { status: 502, body: { error: "x" } } : { a: { status: "connected" } }) }]);
  await ui.store.refreshMcp().catch(() => {});
  const { root } = t$.mount(ui.SettingsView, { section: "mcp" });
  const fail = await t$.waitFor(() => $(root, ".settings-pane .set-fail"));
  assert.match(fail.textContent, /Не удалось загрузить.*Остальные настройки работают/);
  assert.equal($(root, 'a[href="#/settings/mcp"] .set-row-value').textContent, "—");
  down = false;
  t$.click(byText(fail, "button", "Повторить"));
  await t$.waitFor(() => $$(root, ".settings-pane .mcp-row").length === 1);
  assert.match($(root, 'a[href="#/settings/mcp"] .set-row-value').textContent, /1 подключено/);
});

test("П32.Н4/Н5 (E8): системный промпт — сбой сохранения: ошибка под полем, текст на месте; несохранённое → «Выйти без сохранения?»", async () => {
  ui.store.me.value = USER;
  installFetch([
    { method: "GET", path: "/zai/api/me/system-prompt", reply: () => ({ text: "", max: 4000 }) },
    { method: "PUT", path: "/zai/api/me/system-prompt", reply: () => ({ status: 500, body: { error: "x" } }) },
  ]);
  const { root } = t$.mount(ui.SettingsView, { section: "prompt" });
  const ta = await t$.waitFor(() => $(root, ".settings-pane textarea.sysprompt-input"));
  assert.equal($(root, 'a[href="#/settings/prompt"] .set-row-value').textContent, "Не задан");
  t$.typeInto(ta, "Отвечай кратко");
  t$.click(byText(root.querySelector(".settings-pane"), "button", "Сохранить"));
  await t$.waitFor(() => /Не удалось сохранить.*Текст на месте/.test(root.textContent));
  assert.equal($(root, ".settings-pane textarea").value, "Отвечай кратко");
  // уход с несохранённым — вопрос, «Остаться» оставляет, «Выйти» уходит
  let went = 0;
  assert.equal(ui.leaveAllowed("/settings", () => (went += 1)), false);
  const dlg = await t$.waitFor(() => document.querySelector('.modal[aria-label="Выйти без сохранения?"]'));
  assert.match(dlg.textContent, /Изменения в системном промпте не сохранены/);
  t$.click(byText(dlg, "button", "Остаться"));
  assert.equal(document.querySelector(".modal"), null);
  assert.equal($(root, ".settings-pane textarea").value, "Отвечай кратко", "текст не потерян");
  assert.equal(ui.leaveAllowed("/settings", () => (went += 1)), false);
  const d2 = await t$.waitFor(() => document.querySelector(".modal"));
  t$.click(byText(d2, "button", "Выйти"));
  assert.equal(went, 1);
  assert.equal(ui.leaveAllowed("/settings", () => {}), true, "после «Выйти» guard снят");
});

test("П32.Н10: без сети — сохранение промпта неактивно с «Нет связи»", async () => {
  ui.store.me.value = USER;
  installFetch([{ method: "GET", path: "/zai/api/me/system-prompt", reply: () => ({ text: "Старый", max: 4000 }) }]);
  const { root } = t$.mount(ui.SettingsView, { section: "prompt" });
  const ta = await t$.waitFor(() => $(root, ".settings-pane textarea"));
  await t$.flush(5);
  ui.store.connection.value = { state: "offline", restoredAt: null };
  t$.typeInto(ta, "Новый");
  await t$.flush();
  const pane = root.querySelector(".settings-pane");
  assert.equal(byText(pane, "button", "Сохранить").disabled, true);
  assert.match(pane.textContent, /Нет связи/);
});

test("П32.Н6 (E9): уведомления запрещены → в корне «Запрещены», не «Включены»", async () => {
  ui.store.me.value = USER;
  const realN = globalThis.Notification;
  globalThis.Notification = { permission: "denied", requestPermission: async () => "denied" };
  try {
    const { root } = t$.mount(ui.SettingsView);
    await t$.flush(5);
    const v = $(root, 'a[href="#/settings/notifications"] .set-row-value')?.textContent ?? "";
    assert.equal(v.includes("Включены"), false);
  } finally {
    globalThis.Notification = realN;
  }
});

// Ревью шагов 2026-11-05 (П32.У2): стрелка ‹ в шапке раздела на широком экране — НАЗАД ПО ИСТОРИИ
// (как кнопка браузера), а не «к родителю»: иначе «Вперёд» после неё никогда не активна. В happy-dom
// роутер не ведёт историю вкладки — решение проверяется чистой функцией, клик — живым dogfood (П32.У2).
test("П32.У2: backIsHistory — назад по истории, если позади экран настроек; иначе к родителю", () => {
  assert.equal(ui.backIsHistory("/settings/models"), true);
  assert.equal(ui.backIsHistory("/settings"), true);
  assert.equal(ui.backIsHistory("/settingsx"), false);
  assert.equal(ui.backIsHistory("/chat/ses_1"), false);
  assert.equal(ui.backIsHistory(null), false);
});

// Ревью шагов 2026-11-05 (П32.Н11): старый #/access — «Пользователи» у admin, корень у остальных;
// пока учётка грузится — ждать (раньше admin улетал в корень, роль ещё была неизвестна).
test("П32.Н11: accessTarget — ждёт роль; admin → /settings/users, пользователь → /settings", () => {
  assert.equal(ui.accessTarget(null), null);
  assert.equal(ui.accessTarget({ id: "x" }), null);
  assert.equal(ui.accessTarget(ADMIN), "/settings/users");
  assert.equal(ui.accessTarget(USER), "/settings");
});

// BUG-178 (2026-11-06: версия на проде не совпадала с ожидаемой): фронт выкачен без рестарта сервера —
// версия бралась с сервера (1.14.3), а телефон уже работал на 1.14.4. Показываем версию приложения;
// если сервер отстаёт — «zai 1.14.4 (сервер 1.14.3)».
test("BUG-178: версия — приложения (VERSION), отставание сервера видно отдельно", async () => {
  const fn = ui.appVersionLabel;
  assert.equal(fn("1.14.4", "1.14.3"), "Teleharness 1.14.4 (сервер 1.14.3)");
  assert.equal(fn("1.14.4", "1.14.4"), "Teleharness 1.14.4");
  assert.equal(fn("1.14.4", null), "Teleharness 1.14.4");
  const al = ui.aboutLine;
  assert.match(al("1.14.4", { version: "1.14.3", opencodeVersion: "1.19.5" }), /^Teleharness 1\.14\.4 \(сервер 1\.14\.3\) · opencode 1\.19\.5/);
});
