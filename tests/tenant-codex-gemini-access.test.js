// FEAT-20.35: доступ тенантов к Codex и Gemini (ACP) + границы изоляции тенанта.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ENGINES, TENANT_ENGINES, engineAllowed, enginesOf } from "../lib/auth.js";
import { tenantAcpToolAllowed } from "../lib/acp-chat.js";
import { acpProviderCatalog, agentEntry } from "../lib/acp-registry.js";
import { catalogRoutes } from "../routes/catalog.js";
import { providerForUser } from "../lib/policy.js";
import { ClaudeRunner } from "../lib/claude.js";

test("FEAT-20.35: ENGINES и TENANT_ENGINES включают codex и acp; без включения тенант их не получает", () => {
  assert.ok(ENGINES.includes("codex") && ENGINES.includes("acp"));
  assert.ok(TENANT_ENGINES.includes("codex") && TENANT_ENGINES.includes("acp"));
  const plain = { role: "user", engines: ["opencode"] };
  assert.equal(engineAllowed(plain, "codex"), false);
  assert.equal(engineAllowed(plain, "acp"), false);
  assert.deepEqual(enginesOf({ role: "admin" }), ENGINES);

  const granted = { role: "user", engines: ["opencode", "codex", "acp"] };
  assert.equal(engineAllowed(granted, "codex"), true);
  assert.equal(engineAllowed(granted, "acp"), true);

  const prev = process.env.TELEHARNESS_ACP;
  process.env.TELEHARNESS_ACP = "off";
  try {
    assert.equal(engineAllowed(granted, "acp"), false);
    assert.equal(engineAllowed({ role: "admin" }, "acp"), false);
  } finally {
    if (prev === undefined) delete process.env.TELEHARNESS_ACP;
    else process.env.TELEHARNESS_ACP = prev;
  }
});

test("FEAT-20.35: tenantAcpToolAllowed блокирует shell и выход за пределы cwd, разрешает файлы внутри cwd", () => {
  const cwd = path.resolve("/tmp/tenant-home/alice/chat1");
  assert.equal(tenantAcpToolAllowed({ kind: "execute", rawInput: { command: "ls" } }, cwd), false);
  assert.equal(tenantAcpToolAllowed({ kind: "bash", rawInput: {} }, cwd), false);
  assert.equal(tenantAcpToolAllowed({ kind: "shell", rawInput: {} }, cwd), false);
  assert.equal(tenantAcpToolAllowed({ kind: "tool", rawInput: { CommandLine: "id" } }, cwd), false);

  assert.equal(tenantAcpToolAllowed({ kind: "read", rawInput: { path: "../other/secret.txt" } }, cwd), false);
  assert.equal(tenantAcpToolAllowed({ kind: "edit", rawInput: { AbsolutePath: "/etc/passwd" } }, cwd), false);
  assert.equal(tenantAcpToolAllowed({ kind: "write", rawInput: { files: [{ path: "/tmp/tenant-home/bob/a.txt" }] } }, cwd), false);

  assert.equal(tenantAcpToolAllowed({ kind: "read", rawInput: { path: "notes/plan.md" } }, cwd), true);
  assert.equal(tenantAcpToolAllowed({ kind: "edit", rawInput: { AbsolutePath: path.join(cwd, "src/app.js") } }, cwd), true);
  assert.equal(tenantAcpToolAllowed({ kind: "search", rawInput: { DirectoryPath: "." } }, cwd), true);
});

test("FEAT-20.35: /teleharness/api/provider отдаёт ACP-провайдеров тенанту только при включённом движке acp", async () => {
  const baseCatalog = {
    all: [{ id: "zai-coding-plan", name: "z.ai", models: { "glm-5": { id: "glm-5", name: "GLM-5" } } }],
    default: { "zai-coding-plan": "glm-5" },
    connected: ["zai-coding-plan"],
  };
  const routes = catalogRoutes({
    sendJson: (res, status, data) => { res.status = status; res.data = data; },
    errLog: () => {},
    claude: {
      handleProvider: (_req, shim) => {
        shim.writeHead(200, { "content-type": "application/json" });
        shim.end(JSON.stringify(baseCatalog));
      },
    },
    upstream: "http://127.0.0.1:1",
    captureResponse: async (fn) => {
      let status = 200, body = "";
      await fn({ writeHead: (s) => { status = s; }, end: (b) => { body = String(b ?? ""); } });
      return { status, body };
    },
    providerForUser,
    acpReady: (u) => (engineAllowed(u, "acp") ? ["antigravity"] : []),
    acpProviderCatalog,
    discoverModels: async () => ({ availableModels: [{ modelId: "gemini-3-pro", name: "Gemini 3 Pro" }], currentModelId: "gemini-3-pro", promptCapabilities: { image: true } }),
    engineAllowed,
  });
  const provRoute = routes.find((r) => r.path === "/teleharness/api/provider");
  assert.ok(provRoute);

  const res1 = {};
  await provRoute.handler({ req: {}, res: res1, user: { id: "u1", role: "user", engines: ["opencode"] }, admin: false });
  assert.equal(res1.status, 200);
  assert.equal(res1.data.connected.includes("acp-antigravity"), false);

  const res2 = {};
  await provRoute.handler({ req: {}, res: res2, user: { id: "u1", role: "user", engines: ["opencode", "acp"] }, admin: false });
  assert.equal(res2.status, 200);
  assert.equal(res2.data.connected.includes("acp-antigravity"), true);
  assert.ok(res2.data.all.find((p) => p.id === "acp-antigravity")?.models?.["gemini-3-pro"]);
});

test("FEAT-20.35: ClaudeRunner.dispatch разрешает ACP-ход тенанту с acpOwner и отклоняет 403 без acpOwner", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-tenant-run-"));
  let runner;
  try {
    const dst = agentEntry(dir, "gemini");
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(path.resolve("tests/fixtures/acp-chat-agent.mjs"), dst);
    runner = new ClaudeRunner({
      hub: { emit: () => {}, markManaged: () => {} },
      storePath: path.join(dir, "store.json"),
      runsPath: path.join(dir, "runs.json"),
      catalogPath: path.join(dir, "cat.json"),
      binPath: process.execPath,
    });
    const fakeRes = () => {
      let done;
      const p = new Promise((r) => { done = r; });
      return { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = String(b ?? ""); done(); }, done: p };
    };
    const body = JSON.stringify({ model: { providerID: "acp-gemini", modelID: "acp-gemini" }, parts: [{ type: "text", text: "привет" }] });

    const r403 = fakeRes();
    await runner.dispatch({ res: r403, sid: "s-deny", dir, body, access: "tenant", acpOwner: null });
    assert.equal(r403.status, 403);

    const rOk = fakeRes();
    await runner.dispatch({ res: rOk, sid: "s-ok", dir, body, access: "tenant", acpOwner: "admin-owner" });
    assert.equal(rOk.status, 204);
    for (let i = 0; i < 60 && runner.busySnapshot()["s-ok"]; i++) await new Promise((r) => setTimeout(r, 100));
    const msgs = runner.messages("s-ok");
    const ans = msgs.find((m) => m.info.role === "assistant");
    assert.ok(ans, "ответ от ACP-фикстуры получен для тенанта");
    assert.equal(ans.info.providerID, "acp-gemini");
  } finally {
    runner?.shutdown?.();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
