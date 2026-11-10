// FEAT-04.11: tenant kit of Claude chats — jail hook decisions, jail name parity
// with the opencode plugin, chat folder → tenant jail, skills plugin copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decide, jailLine } from "../lib/claude-jail-hook.mjs";
import { jailName, tenantJailFor, syncTenantPlugin, tenantKitArgs, withJailHook } from "../lib/claude-tenant.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const opts = { name: "zai-t-alice", home: "C:/Users/USER/.zai-tenants/alice", jail: "D:/j/zai-jail.exe", py: "D:/py", exists: () => true, real: (p) => p.replace(/\\/g, "/") };

// zai-jail is a Windows AppContainer: the rewrite itself exists only on Windows.
const WIN_ONLY = { skip: process.platform !== "win32" && "Windows-only" };

test("jail hook: Bash is rewritten into the launcher; the command rides base64 in cmd /c", WIN_ONLY, () => {
  const cmd = 'python -c "print(1)" & echo "x|y"';
  const out = decide({ tool_name: "Bash", tool_input: { command: cmd, description: "d" }, cwd: "C:\\Users\\USER\\.zai-tenants\\alice\\sub" }, opts);
  const h = out.hookSpecificOutput;
  assert.equal(h.permissionDecision, "allow");
  assert.equal(h.updatedInput.description, "d");
  const argv = h.updatedInput.command.split(" ");
  assert.equal(argv[0], "D:/j/zai-jail.exe");
  assert.equal(argv[argv.indexOf("--name") + 1], "zai-t-alice");
  assert.equal(argv[argv.indexOf("--cwd") + 1], "C:/Users/USER/.zai-tenants/alice/sub");
  assert.match(h.updatedInput.command, /^[A-Za-z0-9_\-.\/: ]+$/, "only shell-neutral characters on the host line");
  assert.equal(Buffer.from(argv[argv.indexOf("--b64") + 1], "base64url").toString("utf8"), `cmd.exe /d /s /c "${cmd}"`);
});

test("jail hook: fail-closed — cwd outside the home, missing launcher/python, bad name, other tools", () => {
  const no = (ev, o = opts) => assert.equal(decide(ev, o).hookSpecificOutput.permissionDecision, "deny", JSON.stringify(ev));
  no({ tool_name: "Bash", tool_input: { command: "echo" }, cwd: "C:/Users/USER/.zai-tenants/bob" });
  no({ tool_name: "Bash", tool_input: { command: "echo" }, cwd: "C:/Users/USER/.zai-tenants/alice/../bob" });
  no({ tool_name: "Bash", tool_input: { command: "echo" }, cwd: "D:/Portal/zai" });
  no({ tool_name: "Bash", tool_input: { command: "" } });
  no({ tool_name: "Bash", tool_input: { command: "echo" } }, { ...opts, exists: () => false });
  no({ tool_name: "Bash", tool_input: { command: "echo" } }, { ...opts, name: "evil; rm" });
  no({ tool_name: "Bash", tool_input: { command: "echo" } }, { ...opts, home: "C:/Users/USER/My Tenants/alice" });
  no({ tool_name: "PowerShell", tool_input: { command: "echo" } });
  assert.equal(jailLine("a\0b", opts).error, "недопустимый символ в команде");
});

test("jail hook process: stdin event → JSON decision; a garbled event or a missing launcher is denied", () => {
  const hook = path.join(HERE, "..", "lib", "claude-jail-hook.mjs");
  const run = (input) => JSON.parse(spawnSync(process.execPath, [hook, "--name", "zai-t-alice", "--home", "C:/Users/USER/.zai-tenants/alice", "--jail", "D:/nope/zai-jail.exe"], { input, encoding: "utf8" }).stdout);
  assert.equal(run("{not json").hookSpecificOutput.permissionDecision, "deny");
  const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hi" }, cwd: "C:/Users/USER/.zai-tenants/alice" }));
  assert.equal(r.hookSpecificOutput.permissionDecision, "deny");
});

test("jail name = the opencode plugin's (one AppContainer per tenant); chat folder → tenant", () => {
  assert.equal(jailName("Carol"), "zai-t-Carol");
  assert.match(jailName("Мария"), /^zai-t-h[0-9a-f]{16}$/);
  const src = readFileSync(path.join(HERE, "..", "ops", "opencode", "vault-cache.ts"), "utf8");
  assert.ok(src.includes('`zai-t-${JAIL_ID.test(tenant) ? tenant : "h" + createHash("sha1").update(tenant, "utf8").digest("hex").slice(0, 16)}`'), "same formula as the plugin");
  const home = path.resolve("C:/Users/USER/.zai-tenants");
  assert.deepEqual(tenantJailFor(path.join(home, "alice", "proj"), home), { name: "zai-t-alice", home: path.join(home, "alice") });
  assert.equal(tenantJailFor(home, home), null);
  assert.equal(tenantJailFor("D:/Portal/zai", home), null);
  assert.equal(tenantJailFor(path.join(home, "..", "x"), home), null);
});

test("kit args and hook merge keep the undo hook", () => {
  const kit = { pluginDir: "P", mcpConfig: "M", promptFile: null, jailExe: "D:/j.exe", sandboxPy: "D:/py", nodePath: "D:/n/node.exe" };
  const a = tenantKitArgs(kit);
  assert.ok(a.includes("--plugin-dir") && a.includes("--mcp-config") && !a.includes("--append-system-prompt-file"));
  assert.deepEqual(tenantKitArgs(null), []);
  const undo = { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "undo" }] }] };
  const merged = withJailHook(undo, kit, { name: "zai-t-a", home: "C:/h/a" });
  assert.equal(merged.PreToolUse.length, 2);
  assert.equal(merged.PreToolUse[0].hooks[0].command, "undo");
  assert.equal(withJailHook(undo, kit, null), undo);
});

test("skills plugin: zai-* copied with a manifest; nothing to copy → null", () => {
  const T = mkdtempSync(path.join(tmpdir(), "zai-kit-"));
  try {
    mkdirSync(path.join(T, "src", "zai-xlsx"), { recursive: true });
    writeFileSync(path.join(T, "src", "zai-xlsx", "SKILL.md"), "---\nname: zai-xlsx\n---\n");
    mkdirSync(path.join(T, "src", "dogfood"), { recursive: true });
    writeFileSync(path.join(T, "src", "dogfood", "SKILL.md"), "x");
    const out = syncTenantPlugin(path.join(T, "src"), path.join(T, "out"));
    assert.equal(JSON.parse(readFileSync(path.join(out, ".claude-plugin", "plugin.json"), "utf8")).name, "zai");
    assert.ok(existsSync(path.join(out, "skills", "zai-xlsx", "SKILL.md")));
    assert.equal(existsSync(path.join(out, "skills", "dogfood")), false, "only zai-* skills reach tenants");
    assert.equal(syncTenantPlugin(path.join(T, "none"), path.join(T, "out2")), null);
  } finally {
    rmSync(T, { recursive: true, force: true });
  }
});

// FEAT-04.12: more rights for tenants — `cd /d <own folder> &&` no longer dies
// with «Access is denied», WebFetch only to public addresses, subagents (Task).
test("FEAT-04.12: `cd /d <своя подпапка> && …` → cwd подпапки, в песочницу уходит остаток команды", WIN_ONLY, () => {
  const out = decide({ tool_name: "Bash", tool_input: { command: String.raw`cd /d "C:\Users\USER\.zai-tenants\alice\deck" && python build.py` }, cwd: "C:/Users/USER/.zai-tenants/alice" }, opts);
  const h = out.hookSpecificOutput;
  assert.equal(h.permissionDecision, "allow");
  const argv = h.updatedInput.command.split(" ");
  assert.equal(argv[argv.indexOf("--cwd") + 1], "C:/Users/USER/.zai-tenants/alice/deck");
  assert.equal(Buffer.from(argv[argv.indexOf("--b64") + 1], "base64url").toString("utf8"), 'cmd.exe /d /s /c "python build.py"');
  const rel = decide({ tool_name: "Bash", tool_input: { command: "cd deck && dir" }, cwd: "C:/Users/USER/.zai-tenants/alice" }, opts).hookSpecificOutput;
  assert.equal(rel.updatedInput.command.split(" ")[rel.updatedInput.command.split(" ").indexOf("--cwd") + 1], "C:/Users/USER/.zai-tenants/alice/deck");
  const own = decide({ tool_name: "Bash", tool_input: { command: String.raw`cd /d C:\Users\USER\.zai-tenants\alice && python -I a.py` }, cwd: "C:/Users/USER/.zai-tenants/alice" }, opts).hookSpecificOutput;
  assert.equal(Buffer.from(own.updatedInput.command.split(" ").pop(), "base64url").toString("utf8"), 'cmd.exe /d /s /c "python -I a.py"');
  // чужая папка через cd — отказ, как и раньше
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: String.raw`cd /d D:\Portal\zai && type server.js` }, cwd: "C:/Users/USER/.zai-tenants/alice" }, opts).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "cd .. && type x" }, cwd: "C:/Users/USER/.zai-tenants/alice" }, opts).hookSpecificOutput.permissionDecision, "deny");
});

test("FEAT-04.12: WebFetch — только публичные адреса http(s); локальные, LAN и не-http — отказ", async () => {
  const { decideWebFetch } = await import("../lib/claude-jail-hook.mjs");
  const dns = { "example.com": ["93.184.215.14"], "evil.local": ["127.0.0.1"], "lan.test": ["192.168.0.10"], "mixed.test": ["8.8.8.8", "10.0.0.5"], "v6.test": ["::1"] };
  const lookup = async (h) => (dns[h] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  const d = async (url) => (await decideWebFetch({ tool_name: "WebFetch", tool_input: { url, prompt: "p" } }, { lookup })).hookSpecificOutput.permissionDecision;
  assert.equal(await d("https://example.com/page"), "allow");
  for (const u of ["http://127.0.0.1:4096/session", "http://localhost:4170/", "https://evil.local/", "http://lan.test/", "http://mixed.test/", "http://v6.test/", "http://[::1]/", "http://192.168.1.1/", "http://10.1.2.3/", "http://169.254.169.254/", "http://0.0.0.0/", "file:///C:/Windows/win.ini", "ftp://example.com/", "not a url", "http://nohost.test/"])
    assert.equal(await d(u), "deny", u);
});

test("FEAT-04.12: набор тенанта — WebFetch и Task; WebFetch одобряет только хук (не в allowedTools)", async () => {
  const { TENANT_TOOLS, TENANT_ALLOWED } = await import("../lib/claude-tenant.js");
  assert.ok(TENANT_TOOLS.includes("WebFetch") && TENANT_TOOLS.includes("Task"));
  assert.ok(!TENANT_ALLOWED.includes("WebFetch") && !TENANT_ALLOWED.includes("Bash"));
  const kit = { pluginDir: null, mcpConfig: null, promptFile: null, jailExe: "D:/j.exe", sandboxPy: "D:/py", nodePath: "D:/n/node.exe" };
  const merged = withJailHook({}, kit, { name: "zai-t-a", home: "C:/h/a" });
  assert.equal(merged.PreToolUse[0].matcher, "Bash|WebFetch");
});

test("FEAT-04.12: `zai-render <файл>` уходит в рендерер на хосте (не в песочницу), аргументы — base64", WIN_ONLY, () => {
  const ropts = { ...opts, render: "D:/Portal/zai/ops/render/zai_render.py" };
  const h = decide({ tool_name: "Bash", tool_input: { command: 'zai-render "Новый дизайн.pptx" --pages 1-3' }, cwd: "C:/Users/USER/.zai-tenants/alice/deck" }, ropts).hookSpecificOutput;
  assert.equal(h.permissionDecision, "allow");
  const argv = h.updatedInput.command.split(" ");
  assert.equal(argv[0], "D:/py/Scripts/python.exe");
  assert.deepEqual(argv.slice(1, 3), ["-I", "D:/Portal/zai/ops/render/zai_render.py"]);
  assert.equal(argv[argv.indexOf("--root") + 1], "C:/Users/USER/.zai-tenants/alice");
  assert.equal(argv[argv.indexOf("--cwd") + 1], "C:/Users/USER/.zai-tenants/alice/deck");
  assert.equal(Buffer.from(argv[argv.indexOf("--b64") + 1], "base64url").toString("utf8"), '"Новый дизайн.pptx" --pages 1-3');
  assert.match(h.updatedInput.command, /^[A-Za-z0-9_\-.\/: ]+$/);
  // в составе цепочки — это обычная команда песочницы (там zai-render только подсказка)
  const chain = decide({ tool_name: "Bash", tool_input: { command: "zai-render a.pptx && del a.pptx" }, cwd: "C:/Users/USER/.zai-tenants/alice" }, ropts).hookSpecificOutput;
  assert.ok(chain.updatedInput.command.startsWith("D:/j/zai-jail.exe"));
  // рабочая папка вне корня — отказ
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "zai-render x.pptx" }, cwd: "D:/Portal/zai" }, ropts).hookSpecificOutput.permissionDecision, "deny");
});

test("macOS / Linux: no sandbox — every tenant command (and zai-render) is denied with a reason (fail-closed)", async () => {
  const { NO_SANDBOX } = await import("../lib/claude-jail-hook.mjs");
  const posix = { ...opts, platform: "linux" };
  for (const command of ["echo hi", "zai-render a.pptx", "cd deck && ls"]) {
    const h = decide({ tool_name: "Bash", tool_input: { command }, cwd: opts.home }, posix).hookSpecificOutput;
    assert.equal(h.permissionDecision, "deny", command);
    assert.equal(h.updatedInput, undefined, "nothing is rewritten");
    assert.ok(h.permissionDecisionReason.includes(NO_SANDBOX), h.permissionDecisionReason);
  }
});
