// Регресс-тесты аудита клиентского store и UI-компонентов (BUG-304 / TASK-14.21):
// - openSession не перебивает свежий SSE session.idle протухшим /session/status
// - regenerate при сбое sendParts восстанавливает revert (пользователь может вернуть ход)
// - setSessionBinding сохраняет существующие поля teleharness (relays и т.д.)
// - handleEvent обновляет lastEventAt по p.info.sessionID и p.part.sessionID
// - togglePin откатывает только упавший id, не затирая параллельный успешный пин
// - Composer показывает engine-aware подсказку при busy (opencode vs runner)
// - MessageList.followTop безопасно экранирует спецсимволы в data-mid
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    Composer: "src/components/chat/Composer.jsx",
    followTop: "src/components/chat/MessageList.jsx#followTop",
    handleEvent: "src/lib/store/events.js#handleEvent",
  });
  t$ = createHarness(ui);
});

after(() => { ui?.store?.dispose?.(); });

afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.sessions.value = [];
  s.pins.value = [];
  s.busyMap.value = {};
  s.active.value = null;
  s.editing.value = null;
  s.setNotice(null);
  installFetch();
});

test("openSession не откатывает свежий SSE session.idle устаревшим GET /status", async () => {
  const SID = "ses_stale_idle";
  let resolveStatus;
  installFetch([
    { method: "GET", path: `/teleharness/api/session/${SID}/message`, reply: () => [] },
    {
      method: "GET",
      path: "/teleharness/api/status",
      reply: () => new Promise((r) => { resolveStatus = () => r({ [SID]: { type: "busy" } }); }),
    },
  ]);
  ui.store.sessions.value = [{ id: SID, title: "T", time: { created: 1, updated: 1 } }];
  // Фиксируем свежий SSE session.idle ДО openSession
  ui.handleEvent({ type: "session.idle", properties: { sessionID: SID } });

  const openP = ui.store.openSession(SID);
  await t$.waitFor(() => typeof resolveStatus === "function");
  resolveStatus();
  await openP;
  await t$.flush();

  assert.equal(ui.store.active.value?.status, "idle", "свежий idle не должен перетираться протухшим busy");
  assert.equal(Boolean(ui.store.busyMap.value[SID]), false);
});

test("regenerate восстанавливает revert, если повторная отправка sendParts упала", async () => {
  const SID = "ses_regen_fail";
  const revObj = { messageID: "u1" };
  installFetch([
    { method: "POST", path: `/teleharness/api/session/${SID}/revert`, reply: () => ({ id: SID, revert: revObj }) },
    { method: "POST", path: `/teleharness/api/session/${SID}/prompt_async`, reply: () => ({ status: 500, body: { error: "boom" } }) },
  ]);
  ui.store.sessions.value = [
    { id: SID, title: "R", teleharness: { engine: "opencode", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } } },
  ];
  ui.store.active.value = {
    id: SID,
    title: "R",
    status: "idle",
    lastEventAt: Date.now(),
    messages: [
      { info: { id: "u1", role: "user", sessionID: SID, time: { created: 1 } }, parts: [{ id: "p1", type: "text", text: "вопрос" }] },
      { info: { id: "a1", role: "assistant", sessionID: SID, time: { created: 2, completed: 3 } }, parts: [{ id: "p2", type: "text", text: "ответ" }] },
    ],
    loading: false,
    loadError: false,
  };

  const ok = await ui.store.regenerate(SID);
  assert.equal(ok, false);
  const ses = ui.store.sessions.value.find((s) => s.id === SID);
  assert.deepEqual(ses?.revert, revObj, "revert восстановлен после провала sendParts");
});

test("setSessionBinding сохраняет существующие поля teleharness (например relays)", async () => {
  const SID = "ses_relays";
  let resolvePatch;
  installFetch([
    {
      method: "PATCH",
      path: `/teleharness/api/session/${SID}/binding`,
      reply: () => new Promise((r) => { resolvePatch = () => r({ teleharness: { engine: "claude", relays: [{ from: "opencode", to: "claude" }] } }); }),
    },
  ]);
  ui.store.providerCfg.value = {
    models: [
      { id: "glm-5.3", providerID: "zai-coding-plan", engine: "opencode" },
      { id: "claude-opus-5-5", providerID: "anthropic", engine: "claude" },
    ],
  };
  ui.store.sessions.value = [
    {
      id: SID,
      title: "Relay",
      teleharness: {
        engine: "opencode",
        model: { providerID: "zai-coding-plan", modelID: "glm-5.3" },
        relays: [{ from: "claude", to: "opencode", at: 123 }],
        prompted: true,
      },
    },
  ];

  const p = ui.store.setSessionBinding(SID, { model: { providerID: "anthropic", modelID: "claude-opus-5-5" } });
  const optimisticBinding = ui.store.sessions.value.find((s) => s.id === SID)?.teleharness;
  assert.deepEqual(optimisticBinding?.relays, [{ from: "claude", to: "opencode", at: 123 }], "relays не стёрлись оптимистично");
  resolvePatch();
  await p;
});

test("handleEvent обновляет lastEventAt для message.updated (p.info.sessionID) и message.part.updated (p.part.sessionID)", () => {
  const SID = "ses_touch";
  ui.store.active.value = { id: SID, title: "T", status: "busy", lastEventAt: 1000, messages: [], loading: false, loadError: false };
  ui.handleEvent({
    type: "message.updated",
    properties: { info: { id: "a1", role: "assistant", sessionID: SID, time: { created: 2000 } } },
  });
  const t1 = ui.store.active.value.lastEventAt;
  assert.ok(t1 > 1000, "message.updated обновил lastEventAt через p.info.sessionID");

  ui.store.active.value = { ...ui.store.active.value, lastEventAt: 1500 };
  ui.handleEvent({
    type: "message.part.updated",
    properties: { part: { id: "p1", messageID: "a1", sessionID: SID, type: "text", text: "hi" } },
  });
  assert.ok(ui.store.active.value.lastEventAt > 1500, "message.part.updated обновил lastEventAt через p.part.sessionID");
});

test("togglePin откатывает только упавший id и не затирает параллельное обновление pins", async () => {
  let rejectPut;
  installFetch([
    {
      method: "PUT",
      path: "/teleharness/api/me/pins",
      reply: () => new Promise((_, rej) => { rejectPut = () => rej(Object.assign(new Error("fail"), { status: 500 })); }),
    },
  ]);
  ui.store.sessions.value = [
    { id: "s1", title: "1" },
    { id: "s2", title: "2" },
  ];

  const p1 = ui.store.togglePin("s1");
  await t$.waitFor(() => typeof rejectPut === "function");
  // Пока запрос s1 в полёте, список пинов обновился с другого устройства (добавился s2)
  ui.store.pins.value = [...ui.store.pins.value, "s2"];
  rejectPut();
  await p1;

  assert.deepEqual(ui.store.pins.value, ["s2"], "s2 остался закреплённым, отменён только упавший s1");
});

test("Composer.composer-hint различает opencode и runner-движки во время busy", async () => {
  const S_OC = "ses_hint_oc";
  const S_CL = "ses_hint_cl";
  ui.store.sessions.value = [
    { id: S_OC, title: "OC", teleharness: { engine: "opencode", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } } },
    { id: S_CL, title: "CL", teleharness: { engine: "claude", model: { providerID: "anthropic", modelID: "claude-opus-5-5" } } },
  ];

  ui.store.active.value = { id: S_OC, title: "OC", status: "busy", lastEventAt: Date.now(), messages: [], loading: false, loadError: false };
  const h1 = t$.mount(ui.Composer, { status: "busy", onSend: () => {}, onStop: () => {} });
  t$.typeInto($(h1.root, "textarea"), "уточнение");
  await t$.flush();
  assert.match($(h1.root, ".composer-hint")?.textContent ?? "", /доставится и учтётся на ближайшем шаге/);
  h1.unmount();

  ui.store.active.value = { id: S_CL, title: "CL", status: "busy", lastEventAt: Date.now(), messages: [], loading: false, loadError: false };
  const h2 = t$.mount(ui.Composer, { status: "busy", onSend: () => {}, onStop: () => {} });
  t$.typeInto($(h2.root, "textarea"), "уточнение");
  await t$.flush();
  assert.match($(h2.root, ".composer-hint")?.textContent ?? "", /встанет в очередь и уйдёт после текущего хода/);
});

test("MessageList.followTop безопасно экранирует кавычки и спецсимволы в data-mid", () => {
  const el = document.createElement("div");
  const child = document.createElement("div");
  const trickyId = 'msg"1\\2]';
  child.setAttribute("data-mid", trickyId);
  el.appendChild(child);
  Object.defineProperty(el, "scrollHeight", { value: 900 });
  Object.defineProperty(el, "scrollTop", { value: 100 });
  el.getBoundingClientRect = () => ({ top: 0 });
  child.getBoundingClientRect = () => ({ top: 300 });
  const top = ui.followTop(el, trickyId);
  assert.equal(typeof top, "number");
  assert.ok(top < 900, "нашёл элемент с экранированным data-mid вместо падения querySelector");
});
