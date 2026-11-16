// FEAT-18.4 / FEAT-18.3: the Claude permission bridge («Спрашивать») on the
// fake CLI (tests/fixtures/claude-fake.mjs — never the real one): stream-json
// input, control_request can_use_tool → a portal permission dialog
// (permission.asked, the opencode shape), the answer → control_response;
// a stop denies every open request and frees the chat.
// Run: node --test --test-concurrency=1 tests/claude-permbridge.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const TMP = mkdtempSync(path.join(tmpdir(), "teleharness-permbridge-"));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n");
let seq = 0;
const freshStore = () => {
  const dir = path.join(TMP, `data-${++seq}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "claude-sessions.json");
};
const workDir = () => {
  const d = path.join(TMP, `work-${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
};
function stubHub() {
  const events = [];
  return { events, markManaged() {}, emit: (event, dir) => events.push({ event, dir }) };
}
const fakeRes = () => {
  const res = { code: 0 };
  res.writeHead = (c) => (res.code = c);
  res.end = () => {};
  return res;
};
const body = (text) => Buffer.from(JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, parts: [{ type: "text", text }] }));
async function waitFor(fn, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(30);
  }
  throw new Error(`timeout: ${what}`);
}
const ofType = (hub, t) => hub.events.filter((x) => x.event.type === t);

test("permissionArgs: modes per role — ask asks the host, tenant keeps --restricted, never bypass", async () => {
  const { permissionArgs } = await import("../lib/claude.js");
  const admin = (mode) => permissionArgs("admin", { addDirs: [], mode });
  assert.deepEqual(admin(null), ["--permission-mode", "bypassPermissions"]);
  assert.deepEqual(admin("full"), ["--permission-mode", "bypassPermissions"]);
  assert.deepEqual(admin("edits"), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(admin("ask"), ["--permission-mode", "default", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"]);
  const tAsk = permissionArgs("tenant", { mode: "ask" });
  for (const f of ["--restricted", "--strict-mcp-config", "default", "host", "stdio"]) assert.ok(tAsk.includes(f), f);
  // a tenant never gets more than acceptEdits, whatever the mode says
  for (const m of [null, "edits", "full"]) {
    const t = permissionArgs("tenant", { mode: m });
    assert.equal(t[t.indexOf("--permission-mode") + 1], "acceptEdits", String(m));
    assert.ok(t.includes("--restricted"));
    assert.equal(t.includes("bypassPermissions"), false);
  }
});

test("askSummary: command, file, description, else JSON", async () => {
  const { askSummary } = await import("../lib/claude.js");
  assert.equal(askSummary("Bash", { command: "rm x" }), "rm x");
  assert.equal(askSummary("Write", { file_path: "C:\\a\\b.txt", content: "z" }), "C:\\a\\b.txt");
  assert.equal(askSummary("X", {}, "описание"), "описание");
  assert.equal(askSummary("X", { a: 1 }), '{"a":1}');
});

test("bridge: ask mode argv — stream-json input, host prompts; edits mode — stream-json input (BUG-237) without host prompts", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, addDirs: [] });
  await runner.dispatch({ res: fakeRes(), sid: "a1", dir: workDir(), body: body("ECHO"), access: "admin", permMode: "ask" });
  await waitFor(() => ofType(hub, "session.idle").length >= 1, "idle 1");
  const a = JSON.parse(textOf(runner.messages("a1")[1]));
  assert.equal(a.prompt, "ECHO", "the prompt arrives as the stream-json user message");
  assert.equal(a.argv[a.argv.indexOf("--input-format") + 1], "stream-json");
  assert.equal(a.argv[a.argv.indexOf("--permission-mode") + 1], "default");
  assert.equal(a.argv[a.argv.indexOf("--permission-prompt-tool") + 1], "stdio");
  await runner.dispatch({ res: fakeRes(), sid: "a2", dir: workDir(), body: body("ECHO"), access: "admin", permMode: "edits" });
  await waitFor(() => ofType(hub, "session.idle").length >= 2, "idle 2");
  const e = JSON.parse(textOf(runner.messages("a2")[1]));
  assert.equal(e.argv[e.argv.indexOf("--input-format") + 1], "stream-json", "BUG-237: every Claude turn reads stream-json");
  assert.equal(e.argv[e.argv.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(e.argv.includes("--permission-prompt-tool"), false);
});

test("bridge: allow — dialog in the opencode shape, the file is written, the turn goes on", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const dir = workDir();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, addDirs: [] });
  await runner.dispatch({ res: fakeRes(), sid: "b1", dir, body: body("ASKWRITE note.txt hello"), access: "admin", permMode: "ask" });
  const asked = await waitFor(() => ofType(hub, "permission.asked")[0], "permission.asked");
  const p = asked.event.properties;
  assert.equal(p.sessionID, "b1");
  assert.equal(p.permission, "Write");
  assert.ok(p.metadata.command.endsWith("note.txt"), "the card shows the file");
  assert.equal(asked.dir, dir);
  // the REST face (GET /teleharness/api/dialogs) and the chat stays busy while it waits
  assert.equal(runner.dialogs().length, 1);
  assert.equal(runner.dialogs()[0].kind, "permission");
  assert.equal(runner.dialogs()[0].directory, dir);
  assert.deepEqual(runner.dialogOf(p.id), { id: p.id, sessionID: "b1", dir, tool: "Write" });
  assert.ok(runner.busySnapshot().b1);
  assert.equal(existsSync(path.join(dir, "note.txt")), false, "nothing written before the answer");
  assert.equal(runner.replyDialog(p.id, { reply: "once" }), true);
  assert.equal(runner.replyDialog(p.id, { reply: "once" }), false, "answered once");
  await waitFor(() => ofType(hub, "session.idle").length >= 1, "idle");
  assert.equal(readFileSync(path.join(dir, "note.txt"), "utf8"), "hello");
  assert.equal(textOf(runner.messages("b1")[1]), "Файл note.txt записан.");
  const replied = ofType(hub, "permission.replied");
  assert.equal(replied.length, 1);
  assert.equal(replied[0].event.properties.id, p.id);
  assert.equal(replied[0].event.properties.reply, "once");
  assert.deepEqual(runner.dialogs(), []);
  await waitFor(() => Object.keys(runner.liveness()).length === 0 && !runner.busySnapshot().b1, "process gone");
});

test("bridge: deny — the tool does not run, the agent gets the reason", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const dir = workDir();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, addDirs: [] });
  await runner.dispatch({ res: fakeRes(), sid: "c1", dir, body: body("ASKWRITE secret.txt x ASKTWICE"), access: "tenant", permMode: "ask" });
  const first = await waitFor(() => ofType(hub, "permission.asked")[0], "first ask");
  assert.equal(runner.replyDialog(first.event.properties.id, { reply: "reject", message: "не надо" }), true);
  const second = await waitFor(() => ofType(hub, "permission.asked")[1], "second ask");
  assert.notEqual(second.event.properties.id, first.event.properties.id);
  assert.equal(runner.replyDialog(second.event.properties.id, { reply: "reject" }), true);
  await waitFor(() => ofType(hub, "session.idle").length >= 1, "idle");
  assert.equal(existsSync(path.join(dir, "secret.txt")), false);
  const answer = textOf(runner.messages("c1")[1]);
  assert.ok(answer.includes("Отказано: не надо"), answer);
  assert.ok(answer.includes("Отказано: Пользователь запретил"), "a reject without a reason gets the default text");
});

test("bridge: a stop with an open request — deny, dialog closed, CLI gone, chat not busy", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const dir = workDir();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, addDirs: [] });
  await runner.dispatch({ res: fakeRes(), sid: "d1", dir, body: body("ASKWRITE stop.txt x"), access: "admin", permMode: "ask" });
  const asked = await waitFor(() => ofType(hub, "permission.asked")[0], "ask");
  assert.equal(runner.abort("d1"), true);
  const replied = ofType(hub, "permission.replied");
  assert.equal(replied.length, 1, "the open request is closed at once");
  assert.equal(replied[0].event.properties.id, asked.event.properties.id);
  assert.equal(replied[0].event.properties.reply, "reject");
  await waitFor(() => ofType(hub, "session.idle").length >= 1, "idle");
  assert.deepEqual(runner.dialogs(), []);
  assert.equal(runner.busySnapshot().d1, undefined);
  assert.deepEqual(runner.liveness(), {});
  const m = runner.messages("d1")[1];
  assert.equal(m.info.teleharness.interrupted, "user");
  assert.equal(existsSync(path.join(dir, "stop.txt")), false);
  assert.equal(runner.replyDialog(asked.event.properties.id, { reply: "once" }), false);
});
