// Tenant sandbox of vault-cache.ts (2026-11-04). Run:
//   node --test C:\Users\USER\.config\opencode\tests\vault-cache-sandbox.test.mjs
// Uses a throwaway layout under %TEMP%; never touches the real vault or users.json.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vc-sandbox-"))
const P = (...x) => path.join(ROOT, ...x)
const HOME_T = P("tenants", "home")
const VAULT_T = P("tenants", "vault")
const ALICE = P("tenants", "home", "alice")
const BOB = P("tenants", "home", "bob")
const ADMIN_DIR = P("admin-project")
const SECRET = P("secret", "auth.json")

let hook
let hooks
const sessions = {
  ses_admin: { id: "ses_admin", directory: ADMIN_DIR },
  ses_alice: { id: "ses_alice", directory: ALICE },
  ses_child: { id: "ses_child", directory: ALICE, parentID: "ses_alice" },
}

before(async () => {
  for (const d of [ALICE, BOB, ADMIN_DIR, path.dirname(SECRET), P("tenants", "vault", "alice"), P("tenants", "vault", "bob"), P("vault", "agents")]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(SECRET, "{}")
  fs.writeFileSync(path.join(ALICE, "notes.md"), "hi")
  // a junction inside the tenant folder that points outside of it
  execFileSync("cmd", ["/c", "mklink", "/J", path.join(ALICE, "escape"), path.dirname(SECRET)], { stdio: "ignore" })
  fs.writeFileSync(P("users.json"), JSON.stringify({ users: [{ name: "admin", role: "admin", directories: [] }] }))
  Object.assign(process.env, {
    ZAI_TENANT_HOME: HOME_T,
    ZAI_TENANT_VAULT: VAULT_T,
    ZAI_USERS_FILE: P("users.json"),
    VAULT_CACHE_ROOT: P("vault", "agents"),
    VAULT_CACHE_PROTECT: P("vault"),
    VAULT_CACHE_LOG: P("vault-cache.log"),
    // FEAT-04.9: tenant bash goes through the jail; here it only must exist (see vault-cache-jail.test.mjs)
    ZAI_JAIL_EXE: P("jail", "zai-jail.exe"),
    ZAI_SANDBOX_PY: P("py"),
  })
  for (const f of [P("jail", "zai-jail.exe"), P("py", "Scripts", "python.exe"), P("py", "Lib", "site-packages", "certifi", "cacert.pem")]) {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, "")
  }
  const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "vault-cache.ts")).href)
  const client = { session: { get: async ({ path: { id } }) => ({ data: sessions[id] }), messages: async () => ({ data: [] }) } }
  hooks = await mod.default({ client })
  hook = hooks["tool.execute.before"]
})

after(() => {
  try { fs.rmdirSync(path.join(ALICE, "escape")) } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true })
})

const run = (sessionID, tool, args) => hook({ tool, sessionID, callID: "c" }, { args })
const ok = (s, t, a) => assert.doesNotReject(run(s, t, a), `${t} ${JSON.stringify(a)} should run`)
const no = (s, t, a, re = /Доступ запрещён|недоступен/) => assert.rejects(run(s, t, a), re, `${t} ${JSON.stringify(a)} should be blocked`)

test("BUG-169: tenant system rules — search the OWN zone first on a question about the user; admin rules stripped", async () => {
  const out = { system: ["base prompt", `Instructions from: ${P("vault", "agents", "_index.md")}\nadmin rules`] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_alice" }, out)
  const all = out.system.join("\n")
  assert.match(all, /Вопрос о самом пользователе .*сначала поищи в базе знаний/)
  const rule = out.system.find((x) => /Вопрос о самом пользователе/.test(x))
  assert.ok(rule.includes(path.join(VAULT_T, "alice")), rule)
  assert.ok(!rule.includes(P("vault", "agents")), "the admin vault is never named to a tenant")
  assert.doesNotMatch(all, /admin rules/)
})

test("admin sessions are not sandboxed", async () => {
  await ok("ses_admin", "bash", { command: "dir C:\\" })
  await ok("ses_admin", "read", { filePath: SECRET })
  await ok("ses_admin", "task", { subagent_type: "explore", prompt: "x" })
})

test("tenant: tools outside the allowlist are refused", async () => {
  for (const t of ["interactive_bash", "task", "call_omo_agent", "playwright_browser_navigate", "marketplace_compare_browser_snapshot", "skill_mcp", "lsp_rename", "session_read", "skill", "ast_grep_replace"])
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

test("tenant subagent sessions inherit the sandbox", async () => {
  await no("ses_child", "bash", { command: "whoami", workdir: "C:\\" })
  await no("ses_child", "read", { filePath: SECRET })
  await ok("ses_child", "read", { filePath: "notes.md" })
})

test("unknown session: fail-closed", async () => {
  await assert.rejects(run("ses_missing", "read", { filePath: "x" }), /не удалось определить права/)
})
