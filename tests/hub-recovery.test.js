// Tests for the Г2 hub fixes (2026-11-02 review):
//   CC-1   queued prompt is not «answered» by the previous turn's traffic
//   CC-2   replay counter lands on the live entry whatever the SSE/POST order
//   CC-20  a human prompt after exhaustion starts a fresh episode
//   BUG-07.12 counter survives a restart (pendingStatePath)
//   ADR-005   epoch in SSE ids, resync on foreign/ahead/legacy ids
//   FEAT-07.15 no dialog auto-reject by default; dialog parking is not a hang
//   BUG-07.7 loop detector, BUG-07.8 zai.turn.incomplete
//   BUG-12.17 slow-consumer cut-off, per-key stream cap
//   BUG-07.10 prepareForPrompt, FEAT-07.16 sessionsReport
// Events are injected through hub.emit() (the same #emitEvent pipeline the
// upstream SSE feeds), so most tests need no sockets and no sleeps.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { EventHub } from "../lib/hub.js";

const cleanups = [];
after(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Condition polling instead of fixed windows (robust under a loaded machine).
async function waitUntil(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) return false;
    await sleep(20);
  }
  return true;
}
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

// Fake opencode upstream: JSON for every REST route, records POSTs, SSE on
// /event. onPost(post) may return a promise to delay the HTTP answer.
// GET /session/<id> (BUG-186 verification face): 200 + record when the id is
// in sessionList, 200 + {id} when listed in aliveIds (a chat alive but absent
// from the general index — a git-project chat), socket killed for dropIds
// (network error), else 404. gets logs those lookups as {id, dir}.
function fakeUpstream({ messagesById = {}, sessionList = [], aliveIds = [], dropIds = [], onPost = null } = {}) {
  const posts = [];
  const gets = [];
  const sse = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const post = { url: req.url, path: url.pathname, dir: url.searchParams.get("directory"), body: Buffer.concat(chunks).toString("utf8") };
        posts.push(post);
        if (onPost) await onPost(post);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("true");
      });
      return;
    }
    if (url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      sse.push(res);
      return;
    }
    let body = [];
    let status = 200;
    if (url.pathname === "/session") body = sessionList;
    else if (url.pathname === "/session/status") body = {};
    else if (url.pathname.endsWith("/message")) body = messagesById[decodeURIComponent(url.pathname.split("/")[2])] ?? [];
    else {
      const mSingle = /^\/session\/([^/]+)$/.exec(url.pathname);
      if (mSingle && mSingle[1] !== "status") {
        const id = decodeURIComponent(mSingle[1]);
        gets.push({ id, dir: url.searchParams.get("directory") });
        if (dropIds.includes(id)) {
          res.destroy(); // network error for the hub's fetch
          return;
        }
        const rec = sessionList.find((s) => s?.id === id);
        if (rec) body = rec;
        else if (aliveIds.includes(id)) body = { id, directory: url.searchParams.get("directory") };
        else status = 404;
      }
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const base = listen(server).then(() => `http://127.0.0.1:${server.address().port}`);
  return {
    posts,
    gets,
    base,
    async close() {
      for (const r of sse.splice(0)) r.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

async function hubWith(opts = {}, upOpts = {}) {
  const up = fakeUpstream(upOpts);
  const hub = new EventHub({ unstickSettleMs: 0, ...opts });
  hub.start(await up.base, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  return { hub, up };
}

const userMsg = (sid, id) => ({ type: "message.updated", properties: { sessionID: sid, info: { id, role: "user", time: { created: Date.now() } } } });
const asstMsg = (sid, id, parentID, extra = {}) => ({ type: "message.updated", properties: { sessionID: sid, info: { id, role: "assistant", parentID, time: { created: Date.now(), ...extra } } } });
const delta = (sid, messageID) => ({ type: "message.part.delta", properties: { sessionID: sid, messageID, partID: "prt", field: "text", delta: "x" } });
const status = (sid, type) => ({ type: "session.status", properties: { sessionID: sid, status: { type } } });

// Records everything the hub broadcasts (fake res, no sockets).
function fakeClient(hub, { key = null, lastEventId = null, visible = null } = {}) {
  const res = new EventEmitter();
  res.chunks = [];
  res.writableLength = 0;
  res.destroyed = false;
  res.writableEnded = false;
  res.headers = null;
  res.writeHead = (status, headers) => {
    res.headers = headers;
  };
  res.write = (chunk) => {
    res.chunks.push(chunk);
    return true;
  };
  res.destroy = () => {
    res.destroyed = true;
  };
  const req = { url: "/zai/api/event", headers: lastEventId == null ? {} : { "last-event-id": lastEventId } };
  hub.handleClient(req, res, { key, visible });
  res.text = () => res.chunks.join("");
  res.events = () =>
    res
      .text()
      .split("\n\n")
      .map((f) => f.split("\n").find((l) => l.startsWith("data: ")))
      .filter(Boolean)
      .map((l) => JSON.parse(l.slice(6)));
  return res;
}

// ---- CC-1: queued prompt vs the previous turn's traffic ----------------------

test("CC-1: deltas/completion of the PREVIOUS turn do not settle a prompt queued behind it", () => {
  const hub = new EventHub({ stallReplayMs: 60_000 });
  const S = "ses_q";
  hub.emit(status(S, "busy"));
  hub.emit(userMsg(S, "P1"));
  hub.emit(asstMsg(S, "A1", "P1"));
  hub.emit(delta(S, "A1"));
  assert.equal(hub.pendingSnapshot()[S], undefined, "A1 answers P1");

  hub.emit(userMsg(S, "P2")); // queued while A1 still streams
  hub.emit(delta(S, "A1"));
  hub.emit({ type: "message.part.updated", properties: { sessionID: S, part: { id: "p9", messageID: "A1", type: "text" } } });
  assert.ok(hub.pendingSnapshot()[S], "A1 traffic must not settle the queued P2");
  hub.emit(asstMsg(S, "A1", "P1", { completed: Date.now() }));
  assert.ok(hub.pendingSnapshot()[S], "A1 completing (parentID=P1) must not settle P2 either");

  hub.emit(asstMsg(S, "A2", "P2"));
  hub.emit(delta(S, "A2"));
  assert.equal(hub.pendingSnapshot()[S], undefined, "the answer to P2 (parentID=P2) settles it");
});

test("CC-1: without parentID, only a message first seen AFTER the prompt counts as its answer", () => {
  const hub = new EventHub({ stallReplayMs: 60_000 });
  const S = "ses_np";
  hub.emit(userMsg(S, "P1"));
  hub.emit(delta(S, "A1")); // first sight of A1, after P1 → answers P1
  assert.equal(hub.pendingSnapshot()[S], undefined);
  hub.emit(userMsg(S, "P2"));
  hub.emit(delta(S, "A1")); // A1 predates P2
  assert.ok(hub.pendingSnapshot()[S], "an assistant seen before P2 is the previous turn");
  hub.emit(delta(S, "A2"));
  assert.equal(hub.pendingSnapshot()[S], undefined, "a new assistant after P2 answers it");
  hub.emit(userMsg(S, "P2")); // post-turn re-emit
  assert.equal(hub.pendingSnapshot()[S], undefined, "BUG-016 memory still holds");
});

test("CC-1 follow-up: a queued prompt is not «stalled» while the turn runs; its clock restarts at idle", async () => {
  const hub = new EventHub({ stallReplayMs: 80 });
  const S = "ses_cl";
  hub.emit(status(S, "busy"));
  hub.emit(userMsg(S, "P2"));
  await sleep(120);
  assert.equal(hub.stalledSnapshot()[S], undefined, "busy session: a queued prompt is not a hang");
  hub.emit(status(S, "idle"));
  assert.equal(hub.stalledSnapshot()[S], undefined, "the window restarts when the turn ends");
  await sleep(120);
  assert.ok(hub.stalledSnapshot()[S], "idle + unanswered past the window → banner state");
});

// ---- CC-2 / CC-20 / persistence: replay counter -----------------------------

const stuckTail = (sid) => ({
  [sid]: [
    { info: { id: "a0", role: "assistant", providerID: "p", modelID: "m", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "old" }] },
    { info: { id: "u1", role: "user", time: { created: Date.now() - 60_000 } }, parts: [{ type: "text", text: "stuck" }] },
  ],
});

test("CC-2: the replay's own message.updated arriving BEFORE the POST answer keeps the cap", async () => {
  const S = "ses_race";
  let n = 0;
  let hubRef;
  const { hub, up } = await hubWith(
    { stallReplayMs: 60, stallTickMs: 20, maxPromptReplays: 2 },
    {
      messagesById: stuckTail(S),
      // upstream creates the replay's user message and the hub hears it
      // BEFORE the HTTP answer — the order that used to lose the increment
      onPost: async (p) => {
        if (!p.path.endsWith("/prompt_async")) return;
        n += 1;
        hubRef.emit(userMsg(S, `r${n}`), "C:\\Home");
        await sleep(30);
      },
    },
  );
  hubRef = hub;
  hub.emit(userMsg(S, "u1"), "C:\\Home");
  await sleep(900);
  const replays = up.posts.filter((p) => p.path === `/session/${S}/prompt_async`);
  assert.equal(replays.length, 2, "exactly maxPromptReplays replays, never an endless chain");
  assert.equal(hub.pendingSnapshot()[S].replays, 2, "the counter lives on the live Map entry");
  assert.ok(up.posts.some((p) => p.path === `/session/${S}/abort`), "the retry is preceded by an abort");
});

test("CC-20: a HUMAN prompt after exhaustion starts a fresh episode (counter 0)", async () => {
  const S = "ses_human";
  const { hub, up } = await hubWith({ stallReplayMs: 60, stallTickMs: 20, maxPromptReplays: 1 }, { messagesById: stuckTail(S) });
  hub.emit(userMsg(S, "u1"), "C:\\Home");
  await sleep(300);
  assert.equal(up.posts.filter((p) => p.path.endsWith("/prompt_async")).length, 1);
  hub.emit(userMsg(S, "r1"), "C:\\Home"); // the replay's own persisted message
  assert.equal(hub.pendingSnapshot()[S].replays, 1, "the replay-created message inherits → exhausted");
  hub.emit(userMsg(S, "u_manual"), "C:\\Home"); // the human presses «Отправить снова»
  assert.equal(hub.pendingSnapshot()[S].replays, 0, "a manual re-send must not inherit the exhausted counter");
  assert.equal(hub.stalledSnapshot()[S], undefined, "…nor show the banner instantly");
});

test("BUG-180: a replay keeps the variant of the stuck turn; a turn without one is replayed without", async () => {
  const S = "ses_variant";
  const T = "ses_novariant";
  const tail = (sid, variant) => ({
    [sid]: [
      { info: { id: "a0", role: "assistant", providerID: "zai-coding-plan", modelID: "glm-5.3-flash", agent: "Sisyphus - ultraworker", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "old" }] },
      { info: { id: "u1", role: "user", ...(variant ? { variant } : {}), time: { created: Date.now() - 60_000 } }, parts: [{ type: "text", text: "stuck" }] },
    ],
  });
  const { hub, up } = await hubWith({ stallReplayMs: 60, stallTickMs: 20, maxPromptReplays: 1 }, { messagesById: { ...tail(S, "low"), ...tail(T, null) } });
  hub.emit(userMsg(S, "u1"), "C:\\Home");
  hub.emit(userMsg(T, "u1"), "C:\\Home");
  assert.ok(await waitUntil(() => up.posts.filter((p) => p.path.endsWith("/prompt_async")).length >= 2));
  const body = (sid) => JSON.parse(up.posts.find((p) => p.path === `/session/${sid}/prompt_async`).body);
  assert.equal(body(S).variant, "low");
  assert.deepEqual(body(S).model, { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" });
  assert.equal("variant" in body(T), false);
});

test("CC-20: with no replay in flight a new prompt never inherits", () => {
  const hub = new EventHub({ stallReplayMs: 60_000 });
  const S = "ses_inh";
  hub.emit(userMsg(S, "u1"));
  hub.emit(userMsg(S, "u2"));
  assert.equal(hub.pendingSnapshot()[S].replays, 0);
});

test("BUG-07.12: replay counters survive a restart via pendingStatePath", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zai-hub-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hub-pending.json");
  const S = "ses_disk";
  const sessionList = [{ id: S, directory: "C:\\Home", time: { updated: Date.now() } }];
  const opts = { stallReplayMs: 60, stallTickMs: 20, maxPromptReplays: 1, pendingStatePath: file };

  const first = await hubWith(opts, { messagesById: stuckTail(S), sessionList });
  first.hub.emit(userMsg(S, "u1"), "C:\\Home");
  await sleep(250);
  assert.equal(first.up.posts.filter((p) => p.path.endsWith("/prompt_async")).length, 1);
  first.hub.stop();
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.entries[S].replays, 1, "the counter is on disk");
  assert.equal(saved.entries[S].messageID, "u1");

  // «restart»: a new hub, same file; the boot seed finds the same tail
  const second = await hubWith(opts, { messagesById: stuckTail(S), sessionList });
  await second.hub.syncDirectories();
  assert.equal(second.hub.pendingSnapshot()[S].replays, 1, "restored, not reset to 0");
  await sleep(250);
  assert.equal(second.up.posts.filter((p) => p.path.endsWith("/prompt_async")).length, 0, "the cap holds across the restart");

  // answered → the entry leaves the file
  second.hub.emit(asstMsg(S, "a9", "u1", { completed: Date.now() }), "C:\\Home");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).entries[S], undefined);
});

// ---- ADR-005: epoch -----------------------------------------------------------

test("ADR-005: ids are <epoch>.<seq>; own epoch replays, foreign/legacy/ahead ids resync", () => {
  const hub = new EventHub({ epoch: "bootb" });
  assert.equal(hub.epoch, "bootb");
  for (const n of [1, 2, 3]) hub.emit({ type: "test", properties: { n } });

  const live = fakeClient(hub);
  hub.emit({ type: "test", properties: { n: 4 } });
  assert.match(live.text(), /^retry: 3000\n\nid: bootb\.4\n/, "wire id carries the epoch");
  assert.equal(live.headers["x-zai-epoch"], "bootb");

  const own = fakeClient(hub, { lastEventId: "bootb.2" });
  assert.deepEqual(own.events().map((e) => e.properties.n), [3, 4], "own epoch → ring replay");

  for (const stale of ["boota.4211", "5000", "bootb.99", "garbage"]) {
    const c = fakeClient(hub, { lastEventId: stale });
    const ev = c.events();
    assert.deepEqual(ev, [{ type: "zai.resync", properties: {} }], `${stale} → exactly one resync`);
    assert.match(c.text(), /id: bootb\.4\n/, "the resync frame carries the current position");
  }
});

// ---- FEAT-07.15: dialogs wait for the human by default --------------------------

test("FEAT-07.15: by default the watchdog leaves a 31-min-old dialog alone — no reject, no abort, no banner (fake timers)", async () => {
  // mock only Date + setInterval: real setTimeout/sockets keep working
  const up = fakeUpstream();
  const base = await up.base;
  mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  let hub;
  const S = "ses_dlg2";
  try {
    // dialogTimeoutMs NOT passed: the default must be «wait for the human»
    hub = new EventHub({ stallAbortMs: 15 * 60_000, stallReplayMs: 3 * 60_000, stallTickMs: 60_000, unstickSettleMs: 0 });
    // Bare start (no pinned dir): no directory poll, so no real network I/O
    // runs under the mocked clock — only the watchdog interval matters here.
    hub.start(base); // intervals created under the mock
    hub.emit(status(S, "busy"), "C:\\Home");
    hub.emit(userMsg(S, "u_q"), "C:\\Home"); // a prompt queued behind the parked turn
    hub.emit({ type: "permission.asked", properties: { sessionID: S, id: "per_2", permission: "bash" } }, "C:\\Home");
    for (let i = 0; i < 31; i += 1) mock.timers.tick(60_000); // 31 watchdog ticks
    assert.equal(hub.stalledSnapshot()[S], undefined, "a dialog-parked turn is not «Ход завис»");
    const rep = hub.sessionsReport().find((r) => r.sessionID === S);
    assert.equal(rep.state, "dialog");
    assert.equal(rep.stalled, false, "parking on a dialog is not a stall");
  } finally {
    mock.timers.reset();
  }
  await sleep(100);
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  assert.equal(up.posts.length, 0, "no /permission/:id/reply, no abort");
  assert.equal(hub.dialogsSnapshot().length, 1, "the dialog is still open, waiting for the human");

  // control: the same scenario with the opt-in env knob does reject
  mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  let up2;
  let hub2;
  try {
    up2 = fakeUpstream();
    const base2 = await up2.base;
    hub2 = new EventHub({ dialogTimeoutMs: 10 * 60_000, stallTickMs: 60_000 });
    hub2.start(base2);
    hub2.emit({ type: "permission.asked", properties: { sessionID: "s", id: "per_3" } }, "C:\\Home");
    for (let i = 0; i < 11; i += 1) mock.timers.tick(60_000);
  } finally {
    mock.timers.reset();
  }
  await sleep(150);
  cleanups.push(async () => {
    hub2.stop();
    await up2.close();
  });
  assert.ok(up2.posts.some((p) => p.path === "/permission/per_3/reply"), "control: an explicit timeout still works");
});

// ---- BUG-07.7: loop detector ----------------------------------------------------

test("BUG-07.7: N identical tool calls in a row abort the turn and emit zai.loop", async () => {
  const { hub, up } = await hubWith({ loopAbortCount: 3 });
  const c = fakeClient(hub);
  const S = "ses_loop";
  const tool = (id, input, st = "completed") => ({
    type: "message.part.updated",
    properties: { sessionID: S, part: { id, messageID: "A1", type: "tool", tool: "bash", state: { status: st, input } } },
  });
  hub.emit(status(S, "busy"), "C:\\Home");
  hub.emit(tool("t1", { command: "echo hi" }, "running"), "C:\\Home");
  hub.emit(tool("t1", { command: "echo hi" }), "C:\\Home"); // same part: counted once
  hub.emit(tool("t2", { command: "ls" }), "C:\\Home"); // different call breaks the streak
  hub.emit(tool("t3", { command: "echo hi" }), "C:\\Home");
  hub.emit(tool("t4", { command: "echo hi" }), "C:\\Home");
  assert.equal(c.events().filter((e) => e.type === "zai.loop").length, 0, "2 in a row is not a loop yet");
  hub.emit(tool("t5", { command: "echo hi" }), "C:\\Home");
  const loop = c.events().find((e) => e.type === "zai.loop");
  assert.ok(loop, "the third identical call fires the detector");
  assert.equal(loop.properties.sessionID, S);
  assert.equal(loop.properties.tool, "bash");
  assert.equal(loop.properties.count, 3);
  await waitUntil(() => up.posts.some((p) => p.path === `/session/${S}/abort`));
  const abort = up.posts.find((p) => p.path === `/session/${S}/abort`);
  assert.ok(abort, "the looping turn is aborted");
  assert.equal(abort.dir, "C:\\Home");
});

// ---- BUG-07.8: stopped with open todos --------------------------------------------

test("BUG-07.8: a turn that ends with open todos emits zai.turn.incomplete after session.idle", () => {
  const hub = new EventHub();
  const c = fakeClient(hub);
  const S = "ses_todo";
  const todos = (list) => ({ type: "todo.updated", properties: { sessionID: S, todos: list } });
  hub.emit(status(S, "busy"));
  hub.emit(todos([{ id: "1", content: "a", status: "completed" }, { id: "2", content: "b", status: "in_progress" }, { id: "3", content: "c", status: "pending" }]));
  hub.emit(status(S, "idle"));
  hub.emit({ type: "session.idle", properties: { sessionID: S } });
  const types = c.events().map((e) => e.type);
  const inc = c.events().filter((e) => e.type === "zai.turn.incomplete");
  assert.equal(inc.length, 1, "once per turn, not per idle frame");
  assert.deepEqual(inc[0].properties, { sessionID: S, reason: "open-todos", todosOpen: 2, todosTotal: 3 });
  assert.deepEqual(types, ["session.status", "todo.updated", "session.status", "zai.turn.incomplete", "session.idle"], "emitted right after the idle that triggered it");

  // errored turn / all done / queued prompt → no mark
  hub.emit(status(S, "busy"));
  hub.emit({ type: "session.error", properties: { sessionID: S, error: { name: "X" } } });
  hub.emit(status(S, "busy"));
  hub.emit(todos([{ id: "1", status: "completed" }]));
  hub.emit({ type: "session.idle", properties: { sessionID: S } });
  assert.equal(c.events().filter((e) => e.type === "zai.turn.incomplete").length, 1, "error / completed todos → no extra mark");
});

// ---- BUG-12.17: SSE backpressure and per-key cap ---------------------------------

test("BUG-12.17: a client whose unsent buffer exceeds the cap is disconnected", () => {
  const hub = new EventHub({ maxClientBufferBytes: 1000 });
  const slow = fakeClient(hub);
  slow.write = (chunk) => {
    slow.writableLength += chunk.length; // never drains
    return false;
  };
  const ok = fakeClient(hub);
  for (let i = 0; i < 10; i += 1) hub.emit({ type: "big", properties: { pad: "x".repeat(200) } });
  assert.equal(slow.destroyed, true, "the stuck consumer is cut off");
  assert.equal(ok.destroyed, false);
  assert.equal(hub.clientCount(), 1);
});

test("BUG-12.17: per-key stream cap evicts the oldest; closeClients(key) closes a user's streams", () => {
  const hub = new EventHub({ maxStreamsPerKey: 2 });
  const a = fakeClient(hub, { key: "u1" });
  const b = fakeClient(hub, { key: "u1" });
  const other = fakeClient(hub, { key: "u2" });
  const c = fakeClient(hub, { key: "u1" });
  assert.equal(a.destroyed, true, "the oldest stream of u1 goes");
  assert.equal(b.destroyed || c.destroyed, false);
  assert.equal(hub.clientCount("u1"), 2);
  assert.equal(hub.closeClients("u1"), 2);
  assert.equal(hub.clientCount("u1"), 0);
  assert.equal(other.destroyed, false, "other users untouched");
});

// ---- BUG-07.10: prepareForPrompt -------------------------------------------------

test("BUG-07.10: prepareForPrompt aborts a busy-but-silent turn, spares live/dialog/managed ones", async () => {
  const { hub, up } = await hubWith({ promptUnstickMs: 300 });
  hub.emit(status("ses_hung", "busy"), "D:\\Proj");
  hub.emit(status("ses_dlg", "busy"), "C:\\Home");
  hub.emit({ type: "permission.asked", properties: { sessionID: "ses_dlg", id: "per_x" } }, "C:\\Home");
  hub.markManaged("ses_cl");
  hub.emit(status("ses_cl", "busy"));
  await sleep(350);
  hub.emit(status("ses_live", "busy"), "C:\\Home"); // fresh: still streaming
  assert.equal((await hub.prepareForPrompt("ses_live")).reason, "live", "checked first, well inside its window");

  assert.deepEqual(await hub.prepareForPrompt("ses_hung"), { aborted: true, reason: "silent" });
  assert.equal((await hub.prepareForPrompt("ses_dlg")).reason, "dialog");
  assert.equal((await hub.prepareForPrompt("ses_cl")).reason, "managed");
  assert.equal((await hub.prepareForPrompt("ses_idle")).reason, "idle");
  const aborts = up.posts.filter((p) => p.path.endsWith("/abort"));
  assert.deepEqual(aborts.map((p) => p.path), ["/session/ses_hung/abort"]);
  assert.equal(aborts[0].dir, "D:\\Proj", "abort reaches the session's own instance");
  assert.equal(hub.busySnapshot().ses_hung, undefined);
});

// ---- FEAT-07.16: sessions report ------------------------------------------------

test("FEAT-07.16: sessionsReport lists busy / dialog / pending sessions with ages, oldest first", async () => {
  const hub = new EventHub({ stallReplayMs: 60_000, stallAbortMs: 50 });
  hub.emit(status("s_busy", "busy"), "C:\\Home");
  await sleep(60);
  hub.emit({ type: "permission.asked", properties: { sessionID: "s_dlg", id: "p1" } }, "D:\\P");
  hub.emit(userMsg("s_pend", "u1"), "C:\\Home");
  const rep = hub.sessionsReport();
  assert.deepEqual(rep.map((r) => r.sessionID), ["s_busy", "s_dlg", "s_pend"]);
  const [busy, dlg, pend] = rep;
  assert.equal(busy.state, "busy");
  assert.ok(busy.ageMs >= 50 && busy.silentMs >= 50);
  assert.equal(busy.stalled, true, "silent past stallAbortMs");
  assert.equal(dlg.state, "dialog");
  assert.equal(dlg.dialogs, 1);
  assert.equal(dlg.dir, "D:\\P");
  assert.equal(pend.state, "pending");
  assert.deepEqual({ ...pend.pending, at: 0 }, { at: 0, replays: 0, max: 2, exhausted: false });
});

// ---- BUG-186 / BUG-07.23: busy-фантомы удалённых чатов -------------------------
// Чат, удалённый без доставленного хабу session.deleted (у папки пробы не было
// SSE-подписки), остаётся busy вечно. syncDirectories() каждый раз тянет ОБЩИЙ
// индекс /session — но отсутствие в нём не доказательство удаления (opencode
// 1.19.5: без directory там только проект global, ≤100 строк; чаты в
// git-папках живут в своих проектах и там не видны, даже живые). Кандидат
// (вне индекса, не managed, старше порога) проверяется точечно по своей папке
// GET /session/:id?directory=…: снимается ТОЛЬКО по 404; 200 сбрасывает часы,
// сеть/таймаут/5xx оставляют до следующего тика; проверки без dir не делаются.
// Управляемые (claude) чаты sweep не трогает вовсе.

test("BUG-186: busy-чат вне индекса и 404 на точечную проверку — снимается после порога; до порога — ещё busy", async () => {
  const S = "ses_phantom";
  const { hub, up } = await hubWith({ unindexedSweepMs: 150 }, { sessionList: [] }); // GET /session/<S> → 404
  hub.emit(status(S, "busy"), "C:\\Home");
  assert.ok(hub.busySnapshot()[S], "busy-запись посеяна");
  await hub.syncDirectories(); // первый sync без чата в индексе: часы только завелись
  assert.ok(hub.busySnapshot()[S], "до порога busy не снимается");
  await sleep(180);
  await hub.syncDirectories(); // за порогом: кандидат → проверка по папке → 404
  assert.ok(await waitUntil(() => hub.busySnapshot()[S] === undefined), "фантом вычищен по 404");
  assert.deepEqual(up.gets, [{ id: S, dir: "C:\\Home" }], "проверка была точечной, с папкой из busy-записи");
});

test("BUG-186: busy-чат вне ОБЩЕГО индекса, но жив (git-проект, 200) — не снимается и за порогом", async () => {
  const S = "ses_git";
  const { hub, up } = await hubWith({ unindexedSweepMs: 120 }, { sessionList: [], aliveIds: [S] });
  hub.emit(status(S, "busy"), "C:\\Proj");
  await hub.syncDirectories();
  await sleep(160);
  await hub.syncDirectories(); // кандидат → точечная проверка → 200: часы сброшены
  await hub.syncDirectories(); // часы снова завелись, порога нет
  assert.ok(await waitUntil(() => up.gets.some((g) => g.id === S && g.dir === "C:\\Proj")), "кандидат проверен точечно");
  assert.ok(hub.busySnapshot()[S], "живой ход в git-проекте не снимается: 200 — не удалён");
});

test("BUG-186: busy-запись без папки (dir=null) не проверяется и не снимается", async () => {
  const S = "ses_nodir";
  const { hub, up } = await hubWith({ unindexedSweepMs: 120 }, { sessionList: [] });
  hub.emit(status(S, "busy")); // dir не известен
  await hub.syncDirectories();
  await sleep(160);
  await hub.syncDirectories();
  await hub.syncDirectories();
  await sleep(100); // дать возможной fire-and-forget проверке отработать
  assert.ok(hub.busySnapshot()[S], "нет dir — запись не тронута");
  assert.equal(up.gets.some((g) => g.id === S), false, "точечный запрос без папки не делался");
});

test("BUG-186: ошибка сети при проверке кандидата — busy остаётся до следующего тика", async () => {
  const S = "ses_net";
  const { hub, up } = await hubWith({ unindexedSweepMs: 120 }, { sessionList: [], dropIds: [S] }); // соединение рвётся
  hub.emit(status(S, "busy"), "C:\\Home");
  await hub.syncDirectories();
  await sleep(160);
  await hub.syncDirectories(); // кандидат → проверка падает по сети
  await sleep(120);
  assert.ok(up.gets.some((g) => g.id === S), "попытка проверки была");
  assert.ok(hub.busySnapshot()[S], "сетевая ошибка не доказывает удаление — запись на месте");
});

test("BUG-186: чат, живой в индексе, не снимается; управляемый (claude) — тоже", async () => {
  const C = "ses_managed";
  const L = "ses_live";
  const { hub } = await hubWith({ unindexedSweepMs: 120 }, { sessionList: [{ id: L, directory: "C:\\Home", time: { updated: Date.now() } }] });
  hub.markManaged(C); // claude-чата в индексе upstream нет, но он жив
  hub.emit(status(L, "busy"), "C:\\Home");
  hub.emit(status(C, "busy"), "C:\\Home");
  await hub.syncDirectories();
  await sleep(160);
  await hub.syncDirectories();
  await hub.syncDirectories(); // заведомо за порогом
  assert.ok(hub.busySnapshot()[L], "есть в индексе — кандидат не назначается");
  assert.ok(hub.busySnapshot()[C], "claude (managed) не в индексе, но жив — не тронут");
});
