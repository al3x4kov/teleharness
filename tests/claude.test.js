// Claude runner tests: unit coverage for the pure helpers, runner-level
// turns against a fake CLI (tests/fixtures/claude-fake.mjs), and the event
// contract the frontend consumes. The server-level integration (prompt
// routing, /message merge, /provider injection) rides tests/server.test.js
// conventions - spawned server.js against a fake upstream.
// Run: node --test tests/claude.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// FEAT-13.19: a Claude answer is several parts (steps, tools, text) — its text is every text part.
const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n");

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const TMP = mkdtempSync(path.join(tmpdir(), "zai-claude-test-"));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let storeSeq = 0;
// Every runner gets its own data dir: runs/catalog files live next to the store.
const freshStore = () => {
  const dir = path.join(TMP, `data-${++storeSeq}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "claude-sessions.json");
};

// --- unit: providerPatch -----------------------------------------------------

test("providerPatch injects anthropic into connected+all, idempotently", async () => {
  const { providerPatch } = await import("../lib/claude.js");
  const upstream = {
    connected: ["zai"],
    all: [{ id: "zai", models: { glm: { id: "glm", name: "GLM", status: "active" } } }],
    default: { zai: "glm" },
  };
  const patched = providerPatch(upstream);
  assert.ok(patched.connected.includes("anthropic"));
  assert.equal(patched.all.filter((p) => p.id === "anthropic").length, 1);
  const haiku = patched.all.find((p) => p.id === "anthropic").models["claude-haiku-4-5"];
  assert.equal(haiku.providerID, "anthropic");
  assert.equal(haiku.status, "active");
  assert.equal(haiku.capabilities.input.image, true);
  assert.equal(patched.default.anthropic, "claude-opus-5-5");
  // idempotent: a second patch does not duplicate the provider entry
  const twice = providerPatch(patched);
  assert.equal(twice.all.filter((p) => p.id === "anthropic").length, 1);
  // upstream object untouched
  assert.deepEqual(upstream.connected, ["zai"]);
  // tolerant of junk
  assert.ok(providerPatch(null).connected.includes("anthropic"));
  // a custom catalog without the built-in default → its first model
  const custom = providerPatch({}, [{ id: "claude-new-9", name: "New", context: 1 }]);
  assert.deepEqual(Object.keys(custom.all[0].models), ["claude-new-9"]);
  assert.equal(custom.default.anthropic, "claude-new-9");
});

// --- unit: buildPrompt -------------------------------------------------------

test("buildTurn joins text parts, materializes images and stores refs, not data URLs", async () => {
  const { buildPrompt, buildTurn } = await import("../lib/claude.js");
  const dir = path.join(TMP, "prompt-home");
  const png = "data:image/png;base64," + Buffer.from("pngbytes").toString("base64");
  const parts = [
    { type: "text", text: "вопрос" },
    { type: "file", mime: "image/png", filename: "shot.png", url: png },
    { type: "text", text: "смотри скрин" },
  ];
  const { prompt, stored } = buildTurn(parts, dir);
  assert.ok(prompt.startsWith("вопрос"));
  assert.ok(prompt.includes(".zai-uploads/shot.png"));
  assert.ok(prompt.includes("смотри скрин"));
  assert.equal(readFileSync(path.join(dir, ".zai-uploads", "shot.png"), "utf8"), "pngbytes");
  // BUG-13.6: history keeps a reference, never the base64 payload
  assert.equal(stored.length, 3);
  assert.equal(JSON.stringify(stored).includes("data:"), false);
  assert.equal(stored[1].type, "text");
  assert.ok(stored[1].text.includes(".zai-uploads/shot"));
  assert.ok(buildPrompt([{ type: "text", text: "x" }], dir) === "x");
});

// --- unit: translateLine ---------------------------------------------------------

test("translateLine maps stream-json shapes and drops junk", async () => {
  const { translateLine } = await import("../lib/claude.js");
  assert.deepEqual(translateLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}'), {
    kind: "delta",
    text: "hi",
  });
  assert.deepEqual(translateLine('{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}'), { kind: "message_start", messageId: "m1" });
  assert.deepEqual(translateLine('{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash"}}}'), { kind: "tool", name: "Bash" });
  assert.deepEqual(translateLine('{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"done"},{"type":"tool_use","name":"Read"}]}}'), {
    kind: "assistant",
    messageId: "m1",
    text: "done",
    tools: ["Read"],
  });
  // subagent text never becomes answer text
  assert.equal(translateLine('{"type":"assistant","parent_tool_use_id":"t","message":{"content":[{"type":"text","text":"sub"}]}}'), null);
  assert.equal(translateLine('{"type":"stream_event","parent_tool_use_id":"t","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"sub"}}}'), null);
  assert.deepEqual(translateLine('{"type":"system","subtype":"init","session_id":"abc"}'), { kind: "init", claudeSid: "abc" });
  const res = translateLine('{"type":"result","session_id":"s1","is_error":false,"result":"done"}');
  assert.equal(res.kind, "result");
  assert.equal(res.claudeSid, "s1");
  assert.equal(translateLine("not-json"), null);
});

// AnswerText (BUG-13.8) → tests/claude-transcript.test.js «text without block events» (FEAT-13.19).

// --- unit: env / permission profiles -------------------------------------------

test("childEnv: allow-list only, ZAI_* secrets never pass, owner CLAUDE_* auth does", async () => {
  const { childEnv } = await import("../lib/claude.js");
  const env = childEnv({
    PATH: "C:\\bin",
    Path: "x",
    SystemRoot: "C:\\Windows",
    APPDATA: "a",
    USERPROFILE: "u",
    ZAI_ADMIN_TOKEN: "secret",
    zai_lower: "secret",
    ZAI_CLAUDE_BIN: "x",
    CLAUDE_CODE_OAUTH_TOKEN: "owner",
    ANTHROPIC_BASE_URL: "b",
    QBIT_PASSWORD: "p",
    RANDOM_THING: "r",
  });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_BASE_URL", "APPDATA", "CLAUDE_CODE_OAUTH_TOKEN", "PATH", "Path", "SystemRoot", "USERPROFILE"].sort());
  // explicit token fills in only when the env lacks one
  assert.equal(childEnv({}, { token: "t" }).CLAUDE_CODE_OAUTH_TOKEN, "t");
  assert.equal(childEnv({ CLAUDE_CODE_OAUTH_TOKEN: "env" }, { token: "t" }).CLAUDE_CODE_OAUTH_TOKEN, "env");
});

test("permissionArgs: admin bypass + portal dir, tenant restricted, unspecified legacy", async () => {
  const { permissionArgs } = await import("../lib/claude.js");
  assert.deepEqual(permissionArgs(undefined), []);
  const admin = permissionArgs("admin", { addDirs: ["D:\\Portal\\zai"], mcpConfig: "D:\\mcp.json" });
  assert.deepEqual(admin, ["--permission-mode", "bypassPermissions", "--add-dir", "D:\\Portal\\zai", "--mcp-config", "D:\\mcp.json"]);
  assert.deepEqual(permissionArgs("admin", { adminMode: "acceptEdits", addDirs: [] }), ["--permission-mode", "acceptEdits"]);
  const tenant = permissionArgs("tenant");
  // BUG-144: dontAsk denied Edit/Write even inside the chat folder; acceptEdits + --restricted
  // allow edits only in the working directory, settings/git/config writes still need a person (none here).
  for (const f of ["--restricted", "--strict-mcp-config", "acceptEdits", "--permission-prompts", "none"]) assert.ok(tenant.includes(f), f);
  assert.equal(tenant.includes("dontAsk"), false);
  assert.equal(tenant.includes("bypassPermissions"), false);
});

// --- runner-level: stub hub + fake CLI ---------------------------------------

function stubHub() {
  const events = [];
  const managed = new Set();
  return {
    events,
    managed,
    markManaged: (sid) => managed.add(sid),
    emit: (event, dir) => events.push({ event, dir }),
  };
}

const body = (text, modelID = "claude-haiku-4-5") =>
  Buffer.from(JSON.stringify({ model: { providerID: "anthropic", modelID }, parts: [{ type: "text", text }] }));

const fakeRes = () => {
  const res = { code: 0, ended: false, body: "" };
  res.writeHead = (code) => {
    res.code = code;
  };
  res.end = (b) => {
    res.ended = true;
    res.body = b ?? "";
  };
  return res;
};

async function waitIdle(hub, timeoutMs = 10_000, count = 1) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hub.events.filter((x) => x.event.type === "session.idle").length >= count) return;
    await sleep(50);
  }
  throw new Error("no session.idle within timeout; events: " + hub.events.map((x) => x.event.type).join(","));
}

const answerOf = (runner, sid, i = 1) => textOf(runner.messages(sid)[i]);

test("runner turn: 204, event sequence, store, resume on the next turn", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const storePath = freshStore();
  const runner = new ClaudeRunner({ hub, storePath, binPath: FIXTURE, keepaliveMs: 50 });

  const res1 = fakeRes();
  await runner.dispatch({ res: res1, sid: "s1", dir: TMP, body: body("hello") });
  assert.equal(res1.code, 204);
  await waitIdle(hub);

  const types = hub.events.map((x) => x.event.type);
  assert.equal(types[0], "session.status"); // busy first
  assert.ok(types.includes("message.updated")); // user turn
  assert.ok(types.filter((t) => t === "message.part.delta").length >= 2);
  assert.ok(types.includes("message.part.updated")); // final wholesale text
  assert.ok(hub.managed.has("s1"));
  assert.equal(hub.events.at(-1).event.type, "session.idle");
  // ISSUE-003: the answer opens (no completed) right at turn start, tied to
  // its question, and closes with the final update.
  const asstUpdates = hub.events.filter((x) => x.event.type === "message.updated" && x.event.properties.info?.role === "assistant");
  assert.ok(asstUpdates.length >= 2, "open + final assistant updates");
  const opened = asstUpdates[0].event.properties.info;
  assert.ok(opened.parentID, "the open answer carries its question id");
  assert.equal(opened.time.completed, undefined);
  const asst = asstUpdates.at(-1);
  assert.equal(asst.event.properties.info.id, opened.id, "same answer id from open to close");
  assert.equal(asst.event.properties.info.providerID, "anthropic");
  assert.equal(asst.event.properties.info.modelID, "claude-haiku-4-5");
  assert.ok(asst.event.properties.info.time.completed > 0);

  const msgs = runner.messages("s1");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].info.role, "user");
  assert.equal(msgs[1].info.role, "assistant");
  assert.equal(textOf(msgs[1]), "Привет, мир!");
  assert.equal(msgs[1].info.zai, undefined, "a clean turn carries no interruption flag");

  // persisted: a NEW runner instance over the same file sees the history
  runner.flushNow(); // TASK-13.27: the store write is deferred — land it before re-reading the file
  const runner2 = new ClaudeRunner({ hub: stubHub(), storePath, binPath: FIXTURE, keepaliveMs: 50 });
  assert.equal(runner2.messages("s1").length, 2);
  assert.ok(runner2.has("s1"));

  // second turn resumes: the fixture marks resumed text
  const res2 = fakeRes();
  await runner.dispatch({ res: res2, sid: "s1", dir: TMP, body: body("ещё") });
  assert.equal(res2.code, 204);
  await waitIdle(hub, 10_000, 2);
  const msgs2 = runner.messages("s1");
  assert.equal(msgs2.length, 4);
  assert.equal(textOf(msgs2[3]), "Привет, мир! (resumed)", "fixture must see --resume");
  // the store file is replaced atomically: no tmp leftovers
  assert.equal(readdirSync(path.dirname(storePath)).some((n) => n.endsWith(".tmp")), false);
});

// BUG-13.2: the prompt rides stdin as UTF-8 — Cyrillic/emoji intact, a
// leading "-" is text (not a CLI flag), 100K chars pass, no ZAI_* in env.
test("runner: prompt via stdin — UTF-8, option-looking text, 100K chars, clean env", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const env = { ...process.env, ZAI_ADMIN_TOKEN: "top-secret", ZAI_ANYTHING: "x" };
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, env });

  const prompt = "--version ECHO Привет, мир 🙂 - пункт";
  await runner.dispatch({ res: fakeRes(), sid: "e1", dir: TMP, body: body(prompt) });
  await waitIdle(hub);
  const echo = JSON.parse(answerOf(runner, "e1"));
  assert.equal(echo.prompt, prompt, "the prompt arrives byte-exact as text");
  assert.equal(echo.argv.includes(prompt), false, "the prompt is not on argv");
  assert.ok(echo.argv.includes("--input-format"));
  assert.equal(echo.envKeys.some((k) => /^zai_/i.test(k)), false, "no ZAI_* secrets in the child env: " + echo.envKeys.join(","));
  assert.ok(echo.envKeys.some((k) => k.toUpperCase() === "PATH"));

  const big = "ECHO " + "я".repeat(100_000);
  await runner.dispatch({ res: fakeRes(), sid: "e2", dir: TMP, body: body(big) });
  await waitIdle(hub, 15_000, 2);
  assert.equal(JSON.parse(answerOf(runner, "e2")).prompt.length, big.length, "100K prompt passes (no argv limit)");
});

test("runner: access profile reaches the CLI flags (FEAT-13.9)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, addDirs: ["D:\\Portal\\zai"] });
  await runner.dispatch({ res: fakeRes(), sid: "p1", dir: TMP, body: body("ECHO"), access: "admin" });
  await waitIdle(hub);
  const a = JSON.parse(answerOf(runner, "p1")).argv;
  assert.equal(a[a.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(a[a.indexOf("--add-dir") + 1], "D:\\Portal\\zai");
  await runner.dispatch({ res: fakeRes(), sid: "p2", dir: TMP, body: body("ECHO"), access: "tenant" });
  await waitIdle(hub, 10_000, 2);
  const t = JSON.parse(answerOf(runner, "p2")).argv;
  assert.ok(t.includes("--restricted"));
  assert.equal(t[t.indexOf("--permission-mode") + 1], "acceptEdits"); // BUG-144
  assert.equal(t.includes("--add-dir"), false);
});

// FEAT-13.11 + FEAT-01.32: the first turn of a Claude chat carries the
// knowledge-base snapshot to the CLI; the stored user text stays the typed
// text, the snapshot rides as metadata.kbContext; later turns get none.
test("runner: kb snapshot — first turn only, CLI sees it, history keeps the clean text (FEAT-13.11, FEAT-01.32)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const calls = [];
  const kbSnapshot = ({ dir, sid, zone }) => {
    calls.push({ dir, sid, zone });
    return "[obsidian-cache] Активный кэш проекта «x».\n\nПравила кэша: D:\\vault\\_index.md.";
  };
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, kbSnapshot });
  const zone = { tenant: null, root: "D:/vault", home: null };
  await runner.dispatch({ res: fakeRes(), sid: "k1", dir: TMP, body: body("ECHO Привет"), access: "admin", kbZone: zone });
  await waitIdle(hub);
  const echo = JSON.parse(answerOf(runner, "k1"));
  assert.match(echo.prompt, /^\[obsidian-cache\] Активный кэш[\s\S]*\n\n---\n\nECHO Привет$/, "the CLI gets snapshot + separator + typed text");
  const user = runner.messages("k1")[0];
  assert.equal(textOf(user), "ECHO Привет", "history keeps only the typed text");
  assert.match(user.parts[0].metadata.kbContext, /^\[obsidian-cache\]/);
  assert.equal(runner.firstUserText("k1"), "ECHO Привет", "the auto title reads the clean text");
  assert.deepEqual(calls, [{ dir: TMP, sid: "k1", zone }]);

  await runner.dispatch({ res: fakeRes(), sid: "k1", dir: TMP, body: body("ECHO второй"), access: "admin", kbZone: zone });
  await waitIdle(hub, 10_000, 2);
  assert.equal(JSON.parse(answerOf(runner, "k1", 3)).prompt, "ECHO второй", "no snapshot on later turns");
  assert.equal(calls.length, 1);

  // no zone root (tenant without a vault) / provider throws → plain prompt
  const h2 = stubHub();
  const r2 = new ClaudeRunner({ hub: h2, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, kbSnapshot: () => { throw new Error("vault down"); }, log: () => {} });
  await r2.dispatch({ res: fakeRes(), sid: "k2", dir: TMP, body: body("ECHO x"), access: "admin", kbZone: zone });
  await waitIdle(h2);
  assert.equal(JSON.parse(answerOf(r2, "k2")).prompt, "ECHO x", "a broken vault never breaks the chat");
  assert.equal(r2.messages("k2")[0].parts[0].metadata, undefined);
});

test("checkMcpConfig: valid file → servers; missing / no mcpServers → ignored with a reason (FEAT-13.10)", async () => {
  const { checkMcpConfig } = await import("../lib/claude.js");
  assert.deepEqual(checkMcpConfig(null), { file: null, error: null });
  const ok = path.join(TMP, "mcp-ok.json");
  writeFileSync(ok, JSON.stringify({ mcpServers: { playwright: { command: "cmd", args: ["/c", "npx", "-y", "@playwright/mcp@0.0.84", "--isolated"] } } }));
  assert.deepEqual(checkMcpConfig(ok), { file: ok, servers: ["playwright"], error: null });
  assert.match(checkMcpConfig(path.join(TMP, "nope.json")).error, /file not found/);
  const empty = path.join(TMP, "mcp-empty.json");
  writeFileSync(empty, "{}");
  assert.equal(checkMcpConfig(empty).file, null);
  // the shipped sample is valid
  const sample = path.join(ROOT, "ops", "claude", "mcp-playwright.json");
  assert.deepEqual(checkMcpConfig(sample).servers, ["playwright"]);
});

test("runner: --mcp-config reaches admin turns only; tenants stay --strict-mcp-config (FEAT-13.10)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, mcpConfig: "D:\\mcp.json" });
  await runner.dispatch({ res: fakeRes(), sid: "q1", dir: TMP, body: body("ECHO"), access: "admin" });
  await waitIdle(hub);
  const a = JSON.parse(answerOf(runner, "q1")).argv;
  assert.equal(a[a.indexOf("--mcp-config") + 1], "D:\\mcp.json");
  await runner.dispatch({ res: fakeRes(), sid: "q2", dir: TMP, body: body("ECHO"), access: "tenant" });
  await waitIdle(hub, 10_000, 2);
  const t = JSON.parse(answerOf(runner, "q2")).argv;
  assert.equal(t.includes("--mcp-config"), false);
  assert.ok(t.includes("--strict-mcp-config"));
});

test("runner: unknown model → 400, nothing stored or spawned (ADR-004 §4)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE });
  const res = fakeRes();
  await runner.dispatch({ res, sid: "m1", dir: TMP, body: body("hi", "--version") });
  assert.equal(res.code, 400);
  assert.equal(runner.messages("m1"), null);
  assert.equal(hub.events.length, 0);
});

test("runner: catalog override from claude-models.json (FEAT-11.10)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const storePath = freshStore();
  writeFileSync(path.join(path.dirname(storePath), "claude-models.json"), JSON.stringify([{ id: "claude-opus-9", name: "Claude Opus 9" }]));
  const runner = new ClaudeRunner({ hub: stubHub(), storePath, binPath: FIXTURE });
  assert.deepEqual(runner.models().map((m) => m.id), ["claude-opus-9"]);
  const res = fakeRes();
  await runner.dispatch({ res, sid: "c1", dir: TMP, body: body("hi", "claude-haiku-4-5") });
  assert.equal(res.code, 400, "models outside the active catalog are refused");
});

test("runner: multi-step answer keeps every step, live and stored (BUG-13.8)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000 });
  await runner.dispatch({ res: fakeRes(), sid: "ms", dir: TMP, body: body("MULTI") });
  await waitIdle(hub);
  const text = answerOf(runner, "ms");
  assert.equal(text, "Сначала читаю файл.\n\nГотово: в файле 3 строки.");
  assert.equal(text.includes("SUBAGENT"), false);
  // FEAT-13.19: each step keeps its own parts, in order; the tool call
  // between the steps is a card of its own.
  const stored = runner.messages("ms")[1].parts;
  assert.deepEqual(stored.map((p) => p.type), ["step-start", "text", "tool", "step-start", "text"]);
  assert.equal(stored[2].tool, "read");
  assert.equal(stored[2].state.status, "completed");
  // what the client built from the live frames equals what is stored
  assert.deepEqual(liveParts(hub, runner.messages("ms")[1].info.id), stored);
  const keep = hub.events.filter((x) => x.event.type === "zai.keepalive");
  assert.ok(keep.some((x) => x.event.properties.lastAction === "Read"), "tool start is announced as the last action");
});

// Parts of one answer as the client builds them from SSE frames
// (upsertPart / applyDelta / removed).
function liveParts(hub, messageID) {
  const parts = [];
  for (const { event: e } of hub.events) {
    const p = e.properties ?? {};
    if (e.type === "message.part.updated" && p.part?.messageID === messageID) {
      const i = parts.findIndex((x) => x.id === p.part.id);
      if (i < 0) parts.push(structuredClone(p.part));
      else parts[i] = { ...parts[i], ...structuredClone(p.part) };
    } else if (e.type === "message.part.delta" && p.messageID === messageID) {
      const part = parts.find((x) => x.id === p.partID);
      assert.ok(part, "a delta never precedes its part");
      part[p.field] = (part[p.field] ?? "") + p.delta;
    } else if (e.type === "message.part.removed" && p.messageID === messageID) {
      parts.splice(parts.findIndex((x) => x.id === p.partID), 1);
    }
  }
  return parts;
}

test("runner: a turn with thinking and a command streams and stores reasoning + tool parts (FEAT-13.19)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const storePath = freshStore();
  const runner = new ClaudeRunner({ hub, storePath, binPath: FIXTURE, keepaliveMs: 1000 });
  await runner.dispatch({ res: fakeRes(), sid: "tl", dir: TMP, body: body("TOOLS") });
  await waitIdle(hub);
  const answer = runner.messages("tl")[1];
  assert.deepEqual(answer.parts.map((p) => p.type), ["step-start", "reasoning", "tool", "step-start", "text"]);
  const [, reasoning, tool, , text] = answer.parts;
  assert.equal(reasoning.text, "Нужно выполнить команду.");
  assert.ok(reasoning.time.end >= reasoning.time.start);
  assert.equal(tool.tool, "bash", "PowerShell renders as a command card");
  assert.equal(tool.state.status, "completed");
  assert.equal(tool.state.input.command, "echo 42");
  assert.equal(tool.state.title, "Вывести 42");
  assert.equal(tool.state.output, "42");
  assert.equal(text.text, "Вывод: 42.");
  for (const p of answer.parts) {
    assert.equal(p.messageID, answer.info.id);
    assert.equal(p.sessionID, "tl");
  }
  // live = stored; the tool went running → completed on the wire
  assert.deepEqual(liveParts(hub, answer.info.id), answer.parts);
  const toolFrames = hub.events.filter((x) => x.event.type === "message.part.updated" && x.event.properties.part.id === tool.id);
  assert.deepEqual([...new Set(toolFrames.map((x) => x.event.properties.part.state.status))], ["pending", "running", "completed"]);
  // history after a restart (new runner over the same file): the same parts
  runner.flushNow(); // TASK-13.27: deferred write — land it before re-reading the file
  const again = new ClaudeRunner({ hub: stubHub(), storePath, binPath: FIXTURE });
  assert.deepEqual(again.messages("tl")[1].parts, answer.parts);
});

test("runner: concurrent prompt is QUEUED and runs next (BUG-13.7)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000 });
  const res1 = fakeRes();
  const res2 = fakeRes();
  await runner.dispatch({ res: res1, sid: "q", dir: TMP, body: body("WAIT first") });
  await runner.dispatch({ res: res2, sid: "q", dir: TMP, body: body("second") });
  assert.equal(res1.code, 204);
  assert.equal(res2.code, 204, "no 409: the follow-up is queued");
  assert.equal(runner.messages("q").length, 2, "both questions are in history right away");
  assert.equal(runner.liveness().q.queued, 1);
  await waitIdle(hub, 15_000);
  const msgs = runner.messages("q");
  assert.deepEqual(msgs.map((m) => m.info.role), ["user", "assistant", "user", "assistant"], "answers sit right after their questions");
  assert.equal(textOf(msgs[1]), "Привет, мир!");
  assert.equal(textOf(msgs[3]), "Привет, мир! (resumed)", "the queued turn resumes the conversation");
  assert.equal(hub.events.filter((x) => x.event.type === "session.idle").length, 1, "no idle between queued turns");
  assert.deepEqual(runner.liveness(), {});
});

test("runner: queue is bounded — overflow answers 409", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, maxQueue: 1 });
  await runner.dispatch({ res: fakeRes(), sid: "qf", dir: TMP, body: body("HANG") });
  const r2 = fakeRes();
  const r3 = fakeRes();
  await runner.dispatch({ res: r2, sid: "qf", dir: TMP, body: body("two") });
  await runner.dispatch({ res: r3, sid: "qf", dir: TMP, body: body("three") });
  assert.equal(r2.code, 204);
  assert.equal(r3.code, 409);
  assert.equal(runner.abort("qf"), true);
  await waitIdle(hub);
});

test("runner: abort marks the partial answer, cancels the queue, finalizes idle", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 50 });
  await runner.dispatch({ res: fakeRes(), sid: "s3", dir: TMP, body: body("HANG") });
  await runner.dispatch({ res: fakeRes(), sid: "s3", dir: TMP, body: body("queued one") });
  await sleep(400); // let the fixture hang
  assert.equal(runner.abort("s3"), true);
  await waitIdle(hub);
  const msgs = runner.messages("s3");
  assert.deepEqual(msgs.map((m) => m.info.role), ["user", "assistant", "user", "assistant"]);
  assert.ok(textOf(msgs[1]).includes("[Прервано]"));
  assert.equal(msgs[1].info.zai.interrupted, "user");
  assert.ok(msgs[1].info.time.completed > 0);
  assert.ok(textOf(msgs[3]).includes("[Отменено"));
  assert.equal(msgs[3].info.zai.interrupted, "cancelled");
  assert.equal(runner.abort("s3"), false); // slot freed after finalize
  assert.deepEqual(runner.liveness(), {});
});

test("runner: stop during a tool call → the card ends as error, «[Прервано]» is a trailing text part (FEAT-13.19 е)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 50 });
  await runner.dispatch({ res: fakeRes(), sid: "th", dir: TMP, body: body("TOOLHANG") });
  await sleep(400);
  assert.equal(runner.abort("th"), true);
  await waitIdle(hub);
  const answer = runner.messages("th")[1];
  assert.deepEqual(answer.parts.map((p) => p.type), ["step-start", "tool", "text"]);
  assert.equal(answer.parts[1].state.status, "error");
  assert.ok(answer.parts[1].state.time.end > 0);
  assert.equal(answer.parts[2].text, "[Прервано]");
  assert.deepEqual(liveParts(hub, answer.info.id), answer.parts);
});

test("runner: default has NO run timeout — a hung turn survives until abort", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 50 });
  await runner.dispatch({ res: fakeRes(), sid: "s5", dir: TMP, body: body("HANG") });
  await sleep(1500);
  assert.equal(hub.events.some((x) => x.event.type === "session.idle"), false, "a hung turn must stay busy without a timeout");
  // BUG-13.3: liveness is a dedicated event, not a fake busy frame
  const busy = hub.events.filter((x) => x.event.type === "session.status" && x.event.properties.status.type === "busy");
  assert.ok(busy.length <= 2, "keepalive no longer re-sends busy: " + busy.length);
  const keep = hub.events.filter((x) => x.event.type === "zai.keepalive");
  assert.ok(keep.length >= 5);
  const k = keep.at(-1).event.properties;
  assert.equal(k.sessionID, "s5");
  assert.ok(k.startedAt > 0 && k.lastOutputAt >= k.startedAt);
  assert.ok(Date.now() - k.lastOutputAt >= 900, "lastOutputAt is the last REAL output, not the keepalive time");
  assert.equal(runner.abort("s5"), true);
  await waitIdle(hub);
  const text = answerOf(runner, "s5");
  assert.ok(text.includes("[Прервано]"));
  assert.ok(!text.includes("по таймауту"));
});

test("runner: opt-in runTimeoutMs still kills a hung turn with the timeout mark", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, runTimeoutMs: 300, idleTimeoutMs: 0, keepaliveMs: 50 });
  await runner.dispatch({ res: fakeRes(), sid: "s6", dir: TMP, body: body("HANG") });
  await waitIdle(hub);
  assert.ok(answerOf(runner, "s6").includes("[Прервано по таймауту]"));
});

test("runner: idle timeout kills a SILENT turn, never a talking one (BUG-13.3)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, idleTimeoutMs: 400, keepaliveMs: 1000 });
  await runner.dispatch({ res: fakeRes(), sid: "i1", dir: TMP, body: body("HANG") });
  await waitIdle(hub);
  const m = runner.messages("i1")[1];
  assert.ok(textOf(m).includes("[Прервано по бездействию"), textOf(m));
  assert.equal(m.info.zai.interrupted, "idle");
  // ~1 s of output with 100 ms gaps: longer than the idle window, but alive.
  // BUG-222/QA-07: говорящая половина — на отдельном раннере с окном 1500 мс.
  // Под нагрузкой паузы фикстуры растягиваются, и окно 400 мс убивало
  // ГОВОРЯЩИЙ ход (флейк 2026-11-10). Смысл прежний: окно больше паузы между
  // кусками речи → говорящий ход не прерывается.
  const talkHub = stubHub();
  const talkRunner = new ClaudeRunner({ hub: talkHub, storePath: freshStore(), binPath: FIXTURE, idleTimeoutMs: 1500, keepaliveMs: 1000 });
  await talkRunner.dispatch({ res: fakeRes(), sid: "i2", dir: TMP, body: body("SLOW") });
  await waitIdle(talkHub, 10_000, 1); // один ход — один idle (в оригинале 2 = idle обеих половин на общем хабе)
  assert.equal(answerOf(talkRunner, "i2"), "0123456789");
});

test("runner: CLI failure surfaces as the assistant text", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 50 });
  await runner.dispatch({ res: fakeRes(), sid: "s4", dir: TMP, body: body("make it FAIL") });
  await waitIdle(hub);
  assert.equal(answerOf(runner, "s4"), "boom");
});

test("runner: spawn failure (missing binary) is an answer, not a hang", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: path.join(TMP, "no-such-claude.exe") });
  await runner.dispatch({ res: fakeRes(), sid: "sf", dir: TMP, body: body("hi") });
  await waitIdle(hub);
  assert.match(answerOf(runner, "sf"), /^Не удалось запустить claude CLI/);
});

// --- store durability (BUG-13.6) ------------------------------------------------

test("store: a corrupt claude-sessions.json is moved aside, never wiped", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const storePath = freshStore();
  writeFileSync(storePath, '{"version":1,"sessions":{"s":{"messages":[', "utf8");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath, binPath: FIXTURE, keepaliveMs: 1000 });
  const dir = path.dirname(storePath);
  const aside = readdirSync(dir).filter((n) => n.startsWith("claude-sessions.json.corrupt-"));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(path.join(dir, aside[0]), "utf8"), '{"version":1,"sessions":{"s":{"messages":[');
  await runner.dispatch({ res: fakeRes(), sid: "n", dir: TMP, body: body("hi") });
  await waitIdle(hub);
  runner.flushNow(); // TASK-13.27: deferred write — land it before reading the file
  assert.equal(JSON.parse(readFileSync(storePath, "utf8")).sessions.n.messages.length, 2);
  assert.equal(readFileSync(path.join(dir, aside[0]), "utf8").length > 0, true, "the quarantined copy survives later writes");
});

// --- restart recovery (BUG-13.5) ------------------------------------------------

test("restart: orphaned CLI run is killed, question answered, claude session kept", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const storePath = freshStore();
  const dir = path.dirname(storePath);
  // our OWN orphan: a hung fixture process, as a crashed portal leaves it
  const orphan = spawn(process.execPath, [FIXTURE, "-p", "--input-format", "text"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  orphan.stdin.end("HANG");
  const exited = new Promise((r) => orphan.once("exit", r));
  await sleep(300);
  const t0 = Date.now() - 60_000;
  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      sessions: {
        r1: { directory: TMP, claudeSid: "old-sid", messages: [{ info: { id: "u1", sessionID: "r1", role: "user", time: { created: t0 } }, parts: [{ type: "text", text: "долгая задача" }] }] },
        r2: {
          directory: TMP,
          claudeSid: null,
          messages: [
            { info: { id: "u2", sessionID: "r2", role: "user", time: { created: t0 } }, parts: [] },
            { info: { id: "a2", sessionID: "r2", role: "assistant", modelID: "claude-sonnet-5", time: { created: t0, completed: t0 } }, parts: [{ type: "text", text: "ok" }] },
          ],
        },
      },
    }),
  );
  writeFileSync(
    path.join(dir, "claude-runs.json"),
    JSON.stringify({ version: 1, runs: { r1: { pid: orphan.pid, image: "node", spawnedAt: Date.now() - 300, claudeSid: "live-sid", userMsgId: "u1", modelID: "claude-opus-5" } } }),
  );
  const logs = [];
  const runner = new ClaudeRunner({ hub: stubHub(), storePath, binPath: FIXTURE, log: (m) => logs.push(m) });
  const code = await Promise.race([exited.then(() => "exited"), sleep(5000).then(() => "alive")]);
  assert.equal(code, "exited", "the orphan must be killed");
  const msgs = runner.messages("r1");
  assert.equal(msgs.length, 2);
  assert.equal(textOf(msgs[1]), "[Прервано рестартом портала]");
  assert.equal(msgs[1].info.zai.interrupted, "restart");
  assert.equal(msgs[1].info.modelID, "claude-opus-5");
  assert.equal(runner.messages("r2").length, 2, "answered chats untouched");
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "claude-runs.json"), "utf8")).runs, {});
  assert.ok(logs.some((l) => l.includes("killed 1")));
  // the next prompt resumes the interrupted claude session (FEAT-13.12)
  runner.flushNow(); // TASK-13.27: recovery marks the store dirty — land it before r2 re-reads the file
  const hub = stubHub();
  const r2 = new ClaudeRunner({ hub, storePath, binPath: FIXTURE, keepaliveMs: 1000 });
  await r2.dispatch({ res: fakeRes(), sid: "r1", dir: TMP, body: body("ECHO продолжай") });
  await waitIdle(hub);
  const argv = JSON.parse(textOf(r2.messages("r1")[3])).argv;
  assert.equal(argv[argv.indexOf("--resume") + 1], "live-sid");
});

test("restart: a foreign process on a reused PID is never killed", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const storePath = freshStore();
  writeFileSync(path.join(path.dirname(storePath), "claude-runs.json"), JSON.stringify({ version: 1, runs: { x: { pid: 4242, image: "claude", spawnedAt: Date.now() } } }));
  const killed = [];
  const kill = (pid) => killed.push(pid) && true;
  new ClaudeRunner({ hub: stubHub(), storePath, procInspect: () => ({ name: "explorer", startMs: Date.now() }), procKill: kill, log: () => {} });
  assert.deepEqual(killed, [], "other image name");
  writeFileSync(path.join(path.dirname(storePath), "claude-runs.json"), JSON.stringify({ version: 1, runs: { x: { pid: 4242, image: "claude", spawnedAt: Date.now() - 3_600_000 } } }));
  new ClaudeRunner({ hub: stubHub(), storePath, procInspect: () => ({ name: "claude", startMs: Date.now() }), procKill: kill, log: () => {} });
  assert.deepEqual(killed, [], "same image, but started long after our spawn");
  writeFileSync(path.join(path.dirname(storePath), "claude-runs.json"), JSON.stringify({ version: 1, runs: { x: { pid: 4242, image: "claude", spawnedAt: Date.now() } } }));
  new ClaudeRunner({ hub: stubHub(), storePath, procInspect: () => ({ name: "claude", startMs: Date.now() }), procKill: kill, log: () => {} });
  assert.deepEqual(killed, [4242], "ours: killed");
});

test("live run is mirrored to claude-runs.json and removed when done", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const storePath = freshStore();
  const runsFile = path.join(path.dirname(storePath), "claude-runs.json");
  const runner = new ClaudeRunner({ hub, storePath, binPath: FIXTURE, keepaliveMs: 1000 });
  await runner.dispatch({ res: fakeRes(), sid: "lr", dir: TMP, body: body("HANG") });
  await sleep(500);
  const rec = JSON.parse(readFileSync(runsFile, "utf8")).runs.lr;
  assert.ok(rec.pid > 0);
  assert.equal(rec.image, "node");
  assert.ok(rec.claudeSid?.startsWith("fresh-"), "init session id is recorded for resume after a crash");
  runner.abort("lr");
  await waitIdle(hub);
  assert.deepEqual(JSON.parse(readFileSync(runsFile, "utf8")).runs, {});
  assert.ok(existsSync(storePath));
});

// --- hub integration: managed sessions are invisible to the watchdogs -------

test("hub: markManaged keeps pending/replay away from claude sessions", async () => {
  const { EventHub } = await import("../lib/hub.js");
  const hub = new EventHub({ ringSize: 100, stallReplayMs: 30, maxPromptReplays: 1 });
  hub.markManaged("ses_cla");
  hub.emit({ type: "session.status", properties: { sessionID: "ses_cla", status: { type: "busy" } } }, "D:\\x");
  hub.emit({ type: "message.updated", properties: { sessionID: "ses_cla", info: { id: "m1", role: "user", time: { created: Date.now() } } } }, "D:\\x");
  assert.deepEqual(hub.pendingSnapshot(), {}); // no pending entry for managed
  assert.ok(hub.busySnapshot().ses_cla > 0);
  await sleep(120); // past the replay window: the sweep must not act
  hub.emit({ type: "session.idle", properties: { sessionID: "ses_cla" } }, "D:\\x");
  assert.deepEqual(hub.stalledSnapshot(), {});
  // the wire carries exactly what was injected (JSON round-trip)
  const res = { headersSent: false, writes: [], writeHead(code, h) { this.code = code; this.headers = h; }, end() {}, write(s) { this.writes.push(s); }, on() {}, destroy() {}, socket: { destroyed: false } };
  // wire ids carry the hub epoch since ADR-005 (`<epoch>.<seq>`)
  hub.handleClient({ url: "/", headers: { "last-event-id": hub.epoch ? `${hub.epoch}.0` : "0" } }, res);
  const data = res.writes.filter((s) => s.startsWith("id:")).join("");
  assert.ok(data.includes('"ses_cla"'));
  assert.ok(data.includes('"busy"'));
  hub.stop();
});

// --- BUG-13.16 / BUG-085: activity time of a claude chat ----------------------

test("BUG-13.16: a claude turn records activity (persisted) and announces session.updated at start and end", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const storePath = freshStore();
  const runner = new ClaudeRunner({ hub, storePath, binPath: FIXTURE, keepaliveMs: 1000 });
  assert.equal(runner.activityOf("s_act"), null, "unknown chat: no activity");
  const t0 = Date.now();
  await runner.dispatch({ res: fakeRes(), sid: "s_act", dir: TMP, body: body("hello") });
  await waitIdle(hub);
  const bumps = hub.events.filter((x) => x.event.type === "session.updated").map((x) => x.event.properties);
  assert.ok(bumps.length >= 2, "start and end of the turn");
  for (const b of bumps) {
    assert.equal(b.sessionID, "s_act");
    assert.equal(b.info.id, "s_act");
    assert.equal(b.info.directory, TMP);
    assert.ok(b.info.time.updated >= t0);
  }
  const asst = runner.messages("s_act").at(-1).info;
  assert.equal(bumps.at(-1).info.time.updated, asst.time.completed, "the end bump carries the answer time");
  const idleAt = hub.events.findIndex((x) => x.event.type === "session.idle");
  const lastBumpAt = hub.events.findLastIndex((x) => x.event.type === "session.updated");
  assert.ok(lastBumpAt < idleAt, "bumped before idle");
  assert.equal(runner.activityOf("s_act"), asst.time.completed);
  // Survives a restart: the time lives in the store file.
  runner.flushNow(); // TASK-13.27: deferred write — land it before reading the file
  const stored = JSON.parse(readFileSync(storePath, "utf8")).sessions.s_act;
  assert.equal(stored.updatedAt, asst.time.completed);
  const runner2 = new ClaudeRunner({ hub: stubHub(), storePath, binPath: FIXTURE });
  assert.equal(runner2.activityOf("s_act"), asst.time.completed);
});

test("BUG-13.16: an older store entry without updatedAt falls back to its newest message time", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const storePath = freshStore();
  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      sessions: {
        old: {
          directory: TMP,
          claudeSid: null,
          messages: [
            { info: { id: "u", role: "user", time: { created: 1000 } }, parts: [] },
            { info: { id: "a", role: "assistant", time: { created: 1100, completed: 4200 } }, parts: [] },
          ],
        },
      },
    }),
  );
  const runner = new ClaudeRunner({ hub: stubHub(), storePath, binPath: FIXTURE });
  assert.equal(runner.activityOf("old"), 4200);
});

// BUG-169: the tenant's own knowledge-base zone is readable by its Claude file
// tools (--add-dir <zone>) — the snapshot rules tell it to search there; the
// admin vault never; admin keeps its own add-dirs.
test("runner: tenant turn gets --add-dir of its OWN knowledge-base zone only (BUG-169)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000 });
  const zone = { tenant: "alice", root: path.join(TMP, "vault", "alice"), home: null };
  await runner.dispatch({ res: fakeRes(), sid: "z1", dir: TMP, body: body("ECHO"), access: "tenant", kbZone: zone });
  await waitIdle(hub);
  const a = JSON.parse(answerOf(runner, "z1")).argv;
  const dirs = a.flatMap((x, i) => (x === "--add-dir" ? [a[i + 1]] : []));
  assert.deepEqual(dirs, [path.resolve(TMP, "vault", "alice")]);
  // no zone (vault off / unsafe name) → no --add-dir
  await runner.dispatch({ res: fakeRes(), sid: "z2", dir: TMP, body: body("ECHO"), access: "tenant", kbZone: { tenant: "x", root: null } });
  await waitIdle(hub, 10_000, 2);
  const b = JSON.parse(answerOf(runner, "z2")).argv;
  assert.equal(b.includes("--add-dir"), false);
  // admin: the zone is NOT added (admin add-dirs come from its own profile)
  await runner.dispatch({ res: fakeRes(), sid: "z3", dir: TMP, body: body("ECHO"), access: "admin", kbZone: { tenant: null, root: "D:/Obsidian/agents" } });
  await waitIdle(hub, 10_000, 3);
  const c = JSON.parse(answerOf(runner, "z3")).argv;
  assert.equal(c.some((x) => /Obsidian[\\/]agents/.test(x)), false);
});

// FEAT-04.11: a tenant turn with its jail gets the kit — jailed Bash via the
// PreToolUse hook (not in --allowedTools), zai skills plugin, marketplace MCP.
test("runner: tenant kit — Bash only through the jail hook, skills, marketplace (FEAT-04.11)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const kit = { pluginDir: "D:/data/claude-tenant-plugin", mcpConfig: "D:/Portal/zai/ops/claude/tenant-mcp.json", promptFile: "D:/Portal/zai/ops/claude/tenant-prompt.md", jailExe: "D:/j/zai-jail.exe", sandboxPy: "D:/py", nodePath: "D:/nodejs/node.exe" };
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, tenantKit: kit });
  await runner.dispatch({ res: fakeRes(), sid: "k1", dir: TMP, body: body("ECHO"), access: "tenant", jail: { name: "zai-t-alice", home: TMP } });
  await waitIdle(hub);
  const a = JSON.parse(answerOf(runner, "k1")).argv;
  const val = (f) => a[a.indexOf(f) + 1];
  assert.ok(a.includes("--restricted"));
  assert.equal(val("--permission-mode"), "acceptEdits");
  assert.ok(val("--tools").split(",").includes("Bash"));
  // FEAT-04.12: WebFetch and Task are in the kit; WebFetch is approved ONLY by the
  // hook (public addresses), never by --allowedTools.
  assert.ok(val("--tools").split(",").includes("WebFetch") && val("--tools").split(",").includes("Task"));
  assert.equal(val("--allowedTools").split(",").includes("WebFetch"), false, "WebFetch is approved only by the hook (loopback refused)");
  assert.equal(val("--allowedTools").split(",").includes("Bash"), false, "Bash is approved only by the hook (fail-closed)");
  assert.equal(val("--disallowedTools"), "mcp__marketplace__compare_browser_snapshot");
  assert.equal(val("--mcp-config"), kit.mcpConfig);
  assert.equal(val("--plugin-dir"), kit.pluginDir);
  assert.equal(val("--append-system-prompt-file"), kit.promptFile);
  const settings = JSON.parse(val("--settings"));
  const bash = settings.hooks.PreToolUse.find((h) => h.matcher === "Bash|WebFetch");
  assert.ok(bash && /claude-jail-hook\.mjs/.test(bash.hooks[0].command) && /--name zai-t-alice/.test(bash.hooks[0].command));

  // no jail (chat outside the tenant home) → the file-only profile, no Bash at all
  await runner.dispatch({ res: fakeRes(), sid: "k2", dir: TMP, body: body("ECHO"), access: "tenant", jail: null });
  await waitIdle(hub, 10_000, 2);
  const b = JSON.parse(answerOf(runner, "k2")).argv;
  assert.equal(b.includes("--tools"), false);
  assert.equal(b.includes("--plugin-dir"), false);
  // admin never gets the tenant kit
  await runner.dispatch({ res: fakeRes(), sid: "k3", dir: TMP, body: body("ECHO"), access: "admin", jail: { name: "zai-t-alice", home: TMP } });
  await waitIdle(hub, 10_000, 3);
  assert.equal(JSON.parse(answerOf(runner, "k3")).argv.includes("--plugin-dir"), false);
});

test("BUG-164: history serves the running answer with its parts so far; none after the turn", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 50 });
  await runner.dispatch({ res: fakeRes(), sid: "lv", dir: TMP, body: body("TOOLHANG") });
  // wait for the streamed tool call (a fixed 400 ms raced the CLI start under load)
  let live = null;
  for (let i = 0; i < 100 && !live?.parts?.some((p) => p.type === "tool"); i++) {
    await sleep(50);
    live = runner.liveAnswer("lv");
  }
  assert.ok(live, "a running turn has a live answer");
  assert.equal(live.info.role, "assistant");
  assert.equal(live.info.time.completed, undefined);
  assert.ok(live.parts.some((p) => p.type === "tool"), "the tool call already streamed is in the snapshot");
  const merged = await runner.mergedMessages("lv", TMP, "http://127.0.0.1:9");
  assert.deepEqual(merged.map((m) => m.info.role), ["user", "assistant"], "question + open answer");
  assert.equal(merged[1].info.id, live.info.id, "same id as the live events");
  assert.equal(runner.abort("lv"), true);
  await waitIdle(hub);
  assert.equal(runner.liveAnswer("lv"), null);
  const after = await runner.mergedMessages("lv", TMP, "http://127.0.0.1:9");
  assert.equal(after.filter((m) => m.info.role === "assistant").length, 1, "the stored answer replaces the live one, no duplicate");
  assert.ok(after[1].info.time.completed > 0);
});

// FEAT-03.22: the user's own system prompt → ONE --append-system-prompt-file
// (tenant: kit prompt + the user's section; admin: the user's section only),
// never argv text; a chat with a user prompt (now or before) re-renders the
// system prompt on resume (--system-prompt-snapshot off).
test("runner: user system prompt — file, tenant kit merged, snapshot off on resume (FEAT-03.22)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const kitPrompt = path.join(TMP, "kit-prompt.md");
  writeFileSync(kitPrompt, "KIT RULES\n", "utf8");
  const kit = { pluginDir: "D:/data/p", mcpConfig: "D:/m.json", promptFile: kitPrompt, jailExe: "D:/j.exe", sandboxPy: "D:/py", nodePath: "D:/node.exe" };
  const hub = stubHub();
  const storePath = freshStore();
  const runner = new ClaudeRunner({ hub, storePath, binPath: FIXTURE, keepaliveMs: 1000, tenantKit: kit });
  const USER = "--evil-looking start: всегда отвечай по-русски";

  // tenant: kit + user prompt in one file; the text is not on argv
  await runner.dispatch({ res: fakeRes(), sid: "sp1", dir: TMP, body: body("ECHO"), access: "tenant", jail: { name: "zai-t-a", home: TMP }, systemPrompt: USER });
  await waitIdle(hub);
  let a = JSON.parse(answerOf(runner, "sp1")).argv;
  assert.equal(a.filter((x) => x === "--append-system-prompt-file").length, 1, "exactly one prompt file");
  const file = a[a.indexOf("--append-system-prompt-file") + 1];
  assert.notEqual(file, kitPrompt);
  const content = readFileSync(file, "utf8");
  assert.ok(content.startsWith("KIT RULES"), "the kit rules stay first");
  assert.ok(content.includes("# Инструкции пользователя") && content.includes(USER));
  assert.equal(a.some((x) => x.includes("всегда отвечай")), false, "no user text on argv (SEC-11)");
  assert.equal(path.resolve(path.dirname(file)), path.resolve(path.dirname(storePath), "claude-prompts"));
  assert.equal(a.includes("--system-prompt-snapshot"), false, "first turn: nothing to replay yet");

  // second turn in the same chat (resume) → snapshot off so a changed prompt applies
  await runner.dispatch({ res: fakeRes(), sid: "sp1", dir: TMP, body: body("ECHO"), access: "tenant", jail: { name: "zai-t-a", home: TMP }, systemPrompt: USER + " и кратко" });
  await waitIdle(hub, 10_000, 2);
  a = JSON.parse(answerOf(runner, "sp1", 3)).argv;
  assert.ok(a.includes("--resume"));
  assert.equal(a[a.indexOf("--system-prompt-snapshot") + 1], "off");
  assert.ok(readFileSync(a[a.indexOf("--append-system-prompt-file") + 1], "utf8").includes("и кратко"));

  // cleared prompt: the kit prompt again, still re-rendered (the old one must go)
  await runner.dispatch({ res: fakeRes(), sid: "sp1", dir: TMP, body: body("ECHO"), access: "tenant", jail: { name: "zai-t-a", home: TMP }, systemPrompt: "" });
  await waitIdle(hub, 10_000, 3);
  a = JSON.parse(answerOf(runner, "sp1", 5)).argv;
  assert.equal(a[a.indexOf("--append-system-prompt-file") + 1], kitPrompt);
  assert.equal(a[a.indexOf("--system-prompt-snapshot") + 1], "off");

  // admin: the user's section alone; no prompt → no flag at all
  await runner.dispatch({ res: fakeRes(), sid: "sp2", dir: TMP, body: body("ECHO"), access: "admin", systemPrompt: "ADMIN PROMPT" });
  await waitIdle(hub, 10_000, 4);
  a = JSON.parse(answerOf(runner, "sp2")).argv;
  const adminFile = readFileSync(a[a.indexOf("--append-system-prompt-file") + 1], "utf8");
  assert.ok(adminFile.startsWith("# Инструкции пользователя") && adminFile.includes("ADMIN PROMPT"));
  await runner.dispatch({ res: fakeRes(), sid: "sp3", dir: TMP, body: body("ECHO"), access: "admin" });
  await waitIdle(hub, 10_000, 5);
  assert.equal(JSON.parse(answerOf(runner, "sp3")).argv.includes("--append-system-prompt-file"), false);
});
