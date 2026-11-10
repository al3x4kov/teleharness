// FEAT-07.20 (L2): Настройки → «Уведомления» (BRIEF-06 кадры 10–14):
// переключатель, «Проверить», статус словами; iPhone вне экрана «Домой» —
// пояснение и недоступный переключатель; отказ в разрешении — что делать.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { $, byText, createHarness, loadUI, ROOT } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    NotificationsRow: "src/components/views/NotificationsRow.jsx",
    SettingsView: "src/components/views/SettingsView.jsx",
    pushSupport: "src/lib/push.js#pushSupport",
    pushState: "src/lib/push.js#pushState",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.me.value = null;
  installFetch();
  delete navigator.standalone;
});

// A fake push library: state + recorded calls.
function fakeLib(state, { enable = async () => "on", test = async () => ({ ok: true, sent: 1 }) } = {}) {
  const calls = [];
  return {
    calls,
    pushState: async () => state,
    enablePush: async () => {
      calls.push("enable");
      return enable();
    },
    disablePush: async () => {
      calls.push("disable");
      return "off";
    },
    testPush: async () => {
      calls.push("test");
      return test();
    },
  };
}
const sw = (root) => $(root, 'button[role="switch"]');

test("выключены: переключатель off, «Проверить» нет; тап → разрешение и подписка → «Включены на этом устройстве» + «Проверить»", async () => {
  const lib = fakeLib("off");
  const { root } = t$.mount(ui.NotificationsRow, { lib });
  await t$.waitFor(() => root.textContent.includes("Выключены"));
  assert.equal(sw(root).getAttribute("aria-checked"), "false");
  assert.equal(byText(root, "button", "Проверить"), null);
  assert.match(root.textContent, /Когда ход закончился или агент ждёт ответа/);
  t$.click(sw(root));
  await t$.waitFor(() => root.textContent.includes("Включены на этом устройстве"));
  assert.deepEqual(lib.calls, ["enable"]);
  assert.equal(sw(root).getAttribute("aria-checked"), "true");
  assert.ok(byText(root, "button", "Проверить"));
});

test("«Проверить»: успех — «Отправлено…»; 502 — «служба push не ответила»; 409 — «выключите и включите снова»", async () => {
  let reply = async () => ({ ok: true, sent: 1 });
  const lib = fakeLib("on", { test: () => reply() });
  const { root } = t$.mount(ui.NotificationsRow, { lib });
  await t$.waitFor(() => byText(root, "button", "Проверить"));
  t$.click(byText(root, "button", "Проверить"));
  await t$.waitFor(() => root.textContent.includes("Отправлено — уведомление придёт через пару секунд"));
  assert.equal($(root, ".notif-status").getAttribute("role"), "status");
  reply = async () => {
    throw Object.assign(new Error("x"), { status: 502 });
  };
  t$.click(byText(root, "button", "Проверить"));
  await t$.waitFor(() => root.textContent.includes("служба push не ответила"));
  assert.equal($(root, ".notif-status").getAttribute("role"), "alert");
  reply = async () => {
    throw Object.assign(new Error("x"), { status: 409 });
  };
  t$.click(byText(root, "button", "Проверить"));
  await t$.waitFor(() => root.textContent.includes("выключите и включите снова"));
  // выключение
  t$.click(sw(root));
  await t$.waitFor(() => root.textContent.includes("Выключены"));
  assert.ok(lib.calls.includes("disable"));
});

test("отказ в разрешении: «Запрещены в браузере», где разрешить, переключатель недоступен", async () => {
  const lib = fakeLib("off", {
    enable: async () => {
      throw Object.assign(new Error("denied"), { code: "denied" });
    },
  });
  const { root } = t$.mount(ui.NotificationsRow, { lib });
  await t$.waitFor(() => root.textContent.includes("Выключены"));
  t$.click(sw(root));
  await t$.waitFor(() => root.textContent.includes("Запрещены в браузере"));
  assert.match(root.textContent, /Разрешите уведомления для этого сайта/);
  assert.equal(sw(root).disabled, true);
  // закрыл окно разрешения без выбора — подсказка, переключатель снова доступен
  const lib2 = fakeLib("off", {
    enable: async () => {
      throw Object.assign(new Error("x"), { code: "dismissed" });
    },
  });
  t$.cleanup();
  const m2 = t$.mount(ui.NotificationsRow, { lib: lib2 });
  await t$.waitFor(() => m2.root.textContent.includes("Выключены"));
  t$.click(sw(m2.root));
  await t$.waitFor(() => m2.root.textContent.includes("выберите «Разрешить»"));
  assert.equal(sw(m2.root).disabled, false);
});

test("служба push браузера недоступна (приватное окно, headless) — понятный текст, переключатель доступен", async () => {
  const lib = fakeLib("off", {
    enable: async () => {
      throw Object.assign(new Error("Registration failed - push service not available"), { code: "push-service" });
    },
  });
  const { root } = t$.mount(ui.NotificationsRow, { lib });
  await t$.waitFor(() => root.textContent.includes("Выключены"));
  t$.click(sw(root));
  await t$.waitFor(() => root.textContent.includes("Служба уведомлений браузера недоступна"));
  assert.equal(sw(root).disabled, false);
  assert.equal(sw(root).getAttribute("aria-checked"), "false");
});

test("iPhone в Safari: переключатель недоступен, пояснение «экран „Домой“, iOS 16.4+»", async () => {
  const { root } = t$.mount(ui.NotificationsRow, { lib: fakeLib("ios-browser") });
  await t$.waitFor(() => root.textContent.includes("Недоступны в Safari"));
  assert.equal(sw(root).disabled, true);
  const p = $(root, ".notif-ios");
  assert.match(p.textContent, /экрана «Домой»/);
  assert.match(p.textContent, /iOS 16\.4\+/);
});

test("pushSupport: iPhone и navigator.standalone=false → ios-browser; с экрана «Домой» без push API → unsupported", () => {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), "userAgent");
  Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", configurable: true });
  try {
    navigator.standalone = false;
    assert.deepEqual(ui.pushSupport(), { ok: false, reason: "ios-browser" });
    navigator.standalone = true;
    // happy-dom: нет PushManager/serviceWorker
    assert.equal(ui.pushSupport().ok, false);
    assert.notEqual(ui.pushSupport().reason, "ios-browser");
  } finally {
    delete navigator.userAgent;
    if (desc) Object.defineProperty(Object.getPrototypeOf(navigator), "userAgent", desc);
  }
});

test("Настройки показывают строку «Уведомления» (настоящая библиотека: браузер без push → понятный текст)", async () => {
  ui.store.me.value = { id: "u", name: "julia", role: "user" };
  installFetch();
  // FEAT-03.23: строка корня ведёт в раздел «Уведомления»
  const top = t$.mount(ui.SettingsView);
  assert.ok(top.root.querySelector('a[href="#/settings/notifications"]'));
  await t$.waitFor(() => /Недоступны|Выключены/.test(top.root.querySelector('a[href="#/settings/notifications"]').textContent));
  top.unmount();
  const { root } = t$.mount(ui.SettingsView, { section: "notifications" });
  const row = await t$.waitFor(() => byText(root.querySelector(".settings-pane"), ".card", "Уведомления"));
  await t$.waitFor(() => !row.textContent.includes("Проверяем…"));
  assert.match(row.textContent, /не поддерживает push-уведомления|Недоступны в Safari|защищённое соединение/);
  assert.equal(sw(row).disabled, true);
  assert.ok(sw(row).getAttribute("aria-labelledby"));
});

test("тап-цели ≥ 44: переключатель с зоной ::before, «Проверить» — access-btn высотой 44", () => {
  const css = readFileSync(path.join(ROOT, "src", "components", "views.css"), "utf8");
  const sw = /\.switch \{[^}]*height: (\d+)px/.exec(css);
  const zone = /\.switch::before \{[^}]*inset: -(\d+)px -(\d+)px/.exec(css);
  assert.ok(sw && zone, "правила .switch есть");
  assert.ok(Number(sw[1]) + 2 * Number(zone[1]) >= 44, "высота тап-зоны ≥ 44");
  assert.ok(51 + 2 * Number(zone[2]) >= 44, "ширина тап-зоны ≥ 44");
  assert.match(css, /\.access-btn \{[^}]*height: 44px/);
});
