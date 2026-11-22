// FEAT-19.30 / TC-298: Gemini (ACP) в Temporal пайпах (валидация, маршруты, мост, раннер, nonInteractive-изоляция).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { validateDefinition } from "../shared/temporal-definition.js";
import { DefinitionStore } from "../lib/temporal/definitions.js";
import { temporalRoutes } from "../routes/temporal.js";
import { modelBridge } from "../lib/temporal/model-bridge.js";
import { chatStepRunner } from "../lib/temporal/chat-step.js";
import { isLimitError } from "../shared/turn-error.js";
import { agentEntry } from "../lib/acp-registry.js";

const ACP_MODEL = "gemini-4-neon-medium";
const ACP_LABEL = "Gemini 4 Neon (Medium)";

function acpDefinition(dir, overrides = {}) {
  return {
    name: "Gemini pipe",
    directory: dir,
    inputs: [],
    steps: [
      {
        id: "step1",
        name: "Проверка Gemini",
        type: "model",
        engine: "acp",
        model: ACP_MODEL,
        instruction: "Ответь ОК",
        timeoutSeconds: 300,
        maxAttempts: 2,
        dependsOn: [],
        ...overrides,
      },
    ],
  };
}

function makeRouteCaller(routes, user) {
  return async (method, urlPath, bodyObj) => {
    const full = "/teleharness/api/temporal" + urlPath;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = typeof r.path === "string" ? (r.path === full ? [full] : null) : full.match(r.path);
      if (!m) continue;
      let status = 0;
      let payload = null;
      const res = {};
      await r.handler({
        req: { _body: bodyObj },
        res,
        user,
        match: m,
        send: (s, b) => { status = s; payload = b; },
      });
      return { status, body: payload };
    }
    throw new Error(`No route for ${method} ${full}`);
  };
}

test("FEAT-19.30: validateDefinition принимает engine='acp' и отклоняет неизвестный движок", () => {
  const ok = validateDefinition(acpDefinition("/proj"));
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));

  const bad = validateDefinition(acpDefinition("/proj", { engine: "unknown-engine" }));
  assert.equal(bad.valid, false);
  assert(bad.errors.some((e) => e.field === "step1"));
});

test("FEAT-19.30: /capabilities и права доступа для admin, тенанта без acp и тенанта с acp", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "teleharness-t-acp-routes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DefinitionStore({ file: path.join(dir, "defs.json") });
  const proj = path.join(dir, "proj");
  await mkdir(proj, { recursive: true });

  const admin = { id: "admin", role: "admin" };
  const tenantNoAcp = { id: "u-no", role: "user", engines: ["claude"] };
  const tenantWithAcp = { id: "u-yes", role: "user", engines: ["claude", "acp"] };

  const engineAllowed = (user, eng) => user.role === "admin" || (user.engines ?? []).includes(eng);
  let lastStatus = 0;
  let lastBody = null;
  const routes = temporalRoutes({
    store,
    sendJson: (_res, status, obj) => { lastStatus = status; lastBody = obj; },
    readJsonBody: async (req) => req._body,
    dirAllowed: () => true,
    engineAllowed,
    subscriptionModels: { claude: ["claude-sonnet-4-6"], codex: ["gpt-5.4"], acp: [ACP_MODEL] },
    modelLabels: { "claude-sonnet-4-6": "Claude Sonnet 4.6", "gpt-5.4": "GPT-5.4", [ACP_MODEL]: ACP_LABEL },
    startPipeline: async () => {},
  });

  async function call(user, method, urlPath, bodyObj) {
    lastStatus = 0;
    lastBody = null;
    const full = "/teleharness/api/temporal" + urlPath;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = typeof r.path === "string" ? (r.path === full ? [full] : null) : full.match(r.path);
      if (!m) continue;
      await r.handler({ req: { _body: bodyObj }, res: {}, user, match: m });
      return { status: lastStatus, body: lastBody };
    }
    throw new Error(`No route ${method} ${full}`);
  }

  // Admin sees acp + Gemini model + label
  const adminCaps = await call(admin, "GET", "/capabilities");
  assert.equal(adminCaps.status, 200);
  assert.deepEqual(adminCaps.body.engines, ["claude", "codex", "acp", "opencode"]);
  assert.deepEqual(adminCaps.body.subscriptionModels.acp, [ACP_MODEL]);
  assert.equal(adminCaps.body.modelLabels[ACP_MODEL], ACP_LABEL);

  // Tenant WITHOUT acp does not see acp, models, or labels, and gets 403 on create
  const noCaps = await call(tenantNoAcp, "GET", "/capabilities");
  assert.equal(noCaps.status, 200);
  assert(!noCaps.body.engines.includes("acp"));
  assert.equal(noCaps.body.subscriptionModels.acp, undefined);
  assert.equal(noCaps.body.modelLabels[ACP_MODEL], undefined);
  const denied = await call(tenantNoAcp, "POST", "/definitions", { draft: acpDefinition(proj) });
  assert.equal(denied.status, 403);

  // Tenant WITH acp sees acp, models, labels, and can create + publish
  const yesCaps = await call(tenantWithAcp, "GET", "/capabilities");
  assert.equal(yesCaps.status, 200);
  assert(yesCaps.body.engines.includes("acp"));
  assert.deepEqual(yesCaps.body.subscriptionModels.acp, [ACP_MODEL]);
  assert.equal(yesCaps.body.modelLabels[ACP_MODEL], ACP_LABEL);
  const created = await call(tenantWithAcp, "POST", "/definitions", { draft: acpDefinition(proj) });
  assert.equal(created.status, 201);
  const pub = await call(tenantWithAcp, "POST", `/definitions/${created.body.id}/publish`, { revision: created.body.revision });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.versions.length, 1);
});

test("FEAT-19.30: modelBridge пропускает engine='acp' для admin и тенанта с acp, отклоняет тенанта без acp (403) и неизвестную модель (503)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "teleharness-t-acp-bridge-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DefinitionStore({ file: path.join(dir, "defs.json") });
  const proj = path.join(dir, "proj");
  await mkdir(proj, { recursive: true });

  const users = new Map([
    ["admin", { id: "admin", role: "admin" }],
    ["t-ok", { id: "t-ok", role: "user", engines: ["acp"] }],
    ["t-no", { id: "t-no", role: "user", engines: ["claude"] }],
  ]);
  const wfIds = {
    admin: "10000000-0000-4000-8000-000000000001",
    "t-ok": "10000000-0000-4000-8000-000000000002",
    "t-no": "10000000-0000-4000-8000-000000000003",
    bad: "10000000-0000-4000-8000-000000000004",
  };
  const runs = new Map();
  for (const uid of users.keys()) {
    const rec = store.create(uid, acpDefinition(proj));
    store.publish(uid, rec.id, rec.revision);
    runs.set(wfIds[uid], { owner: uid, definitionId: rec.id, version: 1, inputs: "{}" });
  }
  const badModelRec = store.create("admin", acpDefinition(proj, { model: "nonexistent-gemini" }));
  store.publish("admin", badModelRec.id, badModelRec.revision);
  runs.set(wfIds.bad, { owner: "admin", definitionId: badModelRec.id, version: 1, inputs: "{}" });

  const calls = [];
  const bridge = modelBridge({
    store,
    getUser: (id) => users.get(id) ?? null,
    lookupStart: (wf) => runs.get(wf) ?? null,
    dirAllowed: () => true,
    engineAllowed: (u, e) => u.role === "admin" || (u.engines ?? []).includes(e),
    adapters: {
      acp: {
        models: [ACP_MODEL],
        subscriptionOnly: true,
        textOnly: true,
        check: async () => "ready",
        execute: async (arg) => {
          calls.push(arg);
          return { receipt: "00000000-0000-4000-8000-000000000001", sessionId: "ses_acp_1" };
        },
      },
    },
  });

  // Admin resolve + execute
  const rAdmin = await bridge("resolve", { workflowId: wfIds.admin, stepId: "step1" });
  assert.deepEqual(rAdmin, { tenant: "admin", engine: "acp" });
  const eAdmin = await bridge("execute", { workflowId: wfIds.admin, stepId: "step1" });
  assert.equal(eAdmin.receipt, "00000000-0000-4000-8000-000000000001");

  // Tenant WITH acp resolve + execute
  const rTok = await bridge("resolve", { workflowId: wfIds["t-ok"], stepId: "step1" });
  assert.deepEqual(rTok, { tenant: "t-ok", engine: "acp" });
  const eTok = await bridge("execute", { workflowId: wfIds["t-ok"], stepId: "step1" });
  assert.equal(eTok.receipt, "00000000-0000-4000-8000-000000000001");
  assert.equal(calls.length, 2);

  // Tenant WITHOUT acp → 403
  await assert.rejects(bridge("resolve", { workflowId: wfIds["t-no"], stepId: "step1" }), { status: 403 });
  await assert.rejects(bridge("execute", { workflowId: wfIds["t-no"], stepId: "step1" }), { status: 403 });

  // Unknown ACP model → 503
  await assert.rejects(bridge("resolve", { workflowId: wfIds.bad, stepId: "step1" }), { status: 503 });
});

test("FEAT-19.30: chatStepRunner выполняет шаг engine='acp' и распознаёт quota_wait", async () => {
  let createdEngine = null;
  const messages = new Map();
  const runner = chatStepRunner({
    createSession: async ({ engine, model }) => {
      createdEngine = { engine, model };
      return "ses_step_acp";
    },
    dispatchTurn: async ({ res, sid }) => {
      res.writeHead(204);
      res.end();
      setImmediate(() => {
        messages.set(sid, [{ info: { role: "assistant" }, parts: [{ type: "text", text: "ОК" }] }]);
        runner.onTurnEnd({ sid, error: null, reason: null });
      });
    },
    messagesOf: (sid) => messages.get(sid) ?? [],
    abort: () => {},
    isLimit: (err, eng) => isLimitError(err, { engine: eng }),
  });

  const out = await runner.run({
    user: { id: "admin", role: "admin" },
    engine: "acp",
    model: ACP_MODEL,
    directory: "/tmp",
    runFolder: "runs/r1",
    title: "⇄ test",
    instruction: "Ответь ОК",
    timeoutMs: 5000,
  });
  assert.deepEqual(createdEngine, { engine: "acp", model: ACP_MODEL });
  assert.equal(out.text, "ОК");
  assert.equal(out.sessionId, "ses_step_acp");

  // Quota wait mapping for ACP 429 error
  const runnerQ = chatStepRunner({
    createSession: async () => "ses_step_acp_q",
    dispatchTurn: async ({ res, sid }) => {
      res.writeHead(204);
      res.end();
      setImmediate(() => runnerQ.onTurnEnd({ sid, error: "Агент ACP вернул ошибку: 429 RESOURCE_EXHAUSTED", reason: null }));
    },
    messagesOf: () => [],
    abort: () => {},
    isLimit: (err, eng) => isLimitError(err, { engine: eng }),
  });
  const qOut = await runnerQ.run({
    user: { id: "admin", role: "admin" },
    engine: "acp",
    model: ACP_MODEL,
    directory: "/tmp",
    runFolder: "runs/r2",
    title: "⇄ test",
    instruction: "Ответь ОК",
    timeoutMs: 5000,
  });
  assert.deepEqual(qOut, { state: "quota_wait", sessionId: "ses_step_acp_q" });
});

test("FEAT-19.30: acp-shim nonInteractive=true для тенанта авто-одобряет безопасный файл в cwd, но отклоняет shell и путь вне cwd без зависания", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "teleharness-acp-ni-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workDir = path.join(dir, "work");
  await mkdir(workDir, { recursive: true });

  // Fake ACP agent installed under dataDir/acp-agents/gemini/... (spawned via node)
  const fakeEntry = agentEntry(dir, "gemini");
  await mkdir(path.dirname(fakeEntry), { recursive: true });
  const fakeAgentCode = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let nextReq = 100;
const pending = new Map();
function askPerm(toolCall) {
  const id = nextReq++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall,
        options: [
          { optionId: "allow", kind: "allow_once" },
          { optionId: "deny", kind: "reject_once" },
        ],
      },
    });
  });
}
(async () => { for await (const line of rl) {
  const msg = JSON.parse(line);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result?.outcome?.optionId ?? "cancelled");
    pending.delete(msg.id);
    continue;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });
  } else if (msg.method === "session/prompt") {
    void (async () => {
    const promptText = msg.params?.prompt?.[0]?.text ?? "";
    if (promptText.includes("CASE_NONINTERACTIVE")) {
      const d1 = await askPerm({ toolCallId: "t1", kind: "read", title: "read note", rawInput: { path: "note.md" } });
      const d2 = await askPerm({ toolCallId: "t2", kind: "execute", title: "shell", rawInput: { command: "id" } });
      const d3 = await askPerm({ toolCallId: "t3", kind: "read", title: "escape", rawInput: { path: "../secret.txt" } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ d1, d2, d3 }) } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else if (promptText.includes("CASE_INTERACTIVE")) {
      const d1 = await askPerm({ toolCallId: "t4", kind: "read", title: "read note", rawInput: { path: "note.md" } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ d1 }) } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
    })();
  }
} })();
`;
  await writeFile(fakeEntry, fakeAgentCode, "utf8");

  const shimPath = path.resolve(import.meta.dirname, "../lib/acp-shim.mjs");

  async function runShim(turnPayload, onControlRequest = null) {
    const child = spawn(process.execPath, [shimPath], { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
    const events = [];
    const rl = readline.createInterface({ input: child.stdout });
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("acp-shim timed out")); }, 8000);
      rl.on("line", (line) => {
        const ev = JSON.parse(line);
        events.push(ev);
        if (ev.type === "control_request" && onControlRequest) {
          const behavior = onControlRequest(ev);
          child.stdin.write(JSON.stringify({ response: { request_id: ev.request_id, response: { behavior } } }) + "\n");
        }
      });
      child.on("close", () => { clearTimeout(timer); resolve(events); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    child.stdin.write(JSON.stringify(turnPayload) + "\n");
    const evs = await done;
    return evs;
  }

  // Case 1: Tenant in Temporal (nonInteractive=true) -> safe file auto-approved, shell & outside-cwd denied, ZERO control_request
  const evs1 = await runShim({
    dataDir: dir,
    owner: "admin",
    admin: false,
    agent: "gemini",
    modelId: null,
    resume: null,
    mode: "ask",
    nonInteractive: true,
    context: "",
    images: [],
    prompt: "CASE_NONINTERACTIVE",
  });
  assert.equal(evs1.filter((e) => e.type === "control_request").length, 0, "в nonInteractive не должно быть интерактивных control_request");
  const res1 = evs1.find((e) => e.type === "result");
  assert.equal(res1?.is_error, false);
  assert.deepEqual(JSON.parse(res1.result), { d1: "allow", d2: "cancelled", d3: "cancelled" });

  // Case 2: Tenant in interactive chat (nonInteractive=false) -> safe file DOES emit control_request
  let sawControl = false;
  const evs2 = await runShim(
    {
      dataDir: dir,
      owner: "admin",
      admin: false,
      agent: "gemini",
      modelId: null,
      resume: null,
      mode: "ask",
      nonInteractive: false,
      context: "",
      images: [],
      prompt: "CASE_INTERACTIVE",
    },
    () => { sawControl = true; return "allow"; },
  );
  assert.equal(sawControl, true, "интерактивный чат тенанта по-прежнему запрашивает подтверждение");
  const res2 = evs2.find((e) => e.type === "result");
  assert.deepEqual(JSON.parse(res2.result), { d1: "allow" });

  // Case 3: Admin in Temporal (mode=full, nonInteractive=true) -> all tools approved
  const evs3 = await runShim({
    dataDir: dir,
    owner: "admin",
    admin: true,
    agent: "gemini",
    modelId: null,
    resume: null,
    mode: "full",
    nonInteractive: true,
    context: "",
    images: [],
    prompt: "CASE_NONINTERACTIVE",
  });
  const res3 = evs3.find((e) => e.type === "result");
  assert.deepEqual(JSON.parse(res3.result), { d1: "allow", d2: "allow", d3: "allow" });
});
