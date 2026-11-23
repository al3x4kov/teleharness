// @suite: unit — ClaudeRunner на фейковом CLI (без server.js, BUG-222/QA-05)
// FEAT-20.37: план хода в Claude-раннере — tool_use TodoWrite CLI и служебный
// кадр system/plan (от ACP-шима) публикуют teleharness.plan через #emit → hub.emit.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-plan-fake.mjs");
const TMP = mkdtempSync(path.join(tmpdir(), "teleharness-claude-plan-test-"));
after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let storeSeq = 0;
const freshStore = () => {
  const dir = path.join(TMP, `data-${++storeSeq}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "claude-sessions.json");
};

function stubHub() {
  const events = [];
  const managed = new Set();
  return {
    events,
    managed,
    markManaged: (sid) => managed.add(sid),
    emit: (event, dir) => events.push({ event, dir }),
  };
}

const body = (text) => Buffer.from(JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, parts: [{ type: "text", text }] }));
const fakeRes = () => {
  const res = { code: 0, ended: false, body: "" };
  res.writeHead = (code) => {
    res.code = code;
  };
  res.end = (b) => {
    res.ended = true;
    res.body = b ?? "";
  };
  return res;
};

async function waitIdle(hub, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hub.events.some((x) => x.event.type === "session.idle")) return;
    await sleep(50);
  }
  throw new Error("no session.idle within timeout; events: " + hub.events.map((x) => x.event.type).join(","));
}

async function runTurn(prompt) {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 1000 });
  const res = fakeRes();
  await runner.dispatch({ res, sid: "s_plan", dir: TMP, body: body(prompt) });
  assert.equal(res.code, 204);
  await waitIdle(hub);
  const messages = runner.messages("s_plan");
  runner.shutdown();
  return { hub, messages };
}

const plansOf = (hub) => hub.events.filter((x) => x.event.type === "teleharness.plan");

test("FEAT-20.37: tool_use TodoWrite публикует teleharness.plan с нормализованными этапами", async () => {
  const { hub } = await runTurn("TODOWRITE");
  const plans = plansOf(hub);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].event.properties.sessionID, "s_plan");
  assert.deepEqual(plans[0].event.properties.todos, [
    { id: "1", content: "Разобраться", status: "completed" },
    { id: "2", content: "Починить", status: "in_progress" },
    { id: "3", content: "Проверить", status: "pending" },
  ]);
  assert.equal(plans[0].dir, TMP, "событие уходит в папку хода (тенант-фильтр хаба)");
});

test("FEAT-20.37: кадр system/plan (ACP-шим) публикует teleharness.plan, tool-части не создаёт", async () => {
  const { hub, messages } = await runTurn("PLANFRAME");
  const plans = plansOf(hub);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].event.properties.todos, [
    { id: "1", content: "Кадр 1", status: "in_progress" },
    { id: "2", content: "Кадр 2", status: "completed" },
  ]);
  const answer = messages.find((m) => m.info.role === "assistant");
  assert.equal(answer.parts.some((p) => p.type === "tool"), false, "служебный кадр плана не должен создавать tool-часть");
});

test("FEAT-20.37: кадр плана с parent_tool_use_id (субагент) НЕ публикует план главного хода", async () => {
  const { hub } = await runTurn("PLANSUB");
  assert.equal(plansOf(hub).length, 0, "план субагента не должен становиться планом хода");
});

test("FEAT-20.37: неподдерживаемые статусы → pending; повторный todowrite перезаписывает план", async () => {
  const { hub } = await runTurn("TODOBAD");
  const plans = plansOf(hub);
  assert.equal(plans.length, 2, "каждый todowrite хода публикует актуальный план");
  assert.deepEqual(plans[0].event.properties.todos, [{ id: "1", content: "Шаг", status: "pending" }]);
  assert.deepEqual(plans[1].event.properties.todos, [{ id: "a", content: "Финал", status: "completed" }]);
});
