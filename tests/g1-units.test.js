// @suite: server — spawnSync server.js ×3 (BUG-222/QA-05: server-набор, а не параллельная unit-фаза)
// Г1 unit + startup tests (2026-11-02): config validation (TASK-12.19), path
// policy (BUG-12.11), tenant policy (BUG-12.5, BUG-12.10, FEAT-12.16), file
// realpath + CSP (BUG-12.7), GC dry-run (TASK-12.22), fail-fast on a corrupt
// users.json (BUG-12.13) and on a bad env value.
// Run: node --test tests/g1-units.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeConfig, loadConfig } from "../lib/config.js";
import * as paths from "../lib/paths.js";
import { isUnderAny } from "../lib/paths.js";
// The Windows path policy, checked on every OS (POSIX: tests/paths.test.js).
const isAbsoluteDir = (d) => paths.isAbsoluteDir(d, "win32");
const dirProblem = (d, o = {}) => paths.dirProblem(d, { platform: "win32", portalRoot: "D:\\Portal", ...o });
import { agentCan, agentHasShell, agentIsSandboxed, defaultTenantAgent, providerForUser, publicAgent, redactMessages, tenantAgents } from "../lib/policy.js";
import { realInside, serveWorkspaceFile } from "../lib/file.js";
import { planGc } from "../lib/gc.js";
import { isolatedServerEnv, makeTmpRoot } from "./helpers/env.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(path.join(tmpdir(), "zai-g1-units-"));
// Isolated env for the spawned server.js (TASK-14.4): no ZAI_* from the shell.
const ISO = makeTmpRoot("zai-g1-iso-");
after(() => {
  rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  ISO.cleanup();
});

// ---- TASK-12.19 -----------------------------------------------------------------

test("config: defaults, valid overrides, readable errors, masked secrets", () => {
  const d = loadConfig({});
  assert.equal(d.errors.length, 0);
  assert.equal(d.config.ZAI_STALL_ABORT_MS, 900_000);
  assert.equal(d.config.PORT, 4170);
  assert.equal(d.config.ZAI_CHAT_DIR, d.config.ZAI_HOME, "derived default");

  const ok = loadConfig({ ZAI_STALL_ABORT_MS: "0", ZAI_MOCK: "1", ZAI_UPSTREAM: "http://127.0.0.1:9/", ZAI_FILE_ROOTS: "D:\\A; D:\\B" });
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.config.ZAI_STALL_ABORT_MS, 0);
  assert.equal(ok.config.ZAI_MOCK, true);
  assert.equal(ok.config.ZAI_UPSTREAM, "http://127.0.0.1:9");
  assert.deepEqual(ok.config.ZAI_FILE_ROOTS, ["D:\\A", "D:\\B"]);

  const bad = loadConfig({ ZAI_STALL_ABORT_MS: "9oo000", ZAI_MOCK: "yes", ZAI_UPSTREAM: "nope", ZAI_HOME: "relative\\x", PORT: "70000" });
  assert.equal(bad.errors.length, 5);
  assert.ok(bad.errors.some((e) => e.startsWith("ZAI_STALL_ABORT_MS:") && e.includes("9oo000")));

  const line = describeConfig(loadConfig({ ZAI_ADMIN_TOKEN: "supersecret" }).config, loadConfig({ ZAI_ADMIN_TOKEN: "supersecret" }).sources);
  assert.ok(!line.includes("supersecret"), "secrets are masked");
  assert.ok(line.includes('"***"'));
});

test("config: server.js refuses to start on a bad env value", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "server.js")], {
    env: isolatedServerEnv({ tmp: ISO, mock: true, extra: { ZAI_DATA_DIR: path.join(TMP, "cfgdata"), ZAI_STALL_ABORT_MS: "9oo000" } }),
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ZAI_STALL_ABORT_MS: ожидалось целое/);
});

test("config: integration defaults (FEAT-07.15, BUG-07.7, BUG-07.10, ZAI_ENV enum)", () => {
  const d = loadConfig({});
  assert.equal(d.config.ZAI_DIALOG_TIMEOUT_MS, 0, "dialogs wait for the human by default");
  assert.equal(d.config.ZAI_LOOP_ABORT_COUNT, 8);
  assert.equal(d.config.ZAI_PROMPT_UNSTICK_MS, 120_000);
  assert.equal(d.config.ZAI_ENV, "prod");
  assert.equal(loadConfig({ ZAI_ENV: "stand" }).config.ZAI_ENV, "stand");
  const bad = loadConfig({ ZAI_ENV: "staging" });
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /^ZAI_ENV: ожидалось одно из prod \| stand \| test/);
});

// The guard fires at module load, before the hub dials anything (no-prod
// contract: nothing ever connects to this address).
const PROD_LIKE_UPSTREAM = `http://127.0.0.1:${4000 + 96}`;
test("ZAI_ENV guard: a stand refuses the prod upstream :4096 (ADR-003 п.2)", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "server.js")], {
    // The spawned server exits before listening/dialing; :4096 is never contacted.
    env: { ...isolatedServerEnv({ tmp: ISO, mock: true }), ZAI_MOCK: "0", ZAI_ENV: "stand", ZAI_UPSTREAM: PROD_LIKE_UPSTREAM },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ZAI_ENV=stand .*:4096/);
});

// ---- BUG-12.13 --------------------------------------------------------------------

test("corrupt users.json: server exits 1, file untouched, a .corrupt copy is kept", () => {
  const data = path.join(TMP, "corrupt-data");
  mkdirSync(data, { recursive: true });
  const broken = '{"users": [ {"id": "admin", oops';
  writeFileSync(path.join(data, "users.json"), broken);
  const r = spawnSync(process.execPath, [path.join(ROOT, "server.js")], {
    env: isolatedServerEnv({ tmp: ISO, mock: true, extra: { ZAI_DATA_DIR: data, ZAI_ADMIN_TOKEN: "x".repeat(40) } }),
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /users\.json повреждён/);
  assert.equal(readFileSync(path.join(data, "users.json"), "utf8"), broken, "the store is never overwritten");
  assert.ok(readdirSync(data).some((f) => f.startsWith("users.json.corrupt-")), "a copy is kept aside");
});

// ---- BUG-12.11 / BUG-02.5 -----------------------------------------------------------

test("path policy: one rule set for every route", () => {
  assert.equal(isAbsoluteDir("C:\\x"), true);
  for (const [dir, code] of [
    ["relative\\x", "not-absolute"],
    ["C:\\a\\..\\Windows", "not-absolute"],
    ["\\\\?\\C:\\Windows", "device-namespace"],
    ["\\\\.\\PhysicalDrive0", "device-namespace"],
    ["\\\\server\\share\\x", "unc"],
    ["C:\\", "drive-root"],
    ["D:", "not-absolute"],
    ["C:\\Windows\\System32", "system"],
    ["c:/program files/x", "system"],
    ["C:\\x\\file.txt::$DATA", "alias"],
    ["C:\\PROGRA~1\\x", "alias"],
  ]) {
    assert.equal(dirProblem(dir), code, dir);
  }
  // G7 finding 3: the system tree is refused on ANY drive.
  for (const dir of ["D:\\Windows", "d:\\windows\\system32", "E:\\Program Files\\x", "X:\\$Recycle.Bin", "F:\\System Volume Information"]) {
    assert.equal(dirProblem(dir), "system", dir);
  }
  assert.equal(dirProblem("D:\\Windowsy"), null, "a segment boundary is required");
  // BUG-01.28: temp-tree membership for the session-list filter.
  const roots = ["C:\\Users\\USER\\AppData\\Local\\Temp"];
  assert.equal(isUnderAny("c:/users/user/appdata/local/temp/zai-claude-smoke", roots), true);
  assert.equal(isUnderAny("C:\\Users\\USER\\AppData\\Local\\Temp", roots), true);
  assert.equal(isUnderAny("C:\\Users\\USER\\AppData\\Local\\Temporary", roots), false);
  assert.equal(isUnderAny("D:\\proj\\tmp", roots), false);
  assert.equal(isUnderAny(null, roots), false);
  assert.equal(dirProblem("D:\\Portal\\zai"), null, "admin may use the portal tree");
  const t = { tenant: true, dataDir: "D:\\Portal\\zai\\data", profileRoot: "C:\\Users\\USER" };
  assert.equal(dirProblem("D:\\Portal\\zai", t), "portal");
  assert.equal(dirProblem("C:\\Users\\USER", t), "profile-root");
  assert.equal(dirProblem("C:\\Users\\USER\\.zai-tenants\\alice", t), null);
  assert.equal(dirProblem("D:\\Obsidian\\tenants\\alice", t), null);
});

// ---- BUG-12.5 / BUG-12.10 / FEAT-12.16 ------------------------------------------------

test("policy: shell detection on the live agent catalog fixture", () => {
  const agents = JSON.parse(readFileSync(path.join(ROOT, "fixtures", "agents.json"), "utf8"));
  const sisyphus = agents.find((a) => a.name.startsWith("Sisyphus - "));
  const prometheus = agents.find((a) => a.name.startsWith("Prometheus"));
  assert.equal(agentHasShell(sisyphus), true, "bash:* allow → shell");
  assert.equal(agentHasShell(prometheus), false, "ends in bash:* deny → no shell");
  assert.equal(agentHasShell({ permission: [{ permission: "bash", pattern: "*", action: "deny" }, { permission: "bash", pattern: "git *", action: "allow" }] }), true, "a narrower allow re-opens the shell");
  assert.equal(agentHasShell({ permission: [{ permission: "bash", pattern: "*", action: "ask" }] }), true, "ask counts as shell");
  assert.equal(agentHasShell({}), true, "unknown shape → conservative");
  // 2026-11-04: Prometheus has no shell but delegates (task → Sisyphus-Junior with bash)
  // and reads outside its directory — not a tenant agent any more.
  assert.equal(agentCan(prometheus, "task"), true);
  assert.equal(agentIsSandboxed(prometheus), false);
  assert.equal(tenantAgents(agents).some((a) => a.name === prometheus.name), false);
  const sandbox = {
    name: "Sandbox",
    mode: "primary",
    permission: [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
    ],
  };
  assert.equal(agentIsSandboxed(sandbox), true, "deny-by-default agent with file tools only");
  const spool = { permission: "external_directory", pattern: "D:\\zai-stage\\opencode\\data\\opencode\\tool-output\\*", action: "allow" };
  assert.equal(agentIsSandboxed({ ...sandbox, permission: [...sandbox.permission, spool] }), true, "opencode's own tool-output spool is not a user folder");
  assert.equal(agentIsSandboxed({ ...sandbox, permission: [...sandbox.permission, { ...spool, pattern: "C:\\Users\\*" }] }), false, "any other external allow re-opens");
  assert.equal(agentIsSandboxed({ ...sandbox, permission: [...sandbox.permission, { permission: "task", pattern: "explore", action: "allow" }] }), false, "a narrower task allow re-opens delegation");
  assert.equal(agentIsSandboxed({ permission: { "*": "deny", read: "allow" } }), true, "object shape: wildcard deny");
  assert.equal(agentIsSandboxed({ permission: { bash: "deny" } }), false, "object shape: task not denied");
  // FEAT-04.9 (2026-11-04): a tenant shell runs only in its AppContainer (vault-cache → zai-jail),
  // so bash no longer disqualifies an agent; task and external_directory still must be denied.
  const jailed = { ...sandbox, permission: [...sandbox.permission, { permission: "bash", pattern: "*", action: "allow" }] };
  assert.equal(agentHasShell(jailed), true);
  assert.equal(agentIsSandboxed(jailed), true, "bash allow + task/external_directory deny → tenant agent");
  assert.equal(agentIsSandboxed({ permission: { "*": "deny", bash: "allow", read: "allow" } }), true, "object shape: bash allow, rest denied");
  assert.equal(agentIsSandboxed({ permission: { "*": "deny", bash: "allow", task: "allow" } }), false, "bash + task → delegation re-opens");
  assert.equal(agentIsSandboxed({ ...jailed, permission: [...jailed.permission, { permission: "external_directory", pattern: "D:\\Portal\\*", action: "ask" }] }), false, "bash + external_directory ask → not a tenant agent");
  assert.equal(agentIsSandboxed(sisyphus), false, "Sisyphus delegates and reaches outside files");
  assert.equal(tenantAgents([...agents, jailed]).some((a) => a.name === "Sandbox"), true);
  const withSandbox = [...agents, sandbox];
  const allowed = tenantAgents(withSandbox);
  assert.ok(allowed.length > 0 && allowed.every(agentIsSandboxed));
  assert.equal(defaultTenantAgent(withSandbox), "Sandbox");
  // 2026-11-05 (a tenant's chat on multimodal-looker without marketplace): OmO subagents
  // (look_at helper etc.) are not chat agents — a tenant picks only primary/all-mode agents.
  const looker = { ...sandbox, name: "multimodal-looker", mode: "subagent" };
  assert.equal(tenantAgents([...withSandbox, looker]).some((a) => a.name === "multimodal-looker"), false);
  assert.equal(tenantAgents([...withSandbox, looker]).some((a) => a.name === "Sandbox"), true);
  const pub = publicAgent(prometheus);
  assert.equal(pub.prompt, undefined);
  assert.equal(pub.permission, undefined);
});

test("policy: provider filtering and message redaction", () => {
  const cat = { connected: ["a", "anthropic"], all: [{ id: "a" }, { id: "anthropic" }, { id: "big" }], default: { a: "m", anthropic: "c", big: "x" } };
  const t = providerForUser(cat, { claudeAllowed: false });
  assert.deepEqual(t.connected, ["a"]);
  assert.deepEqual(t.all.map((p) => p.id), ["a"]);
  assert.deepEqual(t.default, { a: "m" });
  assert.deepEqual(providerForUser(cat, { claudeAllowed: true }).connected, ["a", "anthropic"]);

  const msgs = [
    {
      info: { id: "m1" },
      parts: [
        { type: "text", text: "готово" },
        { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: { command: "whoami" }, output: "desktop\\user", metadata: { exit: 0 }, title: "whoami", time: { start: 1 } } },
        { type: "tool", tool: "read", state: { status: "error", input: { filePath: "D:\\Portal\\zai\\data\\users.json" }, error: "ENOENT D:\\Portal" } },
        { type: "patch", files: ["D:\\Portal\\zai\\x.js"] },
      ],
    },
  ];
  const out = JSON.stringify(redactMessages(msgs));
  for (const leak of ["whoami", "desktop", "D:\\\\Portal", "exit"]) assert.ok(!out.includes(leak), `${leak} must not reach a tenant`);
  assert.ok(out.includes("Выполнена команда") && out.includes("готово"));
});

// ---- BUG-12.7 ------------------------------------------------------------------------

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(s, h) {
      this.status = s;
      Object.assign(this.headers, h);
    },
    end(b) {
      if (b) this.body += b;
    },
    destroy() {},
  };
}

test("file: a junction inside an allowed root cannot escape it", () => {
  const root = path.join(TMP, "root");
  const outside = path.join(TMP, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "secret.txt"), "SECRET");
  writeFileSync(path.join(root, "ok.txt"), "ok");
  symlinkSync(outside, path.join(root, "jx"), "junction");
  assert.equal(realInside(path.join(root, "jx", "secret.txt"), [root]), null, "junction escape is refused");
  assert.ok(realInside(path.join(root, "ok.txt"), [root]));
  assert.equal(realInside(path.join(root, "missing.txt"), [root]), undefined);

  const res = fakeRes();
  serveWorkspaceFile({ method: "GET" }, res, { directory: root, target: "jx/secret.txt", extraRoots: [] });
  assert.equal(res.status, 403);
});

test("file: html/svg carry a CSP sandbox; other types do not", () => {
  const root = path.join(TMP, "csp");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "x.html"), "<script>alert(1)</script>");
  writeFileSync(path.join(root, "x.svg"), "<svg onload='alert(1)'/>");
  writeFileSync(path.join(root, "x.png"), "png");
  const get = (name) => {
    const res = fakeRes();
    serveWorkspaceFile({ method: "HEAD" }, res, { directory: root, target: name, extraRoots: [] });
    return res;
  };
  assert.match(get("x.html").headers["content-security-policy"], /^sandbox allow-scripts/);
  assert.match(get("x.svg").headers["content-security-policy"], /^sandbox; default-src 'none'/);
  assert.equal(get("x.png").headers["content-security-policy"], undefined, "PDF/images keep working in the viewer");
});

// ---- TASK-12.22 ----------------------------------------------------------------------

test("gc: dry-run report lists orphans and stale uploads (empty chats: runEmptyChatGc dryRun)", () => {
  const dir = path.join(TMP, "gc-chat");
  mkdirSync(path.join(dir, ".zai-uploads"), { recursive: true });
  const old = path.join(dir, ".zai-uploads", "old.bin");
  writeFileSync(old, "12345");
  const past = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(old, past, past);
  writeFileSync(path.join(dir, ".zai-uploads", "new.bin"), "1");
  const bf = path.join(TMP, "b.json");
  writeFileSync(bf, JSON.stringify({ sessions: { live: {}, gone: {} } }));
  const now = Date.now();
  const rep = planGc({
    sessions: [
      { id: "live", directory: dir, time: { created: now - 3 * 86_400_000, updated: now - 3 * 86_400_000 } },
      { id: "busy", directory: dir, time: { created: now - 3 * 86_400_000, updated: now } },
    ],
    bindingsFile: bf,
    claudeFile: path.join(TMP, "none.json"),
    now,
  });
  assert.deepEqual(rep.orphanBindings, ["gone"]);
  assert.deepEqual(rep.staleUploads.map((f) => path.basename(f.path)), ["old.bin"]);
  assert.equal(rep.staleUploadBytes, 5);
  assert.equal(rep.emptyChats, undefined, "empty chats come from the sweep rule, not planGc");
  assert.ok(readdirSync(path.join(dir, ".zai-uploads")).includes("old.bin"), "dry-run deletes nothing");
});

// BUG-171 (BUG-12.24): Sandbox may reach the tenants' knowledge-base root (each tenant only its own
// zone — the vault-cache plugin guard); that allow must not make it «not sandboxed». Anything else
// outside — still disqualifies. Root configurable (ZAI_TENANT_VAULT); default = config default.
test("BUG-171: agentIsSandboxed tolerates external_directory allow under the tenant vault root only", async () => {
  const { agentIsSandboxed, setTenantVaultRoots, tenantVaultRoots } = await import("../lib/policy.js");
  const base = [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "D:\\zai\\opencode\\tool-output\\*", action: "allow" },
  ];
  const sb = (extra) => ({ name: "Sandbox", permission: [...base, ...extra] });
  const ext = (pattern, action = "allow") => ({ permission: "external_directory", pattern, action });
  const { config } = await import("../lib/config.js");
  assert.deepEqual(tenantVaultRoots(), [config.ZAI_TENANT_VAULT], "default root = config default");
  setTenantVaultRoots(["D:\\Obsidian\\tenants"]);
  assert.equal(agentIsSandboxed(sb([ext("D:\\Obsidian\\tenants\\*")])), true, "vault root allow keeps the agent sandboxed");
  assert.equal(agentIsSandboxed(sb([ext("d:/obsidian/tenants/*")])), true, "case and slash insensitive");
  for (const bad of ["D:\\Obsidian\\*", "D:\\Obsidian\\agents\\*", "D:\\Obsidian\\tenants-x\\*", "D:\\Obsidian\\tenants\\..\\agents\\*", "*", "D:\\*"])
    assert.equal(agentIsSandboxed(sb([ext(bad)])), false, `outside the vault root: ${bad}`);
  try {
    setTenantVaultRoots(["D:\\zai-stage\\tenants\\vault"]);
    assert.equal(agentIsSandboxed(sb([ext("D:\\zai-stage\\tenants\\vault\\*")])), true);
    assert.equal(agentIsSandboxed(sb([ext("D:\\Obsidian\\tenants\\*")])), false, "the configured root only");
    setTenantVaultRoots([]);
    assert.equal(agentIsSandboxed(sb([ext("D:\\zai-stage\\tenants\\vault\\*")])), false, "no root → strict as before");
  } finally {
    setTenantVaultRoots([config.ZAI_TENANT_VAULT]);
  }
});
