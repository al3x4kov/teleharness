// @suite: server
// Регрессия server-e2e для BUG-295 (Auto-Relay с Gemini/ACP), BUG-296 (Relay catch-up Gemini→Claude),
// BUG-297 («Сначала план» для Gemini/ACP).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { makeTmpRoot } from "./helpers/env.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { waitFor } from "./helpers/wait.mjs";
import { acpProfileDir } from "../lib/acp-login-launch.js";
import { agentEntry } from "../lib/acp-registry.js";
import { RELAY_REASON_AUTO } from "../shared/relay.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_FAKE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const ADMIN = "d".repeat(20) + "-admin-token-" + "9".repeat(24);
const TMP = mkdtempSync(path.join(tmpdir(), "teleharness-acp-295-"));
const KB = path.join(TMP, "kb");
const DIR = path.join(TMP, "proj");
mkdirSync(DIR, { recursive: true });

const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3" };
const HAIKU = { providerID: "anthropic", modelID: "claude-haiku-4-5" };
const GEMINI = { providerID: "acp-antigravity", modelID: "gemini-4-neon-medium" };
const T0 = Date.now() - 120_000;

const ACP_FAKE_SCRIPT = `
import readline from "node:readline";
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...v }) + "\\n");
let sidSeq = 0;
let permReqId = 1000;
const pendingPerm = new Map();
for await (const line of readline.createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.id != null && !msg.method && pendingPerm.has(msg.id)) {
    const fn = pendingPerm.get(msg.id);
    pendingPerm.delete(msg.id);
    fn(msg.result);
    continue;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [{ id: "oauth-personal" }] } });
  } else if (method === "session/new") {
    send({
      id,
      result: {
        sessionId: "acp-s-" + (++sidSeq),
        models: {
          currentModelId: "gemini-4-neon-medium",
          availableModels: [{ modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" }],
        },
      },
    });
  } else if (method === "session/load" || method === "session/set_model") {
    send({ id, result: {} });
  } else if (method === "session/prompt") {
    const text = (params.prompt || []).find((b) => b.type === "text")?.text ?? "";
    const chunk = (t) => send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } } });
    if (text.includes("ACP_LIMIT")) {
      send({ id, error: { code: -32000, message: "429 Too Many Requests: quota exceeded" } });
      continue;
    }
    if (text.includes("ACP_PLAN_CHECK")) {
      const hasPlanRule = text.includes("Сначала план");
      const reqId = ++permReqId;
      send({
        id: reqId,
        method: "session/request_permission",
        params: {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "t-edit", kind: "edit", title: "edit foo.txt" },
          options: [{ optionId: "allow", kind: "allow_once" }],
        },
      });
      pendingPerm.set(reqId, (res) => {
        const denied = res?.outcome?.outcome === "cancelled";
        chunk("ПЛАН_ACP: Шаг 1. Проверить. (planRule=" + hasPlanRule + ", editDenied=" + denied + ")");
        send({ id, result: { stopReason: "end_turn" } });
      });
      continue;
    }
    if (text.includes("SECRET_GEMINI_FACT")) {
      chunk("ЗАПОМНИЛ_СЕКРЕТ_7731");
      send({ id, result: { stopReason: "end_turn" } });
      continue;
    }
    chunk("GEMINI_OK:" + text.slice(-80));
    send({ id, result: { stopReason: "end_turn" } });
  }
}
`;

let up, srv, tenant, adminId;
const q = (d = DIR) => `?directory=${encodeURIComponent(d)}`;
const api = (p, { method = "GET", body, token = ADMIN } = {}) =>
  fetch(srv.base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, origin: srv.base, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

function seedChat(id, directory = DIR) {
  up.state.sessions.push({ id, directory, title: `чат ${id}`, model: GLM });
  up.state.messages[id] = [
    { info: { id: `${id}_u1`, role: "user", sessionID: id, time: { created: T0 } }, parts: [{ id: `${id}_p1`, type: "text", text: "Стартовый вопрос" }] },
    { info: { id: `${id}_a1`, role: "assistant", sessionID: id, modelID: "glm-5.3", time: { created: T0 + 1000, completed: T0 + 5000 } }, parts: [{ id: `${id}_p2`, type: "text", text: "Стартовый ответ" }] },
  ];
}

before(async () => {
  up = await startFakeOpencode();
  up.route("GET", "/provider", () => ({
    json: {
      all: [{ id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" } } }],
      connected: ["zai-coding-plan"],
      default: { "zai-coding-plan": "glm-5.3" },
    },
  }));
  up.route("GET", "/agent", () => ({
    json: [{ name: "Sandbox", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "allow" }, { permission: "task", pattern: "*", action: "deny" }, { permission: "external_directory", pattern: "*", action: "deny" }] }],
  }));

  seedChat("ses_ar_to_gem");
  seedChat("ses_ar_from_gem");
  seedChat("ses_catchup_gem");
  seedChat("ses_plan_gem");

  const tmp = makeTmpRoot();
  const entryBin = agentEntry(tmp.data, "antigravity");
  mkdirSync(path.dirname(entryBin), { recursive: true });
  const fakeScript = path.join(path.dirname(entryBin), "fake-acp.mjs");
  writeFileSync(fakeScript, ACP_FAKE_SCRIPT);
  writeFileSync(entryBin, `#!/usr/bin/env bash\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });

  srv = await spawnPortal({
    tmp,
    upstream: up.url,
    env: {
      TELEHARNESS_ADMIN_TOKEN: ADMIN,
      TELEHARNESS_KB_ROOT: KB,
      TELEHARNESS_JOURNAL_DEBOUNCE_MS: "20",
      TELEHARNESS_CLAUDE_BIN: CLAUDE_FAKE,
      TELEHARNESS_CLAUDE_TIMEOUT_MS: "10000",
      TELEHARNESS_AUTO_RELAY_DELAY_MS: "50",
      TELEHARNESS_TENANT_AGENT: "Sandbox",
    },
  });

  // Получаем реальный user.id админа и готовим профиль Antigravity ACP (.portal-ready + models-v1.json)
  const me = await (await api("/teleharness/api/auth/me")).json();
  adminId = me.user?.id ?? me.id;
  const prof = acpProfileDir(tmp.data, adminId, "antigravity");
  mkdirSync(prof, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(prof, ".portal-ready"), "1");
  writeFileSync(
    path.join(prof, "models-v1.json"),
    JSON.stringify({
      version: 1,
      discoveredAt: Date.now(),
      currentModelId: "gemini-4-neon-medium",
      promptCapabilities: { image: true },
      models: [{ id: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" }],
    }),
  );

  tenant = await (await api("/teleharness/api/admin/users", { method: "POST", body: { name: "t-acp295", engines: ["opencode", "claude"] } })).json();
  await up.waitForSubscription();
});

after(async () => {
  await srv?.stop?.();
  await up?.close?.();
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test("BUG-295: PUT /me/auto-relay принимает Gemini (acp-antigravity) у админа, но режет тенанта и несуществующую модель", async () => {
  const ok = await api("/teleharness/api/me/auto-relay", { method: "PUT", body: { on: true, order: [GEMINI] } });
  assert.equal(ok.status, 200, "админ должен мочь выбрать Gemini в auto-relay: " + (await ok.clone().text()));
  assert.deepEqual((await ok.json()).order, [GEMINI]);

  const badModel = await api("/teleharness/api/me/auto-relay", { method: "PUT", body: { on: true, order: [{ providerID: "acp-antigravity", modelID: "no-such" }] } });
  assert.equal(badModel.status, 403, "несуществующая модель ACP → 403");

  const tenantTry = await api("/teleharness/api/me/auto-relay", { method: "PUT", token: tenant.token, body: { on: true, order: [GEMINI] } });
  assert.equal(tenantTry.status, 403, "тенанту ACP запрещён → 403");
});

test("BUG-295: автопередача по лимиту opencode → Gemini и Gemini → Claude срабатывает автоматически", async () => {
  // 1) opencode → Gemini
  assert.equal((await api("/teleharness/api/me/auto-relay", { method: "PUT", body: { on: true, order: [GEMINI, HAIKU] } })).status, 200);
  up.emit({ type: "session.error", properties: { sessionID: "ses_ar_to_gem", error: { name: "APIError", data: { message: "429 Too Many Requests" } } } });
  await waitFor(
    async () => {
      const feed = await (await api(`/teleharness/api/session/ses_ar_to_gem/message${q()}`)).json();
      return feed.some((m) => m.info.role === "assistant" && m.info.providerID === "acp-antigravity" && m.parts.some((p) => /GEMINI_OK/.test(p.text ?? "")));
    },
    { label: "ответ Gemini после auto-relay из opencode", timeoutMs: 15_000 },
  );
  const sess1 = await (await api(`/teleharness/api/session${q()}`)).json();
  const s1 = sess1.find((s) => s.id === "ses_ar_to_gem");
  assert.equal(s1?.teleharness?.engine, "acp");
  assert.equal(s1?.teleharness?.relays?.at(-1)?.reason, RELAY_REASON_AUTO);

  // 2) Gemini → Claude (лимит на ACP-ходе)
  assert.equal((await api(`/teleharness/api/session/ses_ar_from_gem/binding${q()}`, { method: "PATCH", body: { relay: true, model: GEMINI } })).status, 200);
  assert.equal((await api("/teleharness/api/me/auto-relay", { method: "PUT", body: { on: true, order: [HAIKU] } })).status, 200);
  assert.ok((await api(`/teleharness/api/session/ses_ar_from_gem/prompt${q()}`, { method: "POST", body: { parts: [{ type: "text", text: "ACP_LIMIT" }] } })).status < 300);
  await waitFor(
    async () => {
      const feed = await (await api(`/teleharness/api/session/ses_ar_from_gem/message${q()}`)).json();
      return feed.some((m) => m.info.role === "assistant" && m.info.providerID === "anthropic");
    },
    { label: "ответ Claude после auto-relay из Gemini", timeoutMs: 15_000 },
  );
  const sess2 = await (await api(`/teleharness/api/session${q()}`)).json();
  const s2 = sess2.find((s) => s.id === "ses_ar_from_gem");
  assert.equal(s2?.teleharness?.engine, "claude");
  assert.equal(s2?.teleharness?.relays?.at(-1)?.reason, RELAY_REASON_AUTO);
});

test("BUG-296: Relay Gemini → Claude вкладывает пропущенные ходы Gemini в запрос Claude (withRelayCatchUp)", async () => {
  // Сначала ход в Gemini
  assert.equal((await api(`/teleharness/api/session/ses_catchup_gem/binding${q()}`, { method: "PATCH", body: { relay: true, model: GEMINI } })).status, 200);
  assert.ok((await api(`/teleharness/api/session/ses_catchup_gem/prompt${q()}`, { method: "POST", body: { parts: [{ type: "text", text: "SECRET_GEMINI_FACT" }] } })).status < 300);
  await waitFor(
    async () => {
      const feed = await (await api(`/teleharness/api/session/ses_catchup_gem/message${q()}`)).json();
      return feed.some((m) => m.info.role === "assistant" && m.parts.some((p) => /ЗАПОМНИЛ_СЕКРЕТ_7731/.test(p.text ?? "")));
    },
    { label: "ответ Gemini с секретом", timeoutMs: 15_000 },
  );

  // Передаём на Claude и шлём ECHO (claude-fake вернёт полученный prompt в JSON)
  assert.equal((await api(`/teleharness/api/session/ses_catchup_gem/binding${q()}`, { method: "PATCH", body: { relay: true, model: HAIKU } })).status, 200);
  assert.ok((await api(`/teleharness/api/session/ses_catchup_gem/prompt${q()}`, { method: "POST", body: { parts: [{ type: "text", text: "ECHO проверка_catchup" }] } })).status < 300);
  const claudeMsg = await waitFor(
    async () => {
      const feed = await (await api(`/teleharness/api/session/ses_catchup_gem/message${q()}`)).json();
      return feed.find((m) => m.info.role === "assistant" && m.info.providerID === "anthropic" && m.parts.some((p) => p.text?.includes("проверка_catchup")));
    },
    { label: "ECHO-ответ Claude после передачи из Gemini", timeoutMs: 15_000 },
  );
  const echoed = JSON.parse(claudeMsg.parts.find((p) => p.text?.includes('"prompt"')).text.replace(/\(resumed\)/g, "").trim()).prompt;
  assert.match(echoed, /ЗАПОМНИЛ_СЕКРЕТ_7731/, "Claude должен получить ответ Gemini в скрытой вставке передачи");
});

test("BUG-297: «Сначала план» включается для ACP (200), блокирует правку и создаёт карточку плана", async () => {
  assert.equal((await api(`/teleharness/api/session/ses_plan_gem/binding${q()}`, { method: "PATCH", body: { relay: true, model: GEMINI } })).status, 200);
  const pf = await api(`/teleharness/api/session/ses_plan_gem/binding${q()}`, { method: "PATCH", body: { planFirst: true } });
  assert.equal(pf.status, 200, "planFirst на ACP у админа должен включаться без 409: " + (await pf.clone().text()));
  assert.equal((await pf.json()).teleharness.planFirst, true);

  assert.ok((await api(`/teleharness/api/session/ses_plan_gem/prompt${q()}`, { method: "POST", body: { parts: [{ type: "text", text: "ACP_PLAN_CHECK" }] } })).status < 300);
  await waitFor(
    async () => {
      const feed = await (await api(`/teleharness/api/session/ses_plan_gem/message${q()}`)).json();
      return feed.some((m) => m.info.role === "assistant" && m.parts.some((p) => /ПЛАН_ACP:/.test(p.text ?? "")));
    },
    { label: "ответ план-хода ACP", timeoutMs: 15_000 },
  );
  const feed = await (await api(`/teleharness/api/session/ses_plan_gem/message${q()}`)).json();
  const planAns = feed.find((m) => m.info.role === "assistant" && m.parts.some((p) => /ПЛАН_ACP:/.test(p.text ?? "")));
  const txt = planAns.parts.map((p) => p.text ?? "").join("");
  assert.match(txt, /planRule=true/, "ACP план-ход должен получать инструкцию режима «Сначала план»");
  assert.match(txt, /editDenied=true/, "в план-ходе ACP onPermission должен отклонять edit");

  const rev = await waitFor(
    async () => {
      const r = await (await api("/teleharness/api/review/chat/ses_plan_gem")).json();
      return (r?.plans?.length ?? 0) > 0 ? r : null;
    },
    { label: "карточка плана для ACP-хода", timeoutMs: 10_000 },
  );
  assert.match(rev.plans[0].text, /ПЛАН_ACP:/);
});
