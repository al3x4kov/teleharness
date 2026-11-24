// FEAT-19.31 / TC-299: OpenCode (GLM-5.3-Flash / GLM-5.3) в Temporal пайпах (валидация, маршруты, мост, async chatStepRunner, OutcomeObserver quota_wait).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateDefinition } from "../shared/temporal-definition.js";
import { DefinitionStore } from "../lib/temporal/definitions.js";
import { temporalRoutes } from "../routes/temporal.js";
import { modelBridge } from "../lib/temporal/model-bridge.js";
import { chatStepRunner } from "../lib/temporal/chat-step.js";
import { chatAdapter } from "../lib/temporal/chat-adapter.js";
import { OutcomeObserver } from "../lib/attention.js";
import { isLimitError } from "../shared/turn-error.js";

const OC_MODEL = "glm-5.3-flash";
const OC_LABEL = "GLM-5.3-Flash";

function ocDefinition(dir, overrides = {}) {
  return {
    name: "GLM pipe",
    directory: dir,
    inputs: [],
    steps: [
      {
        id: "step1",
        name: "Шаг GLM-5.3-Flash",
        type: "model",
        engine: "opencode",
        model: OC_MODEL,
        instruction: "Ответь ОК",
        timeoutSeconds: 300,
        maxAttempts: 2,
        dependsOn: [],
        ...overrides,
      },
    ],
  };
}

test("FEAT-19.31: validateDefinition принимает engine='opencode' с glm-5.3-flash", () => {
  const ok = validateDefinition(ocDefinition("/proj"));
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
});

test("FEAT-19.31: /capabilities отдаёт opencode и modelLabels по engineAllowed; тенанту без opencode — 403", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "teleharness-oc-temporal-"));
  try {
    const store = new DefinitionStore({ file: path.join(dir, "defs.json") });
    const admin = { id: "u-admin", role: "admin", directories: [dir], engines: ["claude", "codex", "acp", "opencode"] };
    const tenantNoOc = { id: "u-no-oc", role: "user", directories: [dir], engines: ["claude"] };
    const tenantWithOc = { id: "u-with-oc", role: "user", directories: [dir], engines: ["opencode"] };

    let lastStatus = 0;
    let lastBody = null;
    const routes = temporalRoutes({
      store,
      sendJson: (_res, s, b) => { lastStatus = s; lastBody = b; },
      readJsonBody: async (req) => req._body ?? {},
      dirAllowed: (u, d) => u.role === "admin" || (u.directories ?? []).includes(d),
      engineAllowed: (u, e) => u.role === "admin" || (u.engines ?? []).includes(e),
      getUser: (id) => [admin, tenantNoOc, tenantWithOc].find((u) => u.id === id) ?? null,
      subscriptionModels: { claude: ["claude-opus-5-5"], codex: ["gpt-6.2-sol"], acp: ["gemini-4-neon-medium"], opencode: ["glm-5.3-flash", "glm-5.3"] },
      modelLabels: { "claude-opus-5-5": "Claude Opus 5.5", "gemini-4-neon-medium": "Gemini 4 Neon (Medium)", "glm-5.3-flash": OC_LABEL, "glm-5.3": "GLM-5.3" },
      startPipeline: async () => {},
    });

    const call = async (user, method, urlPath, bodyObj) => {
      lastStatus = 0; lastBody = null;
      const full = "/teleharness/api/temporal" + urlPath;
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = typeof r.path === "string" ? (r.path === full ? [full] : null) : full.match(r.path);
        if (!m) continue;
        await r.handler({ req: { _body: bodyObj }, res: {}, user, match: m });
        return { status: lastStatus, body: lastBody };
      }
      throw new Error(`No route for ${method} ${full}`);
    };

    // Admin sees opencode + labels
    const capAdmin = await call(admin, "GET", "/capabilities");
    assert.equal(capAdmin.status, 200);
    assert.ok(capAdmin.body.engines.includes("opencode"));
    assert.deepEqual(capAdmin.body.subscriptionModels.opencode, ["glm-5.3-flash", "glm-5.3"]);
    assert.equal(capAdmin.body.modelLabels["glm-5.3-flash"], OC_LABEL);

    // Tenant without opencode does NOT see opencode and gets 403 on POST /definitions
    const capNo = await call(tenantNoOc, "GET", "/capabilities");
    assert.equal(capNo.status, 200);
    assert.equal(capNo.body.engines.includes("opencode"), false);
    assert.equal(capNo.body.subscriptionModels.opencode, undefined);
    assert.equal(capNo.body.modelLabels["glm-5.3-flash"], undefined);
    const denyCreate = await call(tenantNoOc, "POST", "/definitions", { draft: ocDefinition(dir) });
    assert.equal(denyCreate.status, 403);

    // Tenant with opencode sees opencode and can create & publish
    const capYes = await call(tenantWithOc, "GET", "/capabilities");
    assert.equal(capYes.status, 200);
    assert.ok(capYes.body.engines.includes("opencode"));
    const created = await call(tenantWithOc, "POST", "/definitions", { draft: ocDefinition(dir) });
    assert.equal(created.status, 201);
    const pub = await call(tenantWithOc, "POST", `/definitions/${created.body.id}/publish`, { revision: created.body.revision });
    assert.equal(pub.status, 200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEAT-19.31: chatStepRunner + OutcomeObserver + modelBridge — async messagesOf, meta и quota_wait для OpenCode", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "teleharness-oc-step-"));
  const artDir = path.join(dir, "artifacts");
  try {
    const store = new DefinitionStore({ file: path.join(dir, "defs.json") });
    const admin = { id: "u-admin", role: "admin" };
    const rec = store.create(admin.id, ocDefinition(dir));
    store.publish(admin.id, rec.id, rec.revision);

    const seen = { created: [], titled: [], aborted: [], msgsMeta: [] };
    let runner;
    const observer = new OutcomeObserver({
      onTurnEnd: (sid, r) => {
        if (runner?.owns(sid)) {
          runner.onTurnEnd({
            sid,
            error: r?.error ?? (r?.kind === "done" || r?.kind === "stopped" ? null : r?.kind),
            reason: r?.kind === "stopped" ? "user" : r?.kind === "stalled" ? "stalled" : null,
          });
        }
      },
    });

    let mode = "ok";
    runner = chatStepRunner({
      createSession: async (opts) => {
        seen.created.push(opts);
        return "ses_oc_1";
      },
      setTitle: (sid, title, meta) => seen.titled.push({ sid, title, meta }),
      dispatchTurn: async ({ res, sid }) => {
        res.writeHead(204);
        res.end();
        setTimeout(() => {
          observer.observe(JSON.stringify({ type: "session.status", properties: { sessionID: sid, status: "busy" } }), dir);
          if (mode === "ok") {
            observer.observe(JSON.stringify({ type: "session.idle", properties: { sessionID: sid } }), dir);
          } else if (mode === "quota") {
            observer.observe(JSON.stringify({
              type: "session.error",
              properties: { sessionID: sid, terminal: true, error: { name: "provider.quota", message: "rate limit exceeded 429" } },
            }), dir);
          }
        }, 5);
      },
      messagesOf: async (sid, meta) => {
        seen.msgsMeta.push({ sid, meta });
        await new Promise((r) => setTimeout(r, 5));
        return [
          { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "PONG_GLM_53_FLASH" }] },
        ];
      },
      abort: (sid, meta) => seen.aborted.push({ sid, meta }),
      isLimit: (err, engine) => isLimitError(err, { engine }),
    });

    const adapter = chatAdapter({ engine: "opencode", models: ["glm-5.3-flash", "glm-5.3"], runner, artifactDirectory: artDir });
    const wfId = "11111111-1111-4111-8111-111111111111";
    const bridge = modelBridge({
      lookupStart: async () => ({ owner: admin.id, definitionId: rec.id, version: 1, inputs: "{}" }),
      getUser: async () => admin,
      store,
      dirAllowed: () => true,
      engineAllowed: () => true,
      adapters: { opencode: adapter },
      results: { read: async () => "", rememberChat: () => {} },
    });

    // 1. Resolve
    const resolved = await bridge("resolve", { workflowId: wfId, stepId: "step1" });
    assert.equal(resolved.engine, "opencode");

    // 2. Execute OK with async messagesOf
    const execOk = await bridge("execute", { workflowId: wfId, stepId: "step1" });
    assert.ok(execOk.receipt);
    assert.equal(seen.created[0].engine, "opencode");
    assert.equal(seen.created[0].model, OC_MODEL);
    assert.equal(seen.titled[0].meta.engine, "opencode");
    assert.equal(seen.titled[0].meta.admin, true);
    assert.equal(seen.msgsMeta[0].meta.engine, "opencode");
    assert.equal(runner.meta("ses_oc_1").engine, "opencode");

    // 3. Execute quota error -> quota_wait
    mode = "quota";
    const execQuota = await bridge("execute", { workflowId: wfId, stepId: "step1" });
    assert.equal(execQuota.state, "quota_wait");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
