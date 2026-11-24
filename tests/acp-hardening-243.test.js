// BUG-279, BUG-281, BUG-282 — регрессионные тесты релиза 2.4.3
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgyLoginSessions } from "../lib/acp-agy-login.js";
import { CopilotLoginSessions } from "../lib/acp-copilot-login.js";
import { markAcpProfile, acpProfileDir, launchAcpChat } from "../lib/acp-login-launch.js";
import { AcpRegistry, agentEntry } from "../lib/acp-registry.js";
import { runAcpChat } from "../lib/acp-chat.js";
import { ClaudeRunner } from "../lib/claude.js";
import { gitRoutes } from "../routes/git.js";
import { dispatchRoute } from "../routes/router.js";

function fakeChild() {
  const c = new EventEmitter();
  c.stdin = new PassThrough();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.kill = () => { c.killed = true; };
  return c;
}

test("BUG-279: AgyLoginSessions и CopilotLoginSessions возвращают ready после рестарта по isReady", () => {
  const agy = new AgyLoginSessions(() => fakeChild(), null, (owner) => owner === "admin");
  assert.deepEqual(agy.get("admin"), { status: "ready" });
  assert.deepEqual(agy.get("other"), { status: "idle" });

  const copilot = new CopilotLoginSessions(() => fakeChild(), null, (owner) => owner === "admin");
  assert.deepEqual(copilot.get("admin"), { status: "ready" });
  assert.deepEqual(copilot.get("other"), { status: "idle" });
});

test("BUG-279: вход по платному Gemini API-ключу отклонён с 400 (только подписки)", () => {
  const agy = new AgyLoginSessions(() => fakeChild());
  assert.throws(() => agy.start("admin", { method: "api-key", key: "AIzaSyTEST_key-1234567890" }), { status: 400 });
});

test("BUG-279: устаревший gemini не installable в AcpRegistry", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "reg-nogemini-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reg = new AcpRegistry(dir, async () =>
    Response.json({
      agents: [
        { id: "gemini", name: "Gemini CLI", version: "0.70.0", distribution: { npx: { package: "@google/gemini-cli@0.70.0" } } },
        { id: "github-copilot-cli", name: "Copilot", version: "1.0.114", distribution: { npx: { package: "@github/copilot@1.0.114" } } },
      ],
    }),
  );
  const res = await reg.read();
  const gem = res.agents.find((a) => a.id === "gemini");
  const cop = res.agents.find((a) => a.id === "github-copilot-cli");
  assert.equal(gem?.installable, false);
  assert.equal(cop?.installable, true);
});

test("BUG-282: AgyLoginSessions.submit отклоняет чужой loopback-порт и URL без redirect_uri", async (t) => {
  const c = fakeChild();
  const agy = new AgyLoginSessions(() => c);
  const { id } = agy.start("owner");
  c.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, authMethods: [{ id: "oauth-personal" }] } }) + "\n");
  const decoyHits = [];
  const decoy = http.createServer((req, res) => { decoyHits.push(req.url); res.end("decoy"); });
  await new Promise((r) => decoy.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => decoy.close(r)));
  const decoyPort = decoy.address().port;
  const expectedHits = [];
  const expectedSrv = http.createServer((req, res) => { expectedHits.push(req.url); res.end("expected"); });
  await new Promise((r) => expectedSrv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => expectedSrv.close(r)));
  const expectedPort = expectedSrv.address().port;
  c.stderr.write(`Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${expectedPort}/cb`)}\n`);
  await assert.rejects(agy.submit("owner", id, `http://127.0.0.1:${decoyPort}/?code=1`), /адрес/);
  await assert.rejects(agy.submit("owner", id, `http://127.0.0.1:${expectedPort}/other?code=1`), /адрес/);
  assert.deepEqual(decoyHits, [], "запрос на посторонний порт не уходит");
  assert.deepEqual(expectedHits, [], "запрос на чужой путь не уходит");
});

test("BUG-303: AgyLoginSessions.submit переживает гонку finish(ready) до завершения fetch без TypeError и не перезаписывает ready", async (t) => {
  const c = fakeChild();
  const agy = new AgyLoginSessions(() => c);
  const { id } = agy.start("owner");
  c.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, authMethods: [{ id: "oauth-personal" }] } }) + "\n");
  const relay = http.createServer((req, res) => {
    // Имитация: ACP-процесс успел завершить authenticate и закрыться, оборвав сокет до ответа HTTP
    c.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }) + "\n");
    req.socket.destroy();
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => relay.close(r)));
  const port = relay.address().port;
  c.stderr.write(`Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/cb`)}\n`);
  const st = await agy.submit("owner", id, `http://127.0.0.1:${port}/cb?code=1`);
  assert.equal(st.status, "ready");
  assert.equal(agy.get("owner").status, "ready");
});

test("BUG-303: AgyLoginSessions.submit использует redirect:manual и отклоняет 3xx-редирект без запроса на цель", async (t) => {
  const c = fakeChild();
  const agy = new AgyLoginSessions(() => c);
  const { id } = agy.start("owner");
  c.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, authMethods: [{ id: "oauth-personal" }] } }) + "\n");
  const targetHits = [];
  const target = http.createServer((req, res) => { targetHits.push(req.url); res.end("secret"); });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => target.close(r)));
  const targetPort = target.address().port;
  const relay = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/ssrf` });
    res.end();
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => relay.close(r)));
  const port = relay.address().port;
  c.stderr.write(`Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/cb`)}\n`);
  const st = await agy.submit("owner", id, `http://127.0.0.1:${port}/cb?code=1`);
  assert.deepEqual(targetHits, [], "3xx редирект не должен автоматически выполняться");
  assert.equal(st.status, "verification-timeout");
});

test("BUG-282: markAcpProfile ready не удаляет models-v1.json (удаляет только rejected)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-models-keep-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = acpProfileDir(dir, "admin", "antigravity");
  await mkdir(profile, { recursive: true });
  const cacheFile = path.join(profile, "models-v1.json");
  await writeFile(cacheFile, JSON.stringify({ availableModels: [{ modelId: "m1", name: "M1" }], updated: Date.now() }));
  markAcpProfile(dir, "admin", "antigravity", "ready");
  const kept = JSON.parse(await readFile(cacheFile, "utf8"));
  assert.equal(kept.availableModels[0].modelId, "m1");
  markAcpProfile(dir, "admin", "antigravity", "rejected");
  await assert.rejects(readFile(cacheFile, "utf8"));
});

test("BUG-282: github-copilot-cli на Linux получает системный PATH", { skip: process.platform !== "linux" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-cop-path-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = agentEntry(dir, "github-copilot-cli");
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, "console.log(process.env.PATH);\n");
  const child = launchAcpChat(dir, "admin", "github-copilot-cli", dir);
  let out = "";
  for await (const chunk of child.stdout) out += chunk;
  assert.match(out, /\/usr\/bin/);
});

test("BUG-282: runAcpChat принимает allow_always при отсутствии allow_once", async () => {
  const c = fakeChild();
  const sent = [];
  c.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) sent.push(JSON.parse(line));
  });
  const p = runAcpChat(c, { cwd: "/tmp", prompt: "hi", onText() {}, onPermission: async () => true });
  await new Promise((r) => setTimeout(r, 10));
  c.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }) + "\n");
  await new Promise((r) => setTimeout(r, 10));
  c.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "s1" } }) + "\n");
  await new Promise((r) => setTimeout(r, 10));
  c.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id: 99, method: "session/request_permission",
    params: { sessionId: "s1", toolCall: { kind: "read" }, options: [{ kind: "allow_always", optionId: "opt-always" }] },
  }) + "\n");
  await new Promise((r) => setTimeout(r, 20));
  const reply = sent.find((m) => m.id === 99);
  assert.deepEqual(reply?.result?.outcome, { outcome: "selected", optionId: "opt-always" });
  c.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } }) + "\n");
  await p;
});

test("BUG-282: acp-shim.mjs при admin:false и непустом owner НЕ даёт режим full", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-shim-admin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dst = agentEntry(dir, "github-copilot-cli");
  await mkdir(path.dirname(dst), { recursive: true });
  await copyFile("tests/fixtures/acp-chat-agent.mjs", dst);
  const shim = spawn(process.execPath, ["lib/acp-shim.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => shim.kill());
  const out = [];
  shim.stdout.on("data", (d) => {
    for (const line of String(d).split("\n").filter(Boolean)) {
      const msg = JSON.parse(line);
      out.push(msg);
      if (msg.type === "control_request") {
        shim.stdin.write(JSON.stringify({ type: "control_response", response: { request_id: msg.request_id, response: { behavior: "deny" } } }) + "\n");
      }
    }
  });
  shim.stdin.write(JSON.stringify({ dataDir: dir, owner: "tenant-1", admin: false, agent: "github-copilot-cli", modelId: null, resume: null, mode: null, context: "", prompt: "ask" }) + "\n");
  await new Promise((r) => shim.once("close", r));
  assert.ok(out.some((m) => m.type === "control_request"), "при admin:false должен спрашивать разрешение, а не full");
});

test("BUG-281: ClaudeRunner отклоняет revert/revertPreview для ACP-хода статусом 409", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-revert-"));
  let runner = null;
  t.after(async () => { runner?.shutdown(); await runner?.flushNow(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  const dst = agentEntry(dir, "github-copilot-cli");
  await mkdir(path.dirname(dst), { recursive: true });
  await copyFile("tests/fixtures/acp-chat-agent.mjs", dst);
  const events = [];
  runner = new ClaudeRunner({ storePath: path.join(dir, "sessions.json"), hub: { markManaged() {}, emit: (e) => events.push(e) } });
  await runner.dispatch({
    res: { writeHead() {}, end() {} }, sid: "c1", dir, access: "admin", acpOwner: "qa", permMode: "full",
    body: JSON.stringify({ model: { providerID: "acp-github-copilot-cli", modelID: "acp-github-copilot-cli" }, parts: [{ type: "text", text: "first" }] }),
  });
  for (let i = 0; i < 200 && !events.some((e) => e.type === "session.idle"); i++) await new Promise((r) => setTimeout(r, 10));
  const userMsg = runner.messages("c1").find((m) => m.info.role === "user");
  assert.equal(runner.revertPreview("c1", userMsg.info.id).status, 409);
  assert.equal(runner.revert("c1", userMsg.info.id).status, 409);
});

test("BUG-281: routes/git.js suggest-message на ACP-чате вызывает runAcpOneshot, а не OpenCode", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-git-suggest-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(path.join(dir, "a.txt"), "hello\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  await writeFile(path.join(dir, "a.txt"), "hello world\n");

  const dst = agentEntry(dir, "github-copilot-cli");
  await mkdir(path.dirname(dst), { recursive: true });
  await copyFile("tests/fixtures/acp-chat-agent.mjs", dst);

  let ocCalled = false;
  let status = 0, body = null;
  const routes = gitRoutes({
    sendJson: (res, s, b) => { status = s; body = b; },
    readJsonBody: async () => ({ sid: "s-acp", files: ["a.txt"] }),
    apiError: (res, s, e) => { status = s; body = { error: e }; },
    errLog: () => {},
    dirAllowed: () => true,
    existingChatFolder: () => true,
    isUnderAny: () => false,
    chatDirOf: async () => dir,
    bindingOf: async () => ({ engine: "acp", model: { providerID: "acp-github-copilot-cli", modelID: "acp-github-copilot-cli" } }),
    engineAllowed: () => true,
    tenantAgent: async () => null,
    tenantDir: () => null,
    getGitSettings: () => ({ pushAllowed: false }),
    setGitSettings: () => ({}),
    suggest: {
      claudeBin: "", codexShim: "", acpShim: path.resolve("lib/acp-shim.mjs"), dataDir: dir,
      oc: { createSession: async () => { ocCalled = true; throw new Error("should not call opencode"); } },
      token: null, timeoutMs: 15000,
    },
    worktreeDir: () => null,
  });
  await dispatchRoute(routes, {
    req: { method: "POST" }, res: {}, url: new URL("http://test/teleharness/api/git/suggest-message?sid=s-acp"),
    user: { id: "admin" }, admin: true,
  }, { sendJson: (res, s, b) => { status = s; body = b; } });
  assert.equal(ocCalled, false, "OpenCode не должен вызываться для ACP-чата");
  assert.equal(status, 200);
  assert.ok(typeof body?.message === "string" && body.message.length > 0);
});
