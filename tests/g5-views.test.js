// Г5 component tests: Home / Projects / Project / Settings / Access / Login /
// Pickers. The JSX is bundled with esbuild into a temp ESM file (one preact +
// signals instance) and rendered into happy-dom with a stubbed fetch — no
// network, no portal server, nothing touches prod.
// Run: node --test --test-concurrency=1 tests/g5-views.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => JSON.stringify(path.join(root, "src", p).replace(/\\/g, "/"));
let tmp;
let M; // bundled module
let win;

// fetch stub: route table "METHOD /path" → (body) => {status, json}
let routes = {};
const calls = [];
function stubFetch(url, init = {}) {
  const u = new URL(String(url), "http://localhost");
  const key = `${(init.method ?? "GET").toUpperCase()} ${u.pathname}`;
  calls.push(key);
  const h = routes[key];
  const r = h ? h(init.body ? JSON.parse(init.body) : undefined) : { status: 404, json: {} };
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => r.json,
  });
}

async function flush(n = 12) {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function mount(Comp, props = {}) {
  const el = win.document.createElement("div");
  win.document.body.appendChild(el);
  M.render(M.h(Comp, props), el);
  return el;
}

function unmount(el) {
  M.render(null, el);
  el.remove();
}

const byText = (el, sel, text) => [...el.querySelectorAll(sel)].find((n) => n.textContent.includes(text));

before(async () => {
  win = new Window({ url: "http://localhost/zai/" });
  for (const k of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "Node", "Event",
    "KeyboardEvent", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "matchMedia",
    "getSelection", "addEventListener", "removeEventListener", "performance"]) {
    if (win[k] !== undefined) {
      Object.defineProperty(globalThis, k, {
        value: typeof win[k] === "function" && !/^[A-Z]/.test(k) ? win[k].bind(win) : win[k],
        configurable: true, writable: true,
      });
    }
  }
  globalThis.fetch = stubFetch;
  delete globalThis.EventSource; // store.installEventStream becomes a no-op

  tmp = mkdtempSync(path.join(os.tmpdir(), "zai-g5-test-"));
  const entry = path.join(tmp, "entry.jsx");
  writeFileSync(entry, `
    export { h, render } from "preact";
    export * as store from ${src("lib/store.js")};
    export * as home from ${src("components/views/HomeView.jsx")};
    export * as projects from ${src("components/views/ProjectsView.jsx")};
    export { default as ProjectView } from ${src("components/views/ProjectView.jsx")};
    export * as settings from ${src("components/views/SettingsView.jsx")};
    export * as access from ${src("components/views/AccessSection.jsx")};
    export * as login from ${src("components/views/LoginView.jsx")};
    export * as pickers from ${src("components/Pickers.jsx")};
    export { normalizeProviders } from ${src("lib/normalize.js")};
  `);
  const out = path.join(tmp, "bundle.mjs");
  await build({
    entryPoints: [entry], bundle: true, format: "esm", platform: "browser", target: "es2022",
    outfile: out, jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" },
    nodePaths: [path.join(root, "node_modules")], logLevel: "silent",
  });
  M = await import(pathToFileURL(out).href);
});

after(() => {
  M?.store?.sessions && (M.store.sessions.value = []);
  try { win?.happyDOM?.abort?.(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const baseRoutes = () => ({
  "GET /zai/api/dialogs": () => ({ status: 200, json: [] }),
  "GET /zai/api/provider": () => ({ status: 200, json: { all: [], connected: [], default: {} } }),
  "GET /zai/api/agent": () => ({ status: 200, json: [] }),
  "GET /zai/api/mcp": () => ({ status: 200, json: {} }),
  "GET /zai/api/status": () => ({ status: 200, json: {} }),
});

// ---------------------------------------------------------------- BUG-01.40
test("Home: failed chat list → «Не удалось загрузить чаты · Повторить», not the empty hero; retry recovers", async () => {
  M.store.sessions.value = [];
  routes = { ...baseRoutes(), "GET /zai/api/session": () => ({ status: 502, json: {} }) };
  const el = mount(M.home.default);
  await flush();
  assert.match(el.textContent, /Не удалось загрузить чаты/);
  assert.doesNotMatch(el.textContent, /Чем займёмся/);
  routes["GET /zai/api/session"] = () => ({ status: 200, json: [{ id: "ses_1", title: "Отчёт", directory: "D:\\p", time: { updated: Date.now() } }] });
  byText(el, "button", "Повторить").click();
  await flush();
  assert.match(el.textContent, /Отчёт/);
  unmount(el);
});

test("Home: genuinely empty list still shows «Чем займёмся?»", async () => {
  M.store.sessions.value = [];
  routes = { ...baseRoutes(), "GET /zai/api/session": () => ({ status: 200, json: [] }) };
  const el = mount(M.home.default);
  await flush();
  assert.match(el.textContent, /Чем займёмся/);
  unmount(el);
});

test("Projects: failed load → error state, not «Проектов пока нет»", async () => {
  M.store.sessions.value = [];
  routes = { ...baseRoutes(), "GET /zai/api/session": () => ({ status: 500, json: {} }) };
  const el = mount(M.projects.default);
  await flush();
  assert.match(el.textContent, /Не удалось загрузить проекты/);
  assert.doesNotMatch(el.textContent, /Проектов пока нет/);
  unmount(el);
});

test("Project: «Новый чат» failure → notice naming the project; skeleton/error instead of «Загрузка…»", async () => {
  M.store.sessions.value = [{ id: "ses_a", title: "A", directory: "D:\\Work\\zai", time: { updated: Date.now() } }];
  routes = { ...baseRoutes(), "POST /zai/api/session": () => ({ status: 502, json: {} }) };
  const el = mount(M.ProjectView, { id: "D:\\Work\\zai" });
  await flush();
  assert.doesNotMatch(el.textContent, /Загрузка…/);
  const btn = byText(el, "button", "Новый чат в «zai»");
  assert.ok(btn, "button names the project");
  btn.click();
  await flush();
  assert.match(String(M.store.notice.value), /Не удалось создать чат в «zai»/);
  assert.equal(btn.disabled, false, "button is usable again");
  unmount(el);
});

// ----------------------------------------------------------------- BUG-02.6
test("Project: chats have swipe/hover rename+delete actions and remember the project as «Назад»", async () => {
  M.store.sessions.value = [{ id: "ses_p", title: "Сборка", directory: "D:\\Work\\zai", time: { updated: Date.now() } }];
  routes = baseRoutes();
  const el = mount(M.ProjectView, { id: "D:\\Work\\zai" });
  await flush();
  assert.ok(el.querySelector(".swipe"), "row is a swipe row");
  assert.ok(el.querySelector('[aria-label="Удалить чат «Сборка»"]'));
  assert.ok(el.querySelector('[aria-label="Переименовать чат «Сборка»"]'));
  assert.equal(el.querySelector("a.session-row").getAttribute("href"), "#/chat/ses_p");
  unmount(el);
});

// «Назад» has ONE mechanism (integration 1.7.0): the router's chatBackTarget
// from the last non-chat route — the duplicate sessionStorage origin is gone.
test("chatBackTarget: a chat opened (or created) from a project returns there", async () => {
  const { chatBackTarget } = await import("../src/lib/router.js");
  const origin = "/project/" + encodeURIComponent("D:\\Work\\zai");
  assert.equal(chatBackTarget({ from: { view: "project", path: origin } }), origin);
  assert.equal(chatBackTarget({ from: { view: "projects", path: "/projects" } }), "/projects");
  assert.equal(chatBackTarget({ from: null, directory: "D:\\Work\\zai", projects: ["d:\\work\\zai"] }), origin, "deep link → its project");
  assert.equal(chatBackTarget({ from: null, directory: "D:\\Other" }), "/");
  assert.equal(typeof M.home.chatBackPath, "undefined", "the duplicate mechanism is removed");
});

// ----------------------------------------------------------- BUG-01.41 п.1
test("Delete modal never shows the raw «New session - <ISO>» title", () => {
  const raw = { title: "New session - 2026-11-02T12:24:05.614Z", time: { created: Date.UTC(2026, 10, 2, 7, 34) } };
  const name = M.home.chatNameForConfirm(raw);
  assert.doesNotMatch(name, /New session|2026-11-02T/);
  assert.match(name, /^Чат без названия от /);
  assert.equal(M.home.chatNameForConfirm({ title: "Отчёт" }), "«Отчёт»");
});

// ---------------------------------------------------------------- FEAT-01.31
test("Row state: busy → «работает», open dialog → ⏸ wins", async () => {
  M.store.busyMap.value = { ses_b: Date.now() };
  M.store.dialogs.value = [{ id: "per_1", sessionID: "ses_d" }];
  assert.equal(M.home.rowState("ses_b"), "busy");
  assert.equal(M.home.rowState("ses_d"), "waiting");
  assert.equal(M.home.rowState("ses_z"), null);
  M.store.busyMap.value = {};
  M.store.dialogs.value = [];
});

// ------------------------------------------------------------------ P-8
test("Projects: duplicate path → message + «Открыть его», trailing slash and case ignored", () => {
  const list = [{ directory: "D:\\Work\\zai" }];
  assert.equal(M.projects.findExistingProject("d:\\work\\ZAI\\", list), "D:\\Work\\zai");
  assert.equal(M.projects.findExistingProject("D:\\Work\\other", list), null);
  M.store.sessions.value = [];
  const el = mount(M.projects.AddProjectModal, { projects: list, onCreate: () => assert.fail("must not create"), onClose() {} });
  const input = el.querySelector("input");
  input.value = "D:\\Work\\zai";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  return flush().then(async () => {
    byText(el, "button", "Создать").click();
    await flush();
    assert.match(win.document.body.textContent, /уже есть в списке/);
    assert.ok(byText(win.document.body, "button", "Открыть его"));
    assert.equal(input.getAttribute("aria-invalid"), "true");
    unmount(el);
  });
});

// --------------------------------------------------- FEAT-03.2 / BUG-11.11
const fixtureProviders = () => M.normalizeProviders(JSON.parse(readFileSync(path.join(root, "fixtures", "provider.json"), "utf8")));
const claudeModels = [
  { id: "claude-opus-5-5", providerID: "anthropic", label: "Claude Opus 5.5 (anthropic)", status: "active" },
  { id: "claude-sonnet-5-5", providerID: "anthropic", label: "Claude Sonnet 5.5 (anthropic)", status: "active" },
];

test("Model picker data: two engine groups, z.ai first, only working models", () => {
  const cfg = fixtureProviders();
  cfg.models.push(...claudeModels);
  cfg.connected = [...cfg.connected, "anthropic"];
  const groups = M.pickers.modelGroups(cfg);
  assert.deepEqual(groups.map((g) => g.title), ["opencode", "Claude · подписка"]);
  const zai = groups[0].models.map((m) => `${m.providerID}/${m.id}`);
  assert.ok(zai.includes("zai-coding-plan/glm-5.3-flash"));
  assert.ok(zai.includes("zai/glm-5v-turbo"));
  assert.ok(!zai.some((x) => x.startsWith("opencode/")), "free opencode models are not on the token");
  assert.ok(!zai.includes("zai/glm-4.5"), "legacy pay-per-token GLM hidden");
  assert.ok(zai.length <= 5, `≈4 GLM rows, got ${zai.length}`);
  assert.equal(groups[1].models.length, 2);
  // search hides the whole empty group
  assert.deepEqual(M.pickers.modelGroups(cfg, { query: "opus" }).map((g) => g.engine), ["claude"]);
  // the chat's current (filtered) model stays visible
  const kept = M.pickers.modelGroups(cfg, { keep: { providerID: "opencode", modelID: "big-pickle" } });
  assert.ok(kept[0].models.some((m) => m.id === "big-pickle"));
});

test("Model picker: unknown catalog falls back to connected models (never an empty sheet)", () => {
  const cfg = { models: [{ id: "x1", providerID: "other", label: "X1 (other)", status: "active" }], connected: ["other"], defaults: {} };
  assert.equal(M.pickers.modelGroups(cfg)[0].models[0].id, "x1");
});

test("Model picker: default check on the computed default; mandated glm-5.3-flash beats upstream default", () => {
  const cfg = fixtureProviders();
  const d = M.pickers.pickDefaultModel(cfg);
  assert.equal(`${d.providerID}/${d.id}`, "zai-coding-plan/glm-5.3-flash");
});

test("Model picker: catalog failure → «Не удалось получить список моделей» + «Повторить», not endless loading", async () => {
  M.store.providerCfg.value = null;
  routes = { ...baseRoutes(), "GET /zai/api/provider": () => ({ status: 503, json: {} }) };
  const el = mount(M.pickers.ModelPicker, { value: null, onPick() {} });
  await flush();
  assert.match(el.textContent, /Не удалось получить список моделей/);
  routes["GET /zai/api/provider"] = () => ({ status: 200, json: { all: [{ id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" } } }], connected: ["zai-coding-plan"], default: {} } });
  byText(el, "button", "Повторить").click();
  await flush();
  assert.match(el.textContent, /GLM-5\.3/);
  assert.match(el.textContent, /opencode/);
  assert.ok(!/z\.ai · opencode/.test(el.textContent)); // TASK-01.84
  assert.ok(el.querySelector(".picker-row[aria-pressed]"));
  unmount(el);
});

// ------------------------------------------------- BUG-03.13 / Settings text
test("MCP status: Russian words, raw error only as a short reason, tone per state", () => {
  const f = M.settings.mcpView({ status: "failed", error: "MCP error -32000: Connection closed\n at stack" });
  assert.equal(f.text, "ошибка запуска");
  assert.equal(f.why, "Connection closed");
  assert.equal(f.tone, "bad");
  assert.equal(M.settings.mcpView({ status: "disabled" }).tone, "idle");
  assert.equal(M.settings.mcpView({ status: "needs_auth" }).text, "нужна авторизация");
  assert.match(M.settings.mcpView({ status: "failed" }).why, /перезапуск opencode serve/);
  assert.equal(M.settings.mcpView({ status: "weird" }).text, "состояние неизвестно");
});

test("BUG-192: MCP «pending» (opencode 2.x сразу после старта) — «подключается», не «неизвестно»", () => {
  const p = M.settings.mcpView({ status: "pending" });
  assert.equal(p.text, "подключается");
  assert.equal(p.tone, "idle");
});

test("Subscription reset: lower-case pieces, NBSP inside every number+unit pair", () => {
  const now = Date.UTC(2026, 10, 2, 12, 0);
  const p = M.settings.resetParts({ resetAt: now + (1 * 60 + 58) * 60_000 }, now);
  assert.match(p.when, /^сброс /);
  assert.doesNotMatch(p.when, /МСК|MSK/, "the viewer's own time zone, no fixed zone label");
  assert.equal(p.left, "через 1\u00a0ч 58\u00a0мин");
  assert.equal(M.settings.countdown(4 * 86_400_000 + 5 * 3_600_000), "4\u00a0дн. 5\u00a0ч");
  assert.equal(M.settings.resetParts({ resetAt: now + 10_000 }, now).left, "сейчас");
  assert.match(M.settings.usageUnavailableText({ ok: false, error: "plan-unavailable" }), /не отдал квоты/);
});

test("Temperature (BUG-03.5): live CPU / SMART disk / honest «нет живого датчика» with visible reason", () => {
  assert.equal(M.settings.tempView({ tempC: 54, tempStuck: false }).label, "Температура CPU");
  const disk = M.settings.tempView({ tempC: 27.9, tempStuck: true, diskTempC: 46 });
  assert.equal(disk.label, "Температура диска");
  assert.match(disk.note, /ACPI/);
  const none = M.settings.tempView({ tempC: 27.9, tempStuck: true, diskTempC: null });
  assert.equal(none.value, "нет живого датчика");
  assert.ok(none.note.length > 10, "reason is visible text, not only a title");
});

test("About: opencode version from the server, no literal", () => {
  assert.equal(M.settings.aboutLine("1.6.1", { opencodeVersion: "1.19.5" }), "Teleharness 1.6.1 · opencode 1.19.5 · Claude Code");
  assert.equal(M.settings.aboutLine("1.6.1", null), "Teleharness 1.6.1 · opencode · Claude Code");
  const srcText = readFileSync(path.join(root, "src", "components", "views", "SettingsView.jsx"), "utf8");
  assert.doesNotMatch(srcText, /opencode 1\.\d+\.\d+/);
});

test("Busy sessions (FEAT-07.16 UI): age from claude `since` or first sighting, oldest first", () => {
  const now = 10_000_000;
  const rows = M.settings.busyRows(
    { a: { type: "busy", since: now - 30 * 60_000 }, b: { type: "busy" }, c: { type: "idle" }, d: { type: "idle", pending: { at: 1 } } },
    { sessionsList: [{ id: "a", title: "Долгий" }], seen: { b: now - 5 * 60_000 }, now },
  );
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "d"]);
  assert.equal(rows[0].title, "Долгий");
  assert.equal(rows[0].exact, true);
  assert.equal(rows[1].exact, false);
  assert.equal(rows[2].kind, "stalled");
  assert.equal(M.settings.fmtAge(65 * 60_000), "1\u00a0ч 5\u00a0мин");
});

// ---------------------------------------------------------------- FEAT-03.11
test("Access: labelled «Перевыпустить токен», consequences + «Отмена», one-time token with selection on clipboard failure", async () => {
  M.store.me.value = { id: "admin", name: "admin", role: "admin" };
  const users = [
    { id: "admin", name: "admin", role: "admin" },
    { id: "u1", name: "julia", role: "user", directories: [] },
  ];
  routes = {
    ...baseRoutes(),
    "GET /zai/api/admin/users": () => ({ status: 200, json: users }),
    "POST /zai/api/admin/users/u1/token": () => ({ status: 200, json: { token: "tok-NEW-123" } }),
  };
  Object.defineProperty(globalThis.navigator, "clipboard", { value: undefined, configurable: true });
  globalThis.document.execCommand = () => false;
  const el = mount(M.access.default);
  await flush();
  assert.ok(!el.querySelector(".access-icon-btn"), "no icon-only actions");
  const regen = byText(el, "button", "Перевыпустить токен");
  assert.ok(regen);
  assert.ok(byText(el, "button", "Выключить"));
  assert.ok(byText(el, "button", "Удалить"));
  regen.click();
  await flush();
  assert.match(el.textContent, /Старый токен julia перестанет работать сразу/);
  const armed = byText(el, "button", "Да, перевыпустить");
  assert.ok(armed);
  assert.equal(byText(el, "button", "Удалить").disabled, true, "other actions lock while armed");
  byText(el, "button", "Отмена").click();
  await flush();
  assert.ok(!byText(el, "button", "Да, перевыпустить"), "Отмена disarms");
  assert.ok(!calls.includes("POST /zai/api/admin/users/u1/token"), "nothing sent before the second tap");
  byText(el, "button", "Перевыпустить токен").click();
  await flush();
  byText(el, "button", "Да, перевыпустить").click();
  await flush();
  const body = win.document.body;
  assert.match(body.textContent, /tok-NEW-123/);
  assert.match(body.textContent, /Автокопирование не сработало/);
  assert.ok(body.querySelector(".access-token.is-selected"));
  byText(body, "button", "Закрыть").click();
  await flush();
  assert.doesNotMatch(body.textContent, /tok-NEW-123/, "shown once");
  unmount(el);
});

test("Access: action error texts distinguish refusal and network", () => {
  assert.equal(M.access.actionErrorText({ status: 403 }), "Действие отклонено сервером.");
  assert.match(M.access.actionErrorText(new Error("x")), /проверьте связь/);
  assert.equal(M.access.confirmText("toggle", { name: "ivan", disabled: false }).tone, "warn");
  assert.equal(M.access.confirmText("delete", { name: "ivan" }).tone, "danger");
});

// ------------------------------------------------------------------ Login
test("Login: 401 → field aria-invalid + described error with a hint; network error does not blame the field", async () => {
  M.store.me.value = false;
  routes = { ...baseRoutes(), "POST /zai/api/auth/login": () => ({ status: 401, json: {} }) };
  const el = mount(M.login.default);
  const input = el.querySelector("input");
  input.value = "wrong-token";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await flush(2);
  el.querySelector("form").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(input.getAttribute("aria-describedby"), "login-error");
  assert.match(el.textContent, /проверьте, что вставили его целиком/);
  assert.equal(input.value, "wrong-token", "value kept");
  unmount(el);
  assert.equal(M.login.loginError(new Error("net")).field, false);
  assert.match(M.login.loginError(new Error("net")).text, /нажмите «Войти» ещё раз/);
});

test("Login: «Сессия завершена» only after a 401 drop from a logged-in state", () => {
  M.store.me.value = false;
  M.store.me.value = { id: "u", name: "u", role: "user" };
  assert.equal(M.login.sessionExpired(), false);
  M.store.me.value = false; // AppShell onUnauthorized
  assert.equal(M.login.sessionExpired(), true);
  const el = mount(M.login.default);
  assert.match(el.textContent, /Сессия завершена/);
  unmount(el);
});

test("BUG-143: «О приложении» — версия zai с сервера, opencode + harness OmO, Claude Code с версией", () => {
  const info = { version: "1.9.1", opencodeVersion: "1.19.5", omoVersion: "5.1.60", claudeVersion: "2.1.316" };
  assert.equal(M.settings.aboutLine("1.8.6", info), "Teleharness 1.8.6 (сервер 1.9.1) · opencode 1.19.5 (OmO 5.1.60) · Claude Code 2.1.316");
  // сервер ещё не ответил — константа фронта, неизвестное без цифр
  assert.equal(M.settings.aboutLine("1.9.1", null), "Teleharness 1.9.1 · opencode · Claude Code");
  assert.equal(M.settings.aboutLine("1.9.1", { opencodeVersion: "1.19.5" }), "Teleharness 1.9.1 · opencode 1.19.5 · Claude Code");
});

test("BUG-190: «О приложении» на opencode 2.x — версия opencode и slim", () => {
  const info = { version: "1.16.1", opencodeVersion: "2.2.6", harness: { name: "slim", version: "3.0.7" }, claudeVersion: "2.1.316" };
  assert.equal(M.settings.aboutLine("1.16.1", info), "Teleharness 1.16.1 · opencode 2.2.6 (slim 3.0.7) · Claude Code 2.1.316");
  // старый ответ сервера (только omoVersion) — как раньше
  assert.equal(M.settings.aboutLine("1.16.1", { opencodeVersion: "1.19.5", omoVersion: "5.1.60" }), "Teleharness 1.16.1 · opencode 1.19.5 (OmO 5.1.60) · Claude Code");
});

test("BUG-143: константа версии фронта совпадает с package.json", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const src = readFileSync(path.join(root, "src", "lib", "version.js"), "utf8");
  assert.equal(src.match(/export const VERSION = "([^"]+)"/)?.[1], pkg.version);
});
