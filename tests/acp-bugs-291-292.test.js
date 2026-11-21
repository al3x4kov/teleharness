// Регрессия BUG-291 (фоновая работа и очередь в ACP/Gemini) и BUG-292 (изображения в Gemini 4 Neon).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAcpChat } from "../lib/acp-chat.js";
import { acpProviderCatalog } from "../lib/acp-registry.js";
import { discoverAcpModels, cachedAcpModels } from "../lib/acp-models.js";
import { buildTurn, ClaudeRunner } from "../lib/claude.js";
import { ClaudeTranscript } from "../lib/claude-transcript.js";
import { normalizeProviders } from "../src/lib/normalize.js";

// Мини-фикстура ACP-агента: умеет promptCapabilities.image, возвращает принятые image-блоки,
// а также имитирует фоновый execute (текст вопроса до завершения tool_call) и invoke_subagent.
const ACP_FAKE_SRC = `
import readline from "node:readline";
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...v }) + "\\n");
const imgCap = process.env.FAKE_IMG_CAP !== "0";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: imgCap } },
        authMethods: [{ id: "oauth-personal" }],
      },
    });
  } else if (method === "session/new") {
    send({
      id,
      result: {
        sessionId: "s-acp-bug",
        models: {
          currentModelId: "gemini-4-neon-medium",
          availableModels: [{ modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" }],
        },
      },
    });
  } else if (method === "session/load" || method === "session/set_model") {
    send({ id, result: {} });
  } else if (method === "session/prompt") {
    const blocks = Array.isArray(params.prompt) ? params.prompt : [];
    const textBlock = blocks.find((b) => b.type === "text")?.text ?? "";
    const imgBlock = blocks.find((b) => b.type === "image");
    const upd = (u) => send({ method: "session/update", params: { sessionId: params.sessionId, update: u } });

    if (textBlock.includes("ECHO_IMAGE")) {
      const reply = imgBlock ? "IMG:" + imgBlock.mimeType + ":" + imgBlock.data : "NO_IMG";
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
      send({ id, result: { stopReason: "end_turn" } });
      continue;
    }

    if (textBlock.includes("BG_HOLD_TURN")) {
      upd({
        sessionUpdate: "tool_call",
        toolCallId: "bg-cmd-1",
        title: "sleep 8 && echo BG_OK",
        kind: "execute",
        status: "pending",
        rawInput: { CommandLine: "sleep 8 && echo BG_OK", WaitMsBeforeAsync: 500 },
      });
      upd({
        sessionUpdate: "tool_call_update",
        toolCallId: "bg-cmd-1",
        kind: "execute",
        status: "in_progress",
        title: "sleep 8 && echo BG_OK",
        rawInput: { command_line: "sleep 8 && echo BG_OK" },
      });
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Выберите А или Б?" } });
      setTimeout(() => {
        upd({
          sessionUpdate: "tool_call_update",
          toolCallId: "bg-cmd-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "BG_OK" } }],
        });
        send({ id, result: { stopReason: "end_turn" } });
      }, 350);
      continue;
    }

    if (textBlock.includes("SUBAGENT_BG")) {
      upd({
        sessionUpdate: "tool_call",
        toolCallId: "sub-1",
        title: "Run invoke_subagent?",
        kind: "other",
        status: "pending",
        rawInput: { Subagents: [{ Role: "Research Auditor", TypeName: "research", Prompt: "Audit repo" }] },
      });
      upd({
        sessionUpdate: "tool_call_update",
        toolCallId: "sub-1",
        status: "completed",
        rawOutput: "Invoke research subagent",
      });
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Запустил субагента, жду..." } });
      setTimeout(() => {
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Готово." } });
        send({ id, result: { stopReason: "end_turn" } });
      }, 250);
      continue;
    }

    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FOLLOWUP:" + textBlock.trim() } });
    send({ id, result: { stopReason: "end_turn" } });
  }
}
`;

async function makeFakeAgent(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-bugs-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const script = path.join(dir, "fake-acp.mjs");
  await writeFile(script, ACP_FAKE_SRC, "utf8");
  return { dir, script };
}

test("BUG-292: acpProviderCatalog передаёт capabilities.input.image из promptCapabilities (и для antigravity по умолчанию)", () => {
  const base = { all: [], connected: [], default: {} };
  const cat = acpProviderCatalog(base, ["antigravity", "github-copilot-cli"], {
    antigravity: {
      availableModels: [{ modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" }],
      currentModelId: "gemini-4-neon-medium",
      promptCapabilities: { image: true },
    },
    "github-copilot-cli": {
      availableModels: [{ modelId: "gpt-4.1", name: "GPT-4.1" }],
      promptCapabilities: { image: false },
    },
  });
  const agy = cat.all.find((p) => p.id === "acp-antigravity");
  const cop = cat.all.find((p) => p.id === "acp-github-copilot-cli");
  assert.equal(agy.models["gemini-4-neon-medium"].capabilities.input.image, true);
  assert.equal(cop.models["gpt-4.1"].capabilities.input.image, false);

  const norm = normalizeProviders(cat);
  const neon = norm.models.find((m) => m.id === "gemini-4-neon-medium");
  assert.equal(neon?.imageInput, true);
});

test("BUG-292: runAcpChat возвращает promptCapabilities при discoverModels и шлёт image-блок в session/prompt", async (t) => {
  const { script } = await makeFakeAgent(t);
  const c1 = spawn(process.execPath, [script], { stdio: "pipe" });
  t.after(() => c1.kill());
  const discovered = await runAcpChat(c1, { cwd: process.cwd(), discoverModels: true });
  assert.equal(discovered?.promptCapabilities?.image, true);

  const c2 = spawn(process.execPath, [script], { stdio: "pipe" });
  t.after(() => c2.kill());
  let text = "";
  await runAcpChat(c2, {
    cwd: process.cwd(),
    prompt: "ECHO_IMAGE",
    images: [{ data: "QUJDRA==", mimeType: "image/png" }],
    onText(chunk) { text += chunk; },
  });
  assert.equal(text, "IMG:image/png:QUJDRA==");

  // Если агент НЕ заявляет promptCapabilities.image — image-блок не уходит
  const c3 = spawn(process.execPath, [script], { stdio: "pipe", env: { ...process.env, FAKE_IMG_CAP: "0" } });
  t.after(() => c3.kill());
  let textNoCap = "";
  await runAcpChat(c3, {
    cwd: process.cwd(),
    prompt: "ECHO_IMAGE",
    images: [{ data: "QUJDRA==", mimeType: "image/png" }],
    onText(chunk) { textNoCap += chunk; },
  });
  assert.equal(textNoCap, "NO_IMG");
});

test("BUG-292: buildTurn сохраняет PNG в .teleharness-uploads и возвращает метаданные images без base64 в stored", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "buildturn-img-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pngB64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  const { prompt, stored, images } = buildTurn(
    [
      { type: "file", filename: "shot.png", mime: "image/png", url: `data:image/png;base64,${pngB64}` },
      { type: "text", text: "Какое число на картинке?" },
    ],
    dir,
  );
  assert.ok(prompt.includes("Какое число на картинке?"));
  assert.equal(stored.some((p) => String(p.url ?? "").startsWith("data:")), false);
  assert.equal(images?.length, 1);
  assert.equal(images[0].mimeType, "image/png");
  assert.ok(images[0].path.endsWith("shot.png"));
});

test("BUG-291: acp-shim нормализует execute -> bash с командой, держит invoke_subagent running до конца хода и передаёт activeTasks", async (t) => {
  const { dir, script } = await makeFakeAgent(t);
  const { agentEntry } = await import("../lib/acp-registry.js");
  const fakeInstall = agentEntry(dir, "gemini");
  await mkdir(path.dirname(fakeInstall), { recursive: true });
  await writeFile(fakeInstall, ACP_FAKE_SRC, "utf8");

  // 1) Проверка invoke_subagent: teleharnessRun остаётся running пока ход открыт, и завершается в конце
  const shim = spawn(process.execPath, [path.resolve("lib/acp-shim.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => shim.kill());
  const lines = [];
  let buf = "";
  shim.stdout.setEncoding("utf8");
  const done = new Promise((resolve) => {
    shim.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (l) lines.push(JSON.parse(l));
      }
    });
    shim.once("close", resolve);
  });
  shim.stdin.write(JSON.stringify({ dataDir: dir, owner: "admin", admin: true, agent: "gemini", mode: "full", prompt: "SUBAGENT_BG" }) + "\n");
  await done;

  const tr = new ClaudeTranscript({ sessionID: "s1", messageID: "m1" });
  let sawRunningAtText = false;
  for (const evt of lines) {
    tr.feed(evt);
    if (evt.type === "stream_event" && evt.event?.delta?.text?.includes("Запустил")) {
      if (tr.hasRunningTeleharnessRun()) sawRunningAtText = true;
    }
  }
  assert.equal(sawRunningAtText, true, "invoke_subagent должен оставаться running пока субагент работает в фоне");
  assert.equal(tr.hasRunningTeleharnessRun(), false, "к концу хода teleharnessRun субагента должен завершиться");
  const taskPart = tr.parts().find((p) => p.type === "tool" && p.tool === "task");
  assert.ok(taskPart, "invoke_subagent должен отображаться как инструмент task");
  assert.equal(taskPart.state.input.subagent_type, "Research Auditor");

  // 2) Проверка BG_HOLD_TURN + queued follow-up через ClaudeRunner
  const events = [];
  const runner = new ClaudeRunner({
    storePath: path.join(dir, "claude-sessions.json"),
    runsPath: path.join(dir, "claude-runs.json"),
    keepaliveMs: 80,
    hub: {
      markManaged() {},
      emit(evt) { events.push(evt); },
    },
  });
  const sid = "ses_bug291_queue";
  const fakeRes = () => ({ writeHead() {}, end() {} });
  await runner.dispatch({
    res: fakeRes(),
    sid,
    dir,
    access: "admin",
    acpOwner: "admin",
    permMode: "full",
    body: Buffer.from(JSON.stringify({
      model: { providerID: "acp-gemini", modelID: "acp-gemini" },
      parts: [{ type: "text", text: "BG_HOLD_TURN" }],
    })),
  });
  // Ждём появления текста вопроса пока фоновая команда ещё работает
  await new Promise((r) => setTimeout(r, 140));
  // Отправляем ответ пользователя — должен встать в очередь
  await runner.dispatch({
    res: fakeRes(),
    sid,
    dir,
    access: "admin",
    acpOwner: "admin",
    permMode: "full",
    body: Buffer.from(JSON.stringify({
      model: { providerID: "acp-gemini", modelID: "acp-gemini" },
      parts: [{ type: "text", text: "Вариант А" }],
    })),
  });

  // Ждём пока оба хода завершатся (idle после второго хода)
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const msgs = runner.messages(sid) ?? [];
    const assts = msgs.filter((m) => m.info.role === "assistant" && m.info.time?.completed != null);
    if (assts.length >= 2) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const keepalivesWithTask = events.filter(
    (e) => e.type === "teleharness.keepalive" && Array.isArray(e.properties?.activeTasks) && e.properties.activeTasks.some((t) => String(t.detail ?? "").includes("sleep 8")),
  );
  assert.ok(keepalivesWithTask.length > 0, "teleharness.keepalive должен сообщать activeTasks с фоновой командой");

  const msgs = runner.messages(sid);
  const assts = msgs.filter((m) => m.info.role === "assistant");
  assert.equal(assts.length, 2, "очередь должна запуститься ровно один раз после завершения фоновой задачи");
  const secondText = assts[1].parts.filter((p) => p.type === "text").map((p) => p.text).join("");
  assert.ok(secondText.includes("FOLLOWUP:Вариант А"), `второй ход должен получить реплику из очереди, получено: ${secondText}`);
  runner.shutdown(); await runner.flushNow();
});

test("BUG-292 + BUG-291 e2e: ClaudeRunner передаёт вложенный PNG в ACP и сохраняет уже написанный текст при SIGTERM (Стоп)", async (t) => {
  const { dir } = await makeFakeAgent(t);
  const { agentEntry } = await import("../lib/acp-registry.js");
  const fakeInstall = agentEntry(dir, "gemini");
  await mkdir(path.dirname(fakeInstall), { recursive: true });
  await writeFile(fakeInstall, ACP_FAKE_SRC, "utf8");

  const runner = new ClaudeRunner({
    storePath: path.join(dir, "claude-sessions.json"),
    runsPath: path.join(dir, "claude-runs.json"),
    keepaliveMs: 100,
    hub: { markManaged() {}, emit() {} },
  });
  const fakeRes = () => ({ writeHead() {}, end() {} });

  // 1) Image e2e through ClaudeRunner -> acp-shim -> runAcpChat -> fake ACP agent
  const pngB64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42]).toString("base64");
  const sidImg = "ses_e2e_img";
  await runner.dispatch({
    res: fakeRes(),
    sid: sidImg,
    dir,
    access: "admin",
    acpOwner: "admin",
    permMode: "full",
    body: Buffer.from(JSON.stringify({
      model: { providerID: "acp-gemini", modelID: "acp-gemini" },
      parts: [
        { type: "file", filename: "num.png", mime: "image/png", url: `data:image/png;base64,${pngB64}` },
        { type: "text", text: "ECHO_IMAGE" },
      ],
    })),
  });
  const d1 = Date.now() + 6000;
  while (Date.now() < d1) {
    const msgs = runner.messages(sidImg) ?? [];
    if (msgs.some((m) => m.info.role === "assistant" && m.info.time?.completed != null)) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  const imgAsst = runner.messages(sidImg).find((m) => m.info.role === "assistant");
  const imgAns = (imgAsst?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
  assert.equal(imgAns, `IMG:image/png:${pngB64}`, "ClaudeRunner должен доставлять PNG в ACP как image-блок");

  // 2) SIGTERM (Стоп) во время фонового удержания хода сохраняет уже написанный текст вопроса
  const sidStop = "ses_e2e_stop";
  await runner.dispatch({
    res: fakeRes(),
    sid: sidStop,
    dir,
    access: "admin",
    acpOwner: "admin",
    permMode: "full",
    body: Buffer.from(JSON.stringify({
      model: { providerID: "acp-gemini", modelID: "acp-gemini" },
      parts: [{ type: "text", text: "BG_HOLD_TURN" }],
    })),
  });
  const d2 = Date.now() + 4000;
  while (Date.now() < d2) {
    const msgs = runner.messages(sidStop) ?? [];
    const asst = msgs.find((m) => m.info.role === "assistant");
    const txt = (asst?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
    if (txt.includes("Выберите")) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  runner.abort(sidStop);
  const d3 = Date.now() + 4000;
  while (Date.now() < d3) {
    const msgs = runner.messages(sidStop) ?? [];
    if (msgs.some((m) => m.info.role === "assistant" && m.info.time?.completed != null)) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const stopAsst = runner.messages(sidStop).find((m) => m.info.role === "assistant");
  const stopTxt = (stopAsst?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
  assert.ok(stopTxt.includes("Выберите"), `после Стоп текст вопроса не должен пропадать, получено: ${stopTxt}`);
  runner.shutdown(); await runner.flushNow();
});
