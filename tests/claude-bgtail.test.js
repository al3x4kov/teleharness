// BUG-184 (BUG-13.25): the answer was complete, but the claude CLI stayed alive
// waiting for a background task of the agent (Bash run_in_background) — the
// portal closed the turn only on process exit, so the chat showed «Работает»
// for 38 min and the owner's next message waited in the queue (2026-11-07).
// Now the turn closes on the CLI's `result`; the process lives on as a «tail»;
// a new message stops the tail and starts at once; a round the tail runs on its
// own (task notification) becomes one more answer.
// Run: node --test tests/claude-bgtail.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRunner } from "../lib/claude.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const TMP = mkdtempSync(path.join(tmpdir(), "zai-claude-bgtail-"));
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
  return { events, managed: new Set(), markManaged() {}, emit: (event, dir) => events.push({ event, dir, at: Date.now() }) };
};
const body = (text) => Buffer.from(JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, parts: [{ type: "text", text }] }));
const fakeRes = () => ({ code: 0, writeHead(c) { this.code = c }, end() {} });
async function waitIdle(hub, count = 1, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (hub.events.filter((x) => x.event.type === "session.idle").length >= count) return;
    await sleep(25);
  }
  throw new Error(`no session.idle #${count}`);
}
// busy frames after the first answer's idle (the first turn itself sends several)
const busyAfterFirstIdle = (hub) => {
  const i = hub.events.findIndex((x) => x.event.type === "session.idle");
  return i < 0 ? 0 : hub.events.slice(i).filter((x) => x.event.type === "session.status" && x.event.properties.status.type === "busy").length;
};
const mk = () => {
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, log: () => {} });
  return { hub, runner };
};

test("BUG-184: ответ готов (result), CLI ждёт фоновую задачу → ход закрыт сразу, не по выходу процесса", async () => {
  const { hub, runner } = mk();
  const t0 = Date.now();
  await runner.dispatch({ res: fakeRes(), sid: "b1", dir: TMP, body: body("BGTAIL6000 привет") });
  await waitIdle(hub, 1, 4000);
  assert.ok(Date.now() - t0 < 4000, "idle задолго до выхода процесса (6 с)");
  const [, asst] = runner.messages("b1");
  assert.equal(asst.info.role, "assistant");
  assert.ok(asst.info.time.completed, "ответ закрыт");
  assert.equal(asst.info.zai, undefined, "не прерван и не «crash» (BUG-182)");
  assert.match(textOf(asst), /Привет, мир!/);
  assert.deepEqual(runner.busySnapshot(), {}, "чат не занят — healthz/статус и очередь свободны");
  assert.equal(runner.abort("b1"), false, "Стоп нечего останавливать");
  runner.shutdown();
});

test("BUG-184: новое сообщение, пока хвост ждёт, не встаёт в очередь — хвост останавливается, ход стартует сразу", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "b2", dir: TMP, body: body("BGTAIL20000 первый") });
  await waitIdle(hub, 1, 4000);
  const t1 = Date.now();
  await runner.dispatch({ res: fakeRes(), sid: "b2", dir: TMP, body: body("второй") });
  await waitIdle(hub, 2, 6000);
  assert.ok(Date.now() - t1 < 6000, "второй ответ не ждал 20 с хвоста");
  const msgs = runner.messages("b2");
  assert.deepEqual(msgs.map((m) => m.info.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(msgs[1].info.zai, undefined, "первый ответ не помечен прерванным");
  assert.match(textOf(msgs[3]), /Привет, мир! \(resumed\)/, "второй ход продолжает ту же сессию CLI");
  assert.ok(!hub.events.some((x) => x.event.type === "message.part.updated" && /В очереди|Отменено/.test(x.event.properties?.part?.text ?? "")), "ничего не отменено");
  runner.shutdown();
});

test("BUG-184: раунд, который хвост запускает сам (уведомление о фоновой задаче), — ещё один ответ в чате", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "b3", dir: TMP, body: body("BGTAIL400 BGROUND запусти") });
  await waitIdle(hub, 1, 4000);
  await waitIdle(hub, 2, 6000);
  const msgs = runner.messages("b3");
  assert.deepEqual(msgs.map((m) => m.info.role), ["user", "assistant", "assistant"]);
  assert.match(textOf(msgs[1]), /Привет, мир!/);
  assert.match(textOf(msgs[2]), /Фоновая задача завершилась\./);
  assert.equal(msgs[2].info.parentID, msgs[0].info.id);
  assert.ok(msgs[2].info.time.completed && msgs[2].info.zai === undefined);
  assert.equal(busyAfterFirstIdle(hub), 1, "на свой раунд чат снова «работает»");
  runner.shutdown();
});

test("BUG-184: сообщение во время собственного раунда хвоста — в очередь, как к любому идущему ответу", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "b4", dir: TMP, body: body("BGTAIL300 BGROUND раз") });
  await waitIdle(hub, 1, 4000);
  // ждём старт раунда хвоста (второй busy)
  const end = Date.now() + 5000;
  while (Date.now() < end && busyAfterFirstIdle(hub) < 1) await sleep(10);
  await runner.dispatch({ res: fakeRes(), sid: "b4", dir: TMP, body: body("два") });
  await waitIdle(hub, 2, 8000);
  const end2 = Date.now() + 8000;
  while (Date.now() < end2 && runner.messages("b4").length < 5) await sleep(25);
  const roles = runner.messages("b4").map((m) => m.info.role);
  assert.equal(roles.filter((r) => r === "assistant").length, 3, roles.join(","));
  assert.ok(!runner.messages("b4").some((m) => m.info.zai?.interrupted), "никто не прерван");
  runner.shutdown();
});

test("BUG-184: сообщение, пришедшее пока хвост гасится не новым ходом (Отменить ход), всё равно стартует", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "b5", dir: TMP, body: body("BGTAIL20000 раз") });
  await waitIdle(hub, 1, 4000);
  const [u] = runner.messages("b5");
  const r = runner.revert ? runner.revert("b5", u.info.id) : null; // гасит хвост (#rewindProblem → #dropTail)
  if (!r) runner.abort("b5");
  await runner.dispatch({ res: fakeRes(), sid: "b5", dir: TMP, body: body("два") });
  await waitIdle(hub, 2, 8000);
  const all = runner.messages("b5");
  assert.deepEqual(all.map((m) => m.info.role), ["user", "assistant"], "отменённый ход убран, хотя хвост ещё гас (revert зафиксирован)");
  const last = all.at(-1);
  assert.equal(last.info.role, "assistant");
  assert.match(textOf(last), /Привет, мир!/);
  runner.shutdown();
});

test("BUG-184: возобновлённый CLI сначала отрабатывает пустой раунд по уведомлению убитой задачи — ответ не «(пустой ответ)», а настоящий", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "b6", dir: TMP, body: body("STALEBG ответь") });
  await waitIdle(hub, 1, 6000);
  const msgs = runner.messages("b6");
  assert.deepEqual(msgs.map((m) => m.info.role), ["user", "assistant"], "один ответ, без пустого");
  assert.match(textOf(msgs[1]), /Привет, мир!/);
  assert.equal(msgs[1].info.zai, undefined);
  runner.shutdown();
});

test("BUG-184: процесс дал только пустой раунд и вышел — честный «(пустой ответ)», не «crash»", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "b7", dir: TMP, body: body("EMPTYONLY") });
  await waitIdle(hub, 1, 6000);
  const [, asst] = runner.messages("b7");
  assert.match(textOf(asst), /пустой ответ/);
  assert.equal(asst.info.zai, undefined, "не помечен «crash»");
  runner.shutdown();
});

test("BUG-184: пустой раунд, который хвост запустил сам, в чат не попадает", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "b8", dir: TMP, body: body("BGTAIL300 BGEMPTY раз") });
  await waitIdle(hub, 1, 4000);
  await sleep(1500);
  const msgs = runner.messages("b8");
  assert.deepEqual(msgs.map((m) => m.info.role), ["user", "assistant"], msgs.map((m) => textOf(m)).join(" | "));
  assert.deepEqual(runner.busySnapshot(), {});
  const updated = hub.events.filter((x) => x.event.type === "message.updated" && x.event.properties.info.role === "assistant").map((x) => x.event.properties.info.id);
  const removed = hub.events.filter((x) => x.event.type === "message.removed").map((x) => x.event.properties.messageID);
  const extra = [...new Set(updated)].filter((id) => id !== msgs[1].info.id);
  assert.deepEqual(extra.filter((id) => !removed.includes(id)), [], "открытый для пустого раунда ответ убран с экрана");
  runner.shutdown();
});

// FEAT-04.12 stage B: a tenant chat with its own subfolder — the CLI runs THERE
// (cwd, transcript, resume), the tenant root stays readable (--add-dir).
test("FEAT-04.12 Б: ход тенанта с подпапкой чата — CLI в подпапке, --add-dir корня, история продолжается из подпапки", async () => {
  const root = path.join(TMP, "tenant-root");
  const work = path.join(root, "chats", "abc");
  mkdirSync(work, { recursive: true });
  const cfg = path.join(TMP, "claude-cfg");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, log: () => {}, env: { ...process.env, CLAUDE_CONFIG_DIR: cfg }, projectsDir: path.join(cfg, "projects") });
  await runner.dispatch({ res: fakeRes(), sid: "ses_abc", dir: root, workDir: work, body: body("ECHO первый") });
  await waitIdle(hub, 1, 6000);
  const echo = JSON.parse(textOf(runner.messages("ses_abc")[1]));
  assert.equal(path.resolve(echo.cwd).toLowerCase(), path.resolve(work).toLowerCase(), "CLI запущен в подпапке чата");
  const i = echo.argv.indexOf("--add-dir");
  assert.ok(echo.argv.some((a, k) => a === "--add-dir" && path.resolve(echo.argv[k + 1]).toLowerCase() === path.resolve(root).toLowerCase()), "корень тенанта доступен: " + echo.argv.join(" "));
  await runner.dispatch({ res: fakeRes(), sid: "ses_abc", dir: root, workDir: work, body: body("HISTORY") });
  await waitIdle(hub, 2, 6000);
  assert.deepEqual(JSON.parse(textOf(runner.messages("ses_abc")[3])), ["ECHO первый"], "второй ход продолжил транскрипт подпапки");
  const evDirs = new Set(hub.events.map((x) => x.dir));
  assert.deepEqual([...evDirs], [root], "события чата — в папке сессии (корень), не в подпапке");
  runner.shutdown();
});
