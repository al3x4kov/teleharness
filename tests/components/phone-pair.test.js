// FEAT-18.2 (L2): Настройки → «Подключить телефон» and the #/pair/<code>
// landing. Section: QR (SVG) + link + «Скопировать» + «Действует до HH:MM» +
// «Новый код»; without TELEHARNESS_PUBLIC_URL — the setting is named and there is no
// QR; issue errors in words. Landing: waits for the boot check, claims the
// code, goes to the chat list; a used/expired link → login screen with
// «Ссылка истекла или уже использована — покажите новый QR-код.».
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    PhoneSection: "src/components/views/PhoneSection.jsx",
    PairView: "src/components/views/PairView.jsx",
    pairError: "src/components/views/PairView.jsx#pairError",
    LoginView: "src/components/views/LoginView.jsx",
    SettingsView: "src/components/views/SettingsView.jsx",
    match: "src/lib/router.js#match",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.me.value = null;
  ui.pairError.value = null;
  installFetch();
});

const CODE = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const URL1 = `https://portal.example.test/teleharness/#/pair/${CODE}`;
const inTen = () => new Date(Date.now() + 10 * 60_000).toISOString();

test("QR-экран: код, ссылка, «Действует до HH:MM», «Скопировать», «Новый код» выпускает новый", async () => {
  let n = 0;
  installFetch([
    {
      method: "POST",
      path: "/teleharness/api/auth/pair",
      reply: () => {
        n++;
        return { status: 201, body: { configured: true, code: CODE, url: n === 1 ? URL1 : URL1 + "x", expiresAt: inTen() } };
      },
    },
  ]);
  const copied = [];
  const { root } = t$.mount(ui.PhoneSection, { copy: async (s) => (copied.push(s), true) });
  await t$.waitFor(() => $(root, "svg.pair-qr"));
  const svg = $(root, "svg.pair-qr");
  assert.equal(svg.getAttribute("role"), "img");
  assert.match(svg.getAttribute("aria-label"), /QR-код/);
  assert.match(svg.querySelector("path").getAttribute("d"), /^M4 4h7v1h-7z/, "finder pattern drawn, quiet zone 4");
  assert.equal($(root, "input.pair-url").value, URL1);
  assert.match($(root, ".pair-until").textContent, /^Действует до \d{2}:\d{2}$/);
  assert.match(root.textContent, /одноразовый и действует 10 минут/);

  t$.click(byText(root, "button", "Скопировать"));
  await t$.waitFor(() => byText(root, "button", "Скопировано"));
  assert.deepEqual(copied, [URL1]);

  t$.click(byText(root, "button", "Новый код"));
  await t$.waitFor(() => $(root, "input.pair-url")?.value === URL1 + "x");
  assert.equal(n, 2, "«Новый код» asks the server again");
  assert.ok(byText(root, "button", "Скопировать"), "the copy label resets for the new link");
  const posts = fetchCalls.filter((c) => c.path === "/teleharness/api/auth/pair");
  assert.ok(posts.every((c) => c.method === "POST" && !("userId" in (c.body ?? {}))), "never names another user");
});

test("без TELEHARNESS_PUBLIC_URL: экран называет настройку, QR и ссылки нет", async () => {
  installFetch([{ method: "POST", path: "/teleharness/api/auth/pair", reply: () => ({ configured: false, setting: "TELEHARNESS_PUBLIC_URL" }) }]);
  const { root } = t$.mount(ui.PhoneSection);
  await t$.waitFor(() => $(root, ".pair-unset"));
  assert.match(root.textContent, /TELEHARNESS_PUBLIC_URL/);
  assert.match(root.textContent, /https:\/\/example\.com\/teleharness\//);
  assert.equal($(root, "svg.pair-qr"), null);
  assert.equal($(root, "input.pair-url"), null);
  assert.doesNotMatch(root.textContent, /127\.0\.0\.1|localhost/);
});

test("ошибка выпуска: 429 — словами, «Новый код» доступен", async () => {
  installFetch([{ method: "POST", path: "/teleharness/api/auth/pair", reply: () => ({ status: 429, body: { error: "слишком много активных кодов" } }) }]);
  const { root } = t$.mount(ui.PhoneSection);
  await t$.waitFor(() => $(root, ".pair-error"));
  assert.match($(root, ".pair-error").textContent, /Слишком много активных кодов/);
  assert.equal($(root, "svg.pair-qr"), null);
  assert.equal(byText(root, "button", "Новый код").disabled, false);
});

test("Настройки: строка «Подключить телефон» есть у пользователя и у admin", async () => {
  for (const who of [{ id: "u1", name: "u1", role: "user", engines: ["opencode"] }, { id: "admin", name: "admin", role: "admin", engines: ["opencode", "claude"] }]) {
    ui.store.me.value = who;
    installFetch();
    const { root } = t$.mount(ui.SettingsView);
    await t$.waitFor(() => $(root, 'a[href="#/settings/phone"]'));
    assert.match($(root, 'a[href="#/settings/phone"]').textContent, /Подключить телефон/);
    t$.cleanup();
  }
});

test("маршрут #/pair/<код> → view pair", () => {
  assert.deepEqual(ui.match("/pair/" + CODE), { view: "pair", path: "/pair/" + CODE, params: { code: CODE } });
});

test("#/pair: ждёт ответа boot, затем claim → список чатов", async () => {
  location.hash = "#/pair/" + CODE;
  const calls = [];
  const claim = async (c) => {
    calls.push(c);
    ui.store.me.value = { id: "u1", name: "u1", role: "user" };
  };
  ui.store.me.value = null; // boot still asking /auth/me
  t$.mount(ui.PairView, { code: CODE, claim });
  await t$.flush?.(3);
  assert.deepEqual(calls, [], "no claim while the boot check is in flight");
  ui.store.me.value = false; // anonymous phone
  await t$.waitFor(() => calls.length === 1);
  await t$.waitFor(() => location.hash === "#/" || location.hash === "");
  assert.equal(calls[0], CODE);
  assert.equal(ui.pairError.value, null);
});

test("#/pair: использованная/истёкшая ссылка → экран входа с понятным текстом", async () => {
  location.hash = "#/pair/" + CODE;
  ui.store.me.value = false;
  const err = Object.assign(new Error("gone"), { status: 410 });
  t$.mount(ui.PairView, { code: CODE, claim: async () => Promise.reject(err) });
  await t$.waitFor(() => ui.pairError.value);
  assert.equal(ui.pairError.value, "Ссылка истекла или уже использована — покажите новый QR-код.");
  assert.equal(ui.store.me.value, false);
  const { root } = t$.mount(ui.LoginView);
  assert.match($(root, ".login-note").textContent, /Ссылка истекла или уже использована — покажите новый QR-код\./);
  t$.typeInto($(root, "input.login-input"), "x");
  assert.equal(ui.pairError.value, null, "typing a token clears the link message");
});

test("claimPair (store): POST /auth/pair/claim {code} → me = пользователь кода; 401 не роняет в «сессия истекла»", async () => {
  ui.store.me.value = false;
  installFetch([
    { method: "POST", path: "/teleharness/api/auth/pair/claim", reply: (c) => (c.body?.code === CODE ? { user: { id: "u1", name: "u1", role: "user", engines: ["opencode"] } } : { status: 401, body: { error: "ссылка недействительна" } }) },
  ]);
  let unauthorized = 0;
  ui.store.onUnauthorized(() => unauthorized++);
  await assert.rejects(ui.store.claimPair("B".repeat(43)), (e) => e.status === 401);
  assert.equal(unauthorized, 0, "a bad link is not a dead session");
  const user = await ui.store.claimPair(CODE);
  assert.equal(user.id, "u1");
  assert.equal(ui.store.me.value.id, "u1");
  ui.store.onUnauthorized(null);
});

test("claimPair на устройстве, где уже вошли: перезагрузка в новую учётную запись", async () => {
  ui.store.me.value = { id: "old", name: "old", role: "user" };
  installFetch([{ method: "POST", path: "/teleharness/api/auth/pair/claim", reply: () => ({ user: { id: "u2", name: "u2", role: "user" } }) }]);
  let reloads = 0;
  await ui.store.claimPair(CODE, { reload: () => reloads++ });
  assert.equal(reloads, 1);
});
