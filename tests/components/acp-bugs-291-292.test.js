// UI-регрессия BUG-291 (видимость фоновой задачи и причины очереди в Gemini/ACP) и BUG-292 (поддержка картинок в Gemini 4 Neon).
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";
import { acpProviderCatalog } from "../../lib/acp-registry.js";
import { normalizeProviders } from "../../src/lib/normalize.js";
import * as turn from "../../src/lib/turn.js";

let ui, t$;
before(async () => {
  ui = await loadUI({
    ChatView: "src/components/views/ChatView.jsx",
    Composer: "src/components/chat/Composer.jsx",
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
  installFetch();
});

function brokenImages(t) {
  const Orig = globalThis.Image;
  globalThis.Image = class {
    set src(_) { queueMicrotask(() => this.onerror?.(new Error("decode"))); }
  };
  t.after(() => { globalThis.Image = Orig; });
}

test("BUG-292 UI: прикрепление PNG в чате с Gemini 4 Neon (Medium) не показывает предупреждение о неподдерживаемых изображениях", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  brokenImages(t);
  installFetch([{ method: "POST", path: "/teleharness/api/upload", reply: () => ({ name: "pic.png" }) }]);
  const cat = acpProviderCatalog({ all: [], connected: [], default: {} }, ["antigravity"], {
    antigravity: {
      availableModels: [{ modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" }],
      currentModelId: "gemini-4-neon-medium",
      promptCapabilities: { image: true },
    },
  });
  ui.store.providerCfg.value = normalizeProviders(cat);
  const model = { providerID: "acp-antigravity", modelID: "gemini-4-neon-medium" };
  ui.store.sessions.value = [{ id: "s_img", title: "Img", directory: "/tmp", teleharness: { engine: "acp", model, prompted: true } }];
  ui.store.active.value = { id: "s_img", status: "idle", messages: [] };

  const filesApi = { current: null };
  const { root } = t$.mount(ui.Composer, { sessionId: "s_img", status: "idle", model, filesApi, onSend() {} });
  assert.ok(filesApi.current?.add, "filesApi.current.add должен быть доступен");
  const file = new globalThis.window.File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" });
  filesApi.current.add([file]);
  await t$.waitFor(() => $(root, ".attach-name") != null);
  const warn = $(root, ".composer-vision");
  assert.equal(warn, null, `предупреждение «не анализирует изображения» не должно показываться для Gemini 4 Neon, найдено: ${warn?.textContent}`);
});

test("BUG-291 UI: bgWorkNotice, livenessLine и ChatView показывают активную фоновую задачу и причину ожидания очереди", async () => {
  assert.equal(typeof turn.bgWorkNotice, "function", "src/lib/turn.js должен экспортировать bgWorkNotice");

  const startedAt = Date.now() - 12_000;
  const messages = [
    { info: { id: "u1", role: "user", time: { created: startedAt - 1000 } }, parts: [{ type: "text", text: "Проверь" }] },
    {
      info: { id: "a1", role: "assistant", parentID: "u1", providerID: "acp-antigravity", modelID: "gemini-4-neon-medium", time: { created: startedAt } },
      parts: [
        { type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { command: "sleep 8 && echo BG_OK", description: "sleep 8 && echo BG_OK" }, time: { start: startedAt } } },
        { type: "text", text: "Выберите А или Б?" },
      ],
    },
    { info: { id: "u2", role: "user", queued: true, time: { created: Date.now() - 2000 } }, parts: [{ type: "text", text: "1 А" }] },
  ];

  const notice = turn.bgWorkNotice({
    status: "busy",
    engine: "acp",
    messages,
    live: { since: startedAt, activeTasks: [{ id: "c1", tool: "bash", detail: "sleep 8 && echo BG_OK", startedAt }], hasAnswerText: true, queued: 1 },
  });
  assert.ok(notice, "bgWorkNotice должен вернуть описание фоновой задачи");
  assert.ok(notice.title.includes("sleep 8 && echo BG_OK"), `заголовок должен назвать задачу, получено: ${notice.title}`);
  assert.ok(notice.detail.includes("очеред"), `подпись должна объяснить ожидание очереди, получено: ${notice.detail}`);

  const silentNotice = turn.bgWorkNotice({
    status: "busy",
    engine: "acp",
    messages: [
      messages[0],
      { info: messages[1].info, parts: [{ type: "text", text: "Выберите А или Б?" }] },
      messages[2],
    ],
    live: { since: startedAt, lastActivityAt: Date.now() - 10_000, hasAnswerText: true, queued: 1 },
  });
  assert.ok(silentNotice, "bgWorkNotice должен объяснить удержание ACP-хода даже без открытого tool_call");
  assert.ok(/Gemini|фонов/i.test(silentNotice.title));

  const line = turn.livenessLine({
    since: startedAt,
    lastAction: { label: "пишет ответ", at: Date.now() - 2000 },
    activeTasks: [{ id: "c1", tool: "bash", detail: "sleep 8 && echo BG_OK", startedAt }],
  });
  assert.ok(line.includes("sleep 8 && echo BG_OK"), `livenessLine должна показать активную задачу: ${line}`);

  const model = { providerID: "acp-antigravity", modelID: "gemini-4-neon-medium" };
  ui.store.sessions.value = [{ id: "s_bg", title: "BG", directory: "/tmp", teleharness: { engine: "acp", model, prompted: true } }];
  ui.store.busyMap.value = { s_bg: startedAt };
  ui.store.active.value = {
    id: "s_bg",
    status: "busy",
    messages,
    lastActivityAt: Date.now() - 2000,
    activeTasks: [{ id: "c1", tool: "bash", detail: "sleep 8 && echo BG_OK", startedAt }],
    hasAnswerText: true,
    queuedCount: 1,
  };
  const { root } = t$.mount(ui.ChatView, { id: "s_bg" });
  const bar = $(root, ".bg-work-bar");
  assert.ok(bar, "ChatView должен показывать полосу .bg-work-bar с причиной ожидания");
  assert.ok(bar.textContent.includes("sleep 8 && echo BG_OK"), `текст полосы должен содержать задачу: ${bar.textContent}`);
});

test("BUG-291 store: teleharness.keepalive обновляет activeTasks/hasAnswerText/queuedCount, а session.idle их сбрасывает", async () => {
  const startedAt = Date.now() - 5_000;
  ui.store.sessions.value = [{ id: "s_ka", title: "KA", directory: "/tmp", teleharness: { engine: "acp", prompted: true } }];
  ui.store.busyMap.value = { s_ka: startedAt };
  ui.store.active.value = { id: "s_ka", status: "busy", messages: [] };

  ui.store.handleEvent({
    type: "teleharness.keepalive",
    properties: {
      sessionID: "s_ka",
      lastAction: "bash",
      lastOutputAt: Date.now() - 1000,
      activeTasks: [{ id: "c1", tool: "bash", detail: "sleep 8", startedAt }],
      hasAnswerText: true,
      queued: 1,
    },
  });
  assert.equal(ui.store.active.value.activeTasks?.length, 1);
  assert.equal(ui.store.active.value.activeTasks[0].detail, "sleep 8");
  assert.equal(ui.store.active.value.hasAnswerText, true);
  assert.equal(ui.store.active.value.queuedCount, 1);

  ui.store.handleEvent({ type: "session.idle", properties: { sessionID: "s_ka" } });
  assert.deepEqual(ui.store.active.value.activeTasks, []);
  assert.equal(ui.store.active.value.hasAnswerText, false);
  assert.equal(ui.store.active.value.queuedCount, 0);
});
