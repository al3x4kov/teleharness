// FEAT-18.5: расход хода Claude в info ответа — токены хода (сумма вызовов из
// `result`), занятость окна последним вызовом основного разговора
// (tokens.context), окно модели от CLI (contextWindow) и условная цена API
// (cost; клиент для подписки её не показывает).
// Run: node --test --test-concurrency=1 tests/claude-usage.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRunner, claudeTurnUsage, translateEvent } from "../lib/claude.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const TMP = mkdtempSync(path.join(tmpdir(), "teleharness-claude-usage-"));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

test("claudeTurnUsage: на реальной ленте CLI 2.1.322 — сумма хода, контекст последнего вызова, окно и цена", () => {
  const lines = readFileSync(path.join(ROOT, "tests", "fixtures", "claude-stream-subagent-2.1.322.jsonl"), "utf8").split("\n");
  // в записи строки result обоих раундов лежат в конце файла — контекст
  // первого раунда берём до второго `system init`
  let lastUsage = null;
  let result = null;
  let inits = 0;
  for (const l of lines) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type === "system" && e.subtype === "init") inits += 1;
    if (inits === 1 && e.type === "assistant" && !e.parent_tool_use_id && e.message?.usage) lastUsage = e.message.usage;
    if (e.type === "result" && !result) result = translateEvent(e);
  }
  const out = claudeTurnUsage(result, lastUsage, "claude-haiku-4-5");
  assert.deepEqual(out.tokens, { input: 17, output: 388, reasoning: 0, cache: { read: 45725, write: 9220 }, total: 17 + 388 + 45725 + 9220, context: 8 + 26988 + 969 });
  assert.equal(out.contextWindow, 200000);
  assert.ok(Math.abs(out.cost - 0.05584425) < 1e-9);
});

test("claudeTurnUsage: без assistant-usage — последний элемент iterations; без usage и modelUsage — пусто", () => {
  const sig = translateEvent({ type: "result", usage: { input_tokens: 5, output_tokens: 1, iterations: [{ input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 3 }] } });
  assert.equal(claudeTurnUsage(sig, null, "x").tokens.context, 105);
  assert.equal(claudeTurnUsage(sig).contextWindow, undefined, "окна нет — поля нет");
  assert.equal(claudeTurnUsage(sig).cost, undefined, "цены нет — поля нет (не 0)");
  assert.deepEqual(claudeTurnUsage(translateEvent({ type: "result", result: "ok" }), null, "x"), {});
  assert.deepEqual(claudeTurnUsage(null, null, null), {});
  // несколько моделей в modelUsage — берётся модель чата, чужая не подставляется
  const many = translateEvent({ type: "result", modelUsage: { a: { contextWindow: 1000 }, b: { contextWindow: 2000 } } });
  assert.equal(claudeTurnUsage(many, null, "b").contextWindow, 2000);
  assert.equal(claudeTurnUsage(many, null, "c").contextWindow, undefined);
});

test("раннер: info ответа несёт tokens/context/contextWindow/cost; usage субагента в контекст не идёт", async () => {
  const dir = path.join(TMP, "data");
  mkdirSync(dir, { recursive: true });
  const events = [];
  const hub = { events, managed: new Set(), markManaged() {}, emit: (event) => events.push(event) };
  const runner = new ClaudeRunner({ hub, storePath: path.join(dir, "claude-sessions.json"), binPath: FAKE, keepaliveMs: 1000, log: () => {} });
  const body = Buffer.from(JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, parts: [{ type: "text", text: "USAGE" }] }));
  await runner.dispatch({ res: { writeHead() {}, end() {} }, sid: "u1", dir: TMP, body });
  const end = Date.now() + 15_000;
  while (!events.some((e) => e.type === "session.idle") && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const info = runner.messages("u1")[1].info;
  assert.deepEqual(info.tokens, { input: 17, output: 388, reasoning: 0, cache: { read: 45725, write: 9220 }, total: 55350, context: 8 + 26988 + 969 });
  assert.equal(info.contextWindow, 200000);
  assert.ok(Math.abs(info.cost - 0.05584425) < 1e-9);
  const live = events.filter((e) => e.type === "message.updated" && e.properties.info?.role === "assistant").at(-1).properties.info;
  assert.deepEqual(live.tokens, info.tokens, "живое обновление несёт те же цифры");
});
