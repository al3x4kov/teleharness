// TASK-01.81: доводка карточек субагентов до макета (design/mockups-v2/subagents.html).
// Run: node --test tests/subagents-parity2.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentRun, needsTokenRefresh, showBgBar, stepLabel } from "../src/lib/subagents.js";
import { ClaudeTranscript } from "../lib/claude-transcript.js";

const OC_CTX = { busy: () => false, tokensOf: () => null, now: () => 30000, engine: "opencode" };
const CLAUDE_CTX = { childFeed: () => null, busy: () => false, tokensOf: () => null, now: () => 30000, engine: "claude" };

const ocPart = { id: "c1", callID: "c1", type: "tool", tool: "subagent", time: { created: 1000, completed: 9000 }, state: { status: "completed", input: { agent: "explorer", description: "задача" }, metadata: { sessionID: "ses_child" } } };
const feedWith = (toolParts) => [
  { info: { id: "a1", role: "assistant", time: { created: 1300, completed: 8000 } }, parts: [...toolParts, { id: "t1", type: "text", text: "готово" }] },
];

test("TASK-01.81 (кадр 2): чтение ПАПКИ инструментом read — шаг «Список файлов», чтение файла — «Прочитал»", () => {
  const feed = feedWith([
    { id: "p1", callID: "p1", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "D:\\work\\proj" }, output: "<path>D:\\work\\proj</path>\n<type>directory</type>\n<entries>\na.txt\nb.txt\n</entries>" } },
    { id: "p2", callID: "p2", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "D:\\work\\proj\\a.txt" }, output: "<path>D:\\work\\proj\\a.txt</path>\n<type>file</type>\n<content>alpha</content>" } },
  ]);
  const run = agentRun(ocPart, { ...OC_CTX, childFeed: () => feed });
  assert.equal(run.steps.length, 2);
  assert.equal(stepLabel(run.steps[0]).verb, "Список файлов");
  assert.equal(run.steps[0].note, "2 файла", "число записей папки — итог шага");
  assert.equal(stepLabel(run.steps[1]).verb, "Прочитал");
  assert.notEqual(run.steps[0].tool, run.steps[1].tool, "папка и файл не склеиваются в одну группу «Прочитал»");
});

test("TASK-01.81 (кадр 2): чтение папки в формате opencode 2.2.6 («Read directory …, entries 1-2») — запись стенда 2026-11-11", () => {
  const feed = feedWith([
    { id: "p1", callID: "p1", type: "tool", tool: "read", state: { status: "completed", input: { path: "D:\\zai-stage\\tmp\\rd-x" }, metadata: { truncated: false }, output: "Read directory D:\\zai-stage\\tmp\\rd-x, entries 1-2\na.txt\nb.txt" } },
    { id: "p2", callID: "p2", type: "tool", tool: "read", state: { status: "completed", input: { path: "D:\\zai-stage\\tmp\\rd-x\\a.txt" }, metadata: { truncated: false }, output: "Read file D:\\zai-stage\\tmp\\rd-x\\a.txt, lines 1-1\n1: alpha" } },
  ]);
  const run = agentRun(ocPart, { ...OC_CTX, childFeed: () => feed });
  assert.equal(stepLabel(run.steps[0]).verb, "Список файлов");
  assert.equal(run.steps[0].note, "2 файла");
  assert.equal(run.steps[0].object, "rd-x", "у папки — только имя: итог должен поместиться в строку");
  assert.equal(stepLabel(run.steps[1]).verb, "Прочитал");
  assert.equal(run.steps[1].note, null);
});

test("TASK-01.81 (кадр 2): чтение папки по метаданным инструмента (без текста вывода)", () => {
  const feed = feedWith([{ id: "p1", callID: "p1", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/srv/proj" }, metadata: { type: "directory" } } }]);
  const run = agentRun(ocPart, { ...OC_CTX, childFeed: () => feed });
  assert.equal(stepLabel(run.steps[0]).verb, "Список файлов");
});

test("TASK-01.81 (кадр 3): токены Claude-запуска — из zaiRun.tokens", () => {
  const part = { type: "tool", tool: "task", callID: "t1", state: { status: "completed", input: { subagent_type: "general-purpose", description: "d" }, metadata: { zaiRun: { status: "completed", startedAt: 1000, endedAt: 7000, steps: [], output: "ок", tokens: 18144 } } } };
  assert.equal(agentRun(part, CLAUDE_CTX).tokens, 18144);
});

test("TASK-01.81 (кадр 1): пилюля «фоном» у Claude-запуска — только когда запуск действительно фоновый", () => {
  const mk = (input) => ({ type: "tool", tool: "task", callID: "t1", state: { status: "completed", input: { subagent_type: "general-purpose", description: "d", ...input }, metadata: { zaiRun: { status: "running", startedAt: 1000, steps: [] } } } });
  assert.equal(agentRun(mk({}), CLAUDE_CTX).background, false, "обычный вызов Agent — без пилюли (CLI исполняет его асинхронно всегда)");
  assert.equal(agentRun(mk({ run_in_background: true }), CLAUDE_CTX).background, true);
});

test("TASK-01.81: транскрипт Claude кладёт расход агента из task_notification в zaiRun.tokens", () => {
  const lines = readFileSync(new URL("./fixtures/claude-stream-subagent-2.1.322.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const tr = new ClaudeTranscript({ sessionID: "ses_x", messageID: "msg_x", newId: (() => { let n = 0; return () => `p${++n}`; })(), now: () => 1000 });
  for (const evt of lines) tr.feed(evt);
  tr.finish();
  const task = tr.parts().find((p) => p.type === "tool" && p.tool === "task");
  assert.equal(task.state.metadata.zaiRun.tokens, 18144);
});

test("TASK-01.81 (кадры 4 и 5): полоса фоновых агентов — только при включённой детализации", () => {
  assert.equal(showBgBar({ mainBusy: false, dialogOpen: false, detailOn: true, activeCount: 1 }), true, "кадр 5");
  assert.equal(showBgBar({ mainBusy: false, dialogOpen: false, detailOn: false, activeCount: 2 }), false, "детализация выключена: работу агентов показывает индикатор (кадр 4), полоса его не дублирует");
  assert.equal(showBgBar({ mainBusy: true, dialogOpen: false, detailOn: true, activeCount: 1 }), false, "идёт основной ход");
  assert.equal(showBgBar({ mainBusy: false, dialogOpen: true, detailOn: true, activeCount: 1 }), false, "открыт диалог");
  assert.equal(showBgBar({ mainBusy: false, dialogOpen: false, detailOn: true, activeCount: 0 }), false);
});

test("TASK-01.81 (кадр 3): завершённый запуск без токенов — ленту ребёнка стоит перечитать один раз", () => {
  const done = { id: "r1", state: "done", childId: "ses_c", tokens: null };
  assert.equal(needsTokenRefresh(done), true);
  assert.equal(needsTokenRefresh({ ...done, tokens: 1200 }), false);
  assert.equal(needsTokenRefresh({ ...done, state: "running" }), false);
  assert.equal(needsTokenRefresh({ ...done, childId: null }), false, "Claude-запуск: ленты нет");
});
