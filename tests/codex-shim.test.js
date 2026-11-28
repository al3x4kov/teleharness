// FEAT-18.7: lib/codex-shim.mjs — the claude-CLI-protocol face of `codex
// app-server`. Contract tests on the fake app-server
// (tests/fixtures/codex-appserver-fake.mjs, replays the recorded 0.169.0
// streams) — never the real codex. Plus one integration: a real ClaudeRunner
// with the shim as its binary.
// Run: node --test --test-concurrency=1 tests/codex-shim.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHIM = path.join(ROOT, "lib", "codex-shim.mjs");
const FAKE = path.join(ROOT, "tests", "fixtures", "codex-appserver-fake.mjs");
const WRAPPER = path.join(ROOT, "tests", "fixtures", "codex-shim-runner.mjs");
const TMP = mkdtempSync(path.join(tmpdir(), "teleharness-codex-shim-"));
after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); // уборка по возможности: на Windows папку может держать дочерний процесс (EBUSY)
  } catch {}
});

let seq = 0;
const workDir = () => {
  const d = path.join(TMP, `w-${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const BASE = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "gpt-6.1-sol", "--settings", '{"showThinkingSummaries":true}'];
const ASK = ["--permission-mode", "default", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs the shim; text mode: prompt on stdin then EOF; stream-json: the user
// line, stdin open; onControl(req) → {behavior} answers control_request.
function runShim({ args = [], prompt = "hi", stream = false, env = {}, onControl = null, closeAfterMs = null }) {
  const cwd = workDir();
  const logFile = path.join(cwd, "fake-log.jsonl");
  const argv = [SHIM, ...BASE, "--input-format", stream ? "stream-json" : "text", ...args];
  const child = spawn(process.execPath, argv, { cwd, env: { ...process.env, TELEHARNESS_CODEX_BIN: FAKE, CODEX_FAKE_LOG: logFile, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = [];
  let stderr = "";
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!l) continue;
      const evt = JSON.parse(l);
      lines.push(evt);
      if (evt.type === "control_request" && onControl) {
        const r = onControl(evt.request);
        const response = r.behavior === "allow" ? { subtype: "success", request_id: evt.request_id, response: { behavior: "allow", updatedInput: evt.request.input } } : { subtype: "success", request_id: evt.request_id, response: { behavior: "deny", message: "нет" } };
        child.stdin.write(JSON.stringify({ type: "control_response", response }) + "\n");
      }
      if (evt.type === "result" && stream) child.stdin.end(); // like the runner (#endInput)
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.on("error", () => {});
  if (stream) {
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
    if (closeAfterMs != null) setTimeout(() => child.stdin.end(), closeAfterMs);
  } else child.stdin.end(Buffer.from(prompt, "utf8"));
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const received = existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
      resolve({ code, lines, stderr, received, cwd, result: lines.find((e) => e.type === "result") ?? null });
    });
  });
}
const sentTo = (received, method) => received.filter((m) => m.method === method);
const answersTo = (received, id) => received.find((m) => m.id === id && m.method === undefined);

test("expected instructions hash accepts matching text and rejects changed catalog before native thread", async () => {
  const { parseArgs, codexPolicy, renderDeveloperInstructions } = await import("../lib/codex-shim.mjs");
  const file = path.join(TMP, "hash-handshake.json");
  writeFileSync(file, JSON.stringify({ workflow: { prompt: "ORIGINAL_ROLE" } }));
  const args = ["--agents", file, "--agent", "workflow"];
  const parsed = parseArgs([...BASE, ...args]);
  const expected = createHash("sha256").update(renderDeveloperInstructions(parsed, codexPolicy(parsed))).digest("hex");
  const matching = await runShim({ args: [...args, "--teleharness-instructions-hash", expected] });
  assert.equal(matching.result.is_error, false);
  writeFileSync(file, JSON.stringify({ workflow: { prompt: "CHANGED_ROLE" } }));
  const mismatch = await runShim({ args: [...args, "--teleharness-instructions-hash", expected] });
  assert.equal(mismatch.result.is_error, true);
  assert.match(mismatch.result.result, /instructions.*changed|инструкци.*измен/i);
  assert.ok(!JSON.stringify(mismatch.result).includes("CHANGED_ROLE"), "do not expose prompt text");
  assert.equal(sentTo(mismatch.received, "thread/start").length, 0);
  assert.equal(sentTo(mismatch.received, "turn/start").length, 0);
});

test("shim serializes native profile instructions; thread replacement belongs to runner", async () => {
  const file = path.join(TMP, "profiles.json");
  const portal = path.join(TMP, "portal.md");
  writeFileSync(file, JSON.stringify({ workflow: { prompt: "ROLE_WORKFLOW", model: "wrong-model" } }));
  writeFileSync(portal, "PORTAL_AND_USER");
  for (const [method, history] of [["thread/start", []], ["thread/resume", ["--resume", "old"]], ["thread/fork", ["--resume", "old", "--fork-session"]]]) {
    const r = await runShim({ args: [...history, "--agents", file, "--agent", "workflow", "--append-system-prompt-file", portal, ...ASK], stream: true });
    assert.equal(sentTo(r.received, "initialize")[0].params.capabilities?.experimentalApi, undefined);
    const p = sentTo(r.received, method)[0].params;
    assert.match(p.developerInstructions, /ROLE_WORKFLOW/);
    assert.match(p.developerInstructions, /PORTAL_AND_USER/);
    assert.match(p.developerInstructions, /Codex/);
    assert.equal(p.config, undefined);
    assert.equal(sentTo(r.received, "turn/start")[0].params.collaborationMode, undefined);
    assert.equal(p.model, "gpt-6.1-sol");
    assert.equal(p.approvalPolicy, "untrusted");
    assert.equal(p.sandbox, "workspace-write");
  }
  const cleared = await runShim({ args: ["--resume", "old"] });
  assert.equal(sentTo(cleared.received, "thread/resume")[0].params.developerInstructions, "");
  writeFileSync(file, JSON.stringify({ workflow: { prompt: "ROLE_CHANGED" } }));
  const changed = await runShim({ args: ["--resume", "old", "--agents", file, "--agent", "workflow"] });
  const update = sentTo(changed.received, "thread/resume")[0].params.developerInstructions;
  assert.match(update, /ROLE_CHANGED/);
  assert.ok(!update.includes("ROLE_WORKFLOW"));
});

test("Codex fails closed for unavailable, malformed and tool-restricted profiles", async () => {
  const file = path.join(TMP, "bad-profiles.json");
  for (const content of ["{", "{}", JSON.stringify({ workflow: { prompt: "ok", tools: ["Read"] } }), JSON.stringify({ workflow: { prompt: 123 } })]) {
    writeFileSync(file, content);
    const r = await runShim({ args: ["--agents", file, "--agent", "workflow"] });
    assert.equal(r.result?.is_error, true, content);
    assert.match(r.result.result, /profile|профил|tools/i);
    assert.equal(sentTo(r.received, "turn/start").length, 0);
  }
  const missing = await runShim({ args: ["--agents", `${file}.missing`, "--agent", "workflow"] });
  assert.equal(missing.result?.is_error, true);
});

test("turn uses the resolved server model; no model fails before the turn", async () => {
  const r = await runShim({ args: ["--model", ""], env: { CODEX_FAKE_MODEL: "resolved-model", CODEX_FAKE_EFFORT: "low" } });
  const t = sentTo(r.received, "turn/start")[0].params;
  assert.equal(t.model, "resolved-model");
  assert.equal(t.collaborationMode, undefined);
  const missing = await runShim({ args: ["--model", ""], env: { CODEX_FAKE_MODEL: "" } });
  assert.equal(missing.result.is_error, true);
  assert.match(missing.result.result, /модель/);
  assert.equal(sentTo(missing.received, "turn/start").length, 0);
});

test("shipped Workflow keeps its rules with truthful Codex context and preserved portal prompt", async () => {
  const { renderDeveloperInstructions, parseArgs, codexPolicy } = await import("../lib/codex-shim.mjs");
  const { parseAgentFile, compileAgentsJson } = await import("../lib/claude-agents.js");
  const { body } = parseAgentFile(readFileSync(path.join(ROOT, "shared/claude-agents/workflow.md"), "utf8"));
  const catalog = JSON.stringify(compileAgentsJson([{ id: "workflow", prompt: body, description: "Workflow" }]));
  const o = parseArgs(["--agents", "catalog", "--agent", "workflow", "--append-system-prompt-file", "portal", ...ASK]);
  const read = (f) => f === "catalog" ? catalog : "PORTAL_USER_RULES";
  const rendered = renderDeveloperInstructions(o, codexPolicy(o), read);
  assert.match(rendered, /# Главные правила/);
  assert.match(rendered, /Approval policy: untrusted/);
  assert.match(rendered, /Sandbox: workspace-write/);
  assert.ok(!rendered.includes("claude -p"));
  assert.ok(!rendered.includes("Права хода широкие (без запросов разрешений)"));
  assert.ok(rendered.endsWith("PORTAL_USER_RULES"));
  const cleared = { ...o, agent: undefined, agentsFile: undefined };
  assert.equal(renderDeveloperInstructions(cleared, codexPolicy(cleared), read), "PORTAL_USER_RULES");
});

test("parseArgs + codexPolicy: every mode permissionArgs() emits", async () => {
  const { parseArgs, codexPolicy } = await import("../lib/codex-shim.mjs");
  const { permissionArgs } = await import("../lib/claude.js");
  const pol = (access, mode, inputFormat = "text") => codexPolicy(parseArgs(["--input-format", inputFormat, ...permissionArgs(access, { addDirs: [], mode })]));
  const pick = (p) => [p.approvalPolicy, p.sandbox];
  assert.deepEqual(pick(pol("admin", "ask", "stream-json")), ["untrusted", "workspace-write"]);
  assert.equal(pol("admin", "ask", "stream-json").canAsk, true);
  assert.deepEqual(pick(pol("admin", "edits")), ["on-request", "workspace-write"]);
  assert.deepEqual(pick(pol("admin", "full")), ["never", "danger-full-access"]);
  assert.deepEqual(pick(pol("admin", null)), ["never", "danger-full-access"]);
  assert.deepEqual(pick(pol("tenant", "ask", "stream-json")), ["untrusted", "workspace-write"]);
  for (const m of [null, "edits", "full"]) assert.deepEqual(pick(pol("tenant", m)), ["on-request", "workspace-write"], `tenant ${m}`);
  assert.deepEqual(pick(pol(undefined, null)), ["on-request", "workspace-write"]);
  // a tenant never gets danger-full-access, even with bypass on argv
  assert.deepEqual(pick(codexPolicy(parseArgs(["--restricted", "--permission-mode", "bypassPermissions"]))), ["on-request", "workspace-write"]);
  assert.equal(pol("admin", "edits").canAsk, false);
  const o = parseArgs(["-p", "--resume", "abc", "--fork-session", "--append-system-prompt-file", "f.md", "--add-dir", "D:\\x", "--agents", "a.json", "--weird", "--model", "m"]);
  assert.equal(o.resume, "abc");
  assert.equal(o.fork, true);
  assert.equal(o.promptFile, "f.md");
  assert.deepEqual(o.addDirs, ["D:\\x"]);
  assert.equal(o.model, "m");
  assert.deepEqual(o.unknown, ["--weird"]);
});

test("codexCommand: TELEHARNESS_CODEX_BIN js/exe, global npm native exe, bin fallback, null", async () => {
  const { codexCommand } = await import("../lib/codex-shim.mjs");
  const files = new Set();
  const opts = { platform: "win32", arch: "x64", execPath: "C:\\Program Files\\nodejs\\node.exe", exists: (f) => files.has(f), read: () => JSON.stringify({ bin: { codex: "bin/codex.js" } }) };
  assert.equal(codexCommand({}, opts), null);
  files.add("C:\\x\\fake.mjs");
  assert.deepEqual(codexCommand({ TELEHARNESS_CODEX_BIN: "C:\\x\\fake.mjs" }, opts), { cmd: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\x\\fake.mjs"], env: {} });
  files.add("C:\\x\\codex.exe");
  assert.deepEqual(codexCommand({ TELEHARNESS_CODEX_BIN: "C:\\x\\codex.exe" }, opts), { cmd: "C:\\x\\codex.exe", args: [], env: {} });
  assert.equal(codexCommand({ TELEHARNESS_CODEX_BIN: "C:\\x\\gone.exe" }, opts), null);
  const pkg = "C:\\Program Files\\nodejs\\node_modules\\@openai\\codex";
  files.add(`${pkg}\\package.json`);
  files.add(`${pkg}\\bin\\codex.js`);
  assert.deepEqual(codexCommand({}, opts), { cmd: "C:\\Program Files\\nodejs\\node.exe", args: [`${pkg}\\bin\\codex.js`], env: {} });
  const exe = `${pkg}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
  files.add(exe);
  const c = codexCommand({}, opts);
  assert.equal(c.cmd, exe, "the native exe, not the node wrapper");
  assert.equal(c.env.CODEX_MANAGED_PACKAGE_ROOT, pkg);
});

test("turn: init with threadId, message_start + text deltas, final text, usage + contextWindow", async () => {
  const r = await runShim({ prompt: "привет" });
  assert.equal(r.code, 0, r.stderr);
  const init = r.lines[0];
  assert.equal(init.type, "system");
  assert.equal(init.subtype, "init");
  const sid = init.session_id;
  assert.ok(sid);
  const se = r.lines.filter((e) => e.type === "stream_event").map((e) => e.event);
  assert.equal(se[0].type, "message_start");
  assert.equal(se.filter((e) => e.type === "content_block_delta" && e.delta.type === "text_delta").map((e) => e.delta.text).join(""), "Привет мир");
  const texts = r.lines.filter((e) => e.type === "assistant").flatMap((e) => e.message.content).filter((b) => b.type === "text");
  assert.deepEqual(texts.map((b) => b.text), ["Привет мир"]);
  const res = r.result;
  assert.equal(res.subtype, "success");
  assert.equal(res.is_error, false);
  assert.equal(res.result, "Привет мир");
  assert.equal(res.session_id, sid);
  assert.equal(res.total_cost_usd, undefined, "subscription: no cost");
  // turn totals = growth of total over the turn; cached split out of input
  assert.deepEqual(res.usage, { input_tokens: 4000, output_tokens: 120, cache_read_input_tokens: 27000, cache_creation_input_tokens: 0 });
  assert.equal(res.modelUsage["gpt-6.1-sol"].contextWindow, 475000);
  // the runner's view: claudeTurnUsage with the last assistant usage
  const { translateEvent, claudeTurnUsage } = await import("../lib/claude.js");
  const lastUsage = r.lines.filter((e) => e.type === "assistant" && e.message.usage).at(-1).message.usage;
  const u = claudeTurnUsage(translateEvent(res), lastUsage, "gpt-6.1-sol");
  assert.equal(u.contextWindow, 475000);
  assert.equal(u.tokens.context, 16000, "last call: input incl. cached");
  assert.equal(u.cost, undefined);
  // what the shim sent: initialize → initialized → account/read → thread/start → turn/start
  const methods = r.received.map((m) => m.method).filter(Boolean);
  assert.deepEqual(methods.slice(0, 5), ["initialize", "initialized", "account/read", "thread/start", "turn/start"]);
  const ts = sentTo(r.received, "thread/start")[0].params;
  assert.equal(ts.approvalPolicy, "on-request");
  assert.equal(ts.sandbox, "workspace-write");
  assert.equal(ts.model, "gpt-6.1-sol");
  // macOS: the temp dir /var/… is a symlink to /private/var/… — compare real paths
  assert.equal(realpathSync(ts.cwd), realpathSync(r.cwd));
  assert.deepEqual(sentTo(r.received, "turn/start")[0].params.input[0].text, "привет");
});

test("transcript: the shim's stream builds steps, reasoning and a bash tool with its result", async () => {
  const { ClaudeTranscript } = await import("../lib/claude-transcript.js");
  const r = await runShim({ prompt: "APPROVE", args: ASK, stream: true, onControl: () => ({ behavior: "allow" }) });
  assert.equal(r.code, 0, r.stderr);
  const tr = new ClaudeTranscript({ sessionID: "s", messageID: "m" });
  for (const e of r.lines) tr.feed(e);
  tr.finish();
  const parts = tr.parts();
  const tool = parts.find((p) => p.type === "tool");
  assert.equal(tool.tool, "bash");
  assert.equal(tool.state.status, "completed");
  assert.ok(tool.state.input.command.startsWith("Set-Content -LiteralPath"), "the inner command, not the powershell wrapper");
  assert.equal(parts.filter((p) => p.type === "step-start").length, 2, "a new step after the tool result");
  assert.ok(tr.text().includes("готово"));
  const r2 = await runShim({ prompt: "REASON" });
  const tr2 = new ClaudeTranscript({ sessionID: "s", messageID: "m" });
  for (const e of r2.lines) tr2.feed(e);
  tr2.finish();
  const rs = tr2.parts().filter((p) => p.type === "reasoning");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].text, "Думаю о задаче.");
  assert.equal(tr2.text(), "ответ");
  const r3 = await runShim({ prompt: "SEARCH" });
  const ws = r3.lines.filter((e) => e.type === "assistant").flatMap((e) => e.message.content).filter((b) => b.type === "tool_use");
  assert.equal(ws.at(-1).name, "WebSearch");
  assert.equal(ws.at(-1).input.query, "погода москва", "the input is refreshed on completion");
});

test("approval accept (recorded stream): control_request can_use_tool, then accept to Codex", async () => {
  const asked = [];
  const r = await runShim({ prompt: "APPROVE", args: ASK, stream: true, onControl: (req) => (asked.push(req), { behavior: "allow" }) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].subtype, "can_use_tool");
  assert.equal(asked[0].tool_name, "Bash");
  assert.match(asked[0].input.command, /note-accept\.txt/);
  assert.match(asked[0].description, /Разрешить создать файл/);
  assert.equal(asked[0].tool_use_id, "exec-1262e89c-5bcd-488a-bb95-2b0170568dc5");
  assert.deepEqual(answersTo(r.received, 0).result, { decision: "accept" });
  const ts = sentTo(r.received, "thread/start")[0].params;
  assert.equal(ts.approvalPolicy, "untrusted");
  assert.equal(ts.sandbox, "workspace-write");
  const tr = r.lines.filter((e) => e.type === "user").flatMap((e) => e.message.content);
  assert.equal(tr[0].type, "tool_result");
  assert.equal(tr[0].is_error, false);
  assert.equal(r.result.result, "готово");
  assert.equal(r.result.modelUsage["gpt-6.1-sol"].contextWindow, 475000);
});

test("approval decline: deny → decline, the declined command is an error result, the agent says so", async () => {
  const r = await runShim({ prompt: "APPROVE", args: ASK, stream: true, onControl: () => ({ behavior: "deny" }) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(answersTo(r.received, 0).result, { decision: "decline" });
  const tr = r.lines.filter((e) => e.type === "user").flatMap((e) => e.message.content);
  assert.equal(tr[0].is_error, true);
  assert.equal(r.result.result, "Файл не создан: разрешение на запись отклонено.");
});

test("text mode cannot ask: approvals are declined without a control_request", async () => {
  const r = await runShim({ prompt: "APPROVE", args: ["--permission-mode", "acceptEdits"] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.lines.filter((e) => e.type === "control_request").length, 0);
  assert.deepEqual(answersTo(r.received, 0).result, { decision: "decline" });
  const r2 = await runShim({ prompt: "FILECHANGE", args: ["--permission-mode", "acceptEdits"] });
  assert.equal(r2.lines.filter((e) => e.type === "control_request").length, 0);
  assert.deepEqual(answersTo(r2.received, 100).result, { decision: "decline" });
});

test("fileChange approval: Write tool with the path, accept", async () => {
  const asked = [];
  const r = await runShim({ prompt: "FILECHANGE", args: ASK, stream: true, onControl: (req) => (asked.push(req), { behavior: "allow" }) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(asked[0].tool_name, "Write");
  assert.equal(asked[0].input.file_path, "D:\\work\\new.txt");
  assert.deepEqual(answersTo(r.received, 100).result, { decision: "accept" });
  assert.equal(r.result.result, "файл создан");
});

test("--resume → thread/resume; --fork-session → thread/fork; a lost thread → fresh thread/start", async () => {
  const r = await runShim({ prompt: "ECHOTHREAD", args: ["--resume", "thr-old"] });
  const a = JSON.parse(r.result.result);
  assert.equal(a.method, "thread/resume");
  assert.equal(a.params.threadId, "thr-old");
  assert.equal(r.lines[0].session_id, "thr-old");
  const f = await runShim({ prompt: "ECHOTHREAD", args: ["--resume", "thr-old", "--fork-session"] });
  assert.equal(JSON.parse(f.result.result).method, "thread/fork");
  assert.equal(f.result.session_id, "fork-of-thr-old");
  const lost = await runShim({ prompt: "ECHOTHREAD", args: ["--resume", "missing-1"] });
  assert.equal(JSON.parse(lost.result.result).method, "thread/start");
  assert.match(lost.stderr, /missing-1/);
});

test("--append-system-prompt-file → developerInstructions", async () => {
  const f = path.join(TMP, "prompt.md");
  writeFileSync(f, "Отвечай кратко.\n\nПравило портала.", "utf8");
  const r = await runShim({ prompt: "ECHOTHREAD", args: ["--append-system-prompt-file", f] });
  assert.equal(JSON.parse(r.result.result).params.developerInstructions, "Отвечай кратко.\n\nПравило портала.");
});

test("errors: failed turn, usage limit, not logged in, init failure, missing binary", async () => {
  const { turnErrorKind } = await import("../shared/turn-error.js");
  const fail = await runShim({ prompt: "FAIL" });
  assert.equal(fail.code, 1);
  assert.equal(fail.result.is_error, true);
  assert.equal(fail.result.subtype, "error_during_execution");
  assert.match(fail.result.result, /boom/);
  const lim = await runShim({ prompt: "LIMIT" });
  assert.equal(lim.result.is_error, true);
  assert.match(lim.result.result, /usage limit/);
  assert.match(lim.result.result, /try again in 3 days/);
  assert.equal(turnErrorKind(lim.result.result, { engine: "claude" }), "limit");
  const auth = await runShim({ prompt: "hi", env: { CODEX_FAKE_NOAUTH: "1" } });
  assert.equal(auth.result.is_error, true);
  assert.equal(turnErrorKind(auth.result.result, { engine: "claude" }), "auth");
  assert.equal(sentTo(auth.received, "turn/start").length, 0);
  const init = await runShim({ prompt: "hi", env: { CODEX_FAKE_INIT_ERROR: "1" } });
  assert.equal(init.result.is_error, true);
  assert.match(init.result.result, /initialize|unsupported client|app-server/);
  const died = await runShim({ prompt: "hi", env: { CODEX_FAKE_EXIT_ON_INIT: "1" } });
  assert.equal(died.result.is_error, true);
  assert.equal(died.code, 1);
  const none = await runShim({ prompt: "hi", env: { TELEHARNESS_CODEX_BIN: path.join(TMP, "nope.exe") } });
  assert.equal(none.result.is_error, true);
  assert.match(none.result.result, /codex/);
});

test("unknown server request → JSON-RPC error, the turn goes on", async () => {
  const r = await runShim({ prompt: "UNKNOWNREQ" });
  assert.equal(r.code, 0, r.stderr);
  const ans = answersTo(r.received, 100);
  assert.equal(ans.error.code, -32601);
  assert.equal(r.result.result, "error -32601");
});

test("stream-json stdin closed mid-turn → turn/interrupt, exit, no result", async () => {
  const r = await runShim({ prompt: "HANG", args: ASK, stream: true, closeAfterMs: 800 });
  assert.equal(sentTo(r.received, "turn/interrupt").length, 1);
  assert.equal(r.result, null);
});

test("--teleharness-catalog: login + all model pages; failures → ok:false", async () => {
  const run = (env) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [SHIM, "--teleharness-catalog"], { cwd: workDir(), env: { ...process.env, TELEHARNESS_CODEX_BIN: FAKE, ...env }, windowsHide: true });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", (code) => resolve({ code, out: out.trim().split("\n") }));
    });
  const ok = await run({});
  assert.equal(ok.code, 0);
  assert.equal(ok.out.length, 1, "one JSON line");
  const j = JSON.parse(ok.out[0]);
  assert.equal(j.ok, true);
  assert.equal(j.loggedIn, true);
  assert.equal(j.plan, "pro");
  assert.deepEqual(j.models.map((m) => m.id), ["gpt-6.1-sol", "gpt-6-astra", "gpt-old"]);
  assert.equal(j.models[0].isDefault, true);
  assert.deepEqual(j.models[0].inputModalities, ["text", "image"]);
  assert.equal(j.models[2].hidden, true);
  const noauth = JSON.parse((await run({ CODEX_FAKE_NOAUTH: "1" })).out[0]);
  assert.equal(noauth.ok, true);
  assert.equal(noauth.loggedIn, false);
  const bad = await run({ CODEX_FAKE_INIT_ERROR: "1" });
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.out[0]).ok, false);
  const none = await run({ TELEHARNESS_CODEX_BIN: path.join(TMP, "nope.exe") });
  assert.equal(none.code, 1);
  assert.match(JSON.parse(none.out[0]).error, /не найден/);
});

// --- integration: the real runner with the shim as its binary ---------------

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
// a Claude catalog id: the runner's own model gate (engineOfModel) is not what
// this test is about — the binary is the shim either way
const body = (text) => Buffer.from(JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, parts: [{ type: "text", text }] }));
async function dispatchOk(runner, args) {
  const res = fakeRes();
  await runner.dispatch({ res, ...args });
  assert.ok(res.code < 300, `dispatch answered ${res.code}`);
}
async function waitFor(fn, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(30);
  }
  throw new Error(`timeout: ${what}`);
}
const ofType = (hub, t) => hub.events.filter((x) => x.event.type === t);
const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n");

test("ClaudeRunner + shim: ask-mode dialog answered, turn in history with steps and context; next turn resumes the thread", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const dataDir = path.join(TMP, `data-${++seq}`);
  mkdirSync(dataDir, { recursive: true });
  const runner = new ClaudeRunner({ hub, storePath: path.join(dataDir, "claude-sessions.json"), binPath: WRAPPER, keepaliveMs: 1000, addDirs: [] });
  const dir = workDir();
  await dispatchOk(runner, { sid: "cx1", dir, body: body("APPROVE"), access: "admin", permMode: "ask" });
  const asked = await waitFor(() => ofType(hub, "permission.asked")[0], "permission.asked");
  const p = asked.event.properties;
  assert.equal(p.permission, "Bash");
  assert.match(p.metadata.command, /note-accept\.txt/);
  assert.equal(runner.dialogs().length, 1);
  assert.equal(runner.replyDialog(p.id, { reply: "once" }), true);
  await waitFor(() => ofType(hub, "session.idle").length >= 1, "idle 1");
  const ans = runner.messages("cx1")[1];
  assert.equal(textOf(ans).includes("готово"), true, textOf(ans));
  const tool = ans.parts.find((x) => x.type === "tool");
  assert.equal(tool.tool, "bash");
  assert.equal(tool.state.status, "completed");
  assert.equal(ans.info.contextWindow, 475000);
  assert.ok(ans.info.tokens.context > 0);
  assert.equal(ans.info.cost, undefined);
  assert.equal(ans.info.teleharness, undefined, "not interrupted");
  assert.deepEqual(runner.dialogs(), []);
  await waitFor(() => Object.keys(runner.liveness()).length === 0 && !runner.busySnapshot().cx1, "process gone");
  // second turn: the runner resumes the Codex thread the shim named in init
  await dispatchOk(runner, { sid: "cx1", dir, body: body("ECHOTHREAD"), access: "admin", permMode: "edits" });
  await waitFor(() => ofType(hub, "session.idle").length >= 2, "idle 2");
  const echo = JSON.parse(textOf(runner.messages("cx1")[3]));
  assert.equal(echo.method, "thread/resume");
  assert.equal(echo.params.threadId, "01a1e083-8c1f-78e3-a6aa-ac1549ab91da");
  assert.equal(echo.params.approvalPolicy, "on-request");
  await waitFor(() => Object.keys(runner.liveness()).length === 0 && !runner.busySnapshot().cx1, "process gone 2");
});

test("ClaudeRunner + shim: a stop with an open Codex request — dialog closed, chat free", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const dataDir = path.join(TMP, `data-${++seq}`);
  mkdirSync(dataDir, { recursive: true });
  const runner = new ClaudeRunner({ hub, storePath: path.join(dataDir, "claude-sessions.json"), binPath: WRAPPER, keepaliveMs: 1000, addDirs: [] });
  await dispatchOk(runner, { sid: "cx2", dir: workDir(), body: body("APPROVE"), access: "admin", permMode: "ask" });
  await waitFor(() => ofType(hub, "permission.asked")[0], "ask");
  assert.equal(runner.abort("cx2"), true);
  await waitFor(() => ofType(hub, "session.idle").length >= 1, "idle");
  assert.deepEqual(runner.dialogs(), []);
  assert.equal(runner.messages("cx2")[1].info.teleharness.interrupted, "user");
  await waitFor(() => Object.keys(runner.liveness()).length === 0 && !runner.busySnapshot().cx2, "process gone");
});

test("FEAT-18.7: ошибка запуска codex CLI распознаётся как spawn (а не как пропавшая папка), лимит Codex — как limit", async () => {
  const { turnErrorKind, claudeAnswerError } = await import("../shared/turn-error.js");
  assert.equal(turnErrorKind("Не удалось запустить codex CLI: spawn codex.exe ENOENT", { engine: "codex" }), "spawn");
  assert.equal(turnErrorKind("Codex usage limit reached: You've hit your usage limit", { engine: "codex" }), "limit");
  assert.ok(claudeAnswerError("Codex вернул ошибку"));
});

test("FEAT-20.35: --restricted (tenant) auto-declines item/permissions/requestApproval with empty permissions", async () => {
  let asked = 0;
  const r = await runShim({
    args: ["--restricted", ...ASK],
    prompt: "ESCALATE",
    stream: true,
    onControl: () => {
      asked++;
      return { behavior: "allow" };
    },
  });
  assert.equal(asked, 0, "tenant escalation must not even prompt");
  assert.equal(r.result?.is_error, false);
  const ans = JSON.parse(r.result.result);
  assert.deepEqual(ans, { permissions: {} });
});

test("--teleharness-catalog retries account/read once with refreshToken:true on expired access token; active account sends account/read once", async () => {
  const runCat = (env) =>
    new Promise((resolve) => {
      const logFile = path.join(TMP, `cat-log-${++seq}.jsonl`);
      const c = spawn(process.execPath, [SHIM, "--teleharness-catalog"], {
        cwd: workDir(),
        env: { ...process.env, TELEHARNESS_CODEX_BIN: FAKE, CODEX_FAKE_LOG: logFile, ...env },
        windowsHide: true,
      });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", (code) => {
        const rec = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
        resolve({ code, json: JSON.parse(out.trim().split("\n").at(-1)), received: rec });
      });
    });

  const active = await runCat({});
  assert.equal(active.code, 0);
  assert.equal(active.json.loggedIn, true);
  assert.deepEqual(sentTo(active.received, "account/read").map((m) => m.params), [{ refreshToken: false }]);

  const refreshed = await runCat({ CODEX_FAKE_EXPIRED_ONCE: "1" });
  assert.equal(refreshed.code, 0);
  assert.equal(refreshed.json.ok, true);
  assert.equal(refreshed.json.loggedIn, true);
  assert.equal(refreshed.json.plan, "pro");
  assert.deepEqual(sentTo(refreshed.received, "account/read").map((m) => m.params), [{ refreshToken: false }, { refreshToken: true }]);

  const failed = await runCat({ CODEX_FAKE_REFRESH_ERR: "1" });
  assert.equal(failed.code, 0);
  assert.equal(failed.json.ok, true);
  assert.equal(failed.json.loggedIn, false);
  assert.match(failed.json.authError ?? "", /Failed to refresh token:.*already used/i);
  assert.doesNotMatch(failed.json.authError ?? "", /eyJhbGci|rt_secret12345678/);
  assert.deepEqual(sentTo(failed.received, "account/read").map((m) => m.params), [{ refreshToken: false }, { refreshToken: true }]);
});

test("runTurn retries account/read once with refreshToken:true on expired access token", async () => {
  const r = await runShim({ prompt: "hi", env: { CODEX_FAKE_EXPIRED_ONCE: "1" } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result?.is_error, false);
  assert.deepEqual(sentTo(r.received, "account/read").map((m) => m.params), [{ refreshToken: false }, { refreshToken: true }]);
});

test("extractAuthError strips ANSI escapes, redacts secrets and prefers Failed to refresh token over 401", async () => {
  const { extractAuthError } = await import("../lib/codex-shim.mjs");
  const sample = [
    "\u001b[2m2026-11-28T11:30:39Z\u001b[0m \u001b[31mERROR\u001b[0m codex_login::auth::manager: Failed to refresh token: Your refresh token was already used. Bearer sk-secret12345678",
    "\u001b[2m2026-11-28T11:30:40Z\u001b[0m \u001b[31mERROR\u001b[0m codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized",
  ].join("\n");
  const msg = extractAuthError(sample);
  assert.equal(msg, "Failed to refresh token: Your refresh token was already used. Bearer [redacted]");
  assert.doesNotMatch(msg, /\u001b\[/);
});
