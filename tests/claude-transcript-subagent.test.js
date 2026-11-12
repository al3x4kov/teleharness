// FEAT-01.77 (tasks 1.2): работа субагента Claude в части инструмента Task.
// Вся фикстура claude-stream-subagent-2.1.322.jsonl (живая запись CLI 2.1.322:
// Agent → task_started → шаги PowerShell/Read субагента → task_updated →
// task_notification → два раунда основной беседы) прогоняется через
// ClaudeTranscript: события с parent_tool_use_id больше не отбрасываются —
// они достраивают state.metadata.zaiRun части task.
// Run: node --test --test-timeout=60000 tests/claude-transcript-subagent.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeTranscript } from "../lib/claude-transcript.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINES = readFileSync(path.join(HERE, "fixtures", "claude-stream-subagent-2.1.322.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const make = () => {
  let n = 0;
  let t = 1000;
  return new ClaudeTranscript({ sessionID: "s1", messageID: "a1", newId: () => `p${++n}`, now: () => (t += 10) });
};

// Клиентская сборка частей из операций транскрипта
function replay(ops, parts = []) {
  for (const op of ops) {
    if (op.op === "updated") {
      const i = parts.findIndex((p) => p.id === op.part.id);
      if (i < 0) parts.push(structuredClone(op.part));
      else parts[i] = { ...parts[i], ...structuredClone(op.part) };
    } else if (op.op === "delta") {
      const p = parts.find((x) => x.id === op.partID);
      p[op.field] = (p[op.field] ?? "") + op.delta;
    } else if (op.op === "removed") {
      parts.splice(parts.findIndex((p) => p.id === op.partID), 1);
    }
  }
  return parts;
}

test("FEAT-01.77: вся фикстура субагента — часть task с zaiRun: completed, времена, 2 шага (bash, read), ответ агента", () => {
  const tr = make();
  const ops = [];
  for (const evt of LINES) ops.push(...tr.feed(evt));
  ops.push(...tr.finish());
  const live = replay(ops);
  const stored = tr.parts();

  const task = stored.find((p) => p.type === "tool" && p.tool === "task");
  assert.ok(task, "часть инструмента Agent/task существует");
  assert.equal(task.callID, "toolu_01CeYQeu7VHoyxRCaQbJuJwk");
  const z = task.state.metadata?.zaiRun;
  assert.ok(z, "zaiRun в metadata части");
  assert.equal(z.status, "completed", "завершён по task_updated/task_notification");
  assert.equal(Number.isFinite(z.startedAt), true, "startedAt задан");
  assert.equal(z.endedAt, 1794382061707, "endedAt = patch.end_time из task_updated");
  assert.deepEqual(
    z.steps.map((s) => [s.tool, s.status]),
    [["bash", "done"], ["read", "done"]],
    "шаги PowerShell/Read субагента завершены (имена после toolName)",
  );
  assert.match(z.steps[0].object, /Get-ChildItem/, "короткий объект шага — команда");
  assert.match(z.steps[1].object, /a\.txt$/, "короткий объект шага — путь файла");
  assert.match(z.output, /a\.txt/, "итоговый текст агента в zaiRun.output");

  // история хранит то же, что клиент собрал из живых операций
  const storedTask = stored.find((p) => p.id === task.id);
  assert.deepEqual(storedTask.state.metadata, task.state.metadata, "zaiRun сохраняется для истории");
  assert.equal(live.find((p) => p.id === task.id).state.metadata.zaiRun.status, "completed");

  // текст субагента не попал в ответ основной беседы
  const answer = tr.text();
  assert.match(answer, /В папке два файла/, "ответ основной беседы на месте");
  assert.equal(answer.includes("Результаты"), false, "текста субагента нет в ответе");
  assert.equal(answer.includes("**Файлы в папке"), false);
  for (const p of stored.filter((x) => x.type === "text")) assert.equal(p.text.includes("Результаты"), false, "текст субагента не стал текстовой частью");
});

test("FEAT-01.77: task_started → running/startedAt; task_updated по task_id (без tool_use_id) находит свою часть", () => {
  const tr = make();
  const AG = "toolu_ag";
  const ops = [
    { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: AG, name: "Agent", input: {} } } },
    { type: "system", subtype: "task_started", task_id: "t7", tool_use_id: AG, description: "задача" },
  ].flatMap((e) => tr.feed(e));
  const mid = replay(ops);
  let z = mid.find((p) => p.tool === "task").state.metadata.zaiRun;
  assert.equal(z.status, "running");
  assert.ok(Number.isFinite(z.startedAt) && z.endedAt == null);

  const done = [
    { type: "system", subtype: "task_updated", task_id: "t7", patch: { status: "completed", end_time: 555 } },
    { type: "system", subtype: "task_notification", task_id: "t7", tool_use_id: AG, status: "completed" },
  ].flatMap((e) => tr.feed(e));
  assert.equal(done.length, 1, "повторное завершение — без новой операции");
  z = replay(done, structuredClone(mid)).find((p) => p.tool === "task").state.metadata.zaiRun;
  assert.equal(z.status, "completed");
  assert.equal(z.endedAt, 555);
});

test("FEAT-01.77: статусы завершения — failed/stopped/неизвестный; running в task_updated игнорируется", () => {
  const run = (events) => {
    const tr = make();
    const AG = "toolu_ag";
    [
      { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: AG, name: "Agent", input: {} } } },
      { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: AG },
    ].forEach((e) => tr.feed(e));
    const ops = events.flatMap((e) => tr.feed(e));
    return replay(ops, structuredClone(tr.parts())).find((p) => p.tool === "task").state.metadata.zaiRun;
  };
  assert.equal(run([{ type: "system", subtype: "task_notification", task_id: "t1", status: "failed" }]).status, "failed");
  assert.equal(run([{ type: "system", subtype: "task_notification", task_id: "t1", status: "stopped" }]).status, "stopped");
  assert.equal(run([{ type: "system", subtype: "task_notification", task_id: "t1", status: "wat" }]).status, "completed", "неизвестное завершение — completed");
  const ignored = run([{ type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "running" } }]);
  assert.equal(ignored.status, "running");
  assert.equal(ignored.endedAt, null, "running не завершает запуск");
});

test("FEAT-01.77: запуск без task_started — zaiRun строится лениво из трафика субагента; шаг без tool_result остаётся running", () => {
  const tr = make();
  const ops = [
    { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_x", name: "Agent", input: {} } } },
    { type: "assistant", parent_tool_use_id: "toolu_x", message: { id: "s1", content: [{ type: "tool_use", id: "toolu_s1", name: "Grep", input: { pattern: "todo", path: "src" } }] } },
    { type: "assistant", parent_tool_use_id: "toolu_x", message: { id: "s2", content: [{ type: "text", text: "почти готов" }] } },
  ].flatMap((e) => tr.feed(e));
  const parts = replay(ops);
  const z = parts.find((p) => p.tool === "task").state.metadata.zaiRun;
  assert.equal(z.status, "running");
  assert.ok(Number.isFinite(z.startedAt));
  assert.deepEqual(z.steps.map((s) => [s.tool, s.status]), [["grep", "running"]]);
  assert.equal(z.output, "почти готов");
  // дельты субагента состояния не меняют
  assert.equal(tr.feed({ type: "stream_event", parent_tool_use_id: "toolu_x", event: { type: "content_block_delta", delta: { type: "text_delta", text: "…" } } }).length, 0);
  // tool_use без parent-части — без операций
  assert.equal(tr.feed({ type: "assistant", parent_tool_use_id: "toolu_none", message: { content: [{ type: "text", text: "x" }] } }).length, 0);
});

test("FEAT-01.77: потолок 40 шагов — дальше stepsDropped растёт; stopRuns() гасит работающий запуск", () => {
  const tr = make();
  tr.feed({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
  tr.feed({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_cap", name: "Agent", input: {} } } });
  const blocks = Array.from({ length: 45 }, (_, i) => ({ type: "tool_use", id: `s${i}`, name: "Read", input: { file_path: `f${i}.txt` } }));
  tr.feed({ type: "assistant", parent_tool_use_id: "toolu_cap", message: { id: "s", content: blocks } });
  let z = tr.parts().find((p) => p.tool === "task").state.metadata.zaiRun;
  assert.equal(z.steps.length, 40);
  assert.equal(z.stepsDropped, 5);

  const ops = tr.stopRuns();
  assert.equal(ops.length, 1, "одна операция на часть с работающим запуском");
  z = replay(ops).find((p) => p.tool === "task").state.metadata.zaiRun;
  assert.equal(z.status, "stopped");
  assert.ok(Number.isFinite(z.endedAt));
  assert.equal(tr.hasRunningZaiRun(), false, "после stopRuns работающих запусков нет");
});

test("BUG-229: stopRuns штампует zaiRun частям task без статуса — блокирующий с результатом completed (с выводом), фоновый и без результата stopped", () => {
  const tr = make();
  const taskInput = (bg) => ({ description: "Задача", subagent_type: "general-purpose", prompt: "p", ...(bg ? { run_in_background: true } : {}) });
  const ops = [
    ...tr.feed({ type: "assistant", message: { id: "m1", role: "assistant", content: [
      { type: "tool_use", id: "toolu_blk", name: "Task", input: taskInput(false) },
      { type: "tool_use", id: "toolu_bg", name: "Task", input: taskInput(true) },
      { type: "tool_use", id: "toolu_open", name: "Task", input: taskInput(false) },
    ] } }),
    ...tr.feed({ type: "user", message: { role: "user", content: [
      { tool_use_id: "toolu_blk", type: "tool_result", content: [{ type: "text", text: "Отчёт блокирующего агента" }] },
      { tool_use_id: "toolu_bg", type: "tool_result", content: [{ type: "text", text: "Async agent launched successfully." }] },
    ] } }),
    ...tr.feed({ type: "assistant", message: { id: "m1", role: "assistant", content: [
      { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "dir" } },
    ] } }),
    ...tr.feed({ type: "user", message: { role: "user", content: [
      { tool_use_id: "toolu_bash", type: "tool_result", content: [{ type: "text", text: "ok" }] },
    ] } }),
  ];
  const stopOps = tr.stopRuns();
  assert.equal(stopOps.length, 3, "штамп только трём task-частям без zaiRun");
  const parts = replay([...ops, ...stopOps]);
  const zOf = (callID) => parts.find((p) => p.callID === callID)?.state?.metadata?.zaiRun ?? null;

  const blk = zOf("toolu_blk");
  assert.equal(blk.status, "completed", "блокирующий с результатом — готов");
  assert.match(blk.output, /Отчёт блокирующего агента/);
  assert.ok(Number.isFinite(blk.startedAt) && Number.isFinite(blk.endedAt));

  assert.equal(zOf("toolu_bg").status, "stopped", "фоновый запуск погиб вместе с CLI");
  assert.equal(zOf("toolu_bg").output, null, "ack запуска — не ответ агента");
  assert.equal(zOf("toolu_open").status, "stopped", "вызов без результата — stopped");
  assert.equal(zOf("toolu_bash"), null, "не-agent части не штампуются");

  assert.equal(tr.stopRuns().length, 0, "повторный stopRuns ничего не меняет");
});
