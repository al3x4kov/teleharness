// FEAT-20.4
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { runAcpChat } from "../lib/acp-chat.js";
test("ход получает две дельты, следующий ход загружает тот же разговор", async () => {
  for (const resume of [null, "s-test"]) {
    const child = spawn(process.execPath, ["tests/fixtures/acp-chat-agent.mjs"], { stdio: "pipe" });
    const chunks = [];
    try {
      const result = await runAcpChat(child, { cwd: process.cwd(), resume, prompt: "test", onText: (text) => chunks.push(text) });
      assert.equal(result.sessionId, "s-test");
      assert.equal(result.loaded, Boolean(resume));
      assert.deepEqual(chunks, ["one", resume ? " resumed" : " two"]);
    } finally {
      child.kill();
    }
  }
});

for (const agent of ["gemini", "github-copilot-cli"])
  test(agent + " через раннер сохраняет ответы, продолжает историю и останавливает активный ход", async (t) => {
    const { mkdtemp, mkdir, copyFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { default: path } = await import("node:path");
    const { setTimeout: delay } = await import("node:timers/promises");
    const { agentEntry } = await import("../lib/acp-registry.js");
    const { ClaudeRunner } = await import("../lib/claude.js");
    const dir = await mkdtemp(path.join(tmpdir(), "acp-runner-"));
    const dst = agentEntry(dir, agent);
    await mkdir(path.dirname(dst), { recursive: true });
    await copyFile("tests/fixtures/acp-chat-agent.mjs", dst);
    const events = [];
    const runner = new ClaudeRunner({
      storePath: path.join(dir, "sessions.json"),
      hub: { markManaged() {}, emit: (event) => events.push(event) },
    });
    t.after(async () => {
      runner.shutdown();
      await runner.flushNow();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    });
    async function turn(text) {
      const res = {
        writeHead(status) {
          assert.equal(status, 204);
        },
        end() {},
      };
      await runner.dispatch({
        res,
        sid: "chat",
        dir,
        access: "admin",
        acpOwner: "qa",
        permMode: "ask",
        body: JSON.stringify({ model: { providerID: "acp-" + agent, modelID: "acp-" + agent }, parts: [{ type: "text", text }] }),
      });
    }
    async function idle(n) {
      for (let i = 0; i < 200; i++) {
        if (events.filter((e) => e.type === "session.idle").length >= n) return;
        await delay(10);
      }
      assert.fail("раннер не завершил ход");
    }
    await turn("first");
    await idle(1);
    await turn("second");
    await idle(2);
    const answers = runner.messages("chat").filter((m) => m.info.role === "assistant");
    assert.deepEqual(
      answers.map((m) =>
        m.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(""),
      ),
      ["one two", "one resumed"],
    );
    assert.ok(answers.every((m) => m.info.providerID === "acp-" + agent));
    await turn("ask");
    for (let i = 0; i < 200 && !runner.dialogs().length; i++) await delay(10);
    assert.equal(runner.replyDialog(runner.dialogs()[0].id, { reply: "once" }), true);
    await idle(3);
    assert.equal(
      runner
        .messages("chat")
        .at(-1)
        .parts.find((p) => p.type === "text").text,
      "selected",
    );
    await turn("tools");
    await idle(4);
    const tool = runner
      .messages("chat")
      .at(-1)
      .parts.find((p) => p.type === "tool");
    assert.equal(tool?.state.status, "completed");
    assert.match(tool.state.output, /Файл прочитан/);
    await turn("wait");
    await delay(160);
    assert.equal(runner.abort("chat"), true);
    await idle(5);
    assert.equal(runner.messages("chat").at(-1).info.teleharness.interrupted, "user");
  });

test("каталог сохраняет обе группы ACP и не меняет основной движок при отсутствии входа", async () => {
  const { acpProviderCatalog } = await import("../lib/acp-registry.js");
  const { makeBinding } = await import("../lib/binding.js");
  const { engineAllowed } = await import("../lib/auth.js");
  const base = { all: [], default: {}, connected: [] };
  assert.deepEqual(acpProviderCatalog(base, []), base);
  for (const agent of ["gemini", "github-copilot-cli"]) {
    const catalog = acpProviderCatalog(base, [agent]);
    const key = catalog.connected[0];
    assert.equal(makeBinding({ model: { providerID: key, modelID: catalog.default[key] } }).engine, "acp");
    assert.equal(engineAllowed({ role: "user", engines: ["acp"] }, "acp"), false);
  }
});

test("агент отказал в восстановлении — новый ход получает предшествующий текст", async () => {
  const child = spawn(process.execPath, ["tests/fixtures/acp-chat-agent.mjs"], { stdio: "pipe" });
  const chunks = [];
  try {
    const reply = await runAcpChat(child, {
      cwd: process.cwd(),
      resume: "missing",
      context: "history:",
      prompt: "user-message",
      onText: (text) => chunks.push(text),
    });
    assert.equal(reply.loaded, false);
    assert.equal(chunks[0], "context received");
  } finally {
    child.kill();
  }
});

test("выбранная модель применяется перед первым и продолженным запросом", async () => {
  for (const resume of [null, "s-test"]) {
    const child = spawn(process.execPath, ["tests/fixtures/acp-chat-agent.mjs"]);
    const chunks = [];
    try {
      await runAcpChat(child, { cwd: process.cwd(), resume, modelId: "neon-test",
        prompt: "selected-model", onText: text => chunks.push(text) });
      assert.equal(chunks[0], "neon-test");
    } finally { child.kill(); }
  }
});

test("терминал Antigravity на Linux находит bash и sudo в обычном чате", {skip: process.platform !== "linux"}, async t => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { agentEntry } = await import("../lib/acp-registry.js");
  const { launchAcpChat } = await import("../lib/acp-login-launch.js");
  const dir = await mkdtemp(path.join(tmpdir(), "acp-path-"));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const cli = agentEntry(dir,"antigravity");
  await mkdir(path.dirname(cli), {recursive:true});
  await writeFile(cli, '#!/bin/sh\ncommand -v bash && command -v sudo\n', {mode:0o700});
  const child = launchAcpChat(dir,"admin","antigravity",dir);
  let stdout = "";
  for await (const chunk of child.stdout) stdout += chunk;
  assert.match(stdout,/\/bash\n/);
  assert.match(stdout,/\/sudo\n/);
});
