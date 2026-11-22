// FEAT-18.7: Codex на уровне сервера — настоящий server.js, фейковый upstream,
// фейковый CLI вместо посредника Codex (TELEHARNESS_CODEX_SHIM), каталог Codex из кэша
// data/codex-models.json. Каталог у admin; чат Codex идёт через раннер;
// тенант без движка codex — нет каталога и 403; с включённым — есть;
// Relay Codex → Claude вкладывает пропущенный ход Codex.
// Run: node --test tests/codex-server.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n");
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const HOME = mkdtempSync(path.join(tmpdir(), "teleharness-codex-srv-home-"));
const DATA = mkdtempSync(path.join(tmpdir(), "teleharness-codex-srv-data-"));
const ADMIN_TOKEN = "x".repeat(20) + "-codex-srv-test-" + "7".repeat(24);
writeFileSync(path.join(DATA, "codex-models.json"), JSON.stringify({ models: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true }, { id: "gpt-6-astra", displayName: "GPT-6-Astra" }] }));

const http = await import("node:http");
let created = 0;
const upstreamSrv = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  req.resume();
  req.on("end", () => {
    if (req.method === "POST" && url.pathname === "/session") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: `ses_k${++created}`, directory: HOME }));
    }
    if (url.pathname === "/session") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("[]");
    }
    if (url.pathname === "/provider") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ connected: ["zai-coding-plan"], all: [{ id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM 5.3", status: "active" } } }], default: { "zai-coding-plan": "glm-5.3" } }));
    }
    if (url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const t = setInterval(() => res.write(": ping\n\n"), 1000);
      req.on("close", () => clearInterval(t));
      return;
    }
    if (/\/message$/.test(url.pathname)) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("[]");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((r) => upstreamSrv.listen(0, "127.0.0.1", r));

const srv = await spawnPortal({
  upstream: `http://127.0.0.1:${upstreamSrv.address().port}`,
  env: { TELEHARNESS_HOME: HOME, TELEHARNESS_CHAT_DIR: HOME, TELEHARNESS_DATA_DIR: DATA, TELEHARNESS_ADMIN_TOKEN: ADMIN_TOKEN, TELEHARNESS_CLAUDE_BIN: FIXTURE, TELEHARNESS_CODEX_SHIM: FIXTURE, TELEHARNESS_CLAUDE_TIMEOUT_MS: "8000" },
});
after(async () => {
  await srv.stop();
  upstreamSrv.close();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  rmSync(DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
const base = srv.base;
const login = await fetch(`${base}/teleharness/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ADMIN_TOKEN }) });
assert.equal(login.status, 200);
const AUTH = login.headers.getSetCookie().join("\n").match(/teleharness_t=[^;]+/)[0];
const q = "?directory=" + encodeURIComponent(HOME);
const api = (p, { method = "GET", body, token = null } = {}) =>
  fetch(`${base}${p}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : { cookie: AUTH }), origin: base, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const CODEX = { providerID: "openai-codex", modelID: "gpt-6.1-sol" };
const HAIKU = { providerID: "anthropic", modelID: "claude-haiku-4-5" };
async function lastAnswer(id, n, token = null) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const m = await (await api(`/teleharness/api/session/${id}/message${q}`, { token })).json();
    const answers = Array.isArray(m) ? m.filter((x) => x.info.role === "assistant" && x.info.time?.completed) : [];
    if (answers.length >= n) return answers[n - 1];
  }
  return null;
}

test("admin: каталог /provider содержит Codex с основной моделью", async () => {
  let json = null;
  for (let i = 0; i < 20 && !json?.connected?.includes("openai-codex"); i++) {
    json = await (await api("/teleharness/api/provider")).json();
    if (!json.connected.includes("openai-codex")) await new Promise((r) => setTimeout(r, 300));
  }
  assert.ok(json.connected.includes("openai-codex"), JSON.stringify(json.connected));
  const p = json.all.find((x) => x.id === "openai-codex");
  assert.ok(p.models["gpt-6.1-sol"] && p.models["gpt-6-astra"]);
  assert.equal(json.default["openai-codex"], "gpt-6.1-sol");
});

test("чат Codex: привязка codex, ход через посредника, ответ помечен openai-codex", async () => {
  const c = await (await api(`/teleharness/api/session${q}`, { method: "POST", body: { model: CODEX } })).json();
  assert.equal(c.teleharness.engine, "codex");
  assert.equal(c.teleharness.agent ?? null, null);
  const r = await api(`/teleharness/api/session/${c.id}/prompt${q}`, { method: "POST", body: { model: CODEX, parts: [{ type: "text", text: "ECHO привет Codex" }] } });
  assert.equal(r.status, 204);
  const a = await lastAnswer(c.id, 1);
  assert.ok(a, "ответ пришёл");
  assert.equal(a.info.providerID, "openai-codex");
  const echo = JSON.parse(textOf(a));
  assert.ok(echo.argv.includes("gpt-6.1-sol"));
});

test("FEAT-18.7: тенанту Codex не включается — нет в каталоге, чат Codex 403, engines с codex — 400", async () => {
  const t = await (await api("/teleharness/api/admin/users", { method: "POST", body: { name: "codextenant" } })).json();
  assert.ok(t.token);
  const prov = await (await api("/teleharness/api/provider", { token: t.token })).json();
  assert.equal(prov.connected.includes("openai-codex"), false);
  const denied = await api(`/teleharness/api/session`, { method: "POST", body: { model: CODEX }, token: t.token });
  assert.equal(denied.status, 403);
  const id = t.user?.id ?? t.id;
  const p = await api(`/teleharness/api/admin/users/${id}`, { method: "PATCH", body: { engines: ["opencode", "codex"] } });
  assert.equal(p.status, 400, "Codex тенанту не включается до настройки песочницы Codex");
  const prov2 = await (await api("/teleharness/api/provider", { token: t.token })).json();
  assert.equal(prov2.connected.includes("openai-codex"), false);
  assert.equal((await api(`/teleharness/api/session`, { method: "POST", body: { model: CODEX }, token: t.token })).status, 403);
});

test("FEAT-18.7: в Codex-чате admin «Правки без вопросов» — 400, «Спрашивать» и «Без вопросов» — 200", async () => {
  const c = await (await api(`/teleharness/api/session${q}`, { method: "POST", body: { model: CODEX } })).json();
  assert.equal((await api(`/teleharness/api/session/${c.id}/binding${q}`, { method: "PATCH", body: { permMode: "edits" } })).status, 400);
  assert.equal((await api(`/teleharness/api/session/${c.id}/binding${q}`, { method: "PATCH", body: { permMode: "ask" } })).status, 200);
  assert.equal((await api(`/teleharness/api/session/${c.id}/binding${q}`, { method: "PATCH", body: { permMode: "full" } })).status, 200);
});

test("admin Codex: Workflow selected at creation and changed between turns through binding", async () => {
  const catalog = await (await api("/teleharness/api/claude/agents")).json();
  assert.ok(catalog.agents.some((a) => a.id === "workflow"));
  const c = await (await api(`/teleharness/api/session${q}`, { method: "POST", body: { model: CODEX, agent: "workflow" } })).json();
  assert.equal(c.teleharness.agent, "workflow");
  const missing = await api(`/teleharness/api/session/${c.id}/binding${q}`, { method: "PATCH", body: { agent: "missing-profile" } });
  assert.equal(missing.status, 200);
  assert.equal((await missing.json()).teleharness.agent, null, "unknown role cannot persist");
  const pick = await api(`/teleharness/api/session/${c.id}/binding${q}`, { method: "PATCH", body: { agent: "workflow" } });
  assert.equal((await pick.json()).teleharness.agent, "workflow");
  const r = await api(`/teleharness/api/session/${c.id}/prompt${q}`, { method: "POST", body: { model: CODEX, agent: "injected", parts: [{ type: "text", text: "ECHO selected role" }] } });
  assert.equal(r.status, 204);
  const a = await lastAnswer(c.id, 1);
  assert.ok(a);
  const echo = JSON.parse(textOf(a));
  assert.equal(echo.argv[echo.argv.indexOf("--agent") + 1], "workflow");
  const clear = await api(`/teleharness/api/session/${c.id}/binding${q}`, { method: "PATCH", body: { agent: null } });
  assert.equal((await clear.json()).teleharness.agent, null);
});

test("Relay Codex → Claude: Claude получает пропущенный ход Codex", async () => {
  const c = await (await api(`/teleharness/api/session${q}`, { method: "POST", body: { model: CODEX } })).json();
  assert.equal((await api(`/teleharness/api/session/${c.id}/prompt${q}`, { method: "POST", body: { model: CODEX, parts: [{ type: "text", text: "ECHO меня зовут Алекс" }] } })).status, 204);
  assert.ok(await lastAnswer(c.id, 1));
  const rel = await api(`/teleharness/api/session/${c.id}/binding${q}`, { method: "PATCH", body: { relay: true, model: HAIKU } });
  assert.equal(rel.status, 200);
  assert.equal((await rel.json()).teleharness.engine, "claude");
  assert.equal((await api(`/teleharness/api/session/${c.id}/prompt${q}`, { method: "POST", body: { model: HAIKU, parts: [{ type: "text", text: "ECHO как меня зовут?" }] } })).status, 204);
  const a = await lastAnswer(c.id, 2);
  assert.equal(a.info.providerID, "anthropic");
  const prompt = JSON.parse(textOf(a).replace(/\(resumed\)/g, "")).prompt;
  assert.match(prompt, /меня зовут Алекс/, "в запрос Claude вложен пропущенный ход Codex");
  assert.ok(!JSON.parse(textOf(a).replace(/\(resumed\)/g, "")).argv.includes("--resume"), "Claude не продолжает разговор Codex");
});

test("FEAT-20.4: вход ACP → выбор модели → два сообщения через HTTP портала", async()=>{
  const {agentEntry}=await import("../lib/acp-registry.js");
  const {mkdir,copyFile,chmod}=await import("node:fs/promises");
  // FEAT-20.4: antigravity — бинарная поставка (наружный список движков, gemini
  // убран): фикстура-«бинарник» запускается напрямую, вход — вставка адреса
  // страницы после входа (loopback-редирект Google).
  for(const agent of ["antigravity","github-copilot-cli"]){
    const file=agentEntry(DATA,agent);
    await mkdir(path.dirname(file),{recursive:true});
    if(agent==="antigravity"){
      // «Бинарник» — sh-шима (node не исполняет .par); каталог берётся
      // подстановкой ${0%/*}, потому что в env агента нет /usr/bin.
      const {writeFile}=await import("node:fs/promises");
      await copyFile(path.join(ROOT,"tests/fixtures/acp-agy-fake.mjs"),path.join(path.dirname(file),"agy-fake.mjs"));
      await writeFile(file,'#!/usr/bin/env node\nconst p=require("node:path"),{pathToFileURL}=require("node:url");\nimport(pathToFileURL(p.join(__dirname,"agy-fake.mjs")).href).catch(e=>{console.error(e);process.exit(1);});\n');
      await chmod(file,0o755);
    } else await copyFile(path.join(ROOT,"tests/fixtures/acp-chat-agent.mjs"),file);
    const loginPath="/teleharness/api/acp/"+agent+"/login";
    let state=await (await api(loginPath,{method:"POST",body:{action:"start",confirmed:true}})).json();
    if(agent==="antigravity"){
      for(let i=0;i<100 && state.status!=="awaiting-code";i++){
        await new Promise(resolve=>setTimeout(resolve,25));
        state=await (await api(loginPath)).json();
      }
      assert.equal(state.status,"awaiting-code",agent);
      const port=decodeURIComponent(state.url).match(/127\.0\.0\.1:(\d+)\//)?.[1];
      assert.ok(port,"в ссылке входа есть адрес слушателя: "+state.url);
      state=await (await api(loginPath,{method:"POST",body:{action:"submit",id:state.id,url:`http://127.0.0.1:${port}/?code=4/test&state=fake-state`}})).json();
    }
    for(let i=0;i<100 && state.status!=="ready";i++){
      await new Promise(resolve=>setTimeout(resolve,25));
      state=await (await api(loginPath)).json();
    }
    assert.equal(state.status,"ready",agent);
    const key="acp-"+agent;
    const catalog=await (await api("/teleharness/api/provider")).json();
    assert.ok(catalog.connected.includes(key));
    const modelID = agent === "antigravity" ? "neon-test" : key;
    assert.ok(catalog.all.find(p => p.id === key).models[modelID]);
    const model={providerID:key,modelID};
    const chat=await (await api("/teleharness/api/session"+q,{method:"POST",body:{model}})).json();
    assert.equal(chat.teleharness.engine,"acp");
    for(const [index,expected] of ["one two","one resumed"].entries()){
      const r=await api("/teleharness/api/session/"+chat.id+"/prompt"+q,{method:"POST",body:{model,parts:[{type:"text",text:"hello"}]}});
      assert.equal(r.status,204);
      const answer=await lastAnswer(chat.id,index+1);
      assert.equal(answer?.info.providerID,key);
      assert.equal(answer.info.modelID, modelID);
      assert.equal(textOf(answer),agent === "antigravity" ? expected.replace("one","neon-test") : expected);
    }
    if (agent === "antigravity") {
      const response = await api("/teleharness/api/session/"+chat.id+"/prompt"+q, {method:"POST",
        body:{model,parts:[{type:"text",text:"ask"}]}});
      assert.equal(response.status,204);
      assert.equal(textOf(await lastAnswer(chat.id,3)),"selected","режим администратора по умолчанию разрешает инструмент без диалога");
    }
  }
});
