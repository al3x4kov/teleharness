// Компонентные тесты BUG-294: гидратация live из /status и кнопка «Завершить ход» при зависании ACP после ответа.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch, fetchCalls } from "./helpers/dom.mjs";
import * as turn from "../../src/lib/turn.js";

let ui, t$;
before(async () => {
  ui = await loadUI({
    ChatView: "src/components/views/ChatView.jsx",
  });
  t$ = createHarness(ui);
});
after(() => { ui?.store?.dispose?.(); });
afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  ui.store.active.value = null;
  ui.store.busyMap.value = {};
  ui.store.dialogs.value = [];
  ui.store.providerCfg.value = null;
});

test("BUG-294 UI: bgWorkNotice и ChatView показывают кнопку «Завершить ход» при пост-ответной тишине ACP", async () => {
  const now = Date.now();
  const startedAt = now - 90_000;
  const messages = [
    { info: { id: "u1", role: "user", time: { created: startedAt } }, parts: [{ type: "text", text: "Сделай релиз" }] },
    {
      info: { id: "a1", role: "assistant", parentID: "u1", providerID: "acp-antigravity", modelID: "gemini-4-neon-medium", time: { created: startedAt } },
      parts: [{ type: "text", text: "Релиз 2.4.7 полностью проверен." }],
    },
  ];

  const brief = turn.bgWorkNotice({
    status: "busy",
    engine: "acp",
    messages,
    live: { since: startedAt, lastActivityAt: now - 8_000, hasAnswerText: true, queued: 0 },
    now,
  });
  assert.ok(brief);
  assert.equal(brief.canRelease, false);

  const hung = turn.bgWorkNotice({
    status: "busy",
    engine: "acp",
    messages,
    live: { since: startedAt, lastActivityAt: now - 45_000, hasAnswerText: true, queued: 0 },
    now,
  });
  assert.ok(hung);
  assert.equal(hung.kind, "acp-hold");
  assert.equal(hung.canRelease, true);
  assert.ok(/не закрыл ход/i.test(hung.title), `ожидалось честное сообщение о незакрытом ходе: ${hung.title}`);

  const hungQueued = turn.bgWorkNotice({
    status: "busy",
    engine: "acp",
    messages: [...messages, { info: { id: "u2", role: "user", queued: true, time: { created: now - 5_000 } }, parts: [{ type: "text", text: "Оба бага" }] }],
    live: { since: startedAt, lastActivityAt: now - 12_000, hasAnswerText: true, queued: 1 },
    now,
  });
  assert.ok(hungQueued);
  assert.equal(hungQueued.canRelease, true);

  installFetch([
    { method: "POST", path: /\/session\/s_hung\/abort$/, reply: () => ({ ok: true }) },
    { method: "GET", path: "/teleharness/api/status", reply: () => ({}) },
    { method: "GET", path: /\/session\/s_hung\/message$/, reply: () => messages },
  ]);

  const model = { providerID: "acp-antigravity", modelID: "gemini-4-neon-medium" };
  ui.store.sessions.value = [{ id: "s_hung", title: "Hung", directory: "/tmp", teleharness: { engine: "acp", model, prompted: true } }];
  ui.store.busyMap.value = { s_hung: startedAt };
  ui.store.active.value = {
    id: "s_hung",
    status: "busy",
    messages,
    lastActivityAt: now - 45_000,
    activeTasks: [],
    hasAnswerText: true,
    queuedCount: 0,
  };
  const { root } = t$.mount(ui.ChatView, { id: "s_hung" });
  const btn = $(root, ".bg-work-btn");
  assert.ok(btn, "в .bg-work-bar должна быть кнопка .bg-work-btn («Завершить ход»)");
  assert.ok(/Завершить ход/i.test(btn.textContent));
  btn.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    fetchCalls.some((c) => c.method === "POST" && c.path.includes("/session/s_hung/abort") && c.query?.finish === "1"),
    `ожидался POST /abort?finish=1, получено: ${JSON.stringify(fetchCalls)}`,
  );
});

test("BUG-294 store: openSession сразу подтягивает live (lastActivityAt, lastAction, hasAnswerText, queuedCount) из /status", async () => {
  const now = Date.now();
  const startedAt = now - 600_000;
  const lastOutputAt = now - 300_000;
  installFetch([
    {
      method: "GET",
      path: "/teleharness/api/status",
      reply: () => ({
        s_hyd: {
          type: "busy",
          since: startedAt,
          live: {
            startedAt,
            lastOutputAt,
            lastAction: "bash",
            queued: 1,
            activeTasks: [],
            hasAnswerText: true,
          },
        },
      }),
    },
    { method: "GET", path: /\/session\/s_hyd\/message$/, reply: () => [] },
  ]);
  ui.store.sessions.value = [{ id: "s_hyd", title: "Hyd", directory: "/tmp", teleharness: { engine: "acp", prompted: true } }];
  await ui.store.openSession("s_hyd");
  assert.equal(ui.store.active.value.lastActivityAt, lastOutputAt, "openSession должен сразу заполнить lastActivityAt из /status.live");
  assert.equal(ui.store.active.value.lastAction?.label, "команда");
  assert.equal(ui.store.active.value.hasAnswerText, true);
  assert.equal(ui.store.active.value.queuedCount, 1);
});
