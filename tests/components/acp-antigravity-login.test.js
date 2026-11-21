// FEAT-20.4 — мастер входа Google Antigravity: ссылка Google, вставка адреса
// страницы после входа и запасной вход по ключу Gemini API.
import test from "node:test";
import assert from "node:assert/strict";
import { $, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

const LOGIN_PATH = "/teleharness/api/acp/antigravity/login";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=st";

function mockLogin() {
  let state = { status: "idle" };
  installFetch([
    { method: "GET", path: LOGIN_PATH, reply: () => state },
    { method: "POST", path: LOGIN_PATH, reply: ({ body }) => {
      if (body.action === "start" && body.method === "api-key") return state = { status: "ready" };
      if (body.action === "start") return state = { status: "awaiting-code", id: "att-1", url: AUTH_URL };
      if (body.action === "submit") return state = { status: "ready", id: body.id };
      return { status: "idle" };
    } },
  ]);
}

test("мастер Antigravity: ссылка Google и вставка адреса страницы после входа", async t => {
  const ui = await loadUI({ AntigravityLogin: "src/components/views/AntigravityLogin.jsx" });
  const h = createHarness(ui);
  t.after(() => h.cleanup());
  mockLogin();
  const { root } = h.mount(ui.AntigravityLogin);
  await h.waitFor(() => root.textContent.includes("Нужен вход"));
  h.click(byText(root, "button", "Войти через Google"));
  await h.waitFor(() => $(root, "a[href='" + AUTH_URL + "']"));
  assert.ok(root.textContent.includes("Скопируйте адрес из строки браузера"), "пояснение про ошибку соединения");
  const address = "http://127.0.0.1:33445/?code=4%2Ftest&scope=a+b&state=st";
  h.typeInto($(root, "input[type=text]"), address);
  h.fire($(root, "form"), "submit");
  await h.waitFor(() => root.textContent.includes("Вход выполнен"));
  const { fetchCalls } = await import("./helpers/dom.mjs");
  const post = fetchCalls.filter(c => c.method === "POST" && c.path === LOGIN_PATH).pop();
  assert.deepEqual(post.body, { action: "submit", id: "att-1", url: address });
});

test("BUG-279: мастер Antigravity показывает только вход через подписку Google (без API-ключа)", async t => {
  const ui = await loadUI({ AntigravityLogin: "src/components/views/AntigravityLogin.jsx" });
  const h = createHarness(ui);
  t.after(() => h.cleanup());
  mockLogin();
  const { root } = h.mount(ui.AntigravityLogin);
  await h.waitFor(() => root.textContent.includes("Нужен вход"));
  assert.equal(root.textContent.includes("API-ключ"), false);
});
