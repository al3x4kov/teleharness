// C8 Access/Login (L2, TASK-14.7): вход по токену (LoginView: успех →
// /auth/login + init, 401 — поле красное, сеть/429 — поле не виновато,
// «Сессия завершена» после 401 из рабочего состояния), выход («Выйти» в
// Настройках → /auth/logout + перезагрузка), управление учётными записями
// (AccessSection: список и бейджи, создание с одноразовым токеном и
// автокопированием, двухшаговые действия «Выключить» / «Разрешить Claude» /
// «Перевыпустить токен» / «Удалить» / «Новый токен», ошибки).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    LoginView: "src/components/views/LoginView.jsx",
    AccessSection: "src/components/views/AccessSection.jsx",
    SettingsView: "src/components/views/SettingsView.jsx",
  });
  t$ = createHarness(ui);
});

let clipOk = true;
const copied = [];
function stubClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (s) => {
        if (!clipOk) throw new Error("denied");
        copied.push(s);
      },
    },
  });
  // Запасной путь copyText (execCommand) тоже «не работает», когда clipOk=false.
  document.execCommand = () => clipOk;
}

afterEach(() => {
  t$.cleanup();
  clipOk = true;
  copied.length = 0;
  ui.store.me.value = null;
  ui.store.about.value = null;
  installFetch();
});

const json = (o, status = 200) => ({ status, body: o });
const ME = { id: "u_admin", name: "admin", role: "admin" };

// ---- LoginView --------------------------------------------------------------------

test("вход: токен → POST /auth/login {token}, «Проверяем…» на время запроса, me = пользователь, init тянет чаты", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  installFetch([{ method: "POST", path: "/zai/api/auth/login", reply: async () => (await gate, { user: { id: "u_j", name: "julia", role: "user" } }) }]);
  ui.store.me.value = false;
  const { root } = t$.mount(ui.LoginView);
  assert.equal($(root, "h1").textContent, "Вход на портал");
  const input = $(root, 'input[aria-label="Токен доступа"]');
  assert.equal(input.type, "password");
  const btn = $(root, "button.login-btn");
  assert.equal(btn.disabled, true, "пустой токен — «Войти» выключена");
  t$.typeInto(input, "  tok-123  ");
  assert.equal(btn.disabled, false);
  t$.fire($(root, "form"), "submit");
  await t$.flush();
  assert.equal(btn.textContent, "Проверяем…");
  assert.equal(btn.getAttribute("aria-busy"), "true");
  assert.equal(input.readOnly, true);
  release();
  await t$.waitFor(() => ui.store.me.value && ui.store.me.value.id === "u_j");
  assert.deepEqual(fetchCalls.find((c) => c.path === "/zai/api/auth/login").body, { token: "tok-123" }, "токен без пробелов по краям");
  await t$.waitFor(() => fetchCalls.some((c) => c.method === "GET" && c.path === "/zai/api/session"));
});

test("вход: 401 → «Неверный токен…», поле aria-invalid и описано ошибкой; токен сохранён; ввод снимает ошибку", async () => {
  installFetch([{ method: "POST", path: "/zai/api/auth/login", reply: () => json({ error: "bad" }, 401) }]);
  ui.store.me.value = false;
  const { root } = t$.mount(ui.LoginView);
  const input = $(root, "input.login-input");
  t$.typeInto(input, "wrong");
  t$.fire($(root, "form"), "submit");
  const err = await t$.waitFor(() => $(root, '.login-error[role="alert"]'));
  assert.equal(err.textContent, "Неверный токен — проверьте, что вставили его целиком.");
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(input.getAttribute("aria-describedby"), "login-error");
  assert.ok(input.classList.contains("is-invalid"));
  assert.equal(input.value, "wrong", "токен не стирается — поправить вставку одним жестом");
  assert.equal(ui.store.me.value, false);
  assert.equal($(root, "button.login-btn").textContent, "Войти");
  t$.typeInto(input, "wrong2");
  assert.equal($(root, ".login-error"), null);
  assert.equal(input.hasAttribute("aria-invalid"), false);
});

test("вход: сеть упала / 429 — текст про связь или ожидание, поле не красное", async () => {
  let mode = "network";
  installFetch([{ method: "POST", path: "/zai/api/auth/login", reply: () => (mode === "429" ? json({}, 429) : Promise.reject(new TypeError("fetch failed"))) }]);
  ui.store.me.value = false;
  const { root } = t$.mount(ui.LoginView);
  const input = $(root, "input.login-input");
  t$.typeInto(input, "tok");
  t$.fire($(root, "form"), "submit");
  await t$.waitFor(() => $(root, ".login-error"));
  assert.match($(root, ".login-error").textContent, /^Сервер недоступен/);
  assert.equal(input.hasAttribute("aria-invalid"), false);
  mode = "429";
  t$.typeInto(input, "tok2");
  t$.fire($(root, "form"), "submit");
  await t$.waitFor(() => /Слишком много попыток/.test($(root, ".login-error")?.textContent ?? ""));
  assert.equal(input.hasAttribute("aria-invalid"), false);
});

test("«Сессия завершена» — только после 401 из рабочего состояния, не при первом входе", () => {
  ui.store.me.value = false;
  const a = t$.mount(ui.LoginView);
  assert.equal($(a.root, ".login-note"), null, "первый визит — без плашки");
  a.unmount();
  ui.store.me.value = { id: "u_j", name: "julia", role: "user" };
  ui.store.me.value = false; // 401 посреди работы
  const b = t$.mount(ui.LoginView);
  assert.match($(b.root, '.login-note[role="status"]').textContent, /Сессия завершена: токен больше не действует/);
});

// ---- выход ------------------------------------------------------------------------

test("выход: «Выйти» в Настройках → POST /auth/logout, кнопка «Выходим…», страница перезагружается", async () => {
  const realLoc = globalThis.location;
  let reloads = 0;
  globalThis.location = { reload: () => (reloads += 1), hash: "", href: realLoc.href, pathname: realLoc.pathname, search: "" };
  try {
    installFetch([{ method: "POST", path: "/zai/api/auth/logout", reply: () => ({ ok: true }) }]);
    ui.store.me.value = { id: "u_j", name: "julia", role: "user" };
    const { root } = t$.mount(ui.SettingsView);
    await t$.flush();
    // FEAT-03.23: «Выйти» — внизу корня настроек, рядом имя учётки
    const row = byText(root, ".set-row", "Выйти");
    assert.match(row.textContent, /julia/);
    assert.match($(root, ".set-account").textContent, /julia.*пользователь/);
    const btn = byText(row, "button", "Выйти");
    t$.click(btn);
    assert.equal(btn.textContent, "Выходим…");
    assert.equal(btn.disabled, true);
    await t$.waitFor(() => reloads === 1);
    assert.ok(fetchCalls.some((c) => c.method === "POST" && c.path === "/zai/api/auth/logout"));
    assert.equal($(root, ".settings-section-title"), null, "участнику раздел «Доступ» не показывается");
    assert.equal($(root, 'a[href="#/settings/users"]'), null, "и строки «Пользователи» нет");
  } finally {
    globalThis.location = realLoc;
  }
});

test("выход: сервер не ответил — перезагрузка всё равно (экран входа без старого состояния)", async () => {
  const realLoc = globalThis.location;
  let reloads = 0;
  globalThis.location = { reload: () => (reloads += 1) };
  try {
    installFetch([{ method: "POST", path: "/zai/api/auth/logout", reply: "network" }]);
    await ui.store.logout();
    assert.equal(reloads, 1);
  } finally {
    globalThis.location = realLoc;
  }
});

// ---- AccessSection ----------------------------------------------------------------

const USERS = () => [
  { id: "u_admin", name: "admin", role: "admin", directories: ["C:\\Users\\USER"], createdAt: "2026-10-01T00:00:00Z" },
  { id: "u_j", name: "julia", role: "user", directories: ["D:\\Tenants\\julia", "D:\\Shared"], obsidianRoot: "D:\\Vault\\julia", engines: ["opencode"] },
  { id: "u_k", name: "kostya", role: "user", directories: [], disabled: true, engines: ["opencode", "claude"] },
];

function mountAccess(extra = [], users = USERS()) {
  stubClipboard();
  installFetch([...extra, { method: "GET", path: "/zai/api/admin/users", reply: () => users }]);
  ui.store.me.value = ME;
  return t$.mount(ui.AccessSection);
}
const card = (root, name) => $$(root, "li.card").find((c) => $(c, ".row-title")?.firstChild?.textContent === name);

test("список: бейджи «администратор»/«выключен»/«это вы», папки, obsidian, движки; у админа только «Новый токен»", async () => {
  const { root } = mountAccess();
  assert.ok($(root, '[aria-label="Загрузка пользователей…"]'), "сначала скелетон");
  await t$.waitFor(() => card(root, "julia"));
  const a = card(root, "admin");
  assert.deepEqual($$(a, ".access-badge").map((b) => b.textContent), ["администратор", "это вы"]);
  assert.deepEqual($$(a, ".acct-actions button").map((b) => b.textContent), ["Новый токен"]);
  const j = card(root, "julia");
  assert.match($(j, ".access-meta").textContent, /чаты: julia \(\+1\)/);
  assert.match($(j, ".access-meta").textContent, /obsidian: julia/);
  assert.match($(j, ".access-meta").textContent, /движки: z\.ai(?!, Claude)/);
  assert.deepEqual($$(j, ".acct-actions button").map((b) => b.textContent), ["Выключить", "Разрешить Claude", "Перевыпустить токен", "Удалить"]);
  const k = card(root, "kostya");
  assert.ok(byText(k, ".access-badge", "выключен"));
  assert.match($(k, ".access-meta").textContent, /obsidian: весь vault/);
  assert.match($(k, ".access-meta").textContent, /движки: z\.ai, Claude/);
  assert.ok(byText(k, "button", "Включить"));
  assert.ok(byText(k, "button", "Запретить Claude"));
});

test("список не загрузился → «Не удалось загрузить учётные записи · Повторить» → список", async () => {
  let fail = true;
  stubClipboard();
  installFetch([{ method: "GET", path: "/zai/api/admin/users", reply: () => (fail ? json({ error: "x" }, 500) : USERS()) }]);
  ui.store.me.value = ME;
  const { root } = t$.mount(ui.AccessSection);
  await t$.waitFor(() => /Не удалось загрузить учётные записи/.test(root.textContent));
  fail = false;
  t$.click(byText(root, "button", "Повторить"));
  await t$.waitFor(() => card(root, "julia"));
});

test("создание: неверное имя → подсказка без запроса; верное → POST {name}, токен один раз в модалке, скопирован, список обновлён", async () => {
  let users = USERS();
  const { root } = mountAccess([
    {
      method: "POST",
      path: "/zai/api/admin/users",
      reply: (c) => {
        users = [...users, { id: "u_n", name: c.body.name, role: "user", directories: [] }];
        return { user: { id: "u_n", name: c.body.name, role: "user" }, token: "zai_SECRET_once" };
      },
    },
    { method: "GET", path: "/zai/api/admin/users", reply: () => users },
  ]);
  await t$.waitFor(() => card(root, "julia"));
  const input = $(root, 'input[aria-label="Имя пользователя"]');
  t$.typeInto(input, "Юля");
  t$.fire($(root, "form.access-create"), "submit");
  assert.match($(root, "#access-create-err").textContent, /2–32 символа латиницей/);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(fetchCalls.some((c) => c.method === "POST"), false);

  t$.typeInto(input, "masha");
  assert.equal($(root, "#access-create-err"), null);
  t$.fire($(root, "form.access-create"), "submit");
  const modal = await t$.waitFor(() => document.querySelector('.access-modal[role="dialog"]'));
  assert.deepEqual(fetchCalls.find((c) => c.method === "POST").body, { name: "masha" });
  assert.equal(modal.getAttribute("aria-label"), "Токен для «masha»");
  assert.equal($(modal, ".access-token").textContent, "zai_SECRET_once");
  assert.deepEqual(copied, ["zai_SECRET_once"], "токен скопирован автоматически");
  assert.match(modal.textContent, /Скопирован в буфер обмена/);
  assert.match(modal.textContent, /Передайте его masha\. Больше он не покажется/);
  await t$.waitFor(() => card(root, "masha"));
  assert.equal(input.value, "", "поле очищено");
  t$.click(byText(modal, "button", "Готово"));
  assert.equal(document.querySelector(".access-modal"), null);
  assert.equal(document.body.textContent.includes("zai_SECRET_once"), false, "после закрытия токен нигде не виден");
});

test("создание: имя занято (409) → «Имя «…» уже занято.»", async () => {
  const { root } = mountAccess([{ method: "POST", path: "/zai/api/admin/users", reply: () => json({ error: "exists" }, 409) }]);
  await t$.waitFor(() => card(root, "julia"));
  t$.typeInto($(root, "input.access-input"), "julia");
  t$.fire($(root, "form.access-create"), "submit");
  await t$.waitFor(() => $(root, "#access-create-err"));
  assert.equal($(root, "#access-create-err").textContent, "Имя «julia» уже занято.");
});

test("буфер обмена недоступен → предупреждение «Автокопирование не сработало», «Скопировать» повторяет", async () => {
  const { root } = mountAccess([{ method: "POST", path: "/zai/api/admin/users", reply: () => ({ user: { id: "u_n", name: "masha" }, token: "zai_T2" }) }]);
  clipOk = false;
  await t$.waitFor(() => card(root, "julia"));
  t$.typeInto($(root, "input.access-input"), "masha");
  t$.fire($(root, "form.access-create"), "submit");
  const modal = await t$.waitFor(() => document.querySelector(".access-modal"));
  assert.match($(modal, '[role="alert"]').textContent, /Автокопирование не сработало/);
  assert.ok($(modal, ".access-token.is-selected"), "токен выделен для ручного копирования");
  clipOk = true;
  t$.click(byText(modal, "button", "Скопировать"));
  await t$.waitFor(() => /Скопирован в буфер обмена/.test(modal.textContent));
  assert.deepEqual(copied, ["zai_T2"]);
  t$.click(byText(modal, "button", "Готово"));
});

test("«Выключить»: первый тап — последствия и «Отмена», остальные кнопки заперты; «Отмена» снимает; второй тап → PATCH {disabled:true}", async () => {
  const { root } = mountAccess([{ method: "PATCH", path: /\/admin\/users\/u_j$/, reply: () => ({ ok: true }) }]);
  await t$.waitFor(() => card(root, "julia"));
  let j = card(root, "julia");
  t$.click(byText(j, "button", "Выключить"));
  j = card(root, "julia");
  const armed = byText(j, "button", "Да, выключить");
  assert.ok(armed);
  assert.equal(armed.getAttribute("aria-describedby"), "acct-confirm-u_j");
  assert.match($(j, "#acct-confirm-u_j").textContent, /julia не сможет войти, пока вы не включите учётную запись\. Чаты сохранятся\./);
  const others = $$(j, ".acct-actions button").filter((b) => b !== armed);
  assert.equal(others.every((b) => b.disabled), true, "другие действия заперты");
  t$.click(byText(j, ".acct-confirm button", "Отмена"));
  assert.equal($(card(root, "julia"), ".acct-confirm"), null);
  assert.equal(fetchCalls.some((c) => c.method === "PATCH"), false, "без второго тапа ничего не отправлено");

  t$.click(byText(card(root, "julia"), "button", "Выключить"));
  t$.click(byText(card(root, "julia"), "button", "Да, выключить"));
  await t$.waitFor(() => fetchCalls.some((c) => c.method === "PATCH"));
  const call = fetchCalls.find((c) => c.method === "PATCH");
  assert.equal(call.path, "/zai/api/admin/users/u_j");
  assert.deepEqual(call.body, { disabled: true });
  await t$.waitFor(() => !$(card(root, "julia"), ".acct-confirm"));
});

test("«Разрешить Claude» → PATCH {engines:[opencode, claude]}; «Запретить Claude» → только opencode", async () => {
  const { root } = mountAccess([{ method: "PATCH", path: /\/admin\/users\//, reply: () => ({ ok: true }) }]);
  await t$.waitFor(() => card(root, "julia"));
  t$.click(byText(card(root, "julia"), "button", "Разрешить Claude"));
  assert.match(card(root, "julia").textContent, /получит модели Claude .*без shell и без чужих папок/);
  t$.click(byText(card(root, "julia"), "button", "Да, разрешить"));
  await t$.waitFor(() => fetchCalls.filter((c) => c.method === "PATCH").length === 1);
  assert.deepEqual(fetchCalls.find((c) => c.method === "PATCH").body, { engines: ["opencode", "claude"] });
  await t$.waitFor(() => !$(card(root, "julia"), ".acct-confirm"));
  t$.click(byText(card(root, "kostya"), "button", "Запретить Claude"));
  t$.click(byText(card(root, "kostya"), "button", "Да, запретить"));
  await t$.waitFor(() => fetchCalls.filter((c) => c.method === "PATCH").length === 2);
  const second = fetchCalls.filter((c) => c.method === "PATCH")[1];
  assert.equal(second.path, "/zai/api/admin/users/u_k");
  assert.deepEqual(second.body, { engines: ["opencode"] });
});

test("«Перевыпустить токен» → POST /admin/users/:id/token, модалка «Новый токен для «…»»: старый не действует", async () => {
  const { root } = mountAccess([{ method: "POST", path: "/zai/api/admin/users/u_j/token", reply: () => ({ token: "zai_NEW" }) }]);
  await t$.waitFor(() => card(root, "julia"));
  t$.click(byText(card(root, "julia"), "button", "Перевыпустить токен"));
  assert.match(card(root, "julia").textContent, /Старый токен julia перестанет работать сразу/);
  t$.click(byText(card(root, "julia"), "button", "Да, перевыпустить"));
  const modal = await t$.waitFor(() => document.querySelector(".access-modal"));
  assert.equal(modal.getAttribute("aria-label"), "Новый токен для «julia»");
  assert.equal($(modal, ".access-token").textContent, "zai_NEW");
  assert.match(modal.textContent, /Старый токен уже не действует\. Этот покажется только сейчас\./);
  assert.deepEqual(copied, ["zai_NEW"]);
});

test("«Новый токен» себе → POST /auth/token {confirm:true}, модалка «Ваш новый токен»", async () => {
  const { root } = mountAccess([{ method: "POST", path: "/zai/api/auth/token", reply: () => ({ token: "zai_SELF" }) }]);
  await t$.waitFor(() => card(root, "admin"));
  t$.click(byText(card(root, "admin"), "button", "Новый токен"));
  assert.match(card(root, "admin").textContent, /остальные ваши устройства выйдут/);
  t$.click(byText(card(root, "admin"), "button", "Да, выпустить новый"));
  const modal = await t$.waitFor(() => document.querySelector(".access-modal"));
  assert.deepEqual(fetchCalls.find((c) => c.path === "/zai/api/auth/token").body, { confirm: true });
  assert.equal(modal.getAttribute("aria-label"), "Ваш новый токен");
});

test("«Удалить» → DELETE; оставшиеся папки названы, сервер повторит; «Понятно» скрывает", async () => {
  let users = USERS();
  const { root } = mountAccess([
    {
      method: "DELETE",
      path: "/zai/api/admin/users/u_j",
      reply: () => {
        users = users.filter((u) => u.id !== "u_j");
        return { ok: true, warnings: [{ kind: "folder", path: "D:\\Tenants\\julia", retry: true }, { kind: "session", sessionID: "s1" }] };
      },
    },
    { method: "GET", path: "/zai/api/admin/users", reply: () => users },
  ]);
  await t$.waitFor(() => card(root, "julia"));
  t$.click(byText(card(root, "julia"), "button", "Удалить"));
  const j = card(root, "julia");
  assert.ok($(j, ".acct-confirm:not(.is-warn)"), "удаление — опасный тон");
  assert.match(j.textContent, /удалится безвозвратно/);
  t$.click(byText(j, "button", "Да, удалить"));
  const note = await t$.waitFor(() => $(root, ".access-delwarn"));
  assert.match(note.textContent, /Учётная запись «julia» удалена, но не всё убрано\./);
  assert.match(note.textContent, /Осталась папка: D:\\Tenants\\julia — файлы заняты процессом\. Сервер повторит удаление автоматически/);
  assert.match(note.textContent, /Не удалось удалить чатов: 1/);
  await t$.waitFor(() => !card(root, "julia"));
  t$.click(byText(note, "button", "Понятно"));
  assert.equal($(root, ".access-delwarn"), null);
});

test("отказ сервера (403) → «Действие отклонено сервером.» + «Обновить список»; подтверждение остаётся", async () => {
  const { root } = mountAccess([{ method: "PATCH", path: /\/admin\/users\//, reply: () => json({ error: "forbidden" }, 403) }]);
  await t$.waitFor(() => card(root, "julia"));
  t$.click(byText(card(root, "julia"), "button", "Выключить"));
  t$.click(byText(card(root, "julia"), "button", "Да, выключить"));
  const err = await t$.waitFor(() => $(root, '.access-acterr[role="alert"]'));
  assert.match(err.textContent, /^Действие отклонено сервером\./);
  assert.ok(byText(err, "button", "Обновить список"));
  assert.ok(byText(card(root, "julia"), "button", "Да, выключить"), "можно повторить или отменить");
});
