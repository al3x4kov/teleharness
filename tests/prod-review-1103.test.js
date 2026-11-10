// Prod dogfood 2026-11-03 (zai 1.7.0) client fixes: ISSUE-001 long chat
// title (header CSS), ISSUE-002 opencode follow-up held until the previous
// question is answered, ISSUE-003 guessed relative pictures, ISSUE-007 rename
// error inside the modal, ISSUE-008 human model name before the catalog.
// No network: fetch is stubbed per test.
// Run: node --test tests/prod-review-1103.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as store from "../src/lib/store.js";
import { awaitingAnswer, isLocalOnly, finalizeMessages } from "../src/lib/turn.js";
import { collectArtifactEntries, collectArtifacts, makeMessage } from "../src/lib/normalize.js";

const { active, busyMap, dialogs, handleEvent, notice, pendingMap, sessions, setNotice } = store;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const ok = (body, status = 200) => ({ ok: true, status, json: async () => body, headers: { get: () => null } });
const fail = (status) => ({ ok: false, status, json: async () => ({}), headers: { get: () => null } });

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

const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };

function reset() {
  active.value = null;
  sessions.value = [];
  dialogs.value = [];
  busyMap.value = {};
  pendingMap.value = {};
  setNotice(null);
}

function openChat(sid, model = GLM) {
  sessions.value = [{ id: sid, title: "t", directory: "C:\\H", zai: { model, agent: model === GLM ? "build" : null, prompted: true } }];
  active.value = { id: sid, title: "t", status: "idle", lastEventAt: Date.now(), messages: [], loading: false, loadError: false };
}

const prompts = (f) => f.calls.filter((c) => c.path.endsWith("/prompt"));
const textOfPrompt = (c) => c.body.parts.map((p) => p.text).join(" ");
const bubble = (text) => active.value.messages.find((m) => m.parts?.some((p) => p.text === text));

// ---- ISSUE-002 ---------------------------------------------------------------

test("ISSUE-002: awaitingAnswer — newest sent question without an answer below it", () => {
  const u = (id, extra = {}) => makeMessage({ id, role: "user", ...extra }, []);
  const a = (id) => makeMessage({ id, role: "assistant" }, []);
  assert.equal(awaitingAnswer([]), false);
  assert.equal(awaitingAnswer([u("u1")]), true);
  assert.equal(awaitingAnswer([u("u1"), a("a1")]), false);
  assert.equal(awaitingAnswer([u("u1"), a("a1"), u("u2")]), true);
  assert.equal(awaitingAnswer([u("u1"), a("a1"), u("tmp-1", { delivery: "held" })]), false, "held bubbles never reached the server");
  assert.equal(awaitingAnswer([u("u1"), a("a1"), u("tmp-1", { failed: true })]), false);
  const held = u("tmp-2", { delivery: "held" });
  assert.equal(isLocalOnly(held), true, "a held bubble survives history refresh and turn end");
  assert.deepEqual(finalizeMessages([held]).map((m) => m.info.id), ["tmp-2"]);
});

test("ISSUE-002: opencode follow-up before the first answer is held, sent after the answer starts — each question gets its own answer", async () => {
  reset();
  const SID = "ses_q1";
  openChat(SID);
  const f = stubFetch(async (c) => (c.path.endsWith("/prompt") ? ok(null, 204) : ok({})));
  try {
    assert.equal(await store.send({ text: "Какая столица Франции?", sessionId: SID }), true);
    assert.equal(prompts(f).length, 1);
    // 1.5 s later — the turn runs, no assistant message yet.
    assert.equal(await store.send({ text: "Какая столица Италии?", sessionId: SID }), true);
    assert.equal(prompts(f).length, 1, "the second question is NOT posted while the first has no answer");
    const q2 = bubble("Какая столица Италии?");
    assert.equal(q2.info.delivery, "held");
    assert.equal(q2.info.queued, true, "the bubble honestly says «В очереди»");
    assert.equal(store.heldCount(SID), 1);

    // The server stores question 1 and starts answering it.
    handleEvent({ type: "message.updated", properties: { sessionID: SID, info: { id: "msg_u1", sessionID: SID, role: "user", time: { created: 1 } } } });
    assert.equal(bubble("Какая столица Италии?").info.delivery, "held", "a user echo is not an answer");
    assert.equal(prompts(f).length, 1);
    handleEvent({ type: "message.updated", properties: { sessionID: SID, info: { id: "msg_a1", sessionID: SID, role: "assistant", parentID: "msg_u1", time: { created: 2 } } } });
    await tick();
    assert.equal(prompts(f).length, 2, "released once the answer to question 1 started");
    assert.match(textOfPrompt(prompts(f)[1]), /Италии/);
    assert.equal(store.heldCount(SID), 0);
    assert.equal(bubble("Какая столица Италии?").info.delivery, "delivered");
  } finally {
    f.restore();
    reset();
  }
});

test("ISSUE-002: two held follow-ups go out one at a time; turn end releases the next", async () => {
  reset();
  const SID = "ses_q2";
  openChat(SID);
  const f = stubFetch(async (c) => (c.path.endsWith("/prompt") ? ok(null, 204) : ok({})));
  try {
    await store.send({ text: "Q1", sessionId: SID });
    await store.send({ text: "Q2", sessionId: SID });
    await store.send({ text: "Q3", sessionId: SID });
    assert.equal(prompts(f).length, 1);
    assert.equal(store.heldCount(SID), 2);
    handleEvent({ type: "message.updated", properties: { sessionID: SID, info: { id: "msg_u1", sessionID: SID, role: "user" } } });
    handleEvent({ type: "message.updated", properties: { sessionID: SID, info: { id: "msg_a1", sessionID: SID, role: "assistant", parentID: "msg_u1" } } });
    await tick();
    assert.deepEqual(prompts(f).map(textOfPrompt), ["Q1", "Q2"], "only Q2 — Q3 waits for Q2's answer");
    // More steps of answer 1 must not release Q3 (Q2 still unanswered).
    handleEvent({ type: "message.updated", properties: { sessionID: SID, info: { id: "msg_a1", sessionID: SID, role: "assistant", parentID: "msg_u1", time: { completed: 3 } } } });
    await tick();
    assert.equal(prompts(f).length, 2);
    // Turn end (status idle + session.idle back to back) releases exactly one.
    handleEvent({ type: "session.status", properties: { sessionID: SID, status: { type: "idle" } } });
    handleEvent({ type: "session.idle", properties: { sessionID: SID } });
    await tick();
    assert.deepEqual(prompts(f).map(textOfPrompt), ["Q1", "Q2", "Q3"]);
    assert.equal(store.heldCount(SID), 0);
  } finally {
    f.restore();
    reset();
  }
});

test("ISSUE-002: once the answer has started, a follow-up is sent at once (opencode queues it)", async () => {
  reset();
  const SID = "ses_q3";
  openChat(SID);
  const f = stubFetch(async (c) => (c.path.endsWith("/prompt") ? ok(null, 204) : ok({})));
  try {
    await store.send({ text: "Мадрид?", sessionId: SID });
    handleEvent({ type: "message.updated", properties: { sessionID: SID, info: { id: "msg_u1", sessionID: SID, role: "user" } } });
    handleEvent({ type: "message.updated", properties: { sessionID: SID, info: { id: "msg_a1", sessionID: SID, role: "assistant", parentID: "msg_u1" } } });
    await store.send({ text: "Берлин?", sessionId: SID });
    assert.equal(prompts(f).length, 2);
    assert.equal(bubble("Берлин?").info.queued, true);
    assert.equal(bubble("Берлин?").info.delivery, "delivered");
  } finally {
    f.restore();
    reset();
  }
});

test("ISSUE-002: Claude chats keep the server-side queue — follow-up posted at once", async () => {
  reset();
  const SID = "ses_q4";
  openChat(SID, OPUS);
  const f = stubFetch(async (c) => (c.path.endsWith("/prompt") ? ok(null, 204) : ok({})));
  try {
    await store.send({ text: "раз", sessionId: SID });
    await store.send({ text: "два", sessionId: SID });
    assert.equal(prompts(f).length, 2);
    assert.equal(store.heldCount(SID), 0);
  } finally {
    f.restore();
    reset();
  }
});

test("ISSUE-002: «Стоп» turns held follow-ups into «Не отправлено» with «Повторить», nothing posted", async () => {
  reset();
  const SID = "ses_q5";
  openChat(SID);
  const f = stubFetch(async (c) => (c.path.endsWith("/prompt") || c.path.endsWith("/abort") ? ok(null, 204) : ok([])));
  try {
    await store.send({ text: "Q1", sessionId: SID });
    await store.send({ text: "Q2", sessionId: SID });
    store.stop();
    const q2 = bubble("Q2");
    assert.equal(q2.info.failed, true);
    assert.equal(q2.info.failReason, "stopped");
    assert.equal(store.heldCount(SID), 0);
    handleEvent({ type: "session.idle", properties: { sessionID: SID } });
    await tick(20);
    assert.equal(prompts(f).length, 1, "the cancelled follow-up is not sent behind the user's back");
    assert.ok(bubble("Q2"), "the bubble stays for «Повторить»");
  } finally {
    f.restore();
    reset();
  }
});

test("ISSUE-002: a held follow-up whose POST fails becomes a failed bubble", async () => {
  reset();
  const SID = "ses_q6";
  openChat(SID);
  let n = 0;
  const f = stubFetch(async (c) => (c.path.endsWith("/prompt") ? (++n === 1 ? ok(null, 204) : fail(502)) : ok({})));
  try {
    await store.send({ text: "Q1", sessionId: SID });
    await store.send({ text: "Q2", sessionId: SID });
    handleEvent({ type: "session.idle", properties: { sessionID: SID } });
    await tick();
    const q2 = bubble("Q2");
    assert.equal(q2.info.failed, true);
    assert.equal(q2.info.failReason, "rejected");
  } finally {
    f.restore();
    reset();
  }
});

// ---- ISSUE-003 ---------------------------------------------------------------

test("ISSUE-003: relative picture names from the text are marked guessed; write/edit and absolute paths are not", () => {
  const dir = "C:\\Users\\USER\\proj";
  const parts = [{ type: "tool", tool: "write", state: { status: "completed", input: { filePath: `${dir}\\made.png` } } }];
  const texts = [`Готово: ${dir}\\abs.png, а ещё shots/v2-qa-viewer-png.png и made.png`];
  const entries = collectArtifactEntries(parts, texts, dir);
  const by = Object.fromEntries(entries.map((e) => [e.path.split("\\").pop(), e.guessed]));
  assert.equal(by["made.png"], false, "write/edit");
  assert.equal(by["abs.png"], false, "absolute path from the text");
  assert.equal(by["v2-qa-viewer-png.png"], true, "relative name glued to the session folder");
  assert.deepEqual(collectArtifacts(parts, texts, dir), entries.map((e) => e.path), "collectArtifacts keeps its old shape");
});

// ---- ISSUE-001 ---------------------------------------------------------------

test("ISSUE-001: the chat header clips a long title to its column", () => {
  const lf = (s) => s.replace(/\r\n/g, "\n");
  const app = lf(readFileSync(new URL("../src/app.css", import.meta.url), "utf8"));
  const chat = lf(readFileSync(new URL("../src/components/chat.css", import.meta.url), "utf8"));
  const rule = (css, sel) => {
    const m = css.match(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    return m ? m[2] : "";
  };
  assert.match(rule(app, ".chat-header"), /grid-template-columns:\s*44px\s+minmax\(0,\s*1fr\)\s+44px/);
  const heading = rule(chat, ".chat-heading");
  assert.match(heading, /min-width:\s*0/);
  assert.match(heading, /overflow:\s*hidden/);
  assert.match(heading, /width:\s*100%/);
  const lines = rule(chat, ".chat-heading > .chat-title,\n.chat-heading > .chat-sub");
  for (const d of [/max-width:\s*100%/, /white-space:\s*nowrap/, /overflow:\s*hidden/, /text-overflow:\s*ellipsis/]) assert.match(lines, d);
  assert.match(rule(chat, ".chat-header > .icon-btn"), /z-index:\s*1/, "«Назад» / «Стоп» above the heading");
});

// ---- ISSUE-007 ---------------------------------------------------------------

test("ISSUE-007: renameSession with onError — rollback, error to the caller, no global notice", async () => {
  reset();
  sessions.value = [{ id: "s1", title: "Старое", directory: "C:\\H" }];
  const f = stubFetch(async () => fail(502));
  try {
    let got = null;
    const r = await store.renameSession("s1", "Новое", { onError: (m) => (got = m) });
    assert.equal(r, false);
    assert.match(got, /переименовать/i);
    assert.equal(notice.value, null);
    assert.equal(sessions.value[0].title, "Старое");
  } finally {
    f.restore();
    reset();
  }
});
