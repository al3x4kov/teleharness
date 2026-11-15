// FEAT-18.7: один раннер CLI ведёт и Claude-, и Codex-ходы. Для модели из каталога
// Codex он запускает посредника (codexBin) вместо claude CLI; ответ помечен
// провайдером openai-codex; продолжение Codex (codexSid) хранится отдельно от
// claudeSid; откат хода Codex отклоняется; без каталога Codex модель не проходит.
// Посредник здесь — тот же фейковый CLI (протокол claude stream-json).
// Run: node --test --test-concurrency=1 tests/claude-codex-route.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

function makeRunner(name, { codexBin = FAKE, catalog = CATALOG } = {}) {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const events = [];
  const hub = { events, managed: new Set(), markManaged() {}, emit: (event) => events.push(event) };
  const runner = new ClaudeRunner({ hub, storePath: path.join(dir, "claude-sessions.json"), binPath: FAKE, codexBin, keepaliveMs: 1000, log: () => {} });
  if (catalog) runner.setCodexCatalog(catalog);
  return { runner, events };
}
async function turn(runner, events, sid, model, text) {
  const idleBefore = events.filter((e) => e.type === "session.idle" && e.properties?.sessionID === sid).length;
  let status = null;
  const res = { writeHead(s) { status = s; }, end() {} };
  await runner.dispatch({ res, sid, dir: TMP, body: Buffer.from(JSON.stringify({ model, parts: [{ type: "text", text }] })) });
  if (status !== 204) return { status };
  const end = Date.now() + 15_000;
  while (events.filter((e) => e.type === "session.idle" && e.properties?.sessionID === sid).length <= idleBefore && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const msgs = runner.messages(sid);
  return { status, answer: msgs.at(-1) };
}
const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");

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
  assert.equal(cl[cl.indexOf("--input-format") + 1], "text", "Claude: «Правки» без моста, как раньше");
});
