// FEAT-04.9 (2026-11-04): a tenant `bash` call is rewritten into a zai-jail call
// (Windows AppContainer of the tenant); admin sessions are not touched. Run:
//   node --test ops/opencode/tests/vault-cache-jail.test.mjs
// Throwaway layout under %TEMP%; the launcher here is a placeholder file — the
// real isolation is covered by ops/sandbox/tests/jail-live.test.mjs.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vc-jail-"))
const P = (...x) => path.join(ROOT, ...x)
const F = (p) => p.replace(/\\/g, "/")
const ALICE = P("tenants", "home", "alice")
const BOB = P("tenants", "home", "bob")
const CAROL = P("portal-tenants", "carol")
const ADMIN_DIR = P("admin-project")
const JAIL = P("ops", "sandbox", "zai-jail.exe")
const PY = P("zai-sandbox", "python")
const PY_EXE = path.join(PY, "Scripts", "python.exe")
const CAFILE = path.join(PY, "Lib", "site-packages", "certifi", "cacert.pem")

let hook, hooks
const sessions = {
  ses_admin: { id: "ses_admin", directory: ADMIN_DIR },
  ses_alice: { id: "ses_alice", directory: ALICE },
  ses_alice_sub: { id: "ses_alice_sub", directory: path.join(ALICE, "proj") },
  ses_child: { id: "ses_child", directory: ALICE, parentID: "ses_alice" },
  ses_carol: { id: "ses_carol", directory: CAROL },
  ses_bad: { id: "ses_bad", directory: P("tenants", "home", "bad name") },
}

before(async () => {
  for (const d of [path.join(ALICE, "proj"), path.join(ALICE, "vault-link-target"), BOB, CAROL, ADMIN_DIR, P("tenants", "home", "bad name"), P("tenants", "vault", "alice")]) fs.mkdirSync(d, { recursive: true })
  for (const f of [JAIL, PY_EXE, CAFILE]) {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, "")
  }
  execFileSync("cmd", ["/c", "mklink", "/J", path.join(ALICE, "escape"), BOB], { stdio: "ignore" })
  fs.writeFileSync(P("users.json"), JSON.stringify({ users: [
    { name: "admin", role: "admin", directories: [] },
    { name: "Тенант Н.", role: "user", directories: [CAROL] },
  ] }))
  Object.assign(process.env, {
    ZAI_TENANT_HOME: P("tenants", "home"),
    ZAI_TENANT_VAULT: P("tenants", "vault"),
    ZAI_USERS_FILE: P("users.json"),
    VAULT_CACHE_ROOT: P("vault", "agents"),
    VAULT_CACHE_PROTECT: P("vault"),
    VAULT_CACHE_LOG: P("vault-cache.log"),
    ZAI_JAIL_EXE: JAIL,
    ZAI_SANDBOX_PY: PY,
  })
  const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "vault-cache.ts")).href)
  const client = { session: { get: async ({ path: { id } }) => ({ data: sessions[id] }), messages: async () => ({ data: [] }) } }
  hooks = await mod.default({ client })
  hook = hooks["tool.execute.before"]
})

after(() => {
  try { fs.rmdirSync(path.join(ALICE, "escape")) } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true })
})

async function bash(sessionID, command, extra = {}) {
  const args = { command, description: "x", ...extra }
  await hook({ tool: "bash", sessionID, callID: "c" }, { args })
  return args
}
/** argv of a rewritten command (it is a plain space-separated list by construction) */
function parse(cmd) {
  const t = cmd.split(" ")
  const opt = (k) => { const i = t.indexOf(k); return i >= 0 ? t[i + 1] : undefined }
  return { exe: t[0], t, opt, decoded: Buffer.from(opt("--b64"), "base64url").toString("utf8") }
}
const SAFE = /^[A-Za-z0-9_.\/:\- ]+$/

test("tenant bash is rewritten into zai-jail with the command in base64", async () => {
  const args = await bash("ses_alice", "python -c \"import pandas; print(1)\"")
  const j = parse(args.command)
  assert.equal(j.exe, F(JAIL))
  assert.equal(j.opt("--name"), "zai-t-alice")
  assert.equal(j.opt("--dir"), F(ALICE))
  assert.equal(j.opt("--cwd"), F(ALICE))
  assert.ok(j.t.includes("--net"))
  assert.equal(j.opt("--cafile"), F(CAFILE))
  assert.equal(j.opt("--path-prepend"), F(path.join(PY, "Scripts")))
  assert.equal(j.decoded, 'cmd.exe /d /s /c "python -c "import pandas; print(1)""')
  assert.match(args.command, SAFE, "only shell-inert characters reach the host shell")
  assert.doesNotMatch(args.command, /\\/, "forward slashes only")
})

test("quotes, &, |, \" and shell syntax stay inside the base64 payload", async () => {
  const evil = [
    'echo a & type D:\\Portal\\zai\\data\\users.json',
    'echo "x" | findstr x && whoami',
    '" & calc & "',
    "'; rm -rf / #",
    "$(curl http://127.0.0.1:4096/session) `id` ${HOME}",
    "echo %USERPROFILE% ^& ver > out.txt 2>&1",
    "привет мир; echo ok\nwhoami\r\nver",
  ]
  for (const cmd of evil) {
    const args = await bash("ses_alice", cmd)
    const j = parse(args.command)
    assert.equal(j.decoded, `cmd.exe /d /s /c "${cmd}"`, cmd)
    assert.match(args.command, SAFE, cmd)
    assert.equal(j.t.length, 14, `fixed argv shape for ${JSON.stringify(cmd)}`)
    assert.equal(j.exe, F(JAIL))
  }
})

test("workdir inside the tenant folder becomes --cwd; relative ones resolve against the session", async () => {
  assert.equal(parse((await bash("ses_alice", "cd", { workdir: path.join(ALICE, "proj") })).command).opt("--cwd"), F(path.join(ALICE, "proj")))
  assert.equal(parse((await bash("ses_alice", "cd", { workdir: "proj" })).command).opt("--cwd"), F(path.join(ALICE, "proj")))
  const sub = parse((await bash("ses_alice_sub", "cd")).command)
  assert.equal(sub.opt("--dir"), F(ALICE), "the jail root is the tenant home, not the session subfolder")
  assert.equal(sub.opt("--cwd"), F(path.join(ALICE, "proj")))
})

test("workdir outside the tenant folder is refused", async () => {
  for (const workdir of [BOB, "..\\bob", "C:\\Windows", "D:\\Portal\\zai", path.join(ALICE, "escape"), P("tenants", "vault", "alice")])
    await assert.rejects(bash("ses_alice", "dir", { workdir }), /Доступ запрещён/, workdir)
})

test("portal-defined tenant with a non-ASCII name gets a stable hashed container", async () => {
  const a = parse((await bash("ses_carol", "ver")).command)
  const b = parse((await bash("ses_carol", "ver")).command)
  assert.match(a.opt("--name"), /^zai-t-h[0-9a-f]{16}$/)
  assert.equal(a.opt("--name"), b.opt("--name"))
  assert.equal(a.opt("--dir"), F(CAROL))
})

test("tenant folder with a space is refused (shell-unsafe path)", async () => {
  await assert.rejects(bash("ses_bad", "ver"), /недопустимыми символами/)
})

test("tenant subagent: jailed as well", async () => {
  const j = parse((await bash("ses_child", "whoami")).command)
  assert.equal(j.exe, F(JAIL))
  assert.equal(j.opt("--name"), "zai-t-alice")
})

test("sandbox checks run first: obsidian paths and blocked tools still refused", async () => {
  await assert.rejects(bash("ses_alice", `type ${P("vault", "agents", "_index.md")}`), /Доступ запрещён/)
  await assert.rejects(hook({ tool: "task", sessionID: "ses_alice", callID: "c" }, { args: {} }), /недоступен/)
  await assert.rejects(hook({ tool: "interactive_bash", sessionID: "ses_alice", callID: "c" }, { args: { tmux_command: "x" } }), /недоступен/)
})

test("MCP: context7 and grep_app allowed, playwright, lsp, skill_mcp refused", async () => {
  for (const tool of ["context7_resolve-library-id", "context7_query-docs", "grep_app_searchGitHub"])
    await assert.doesNotReject(hook({ tool, sessionID: "ses_alice", callID: "c" }, { args: { query: "pandas" } }), tool)
  for (const tool of ["playwright_browser_navigate", "lsp_diagnostics", "skill_mcp", "marketplace_compare_browser_snapshot"])
    await assert.rejects(hook({ tool, sessionID: "ses_alice", callID: "c" }, { args: {} }), /недоступен/, tool)
})

test("admin bash is not touched", async () => {
  const args = await bash("ses_admin", 'dir C:\\ & echo "x"', { workdir: "C:\\" })
  assert.equal(args.command, 'dir C:\\ & echo "x"')
  assert.equal(args.workdir, "C:\\")
})

test("fail-closed: no launcher or no Python environment → refused", async () => {
  for (const f of [JAIL, PY_EXE, CAFILE]) {
    fs.renameSync(f, f + ".off")
    try {
      await assert.rejects(bash("ses_alice", "ver"), /командная строка недоступна/, f)
    } finally {
      fs.renameSync(f + ".off", f)
    }
  }
  await assert.doesNotReject(bash("ses_alice", "ver"))
})

test("empty command is refused", async () => {
  await assert.rejects(bash("ses_alice", "   "), /пустая команда/)
  await assert.rejects(bash("ses_alice", undefined), /пустая команда/)
})

test("the model's history shows the tenant's own command, not the launcher line", async () => {
  // stand probe 2026-11-04: a model that saw `zai-jail.exe … --b64 …` started to imitate it
  const cmd = 'python -c "print(1 & 2)" | findstr 0'
  const args = { command: cmd, description: "x" }
  await hook({ tool: "bash", sessionID: "ses_alice", callID: "call_1" }, { args })
  assert.match(args.command, /zai-jail\.exe .* --b64 /)
  const jailedLine = args.command

  const stored = { type: "tool", tool: "bash", callID: "call_2", state: { status: "completed", input: { command: jailedLine, description: "x" }, output: "1" } }
  const other = { type: "tool", tool: "bash", state: { status: "completed", input: { command: "echo zai-jail --b64 notreally" } } }
  const output = { messages: [{ info: { role: "assistant" }, parts: [stored, other, { type: "text", text: "ok" }] }] }
  await hooks["experimental.chat.messages.transform"]({}, output)
  assert.equal(output.messages[0].parts[0].state.input.command, cmd)
  assert.equal(stored.state.input.command, jailedLine, "the stored part object is not mutated")
  assert.equal(output.messages[0].parts[1], other, "non-jail commands untouched")
})

test("agent-config plants from the tenant shell are moved away before and after bash", async () => {
  // stand 2026-11-04: a .opencode/plugins/*.js written by a jailed command ran inside `opencode serve`
  const plants = [".opencode/plugins/x.js", "opencode.json", "proj/opencode.jsonc", "proj/.claude/settings.json", ".mcp.json", "proj/deep/.agents/skills/a/SKILL.md", ".omo/omo.jsonc"]
  const mk = () => { for (const f of plants) { fs.mkdirSync(path.dirname(path.join(ALICE, f)), { recursive: true }); fs.writeFileSync(path.join(ALICE, f), "x") } }
  fs.mkdirSync(path.join(BOB, ".opencode"), { recursive: true }) // reachable from alice only through the junction "escape"
  fs.mkdirSync(path.join(ALICE, ".omo", "run-continuation"), { recursive: true }) // OmO's own state stays
  fs.writeFileSync(path.join(ALICE, "notes.md"), "keep")
  mk()
  await bash("ses_alice", "echo x")
  for (const f of plants) assert.equal(fs.existsSync(path.join(ALICE, f)), false, `before: ${f} still there`)
  assert.ok(fs.readdirSync(ALICE).some((n) => /^\.opencode\.zai-blocked-\d+$/.test(n)))
  assert.ok(fs.existsSync(path.join(ALICE, ".omo", "run-continuation")))
  assert.ok(fs.existsSync(path.join(ALICE, "notes.md")))
  assert.ok(fs.existsSync(path.join(BOB, ".opencode")), "junction must not be followed")
  // after: the command itself planted them again
  mk()
  const out = { output: "done" }
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_alice", callID: "c" }, out)
  for (const f of plants) assert.equal(fs.existsSync(path.join(ALICE, f)), false, `after: ${f} still there`)
  assert.match(out.output, /^done\n\[песочница\] Файлы конфигурации агента .*\.opencode/)
  // admin sessions and other tools are not touched
  fs.mkdirSync(path.join(ADMIN_DIR, ".opencode"), { recursive: true })
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_admin", callID: "c" }, { output: "" })
  await bash("ses_admin", "echo x")
  assert.ok(fs.existsSync(path.join(ADMIN_DIR, ".opencode")))
  const clean = { output: "ok" }
  await hooks["tool.execute.after"]({ tool: "read", sessionID: "ses_alice", callID: "c" }, clean)
  assert.equal(clean.output, "ok")
})

// FEAT-04.12 (2026-11-06): `cd /d <own folder> && rest` → the folder is the jail
// --cwd (cmd's own cd died with «Access is denied» walking C:\Users\USER);
// `zai-render <file>` as a whole command → the host renderer, args in base64.
test("FEAT-04.12: cd /d <своя подпапка> && … → --cwd подпапки, в base64 только остаток", async () => {
  const j = parse((await bash("ses_alice", `cd /d "${path.join(ALICE, "proj")}" && python build.py`)).command)
  assert.equal(j.exe, F(JAIL))
  assert.equal(j.opt("--cwd"), F(path.join(ALICE, "proj")))
  assert.equal(j.decoded, 'cmd.exe /d /s /c "python build.py"')
  const rel = parse((await bash("ses_alice", "cd proj && dir")).command)
  assert.equal(rel.opt("--cwd"), F(path.join(ALICE, "proj")))
  await assert.rejects(bash("ses_alice", `cd /d ${BOB} && type x`), /вне вашей папки/)
  await assert.rejects(bash("ses_alice", "cd .. && type x"), /вне вашей папки/)
})

test("FEAT-04.12: zai-render <файл> → рендерер на хосте; в цепочке — обычная команда песочницы", async () => {
  const RENDER = P("ops", "render", "zai_render.py")
  fs.mkdirSync(path.dirname(RENDER), { recursive: true })
  fs.writeFileSync(RENDER, "")
  process.env.ZAI_RENDER_SCRIPT = RENDER
  const args = await bash("ses_alice", 'zai-render "Новый дизайн.pptx" --pages 1-3', { workdir: path.join(ALICE, "proj") })
  const t = args.command.split(" ")
  assert.equal(t[0], F(PY_EXE))
  assert.deepEqual(t.slice(1, 3), ["-I", F(RENDER)])
  assert.equal(t[t.indexOf("--root") + 1], F(ALICE))
  assert.equal(t[t.indexOf("--cwd") + 1], F(path.join(ALICE, "proj")))
  assert.equal(Buffer.from(t[t.indexOf("--b64") + 1], "base64url").toString("utf8"), '"Новый дизайн.pptx" --pages 1-3')
  assert.match(args.command, SAFE)
  assert.equal(parse((await bash("ses_alice", "zai-render a.pptx && del a.pptx")).command).exe, F(JAIL))
  await assert.rejects(bash("ses_alice", "zai-render x.pptx", { workdir: BOB }), /вне вашей/)
  const admin = await bash("ses_admin", "zai-render a.pptx")
  assert.equal(admin.command, "zai-render a.pptx", "admin не трогается")
})
