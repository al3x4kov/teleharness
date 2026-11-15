// FEAT-18.6: Настройки → «Продолжать автоматически при лимите» (выключатель + порядок запасных
// моделей, до 3), отметка «передано автоматически: лимит» в ленте, плашка уходит, когда сервер
// сам передал чат.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    AutoRelayRow: "src/components/views/AutoRelayRow.jsx",
    addModel: "src/components/views/AutoRelayRow.jsx#addModel",
    removeAt: "src/components/views/AutoRelayRow.jsx#removeAt",
    moveUp: "src/components/views/AutoRelayRow.jsx#moveUp",
    SettingsView: "src/components/views/SettingsView.jsx",
    ChatView: "src/components/views/ChatView.jsx",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.sessions.value = [];
  s.active.value = null;
  s.providerCfg.value = null;
  s.me.value = null;
  installFetch();
});

const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3" };
const FLASH = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const HAIKU = { providerID: "anthropic", modelID: "claude-haiku-4-5" };
const PROVIDERS = {
  all: [
    { id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" }, "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM-5.3 Flash" } } },
    { id: "anthropic", models: { "claude-haiku-4-5": { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" } } },
  ],
  connected: ["zai-coding-plan", "anthropic"],
  default: {},
};

function settingRoutes(initial = { on: false, order: [] }, { reject = null } = {}) {
  const state = { ...initial };
  const puts = [];
  installFetch([
    { method: "GET", path: "/teleharness/api/me/auto-relay", reply: () => ({ ...state, max: 3 }) },
    {
      method: "PUT",
      path: "/teleharness/api/me/auto-relay",
      reply: (c) => {
        puts.push(c.body);
        if (reject && reject(c.body)) return { status: 403, body: { error: "model not allowed" } };
        Object.assign(state, c.body);
        return { ...state, max: 3 };
      },
    },
    { method: "GET", path: "/teleharness/api/provider", reply: () => PROVIDERS },
  ]);
  return puts;
}
async function mountRow(initial, opts) {
  const puts = settingRoutes(initial, opts);
  await ui.store.refreshProvider();
  const h = t$.mount(ui.AutoRelayRow);
  await t$.waitFor(() => $(h.root, '[role="switch"]') && !$(h.root, '[role="switch"]').disabled);
  return { ...h, puts };
}
const sw = (root) => $(root, '[role="switch"]');
const idle = (root) => t$.waitFor(() => !sw(root).disabled);
const names = (root) => $$(root, ".autorelay-name").map((n) => n.textContent.trim());

test("FEAT-18.6: порядок — добавить без повторов и не больше 3, поднять, убрать", () => {
  let o = ui.addModel([], GLM);
  o = ui.addModel(o, GLM);
  assert.deepEqual(o, [GLM], "повтор не добавляется");
  o = ui.addModel(ui.addModel(o, FLASH), HAIKU);
  assert.deepEqual(ui.addModel(o, { providerID: "x", modelID: "y" }), o, "не больше трёх");
  assert.deepEqual(ui.moveUp(o, 2), [GLM, HAIKU, FLASH]);
  assert.deepEqual(ui.moveUp(o, 0), o);
  assert.deepEqual(ui.removeAt(o, 1), [GLM, HAIKU]);
});

test("FEAT-18.6: по умолчанию выключено — выключатель, подсказка про плашку, списка нет", async () => {
  const { root } = await mountRow();
  assert.equal(sw(root).getAttribute("aria-checked"), "false");
  assert.match(root.textContent, /Продолжать автоматически при лимите/);
  assert.match(root.textContent, /Выключено — на плашке лимита кнопка «Продолжить в …»/);
  assert.equal($(root, ".autorelay-list"), null);
  assert.equal(byText(root, "button", "Добавить модель"), null);
});

test("FEAT-18.6: включение и выбор порядка из доступных моделей — сохраняется на сервере", async () => {
  const { root, puts } = await mountRow();
  t$.click(sw(root));
  await t$.waitFor(() => puts.length === 1 && sw(root).getAttribute("aria-checked") === "true");
  await idle(root);
  assert.deepEqual(puts[0], { on: true, order: [] });
  assert.match(root.textContent, /Добавьте хотя бы одну модель/);
  for (const name of ["GLM-5.3 Flash", "Claude Haiku 4.5"]) {
    t$.click(byText(root, "button", "Добавить модель"));
    const row = await t$.waitFor(() => [...(document.querySelector('.sheet[aria-label="Запасная модель"]')?.querySelectorAll(".picker-row") ?? [])].find((r) => r.textContent.includes(name)));
    assert.ok(row, `в выборе есть ${name}`);
    t$.click(row);
    await t$.waitFor(() => document.querySelector(".sheet") == null && names(root).some((n) => n.includes(name)));
    await idle(root);
  }
  assert.deepEqual(puts.at(-1), { on: true, order: [FLASH, HAIKU] });
  assert.match(names(root)[0], /GLM-5\.3 Flash · z\.ai/);
  assert.match(names(root)[1], /Claude Haiku 4\.5 · Claude/);
  // поднять Haiku наверх
  t$.click($(root, 'button[aria-label="Выше: Claude Haiku 4.5 · Claude"]'));
  await t$.waitFor(() => /Haiku/.test(names(root)[0]));
  await idle(root);
  assert.deepEqual(puts.at(-1).order, [HAIKU, FLASH]);
  // тап-цели не меньше 40 px (стили) — кнопки есть и подписаны
  for (const b of $$(root, ".autorelay-btn")) assert.ok(b.getAttribute("aria-label"));
  t$.click($(root, 'button[aria-label="Убрать: GLM-5.3 Flash · z.ai"]'));
  await t$.waitFor(() => names(root).length === 1);
  assert.deepEqual(puts.at(-1), { on: true, order: [HAIKU] });
});

test("FEAT-18.6: три модели — «Добавить» скрыта; отказ сервера (403) — откат и понятный текст", async () => {
  const { root, puts } = await mountRow({ on: true, order: [GLM, FLASH, HAIKU] }, { reject: (b) => b.order?.[0]?.modelID === "glm-5.3-flash" });
  assert.equal(names(root).length, 3);
  assert.equal(byText(root, "button", "Добавить модель"), null);
  t$.click(await t$.waitFor(() => $(root, 'button[aria-label="Выше: GLM-5.3 Flash · z.ai"]')));
  await t$.waitFor(() => puts.length === 1 && $(root, ".set-warn[role=alert]"));
  await idle(root);
  assert.match($(root, ".set-warn[role=alert]").textContent, /Эта модель вам недоступна/);
  assert.match(names(root)[0], /^GLM-5.3 ·/, "порядок вернулся к сохранённому");
});

test("FEAT-18.6: строка — в Настройках → «Модель и агенты»", async () => {
  settingRoutes();
  ui.store.me.value = { id: "u_t", name: "alice", role: "user" };
  const { root } = t$.mount(ui.SettingsView, { section: "models" });
  await t$.waitFor(() => /Продолжать автоматически при лимите/.test(root.textContent));
  assert.ok($(root, '[data-feat="FEAT-18.6"] [role="switch"]'));
});

const SID = "ses_auto";
const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);
const msg = (id, role, at, text, extra = {}) => ({ info: { id, role, sessionID: SID, time: { created: at, completed: role === "assistant" ? at + 500 : undefined }, ...extra }, parts: [{ id: `p_${id}`, type: "text", text }] });

test("FEAT-18.6: сервер сам передал чат — плашка лимита уходит, в ленте «передано автоматически: лимит»", async () => {
  const claude = { engine: "claude", model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, agent: null, prompted: true, source: "stored" };
  const s = { id: SID, title: "Отчёты", directory: "C:\\Users\\USER", time: { created: T0, updated: T0 }, teleharness: claude };
  const messages = [msg("u1", "user", T0, "Доделай пятый"), msg("a1", "assistant", T0 + 1000, "Claude AI usage limit reached|1731000000")];
  installFetch([
    { method: "GET", path: "/teleharness/api/session", reply: () => [s] },
    { method: "GET", path: `/teleharness/api/session/${SID}/message`, reply: () => messages },
    { method: "GET", path: "/teleharness/api/provider", reply: () => PROVIDERS },
    { method: "GET", path: "/teleharness/api/subscriptions", reply: () => ({ providers: [] }) },
    { method: "GET", path: "/teleharness/api/me/pins", reply: () => ({ ids: [], max: 200 }) },
  ]);
  ui.store.me.value = { id: "admin", name: "admin", role: "admin" };
  ui.store.sessions.value = [s];
  await ui.store.refreshProvider();
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $(root, ".turn-error"));
  const mark = { at: T0 + 2000, from: { engine: "claude", ...claude.model }, to: { engine: "opencode", ...GLM }, reason: "limit-auto" };
  t$.act(() => ui.store.handleEvent({ type: "session.updated", properties: { sessionID: SID, info: { id: SID, teleharness: { engine: "opencode", model: GLM, agent: null, prompted: true, source: "stored", relays: [mark] } } } }));
  await t$.waitFor(() => $(root, ".turn-error") == null);
  const el = await t$.waitFor(() => $(root, ".relay-mark-auto"));
  assert.match(el.textContent, /передано автоматически: лимит/);
  assert.match(el.getAttribute("aria-label"), /Чат передан: Claude Haiku 4\.5 → GLM-5\.3, .*передано автоматически: лимит/);
  assert.equal(fetchCalls.some((c) => c.method === "POST" && /\/prompt/.test(c.path)), false, "«продолжи» отправляет сервер, не клиент");
});
