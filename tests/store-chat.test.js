// Г4a (2026-11-02): client chat logic & state — race, turn errors, SSE
// self-healing, failed/queued bubbles, dialogs, liveness, back navigation.
// No network: globalThis.fetch is stubbed per test; EventSource is faked.
// Run: node --test tests/store-chat.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as store from "../src/lib/store.js";
import { epochOfEventId, openEvents } from "../src/lib/api.js";
import {
  actionOf,
  collectAnswers,
  describeTurnError,
  livenessLine,
  resendParts,
  turnErrorFromMessages,
} from "../src/lib/turn.js";
import { chatBackTarget } from "../src/lib/router.js";
import { makeMessage } from "../src/lib/normalize.js";

const { active, busyMap, dialogs, handleEvent, notice, pendingMap, sessions, setNotice, stalled } = store;
const SES = "ses_g4a";
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
const ok = (body, status = 200, headers = {}) => ({ ok: true, status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });

function reset() {
  active.value = null;
  sessions.value = [];
  dialogs.value = [];
  busyMap.value = {};
  pendingMap.value = {};
  setNotice(null);
}

function setActive(extra = {}) {
  active.value = { id: SES, title: "", status: "idle", lastEventAt: Date.now(), messages: [], loading: false, loadError: false, ...extra };
}

// ---- BUG-01.35: openSession race -------------------------------------------

test("BUG-01.35: a late status answer for chat A never overwrites chat B", async () => {
  reset();
  let releaseA;
  const gateA = new Promise((r) => (releaseA = r));
  let statusCalls = 0;
  const f = stubFetch(async (c) => {
    if (c.path.endsWith("/status")) {
      statusCalls += 1;
      if (statusCalls === 1) await gateA; // A's status is slow (8 s fan-out)
      return ok({ ses_A: { type: "busy" } });
    }
    return ok([]);
  });
  try {
    const pA = store.openSession("ses_A");
    store.closeSession(); // «Назад»
    await store.openSession("ses_B");
    assert.equal(active.value.id, "ses_B");
    releaseA();
    await pA;
    assert.equal(active.value.id, "ses_B", "A's late answer must be ignored");
    assert.equal(active.value.status, "idle");
  } finally {
    f.restore();
    reset();
  }
});

test("BUG-01.35: send refuses a target that is not the active chat; the chat is active while history loads", async () => {
  reset();
  const f = stubFetch(async (c) => {
    if (c.path.endsWith("/message")) {
      await tick(30);
      return ok([]);
    }
    return ok({});
  });
  try {
    const p = store.openSession("ses_B");
    assert.equal(active.value.id, "ses_B", "active flips immediately (loading)");
    assert.equal(active.value.loading, true);
    const refused = await store.send({ text: "в чужой чат?", sessionId: "ses_A" });
    assert.equal(refused, false);
    assert.ok(!f.calls.some((c) => c.path.endsWith("/prompt")), "nothing is posted to another chat");
    assert.match(String(notice.value), /не отправлено/i);
    const sent = await store.send({ text: "во время загрузки", sessionId: "ses_B" });
    assert.equal(sent, true);
    await p;
    assert.ok(
      active.value.messages.some((m) => m.parts.some((x) => x.text === "во время загрузки")),
      "a message typed while history loads survives the history refresh",
    );
  } finally {
    f.restore();
    reset();
  }
});

// ---- BUG-07.14: turn errors ------------------------------------------------

test("BUG-07.14: session.error with sessionID ends the turn WITH a visible error", () => {
  reset();
  setActive({ status: "busy" });
  handleEvent({
    type: "session.error",
    properties: { sessionID: SES, error: { name: "APIError", data: { message: "429 Too Many Requests: usage limit exceeded" } } },
  });
  assert.equal(active.value.status, "idle");
  assert.equal(active.value.turnError.kind, "limit");
  assert.match(active.value.turnError.title, /лимит z\.ai/i);
  assert.ok(active.value.turnError.actions.includes("settings"));
  reset();
});

test("BUG-07.14: session.error WITHOUT sessionID only notifies — the open chat keeps running", () => {
  reset();
  setActive({
    status: "busy",
    messages: [makeMessage({ id: "tmp-1", role: "user", delivery: "delivered" }, [{ type: "text", text: "x" }])],
  });
  handleEvent({ type: "session.error", properties: { error: { name: "UnknownError", data: { message: "boom" } } } });
  assert.equal(active.value.status, "busy", "global error must not finalize the open chat");
  assert.equal(active.value.messages.length, 1, "tmp bubbles stay");
  assert.ok(notice.value, "a notice explains the global error");
  reset();
});

test("BUG-07.14: aborted turn is not an error; assistant info.error shows; Claude auth text is detected from history", () => {
  assert.equal(describeTurnError({ name: "MessageAbortedError" }), null);
  const auth = describeTurnError("Invalid API key · Please run /login", { engine: "claude" });
  assert.equal(auth.kind, "auth");
  assert.match(auth.title, /Claude/);
  reset();
  setActive({ status: "busy" });
  handleEvent({
    type: "message.updated",
    properties: { sessionID: SES, info: { id: "msg_a", role: "assistant", error: { name: "ProviderAuthError", data: { message: "bad key" } } } },
  });
  assert.equal(active.value.turnError.kind, "auth");
  const hist = [
    makeMessage({ id: "u", role: "user" }, [{ type: "text", text: "hi" }]),
    makeMessage({ id: "a", role: "assistant" }, [{ type: "text", text: "Claude AI usage limit reached|1730000000" }]),
  ];
  assert.equal(turnErrorFromMessages(hist, { engine: "claude" }).kind, "limit");
  assert.equal(turnErrorFromMessages(hist, { engine: "opencode" }), null, "opencode text is never sniffed");
  store.dismissTurnError(SES);
  assert.equal(active.value.turnError, null);
  reset();
});

test("BUG-07.14: a new send clears the error banner", async () => {
  reset();
  const f = stubFetch(() => ok({}, 204));
  try {
    setActive({ turnError: { kind: "provider", title: "x", text: "y", actions: ["retry"] } });
    await store.send({ text: "ещё раз", sessionId: SES });
    assert.equal(active.value.turnError, null);
  } finally {
    f.restore();
    reset();
  }
});

// ---- BUG-07.11: SSE self-healing, epoch, busy→idle ---------------------------

function fakeES() {
  const made = [];
  const factory = (url) => {
    const es = { url, readyState: 0, closed: false, close() { this.closed = true; this.readyState = 2; } };
    made.push(es);
    return es;
  };
  return { made, factory };
}

test("BUG-07.11: a CLOSED EventSource (502/401) is recreated with backoff and resyncs after reopen", async () => {
  const { made, factory } = fakeES();
  const statuses = [];
  const resyncs = [];
  const events = [];
  const h = openEvents({
    factory,
    minDelayMs: 5,
    maxDelayMs: 20,
    onStatus: (s) => statuses.push(s),
    onResync: (why) => resyncs.push(why),
    onEvent: (e) => events.push(e),
  });
  try {
    assert.equal(made.length, 1);
    made[0].onopen();
    assert.deepEqual(resyncs, [], "the first open is not a reconnect");
    made[0].readyState = 2; // edge answered 502
    made[0].onerror();
    assert.ok(made[0].closed);
    assert.equal(statuses.at(-1), "closed");
    await tick(15);
    assert.equal(made.length, 2, "a new EventSource is created after the backoff");
    made[1].readyState = 2;
    made[1].onerror(); // still down: backoff doubles
    await tick(30);
    assert.equal(made.length, 3);
    made[2].onopen();
    assert.deepEqual(resyncs, ["reconnect"], "reopen after an error triggers resync");
    made[2].onmessage({ data: JSON.stringify({ type: "zai.resync", properties: {} }), lastEventId: "" });
    assert.deepEqual(resyncs, ["reconnect", "server"]);
    made[2].onmessage({ data: "not json" });
    made[2].onmessage({ data: JSON.stringify({ type: "session.idle", properties: { sessionID: "s" } }), lastEventId: "k3x.7" });
    assert.equal(events.length, 1);
    // a transient error (browser auto-reconnects) does not recreate the stream
    made[2].readyState = 0;
    made[2].onerror();
    await tick(30);
    assert.equal(made.length, 3);
    assert.equal(statuses.at(-1), "error");
  } finally {
    h.close();
  }
});

test("BUG-07.11: epoch is read from `<epoch>.<seq>` ids and tolerated when absent", () => {
  assert.equal(epochOfEventId("mhz3k1.42"), "mhz3k1");
  assert.equal(epochOfEventId("42"), null, "legacy numeric id → no epoch");
  assert.equal(epochOfEventId(""), null);
  assert.equal(epochOfEventId(undefined), null);
});

test("BUG-07.11: an epoch change (SSE id or x-zai-epoch header) triggers a resync", async () => {
  reset();
  const f = stubFetch((c) => (c.path.endsWith("/status") ? ok({}, 200, { "x-zai-epoch": "ep2" }) : ok([])));
  try {
    store.noteEpoch("ep1", "sse");
    store.noteEpoch("ep1", "sse");
    await tick();
    assert.equal(f.calls.filter((c) => c.path.endsWith("/session")).length, 0, "same epoch → nothing");
    store.noteEpoch("ep2", "sse");
    await tick(20);
    assert.ok(f.calls.some((c) => c.path.endsWith("/session")), "epoch change → resync refetches sessions");
  } finally {
    f.restore();
    reset();
  }
});

test("BUG-07.11: pollBusy finalizes a chat the server says is idle (missed session.idle), with a grace for fresh sends", async () => {
  reset();
  const f = stubFetch((c) => (c.path.endsWith("/status") ? ok({}) : ok([])));
  try {
    setActive({ status: "busy", lastEventAt: Date.now() - 2000 });
    await store.pollBusy();
    assert.equal(active.value.status, "busy", "inside the grace window a just-sent prompt stays busy");
    setActive({ status: "busy", lastEventAt: Date.now() - 60_000 });
    await store.pollBusy();
    assert.equal(active.value.status, "idle", "server idle + silence → idle");
    assert.equal(stalled.value, false, "no false stall banner");
  } finally {
    f.restore();
    reset();
  }
});

test("BUG-228: a stale cached /status right after session.idle does not flip the chat back to busy", async () => {
  reset();
  // сервер кэширует /status на 3 с: ответ сразу после конца хода ещё говорит «занят»
  const f = stubFetch((c) => (c.path.endsWith("/status") ? ok({ [SES]: { type: "busy", since: Date.now() - 5000 } }) : ok([])));
  try {
    setActive({ status: "busy" });
    // отметки занятости в busyMap нет: её стёр такой же устаревший опрос в начале хода
    handleEvent({ type: "session.idle", properties: { sessionID: SES } });
    assert.equal(active.value.status, "idle");
    await store.pollBusy();
    assert.equal(active.value.status, "idle", "устаревший ответ не возвращает «занят»");
    assert.equal(busyMap.value[SES], undefined, "и не возвращает отметку занятости в список");
    // окно прошло: тот же ответ — уже правда (ход начат с другого устройства)
    store.idleSeenAt.set(SES, Date.now() - 60_000);
    await store.pollBusy();
    assert.equal(active.value.status, "busy", "после окна серверная правда снова применяется");
    assert.ok(busyMap.value[SES]);
  } finally {
    f.restore();
    store.idleSeenAt.clear();
    reset();
  }
});

test("BUG-07.11: offline face appears only after the grace, and «Связь восстановлена» follows", async () => {
  const { connection, onStreamStatus } = store;
  const f = stubFetch(() => ok({ user: { id: 1 } }));
  try {
    onStreamStatus("error");
    assert.equal(connection.value.state, "online", "a blip is not offline");
    onStreamStatus("open");
    await tick(3100);
    assert.equal(connection.value.state, "online");
    onStreamStatus("error");
    await tick(3100);
    assert.equal(connection.value.state, "offline");
    onStreamStatus("open");
    assert.equal(connection.value.state, "online");
    assert.ok(connection.value.restoredAt, "restored flash is armed");
  } finally {
    f.restore();
  }
});

// ---- BUG-01.36: failed bubbles ---------------------------------------------

test("BUG-01.36: a real message never merges into a failed bubble; failed bubbles survive idle and refresh", async () => {
  reset();
  const failed = makeMessage({ id: "tmp-f", role: "user", failed: true, delivery: "failed" }, [{ type: "text", text: "M1" }]);
  const live = makeMessage({ id: "tmp-2", role: "user", delivery: "delivered" }, [{ type: "text", text: "M2" }]);
  setActive({ status: "busy", messages: [failed, live] });
  handleEvent({ type: "message.updated", properties: { sessionID: SES, info: { id: "msg_u2", role: "user" } } });
  const ids = active.value.messages.map((m) => m.info.id);
  assert.deepEqual(ids, ["tmp-f", "msg_u2"], "U2 replaced M2's bubble, not the failed M1");
  assert.equal(active.value.messages[1].parts[0].text, "M2");
  assert.ok(!active.value.messages[1].info.failed);

  const f = stubFetch(() => ok([{ info: { id: "msg_u2", role: "user" }, parts: [{ type: "text", text: "M2" }] }]));
  try {
    handleEvent({ type: "session.idle", properties: { sessionID: SES } });
    assert.ok(active.value.messages.some((m) => m.info.id === "tmp-f"), "idle keeps the failed bubble");
    await store.resync();
    assert.deepEqual(
      active.value.messages.map((m) => m.info.id),
      ["msg_u2", "tmp-f"],
      "history refresh keeps the failed bubble at the tail",
    );
  } finally {
    f.restore();
    reset();
  }
});

test("BUG-01.36: «Отправить снова» sends clean text without the vault snapshot, with files; empty → notice", async () => {
  const snap = "[obsidian-cache] Активный кэш.\n\nПравила кэша: _index.md.\n\n---\n\nСделай отчёт";
  const msg = makeMessage({ id: "u1", role: "user" }, [
    { type: "text", text: snap },
    { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAA" },
  ]);
  assert.deepEqual(resendParts(msg), [
    { type: "text", text: "Сделай отчёт" },
    { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAA" },
  ]);
  reset();
  const f = stubFetch(() => ok({}, 204));
  try {
    setActive({ messages: [makeMessage({ id: "u2", role: "user" }, [{ type: "file", mime: "image/png", filename: "b.png", url: "data:x" }])] });
    assert.equal(await store.resendLast(SES), true, "an image-only message is resent, not silently skipped");
    const post = f.calls.find((c) => c.path.endsWith("/prompt"));
    assert.deepEqual(post.body.parts, [{ type: "file", mime: "image/png", filename: "b.png", url: "data:x" }]);
    setActive({ messages: [makeMessage({ id: "u3", role: "user" }, [{ type: "text", text: "   " }])] });
    assert.equal(await store.resendLast(SES), false);
    assert.match(String(notice.value), /Нечего отправить/);
  } finally {
    f.restore();
    reset();
  }
});

test("R-12: a failed send marks only its own bubble and adds no global notice on network loss", async () => {
  reset();
  const f = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    setActive();
    await store.send({ text: "a", sessionId: SES });
    const m = active.value.messages[0];
    assert.equal(m.info.failed, true);
    assert.equal(m.info.failReason, "network");
    assert.equal(notice.value, null);
    assert.equal(active.value.status, "idle");
  } finally {
    f.restore();
    reset();
  }
});

// ---- BUG-01.37 (store part): prompted, fresh chat, stopping ------------------

test("CC-23: `prompted` is set only after the server accepted the first prompt", async () => {
  reset();
  let online = false;
  const f = stubFetch(() => {
    if (!online) throw new TypeError("fetch failed");
    return ok({}, 204);
  });
  try {
    sessions.value = [{ id: SES, directory: "C:\\H", zai: { model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }, agent: "build", prompted: false } }];
    setActive();
    await store.send({ text: "первое", sessionId: SES });
    assert.equal(sessions.value[0].zai.prompted, false, "a failed first message must not lock the engine");
    online = true;
    await store.send({ text: "первое", sessionId: SES });
    assert.equal(sessions.value[0].zai.prompted, true);
  } finally {
    f.restore();
    reset();
  }
});

test("CC-25: a fresh chat left while its history still loads is deleted", async () => {
  reset();
  const f = stubFetch(async (c) => {
    if (c.method === "POST" && c.path.endsWith("/session")) return ok({ id: "ses_fresh", directory: "C:\\H" });
    if (c.path.endsWith("/message")) {
      await tick(20);
      return ok([]);
    }
    return ok({});
  });
  try {
    const p = store.createAndOpen({ directory: "C:\\H" });
    await tick(2);
    store.closeSession(); // left during loading
    await p;
    await tick(30);
    assert.ok(f.calls.some((c) => c.method === "DELETE" && c.url.includes("ses_fresh")));
  } finally {
    f.restore();
    reset();
  }
});

test("CC-07: a failed abort rolls «stopping» back and explains it", async () => {
  reset();
  const f = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    setActive({ status: "busy" });
    store.stop();
    assert.equal(active.value.status, "stopping");
    await tick(10);
    assert.equal(active.value.status, "busy", "never parked in stopping");
    assert.match(String(notice.value), /остановить/);
  } finally {
    f.restore();
    reset();
  }
});

// ---- FEAT-01.29: queue marks -----------------------------------------------

test("FEAT-01.29: a follow-up sent during a turn is queued → delivered → accepted", async () => {
  reset();
  let release;
  const gate = new Promise((r) => (release = r));
  const f = stubFetch(async () => {
    await gate;
    return ok({}, 204);
  });
  try {
    setActive({ status: "busy" });
    const p = store.send({ text: "досылка", sessionId: SES });
    let m = active.value.messages.at(-1);
    assert.equal(m.info.queued, true);
    assert.equal(m.info.delivery, "sending");
    release();
    await p;
    m = active.value.messages.at(-1);
    assert.equal(m.info.delivery, "delivered");
    handleEvent({ type: "message.updated", properties: { sessionID: SES, info: { id: "msg_q", role: "user" } } });
    handleEvent({ type: "message.updated", properties: { sessionID: SES, info: { id: "msg_r", role: "assistant", parentID: "msg_q" } } });
    m = active.value.messages.find((x) => x.info.id === "msg_q");
    assert.equal(m.info.delivery, "accepted");
    assert.equal(m.info.queued, false, "the «В очереди» mark goes once the turn on it started");
  } finally {
    f.restore();
    reset();
  }
});

test("CC-21: an answered turn clears the «ход завис» pending banner at once", () => {
  reset();
  setActive({ status: "busy" });
  pendingMap.value = { [SES]: { at: 1, replays: 1, max: 2 } };
  handleEvent({ type: "message.updated", properties: { sessionID: SES, info: { id: "a1", role: "assistant", time: { created: 1, completed: 2 } } } });
  assert.equal(pendingMap.value[SES], undefined);
  reset();
});

// ---- BUG-07.13: dialogs ----------------------------------------------------

test("BUG-07.13: multi-question replies carry one answer array per question", async () => {
  reset();
  assert.deepEqual(collectAnswers([{}, { multiple: true }], [["A"], ["x", "y"]], ["", "свой"]), [["A"], ["x", "y", "свой"]]);
  assert.equal(collectAnswers([{}, {}], [["A"], []], ["", ""]), null, "unanswered question → no payload");
  const f = stubFetch(() => ok(true));
  try {
    const d = { kind: "question", id: "que_m", sessionID: SES, questions: [{}, {}] };
    dialogs.value = [d];
    await store.replyDialog(d, [["A"], ["B", "C"]]);
    assert.deepEqual(f.calls[0].body, { answers: [["A"], ["B", "C"]] });
  } finally {
    f.restore();
    reset();
  }
});

test("BUG-07.13: every network failure re-arms with a new attempt; timeout + 404 on retry = success", async () => {
  reset();
  let f = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const d = { kind: "permission", id: "per_1", sessionID: SES };
    dialogs.value = [d];
    await store.replyDialog(d, "once");
    assert.equal(dialogs.value[0].attempt, 1);
    await store.replyDialog(dialogs.value[0], "once");
    assert.equal(dialogs.value[0].attempt, 2, "the second failure bumps the attempt (card re-arms)");
  } finally {
    f.restore();
    reset();
  }
  let n = 0;
  f = stubFetch(() => {
    n += 1;
    if (n === 1) {
      const e = new Error("timeout");
      e.name = "TimeoutError";
      throw e;
    }
    return fail(404);
  });
  try {
    const d = { kind: "permission", id: "per_2", sessionID: SES };
    dialogs.value = [d];
    await store.replyDialog(d, "once");
    assert.equal(dialogs.value.length, 0);
    assert.equal(notice.value, null, "no false «не актуален»");
  } finally {
    f.restore();
    reset();
  }
});

test("BUG-07.13: 5xx re-arms; an answered dialog is not resurrected by a lagging seed", async () => {
  reset();
  let f = stubFetch(() => fail(502));
  try {
    const d = { kind: "permission", id: "per_5", sessionID: SES };
    dialogs.value = [d];
    await store.replyDialog(d, "once");
    assert.equal(dialogs.value[0].error, true);
  } finally {
    f.restore();
    reset();
  }
  f = stubFetch((c) => (c.path.endsWith("/dialogs") ? ok([{ kind: "permission", id: "per_ok", sessionID: SES }]) : ok(true)));
  try {
    const d = { kind: "permission", id: "per_ok", sessionID: SES };
    dialogs.value = [d];
    await store.replyDialog(d, "once");
    await store.seedDialogs();
    assert.equal(dialogs.value.length, 0, "the just-answered dialog stays gone");
  } finally {
    f.restore();
    reset();
  }
});

// ---- BUG-13.3 / BUG-07.8 UI: liveness ----------------------------------------

test("BUG-13.3: keepalive does not reset the stall clock; tool parts set the last action", () => {
  reset();
  const old = Date.now() - 300_000;
  setActive({ status: "busy", lastEventAt: old });
  handleEvent({ type: "zai.keepalive", properties: { sessionID: SES, lastAction: "Bash", lastOutputAt: old } });
  assert.equal(active.value.lastEventAt, old, "keepalive is not output");
  assert.equal(stalled.value, true);
  assert.equal(active.value.lastAction.label, "команда");
  handleEvent({ type: "message.part.updated", properties: { sessionID: SES, part: { id: "p1", messageID: "m1", type: "tool", tool: "read" } } });
  assert.equal(active.value.lastAction.label, "чтение файла");
  assert.equal(stalled.value, false);
  reset();
});

test("BUG-13.3: liveness line and labels", () => {
  const now = 1_000_000;
  assert.equal(
    livenessLine({ since: now - 185_000, lastAction: { label: "команда" }, lastActivityAt: now - 12_000 }, now),
    "Работает 3м 05с · последнее действие: команда · 12с назад",
  );
  assert.equal(livenessLine({}, now), "Работает");
  assert.equal(actionOf({ type: "tool", tool: "mcp_playwright_browser_click" }), "инструмент mcp_playwright_browser_click");
  assert.equal(actionOf({ type: "step-start" }), null);
});

test("BUG-07.8: zai.turn.incomplete and an interrupted Claude turn offer «Продолжить»", () => {
  reset();
  setActive();
  handleEvent({ type: "zai.turn.incomplete", properties: { sessionID: SES, reason: "open-todos", todosOpen: 2, todosTotal: 5 } });
  assert.deepEqual(active.value.incomplete, { reason: "open-todos", todosOpen: 2, todosTotal: 5 });
  setActive();
  handleEvent({ type: "message.updated", properties: { sessionID: SES, info: { id: "a", role: "assistant", zai: { interrupted: "idle" } } } });
  assert.equal(active.value.incomplete.reason, "idle");
  setActive();
  // BUG-182: the claude CLI died on its own → the same «не закончил / Продолжить»
  handleEvent({ type: "message.updated", properties: { sessionID: SES, info: { id: "a", role: "assistant", zai: { interrupted: "crash" } } } });
  assert.equal(active.value.incomplete.reason, "crash");
  setActive();
  handleEvent({ type: "message.updated", properties: { sessionID: SES, info: { id: "a", role: "assistant", zai: { interrupted: "user" } } } });
  assert.equal(active.value.incomplete ?? null, null, "a user «Стоп» is not «не закончил»");
  reset();
});

// ---- R-23: back navigation ---------------------------------------------------

test("R-23: «Назад» from a chat returns to its source / its project", () => {
  const proj = { view: "project", path: "/project/D%3A%5CP", params: { id: "D:\\P" } };
  assert.equal(chatBackTarget({ from: proj }), "/project/D%3A%5CP");
  assert.equal(chatBackTarget({ from: { view: "home", path: "/" }, directory: "D:\\P", projects: ["D:\\P"] }), "/");
  assert.equal(chatBackTarget({ from: null, directory: "d:\\p", projects: ["D:\\P"] }), "/project/d%3A%5Cp", "deep link → the chat's project");
  assert.equal(chatBackTarget({ from: { view: "settings", path: "/settings" }, directory: "C:\\Users\\USER", projects: [] }), "/");
});

// ---- TASK-01.42: active chat id is a signal ----------------------------------

test("TASK-01.42: activeSessionDir reads the activeId signal (no globalThis stamp)", () => {
  reset();
  sessions.value = [{ id: SES, directory: "D:\\Proj" }];
  store.setActiveId(SES);
  assert.equal(store.activeSessionDir(), "D:\\Proj");
  assert.equal(globalThis.__zaiActiveId, undefined);
  store.setActiveId(null);
  assert.equal(store.activeSessionDir(), null);
  reset();
});

// ---- BUG-093: «Новый чат» из меню внутри чата ---------------------------------
// Drawer → «Новый чат» while chat A is open: createAndOpen() makes B active
// BEFORE ChatView(A) unmounts. A's cleanup must close A only — not the fresh
// B (closing B deleted the brand-new chat and left «Без названия» + skeleton).

test("BUG-093: leaving chat A after «Новый чат» from the menu keeps the new chat B", async () => {
  reset();
  const f = stubFetch(async (c) => {
    if (c.method === "POST" && c.path.endsWith("/session")) return ok({ id: "ses_new093", title: "", directory: "C:\H" });
    if (c.path.endsWith("/status")) return ok({});
    if (c.method === "DELETE") return ok(true);
    return ok([]);
  });
  try {
    sessions.value = [{ id: "ses_old093", title: "Старый", directory: "C:\H" }];
    await store.openSession("ses_old093");
    await store.createAndOpen();
    store.closeSession("ses_old093"); // ChatView(A) cleanup runs after navigate
    await tick(20);
    assert.equal(active.value?.id, "ses_new093", "the new chat stays open");
    assert.ok(!f.calls.some((c) => c.method === "DELETE" && c.url.includes("ses_new093")), "the new chat is NOT deleted");
    assert.ok(sessions.value.some((s) => s.id === "ses_new093"), "and stays in the list");
  } finally {
    f.restore();
    reset();
  }
});

test("BUG-093: an untouched fresh chat A is still deleted when «Новый чат» replaces it", async () => {
  reset();
  let n = 0;
  const f = stubFetch(async (c) => {
    if (c.method === "POST" && c.path.endsWith("/session")) return ok({ id: n++ === 0 ? "ses_a093" : "ses_b093", title: "", directory: "C:\H" });
    if (c.path.endsWith("/status")) return ok({});
    if (c.method === "DELETE") return ok(true);
    return ok([]);
  });
  try {
    await store.createAndOpen();
    await store.createAndOpen();
    store.closeSession("ses_a093");
    await tick(20);
    assert.equal(active.value?.id, "ses_b093");
    assert.ok(f.calls.some((c) => c.method === "DELETE" && c.url.includes("ses_a093")), "empty A is cleaned up (BUG-009)");
    assert.ok(!f.calls.some((c) => c.method === "DELETE" && c.url.includes("ses_b093")), "B survives");
  } finally {
    f.restore();
    reset();
  }
});

// FEAT-01.69 П31.Н2 (стенд 1.14.0): открытый чат удалили на другом устройстве → событие
// session.deleted. Было: active=null → вечный скелет загрузки. Стало: плашка «уже удалён»,
// переход на главную без записи назад, закрепление снято. Своё удаление (строку уже убрали
// из списка до события) плашку не показывает.
// node: минимальный location (hash + replace), как в браузере
globalThis.location ??= { hash: "", replace(h) { this.hash = String(h).slice(String(h).indexOf("#")); } };

test("П31.Н2: session.deleted открытого чата — плашка «уже удалён», главная, закрепление снято", async () => {
  reset();
  const { navigate } = await import("../src/lib/router.js");
  store.setNavigate(navigate); // как AppShell
  location.hash = `#/chat/${SES}`;
  sessions.value = [{ id: SES, title: "Ремонт спойлера", time: { updated: 1 } }];
  store.pins.value = [SES];
  setActive();
  handleEvent({ type: "session.deleted", properties: { info: { id: SES } } });
  assert.equal(sessions.value.some((s) => s.id === SES), false);
  assert.match(String(notice.value?.text ?? notice.value), /Ремонт спойлера.*уже удалён/);
  assert.equal(store.pins.value.includes(SES), false);
  assert.equal(location.hash.includes(SES), false, location.hash);
  // своё удаление: строки в списке уже нет → без плашки
  reset();
  location.hash = `#/chat/${SES}`;
  setActive();
  handleEvent({ type: "session.deleted", properties: { info: { id: SES } } });
  assert.equal(notice.value == null || notice.value === "" || notice.value?.text == null, true);
  assert.equal(active.value, null);
});

// Ревью шагов 2026-11-05 (П31.Н10): сессия истекла на действии → вход заново → в чате висела
// старая плашка «…(код 401). Повторить». Успешный вход сбрасывает плашки прошлой сессии.
test("П31.Н10: loginWithToken снимает плашку, оставшуюся от истёкшей сессии", async () => {
  reset();
  setNotice("Не удалось закрепить чат: сервер отклонил запрос (код 401).", 10_000, { label: "Повторить", run: () => {} });
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/auth/login")) return new Response(JSON.stringify({ id: "admin", name: "admin", role: "admin" }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await store.loginWithToken("t").catch(() => {});
    assert.equal(notice.value == null || notice.value === "", true, `плашка: ${notice.value}`);
    assert.equal(store.noticeAction.value, null);
  } finally {
    globalThis.fetch = real;
  }
});
