// BUG-264 п.2 (dogfood 2026-11-19, C/N2): после Relay GLM → Claude старая ошибка z.ai в ленте
// была подписана «Исчерпан лимит подписки Claude» и с точкой модели цвета Claude: движок
// подписи брался из ТЕКУЩЕЙ привязки чата, а не из сообщения (info.providerID).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ ChatView: "src/components/views/ChatView.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.sessions.value = [];
  s.busyMap.value = {};
  s.active.value = null;
  s.providerCfg.value = null;
  s.me.value = null;
  installFetch();
});

const SID = "ses_bubble_engine";
const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3" };
const HAIKU = { providerID: "anthropic", modelID: "claude-haiku-4-5" };
const PROVIDERS = {
  all: [
    { id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" } } },
    { id: "anthropic", models: { "claude-haiku-4-5": { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" } } },
  ],
  connected: ["zai-coding-plan", "anthropic"],
  default: {},
};
const QUOTA = { name: "APIError", data: { message: "429 Too Many Requests: usage limit exceeded", statusCode: 429 } };
const HISTORY = [
  { info: { id: "u1", role: "user", sessionID: SID, time: { created: T0 } }, parts: [{ id: "pu1", type: "text", text: "привет" }] },
  {
    info: { id: "a1", role: "assistant", sessionID: SID, parentID: "u1", agent: "orchestrator", ...GLM, error: QUOTA, time: { created: T0 + 500, completed: T0 + 900 } },
    parts: [],
  },
  { info: { id: "u2", role: "user", sessionID: SID, time: { created: T0 + 60_000 } }, parts: [{ id: "pu2", type: "text", text: "Продолжай" }] },
  {
    info: { id: "a2", role: "assistant", sessionID: SID, parentID: "u2", ...HAIKU, time: { created: T0 + 61_000, completed: T0 + 62_000 } },
    parts: [{ id: "pa2", type: "text", text: "Ок" }],
  },
];

test("BUG-264 п.2: после Relay на Claude старая ошибка z.ai подписана по движку сообщения, а не чата", async () => {
  const teleharness = {
    engine: "claude",
    model: HAIKU,
    agent: null,
    prompted: true,
    source: "stored",
    relays: [{ at: T0 + 30_000, from: { engine: "opencode", ...GLM }, to: { engine: "claude", ...HAIKU } }],
  };
  const s = { id: SID, title: "Relay", directory: "/home/u", time: { created: T0, updated: T0 }, teleharness };
  installFetch([
    { method: "GET", path: "/teleharness/api/session", reply: () => [s] },
    { method: "GET", path: `/teleharness/api/session/${SID}/message`, reply: () => HISTORY },
    { method: "GET", path: "/teleharness/api/provider", reply: () => PROVIDERS },
    { method: "GET", path: "/teleharness/api/me/pins", reply: () => ({ ids: [], max: 200 }) },
  ]);
  ui.store.me.value = { id: "admin", name: "admin", role: "admin" };
  ui.store.sessions.value = [s];
  await ui.store.loadProviders?.();
  const { root } = t$.mount(ui.ChatView, { id: SID });
  const mark = await t$.waitFor(() => $$(root, ".msg-turn-error")[0]);
  assert.match(mark.textContent, /Исчерпан лимит z\.ai/);
  assert.doesNotMatch(mark.textContent, /Claude/);
  const glmBubble = root.querySelector('[data-mid="a1"]');
  assert.ok(glmBubble, "ответ GLM в ленте");
  assert.equal(glmBubble.querySelector(".msg-avatar.is-claude"), null, "точка модели у ответа GLM — не цвета Claude");
  const claudeBubble = root.querySelector('[data-mid="a2"]');
  assert.ok(claudeBubble?.querySelector(".msg-avatar.is-claude"), "ответ Claude по-прежнему с точкой Claude");
});
