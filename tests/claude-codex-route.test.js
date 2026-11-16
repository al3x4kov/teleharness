// FEAT-18.7: один раннер CLI ведёт и Claude-, и Codex-ходы. Для модели из каталога
// Codex он запускает посредника (codexBin) вместо claude CLI; ответ помечен
// провайдером openai-codex; продолжение Codex (codexSid) хранится отдельно от
// claudeSid; откат хода Codex отклоняется; без каталога Codex модель не проходит.
// Посредник здесь — тот же фейковый CLI (протокол claude stream-json).
// Run: node --test --test-concurrency=1 tests/claude-codex-route.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRunner, codexProviderPatch, providerPatch } from "../lib/claude.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const TMP = mkdtempSync(path.join(tmpdir(), "teleharness-codex-route-"));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const CODEX = { providerID: "openai-codex", modelID: "gpt-6.1-sol" };
const HAIKU = { providerID: "anthropic", modelID: "claude-haiku-4-5" };
const CATALOG = [{ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true }, { id: "gpt-6-astra", displayName: "GPT-6-Astra" }];

function makeRunner(name, { codexBin = FAKE, catalog = CATALOG, agents = null } = {}) {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const events = [];
  const hub = { events, managed: new Set(), markManaged() {}, emit: (event) => events.push(event) };
  const runner = new ClaudeRunner({ hub, agents, storePath: path.join(dir, "claude-sessions.json"), binPath: FAKE, codexBin, keepaliveMs: 1000, log: () => {} });
  if (catalog) runner.setCodexCatalog(catalog);
  return { runner, events };
}
async function turn(runner, events, sid, model, text, agent = null) {
  const idleBefore = events.filter((e) => e.type === "session.idle" && e.properties?.sessionID === sid).length;
  let status = null;
  const res = { writeHead(s) { status = s; }, end() {} };
  await runner.dispatch({ res, sid, dir: TMP, agent, body: Buffer.from(JSON.stringify({ model, parts: [{ type: "text", text }] })) });
  if (status !== 204) return { status };
  const end = Date.now() + 15_000;
  while (events.filter((e) => e.type === "session.idle" && e.properties?.sessionID === sid).length <= idleBefore && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const msgs = runner.messages(sid);
  return { status, answer: msgs.at(-1) };
}
const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");

test("Codex carries the catalog profile and removes it on the next turn", async () => {
  const file = path.join(TMP, "profiles.json");
  writeFileSync(file, JSON.stringify({ workflow: { prompt: "ROLE_ACTIVE" } }));
  const { runner, events } = makeRunner("profiles", { agents: { has: (id) => id === "workflow", compiledFile: () => file } });
  const selected = await turn(runner, events, "p1", CODEX, "ECHO role", "workflow");
  const argv = JSON.parse(textOf(selected.answer)).argv;
  assert.equal(argv[argv.indexOf("--agents") + 1], file);
  assert.equal(argv[argv.indexOf("--agent") + 1], "workflow");
  assert.match(argv[argv.indexOf("--teleharness-instructions-hash") + 1], /^[a-f0-9]{64}$/);
  assert.equal(selected.answer.info.agent, "workflow");
  const same = await turn(runner, events, "p1", CODEX, "ECHO MEMORY_MARKER", "workflow");
  assert.ok(JSON.parse(textOf(same.answer).replace(/\(resumed\)/g, "")).argv.includes("--resume"));
  const cleared = await turn(runner, events, "p1", CODEX, "ECHO clear");
  const echo = JSON.parse(textOf(cleared.answer).replace(/\(resumed\)/g, ""));
  assert.ok(!echo.argv.includes("--agent"));
  assert.ok(!echo.argv.includes("--resume"), "changed instructions require a fresh native baseline");
  assert.match(echo.prompt, /MEMORY_MARKER/);
  assert.match(echo.prompt, /истори|переписк/i);
  assert.ok(echo.prompt.endsWith("ECHO clear"));
  assert.equal(cleared.answer.info.agent, undefined);
  runner.flushNow();
  const stored = JSON.parse(readFileSync(path.join(TMP, "profiles", "claude-sessions.json"), "utf8"));
  assert.match(stored.sessions.p1.codexInstructionsHash, /^[a-f0-9]{64}$/);
  // A catalog edit without changing its id still refreshes the native prompt.
  const selectedAgain = await turn(runner, events, "p1", CODEX, "ECHO select", "workflow");
  assert.ok(!JSON.parse(textOf(selectedAgain.answer)).argv.includes("--resume"));
  writeFileSync(file, JSON.stringify({ workflow: { prompt: "ROLE_EDITED" } }));
  const edited = await turn(runner, events, "p1", CODEX, "ECHO edit", "workflow");
  assert.ok(!JSON.parse(textOf(edited.answer)).argv.includes("--resume"));
});

test("failed Codex profile resolution does not associate old native history with new instructions", async () => {
  const file = path.join(TMP, "failure-profiles.json");
  writeFileSync(file, JSON.stringify({ workflow: { prompt: "FIRST_ROLE" } }));
  const { runner, events } = makeRunner("hash-failure", { agents: { has: () => true, compiledFile: () => file } });
  await turn(runner, events, "hf", CODEX, "ECHO first", "workflow");
  const storeFile = path.join(TMP, "hash-failure", "claude-sessions.json");
  runner.flushNow();
  const before = JSON.parse(readFileSync(storeFile, "utf8")).sessions.hf;
  writeFileSync(file, "malformed");
  const fail = await turn(runner, events, "hf", CODEX, "ECHO MUST_NOT_EXECUTE", "workflow");
  assert.match(textOf(fail.answer), /Codex.*(?:роль|профил)/i);
  runner.flushNow();
  const after = JSON.parse(readFileSync(storeFile, "utf8")).sessions.hf;
  assert.equal(after.codexSid, before.codexSid);
  assert.equal(after.codexInstructionsHash, before.codexInstructionsHash);
  writeFileSync(file, JSON.stringify({ workflow: { prompt: "SECOND_ROLE" } }));
  const retry = await turn(runner, events, "hf", CODEX, "ECHO retry", "workflow");
  assert.ok(!JSON.parse(textOf(retry.answer)).argv.includes("--resume"));
});

test("legacy Codex sid with unknown instructions refreshes once with bounded visible context", async () => {
  const dir = path.join(TMP, "legacy-hash");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "claude-sessions.json"), JSON.stringify({ version: 1, sessions: { legacy: {
    directory: TMP, codexSid: "legacy-native", messages: [
      { info: { id: "old-user", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "x".repeat(20000) + " OLD_MEMORY file D:/notes.txt" }] },
      { info: { id: "old-asst", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "VISIBLE_ANSWER" }, { type: "tool", tool: "Bash", state: { input: { command: "EXECUTE_OLD_TOOL" } } }] },
    ],
  } } }));
  const { runner, events } = makeRunner("legacy-hash");
  const first = await turn(runner, events, "legacy", CODEX, "ECHO current");
  const echo = JSON.parse(textOf(first.answer));
  assert.ok(!echo.argv.includes("--resume"));
  assert.match(echo.prompt, /OLD_MEMORY file D:\/notes.txt/);
  assert.match(echo.prompt, /VISIBLE_ANSWER/);
  assert.match(echo.prompt, /сокращено.*журнал/s);
  assert.ok(!echo.prompt.includes("EXECUTE_OLD_TOOL"));
  assert.ok(echo.prompt.length < 14000);
  assert.equal(runner.messages("legacy").length, 4, "portal history remains intact");
  const second = await turn(runner, events, "legacy", CODEX, "ECHO continue");
  assert.ok(JSON.parse(textOf(second.answer).replace(/\(resumed\)/g, "")).argv.includes("--resume"));
});

test("failed native spawn keeps the last successful Codex sid/hash association", async () => {
  const bin = path.join(TMP, "temporary-codex.mjs");
  const source = readFileSync(FAKE, "utf8");
  writeFileSync(bin, source);
  const profile = path.join(TMP, "spawn-profile.json");
  writeFileSync(profile, JSON.stringify({ workflow: { prompt: "FIRST" } }));
  const { runner, events } = makeRunner("spawn-hash", { codexBin: bin, agents: { has: () => true, compiledFile: () => profile } });
  await turn(runner, events, "spawn", CODEX, "ECHO first", "workflow");
  const store = path.join(TMP, "spawn-hash", "claude-sessions.json");
  runner.flushNow();
  const before = JSON.parse(readFileSync(store, "utf8")).sessions.spawn;
  rmSync(bin);
  await turn(runner, events, "spawn", CODEX, "ECHO clear");
  runner.flushNow();
  const after = JSON.parse(readFileSync(store, "utf8")).sessions.spawn;
  assert.equal(after.codexSid, before.codexSid);
  assert.equal(after.codexInstructionsHash, before.codexInstructionsHash);
  writeFileSync(bin, source);
  const retry = await turn(runner, events, "spawn", CODEX, "ECHO retry clear");
  assert.ok(!JSON.parse(textOf(retry.answer)).argv.includes("--resume"));
});

test("Codex catalog failures never run an unprofiled turn and leave the chat idle", async () => {
  for (const [name, agents] of [
    ["throws", { has: () => true, compiledFile() { throw new Error("disk failed"); } }],
    ["null", { has: () => true, compiledFile: () => null }],
    ["missing", { has: () => false }],
  ]) {
    const { runner, events } = makeRunner(`profile-${name}`, { agents });
    const r = await turn(runner, events, name, CODEX, "ECHO MUST_NOT_EXECUTE", "workflow");
    assert.match(textOf(r.answer), /Codex.*(?:роль|профил)/i);
    assert.ok(!textOf(r.answer).includes("MUST_NOT_EXECUTE"));
    assert.ok(events.some((e) => e.type === "session.idle" && e.properties?.sessionID === name));
    const recovery = await turn(runner, events, name, CODEX, "ECHO recovered");
    assert.ok(JSON.parse(textOf(recovery.answer)).argv.includes("--model"), "next turn can run");
  }
});

test("модель Codex: ход идёт через посредника, ответ помечен openai-codex, codexSid отдельно", async () => {
  const { runner, events } = makeRunner("route");
  assert.equal(runner.engineOfModel("gpt-6.1-sol"), "codex");
  assert.equal(runner.engineOfModel("claude-haiku-4-5"), "claude");
  const r1 = await turn(runner, events, "c1", CODEX, "ECHO привет");
  assert.equal(r1.status, 204);
  assert.equal(r1.answer.info.providerID, "openai-codex");
  assert.equal(r1.answer.info.modelID, "gpt-6.1-sol");
  const echo = JSON.parse(textOf(r1.answer));
  assert.ok(echo.argv.includes("--model") && echo.argv.includes("gpt-6.1-sol"));
  assert.ok(!echo.argv.includes("--resume"), "первый ход — новый разговор");
  assert.ok(!echo.argv.includes("--agents"));
  // второй ход Codex продолжает свой разговор
  const r2 = await turn(runner, events, "c1", CODEX, "ECHO ещё");
  const argv2 = JSON.parse(textOf(r2.answer).replace(/\(resumed\)/g, "")).argv;
  const i = argv2.indexOf("--resume");
  assert.ok(i > 0, "второй ход Codex идёт с --resume");
  // Claude-ход в том же чате не получает id разговора Codex
  const r3 = await turn(runner, events, "c1", HAIKU, "ECHO claude");
  assert.equal(r3.answer.info.providerID, "anthropic");
  const argv3 = JSON.parse(textOf(r3.answer).replace(/\(resumed\)/g, "")).argv;
  assert.ok(!argv3.includes("--resume"), "Claude начинает свой разговор, а не продолжает Codex");
});

test("откат хода Codex отклоняется понятной ошибкой", async () => {
  const { runner, events } = makeRunner("undo");
  await turn(runner, events, "u1", CODEX, "ECHO x");
  const last = runner.messages("u1").filter((m) => m.info.role === "user").at(-1).info.id;
  const r = runner.revert("u1", last);
  assert.equal(r.status, 409);
  assert.match(r.error, /Codex/);
  assert.equal(runner.revertPreview("u1", last).status, 409);
});

test("без каталога Codex модель Codex не проходит (400), Claude работает", async () => {
  const { runner, events } = makeRunner("off", { catalog: null });
  assert.equal(runner.engineOfModel("gpt-6.1-sol"), null);
  const r = await turn(runner, events, "o1", CODEX, "ECHO x");
  assert.equal(r.status, 400);
  const ok = await turn(runner, events, "o2", HAIKU, "ECHO y");
  assert.equal(ok.status, 204);
});

test("каталог провайдеров: Codex добавлен только с непустым каталогом, основная модель — по умолчанию", () => {
  const base = providerPatch({ connected: ["zai-coding-plan"], all: [] });
  assert.equal(codexProviderPatch(base, []), base);
  const out = codexProviderPatch(base, [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol", context: 475000, isDefault: true }, { id: "gpt-6-astra", name: "GPT-6-Astra", context: 475000 }]);
  assert.ok(out.connected.includes("openai-codex") && out.connected.includes("anthropic"));
  const p = out.all.find((x) => x.id === "openai-codex");
  assert.deepEqual(Object.keys(p.models), ["gpt-6.1-sol", "gpt-6-astra"]);
  assert.equal(p.models["gpt-6.1-sol"].limit.context, 475000);
  assert.equal(out.default["openai-codex"], "gpt-6.1-sol");
});

test("FEAT-18.7: «Правки без вопросов» в Codex-ходе идут как «Спрашивать» (мост разрешений), в Claude-ходе — как были", async () => {
  const { runner, events } = makeRunner("edits");
  const run = async (sid, model) => {
    let status = null;
    await runner.dispatch({ res: { writeHead(s) { status = s; }, end() {} }, sid, dir: TMP, permMode: "edits", body: Buffer.from(JSON.stringify({ model, parts: [{ type: "text", text: "ECHO режим" }] })) });
    const end = Date.now() + 15_000;
    while (!events.some((e) => e.type === "session.idle" && e.properties?.sessionID === sid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return JSON.parse(textOf(runner.messages(sid).at(-1)).replace(/\(resumed\)/g, "")).argv;
  };
  const cx = await run("e1", CODEX);
  assert.equal(cx[cx.indexOf("--input-format") + 1], "stream-json", "Codex: мост разрешений");
  assert.ok(cx.includes("--permission-prompt-tool"));
  const cl = await run("e2", HAIKU);
  assert.equal(cl[cl.indexOf("--input-format") + 1], "stream-json", "Claude: ввод stream-json (BUG-237), но без моста");
  assert.equal(cl.includes("--permission-prompt-tool"), false);
});
