// FEAT-01.77 (tasks 1.3): занятость чата Claude, пока работает субагент, и
// «Стоп». Запуск агента всегда асинхронный: `result` закрывает ход, а CLI
// живёт в хвосте (BUG-184), ожидая task_notification. Раньше чат на этом
// промежутке мигал idle, а события субагента в хвосте пропадали — teleharnessRun
// части Task оставался «running» в истории навсегда. Сценарий — фейковый CLI
// "SUBAGENT<ms>", воспроизводящий последовательность живой фикстуры
// claude-stream-subagent-2.1.322.jsonl с паузой между result и уведомлением.
// Run: node --test --test-timeout=60000 tests/claude-subagent-busy.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRunner } from "../lib/claude.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const TMP = mkdtempSync(path.join(tmpdir(), "teleharness-claude-subagent-"));
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
async function waitUntil(pred, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(25);
  }
  return false;
}
async function waitIdle(hub, count = 1, ms = 15_000) {
  const ok = await waitUntil(() => hub.events.filter((x) => x.event.type === "session.idle").length >= count, ms);
  assert.ok(ok, `нет session.idle #${count}`);
}
const mk = () => {
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000, log: () => {} });
  return { hub, runner };
};
const teleharnessOf = (msg) => msg.parts.find((p) => p.type === "tool")?.state?.metadata?.teleharnessRun ?? null;

test("FEAT-01.77: между result и уведомлением о задаче чат занят и не мигает idle; после раунда — свободен", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "sa1", dir: TMP, body: body("SUBAGENT700 запусти") });
  // первый ответ готов (result пришёл), субагент ещё работает в хвосте
  assert.ok(await waitUntil(() => (runner.messages("sa1")?.length ?? 0) >= 2, 8000), "первый ответ сохранён");
  assert.deepEqual(runner.busySnapshot(), { sa1: { type: "busy", bg: true } }, "чат занят между result и уведомлением (busySnapshot — тот же признак, что у healthz); BUG-237: bg — только фоновые агенты");
  assert.equal(hub.events.filter((x) => x.event.type === "session.idle").length, 0, "в idle между раундами CLI не мигает");

  // хвост: субагент завершился → запуск completed; затем раунд CLI → busy → idle
  await waitIdle(hub, 2, 15_000);
  const msgs = runner.messages("sa1");
  assert.deepEqual(msgs.map((m) => m.info.role), ["user", "assistant", "assistant"], "ответ по уведомлению — второй ответ в чате");
  assert.match(textOf(msgs[2]), /В папке два файла/);
  assert.deepEqual(runner.busySnapshot(), {}, "после завершения чат свободен");

  const z = teleharnessOf(msgs[1]);
  assert.ok(z, "у первого ответа есть часть Task с teleharnessRun");
  assert.equal(z.status, "completed", "запуск доведён до completed даже в хвосте");
  assert.ok(Number.isFinite(z.startedAt) && Number.isFinite(z.endedAt), "времена запуска заданы");
  assert.deepEqual(z.steps.map((s) => [s.tool, s.status]), [["bash", "done"]], "шаг субагента из хвоста дошел до части");
  assert.match(z.output, /Результаты/, "текст субагента в teleharnessRun.output");
  assert.equal(textOf(msgs[1]).includes("Результаты"), false, "текст субагента не в ответе основной беседы");
  runner.shutdown();
});

test("FEAT-01.77: «Стоп» посреди работы субагента — запуск stopped с endedAt, доставлен клиенту и сохранён", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "sa2", dir: TMP, body: body("SUBAGENTSTOP") });
  assert.ok(await waitUntil(() => (runner.messages("sa2")?.length ?? 0) >= 2, 8000), "первый ответ сохранён");
  assert.ok(runner.busySnapshot()["sa2"], "субагент работает — чат занят");
  assert.ok(await waitUntil(() => teleharnessOf(runner.messages("sa2")[1])?.steps?.length >= 1, 8000), "шаг субагента дошел до части до остановки");

  runner.abort("sa2");
  assert.ok(
    await waitUntil(() => teleharnessOf(runner.messages("sa2")[1])?.status === "stopped", 8000),
    "teleharnessRun.status = stopped в сохранённой истории",
  );
  const z = teleharnessOf(runner.messages("sa2")[1]);
  assert.equal(z.status, "stopped");
  assert.ok(Number.isFinite(z.endedAt), "endedAt при остановке задан");
  assert.ok(
    hub.events.some((x) => x.event.type === "message.part.updated" && x.event.properties.part?.state?.metadata?.teleharnessRun?.status === "stopped"),
    "остановка доставлена клиенту событием message.part.updated",
  );
  assert.ok(await waitUntil(() => !runner.busySnapshot()["sa2"], 8000), "после остановки чат свободен");
  assert.equal(hub.events.some((x) => x.event.type === "session.idle"), true, "idle пришёл после остановки");
  runner.shutdown();
});

// BUG-237: ввод stream-json — фоновый субагент живёт после `result` (stdin открыт); новое сообщение
// не гасит его, а ждёт в очереди и уходит после раунда-уведомления.
test("BUG-237: сообщение, пока фоновый субагент работает, — в очереди; субагент доработал, затем новый ход", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "sa3", dir: TMP, body: body("SUBAGENT2000 запусти") });
  assert.ok(await waitUntil(() => (runner.messages("sa3")?.length ?? 0) >= 2, 8000), "первый ответ сохранён");
  assert.ok(runner.busySnapshot()["sa3"], "субагент работает — чат занят");
  const res = fakeRes();
  await runner.dispatch({ res, sid: "sa3", dir: TMP, body: body("ECHO второй вопрос") });
  assert.equal(res.code, 204, "сообщение принято");
  await sleep(300);
  assert.equal(teleharnessOf(runner.messages("sa3")[1])?.status, "running", "субагент не остановлен новым сообщением");
  // субагент доработал → раунд-уведомление → процесс вышел → очередь: ход на «второй вопрос»
  assert.ok(await waitUntil(() => runner.messages("sa3").some((m) => m.info.role === "assistant" && textOf(m).includes("второй вопрос")), 20_000), "новый ход ответил на второе сообщение");
  const msgs = runner.messages("sa3");
  assert.equal(teleharnessOf(msgs[1])?.status, "completed", "субагент доведён до конца, а не убит");
  assert.ok(msgs.some((m) => m.info.role === "assistant" && /В папке два файла/.test(textOf(m))), "ответ по уведомлению на месте");
  await waitIdle(hub, 1, 15_000);
  runner.shutdown();
});

test("BUG-237: stdin закрывается после ответа, когда фоновых задач нет — процесс не висит", async () => {
  const { hub, runner } = mk();
  const started = Date.now();
  await runner.dispatch({ res: fakeRes(), sid: "sa4", dir: TMP, body: body("ECHO просто ответ") });
  await waitIdle(hub, 1, 8000);
  assert.ok(await waitUntil(() => !runner.liveness()["sa4"] && !runner.busySnapshot()["sa4"], 8000), "ход завершён, чат свободен");
  assert.ok(Date.now() - started < 8000, "процесс CLI не ждал 30 с закрытия stdin");
  runner.shutdown();
});

test("BUG-237: CLI открыл свой раунд, пока субагент работает, — чат всё ещё занят, новое сообщение ждёт в очереди", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "sa5", dir: TMP, body: body("SUBAGENT3000 MIDROUND запусти") });
  // первый ответ и раунд CLI «Субагент ещё работает.» — оба до завершения субагента
  assert.ok(await waitUntil(() => runner.messages("sa5")?.some((m) => textOf(m).includes("Субагент ещё работает")), 10_000), "раунд CLI посреди работы субагента");
  await sleep(200);
  assert.ok(runner.busySnapshot()["sa5"], "после такого раунда чат занят — субагент работает по списку задач CLI");
  const res = fakeRes();
  await runner.dispatch({ res, sid: "sa5", dir: TMP, body: body("ECHO третий вопрос") });
  await sleep(300);
  const agentMsg = runner.messages("sa5").find((m) => teleharnessOf(m));
  assert.equal(teleharnessOf(agentMsg)?.status, "running", "сообщение не убило субагента");
  assert.ok(await waitUntil(() => runner.messages("sa5").some((m) => m.info.role === "assistant" && textOf(m).includes("третий вопрос")), 20_000), "сообщение из очереди отвечено");
  const msgs = runner.messages("sa5");
  assert.ok(msgs.some((m) => /В папке два файла/.test(textOf(m))), "ответ по уведомлению пришёл раньше очереди");
  assert.equal(teleharnessOf(msgs.find((m) => teleharnessOf(m)))?.status, "completed");
  await waitIdle(hub, 1, 15_000);
  runner.shutdown();
});

test("BUG-237: после ответа, пока работает только фоновый субагент, — статус busy с признаком bg (клиенту — полоса, а не «Работает»)", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "sa6", dir: TMP, body: body("SUBAGENT1500 запусти") });
  assert.ok(await waitUntil(() => (runner.messages("sa6")?.length ?? 0) >= 2, 8000), "первый ответ сохранён");
  assert.ok(hub.events.some((x) => x.event.type === "session.status" && x.event.properties.sessionID === "sa6" && x.event.properties.status?.bg === true), "событие busy+bg после ответа");
  assert.deepEqual(runner.busySnapshot().sa6, { type: "busy", bg: true }, "в /status тоже bg");
  await waitIdle(hub, 1, 15_000);
  runner.shutdown();
});
