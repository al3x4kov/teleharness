// FEAT-01.77 (tasks 1.1): метаданные вызова инструмента в переписывателе v2.
// session.tool.progress несёт metadata.sessionID дочерней сессии — раньше
// отбрасывался, клиент не знал «кого запустили», пока инструмент не закончится.
// Теперь metadata накапливаются в записи вызова и едут в part.state.metadata
// на каждом обновлении; tool.success объединяет свои metadata с накопленными.
// Папка событий дочерней сессии — из session.created дочерней (там есть
// location) через существующий knownDir. Фикстуры — живые записи стенда v2.
// Run: node --test --test-timeout=60000 tests/oc-client-subagent.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createV2Rewriter } from "../lib/oc-client.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC = JSON.parse(readFileSync(path.join(HERE, "fixtures", "v2-subagent-sync.json"), "utf8"));
const BG = JSON.parse(readFileSync(path.join(HERE, "fixtures", "v2-subagent-background.json"), "utf8"));

// Возвращённое переписывателем — то, что хаб шлёт клиентам
const feedAll = (rw, fx) => {
  const out = [];
  for (const evt of fx.events ?? []) {
    const e = rw(evt);
    if (e) out.push(e);
  }
  return out;
};
const partsOf = (emitted, callID) =>
  emitted.filter((e) => e.type === "message.part.updated" && e.properties.part?.id === callID).map((e) => e.properties.part);

test("FEAT-01.77: tool.progress кладёт metadata.sessionID дочерней сессии в часть субагента (статус running), success сохраняет её", () => {
  const rw = createV2Rewriter({ emit: () => {}, throttleMs: 1 });
  const CALL = "call_5ebef332437a4021944ff6fb";
  const CHILD = "ses_e36eb8e5cffeiN1GF5pBbIeL7U";
  let afterProgress = null;
  let afterSuccess = null;
  for (const evt of SYNC.events) {
    const out = rw(evt);
    if (out?.type !== "message.part.updated" || out.properties.part?.id !== CALL) continue;
    if (evt.type === "session.tool.progress") afterProgress = out.properties.part;
    if (evt.type === "session.tool.success") afterSuccess = out.properties.part;
  }
  assert.ok(afterProgress, "по tool.progress часть субагента выдана");
  assert.equal(afterProgress.state.status, "running");
  assert.equal(afterProgress.state.metadata?.sessionID, CHILD, "sessionID дочерней сессии известен клиенту, пока агент работает");
  assert.equal(afterProgress.state.metadata?.status, "running");
  assert.ok(afterSuccess, "по tool.success часть обновлена");
  assert.equal(afterSuccess.state.status, "completed");
  assert.equal(afterSuccess.state.metadata?.sessionID, CHILD, "sessionID не потерян на завершении");
  assert.equal(afterSuccess.state.metadata?.status, "completed", "свои metadata success поверх накопленных");
});

test("FEAT-01.77: события дочерней сессии идут дальше с её sessionID и папкой родителя (directory не null)", () => {
  const rw = createV2Rewriter({ emit: () => {}, throttleMs: 1 });
  const DIR = "D:\\zai-stage\\tmp\\w2-fixture-mwbohnze";
  const CHILD = "ses_e36eb8e5cffeiN1GF5pBbIeL7U";
  const emitted = feedAll(rw, SYNC);
  const childEvents = emitted.filter((e) => e.properties?.sessionID === CHILD || e.properties?.info?.sessionID === CHILD || e.properties?.info?.id === CHILD);
  assert.ok(childEvents.length >= 3, `события дочерней сессии дошли (${childEvents.length})`);
  for (const e of childEvents) assert.equal(e.directory, DIR, `папка дочерней сессии = папка родителя (${e.type})`);
  // execution.started дочерней сессии приходит без location — папка из session.created (knownDir)
  const noLoc = SYNC.events.filter((e) => e.data?.sessionID === CHILD && !e.location && e.type !== "session.created").map((e) => e.type);
  assert.ok(noLoc.includes("session.execution.started"), "в фикстуре есть события дочерней сессии без location");
});

test("FEAT-01.77: два фоновых запуска — у каждого свой sessionID; немедленный tool.success хранит metadata.status running", () => {
  const rw = createV2Rewriter({ emit: () => {}, throttleMs: 1 });
  const emitted = feedAll(rw, BG);
  const childById = new Map([["call_e1eac34c2b594ed98dff82da", "ses_e368062e1ffeCMv0fHa0hnaQ3c"], ["call_977c6ca8596e4a7d89b69a58", "ses_e368062daffezgIQH2FzfuWa6N"]]);
  for (const [call, child] of childById) {
    const parts = partsOf(emitted, call);
    assert.ok(parts.length >= 2, `у вызова ${call} были и progress, и success`);
    const last = parts.at(-1);
    assert.equal(last.state.status, "completed", "часть завершена (судить о работе фонового агента клиент будет по zai.resync/записи, не по части)");
    assert.equal(last.state.metadata?.sessionID, child, "у фонового запуска свой sessionID");
    assert.equal(last.state.metadata?.status, "running", "metadata.status как в записи — «работает»");
    assert.equal(last.state.metadata?.truncated, false);
    const prog = parts.filter((p) => p.state.status === "running").at(-1);
    assert.equal(prog?.state.metadata?.sessionID, child, "sessionID уже в progress");
  }
});

test("FEAT-01.77: объединение metadata по ключам (progress → success), накопленное живёт до success без своих metadata", () => {
  const rw = createV2Rewriter({ emit: () => {}, throttleMs: 1 });
  const dir = { location: { directory: "C:\\x" } };
  const base = { sessionID: "s9", assistantMessageID: "m9" };
  const parts = [];
  for (const evt of [
    { type: "session.tool.called", ...dir, data: { ...base, id: "cA", name: "bash", input: {} } },
    { type: "session.tool.progress", data: { ...base, id: "cA", metadata: { a: "1" } } },
    { type: "session.tool.progress", data: { ...base, id: "cA", metadata: { b: "2" }, message: "шаг" } },
    { type: "session.tool.success", ...dir, data: { ...base, id: "cA", content: [], metadata: { b: "3", c: true } } },
  ]) {
    const out = rw(evt);
    if (out?.type === "message.part.updated") parts.push(out.properties.part);
  }
  assert.deepEqual(parts[2].state, { status: "running", message: "шаг", metadata: { a: "1", b: "2" } }, "progress копит metadata и несёт message");
  assert.deepEqual(parts.at(-1).state.metadata, { a: "1", b: "3", c: true }, "success поверх накопленных, по ключам");

  // инструмент без субагентных metadata — прежняя форма части
  const rw2 = createV2Rewriter({ emit: () => {}, throttleMs: 1 });
  const out = rw2({ type: "session.tool.progress", ...dir, data: { ...base, id: "cB", message: "идёт" } });
  assert.deepEqual(out.properties.part.state, { status: "running", message: "идёт" }, "без metadata — как раньше, без ключа metadata");
});

// FEAT-01.77: ввод инструмента виден клиенту с момента сборки ввода — карточка агента в
// очереди знает имя и задачу, работающий шаг — свой объект (раньше ввод приходил только на success).
test("ввод инструмента: из input.ended (JSON-строка text) и tool.called — в состояниях pending и running", async () => {
  const { readFileSync } = await import("node:fs");
  const { createV2Rewriter } = await import("../lib/oc-client.js");
  const fx = JSON.parse(readFileSync(new URL("./fixtures/v2-subagent-sync.json", import.meta.url), "utf8"));
  const rw = createV2Rewriter({ emit: () => {}, throttleMs: 0 });
  const seen = [];
  for (const e of fx.events) {
    const r = rw(e);
    if (r?.type === "message.part.updated" && r.properties.part.tool === "subagent") seen.push({ src: e.type, status: r.properties.part.state.status, agent: r.properties.part.state.input?.agent ?? null });
  }
  const at = (src) => seen.find((x) => x.src === src);
  assert.equal(at("session.tool.input.started").agent, null);
  assert.equal(at("session.tool.input.ended").status, "pending");
  assert.equal(at("session.tool.input.ended").agent, "explorer");
  assert.equal(at("session.tool.called").status, "running");
  assert.equal(at("session.tool.called").agent, "explorer");
  assert.equal(at("session.tool.progress").agent, "explorer");
});
