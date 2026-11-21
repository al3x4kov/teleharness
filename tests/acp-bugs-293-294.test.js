// Регрессия BUG-293 (ложное определение субагента в acp-shim) и
// BUG-294 (зависший session/prompt ACP после готового ответа: finishHungAcp + watchdog).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as acpChat from "../lib/acp-chat.js";
import { agentEntry } from "../lib/acp-registry.js";
import { ClaudeRunner } from "../lib/claude.js";

const ACP_FAKE_293_294 = `
import readline from "node:readline";
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...v }) + "\\n");
let sidSeq = 0;
let currentSid = null;
let loadedSid = null;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        authMethods: [{ id: "oauth-personal" }],
      },
    });
  } else if (method === "session/new") {
    currentSid = "s-fresh-" + (++sidSeq) + "-" + process.pid;
    loadedSid = null;
    send({
      id,
      result: {
        sessionId: currentSid,
        models: {
          currentModelId: "gemini-4-neon-medium",
          availableModels: [{ modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" }],
        },
      },
    });
  } else if (method === "session/load") {
    currentSid = params.sessionId;
    loadedSid = params.sessionId;
    send({ id, result: {} });
  } else if (method === "session/set_model") {
    send({ id, result: {} });
  } else if (method === "session/prompt") {
    const blocks = Array.isArray(params.prompt) ? params.prompt : [];
    const textBlock = blocks.find((b) => b.type === "text")?.text ?? "";
    const upd = (u) => send({ method: "session/update", params: { sessionId: params.sessionId, update: u } });

    if (textBlock.includes("FOLLOWUP_AFTER_RELEASE")) {
      const hasHistory = textBlock.includes("[История чата]") && textBlock.includes("Готово, выберите вариант.");
      const reply = "FOLLOWUP_OK loaded=" + (loadedSid ? "yes" : "no") + " history=" + (hasHistory ? "yes" : "no");
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
      send({ id, result: { stopReason: "end_turn" } });
      continue;
    }

    if (textBlock.includes("CMD_MENTIONS_SUBAGENT")) {
      upd({
        sessionUpdate: "tool_call",
        toolCallId: "cmd-fake-sa",
        title: "node -e 'console.log(\\"invoke_subagent\\")'",
        kind: "execute",
        status: "pending",
        rawInput: { CommandLine: "node -e 'console.log(\\"invoke_subagent\\")'" },
      });
      upd({
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-fake-sa",
        kind: "execute",
        status: "completed",
        title: "node -e 'console.log(\\"invoke_subagent\\")'",
        rawOutput: "invoke_subagent",
      });
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Команда выполнена." } });
      send({ id, result: { stopReason: "end_turn" } });
      continue;
    }

    if (textBlock.includes("HANG_AFTER_ANSWER")) {
      upd({
        sessionUpdate: "tool_call",
        toolCallId: "done-cmd-1",
        title: "echo ok",
        kind: "execute",
        status: "pending",
        rawInput: { CommandLine: "echo ok" },
      });
      upd({
        sessionUpdate: "tool_call_update",
        toolCallId: "done-cmd-1",
        kind: "execute",
        status: "completed",
        title: "echo ok",
        rawOutput: "ok",
      });
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Готово, выберите вариант." } });
      continue;
    }

    if (textBlock.includes("LONG_BASH_WITH_TEXT")) {
      upd({
        sessionUpdate: "tool_call",
        toolCallId: "long-bash-1",
        title: "sleep 1 && echo LONG_OK",
        kind: "execute",
        status: "in_progress",
        rawInput: { CommandLine: "sleep 1 && echo LONG_OK" },
      });
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Жду сборку..." } });
      setTimeout(() => {
        upd({
          sessionUpdate: "tool_call_update",
          toolCallId: "long-bash-1",
          kind: "execute",
          status: "completed",
          rawOutput: "LONG_OK",
        });
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Сборка готова." } });
        send({ id, result: { stopReason: "end_turn" } });
      }, 450);
      continue;
    }

    if (textBlock.includes("SILENT_THINKING_NO_TEXT")) {
      setTimeout(() => {
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Додумал и ответил." } });
        send({ id, result: { stopReason: "end_turn" } });
      }, 450);
      continue;
    }

    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } });
    send({ id, result: { stopReason: "end_turn" } });
  }
}
`;

async function setupFakeAcpEnv(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const fakeInstall = agentEntry(dir, "gemini");
  await mkdir(path.dirname(fakeInstall), { recursive: true });
  await writeFile(fakeInstall, ACP_FAKE_293_294, "utf8");
  return dir;
}

function makeRunner(dir, events, opts = {}) {
  return new ClaudeRunner({
    hub: { emit: (evt) => events.push(evt), markManaged: () => {} },
    storePath: path.join(dir, "claude-sessions.json"),
    runsPath: path.join(dir, "claude-runs.json"),
    keepaliveMs: opts.keepaliveMs ?? 80,
    acpPostAnswerIdleMs: opts.acpPostAnswerIdleMs ?? 0,
    log: () => {},
  });
}

async function sendAcp(runner, dir, sid, text) {
  const fakeRes = { writeHead() {}, end() {} };
  await runner.dispatch({
    res: fakeRes,
    sid,
    dir,
    access: "admin",
    acpOwner: "admin",
    permMode: "full",
    body: Buffer.from(JSON.stringify({
      model: { providerID: "acp-gemini", modelID: "acp-gemini" },
      parts: [{ type: "text", text }],
    })),
  });
}

async function waitFor(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timeout");
}

test("BUG-293 unit: normalizeAcpTool не принимает execute/read/search с текстом invoke_subagent за субагента", () => {
  assert.equal(typeof acpChat.normalizeAcpTool, "function", "normalizeAcpTool должен экспортироваться из lib/acp-chat.js");

  const execMention = acpChat.normalizeAcpTool({
    kind: "execute",
    title: "env -C /srv/teleharness node -e 'console.log(\"invoke_subagent\")'",
    rawInput: { CommandLine: "env -C /srv/teleharness node -e 'console.log(\"invoke_subagent\")'" },
  });
  assert.equal(execMention.isSubagent, false);
  assert.equal(execMention.name, "bash");

  const searchMention = acpChat.normalizeAcpTool({
    kind: "search",
    title: "grep invoke_subagent lib/acp-shim.mjs",
    rawInput: { query: "invoke_subagent" },
  });
  assert.equal(searchMention.isSubagent, false);
  assert.equal(searchMention.name, "search");

  const realStructured = acpChat.normalizeAcpTool({
    kind: "other",
    title: "Running invoke_subagent",
    rawInput: { Subagents: [{ Role: "Code Auditor", TypeName: "research", Prompt: "Audit diff" }] },
  });
  assert.equal(realStructured.isSubagent, true);
  assert.equal(realStructured.name, "task");
  assert.equal(realStructured.input.subagent_type, "Code Auditor");
  assert.equal(realStructured.input.run_in_background, true);

  const realTitleOnly = acpChat.normalizeAcpTool({
    kind: "other",
    title: "Running invoke_subagent",
    rawInput: {},
  });
  assert.equal(realTitleOnly.isSubagent, true);
  assert.equal(realTitleOnly.name, "task");
});

test("BUG-293 e2e: shell-команда с текстом invoke_subagent проходит как bash без teleharnessRun", async () => {
  const dir = await setupFakeAcpEnv("teleharness-bug293-");
  const events = [];
  const runner = makeRunner(dir, events);
  try {
    const sid = "ses_bug293_e2e";
    await sendAcp(runner, dir, sid, "CMD_MENTIONS_SUBAGENT");
    await waitFor(() => events.some((e) => e.type === "session.idle" && e.properties?.sessionID === sid));
    const msgs = runner.messages(sid);
    const asst = msgs.find((m) => m.info.role === "assistant");
    assert.ok(asst);
    const toolParts = asst.parts.filter((p) => p.type === "tool");
    assert.equal(toolParts.length, 1);
    assert.equal(toolParts[0].tool, "bash", `ожидался bash, получено ${toolParts[0].tool}`);
    assert.equal(toolParts[0].state?.status, "completed");
    assert.equal(toolParts[0].state?.metadata?.teleharnessRun, undefined, "обычный execute не должен создавать teleharnessRun");
  } finally {
    runner.shutdown();
    await runner.flushNow();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});

test("BUG-294 e2e: finishHungAcp сохраняет ответ без [Прервано], не теряет очередь и сбрасывает битый acpSession", async () => {
  const dir = await setupFakeAcpEnv("teleharness-bug294-manual-");
  const events = [];
  const runner = makeRunner(dir, events);
  try {
    const sid = "ses_bug294_manual";
    await sendAcp(runner, dir, sid, "HANG_AFTER_ANSWER");
    await waitFor(() => {
      const live = runner.liveness()[sid];
      return live?.hasAnswerText === true && (live.activeTasks?.length ?? 0) === 0;
    });
    await sendAcp(runner, dir, sid, "FOLLOWUP_AFTER_RELEASE");
    assert.equal(runner.liveness()[sid]?.queued, 1);

    assert.equal(typeof runner.finishHungAcp, "function", "ClaudeRunner.finishHungAcp должен существовать");
    const ok = runner.finishHungAcp(sid);
    assert.equal(ok, true);

    await waitFor(() => events.some((e) => e.type === "session.idle" && e.properties?.sessionID === sid), 8000);

    const msgs = runner.messages(sid);
    const assts = msgs.filter((m) => m.info.role === "assistant");
    assert.equal(assts.length, 2, `ожидалось 2 ответа ассистента, получено ${assts.length}`);

    const firstText = assts[0].parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    assert.ok(firstText.includes("Готово, выберите вариант."), `первый ответ потерян: ${firstText}`);
    assert.ok(!firstText.includes("[Прервано]"), `первый ответ не должен помечаться [Прервано]: ${firstText}`);
    assert.equal(assts[0].info?.teleharness?.interrupted, undefined);

    const secondText = assts[1].parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    assert.ok(secondText.includes("FOLLOWUP_OK"), `реплика из очереди не выполнилась: ${secondText}`);
    assert.ok(secondText.includes("loaded=no"), `битая ACP-сессия должна быть сброшена (ожидалось loaded=no): ${secondText}`);
    assert.ok(secondText.includes("history=yes"), `новая ACP-сессия должна получить историю чата: ${secondText}`);
  } finally {
    runner.shutdown();
    await runner.flushNow();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});

test("BUG-294 e2e: серверный watchdog acpPostAnswerIdleMs авто-завершает зависший пост-ответный ход, но не трогает долгий bash и размышление до ответа", async () => {
  const dir = await setupFakeAcpEnv("teleharness-bug294-watchdog-");
  const events = [];
  const runner = makeRunner(dir, events, { acpPostAnswerIdleMs: 250 });
  try {
    const sidBash = "ses_bug294_bash";
    await sendAcp(runner, dir, sidBash, "LONG_BASH_WITH_TEXT");
    await waitFor(() => events.some((e) => e.type === "session.idle" && e.properties?.sessionID === sidBash), 6000);
    const bashText = runner.messages(sidBash).find((m) => m.info.role === "assistant")?.parts.filter((p) => p.type === "text").map((p) => p.text).join("") ?? "";
    assert.ok(bashText.includes("Сборка готова."), `долгий bash не должен быть оборван сторожем: ${bashText}`);

    const sidThink = "ses_bug294_think";
    await sendAcp(runner, dir, sidThink, "SILENT_THINKING_NO_TEXT");
    await waitFor(() => events.some((e) => e.type === "session.idle" && e.properties?.sessionID === sidThink), 6000);
    const thinkText = runner.messages(sidThink).find((m) => m.info.role === "assistant")?.parts.filter((p) => p.type === "text").map((p) => p.text).join("") ?? "";
    assert.ok(thinkText.includes("Додумал и ответил."), `размышление до ответа не должно быть оборвано: ${thinkText}`);

    const sidHung = "ses_bug294_auto";
    await sendAcp(runner, dir, sidHung, "HANG_AFTER_ANSWER");
    await waitFor(() => runner.liveness()[sidHung]?.hasAnswerText === true);
    await sendAcp(runner, dir, sidHung, "FOLLOWUP_AFTER_RELEASE");
    await waitFor(() => events.some((e) => e.type === "session.idle" && e.properties?.sessionID === sidHung), 8000);
    const assts = runner.messages(sidHung).filter((m) => m.info.role === "assistant");
    assert.equal(assts.length, 2);
    assert.ok(assts[1].parts.filter((p) => p.type === "text").map((p) => p.text).join("").includes("loaded=no"));
    assert.ok(events.some((e) => e.type === "teleharness.notice" && e.properties?.sessionID === sidHung), "сторож должен уведомить через teleharness.notice");
  } finally {
    runner.shutdown();
    await runner.flushNow();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});
