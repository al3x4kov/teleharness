// BUG-290 (BUG-01.91): полоса фоновых агентов над полем ввода остаётся видимой
// во время нового основного хода, показывает текущее действие (обновляется вместе
// с шагами карточки) и работает в обоих режимах детализации без дублирования в ленте.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

const DIR = "/srv/test/bg-status";
const T = Date.now() - 60_000;

let ui, t$;
before(async () => {
  ui = await loadUI({
    ChatView: "src/components/views/ChatView.jsx",
    BgAgentsBar: "src/components/chat/BgAgentsBar.jsx",
  });
  t$ = createHarness(ui);
});

afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.setPrefs({ execDetail: true });
  s.me.value = null;
  s.sessions.value = [];
  s.active.value = null;
  s.setActiveId(null);
  s.busyMap.value = {};
  s.dialogs.value = [];
  s.resetChildFeeds();
  installFetch();
});

const claudeTaskPart = (teleharnessRun, agent = "workflow") => ({
  id: "pt-bg",
  type: "tool",
  tool: "task",
  callID: "toolu_bg_1",
  state: {
    status: "completed",
    input: { subagent_type: agent, description: "Проверка репо", run_in_background: true },
    metadata: { teleharnessRun },
  },
});

function makeFeed(sid, teleharnessRun, extraUser = false) {
  const msgs = [
    { info: { id: "u1", role: "user", sessionID: sid, time: { created: T } }, parts: [{ id: "p1", type: "text", text: "Проверь репо" }] },
    {
      info: { id: "a1", role: "assistant", sessionID: sid, providerID: "anthropic", modelID: "claude-sonnet-4-5", time: { created: T + 1000, completed: T + 4000 } },
      parts: [claudeTaskPart(teleharnessRun), { id: "t1", type: "text", text: "Запустил workflow в фоне." }],
    },
  ];
  if (extraUser) {
    msgs.push({ info: { id: "u2", role: "user", sessionID: sid, time: { created: T + 10_000 } }, parts: [{ id: "p2", type: "text", text: "Решение — а" }] });
  }
  return msgs;
}

test("BUG-290: при новом основном ходе полоса остаётся над полем ввода, показывает имя и текущее действие, обновляется и исчезает после завершения", async () => {
  ui.store.setPrefs({ execDetail: true });
  const SID = "ses_bug290_busy";
  const SESSION = { id: SID, title: "Аудит", directory: DIR, teleharness: { model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } } };
  const feedStep1 = makeFeed(SID, {
    status: "running",
    startedAt: T + 1000,
    steps: [{ id: "s1", kind: "tool", tool: "read", object: "server.js", status: "running" }],
  }, true);

  installFetch([
    { method: "GET", path: "/teleharness/api/session", reply: () => [SESSION] },
    { method: "GET", path: `/teleharness/api/session/${SID}/message`, reply: () => feedStep1 },
  ]);

  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length >= 3);

  // Новый основной ход активен (busy = true, bgAgents = false)
  t$.act(() => {
    ui.store.active.value = { ...ui.store.active.value, messages: feedStep1, status: "busy", bgAgents: false };
    ui.store.busyMap.value = { [SID]: Date.now() };
  });

  const bar = await t$.waitFor(() => $(root, ".bg-bar"));
  assert.match($(bar, ".bt").textContent, /workflow/, "имя фонового агента видно");
  assert.match($(bar, ".bt-act")?.textContent ?? "", /Читает\s+server\.js/, "текущее действие видно в полосе");

  // Смена шага фонового агента → действие в полосе обновляется
  const feedStep2 = makeFeed(SID, {
    status: "running",
    startedAt: T + 1000,
    steps: [
      { id: "s1", kind: "tool", tool: "read", object: "server.js", status: "done" },
      { id: "s2", kind: "tool", tool: "bash", object: "npm test", status: "running" },
    ],
  }, true);
  t$.act(() => {
    ui.store.active.value = { ...ui.store.active.value, messages: feedStep2, status: "busy", bgAgents: false };
  });
  await t$.waitFor(() => /Запускает команду\s+npm test/.test($(root, ".bg-bar .bt-act")?.textContent ?? ""));

  // Открытый диалог скрывает полосу (приоритет диалога)
  t$.act(() => {
    ui.store.dialogs.value = [{ id: "dlg1", kind: "permission", sessionID: SID, permission: "bash", patterns: ["npm test"] }];
  });
  await t$.waitFor(() => $(root, ".bg-bar") == null);
  t$.act(() => {
    ui.store.dialogs.value = [];
  });
  await t$.waitFor(() => $(root, ".bg-bar") != null);

  // Агент завершился → полоса исчезла, основной ход (status: busy) сохраняется
  const feedDone = makeFeed(SID, {
    status: "completed",
    startedAt: T + 1000,
    endedAt: T + 20_000,
    steps: [{ id: "s1", kind: "tool", tool: "read", object: "server.js", status: "done" }],
    output: "Готово",
  }, true);
  t$.act(() => {
    ui.store.active.value = { ...ui.store.active.value, messages: feedDone, status: "busy", bgAgents: false };
  });
  await t$.waitFor(() => $(root, ".bg-bar") == null);
  assert.equal(ui.store.active.value.status, "busy", "состояние основного хода сохраняется");
});

test("BUG-290 (вариант 4А): при выключенной детализации имя и действие видны над полем ввода без дублирования индикатора в ленте", async () => {
  ui.store.setPrefs({ execDetail: false });
  const SID = "ses_bug290_compact";
  const SESSION = { id: SID, title: "Аудит", directory: DIR, teleharness: { model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } } };
  const feed = makeFeed(SID, {
    status: "running",
    startedAt: T + 1000,
    steps: [{ id: "s1", kind: "tool", tool: "bash", object: "npm test", status: "running" }],
  }, false);

  installFetch([
    { method: "GET", path: "/teleharness/api/session", reply: () => [SESSION] },
    { method: "GET", path: `/teleharness/api/session/${SID}/message`, reply: () => feed },
  ]);

  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length >= 2);
  t$.act(() => {
    ui.store.active.value = { ...ui.store.active.value, messages: feed, status: "idle", bgAgents: false };
  });

  const bar = await t$.waitFor(() => $(root, ".bg-bar"));
  assert.match($(bar, ".bt").textContent, /workflow/, "имя агента видно над полем ввода");
  assert.match($(bar, ".bt-act")?.textContent ?? "", /Запускает команду\s+npm test/, "текущее действие видно над полем ввода");
  assert.equal($(root, ".msg-preloader.is-agents"), null, "дублирующего индикатора «Работают агенты» в ленте нет");
});
