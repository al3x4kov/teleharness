// FEAT-01.77: ленты дочерних сессий субагентов в сторе — событийная
// маршрутизация, загрузка лент, вычисляемые запуски открытого чата.
// Без сети: globalThis.fetch подменяется на тест (как в store-chat.test.js).
// Run: node --test tests/store-child-feeds.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as store from "../src/lib/store.js";
import { summarize } from "../src/lib/subagents.js";

const { active, busyMap, sessions, handleEvent } = store;
const MAIN = "ses_main";
const CHILD = "ses_child";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function stubFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const c = { url: String(url), path: String(url).split("?")[0], method: opts.method ?? "GET", body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(c);
    return handler(c);
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}
const ok = (body, status = 200) => ({ ok: true, status, json: async () => body, headers: { get: () => null } });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });

function reset() {
  active.value = null;
  sessions.value = [];
  busyMap.value = {};
  store.resetChildFeeds();
}

function setActive(extra = {}) {
  active.value = { id: MAIN, title: "", status: "idle", lastEventAt: Date.now(), messages: [], loading: false, loadError: false, ...extra };
}

const msgPage = (list) => ok(list); // GET /message отвечает массивом (новые раньше)

// ---- маршрутизация событий дочерних сессий ----------------------------------

test("FEAT-01.77: события дочерней сессии идут в её ленту, а не в открытый чат", () => {
  reset();
  setActive();
  // ребёнок в списке сессий — как после GET /session (session.created без
  // title список не пополняет: guard от заглушек)
  sessions.value = [{ id: CHILD, parentID: MAIN, directory: "D:\\x" }];
  handleEvent({ type: "message.part.updated", properties: { sessionID: CHILD, part: { id: "p1", messageID: "m1", type: "text", text: "шаг агента" } } });
  const feed = store.childFeedOf(CHILD);
  assert.ok(Array.isArray(feed) && feed.length === 1, "часть осела в ленте ребёнка");
  assert.equal(feed[0].parts[0].text, "шаг агента");
  assert.equal(active.value.messages.length, 0, "открытый чат не тронут");
});

test("FEAT-01.77: события чужого чата и активного чата ведут себя как раньше", () => {
  reset();
  setActive();
  // чужой (не ребёнок активного) — в ленты не попадает
  handleEvent({ type: "message.part.updated", properties: { sessionID: "ses_stranger", part: { id: "p1", messageID: "m1", type: "text", text: "чужое" } } });
  assert.equal(store.childFeedOf("ses_stranger"), null);
  // активный чат — как раньше: часть встаёт в активные сообщения
  handleEvent({ type: "message.part.updated", properties: { sessionID: MAIN, part: { id: "p2", messageID: "mm", type: "text", text: "моё" } } });
  assert.equal(active.value.messages.length, 1);
  assert.equal(active.value.messages[0].parts[0].text, "моё");
  // ребёнок БЕЗ записи в списке, но с metadata.sessionID на части агента активного чата — тоже маршрутится
  active.value = {
    ...active.value,
    messages: [
      ...active.value.messages,
      { info: { id: "a1", role: "assistant", sessionID: MAIN }, parts: [{ id: "call1", type: "tool", tool: "subagent", state: { status: "running", metadata: { sessionID: CHILD, status: "running" } } }] },
    ],
  };
  handleEvent({ type: "message.part.updated", properties: { sessionID: CHILD, part: { id: "p3", messageID: "m3", type: "text", text: "ребёнок" } } });
  assert.ok(Array.isArray(store.childFeedOf(CHILD)), "ребёнок из metadata части маршрутизируется");
  assert.equal(store.childFeedOf(CHILD)[0].parts[0].text, "ребёнок");
});

test("FEAT-01.77: message.updated ребёнка определяет сессию и по info.sessionID", () => {
  reset();
  setActive();
  sessions.value = [{ id: CHILD, parentID: MAIN, directory: "D:\\x" }];
  handleEvent({ type: "message.updated", properties: { info: { id: "mu1", role: "assistant", sessionID: CHILD } } });
  const feed = store.childFeedOf(CHILD);
  assert.ok(feed?.length === 1 && feed[0].info.id === "mu1");
  assert.equal(active.value.messages.length, 0);
});

// ---- загрузка ленты: ensureChildFeed ----------------------------------------

test("FEAT-01.77: ensureChildFeed грузит страницу, формирует сообщения и кэшируется", async () => {
  reset();
  setActive();
  sessions.value = [{ id: MAIN, directory: "D:\\x" }];
  const f = stubFetch(async (c) => {
    if (c.path.endsWith(`/session/${CHILD}/message`)) {
      // реальный контракт GET /message: новые раньше старых
      return msgPage([
        { info: { id: "m2", role: "assistant", sessionID: CHILD, tokens: { total: 7668 } }, parts: [{ type: "text", text: "ответ агента" }] },
        { info: { id: "m1", role: "user", sessionID: CHILD }, parts: [{ type: "text", text: "задача" }] },
      ]);
    }
    return ok({});
  });
  try {
    await store.ensureChildFeed(CHILD);
    const feed = store.childFeedOf(CHILD);
    assert.equal(feed.length, 2);
    assert.equal(feed[1].info.tokens?.total, 7668, "сообщения прогнаны через makeMessage");
    const loads = f.calls.filter((c) => c.path.endsWith(`/session/${CHILD}/message`)).length;
    await store.ensureChildFeed(CHILD);
    assert.equal(f.calls.filter((c) => c.path.endsWith(`/session/${CHILD}/message`)).length, loads, "повторный вызов — из кэша");
  } finally {
    f.restore();
    reset();
  }
});

test("FEAT-01.77: ошибка загрузки не ретраится автоматически и не роняет вызов", async () => {
  reset();
  setActive();
  const f = stubFetch(async (c) => (c.path.endsWith("/message") ? fail(500) : ok({})));
  try {
    await store.ensureChildFeed(CHILD);
    assert.equal(store.childFeedOf(CHILD), null);
    await store.ensureChildFeed(CHILD);
    assert.equal(f.calls.filter((c) => c.path.endsWith("/message")).length, 1, "второго запроса нет без force");
  } finally {
    f.restore();
    reset();
  }
});

test("FEAT-01.77: параллельные загрузки ограничены тремя", async () => {
  reset();
  setActive();
  let inFlight = 0;
  let maxInFlight = 0;
  const f = stubFetch(async (c) => {
    if (!c.path.endsWith("/message")) return ok({});
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick(15);
    inFlight -= 1;
    return msgPage([{ info: { id: "m", role: "assistant", sessionID: "x" }, parts: [] }]);
  });
  try {
    await Promise.all([1, 2, 3, 4, 5].map((i) => store.ensureChildFeed(`ses_par${i}`)));
    assert.ok(maxInFlight <= 3, `одновременно не больше трёх (было ${maxInFlight})`);
    for (let i = 1; i <= 5; i++) assert.ok(Array.isArray(store.childFeedOf(`ses_par${i}`)));
  } finally {
    f.restore();
    reset();
  }
});

test("FEAT-01.77: одновременные ensure одной ленты дедуплицируются", async () => {
  reset();
  setActive();
  const f = stubFetch(async (c) => {
    if (c.path.endsWith("/message")) {
      await tick(20);
      return msgPage([{ info: { id: "m", role: "assistant", sessionID: CHILD }, parts: [] }]);
    }
    return ok({});
  });
  try {
    await Promise.all([store.ensureChildFeed(CHILD), store.ensureChildFeed(CHILD), store.ensureChildFeed(CHILD)]);
    assert.equal(f.calls.filter((c) => c.path.endsWith("/message")).length, 1);
  } finally {
    f.restore();
    reset();
  }
});

test("FEAT-01.77: ленты не разрастаются — максимум 50, вытесняются старые завершённые", () => {
  reset();
  setActive();
  for (let i = 0; i < 51; i++) store.patchChildFeed(`ses_cap${i}`, () => [{ info: { id: "m", role: "assistant" }, parts: [] }]);
  store.patchChildFeed("ses_new", () => []);
  assert.ok(store.childFeeds.value.size <= 50, `размер ${store.childFeeds.value.size}`);
  assert.equal(store.childFeedOf("ses_cap0"), null, "самая старая вытеснена");
  assert.ok(Array.isArray(store.childFeedOf("ses_new")), "новая на месте");
  reset();
});

// ---- жизненный цикл: смена чата и «Стоп» ------------------------------------

test("FEAT-01.77: смена чата и закрытие сбрасывают ленты", async () => {
  reset();
  setActive();
  sessions.value = [{ id: MAIN, directory: "D:\\x" }, { id: "ses_other", directory: "D:\\y" }];
  store.patchChildFeed(CHILD, () => [{ info: { id: "m", role: "assistant" }, parts: [] }]);
  const f = stubFetch(async () => ok({ list: [], hasMore: false, nextBefore: null }));
  try {
    await store.openSession("ses_other");
    assert.equal(store.childFeedOf(CHILD), null, "ленты прежнего чата сброшены");
    store.patchChildFeed(CHILD, () => [{ info: { id: "m", role: "assistant" }, parts: [] }]);
    store.closeSession("ses_other");
    assert.equal(store.childFeedOf(CHILD), null);
    assert.equal(active.value, null);
  } finally {
    f.restore();
    reset();
  }
});

test("FEAT-01.77: «Стоп» обрывает и занятых детей, и сам чат", async () => {
  reset();
  setActive({ status: "busy" });
  sessions.value = [{ id: MAIN, directory: "D:\\x" }];
  active.value = {
    ...active.value,
    messages: [
      { info: { id: "u1", role: "user", sessionID: MAIN }, parts: [] },
      {
        info: { id: "a1", role: "assistant", sessionID: MAIN },
        parts: [{ id: "call1", type: "tool", tool: "subagent", state: { status: "running", metadata: { sessionID: CHILD, status: "running" } } }],
      },
    ],
  };
  busyMap.value = { [MAIN]: Date.now(), [CHILD]: Date.now() };
  const f = stubFetch(async (c) => (c.method === "POST" && c.path.endsWith("/abort") ? ok({}) : ok({ list: [], hasMore: false, nextBefore: null })));
  try {
    store.stop();
    await tick(30);
    const aborted = f.calls.filter((c) => c.path.endsWith("/abort")).map((c) => c.path);
    assert.ok(aborted.some((p) => p.includes(MAIN)), "родитель оборван");
    assert.ok(aborted.some((p) => p.includes(CHILD)), "занятый ребёнок оборван вместе с родителем");
  } finally {
    f.restore();
    reset();
  }
});

// ---- вычисляемые запуски открытого чата --------------------------------------

test("FEAT-01.77: chatRuns/agentsBusy реагируют на занятость и ленты детей", async () => {
  reset();
  setActive({ status: "busy" });
  sessions.value = [{ id: MAIN, directory: "D:\\x" }];
  active.value = {
    ...active.value,
    messages: [
      {
        info: { id: "a1", role: "assistant", sessionID: MAIN },
        parts: [
          {
            id: "call1",
            type: "tool",
            tool: "subagent",
            state: {
              status: "completed",
              input: { agent: "explorer", description: "Файлы", background: true },
              metadata: { sessionID: CHILD, status: "running" },
            },
          },
        ],
      },
    ],
  };
  busyMap.value = { [MAIN]: Date.now(), [CHILD]: Date.now() };
  assert.equal(store.agentsBusy.value, true, "ребёнок занят → агент в работе");
  const running = store.chatRuns.value;
  assert.equal(running.length, 1);
  assert.equal(running[0].state, "running");
  assert.equal(running[0].agent, "explorer");

  // ребёнок получил ответ и освободился → готов, с токенами и текстом
  busyMap.value = { [MAIN]: Date.now() };
  store.patchChildFeed(CHILD, () => [
    { info: { id: "m1", role: "user", sessionID: CHILD }, parts: [{ type: "text", text: "задача" }] },
    {
      info: { id: "m2", role: "assistant", sessionID: CHILD, tokens: { total: 7668 } },
      parts: [
        { id: "s1", type: "tool", tool: "glob", callID: "s1", state: { status: "completed", input: { pattern: "**/*" } } },
        { id: "t1", type: "text", text: "Каталог пуст" },
      ],
    },
  ]);
  const done = store.chatRuns.value;
  assert.equal(done[0].state, "done");
  assert.equal(store.agentsBusy.value, false);
  assert.equal(done[0].tokens, 7668, "токены — из ленты ребёнка");
  assert.equal(done[0].steps.length, 1, "шаги — инструменты ребёнка");
  assert.equal(done[0].steps[0].tool, "glob");
  assert.equal(done[0].output, "Каталог пуст");
  assert.equal(summarize(done).text, "Агенты: 1 готов");
  reset();
});

test("FEAT-01.77: childIdsOfActive — дети из metadata частей активного чата", () => {
  reset();
  setActive();
  active.value = {
    ...active.value,
    messages: [
      {
        info: { id: "a1", role: "assistant", sessionID: MAIN },
        parts: [{ id: "call1", type: "tool", tool: "subagent", state: { status: "running", metadata: { sessionID: CHILD, status: "running" } } }],
      },
    ],
  };
  assert.deepEqual(store.childIdsOfActive(), [CHILD]);
  reset();
});
