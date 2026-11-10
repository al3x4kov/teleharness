// BUG-182 (BUG-13.24): a claude CLI process that dies on its own (out of memory,
// killed) without a `result` line used to close the turn as a normal answer —
// half a sentence, no mark, no «Продолжить». Now it is an interrupted turn
// (info.zai.interrupted = "crash") with a visible mark and a server log line.
// Run: node --test tests/claude-crash.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRunner } from "../lib/claude.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const TMP = mkdtempSync(path.join(tmpdir(), "zai-claude-crash-"));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
let seq = 0;
const freshStore = () => {
  const dir = path.join(TMP, `data-${++seq}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "claude-sessions.json");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n");
const stubHub = () => {
  const events = [];
  return { events, managed: new Set(), markManaged() {}, emit: (event, dir) => events.push({ event, dir }) };
};
const body = (text) => Buffer.from(JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, parts: [{ type: "text", text }] }));
const fakeRes = () => ({ code: 0, writeHead(c) { this.code = c }, end() {} });
async function waitIdle(hub, count = 1, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (hub.events.filter((x) => x.event.type === "session.idle").length >= count) return;
    await sleep(50);
  }
  throw new Error("no session.idle");
}
function runnerWithLog() {
  const hub = stubHub();
  const logs = [];
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, log: (m) => logs.push(String(m)) });
  return { hub, runner, logs };
}
const finalInfo = (hub) => hub.events.filter((x) => x.event.type === "message.updated" && x.event.properties.info?.role === "assistant").at(-1).event.properties.info;

test("CLI dies with a non-zero code and no result → interrupted «crash», mark with the code, log line with stderr tail", async () => {
  const { hub, runner, logs } = runnerWithLog();
  await runner.dispatch({ res: fakeRes(), sid: "c1", dir: TMP, body: body("CRASH please") });
  await waitIdle(hub);
  const [, asst] = runner.messages("c1");
  assert.equal(asst.info.zai?.interrupted, "crash");
  assert.equal(finalInfo(hub).zai?.interrupted, "crash", "the live update carries it too (front shows «не закончил / Продолжить»)");
  const text = textOf(asst);
  assert.match(text, /Начинаю работу/, "the partial work is kept");
  assert.match(text, /\[Прервано: процесс Claude завершился неожиданно \(код 134\)/);
  assert.match(text, /Продолжай/);
  const line = logs.find((l) => /BUG-182|unexpected exit|завершился/.test(l));
  assert.ok(line, logs.join("\n"));
  assert.match(line, /134/);
  assert.match(line, /allocation failed/, "stderr tail helps the diagnosis");
  assert.doesNotMatch(line, /CRASH please/, "the prompt never goes to the log");
});

test("exit code 0 without a result line is a crash too", async () => {
  const { hub, runner } = runnerWithLog();
  await runner.dispatch({ res: fakeRes(), sid: "c2", dir: TMP, body: body("CRASH0") });
  await waitIdle(hub);
  assert.equal(runner.messages("c2")[1].info.zai?.interrupted, "crash");
  assert.match(textOf(runner.messages("c2")[1]), /\(код 0\)/);
});

test("negative: a normal turn and an is_error result are not crashes", async () => {
  const { hub, runner } = runnerWithLog();
  await runner.dispatch({ res: fakeRes(), sid: "n1", dir: TMP, body: body("hello") });
  await waitIdle(hub);
  assert.equal(runner.messages("n1")[1].info.zai, undefined);
  assert.doesNotMatch(textOf(runner.messages("n1")[1]), /Прервано/);
  await runner.dispatch({ res: fakeRes(), sid: "n2", dir: TMP, body: body("FAIL now") });
  await waitIdle(hub, 2);
  assert.equal(runner.messages("n2")[1].info.zai, undefined);
  assert.doesNotMatch(textOf(runner.messages("n2")[1]), /неожиданно/);
});

test("negative: a user «Стоп» stays «[Прервано]», not crash", async () => {
  const { hub, runner } = runnerWithLog();
  await runner.dispatch({ res: fakeRes(), sid: "u1", dir: TMP, body: body("HANG") });
  await sleep(700);
  assert.equal(runner.abort("u1"), true);
  await waitIdle(hub);
  const a = runner.messages("u1")[1];
  assert.equal(a.info.zai?.interrupted, "user");
  assert.match(textOf(a), /\[Прервано\]/);
  assert.doesNotMatch(textOf(a), /неожиданно/);
});

test("after a crash the next turn resumes the same claude session (FEAT-13.12)", async () => {
  const { hub, runner } = runnerWithLog();
  await runner.dispatch({ res: fakeRes(), sid: "r1", dir: TMP, body: body("CRASH") });
  await waitIdle(hub);
  await runner.dispatch({ res: fakeRes(), sid: "r1", dir: TMP, body: body("Продолжай") });
  await waitIdle(hub, 2);
  const msgs = runner.messages("r1");
  assert.equal(msgs.length, 4);
  assert.equal(msgs[3].info.zai, undefined);
  assert.match(textOf(msgs[3]), /Привет, мир!/);
});
