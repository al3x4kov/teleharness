// FEAT-01.77: подключение компонентов агентов к данным стора (design §5,
// tasks 3.1–3.3, вторая половина): связка AgentRuns в ленте, сводка хода,
// прелоадер с подписью при выключенной детализации, полоса фоновых агентов.
// Данные — живые фикстуры opencode 2.2.6 (ленты прогоняются через
// createV2Rewriter, как в tests/subagents.test.js) и Claude-часть с zaiRun.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";
import { createV2Rewriter } from "../../lib/oc-client.js";
import { makeMessage } from "../../src/lib/normalize.js";

const readJson = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const SYNC = readJson("v2-subagent-sync.json");
const BG = readJson("v2-subagent-background.json");
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const DIR = "D:\\Chats\\wiring";
const T = Date.now() - 60_000;

let ui, t$;
before(async () => {
  ui = await loadUI({
    MessageList: "src/components/chat/MessageList.jsx",
    MessageBubble: "src/components/chat/MessageBubble.jsx",
    ChatView: "src/components/views/ChatView.jsx",
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
  s.resetChildFeeds();
  installFetch();
});

// ---- прогон сырых событий v2 через переписыватель → ленты сессий ------------

function replay(fx) {
  const feeds = new Map(); // sessionID → сообщения
  const emit = (evt) => {
    const type = evt?.type;
    const p = evt?.properties ?? {};
    const sid = p.sessionID;
    if (type === "message.updated") {
      const info = p.info ?? p;
      const arr = feeds.get(sid) ?? [];
      const i = arr.findIndex((m) => m.info.id === info.id);
      if (i >= 0) arr[i] = { info: { ...arr[i].info, ...info }, parts: arr[i].parts };
      else arr.push({ info: { ...info }, parts: [] });
      feeds.set(sid, arr);
      return;
    }
    if (type === "message.part.updated") {
      const part = p.part;
      const arr = feeds.get(sid) ?? [];
      let m = arr.find((x) => x.info.id === part.messageID);
      if (!m) {
        m = { info: { id: part.messageID, sessionID: sid, role: "assistant", time: {} }, parts: [] };
        arr.push(m);
        feeds.set(sid, arr);
      }
      const i = m.parts.findIndex((x) => x.id === part.id);
      if (i >= 0) m.parts[i] = { ...m.parts[i], ...part };
      else m.parts.push({ ...part });
    }
  };
  const rewrite = createV2Rewriter({ emit, throttleMs: 0 });
  let n = 0;
  return {
    feeds,
    feedTo: async (k) => {
      for (; n < k; n += 1) {
        const ev = rewrite(fx.events[n]);
        if (ev) emit(ev);
      }
      await tick(30); // троттлинг переписывателя (0 мс → микротаски/таймеры)
    },
  };
}

const evIdx = (fx, pred) => fx.events.findIndex(pred);

// Живая часть несёт ввод/метаданные так же, как их кладёт исправленный
// переписыватель (см. tests/subagents.test.js, patchPartMeta/patchPartInput).
function patchPart(messages, callID, patch) {
  for (const m of messages ?? []) {
    for (const p of m.parts ?? []) {
      if (p?.type === "tool" && (p.callID ?? p.id) === callID) {
        p.state = { ...p.state, ...patch };
      }
    }
  }
}

// ---- лента для Mount ---------------------------------------------------------

const hist = (fx) => fx.history.messages.map((m) => makeMessage(m.info, m.parts));

function mountFeed(messages, { busy = false, sid, session } = {}) {
  const id = sid ?? messages[0]?.info?.sessionID ?? "ses_wiring";
  ui.store.sessions.value = [session ?? { id, title: "x", directory: DIR }];
  ui.store.setActiveId(id);
  ui.store.active.value = { id, messages, status: busy ? "busy" : "idle" };
  return t$.mount(ui.MessageList, { sessionId: id, messages, streamingId: null, busy });
}

function putFeed(id, messages) {
  ui.store.childFeeds.value = new Map([...ui.store.childFeeds.value, [id, { messages, loadedAt: 1, complete: true, loading: false, error: false }]]);
}

const agentPart = (callID, { child, agent = "explorer", description = "Файлы", background = true, state = "completed" } = {}) => ({
  id: callID,
  type: "tool",
  tool: "subagent",
  callID,
  state: {
    status: state,
    input: { agent, description, background },
    ...(child ? { metadata: { sessionID: child, status: "running" } } : {}),
  },
});
const childFeed = (text) => [
  { info: { id: `${text.length}u`, role: "user", sessionID: "c" }, parts: [] },
  { info: { id: `${text.length}a`, role: "assistant", sessionID: "c", tokens: { total: 1200 } }, parts: [{ id: "t1", type: "text", text }] },
];

// ---- (а) детализация включена: работает → готов -------------------------------

test("FEAT-01.77 (а): детализация включена — работает: .sa.is-run с именем, задачей и «сейчас»; готов: .is-ok свёрнута", async () => {
  ui.store.setPrefs({ execDetail: true });
  const MAIN = SYNC.sessionID;
  const CHILD = "ses_e36eb8e5cffeiN1GF5pBbIeL7U";
  const CALL = "call_5ebef332437a4021944ff6fb";
  const READ = "call_34feeceb0c8346298c7300ca";
  const r = replay(SYNC);
  await r.feedTo(evIdx(SYNC, (e) => e.type === "session.tool.called" && e.data?.id === READ) + 1);
  const main = r.feeds.get(MAIN);
  const child = r.feeds.get(CHILD);
  patchPart(main, CALL, { input: SYNC.events.find((e) => e.type === "session.tool.called" && e.data?.id === CALL).data.input, metadata: { sessionID: CHILD, status: "running" } });
  patchPart(child, READ, { input: SYNC.events.find((e) => e.type === "session.tool.called" && e.data?.id === READ).data.input });
  ui.store.sessions.value = [
    { id: MAIN, title: "x", directory: DIR },
    { id: CHILD, title: "agent", directory: DIR },
  ];
  putFeed(CHILD, child);
  ui.store.busyMap.value = { [CHILD]: Date.now() };
  const h = mountFeed(main);
  t$.act(() => {
    ui.store.active.value = { id: MAIN, messages: main, status: "idle" };
  });

  const card = await t$.waitFor(() => $(h.root, ".sa.is-run"));
  assert.equal($(card, ".sa-name-t").textContent, "explorer", "имя агента");
  assert.equal($(card, ".sa-task").textContent, "Список файлов в текущей папке", "задача одной строкой");
  assert.match($(card, ".sa-now").textContent, /Читает/, "строка «сейчас» — Читает <путь>");

  // готов: полный прогон, ребёнок освободился, лента с ответом
  await r.feedTo(SYNC.events.length);
  t$.act(() => {
    ui.store.busyMap.value = {};
    putFeed(CHILD, r.feeds.get(CHILD));
    ui.store.active.value = { id: MAIN, messages: r.feeds.get(MAIN), status: "idle" };
  });
  const done = await t$.waitFor(() => $(h.root, ".sa.is-ok"));
  assert.equal($(done, ".sa-head").getAttribute("aria-expanded"), "false", "завершённая свёрнута");
  assert.match(done.textContent, /2 шага/, "число шагов у готовой");
  assert.equal($(h.root, ".sa-now"), null, "строки «сейчас» нет");
  assert.equal($(h.root, ".sa-sum"), null, "один запуск — сводки нет");
});

// ---- (б) сводка хода -----------------------------------------------------------

test("FEAT-01.77 (б): два запуска одного хода — одна сводка над первой карточкой; закончили — «2 готовы»", async () => {
  ui.store.setPrefs({ execDetail: true });
  const MAIN = BG.sessionID;
  const C1 = "ses_e368062e1ffeCMv0fHa0hnaQ3c";
  const C2 = "ses_e368062daffezgIQH2FzfuWa6N";
  const feed = hist(BG);
  ui.store.sessions.value = [
    { id: MAIN, title: "x", directory: DIR },
    { id: C1, title: "a1", directory: DIR },
    { id: C2, title: "a2", directory: DIR },
  ];
  // дети заняты, лент нет — metadata.status:"running" в истории держит running
  ui.store.busyMap.value = { [C1]: Date.now(), [C2]: Date.now() };
  const h = mountFeed(feed);
  await t$.waitFor(() => $$(h.root, ".sa").length === 2);
  const sums = $$(h.root, ".sa-sum");
  assert.equal(sums.length, 1, "сводка одна на ход");
  assert.match(sums[0].textContent, /Агенты: 2 работают/);
  assert.equal(sums[0].nextElementSibling?.classList.contains("sa"), true, "сводка прямо над первой карточкой");

  t$.act(() => {
    ui.store.busyMap.value = {};
    putFeed(C1, childFeed("Папка пуста"));
    putFeed(C2, childFeed("MAJOR.MINOR.PATCH — так читается semver"));
  });
  await t$.waitFor(() => /Агенты: 2 готовы/.test($(h.root, ".sa-sum")?.textContent ?? ""));
  assert.equal($$(h.root, ".sa.is-ok").length, 2, "оба готовы");
});

// ---- (в) раскрытие готовой карточки без ленты ----------------------------------

test("FEAT-01.77 (в): раскрытие готовой карточки без ленты зовёт ensureChildFeed и показывает шаги", async () => {
  ui.store.setPrefs({ execDetail: true });
  const MAIN = SYNC.sessionID;
  const CHILD = "ses_e36eb8e5cffeiN1GF5pBbIeL7U";
  const feed = hist(SYNC);
  installFetch([
    {
      method: "GET",
      path: `/zai/api/session/${CHILD}/message`,
      reply: () => [
        {
          info: { id: "cm2", role: "assistant", sessionID: CHILD, tokens: { total: 7668 } },
          parts: [
            { id: "cg1", type: "tool", tool: "glob", callID: "cg1", state: { status: "completed", input: { pattern: "**/*" } } },
            { id: "ct1", type: "text", text: "Каталог пуст" },
          ],
        },
        { info: { id: "cm1", role: "user", sessionID: CHILD }, parts: [{ type: "text", text: "задача" }] },
      ],
    },
  ]);
  const h = mountFeed(feed);
  const card = await t$.waitFor(() => $(h.root, ".sa.is-ok"));
  assert.equal($(card, ".sa-body"), null, "пока свёрнута");
  t$.click($(card, ".sa-head"));
  await t$.waitFor(() => fetchCalls.some((c) => c.path === `/zai/api/session/${CHILD}/message`), "ensureChildFeed вызван");
  const body = await t$.waitFor(() => {
    const b = $(h.root, ".sa.is-ok .sa-body");
    return b && b.textContent.includes("Каталог пуст") ? b : null;
  }, "лента загрузилась в раскрытую карточку");
  assert.equal($(h.root, ".sa.is-ok .sa-head").getAttribute("aria-expanded"), "true");
  assert.ok($(h.root, ".sa .sa-link"), "кнопка «Открыть чат агента» есть");
});

// ---- (в2) TASK-01.79: итог завершённой карточки сразу -------------------------

test("TASK-01.79: завершённая карточка без ленты грузит ленту при появлении — в шапке «N шаг…» без раскрытия", async () => {
  ui.store.setPrefs({ execDetail: true });
  const MAIN = SYNC.sessionID;
  const CHILD = "ses_e36eb8e5cffeiN1GF5pBbIeL7U";
  installFetch([
    {
      method: "GET",
      path: `/zai/api/session/${CHILD}/message`,
      reply: () => [
        {
          info: { id: "cm2", role: "assistant", sessionID: CHILD, tokens: { total: 7668 } },
          parts: [
            { id: "cg1", type: "tool", tool: "glob", callID: "cg1", state: { status: "completed", input: { pattern: "**/*" }, metadata: { count: 214 } } },
            { id: "ct1", type: "text", text: "Каталог пуст" },
          ],
        },
        { info: { id: "cm1", role: "user", sessionID: CHILD }, parts: [{ type: "text", text: "задача" }] },
      ],
    },
  ]);
  const h = mountFeed(hist(SYNC));
  await t$.waitFor(() => fetchCalls.some((c) => c.path === `/zai/api/session/${CHILD}/message`), "лента грузится при появлении карточки, без раскрытия");
  const card = await t$.waitFor(() => {
    const c = $(h.root, ".sa");
    return c && /шаг/.test($(c, ".sa-meta")?.textContent ?? "") ? c : null;
  }, "после загрузки в шапке «N шаг…»");
  assert.equal($(card, ".sa-body"), null, "карточка не раскрыта");
  assert.match($(card, ".sa-meta").textContent, /1 шаг/);
  assert.match(card.textContent, /Список файлов/, "шаг с note виден в раскрытой карточке");
  t$.click($(card, ".sa-head"));
  assert.match($(card, ".sa-steps li small").textContent, /· 214 файлов/, "note из метаданных загруженной ленты");
});

// ---- (г) детализация выключена: ответ + прелоадер с подписью -------------------

test("FEAT-01.77 (г): детализация выключена — фоновый агент занят: виден ответ и прелоадер «Работают агенты», карточек .sa нет", async () => {
  ui.store.setPrefs({ execDetail: false });
  const CHILD = "ses_bg_child";
  const feed = [
    { info: { id: "u1", role: "user", sessionID: "ses_wiring", time: { created: T } }, parts: [{ id: "p1", type: "text", text: "Собери данные" }] },
    {
      info: { id: "a1", role: "assistant", sessionID: "ses_wiring", time: { created: T + 1000, completed: T + 4000 } },
      parts: [{ id: "s1", type: "step-start" }, agentPart("pa", { child: CHILD }), { id: "t1", type: "text", text: "Ответ готов." }],
    },
  ];
  ui.store.busyMap.value = { [CHILD]: Date.now() };
  const h = mountFeed(feed);
  await t$.waitFor(() => $(h.root, ".msg-preloader.is-agents"));
  assert.match(h.root.textContent, /Ответ готов\./, "завершённый ответ показан");
  assert.equal($$(h.root, ".sa").length, 0, "карточек агентов в компактном режиме нет");
  assert.equal($(h.root, ".pre-t b").textContent, "Работают агенты");
  assert.match($(h.root, ".pre-t span").textContent, /explorer/, "в подписи имя агента");

  // агент закончил → прелоадер погас, ответ остался
  t$.act(() => {
    ui.store.busyMap.value = {};
    putFeed(CHILD, childFeed("Собрал всё"));
  });
  await t$.waitFor(() => $(h.root, ".msg-preloader") == null);
  assert.match(h.root.textContent, /Ответ готов\./, "ответ остался на месте");
});

// ---- (д) полоса фоновых агентов в ChatView --------------------------------------

test("FEAT-01.77 (д): полоса «Фоном работает агент» — видна при свободном ходе и занятом агенте, гаснет после; при ходе основного агента её нет", async () => {
  // TASK-01.81: полоса — только при включённой детализации (кадр 5); при выключенной — индикатор (кадр 4)
  ui.store.setPrefs({ execDetail: true });
  const SID = "ses_bar";
  const CHILD = "ses_bg_bar";
  const SESSION = { id: SID, title: "Отчёт", directory: DIR };
  const feed = [
    { info: { id: "u1", role: "user", sessionID: SID, time: { created: T } }, parts: [{ id: "p1", type: "text", text: "Фоном проверь" }] },
    {
      info: { id: "a1", role: "assistant", sessionID: SID, time: { created: T + 1000, completed: T + 4000 } },
      parts: [{ id: "s1", type: "step-start" }, agentPart("pb", { child: CHILD }), { id: "t1", type: "text", text: "Запустил фоном." }],
    },
  ];
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => [SESSION] },
    { method: "GET", path: `/zai/api/session/${SID}/message`, reply: () => feed },
    { method: "GET", path: /\/zai\/api\/session\/[^/]+\/message$/, reply: () => [] },
  ]);
  // фоновая часть навсегда несёт metadata.status:"running" (design §1) —
  // «агент не занят» показывается только лентой ребёнка с ответом.
  putFeed(CHILD, childFeed("Сделано фоном"));
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => $$(root, ".msg").length >= 2);
  assert.equal($(root, ".bg-bar"), null, "агент не занят — полосы нет");
  // агент в работе: лента убрана, ребёнок занят
  t$.act(() => {
    ui.store.childFeeds.value = new Map();
    ui.store.busyMap.value = { [CHILD]: Date.now() };
  });
  const bar = await t$.waitFor(() => $(root, ".bg-bar"));
  assert.match($(bar, ".bt").textContent, /Фоном работает агент/);
  assert.match($(bar, ".bt").textContent, /explorer/);
  // ход основного агента идёт → полоса скрыта
  t$.act(() => {
    ui.store.active.value = { ...ui.store.active.value, status: "busy" };
  });
  await t$.waitFor(() => $(root, ".bg-bar") == null);
  t$.act(() => {
    ui.store.active.value = { ...ui.store.active.value, status: "idle" };
  });
  await t$.waitFor(() => $(root, ".bg-bar") != null);
  // агент закончил → полоса исчезла
  t$.act(() => {
    ui.store.busyMap.value = {};
    putFeed(CHILD, childFeed("Сделано фоном"));
  });
  await t$.waitFor(() => $(root, ".bg-bar") == null);
  // TASK-01.81 (кадр 4): детализация выключена, агент снова в работе → полосы нет, есть индикатор с подписью
  t$.act(() => {
    ui.store.setPrefs({ execDetail: false });
    ui.store.childFeeds.value = new Map();
    ui.store.busyMap.value = { [CHILD]: Date.now() };
  });
  const pre = await t$.waitFor(() => $(root, ".msg-preloader.is-agents"));
  assert.match(pre.textContent, /Работают агенты/);
  assert.equal($(root, ".bg-bar"), null, "полоса не дублирует индикатор");
  t$.act(() => {
    ui.store.busyMap.value = {};
  });
});

// ---- (е) Claude: zaiRun ----------------------------------------------------------

test("FEAT-01.77 (е): Claude-часть с zaiRun — карточка с шагами и строкой «сейчас», без «Открыть чат агента»; завершён — is-ok", async () => {
  ui.store.setPrefs({ execDetail: true });
  const SID = "ses_cl_wiring";
  const T0 = Date.now() - 42_000;
  const zaiPart = (zaiRun) => ({
    id: "pt",
    type: "tool",
    tool: "task",
    callID: "toolu_1",
    state: { status: "completed", input: { subagent_type: "explorer", description: "Найти файлы" }, metadata: { zaiRun } },
  });
  const running = [
    {
      info: { id: "mc1", role: "assistant", sessionID: SID, providerID: "anthropic", modelID: "claude-sonnet-4-5", time: { created: T0 } },
      parts: [
        zaiPart({
          status: "running",
          startedAt: T0,
          steps: [
            { id: "s1", kind: "tool", tool: "glob", object: "**/*", status: "done" },
            { id: "s2", kind: "tool", tool: "read", object: "server.js", status: "running" },
          ],
        }),
      ],
    },
  ];
  const CLAUDE_SESSION = { id: SID, title: "x", directory: DIR, zai: { model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } } };
  const h = mountFeed(running, { sid: SID, session: CLAUDE_SESSION });
  const card = await t$.waitFor(() => $(h.root, ".sa.is-run"));
  assert.equal($(card, ".sa-name-t").textContent, "explorer");
  assert.equal($(card, ".sa-task").textContent, "Найти файлы");
  assert.match($(card, ".sa-now").textContent, /Читает\s*server\.js/);
  t$.click($(card, ".sa-head"));
  const steps = await t$.waitFor(() => $(h.root, ".sa .sa-steps"));
  assert.match(steps.textContent, /Читает/, "шаги zaiRun в раскрытой карточке");
  assert.equal($(h.root, ".sa .sa-link"), null, "у Claude ссылки «Открыть чат агента» нет");
  t$.click($(h.root, ".sa .sa-head"), "свернуть обратно");

  const doneFeed = [
    {
      info: { id: "mc1", role: "assistant", sessionID: SID, providerID: "anthropic", modelID: "claude-sonnet-4-5", time: { created: T0, completed: T0 + 9000 } },
      parts: [
        zaiPart({
          status: "completed",
          startedAt: T0,
          endedAt: T0 + 9000,
          steps: [
            { id: "s1", kind: "tool", tool: "glob", object: "**/*", status: "done" },
            { id: "s2", kind: "tool", tool: "read", object: "server.js", status: "done" },
          ],
          output: "Нашёл 3 файла",
        }),
      ],
    },
  ];
  h.rerender({ messages: doneFeed });
  t$.act(() => {
    ui.store.active.value = { id: SID, messages: doneFeed, status: "idle" };
  });
  const done = await t$.waitFor(() => $(h.root, ".sa.is-ok"));
  assert.equal($(done, ".sa-head").getAttribute("aria-expanded"), "false", "завершённая свёрнута");
});

// ---- (ж) вложенный запуск ---------------------------------------------------------

test("FEAT-01.77 (ж): вложенный запуск — карточка с отступом сразу после родителя", async () => {
  ui.store.setPrefs({ execDetail: true });
  const CHILD = "ses_nest_child";
  const GRAND = "ses_nest_grand";
  const feed = [
    {
      info: { id: "a1", role: "assistant", sessionID: "ses_wiring", time: { created: T, completed: T + 3000 } },
      parts: [agentPart("pc", { child: CHILD, description: "Внешний" })],
    },
  ];
  const grandFeed = [
    {
      info: { id: "g1", role: "assistant", sessionID: GRAND },
      parts: [agentPart("cg", { child: GRAND, agent: "librarian", description: "Внутренний", background: false })],
    },
  ];
  putFeed(CHILD, grandFeed);
  ui.store.busyMap.value = { [CHILD]: Date.now(), [GRAND]: Date.now() };
  const h = mountFeed(feed);
  await t$.waitFor(() => $$(h.root, ".sa").length === 2);
  const cards = $$(h.root, ".sa");
  assert.equal($(cards[0], ".sa-name-t").textContent, "explorer");
  assert.equal($(cards[1], ".sa-name-t").textContent, "librarian", "вложенный после родителя");
  assert.equal(cards[0].classList.contains("is-deep"), false, "родитель без отступа");
  assert.equal(cards[1].classList.contains("is-deep"), true, "вложенный с отступом");
  assert.equal(cards[0].nextSibling, cards[1], "карточки идут подряд");
});

// ---- BUG-229: старая Claude-история (task без zaiRun) -----------------------------

test("BUG-229: Claude-история с task-частями без zaiRun — карточки «готов», полосы и прелоадера нет, занятость их не оживляет", async () => {
  const SID = "ses_cl_legacy";
  const T0 = Date.now() - 400_000;
  const legacyPart = (callID, desc, bg) => ({
    id: `pt-${callID}`,
    type: "tool",
    tool: "task",
    callID,
    messageID: "mc1",
    state: {
      status: "completed",
      input: { subagent_type: "general-purpose", description: desc, ...(bg ? { run_in_background: true } : {}) },
      time: { start: T0, end: T0 + 8000 },
      output: bg ? "Async agent launched successfully." : "Отчёт агента",
    },
  });
  const legacyFeed = [
    { info: { id: "u1", role: "user", sessionID: SID, time: { created: T0 - 1000 } }, parts: [{ id: "x1", type: "text", text: "проверь репо" }] },
    {
      info: { id: "mc1", role: "assistant", sessionID: SID, providerID: "anthropic", modelID: "claude-sonnet-4-5", time: { created: T0, completed: T0 + 12_000 } },
      parts: [legacyPart("toolu_l1", "Аудит картинок", false), legacyPart("toolu_l2", "Аудит кода", true), { id: "x2", type: "text", text: "Готово." }],
    },
  ];
  const CLAUDE_SESSION = { id: SID, title: "x", directory: DIR, zai: { model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } } };
  ui.store.setPrefs({ execDetail: true });
  const h = mountFeed(legacyFeed, { sid: SID, session: CLAUDE_SESSION });
  const cards = await t$.waitFor(() => $$(h.root, ".sa.is-ok"));
  assert.equal(cards.length, 2, "обе карточки «готов», а не «работает»");
  assert.equal($(h.root, ".bg-bar"), null, "полосы «Фоном работают…» нет");
  assert.equal($(h.root, ".msg-preloader"), null, "прелоадер не висит");
  // занятый чат (новый ход) старые завершённые сообщения в живой хвост не превращает
  t$.act(() => {
    ui.store.busyMap.value = { [SID]: Date.now() };
  });
  await t$.waitFor(() => $$(h.root, ".sa.is-run").length === 0);
  assert.equal($(h.root, ".bg-bar"), null, "полосы нет и при занятом чате");
  // детализация выключена: индикатор «Работают агенты» не появляется на старой истории
  t$.act(() => {
    ui.store.setPrefs({ execDetail: false });
    ui.store.busyMap.value = {};
  });
  await t$.waitFor(() => $(h.root, ".msg-preloader.is-agents") == null);
  assert.equal($(h.root, ".msg-preloader"), null, "вечного индикатора работы нет");
});
