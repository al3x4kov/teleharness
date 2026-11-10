// Regression tests for the store's SSE reducer against the event shapes
// captured live from opencode 1.19.5 (2026-10-31). The bug: message.updated
// properties nest the message under `info`; feeding raw properties to
// upsertIncoming stranded the optimistic user bubble and let the first
// part.updated materialize the vault-cache-injected user text as a fresh
// role:"assistant" message — the raw snapshot showed up in the chat.
// Run: node --test tests/store.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { active, handleEvent, refreshStall, stalled } from "../src/lib/store.js";
import { makeMessage, splitInjected } from "../src/lib/normalize.js";

const SES = "ses_test";

const SNAPSHOT_HEAD = "[obsidian-cache] Активный кэша проекта «user» (C:\\Users\\USER), собран 2026-10-31 07:02.";
const injectedText = (user) => `${SNAPSHOT_HEAD}\n\nПравила кэша: _index.md.\n\n---\n\n${user}`;

function setActive(messages) {
  active.value = { id: SES, title: "", status: "idle", messages };
}

// Live shape: {sessionID, info:{id, role, ...}} — parts never ride on it.
function msgUpdated(id, role, extra = {}) {
  return {
    type: "message.updated",
    properties: { sessionID: SES, info: { id, role, sessionID: SES, time: { created: 1 }, ...extra } },
  };
}

// Live shape: {sessionID, part:{id, messageID, type, ...}}
function partUpdated(part) {
  return { type: "message.part.updated", properties: { sessionID: SES, part, time: 2 } };
}

test("first message: user bubble survives, injected part stays on the user message", () => {
  setActive([makeMessage({ id: "tmp-1", role: "user", time: { created: 0 } }, [{ type: "text", text: "Привет" }])]);

  // 1) message.updated (nested info) replaces the optimistic tmp entry
  handleEvent(msgUpdated("msg_u", "user", { agent: "build" }));
  let act = active.value;
  assert.equal(act.messages.length, 1, "no garbage shell may be appended");
  assert.equal(act.messages[0].info.id, "msg_u");
  assert.equal(act.messages[0].info.role, "user");
  assert.deepEqual(act.messages[0].parts.map((p) => p.text), ["Привет"]);

  // 2) part.updated with the vault-cache-injected text lands on the user message
  handleEvent(partUpdated({ id: "prt_1", messageID: "msg_u", type: "text", text: injectedText("Привет") }));
  act = active.value;
  assert.equal(act.messages.length, 1);
  assert.equal(act.messages[0].info.role, "user", "user text must not become an assistant message");
  assert.equal(act.messages[0].parts.length, 1, "injected server part replaces the typed optimistic part");
  assert.equal(splitInjected(act.messages[0].parts[0].text).text, "Привет");
  assert.ok(splitInjected(act.messages[0].parts[0].text).context.startsWith("[obsidian-cache]"));

  // 3) assistant info + step-start part; 4) session.idle must not drop the user msg
  handleEvent(msgUpdated("msg_a", "assistant", { agent: "build", tokens: { total: 100 } }));
  handleEvent(partUpdated({ id: "prt_2", messageID: "msg_a", type: "step-start" }));
  handleEvent({ type: "session.idle", properties: { sessionID: SES } });
  act = active.value;
  assert.deepEqual(
    act.messages.map((m) => m.info.role),
    ["user", "assistant"],
    "exactly the real user + assistant messages survive idle",
  );
  assert.equal(splitInjected(act.messages[0].parts[0].text).text, "Привет");
});

test("out-of-order part.updated still yields a single clean user message", () => {
  setActive([makeMessage({ id: "tmp-1", role: "user", time: { created: 0 } }, [{ type: "text", text: "Привет" }])]);

  // part.updated arrives before message.updated: placeholder must be role-less-safe
  handleEvent(partUpdated({ id: "prt_1", messageID: "msg_u", type: "text", text: injectedText("Привет") }));
  handleEvent(msgUpdated("msg_u", "user"));
  handleEvent({ type: "session.idle", properties: { sessionID: SES } });

  const users = active.value.messages.filter((m) => m.info.role === "user");
  assert.equal(users.length, 1, "tmp and real user messages must collapse into one");
  assert.equal(users[0].info.id, "msg_u");
  assert.equal(splitInjected(users[0].parts[0].text).text, "Привет");
});

test("message.updated without id (odd payload) is ignored, never appended", () => {
  setActive([makeMessage({ id: "m1", role: "user" }, [])]);
  handleEvent({ type: "message.updated", properties: { sessionID: SES, info: { role: "user" } } });
  handleEvent({ type: "message.updated", properties: { sessionID: SES } });
  assert.equal(active.value.messages.length, 1);
  assert.equal(active.value.messages[0].info.id, "m1");
});

// ---- dogfood 2026-11-02: abandoned empty chats + failed-send retry ----------

function stubFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const c = { url: String(url), method: opts.method ?? "GET", body: opts.body };
    calls.push(c);
    return handler(c);
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}

test("BUG-009: a chat created here and left empty is deleted on close", async () => {
  const { createAndOpen, closeSession, sessions: sessionsSignal } = await import("../src/lib/store.js");
  const f = stubFetch((c) => {
    if (c.method === "POST" && c.url.split("?")[0].endsWith("/session")) {
      return { ok: true, status: 200, json: async () => ({ id: "ses_empty", title: "", directory: "C:\\H" }) };
    }
    return { ok: true, status: 200, json: async () => [] };
  });
  try {
    sessionsSignal.value = [];
    await createAndOpen({ directory: "C:\\H" });
    closeSession();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(f.calls.some((c) => c.method === "DELETE" && c.url.includes("ses_empty")), "the empty chat is deleted upstream");
    assert.ok(!sessionsSignal.value.some((s) => s.id === "ses_empty"), "and gone from the list");
  } finally {
    f.restore();
    sessionsSignal.value = [];
  }
});

test("BUG-017: a failed send keeps the chat, marks the bubble, «Повторить» resends the same text", async () => {
  const { createAndOpen, closeSession, send, retryFailed, active, setNotice, sessions: sessionsSignal } = await import("../src/lib/store.js");
  let online = false;
  const f = stubFetch((c) => {
    const p = c.url.split("?")[0];
    if (c.method === "POST" && p.endsWith("/session")) {
      return { ok: true, status: 200, json: async () => ({ id: "ses_fail", title: "", directory: "C:\\H" }) };
    }
    if (p.endsWith("/prompt")) {
      if (!online) throw new TypeError("fetch failed");
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => [] };
  });
  try {
    sessionsSignal.value = [];
    await createAndOpen({ directory: "C:\\H" });
    await send({ text: "не потеряй меня" });
    const failed = active.value.messages.find((m) => m.info.failed);
    assert.ok(failed, "the optimistic bubble is marked failed");
    assert.equal(active.value.status, "idle");
    online = true;
    await retryFailed(failed.info.id);
    const prompts = f.calls.filter((c) => c.url.split("?")[0].endsWith("/prompt"));
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].body.includes("не потеряй меня"), "the retry carries the same text");
    assert.ok(!active.value.messages.some((m) => m.info.failed), "the failed copy is replaced");
    closeSession();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!f.calls.some((c) => c.method === "DELETE"), "a chat with messages is never auto-deleted");
  } finally {
    f.restore();
    setNotice(null); // shared module state: later tests assert a clean notice
    sessionsSignal.value = [];
  }
});

// ---- project-scoped chat creation ------------------------------------------
// createAndOpen goes through api.js (relative fetch URLs). Stub globalThis.fetch
// (referenced lazily at call time) to capture the request and answer fixtures.

test("createAndOpen({directory}) POSTs ?directory= and upserts the session with it", async () => {
  const { createAndOpen, sessions: sessionsSignal } = await import("../src/lib/store.js");
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? "GET" });
    const path = String(url).split("?")[0];
    if (opts.method === "POST" && path.endsWith("/session")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "ses_new", title: "", directory: "D:\\Proj" }),
      };
    }
    return { ok: true, status: 200, json: async () => [] }; // message list etc.
  };
  try {
    sessionsSignal.value = [];
    const s = await createAndOpen({ directory: "D:\\Proj" });
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/session"));
    assert.ok(post, "a POST /session must be issued");
    assert.ok(
      post.url.includes("directory=D%3A%5CProj"),
      `POST must carry the project directory, got ${post.url}`,
    );
    assert.equal(s.id, "ses_new");
    assert.equal(s.directory, "D:\\Proj");
    assert.ok(
      sessionsSignal.value.some((x) => x.id === "ses_new" && x.directory === "D:\\Proj"),
      "the created session must land in the sessions signal with its directory",
    );
  // the follow-up message load must reuse the session's own directory
  const msgCall = calls.find((c) => c.url.includes("/message"));
  assert.ok(msgCall && msgCall.url.includes("directory=D%3A%5CProj"), "message fetch must be directory-scoped");
  } finally {
    globalThis.fetch = realFetch;
    sessionsSignal.value = [];
  }
});

// ---- dialog reply contract (2026-11-01: question replies 400ed all day) ----
// opencode 1.19.5 expects {answers: string[][]} — an array of selected labels
// PER question. The old flat {answers:[label]} 400ed with «Expected
// QuestionAnswer, got …» on every tap.

test("replyDialog(question) POSTs answers as string[][] and drops the dialog on success", async () => {
  const { replyDialog, dialogs, notice } = await import("../src/lib/store.js");
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => true };
  };
  try {
    const dialog = { kind: "question", id: "que_1", sessionID: "ses_1", questions: [] };
    dialogs.value = [dialog];
    await replyDialog(dialog, "Работать параллельно");
    const call = calls.find((c) => c.url.includes("/question/que_1/reply"));
    assert.ok(call, "question reply must be POSTed");
    assert.deepEqual(call.body, { answers: [["Работать параллельно"]] },
      "answers must be an array of label-arrays (opencode QuestionAnswer = string[])");
    assert.equal(dialogs.value.length, 0, "dialog leaves the queue after a successful reply");
    assert.equal(notice.value, null);
  } finally {
    globalThis.fetch = realFetch;
    dialogs.value = [];
  }
});

test("replyDialog: server 4xx drops the dialog for good (no dead retry), network error re-arms it", async () => {
  const { replyDialog, dialogs, notice } = await import("../src/lib/store.js");
  const realFetch = globalThis.fetch;

  // upstream said no (expired / answered / contract drift) — a retry can
  // never succeed: dialog must NOT come back, a notice must explain why.
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ name: "BadRequest" }) });
  try {
    const dialog = { kind: "question", id: "que_bad", sessionID: "ses_1", questions: [] };
    dialogs.value = [dialog];
    await replyDialog(dialog, "любой");
    assert.equal(dialogs.value.length, 0, "4xx must drop the dialog, not re-arm it");
    assert.ok(String(notice.value).includes("не актуален"), "notice must explain the drop");
  } finally {
    globalThis.fetch = realFetch;
    dialogs.value = [];
    notice.value = null;
  }

  // network failure — retry CAN succeed later: dialog re-arms with error:true
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  try {
    const dialog = { kind: "permission", id: "per_net", sessionID: "ses_1" };
    dialogs.value = [dialog];
    await replyDialog(dialog, "once");
    assert.equal(dialogs.value.length, 1, "network failure must re-arm the dialog");
    assert.equal(dialogs.value[0].error, true, "re-armed dialog carries error:true");
  } finally {
    globalThis.fetch = realFetch;
    dialogs.value = [];
    notice.value = null;
  }
});

// ---- hung-turn UX: busy visibility + stall banner (2026-10-31 incident) -----
// Live wire: session.status carries status as an OBJECT {type:"busy"|"idle"}.
// The old string compare (p.status === "idle") never matched, so the only idle
// path was session.idle, and a freshly opened chat that was actually hung
// looked idle — no stop button, no way out.

test("session.status object shape: busy sets busy, {type:'idle'} clears", () => {
  active.value = { id: SES, title: "", status: "idle", messages: [], loading: false };
  handleEvent({ type: "session.status", properties: { sessionID: SES, status: { type: "busy" } } });
  assert.equal(active.value.status, "busy");
  handleEvent({ type: "session.status", properties: { sessionID: SES, status: { type: "idle" } } });
  assert.equal(active.value.status, "idle", "object-shaped idle must be honored");
});

test("openSession reads upstream busy status (reload into a hung chat shows Прервать)", async () => {
  const { openSession, sessions: sessionsSignal } = await import("../src/lib/store.js");
  const realFetch = globalThis.fetch;
  const fake = (statusMap) => async (url) => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/status")) return { ok: true, status: 200, json: async () => statusMap };
    return { ok: true, status: 200, json: async () => [] }; // message list
  };
  try {
    sessionsSignal.value = [];
    globalThis.fetch = fake({ [SES]: { type: "busy" } });
    await openSession(SES);
    assert.equal(active.value.status, "busy", "a hung upstream turn must open as busy");

    globalThis.fetch = fake({});
    await openSession(SES);
    assert.equal(active.value.status, "idle");
  } finally {
    globalThis.fetch = realFetch;
    sessionsSignal.value = [];
  }
});

// 2026-11-02 incident: an edge-wide 404 on /message left `known` chats showing
// the empty hero — loadError must be set so ChatView can render the retry
// state instead of masking the outage as a fresh chat.
test("openSession: dead history fetch sets loadError; successful retry clears it", async () => {
  const { openSession, sessions: sessionsSignal } = await import("../src/lib/store.js");
  const realFetch = globalThis.fetch;
  try {
    sessionsSignal.value = [{ id: SES, title: "chat in list", directory: "C:\\Users\\USER" }];
    globalThis.fetch = async (url) => {
      const path = String(url).split("?")[0];
      if (path.endsWith("/status")) return { ok: true, status: 200, json: async () => ({}) };
      if (path.endsWith("/message")) throw new TypeError("fetch failed");
      return { ok: true, status: 200, json: async () => [] };
    };
    await openSession(SES);
    assert.equal(active.value.loading, false, "loading must settle even on failure");
    assert.equal(active.value.loadError, true, "known chat with dead history carries loadError");

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
    await openSession(SES);
    assert.equal(active.value.loadError, false, "successful retry clears the error");
  } finally {
    globalThis.fetch = realFetch;
    sessionsSignal.value = [];
  }
});

test("stall banner: 2min of silence while busy raises it; any event or idle clears it", () => {
  active.value = { id: SES, title: "", status: "busy", lastEventAt: Date.now() - 300_000, messages: [], loading: false };
  stalled.value = false;
  refreshStall();
  assert.equal(stalled.value, true, "silence past the window while busy must raise the banner");

  // any event for the session refreshes the stall clock
  handleEvent({ type: "session.diff", properties: { sessionID: SES, diff: [] } });
  assert.equal(stalled.value, false, "a live event must clear the banner");

  // rewind the clock again, then end the turn
  active.value = { ...active.value, lastEventAt: Date.now() - 300_000 };
  refreshStall();
  assert.equal(stalled.value, true);
  handleEvent({ type: "session.idle", properties: { sessionID: SES } });
  assert.equal(stalled.value, false, "turn end must clear the banner");
});
