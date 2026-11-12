// FEAT-01.77 (tasks 1.3): занятость чата Claude, пока работает субагент, и
// «Стоп». Запуск агента всегда асинхронный: `result` закрывает ход, а CLI
// живёт в хвосте (BUG-184), ожидая task_notification. Раньше чат на этом
// промежутке мигал idle, а события субагента в хвосте пропадали — zaiRun
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
const TMP = mkdtempSync(path.join(tmpdir(), "zai-claude-subagent-"));
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
const zaiOf = (msg) => msg.parts.find((p) => p.type === "tool")?.state?.metadata?.zaiRun ?? null;

test("FEAT-01.77: между result и уведомлением о задаче чат занят и не мигает idle; после раунда — свободен", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "sa1", dir: TMP, body: body("SUBAGENT700 запусти") });
  // первый ответ готов (result пришёл), субагент ещё работает в хвосте
  assert.ok(await waitUntil(() => (runner.messages("sa1")?.length ?? 0) >= 2, 8000), "первый ответ сохранён");
  assert.deepEqual(runner.busySnapshot(), { sa1: { type: "busy" } }, "чат занят между result и уведомлением (busySnapshot — тот же признак, что у healthz)");
  assert.equal(hub.events.filter((x) => x.event.type === "session.idle").length, 0, "в idle между раундами CLI не мигает");

  // хвост: субагент завершился → запуск completed; затем раунд CLI → busy → idle
  await waitIdle(hub, 2, 15_000);
  const msgs = runner.messages("sa1");
  assert.deepEqual(msgs.map((m) => m.info.role), ["user", "assistant", "assistant"], "ответ по уведомлению — второй ответ в чате");
  assert.match(textOf(msgs[2]), /В папке два файла/);
  assert.deepEqual(runner.busySnapshot(), {}, "после завершения чат свободен");

  const z = zaiOf(msgs[1]);
  assert.ok(z, "у первого ответа есть часть Task с zaiRun");
  assert.equal(z.status, "completed", "запуск доведён до completed даже в хвосте");
  assert.ok(Number.isFinite(z.startedAt) && Number.isFinite(z.endedAt), "времена запуска заданы");
  assert.deepEqual(z.steps.map((s) => [s.tool, s.status]), [["bash", "done"]], "шаг субагента из хвоста дошел до части");
  assert.match(z.output, /Результаты/, "текст субагента в zaiRun.output");
  assert.equal(textOf(msgs[1]).includes("Результаты"), false, "текст субагента не в ответе основной беседы");
  runner.shutdown();
});

test("FEAT-01.77: «Стоп» посреди работы субагента — запуск stopped с endedAt, доставлен клиенту и сохранён", async () => {
  const { hub, runner } = mk();
  await runner.dispatch({ res: fakeRes(), sid: "sa2", dir: TMP, body: body("SUBAGENTSTOP") });
  assert.ok(await waitUntil(() => (runner.messages("sa2")?.length ?? 0) >= 2, 8000), "первый ответ сохранён");
  assert.ok(runner.busySnapshot()["sa2"], "субагент работает — чат занят");
  assert.ok(await waitUntil(() => zaiOf(runner.messages("sa2")[1])?.steps?.length >= 1, 8000), "шаг субагента дошел до части до остановки");

  runner.abort("sa2");
  assert.ok(
    await waitUntil(() => zaiOf(runner.messages("sa2")[1])?.status === "stopped", 8000),
    "zaiRun.status = stopped в сохранённой истории",
  );
  const z = zaiOf(runner.messages("sa2")[1]);
  assert.equal(z.status, "stopped");
  assert.ok(Number.isFinite(z.endedAt), "endedAt при остановке задан");
  assert.ok(
    hub.events.some((x) => x.event.type === "message.part.updated" && x.event.properties.part?.state?.metadata?.zaiRun?.status === "stopped"),
    "остановка доставлена клиенту событием message.part.updated",
  );
  assert.ok(await waitUntil(() => !runner.busySnapshot()["sa2"], 8000), "после остановки чат свободен");
  assert.equal(hub.events.some((x) => x.event.type === "session.idle"), true, "idle пришёл после остановки");
  runner.shutdown();
});
