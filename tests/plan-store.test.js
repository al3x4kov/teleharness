// @suite: unit
// FEAT-20.37: стор плана хода — нормализация todos, SSE teleharness.plan через
// handleEvent (в т.ч. дочерние сессии субагентов), сброс на новом сообщении
// пользователя, loadPlan (200/403, одноразовая подгрузка, admin-фолбэк из
// загруженной истории). Без сети: globalThis.fetch подменяется на тест
// (образец tests/store-chat.test.js); EventSource не нужен — события
// кормятся напрямую в handleEvent.
// Run: node --test tests/plan-store.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as store from "../src/lib/store.js";

const { active, applyPlan, clearPlan, handleEvent, hydratePlanFromHistory, loadPlan, me, planOf, plansBySession, resetPlans, sessions } = store;
const MAIN = "ses_main";
const CHILD = "ses_child";
const PLAN_PATH = `/teleharness/api/session/${MAIN}/plan`;

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
  resetPlans();
  active.value = null;
  sessions.value = [];
  me.value = null;
}

function setActive(extra = {}) {
  active.value = { id: MAIN, title: "", status: "idle", lastEventAt: Date.now(), messages: [], loading: false, loadError: false, ...extra };
}

// ---- applyPlan / planOf / нормализация --------------------------------------

test("FEAT-20.37: applyPlan нормализует todos — не массив пуст, без content пропуск, чужой статус pending", () => {
  reset();
  applyPlan(MAIN, "мусор");
  assert.deepEqual(planOf(MAIN), [], "не массив → []");
  applyPlan(MAIN, [{ id: "1", content: "Шаг 1", status: "completed" }, { content: "Шаг 2", status: "weird" }, { nope: true }, { content: "   " }]);
  assert.deepEqual(planOf(MAIN), [
    { id: "1", content: "Шаг 1", status: "completed" },
    { content: "Шаг 2", status: "pending" },
  ]);
});

test("FEAT-20.37: пустой массив хранится как [] = «плана нет», а не стирается", () => {
  reset();
  applyPlan(MAIN, []);
  assert.deepEqual(planOf(MAIN), []);
  assert.ok(plansBySession.value.has(MAIN), "пустой план заведомо известен");
  assert.equal(planOf("ses_other"), null, "чужая сессия — данных нет");
});

// ---- SSE teleharness.plan через handleEvent -----------------------------------------

test("FEAT-20.37: teleharness.plan через handleEvent пишет план активного чата", () => {
  reset();
  setActive();
  handleEvent({ type: "teleharness.plan", properties: { sessionID: MAIN, todos: [{ id: "a", content: "Прочитать", status: "in_progress" }, { content: "Ответить" }] } });
  assert.deepEqual(planOf(MAIN), [
    { id: "a", content: "Прочитать", status: "in_progress" },
    { content: "Ответить", status: "pending" },
  ]);
});

test("FEAT-20.37: message.updated role=user сбрасывает план хода", () => {
  reset();
  setActive();
  handleEvent({ type: "teleharness.plan", properties: { sessionID: MAIN, todos: [{ content: "Старый план" }] } });
  handleEvent({ type: "message.updated", properties: { sessionID: MAIN, info: { id: "u1", role: "user", sessionID: MAIN } } });
  assert.equal(planOf(MAIN), null, "новый запрос — старого плана нет");
  // ассистентское сообщение план не снимает
  handleEvent({ type: "teleharness.plan", properties: { sessionID: MAIN, todos: [{ content: "Новый план" }] } });
  handleEvent({ type: "message.updated", properties: { sessionID: MAIN, info: { id: "a1", role: "assistant", sessionID: MAIN } } });
  assert.deepEqual(planOf(MAIN), [{ content: "Новый план", status: "pending" }]);
});

test("FEAT-20.37: teleharness.plan дочерней сессии игнорируется — план главного хода не тронут", () => {
  reset();
  setActive();
  // ребёнок в списке сессий — как в tests/store-child-feeds.test.js
  sessions.value = [{ id: CHILD, parentID: MAIN, directory: "D:\\x" }];
  applyPlan(MAIN, [{ content: "Главный", status: "pending" }]);
  handleEvent({ type: "teleharness.plan", properties: { sessionID: CHILD, todos: [{ content: "Шаг ребёнка" }] } });
  assert.equal(planOf(CHILD), null, "план ребёнка не заводится");
  assert.deepEqual(planOf(MAIN), [{ content: "Главный", status: "pending" }]);
});

// ---- loadPlan ---------------------------------------------------------------

test("FEAT-20.37: loadPlan 200 {todos} → записано; повторный вызов сеть не дёргает", async () => {
  reset();
  setActive();
  const f = stubFetch(async (c) => (c.path === PLAN_PATH ? ok({ sessionID: MAIN, todos: [{ id: "t1", content: "Собрать", status: "pending" }] }) : ok({})));
  try {
    await loadPlan(MAIN, { isAdmin: false });
    assert.deepEqual(planOf(MAIN), [{ id: "t1", content: "Собрать", status: "pending" }]);
    const loads = f.calls.filter((c) => c.path === PLAN_PATH).length;
    assert.equal(loads, 1);
    await loadPlan(MAIN, { isAdmin: false });
    assert.equal(f.calls.filter((c) => c.path === PLAN_PATH).length, 1, "повторный вызов — из признака загруженности");
  } finally {
    f.restore();
    reset();
  }
});

test("FEAT-20.37: loadPlan 403 → пустой план; у тенанта фолбэка из истории нет", async () => {
  reset();
  setActive({
    messages: [
      { info: { id: "u1", role: "user", sessionID: MAIN }, parts: [] },
      { info: { id: "a1", role: "assistant", sessionID: MAIN }, parts: [{ id: "p1", type: "tool", tool: "todowrite", state: { status: "completed", input: { todos: [{ id: "x", content: "Из истории", status: "completed" }] } } }] },
    ],
  });
  const f = stubFetch(async (c) => (c.path === PLAN_PATH ? fail(403) : ok({})));
  try {
    await loadPlan(MAIN, { isAdmin: false });
    assert.deepEqual(planOf(MAIN), [], "403 трактуется как «нет плана»");
  } finally {
    f.restore();
  }
  // admin при [] с сервера восстанавливает план из загруженной истории
  reset();
  setActive({
    messages: [
      { info: { id: "u1", role: "user", sessionID: MAIN }, parts: [] },
      { info: { id: "a1", role: "assistant", sessionID: MAIN }, parts: [{ id: "p1", type: "tool", tool: "todowrite", state: { status: "completed", input: { todos: [{ id: "x", content: "Из истории", status: "completed" }] } } }] },
    ],
  });
  const f2 = stubFetch(async (c) => (c.path === PLAN_PATH ? fail(403) : ok({})));
  try {
    await loadPlan(MAIN, { isAdmin: true });
    assert.deepEqual(planOf(MAIN), [{ id: "x", content: "Из истории", status: "completed" }], "admin-фолбэк: последняя todowrite-часть");
  } finally {
    f2.restore();
    reset();
  }
});

test("FEAT-20.37: loadPlan 200 [] у admin с todowrite ДО последнего сообщения пользователя не подменяет план", async () => {
  reset();
  setActive({
    messages: [
      { info: { id: "a0", role: "assistant", sessionID: MAIN }, parts: [{ id: "p0", type: "tool", tool: "todowrite", state: { input: { todos: [{ content: "Прошлый ход", status: "completed" }] } } }] },
      { info: { id: "u1", role: "user", sessionID: MAIN }, parts: [] },
    ],
  });
  const f = stubFetch(async (c) => (c.path === PLAN_PATH ? ok({ sessionID: MAIN, todos: [] }) : ok({})));
  try {
    await loadPlan(MAIN, { isAdmin: true });
    assert.deepEqual(planOf(MAIN), [], "todowrite до последнего role=user — не текущий план");
  } finally {
    f.restore();
    reset();
  }
});

test("FEAT-20.37: loadPlan для admin с todowrite ПОСЛЕ последнего role=user берёт последнюю часть", async () => {
  reset();
  setActive({
    messages: [
      { info: { id: "u1", role: "user", sessionID: MAIN }, parts: [] },
      { info: { id: "a1", role: "assistant", sessionID: MAIN }, parts: [
        { id: "p1", type: "tool", tool: "todowrite", state: { input: { todos: [{ content: "Первая", status: "completed" }] } } },
        { id: "p2", type: "tool", tool: "todowrite", state: { input: { todos: [{ content: "Вторая", status: "in_progress" }, { content: "Третья", status: "pending" }] } } },
      ] },
    ],
  });
  const f = stubFetch(async (c) => (c.path === PLAN_PATH ? ok({ sessionID: MAIN, todos: [] }) : ok({})));
  try {
    await loadPlan(MAIN, { isAdmin: true });
    assert.deepEqual(planOf(MAIN), [
      { content: "Вторая", status: "in_progress" },
      { content: "Третья", status: "pending" },
    ], "последняя todowrite после последнего сообщения пользователя");
  } finally {
    f.restore();
    reset();
  }
});

test("FEAT-20.37: живой teleharness.plan в полёте loadPlan не затирается устаревшим ответом /plan", async () => {
  reset();
  setActive();
  let release;
  const gate = new Promise((r) => (release = r));
  const f = stubFetch(async (c) => {
    if (c.path === PLAN_PATH) {
      await gate;
      return ok({ sessionID: MAIN, todos: [] });
    }
    return ok({});
  });
  try {
    const p = loadPlan(MAIN, { isAdmin: false });
    handleEvent({ type: "teleharness.plan", properties: { sessionID: MAIN, todos: [{ id: "live", content: "Живой этап", status: "in_progress" }] } });
    release();
    await p;
    assert.deepEqual(planOf(MAIN), [{ id: "live", content: "Живой этап", status: "in_progress" }], "устаревший [] не затёр живой план");
  } finally {
    f.restore();
    reset();
  }
});

test("FEAT-20.37: сброс нового хода (clearPlan) в полёте loadPlan не даёт старому /plan воскреснуть", async () => {
  reset();
  setActive();
  let release;
  const gate = new Promise((r) => (release = r));
  const f = stubFetch(async (c) => {
    if (c.path === PLAN_PATH) {
      await gate;
      return ok({ sessionID: MAIN, todos: [{ id: "old", content: "Старый этап", status: "completed" }] });
    }
    return ok({});
  });
  try {
    const p = loadPlan(MAIN, { isAdmin: false });
    clearPlan(MAIN);
    release();
    await p;
    assert.equal(planOf(MAIN), null, "устаревший ответ /plan после сброса хода отброшен");
  } finally {
    f.restore();
    reset();
  }
});

test("FEAT-20.37: hydratePlanFromHistory восстанавливает план после F5, когда история доехала позже /plan", async () => {
  reset();
  setActive({ messages: [] });
  const f = stubFetch(async (c) => (c.path === PLAN_PATH ? ok({ sessionID: MAIN, todos: [] }) : ok({})));
  try {
    await loadPlan(MAIN);
    assert.deepEqual(planOf(MAIN), []);
    setActive({
      messages: [
        { info: { id: "u1", role: "user", sessionID: MAIN }, parts: [] },
        { info: { id: "a1", role: "assistant", sessionID: MAIN }, parts: [{ id: "p1", type: "tool", tool: "todowrite", state: { input: { todos: [{ id: "h1", content: "Из истории F5", status: "completed" }] } } }] },
      ],
    });
    hydratePlanFromHistory(MAIN);
    assert.deepEqual(planOf(MAIN), [{ id: "h1", content: "Из истории F5", status: "completed" }]);
    // После сброса хода hydratePlanFromHistory не воскрешает старую историю
    clearPlan(MAIN);
    hydratePlanFromHistory(MAIN);
    assert.equal(planOf(MAIN), null, "после clearPlan фолбэк из истории не срабатывает");
  } finally {
    f.restore();
    reset();
  }
});

test("FEAT-20.37: повторный message.updated того же user-сообщения (BUG-016 / summary) план не стирает", () => {
  reset();
  setActive();
  handleEvent({ type: "message.updated", properties: { sessionID: MAIN, info: { id: "u1", role: "user", sessionID: MAIN } } });
  handleEvent({ type: "teleharness.plan", properties: { sessionID: MAIN, todos: [{ id: "1", content: "Актуальный шаг", status: "in_progress" }] } });
  // Повтор того же id (mid-turn summary или BUG-016 после хода)
  handleEvent({ type: "message.updated", properties: { sessionID: MAIN, info: { id: "u1", role: "user", sessionID: MAIN, summary: { title: "x" } } } });
  assert.deepEqual(planOf(MAIN), [{ id: "1", content: "Актуальный шаг", status: "in_progress" }], "повтор того же user-id не стирает план");
  // Новый user-id — план сброшен
  handleEvent({ type: "message.updated", properties: { sessionID: MAIN, info: { id: "u2", role: "user", sessionID: MAIN } } });
  assert.equal(planOf(MAIN), null, "новый запрос с новым id сбрасывает план");
});

test("FEAT-20.37: после F5 повторный message.updated для user-id из истории план не стирает; session.deleted чистит план", () => {
  reset();
  setActive({ messages: [{ info: { id: "u_hist", role: "user", sessionID: MAIN }, parts: [] }] });
  applyPlan(MAIN, [{ id: "1", content: "План после F5", status: "completed" }]);
  handleEvent({ type: "message.updated", properties: { sessionID: MAIN, info: { id: "u_hist", role: "user", sessionID: MAIN } } });
  assert.deepEqual(planOf(MAIN), [{ id: "1", content: "План после F5", status: "completed" }], "уже загруженный в историю user-id не сбрасывает план");
  handleEvent({ type: "session.deleted", properties: { sessionID: MAIN } });
  assert.equal(planOf(MAIN), null, "удаление сессии очищает план");
});
