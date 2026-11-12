// Ядро песочницы ops/opencode/sandbox-core/index.mjs (FEAT-16.3, tasks 4.1).
// Кейсы слиты из vault-cache-sandbox.test.mjs и vault-cache-jail.test.mjs
// (v1-адаптер) и дополнены v2-именами инструментов (shell/subagent, Э7) и
// codemode-обёрткой `execute` (Э10). Run:
//   node --test ops/opencode/tests/sandbox-core.test.mjs
// Throwaway layout под %TEMP%; реальный vault и users.json не трогаются.
// Кейс BUG-169 (tenant system-rules в system.transform) остаётся в
// vault-cache-sandbox.test.mjs — это системный промпт, не ядро песочницы.
// Все иероглифы в тестах — \u-escape: литеральные CJK в исходнике отклоняет
// CJK-страж самого воркера (BUG-180).
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sb-core-"))
const P = (...x) => path.join(ROOT, ...x)
const F = (p) => p.replace(/\\/g, "/")
const HOME_T = P("tenants", "home")
const VAULT_T = P("tenants", "vault")
const ALICE = P("tenants", "home", "alice")
const BOB = P("tenants", "home", "bob")
const NATALIA = P("portal-tenants", "natalia")
const ADMIN_DIR = P("admin-project")
const SECRET = P("secret", "auth.json")
const JAIL = P("ops", "sandbox", "zai-jail.exe")
const PY = P("zai-sandbox", "python")
const PY_EXE = path.join(PY, "Scripts", "python.exe")
const CAFILE = path.join(PY, "Lib", "site-packages", "certifi", "cacert.pem")

const sessions = {
  ses_admin: { id: "ses_admin", directory: ADMIN_DIR },
  ses_alice: { id: "ses_alice", directory: ALICE },
  ses_alice_sub: { id: "ses_alice_sub", directory: path.join(ALICE, "proj") },
  ses_child: { id: "ses_child", directory: ALICE, parentID: "ses_alice" },
  ses_nat: { id: "ses_nat", directory: NATALIA },
  ses_bad: { id: "ses_bad", directory: P("tenants", "home", "bad name") },
}

let core, sb

before(async () => {
  for (const d of [
    ALICE, path.join(ALICE, "proj"), path.join(ALICE, "vault-link-target"), BOB, NATALIA,
    P("tenants", "home", "bad name"), ADMIN_DIR, path.dirname(SECRET),
    P("tenants", "vault", "alice"), P("tenants", "vault", "bob"), P("vault", "agents"),
  ])
    fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(SECRET, "{}")
  fs.writeFileSync(path.join(ALICE, "notes.md"), "hi")
  for (const f of [JAIL, PY_EXE, CAFILE]) {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, "")
  }
  // junctions inside the tenant folder pointing outside of it
  execFileSync("cmd", ["/c", "mklink", "/J", path.join(ALICE, "escape"), path.dirname(SECRET)], { stdio: "ignore" })
  execFileSync("cmd", ["/c", "mklink", "/J", path.join(ALICE, "escape-bob"), BOB], { stdio: "ignore" })
  fs.writeFileSync(P("users.json"), JSON.stringify({ users: [
    { name: "admin", role: "admin", directories: [] },
    { name: "Carol S.", role: "user", directories: [NATALIA] },
  ] }))
  Object.assign(process.env, {
    ZAI_TENANT_HOME: HOME_T,
    ZAI_TENANT_VAULT: VAULT_T,
    ZAI_USERS_FILE: P("users.json"),
    VAULT_CACHE_ROOT: P("vault", "agents"),
    VAULT_CACHE_PROTECT: P("vault"),
    VAULT_CACHE_LOG: P("vault-cache.log"),
    ZAI_JAIL_EXE: JAIL,
    ZAI_SANDBOX_PY: PY,
    ZAI_TURN_UNDO_ROOT: P("turn-undo"),
  })
  core = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "sandbox-core", "index.mjs")).href)
  sb = core.createSandbox({
    getSession: async (id) => sessions[id] ?? null,
    getMessages: async () => [],
  })
})

after(() => {
  for (const j of [path.join(ALICE, "escape"), path.join(ALICE, "escape-bob")]) { try { fs.rmdirSync(j) } catch {} }
  fs.rmSync(ROOT, { recursive: true, force: true })
})

const run = (sessionID, tool, args) => sb.before(tool, sessionID, args)
const ok = (s, t, a) => assert.doesNotReject(run(s, t, a), `${t} ${JSON.stringify(a)} should run`)
const no = (s, t, a, re = /Доступ запрещён|недоступен/) => assert.rejects(run(s, t, a), re, `${t} ${JSON.stringify(a)} should be blocked`)

// ---- нормализация имён v1/v2 и codemode (FEAT-16.3: ядро, Э7/Э10) ----

test("canonicalTool: shell→bash, subagent→task; v1-имена и прочие — как есть", () => {
  assert.equal(core.canonicalTool("shell"), "bash")
  assert.equal(core.canonicalTool("subagent"), "task")
  assert.equal(core.canonicalTool("Shell"), "bash")
  assert.equal(core.canonicalTool("read"), "read")
  assert.equal(core.canonicalTool("bash"), "bash")
  assert.equal(core.canonicalTool("task"), "task")
  assert.equal(core.canonicalTool("marketplace_wb_search"), "marketplace_wb_search")
})

test("tenantToolAllowed: один allowlist для v1- и v2-имён", () => {
  for (const t of ["bash", "shell", "read", "glob", "grep", "list", "edit", "write", "webfetch", "todowrite", "question", "look_at"])
    assert.equal(core.tenantToolAllowed(t), true, t)
  for (const t of ["task", "subagent", "interactive_bash", "playwright_browser_navigate", "lsp_rename", "skill_mcp", "ast_grep_replace", "marketplace_compare_browser_snapshot"])
    assert.equal(core.tenantToolAllowed(t), false, t)
  assert.equal(core.tenantToolAllowed("context7_resolve-library-id"), true)
  assert.equal(core.tenantToolAllowed("marketplace_wb_search"), true)
})

test("codemodeToolCalls: имена tools.<сервер>.<метод> из кода + toolCalls в input/metadata", () => {
  assert.deepEqual(
    core.codemodeToolCalls({ code: 'return await tools.marketplace.wb_search({ q: 1 }) // tools.mini.echo()' }),
    ["marketplace.wb_search", "mini.echo"],
  )
  assert.deepEqual(core.codemodeToolCalls({ metadata: { toolCalls: [{ tool: "mini.echo" }, { tool: "context7.query-docs" }] } }), ["mini.echo", "context7.query-docs"])
  assert.deepEqual(core.codemodeToolCalls({ toolCalls: [{ tool: "grep_app.searchGitHub" }] }), ["grep_app.searchGitHub"])
  assert.deepEqual(core.codemodeToolCalls({ code: "const x = 1" }), [])
  assert.deepEqual(core.codemodeToolCalls("return await tools.marketplace.compare_prices()"), ["marketplace.compare_prices"])
})

// ---- vault-cache-sandbox.test.mjs: allowlist/paths/webfetch/fail-closed ----

test("admin sessions are not sandboxed (v1 и v2 имена)", async () => {
  await ok("ses_admin", "bash", { command: "dir C:\\" })
  await ok("ses_admin", "shell", { command: "dir C:\\" })
  await ok("ses_admin", "read", { filePath: SECRET })
  await ok("ses_admin", "task", { subagent_type: "explore", prompt: "x" })
  await ok("ses_admin", "subagent", { agent: "explore", prompt: "x" })
  await ok("ses_admin", "execute", { code: 'return await tools.playwright.browser_navigate({url:"file:///C:/x"})' })
})

test("tenant: tools outside the allowlist are refused", async () => {
  for (const t of ["interactive_bash", "task", "subagent", "call_omo_agent", "playwright_browser_navigate", "marketplace_compare_browser_snapshot", "skill_mcp", "lsp_rename", "session_read", "skill", "ast_grep_replace"])
    await no("ses_alice", t, {})
})

test("tenant: own folder works, relative paths included", async () => {
  await ok("ses_alice", "read", { filePath: path.join(ALICE, "notes.md") })
  await ok("ses_alice", "read", { filePath: "notes.md" })
  await ok("ses_alice", "write", { filePath: "sub/new.md", content: "x" })
  await ok("ses_alice", "glob", { pattern: "**/*.md" })
  await ok("ses_alice", "grep", { pattern: "C:\\\\d+", include: "*.md" })
  await ok("ses_alice", "list", {})
  await ok("ses_alice", "read", { filePath: path.join(VAULT_T, "alice", "lessons", "x.md") })
  await ok("ses_alice", "todowrite", { todos: [] })
})

test("tenant: paths outside the folder are refused", async () => {
  await no("ses_alice", "read", { filePath: SECRET })
  await no("ses_alice", "read", { filePath: "..\\bob\\x.md" })
  await no("ses_alice", "read", { filePath: path.join(BOB, "x.md") })
  await no("ses_alice", "list", { path: "C:\\" })
  await no("ses_alice", "glob", { pattern: "../../**/*.json" })
  await no("ses_alice", "glob", { pattern: "*.json", path: path.dirname(SECRET) })
  await no("ses_alice", "grep", { pattern: "key", path: "C:\\Users" })
  await no("ses_alice", "read", { filePath: path.join(VAULT_T, "bob", "x.md") })
  await no("ses_alice", "read", { filePath: "\\\\localhost\\c$\\Windows\\win.ini" })
})

test("tenant: a junction out of the folder does not help", async () => {
  await no("ses_alice", "read", { filePath: path.join(ALICE, "escape", "auth.json") })
  await no("ses_alice", "read", { filePath: "escape/auth.json" })
  await no("ses_alice", "write", { filePath: "escape/new.txt", content: "x" })
})

test("tenant: agent configuration cannot be written", async () => {
  await no("ses_alice", "write", { filePath: ".opencode/plugin/x.ts", content: "x" })
  await no("ses_alice", "write", { filePath: "opencode.json", content: "{}" })
  await no("ses_alice", "edit", { filePath: path.join(ALICE, ".omo", "omo.jsonc"), oldString: "a", newString: "b" })
  await no("ses_alice", "apply_patch", { patchText: "*** Begin Patch\n*** Add File: .opencode/plugin/p.ts\n+x\n*** End Patch" })
  await no("ses_alice", "write", { filePath: ".agents/skills/zai-x/SKILL.md", content: "x" })
  await no("ses_alice", "write", { filePath: "proj/.MCP.json", content: "{}" })
  await no("ses_alice", "write", { filePath: ".Claude/agents/a.md", content: "x" })
  await ok("ses_alice", "read", { filePath: "opencode.json" })
  await ok("ses_alice", "apply_patch", { patchText: "*** Begin Patch\n*** Update File: notes.md\n-hi\n+see C:\\Windows\\x\n*** End Patch" })
  await no("ses_alice", "apply_patch", { patchText: "*** Begin Patch\n*** Update File: ../bob/x.md\n+x\n*** End Patch" })
})

test("tenant: webfetch only to public hosts", async () => {
  for (const url of ["http://127.0.0.1:4096/session", "http://localhost:4170/zai/api", "http://[::1]:4096/", "http://192.168.1.1/", "http://10.0.0.5/", "http://169.254.169.254/latest", "file:///C:/Windows/win.ini", "ftp://example.com/", `http://${os.hostname()}:4096/`, "http://localtest.me:4096/session"])
    await no("ses_alice", "webfetch", { url, format: "text" })
  await ok("ses_alice", "webfetch", { url: "https://93.184.215.14/", format: "text" })
})

test("tenant: skill только zai-* (FEAT-04.10)", async () => {
  await ok("ses_alice", "skill", { name: "zai-xlsx" })
  await ok("ses_alice", "skill", { name: "/Zai-Docx" })
  await no("ses_alice", "skill", { name: "dogfood" }, /скилл/)
  await no("ses_alice", "skill", { name: "marketplace" }, /скилл/)
})

test("tenant subagent sessions inherit the sandbox", async () => {
  await no("ses_child", "bash", { command: "whoami", workdir: "C:\\" })
  await no("ses_child", "shell", { command: "whoami", workdir: "C:\\" })
  await no("ses_child", "read", { filePath: SECRET })
  await ok("ses_child", "read", { filePath: "notes.md" })
})

test("unknown session: fail-closed", async () => {
  await assert.rejects(run("ses_missing", "read", { filePath: "x" }), /не удалось определить права/)
})

// ---- codemode `execute` v2 (Э10) ----

test("tenant codemode execute: поисковые MCP внутри — можно", async () => {
  await ok("ses_alice", "execute", { code: 'return await tools.marketplace.wb_search({ query: "чайник" })' })
  await ok("ses_alice", "execute", { code: "const a = await tools.context7.resolveLibraryId({}); return await tools.grep_app.searchGitHub({})" })
  await ok("ses_alice", "execute", { metadata: { toolCalls: [{ tool: "marketplace.compare_prices" }] } })
})

test("tenant codemode execute: всё остальное — отказ (fail-closed)", async () => {
  await no("ses_alice", "execute", { code: 'return await tools.playwright.browser_navigate({ url: "file:///C:/Windows/win.ini" })' })
  await no("ses_alice", "execute", { code: 'return await tools.shell("whoami")' }, /execute/)
  await no("ses_alice", "execute", { code: 'return await tools.read({ path: "C:/x" })' }, /execute/)
  await no("ses_alice", "execute", { code: "return await tools.mini.echo({})" }, /mini\.echo/)
  await no("ses_alice", "execute", { code: "const x = 1; return x" }, /не распознаны/)
  await no("ses_alice", "execute", {}, /не распознаны/)
  await no("ses_alice", "execute", { metadata: { toolCalls: [{ tool: "marketplace_compare_browser_snapshot" }] } })
})

// ---- vault-cache-jail.test.mjs: jail, splitCd, zai-render, plants, unjail ----

async function bash(sessionID, command, extra = {}, tool = "bash") {
  const args = { command, description: "x", ...extra }
  await sb.before(tool, sessionID, args)
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
  const args = await bash("ses_alice", 'python -c "import pandas; print(1)"')
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

test("v2 shell is jailed identically (Э7: bash → shell)", async () => {
  const args = await bash("ses_alice", "whoami", {}, "shell")
  const j = parse(args.command)
  assert.equal(j.exe, F(JAIL))
  assert.equal(j.opt("--name"), "zai-t-alice")
  assert.equal(j.decoded, 'cmd.exe /d /s /c "whoami"')
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
  const v2 = parse((await bash("ses_alice", "cd", { workdir: "proj" }, "shell")).command)
  assert.equal(v2.opt("--cwd"), F(path.join(ALICE, "proj")), "v2 shell: workdir as well")
})

test("workdir outside the tenant folder is refused", async () => {
  for (const workdir of [BOB, "..\\bob", "C:\\Windows", "D:\\Portal\\zai", path.join(ALICE, "escape"), P("tenants", "vault", "alice")])
    await assert.rejects(bash("ses_alice", "dir", { workdir }), /Доступ запрещён/, workdir)
})

test("portal-defined tenant with a non-ASCII name gets a stable hashed container", async () => {
  const a = parse((await bash("ses_nat", "ver")).command)
  const b = parse((await bash("ses_nat", "ver")).command)
  assert.match(a.opt("--name"), /^zai-t-h[0-9a-f]{16}$/)
  assert.equal(a.opt("--name"), b.opt("--name"))
  assert.equal(a.opt("--dir"), F(NATALIA))
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
  await assert.rejects(run("ses_alice", "task", {}), /недоступен/)
  await assert.rejects(run("ses_alice", "subagent", {}), /недоступен/)
  await assert.rejects(run("ses_alice", "interactive_bash", { tmux_command: "x" }), /недоступен/)
})

test("MCP: v1-имена (подчёркивание) и v2 codemode — паритет", async () => {
  for (const tool of ["context7_resolve-library-id", "context7_query-docs", "grep_app_searchGitHub"])
    await assert.doesNotReject(run("ses_alice", tool, { query: "pandas" }), tool)
  for (const tool of ["playwright_browser_navigate", "lsp_diagnostics", "skill_mcp", "marketplace_compare_browser_snapshot"])
    await assert.rejects(run("ses_alice", tool, {}), /недоступен/, tool)
})

test("admin bash/shell is not touched", async () => {
  const args = await bash("ses_admin", 'dir C:\\ & echo "x"', { workdir: "C:\\" })
  assert.equal(args.command, 'dir C:\\ & echo "x"')
  assert.equal(args.workdir, "C:\\")
  const v2 = await bash("ses_admin", "dir C:\\", { workdir: "C:\\" }, "shell")
  assert.equal(v2.command, "dir C:\\")
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

test("the model's history shows the tenant's own command, not the launcher line (v1 bash и v2 shell)", async () => {
  // stand probe 2026-11-04: a model that saw `zai-jail.exe … --b64 …` started to imitate it
  const cmd = 'python -c "print(1 & 2)" | findstr 0'
  const args = { command: cmd, description: "x" }
  await sb.before("bash", "ses_alice", args)
  assert.match(args.command, /zai-jail\.exe .* --b64 /)
  const jailedLine = args.command
  const args2 = { command: cmd, description: "x" }
  await sb.before("shell", "ses_alice", args2)
  assert.match(args2.command, /zai-jail\.exe .* --b64 /)

  const stored = { type: "tool", tool: "shell", callID: "call_2", state: { status: "completed", input: { command: jailedLine, description: "x" }, output: "1" } }
  const other = { type: "tool", tool: "bash", state: { status: "completed", input: { command: "echo zai-jail --b64 notreally" } } }
  const out = core.unjailPart(stored)
  assert.equal(out.state.input.command, cmd, "v2 shell part unjailed")
  assert.equal(core.unjailPart(other), other, "non-jail commands untouched")
  const copy = JSON.parse(JSON.stringify(stored))
  copy.state.input.command = jailedLine
  const un = core.unjailPart(copy)
  assert.equal(copy.state.input.command, jailedLine, "the stored part object is not mutated")
  assert.equal(un.state.input.command, cmd)
})

test("agent-config plants from the tenant shell are moved away before and after bash (v1 и v2)", async () => {
  // stand 2026-11-04: a .opencode/plugins/*.js written by a jailed command ran inside `opencode serve`
  const plants = [".opencode/plugins/x.js", "opencode.json", "proj/opencode.jsonc", "proj/.claude/settings.json", ".mcp.json", "proj/deep/.agents/skills/a/SKILL.md", ".omo/omo.jsonc"]
  const mk = () => { for (const f of plants) { fs.mkdirSync(path.dirname(path.join(ALICE, f)), { recursive: true }); fs.writeFileSync(path.join(ALICE, f), "x") } }
  fs.mkdirSync(path.join(BOB, ".opencode"), { recursive: true }) // reachable from alice only through the junction "escape-bob"
  fs.mkdirSync(path.join(ALICE, ".omo", "run-continuation"), { recursive: true }) // OmO's own state stays
  fs.writeFileSync(path.join(ALICE, "notes.md"), "keep")
  mk()
  await bash("ses_alice", "echo x")
  for (const f of plants) assert.equal(fs.existsSync(path.join(ALICE, f)), false, `before: ${f} still there`)
  assert.ok(fs.readdirSync(ALICE).some((n) => /^\.opencode\.zai-blocked-\d+$/.test(n)))
  assert.ok(fs.existsSync(path.join(ALICE, ".omo", "run-continuation")))
  assert.ok(fs.existsSync(path.join(ALICE, "notes.md")))
  assert.ok(fs.existsSync(path.join(BOB, ".opencode")), "junction must not be followed")
  // after: the command itself planted them again; v2-имя shell — тот же карантин
  mk()
  const note = await sb.after("shell", "ses_alice")
  assert.match(String(note), /^\n\[песочница\] Файлы конфигурации агента .*\.opencode/)
  for (const f of plants) assert.equal(fs.existsSync(path.join(ALICE, f)), false, `after: ${f} still there`)
  // v1-имя bash — тоже (без before: карантин только after)
  mk()
  const note2 = await sb.after("bash", "ses_alice")
  assert.match(String(note2), /\[песочница\]/)
  for (const f of plants) assert.equal(fs.existsSync(path.join(ALICE, f)), false, `after bash: ${f} still there`)
  // admin sessions and other tools are not touched
  fs.mkdirSync(path.join(ADMIN_DIR, ".opencode"), { recursive: true })
  assert.equal(await sb.after("bash", "ses_admin"), null)
  await bash("ses_admin", "echo x")
  assert.ok(fs.existsSync(path.join(ADMIN_DIR, ".opencode")))
  assert.equal(await sb.after("read", "ses_alice"), null)
})

// FEAT-04.12: `cd /d <own folder> && rest` → the folder is the jail --cwd;
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

// ---- CJK-страж (BUG-180; кейсы vault-cache-cjk.test.mjs через ядро) ----
// Все CJK в исходнике — \u-escape: литеральные иероглифы страж не пропускает.

const blocked = (p) => assert.rejects(p, /иероглиф|сбой генерации|Запись отклонена/)

test("BUG-180: edit — иероглиф, приклеенный к кириллице, отклоняется", async () => {
  fs.writeFileSync(path.join(ALICE, "ru.md"), "# Заметка\n\nЗащита диалогов в resync.\n")
  const leak = "\u4E22\u5F03"
  await blocked(run("ses_alice", "edit", { filePath: "ru.md", oldString: "Защита диалогов", newString: `Защиту (п${leak} диалогов)` }))
})

test("BUG-180: изолированное CJK-слово в английском коде и U+FFFD отклоняются", async () => {
  const driver = "\u9A71\u52A8"
  await blocked(run("ses_alice", "write", { filePath: "app.js", content: `// store.test.js${driver} handleEvent\nexport function f() {}\n` }))
  await blocked(run("ses_alice", "write", { filePath: "new.md", content: "Итог: все тесты прошли \uFFFD успешно.\n" }))
})

test("BUG-180: намеренный китайский (высокая доля CJK) и правка файла, где CJK уже есть, проходят", async () => {
  const zh = "\u4F60\u597D\u4E16\u754C"
  await ok("ses_alice", "write", { filePath: "i18n.json", content: `{"hello": "${zh}"}\n` })
  fs.writeFileSync(path.join(ALICE, "zh-doc.md"), "# \u8BF4\u660E\n\n\u8FD9\u662F\u4E2D\u6587\u6587\u6863\u3002\n")
  await ok("ses_alice", "edit", { filePath: "zh-doc.md", oldString: "\u8FD9\u662F\u4E2D\u6587\u6587\u6863\u3002", newString: "\u8FD9\u662F\u4E2D\u6587\u6587\u6863\u3002Version 2 \u53D1\u5E03\u3002" })
})

test("BUG-180: повтор того же отклонённого вызова в той же сессии проходит (override)", async () => {
  const leak = "\u65E5\u5FD7"
  const args = () => ({ filePath: "ru.md", oldString: "Защита диалогов", newString: `Защита диалогов (термин ${leak} — «журнал»)` })
  await blocked(run("ses_alice", "edit", args()))
  await ok("ses_alice", "edit", args())
  await blocked(run("ses_alice", "edit", { filePath: "ru.md", oldString: "Защита", newString: `Защита п\u4E22\u5F03` }))
})

test("BUG-180: не-write инструменты не проверяются", async () => {
  await ok("ses_alice", "grep", { pattern: "\u4E22\u5F03", path: ALICE })
  await ok("ses_alice", "read", { filePath: path.join(ALICE, "zh-doc.md") })
})

test("glmEffort: GLM-5.3* low/high/max, title — low, прочие модели — null", () => {
  const m = { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, message: { model: { variant: "low" } } }
  assert.equal(core.glmEffort(m), "low")
  assert.equal(core.glmEffort({ ...m, message: { model: { variant: "max" } } }), "max")
  assert.equal(core.glmEffort({ ...m, agent: "title" }), "low")
  assert.equal(core.glmEffort({ ...m, message: { model: { variant: "bogus" } } }), null)
  assert.equal(core.glmEffort({ model: { providerID: "other", modelID: "glm-5.3" }, message: { model: { variant: "low" } } }), null)
  assert.equal(core.glmEffort({ model: { providerID: "zai-coding-plan", modelID: "glm-4.5" } }), null)
})

// TASK-16.7 (стенд v2, 2026-11-08): в opencode 2.2.6 read/edit/write берут `path`
// вместо `filePath`, skill — `id` вместо `name` (заметка мигратора 2.2.6 о переименованиях).
test("BUG-199: pointToChat — v2 `path` у read/edit/write уходит в папку чата; абсолютный не трогаем", () => {
  const chat = path.join(ALICE, "chats", "ses_x")
  const w = { path: "notes/ok.md", content: "x" }
  core.pointToChat("write", w, chat)
  assert.equal(w.path, path.resolve(chat, "notes/ok.md"))
  const r = { path: "a.txt" }
  core.pointToChat("read", r, chat)
  assert.equal(r.path, path.resolve(chat, "a.txt"))
  const abs = { path: path.join(ALICE, "x.txt") }
  core.pointToChat("edit", abs, chat)
  assert.equal(abs.path, path.join(ALICE, "x.txt"))
  const v1 = { filePath: "b.txt" }
  core.pointToChat("write", v1, chat)
  assert.equal(v1.filePath, path.resolve(chat, "b.txt"), "v1-ключ как раньше")
})

test("BUG-198: skillViolation — v2 skill передаёт `id`: zai-* разрешены, прочие — отказ с именем", () => {
  assert.equal(core.skillViolation({ id: "zai-xlsx" }), null)
  assert.match(core.skillViolation({ id: "as-spec" }), /скилл «as-spec» недоступен/)
  assert.equal(core.skillViolation({ name: "zai-pdf" }), null, "v1-ключ как раньше")
  assert.match(core.skillViolation({}), /скилл «\?» недоступен/)
})

test("BUG-200: writeTargets — v2 `path` у write/edit попадает в резервную копию хода", () => {
  const cwd = ALICE
  assert.deepEqual(core.writeTargets("write", { path: "n.md", content: "x" }, cwd), [path.resolve(cwd, "n.md")])
  assert.deepEqual(core.writeTargets("edit", { path: path.join(ALICE, "e.md"), oldString: "a", newString: "b" }, cwd), [path.join(ALICE, "e.md")])
  assert.deepEqual(core.writeTargets("read", { path: "n.md" }, cwd), [], "чтение — не запись")
})
