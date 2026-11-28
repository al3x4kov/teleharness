// Test fixture: a `codex app-server` stand-in for lib/codex-shim.mjs tests
// (FEAT-18.7). Spawned as `node codex-appserver-fake.mjs app-server`; speaks
// JSON-RPC 2.0, one JSON message per line, like codex-cli 0.169.0. Turns
// REPLAY the real recorded streams (tests/fixtures/codex-appserver-accept-
// 0.169.0.jsonl / -decline-) where they exist; the rest are hand-made in the
// shapes of the protocol schema (codex app-server generate-json-schema).
//
// Environment:
//   CODEX_FAKE_LOG=<file>    every received line is appended (JSONL) — tests
//                            assert what the shim sent (params, decisions …)
//   CODEX_FAKE_NOAUTH=1      account/read → {account:null, requiresOpenaiAuth:true}
//   CODEX_FAKE_INIT_ERROR=1  initialize → JSON-RPC error
//   CODEX_FAKE_EXIT_ON_INIT=1 exits right after reading initialize
// Turn scenarios — a keyword in the turn/start input text:
//   (none)       deltas «Привет» + « мир», final answer, token usage
//   APPROVE      the recorded accept stream up to item/commandExecution/
//                requestApproval, then waits for the answer: accept → the rest
//                of the accept recording, anything else → the rest of the
//                decline recording
//   FILECHANGE   fileChange item + item/fileChange/requestApproval
//   REASON       reasoning summary deltas, then the answer
//   SEARCH       webSearch item (query only known on completion)
//   FAIL         turn/completed failed {message:"boom", codexErrorInfo:"other"}
//   LIMIT        error notification + turn failed with usageLimitExceeded
//   UNKNOWNREQ   server request item/tool/requestUserInput, waits for the reply
//   HANG         turn never completes; turn/interrupt → turn/completed interrupted
//   ECHOTHREAD   answer text = JSON of the thread/start|resume|fork params
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REC_THREAD = { accept: "01a1e083-8c1f-78e3-a6aa-ac1549ab91da", decline: "01a1e083-c45b-7870-bbab-8fb0dd094682" };
const ACCEPT_TURN = "01a1e083-92a7-75a2-8482-ddce629b24ac";
const DECLINE_TURN = "01a1e083-c768-7901-8752-eade7c92e8b5";
const LOG = process.env.CODEX_FAKE_LOG || null;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const note = (method, params) => send({ method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let threadId = null;
let threadParams = null;
let threadMethod = null;
let turnSeq = 0;
let srvReqSeq = 100;
const waiters = new Map(); // server request id → resolve(message)
let hangTurn = null;

function recording(kind) {
  const lines = readFileSync(path.join(HERE, `codex-appserver-${kind}-0.169.0.jsonl`), "utf8").split("\n").filter(Boolean);
  // only the turn's notifications/requests: after the turn/start response (id 4)
  const start = lines.findIndex((l) => l.startsWith('{"id":4,'));
  // the decline remainder continues the accept turn: one turn id for both
  return lines.slice(start + 1).map((l) => JSON.parse(l.split(REC_THREAD[kind]).join(threadId).split(DECLINE_TURN).join(ACCEPT_TURN)));
}

async function replay(msgs) {
  for (const m of msgs) {
    send(m);
    await sleep(2);
  }
}

function serverRequest(method, params) {
  const id = srvReqSeq++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((r) => waiters.set(id, r));
}

const usage = (inp, cached, out, total = null) => ({
  threadId,
  turnId: `turn-${turnSeq}`,
  tokenUsage: {
    total: total ?? { totalTokens: inp + out, inputTokens: inp, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: out, reasoningOutputTokens: 0 },
    last: { totalTokens: inp + out, inputTokens: inp, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: out, reasoningOutputTokens: 0 },
    modelContextWindow: 475000,
  },
});
const ids = () => ({ threadId, turnId: `turn-${turnSeq}` });
const completed = (status = "completed", error = null) => note("turn/completed", { threadId, turn: { id: `turn-${turnSeq}`, items: [], status, error } });
async function answer(text, id = "msg_fake_final") {
  note("item/started", { ...ids(), item: { type: "agentMessage", id, text: "", phase: "final_answer" } });
  const half = Math.ceil(text.length / 2);
  for (const d of [text.slice(0, half), text.slice(half)]) if (d) note("item/agentMessage/delta", { ...ids(), itemId: id, delta: d });
  note("item/completed", { ...ids(), item: { type: "agentMessage", id, text, phase: "final_answer" } });
}

async function runTurn(text) {
  if (/APPROVE/.test(text)) {
    const acc = recording("accept");
    const i = acc.findIndex((m) => m.method === "item/commandExecution/requestApproval");
    await replay(acc.slice(0, i));
    const req = acc[i];
    const reply = await new Promise((r) => {
      waiters.set(req.id, r);
      send(req);
    });
    if (reply.result?.decision === "accept") return replay(acc.slice(i + 1));
    const dec = recording("decline");
    const j = dec.findIndex((m) => m.method === "item/commandExecution/requestApproval");
    await replay(dec.slice(j + 1));
    // the decline recording ends before turn/completed (the spike's log was cut
    // at exit) — finish the turn the way the accept recording does
    return note("turn/completed", { threadId, turn: { id: ACCEPT_TURN, items: [], status: "completed", error: null } });
  }
  if (/FILECHANGE/.test(text)) {
    const item = { type: "fileChange", id: "call_fc1", status: "inProgress", changes: [{ path: "D:\\work\\new.txt", kind: { type: "add" }, diff: "hello\n" }] };
    note("item/started", { ...ids(), item });
    const reply = await serverRequest("item/fileChange/requestApproval", { ...ids(), itemId: "call_fc1", startedAtMs: Date.now(), reason: "Создать new.txt?", grantRoot: null });
    const ok = reply.result?.decision === "accept";
    note("item/completed", { ...ids(), item: { ...item, status: ok ? "completed" : "declined" } });
    await answer(ok ? "файл создан" : "файл не создан");
    note("thread/tokenUsage/updated", usage(1000, 0, 10));
    return completed();
  }
  if (/REASON/.test(text)) {
    note("item/started", { ...ids(), item: { type: "reasoning", id: "rs_1", summary: [], content: [] } });
    note("item/reasoning/summaryPartAdded", { ...ids(), itemId: "rs_1", summaryIndex: 0 });
    note("item/reasoning/summaryTextDelta", { ...ids(), itemId: "rs_1", summaryIndex: 0, delta: "Думаю " });
    note("item/reasoning/summaryTextDelta", { ...ids(), itemId: "rs_1", summaryIndex: 0, delta: "о задаче." });
    note("item/completed", { ...ids(), item: { type: "reasoning", id: "rs_1", summary: ["Думаю о задаче."], content: [] } });
    await answer("ответ");
    return completed();
  }
  if (/SEARCH/.test(text)) {
    note("item/started", { ...ids(), item: { type: "webSearch", id: "ws_1", query: "" } });
    note("item/completed", { ...ids(), item: { type: "webSearch", id: "ws_1", query: "погода москва", results: null } });
    await answer("нашёл");
    return completed();
  }
  if (/FAIL/.test(text)) {
    note("error", { ...ids(), willRetry: false, error: { message: "boom", codexErrorInfo: "other" } });
    return completed("failed", { message: "boom", codexErrorInfo: "other" });
  }
  if (/LIMIT/.test(text)) {
    const error = { message: "You've hit your usage limit. Upgrade to Pro or try again in 3 days.", codexErrorInfo: "usageLimitExceeded" };
    note("error", { ...ids(), willRetry: false, error });
    return completed("failed", error);
  }
  if (/ESCALATE/.test(text)) {
    const reply = await serverRequest("item/permissions/requestApproval", { ...ids(), itemId: "call_esc1", permissions: { fileSystem: { write: ["/etc"] } }, reason: "Выйти за папку" });
    await answer(JSON.stringify(reply.result ?? null));
    return completed();
  }
  if (/UNKNOWNREQ/.test(text)) {
    const reply = await serverRequest("item/tool/requestUserInput", { ...ids(), itemId: "q1", isBlocking: true, questions: [] });
    await answer(reply.error ? `error ${reply.error.code}` : "no error");
    return completed();
  }
  if (/HANG/.test(text)) {
    hangTurn = `turn-${turnSeq}`;
    note("item/started", { ...ids(), item: { type: "agentMessage", id: "msg_h", text: "", phase: "commentary" } });
    note("item/agentMessage/delta", { ...ids(), itemId: "msg_h", delta: "работаю" });
    return;
  }
  if (/ECHOTHREAD/.test(text)) {
    await answer(JSON.stringify({ method: threadMethod, params: threadParams }));
    return completed();
  }
  note("item/started", { ...ids(), item: { type: "userMessage", id: "u1", content: [{ type: "text", text }] } });
  note("item/completed", { ...ids(), item: { type: "userMessage", id: "u1", content: [{ type: "text", text }] } });
  await answer("Привет мир");
  // two model calls: total grows over the thread, last = the latest call
  note("thread/tokenUsage/updated", usage(15000, 12000, 100));
  note("thread/tokenUsage/updated", usage(16000, 15000, 20, { totalTokens: 31120, inputTokens: 31000, cachedInputTokens: 27000, cacheWriteInputTokens: 0, outputTokens: 120, reasoningOutputTokens: 0 }));
  note("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1795372460 }, rateLimitReachedType: null } });
  return completed();
}

function handle(m) {
  if (m.method === undefined && m.id !== undefined) {
    const w = waiters.get(m.id);
    if (w) {
      waiters.delete(m.id);
      w(m);
    }
    return;
  }
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  const error = (code, message) => send({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      if (process.env.CODEX_FAKE_EXIT_ON_INIT === "1") process.exit(3);
      if (process.env.CODEX_FAKE_INIT_ERROR === "1") return error(-32600, "unsupported client");
      return reply({ userAgent: "fake/0.169.0", codexHome: "C:\\fake\\.codex", platformFamily: "windows", platformOs: "windows" });
    case "initialized":
      return;
    case "account/read":
      if (process.env.CODEX_FAKE_REFRESH_ERR === "1") {
        if (p.refreshToken === true) {
          process.stderr.write("2026-11-28T11:00:00.000Z ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig rt_secret12345678\n");
        }
        return reply({ account: null, requiresOpenaiAuth: true });
      }
      if (process.env.CODEX_FAKE_EXPIRED_ONCE === "1") {
        if (p.refreshToken === true) {
          return reply({ account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true });
        }
        return reply({ account: null, requiresOpenaiAuth: true });
      }
      if (process.env.CODEX_FAKE_NOAUTH === "1") return reply({ account: null, requiresOpenaiAuth: true });
      return reply({ account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true });
    case "model/list":
      if (!p.cursor)
        return reply({
          data: [
            { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", hidden: false, isDefault: true, inputModalities: ["text", "image"], defaultReasoningEffort: "medium", description: "" },
            { id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: false, isDefault: false, inputModalities: ["text"], defaultReasoningEffort: "low", description: "" },
          ],
          nextCursor: "page2",
        });
      return reply({ data: [{ id: "gpt-old", model: "gpt-old", displayName: "Old", hidden: true, isDefault: false, inputModalities: ["text"], description: "" }], nextCursor: null });
    case "thread/start":
    case "thread/resume":
    case "thread/fork": {
      if (m.method !== "thread/start" && String(p.threadId).startsWith("missing")) return error(-32602, `thread not found: ${p.threadId}`);
      threadMethod = m.method;
      threadParams = p;
      threadId = m.method === "thread/resume" ? p.threadId : m.method === "thread/fork" ? `fork-of-${p.threadId}` : REC_THREAD.accept;
      reply({ thread: { id: threadId, status: { type: "idle" } }, model: process.env.CODEX_FAKE_MODEL ?? p.model ?? "gpt-6.1-sol", reasoningEffort: process.env.CODEX_FAKE_EFFORT ?? null, approvalPolicy: p.approvalPolicy ?? "on-request", sandbox: { type: "workspaceWrite" }, cwd: p.cwd ?? process.cwd() });
      return note("thread/started", { thread: { id: threadId } });
    }
    case "turn/start": {
      turnSeq++;
      const text = (p.input ?? []).map((x) => x?.text ?? "").join("");
      const turnId = /APPROVE/.test(text) ? null : `turn-${turnSeq}`;
      reply({ turn: { id: turnId ?? ACCEPT_TURN, items: [], status: "inProgress", error: null } });
      note("turn/started", { threadId, turn: { id: turnId ?? ACCEPT_TURN, items: [], status: "inProgress" } });
      setImmediate(() => runTurn(text).catch((e) => process.stderr.write(String(e?.stack ?? e))));
      return;
    }
    case "turn/interrupt":
      reply({});
      if (hangTurn) note("turn/completed", { threadId, turn: { id: hangTurn, items: [], status: "interrupted", error: null } });
      return;
    default:
      return error(-32601, `unknown method ${m.method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    if (LOG) appendFileSync(LOG, line + "\n");
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    handle(m);
  }
});
process.stdin.on("end", () => process.exit(0));
