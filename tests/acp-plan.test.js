// @suite: unit — чистый тест runAcpChat с фейковым child-процессом
// FEAT-20.37: разбор sessionUpdate:"plan" в runAcpChat → колбэк onPlan.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { runAcpChat } from "../lib/acp-chat.js";

async function turn(prompt) {
  const child = spawn(process.execPath, ["tests/fixtures/acp-plan-agent.mjs"], { stdio: "pipe" });
  const plans = [];
  try {
    const result = await runAcpChat(child, { cwd: process.cwd(), prompt, onText: () => {}, onPlan: (entries) => plans.push(entries) });
    return { result, plans };
  } finally {
    child.kill();
  }
}

test("FEAT-20.37: sessionUpdate plan → onPlan вызван с entries по схеме ACP", async () => {
  const { plans } = await turn("plan");
  assert.deepEqual(plans, [
    [
      { content: "Прочитать файл", priority: "high", status: "completed" },
      { content: "Починить", priority: "medium", status: "in_progress" },
      { content: "Проверить", priority: "low", status: "pending" },
    ],
  ]);
});

test("FEAT-20.37: entries не массив — onPlan НЕ вызывается", async () => {
  const { plans } = await turn("plan-no-entries");
  assert.deepEqual(plans, [], "мусорные entries не доходят до колбэка");
});

test("FEAT-20.37: мусорный статус проходит транспортом как есть (нормализует раннер/хаб)", async () => {
  const { plans } = await turn("plan-junk-status");
  assert.deepEqual(plans, [[{ content: "Шаг", status: "unknown" }]]);
});
