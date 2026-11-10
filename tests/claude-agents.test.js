// FEAT-13.17: Claude agents — catalog (lib/claude-agents.js), binding rules
// (lib/binding.js) and the runner argv (lib/claude.js against the fake CLI).
// Run: node --test tests/claude-agents.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAgentCatalog, compileAgentsJson, isClaudeAgentId, loadClaudeAgents, parseAgentFile } from "../lib/claude-agents.js";
import { makeBinding, patchBinding, resolveBinding } from "../lib/binding.js";
import { ClaudeRunner } from "../lib/claude.js";
// FEAT-13.19: a Claude answer is several parts (steps, tools, text) — its text is every text part.
const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n");

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const SHIPPED = path.join(ROOT, "shared", "claude-agents");
const TMP = mkdtempSync(path.join(tmpdir(), "zai-claude-agents-"));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

let seq = 0;
const freshDir = (name = "d") => {
  const d = path.join(TMP, `${name}-${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const md = (name, description, body = "Промпт агента.", extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- catalog -------------------------------------------------------------------

test("parseAgentFile: frontmatter key: value, BOM + CRLF, quotes; no frontmatter → null", () => {
  const p = parseAgentFile('﻿---\r\nname: "Workflow"\r\ndescription: Задача: по флоу # не комментарий\r\n# comment line\r\ntools: Read, Edit\r\n---\r\nТело\r\nпромпта\r\n');
  assert.equal(p.meta.name, "Workflow");
  assert.equal(p.meta.description, "Задача: по флоу # не комментарий");
  assert.equal(p.meta.tools, "Read, Edit");
  assert.equal(p.body, "Тело\nпромпта");
  assert.equal(parseAgentFile("просто текст"), null);
});

test("isClaudeAgentId: file-name ids only; opencode names and option-like strings never pass (BUG-11.2)", () => {
  for (const ok of ["workflow", "a", "code-review2"]) assert.equal(isClaudeAgentId(ok), true, ok);
  for (const bad of ["Sisyphus - ultraworker", "explore ", "-p", "--agent", "Workflow", "", null, "a".repeat(33), "1abc"]) assert.equal(isClaudeAgentId(bad), false, String(bad));
});

test("shipped catalog: Workflow is there with a description", () => {
  const list = loadClaudeAgents({ shippedDir: SHIPPED, dataDir: null, log: () => {} });
  const wf = list.find((a) => a.id === "workflow");
  assert.ok(wf, "workflow agent shipped");
  assert.equal(wf.name, "Workflow");
  assert.match(wf.description, /^Задача по полному флоу разработки/);
  assert.ok(wf.prompt.length > 1000);
});

test("loadClaudeAgents: data/ overrides shared/ by id, disabled hides, broken files are skipped with a log line", () => {
  const shared = freshDir("shared");
  const data = freshDir("data");
  writeFileSync(path.join(shared, "alpha.md"), md("Alpha", "из shared"));
  writeFileSync(path.join(shared, "beta.md"), md("Beta", "beta shared"));
  writeFileSync(path.join(shared, "gamma.md"), md("Gamma", "gamma"));
  writeFileSync(path.join(data, "alpha.md"), md("Alpha local", "из data"));
  writeFileSync(path.join(data, "beta.md"), "---\ndisabled: true\n---\n");
  writeFileSync(path.join(data, "noname.md"), "---\ndescription: без имени\n---\nтело\n");
  writeFileSync(path.join(data, "nobody.md"), "---\nname: X\ndescription: y\n---\n");
  writeFileSync(path.join(data, "Bad Name.md"), md("Bad", "bad id"));
  writeFileSync(path.join(data, "readme.txt"), "not an agent");
  const logs = [];
  const list = loadClaudeAgents({ shippedDir: shared, dataDir: data, log: (m) => logs.push(m) });
  assert.deepEqual(list.map((a) => [a.id, a.name, a.description, a.source]), [
    ["alpha", "Alpha local", "из data", "data"],
    ["gamma", "Gamma", "gamma", "shared"],
  ]);
  assert.equal(logs.length, 3, logs.join("\n"));
  assert.ok(logs.some((l) => l.includes("noname.md")));
  assert.ok(logs.some((l) => l.includes("Bad Name.md")));
});

test("compiled JSON: every agent, prompt + description, tools as a list, NEVER model", () => {
  const out = compileAgentsJson([
    { id: "a", name: "A", description: "d", prompt: "p", tools: "Read, Edit ,Bash" },
    { id: "b", name: "B", description: "e", prompt: "q" },
  ]);
  assert.deepEqual(out, { a: { description: "d", prompt: "p", tools: ["Read", "Edit", "Bash"] }, b: { description: "e", prompt: "q" } });
  const shared = freshDir("shared");
  writeFileSync(path.join(shared, "m.md"), md("M", "with model", "тело", "model: claude-opus-5-5\n"));
  const compiled = path.join(freshDir("data"), "claude-agents.compiled.json");
  const cat = new ClaudeAgentCatalog({ shippedDir: shared, compiledPath: compiled, log: () => {} });
  assert.equal(cat.compiledFile(), compiled);
  const json = JSON.parse(readFileSync(compiled, "utf8"));
  assert.deepEqual(Object.keys(json), ["m"]);
  assert.equal("model" in json.m, false, "the chat binding owns the model");
});

test("ClaudeAgentCatalog: a new / edited / removed file is seen without a restart; publicList has no prompt", async () => {
  const shared = freshDir("shared");
  const data = freshDir("data");
  writeFileSync(path.join(shared, "workflow.md"), md("Workflow", "флоу", "СЕКРЕТНЫЙ ПРОМПТ"));
  const compiled = path.join(data, "claude-agents.compiled.json");
  const cat = new ClaudeAgentCatalog({ shippedDir: shared, dataDir: data, compiledPath: compiled, log: () => {} });
  assert.deepEqual(cat.publicList(), [{ id: "workflow", name: "Workflow", description: "флоу" }]);
  assert.equal(JSON.stringify(cat.publicList()).includes("СЕКРЕТНЫЙ"), false);
  cat.compiledFile();

  writeFileSync(path.join(data, "reviewer.md"), md("Reviewer", "ревью"));
  assert.deepEqual(cat.publicList().map((a) => a.id), ["reviewer", "workflow"]);
  assert.ok("reviewer" in JSON.parse(readFileSync(cat.compiledFile(), "utf8")), "compiled file rewritten after a change");

  const f = path.join(data, "reviewer.md");
  writeFileSync(f, md("Reviewer 2", "ревью 2"));
  const t = new Date(Date.now() + 5000);
  utimesSync(f, t, t);
  assert.equal(cat.get("reviewer").name, "Reviewer 2");

  unlinkSync(f);
  assert.equal(cat.has("reviewer"), false);
  assert.equal(cat.nameOf("reviewer"), "Reviewer 2", "a gone agent keeps its last name for the notice");
  assert.equal(cat.has("Sisyphus - ultraworker"), false);
});

// --- binding -------------------------------------------------------------------

const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const inCatalog = (a) => a === "workflow";

test("makeBinding: claude agent only through the catalog validator; default → null (BUG-11.2 kept)", () => {
  assert.equal(makeBinding({ model: OPUS, agent: "workflow" }).agent, null, "no validator = no claude agents");
  assert.equal(makeBinding({ model: OPUS, agent: "workflow" }, { claudeAgentOk: inCatalog }).agent, "workflow");
  assert.equal(makeBinding({ model: OPUS, agent: "Sisyphus - ultraworker" }, { claudeAgentOk: inCatalog }).agent, null);
  assert.equal(makeBinding({ model: OPUS }, { claudeAgentOk: inCatalog }).agent, null, "default: no agent");
  assert.equal(makeBinding({ model: GLM, agent: "Sisyphus - ultraworker" }, { claudeAgentOk: inCatalog }).agent, "Sisyphus - ultraworker");
});

test("patchBinding: the claude agent changes before AND after the first message; the engine stays locked (409)", () => {
  const empty = makeBinding({ model: OPUS });
  const pick = patchBinding(empty, { agent: "workflow" }, { claudeAgentOk: inCatalog });
  assert.equal(pick.binding.agent, "workflow");
  const prompted = { ...pick.binding, prompted: true };
  const back = patchBinding(prompted, { agent: null }, { claudeAgentOk: inCatalog });
  assert.equal(back.status, undefined);
  assert.equal(back.binding.agent, null);
  assert.equal(back.binding.prompted, true);
  const again = patchBinding({ ...back.binding }, { agent: "workflow" }, { claudeAgentOk: inCatalog });
  assert.equal(again.binding.agent, "workflow");
  // a model change within claude keeps the agent
  assert.equal(patchBinding(prompted, { model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, { claudeAgentOk: inCatalog }).binding.agent, "workflow");
  // the engine is still locked
  assert.equal(patchBinding(prompted, { model: GLM }, { claudeAgentOk: inCatalog }).status, 409);
  // unknown / opencode names / no admin validator → null, never stored
  assert.equal(patchBinding(empty, { agent: "nope" }, { claudeAgentOk: inCatalog }).binding.agent, null);
  assert.equal(patchBinding(empty, { agent: "Sisyphus - ultraworker" }, { claudeAgentOk: inCatalog }).binding.agent, null);
  assert.equal(patchBinding(empty, { agent: "workflow" }).binding.agent, null, "tenant: no validator");
  // opencode → claude in an empty chat: the patch names the claude agent (or none)
  const oc = makeBinding({ model: GLM, agent: "Sisyphus - ultraworker" });
  assert.equal(patchBinding(oc, { model: OPUS }, { claudeAgentOk: inCatalog }).binding.agent, null);
  assert.equal(patchBinding(oc, { model: OPUS, agent: "workflow" }, { claudeAgentOk: inCatalog }).binding.agent, "workflow");
});

test("resolveBinding: a stored claude agent survives; chats without a record never get one", () => {
  const stored = { engine: "claude", model: OPUS, agent: "workflow", prompted: true };
  const r = resolveBinding({ stored, claudeAgentOk: (a) => isClaudeAgentId(a) });
  assert.equal(r.agent, "workflow");
  assert.equal(resolveBinding({ stored: { ...stored, agent: "Sisyphus - ultraworker" }, claudeAgentOk: isClaudeAgentId }).agent, null);
  const inferred = resolveBinding({ session: { id: "x" }, claudeKnown: true, claudeModelID: "claude-opus-5-5", claudeAgentOk: isClaudeAgentId });
  assert.equal(inferred.source, "claude");
  assert.equal(inferred.agent, null, "old chats get no agent implicitly");
});

// --- runner argv (fake CLI) ------------------------------------------------------

function stubHub() {
  const events = [];
  return { events, markManaged: () => {}, emit: (event, dir) => events.push({ event, dir }) };
}
const body = (text, modelID = "claude-opus-5-5") => Buffer.from(JSON.stringify({ model: { providerID: "anthropic", modelID }, parts: [{ type: "text", text }] }));
const fakeRes = () => ({ code: 0, writeHead(c) { this.code = c; }, end() {} });
async function waitIdle(hub, count = 1, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hub.events.filter((x) => x.event.type === "session.idle").length >= count) return;
    await sleep(40);
  }
  throw new Error("no session.idle within timeout");
}
const answers = (runner, sid) => runner.messages(sid).filter((m) => m.info.role === "assistant");
const argvOf = (msg) => JSON.parse(textOf(msg).replace(/ \(resumed\)/g, "")).argv;

function agentRunner({ agents, onAgentMissing } = {}) {
  const data = freshDir("run");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: path.join(data, "claude-sessions.json"), binPath: FIXTURE, keepaliveMs: 5000, addDirs: [], agents, onAgentMissing, log: () => {} });
  return { hub, runner, data };
}

function workflowCatalog() {
  const shared = freshDir("shared");
  writeFileSync(path.join(shared, "workflow.md"), md("Workflow", "флоу", "Ты Workflow."));
  const compiledPath = path.join(freshDir("data"), "claude-agents.compiled.json");
  return { shared, compiledPath, catalog: new ClaudeAgentCatalog({ shippedDir: shared, compiledPath, log: () => {} }) };
}

test("runner: no agent → argv exactly as before agents (regression); agent → --agents <file> --agent <id> + snapshot off", async () => {
  const { catalog, compiledPath } = workflowCatalog();
  const { hub, runner } = agentRunner({ agents: catalog });
  await runner.dispatch({ res: fakeRes(), sid: "n1", dir: TMP, body: body("ECHO"), access: "admin" });
  await waitIdle(hub, 1);
  const argv = argvOf(answers(runner, "n1")[0]);
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  assert.deepEqual(argv.map((a, i) => (argv[i - 1] === "--settings" ? "<settings>" : a)), [
    "-p", "--input-format", "text", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--model", "claude-opus-5-5",
    // FEAT-13.19: thinking summaries ride every turn (no agent flags added)
    "--settings", "<settings>",
    "--permission-mode", "bypassPermissions",
  ]);
  assert.equal(settings.showThinkingSummaries, true);
  // FEAT-01.58: the same settings carry the PreToolUse backup hook.
  assert.equal(settings.hooks.PreToolUse[0].matcher, "Write|Edit|MultiEdit|NotebookEdit");
  assert.equal("agent" in answers(runner, "n1")[0].info, false);

  await runner.dispatch({ res: fakeRes(), sid: "a1", dir: TMP, body: body("ECHO"), access: "admin", agent: "workflow" });
  await waitIdle(hub, 2);
  const a = argvOf(answers(runner, "a1")[0]);
  assert.equal(a[a.indexOf("--agents") + 1], compiledPath);
  assert.equal(a[a.indexOf("--agent") + 1], "workflow");
  assert.equal(a[a.indexOf("--model") + 1], "claude-opus-5-5", "the model still comes from the binding");
  assert.equal(a[a.indexOf("--system-prompt-snapshot") + 1], "off");
  assert.equal(answers(runner, "a1")[0].info.agent, "workflow", "the answer records its agent");
  const compiled = JSON.parse(readFileSync(compiledPath, "utf8"));
  assert.equal(compiled.workflow.prompt, "Ты Workflow.");
  assert.equal("model" in compiled.workflow, false);
});

test("runner: switching agents mid-chat — same claude session (--resume), prompt re-rendered each turn", async () => {
  const { catalog } = workflowCatalog();
  const { hub, runner } = agentRunner({ agents: catalog });
  await runner.dispatch({ res: fakeRes(), sid: "s", dir: TMP, body: body("ECHO"), access: "admin", agent: "workflow" });
  await waitIdle(hub, 1);
  await runner.dispatch({ res: fakeRes(), sid: "s", dir: TMP, body: body("ECHO"), access: "admin", agent: null });
  await waitIdle(hub, 2);
  const [first, second] = answers(runner, "s");
  assert.equal(first.info.agent, "workflow");
  const b = argvOf(second);
  assert.ok(b.includes("--resume"), "the same claude session continues");
  assert.equal(b.includes("--agent"), false);
  assert.equal(b.includes("--agents"), false);
  assert.equal(b[b.indexOf("--system-prompt-snapshot") + 1], "off", "without it the CLI would replay the Workflow prompt (spike)");
  assert.equal("agent" in second.info, false);
});

test("runner: a queued follow-up keeps the agent of the moment it was sent", async () => {
  const { catalog } = workflowCatalog();
  const { hub, runner } = agentRunner({ agents: catalog });
  await runner.dispatch({ res: fakeRes(), sid: "q", dir: TMP, body: body("WAIT"), access: "admin", agent: "workflow" });
  await runner.dispatch({ res: fakeRes(), sid: "q", dir: TMP, body: body("ECHO queued"), access: "admin", agent: "workflow" });
  await runner.dispatch({ res: fakeRes(), sid: "q", dir: TMP, body: body("ECHO later"), access: "admin", agent: null });
  await waitIdle(hub, 1, 20_000);
  const list = answers(runner, "q");
  assert.equal(list.length, 3);
  assert.equal(list[1].info.agent, "workflow");
  assert.equal(argvOf(list[1]).includes("--agent"), true);
  assert.equal("agent" in list[2].info, false);
  assert.equal(argvOf(list[2]).includes("--agent"), false);
});

test("runner: an agent gone from the catalog → turn without agent + onAgentMissing (name kept)", async () => {
  const { catalog, shared } = workflowCatalog();
  catalog.list(); // the name is known before the file disappears
  unlinkSync(path.join(shared, "workflow.md"));
  const missing = [];
  const { hub, runner } = agentRunner({ agents: catalog, onAgentMissing: (e) => missing.push(e) });
  await runner.dispatch({ res: fakeRes(), sid: "g", dir: TMP, body: body("ECHO"), access: "admin", agent: "workflow" });
  await waitIdle(hub, 1);
  const a = argvOf(answers(runner, "g")[0]);
  assert.equal(a.includes("--agent"), false);
  assert.equal(a.includes("--agents"), false);
  assert.deepEqual(missing.map((m) => [m.sid, m.agent, m.name]), [["g", "workflow", "Workflow"]]);
});

test("runner: an opencode agent name never reaches the CLI (BUG-11.2)", async () => {
  const { catalog } = workflowCatalog();
  const missing = [];
  const { hub, runner } = agentRunner({ agents: catalog, onAgentMissing: (e) => missing.push(e) });
  await runner.dispatch({ res: fakeRes(), sid: "o", dir: TMP, body: body("ECHO"), access: "admin", agent: "Sisyphus - ultraworker" });
  await waitIdle(hub, 1);
  const a = argvOf(answers(runner, "o")[0]);
  assert.equal(a.includes("--agent"), false);
  assert.equal(a.some((x) => x.includes("Sisyphus")), false);
  assert.equal(missing.length, 0);
});
