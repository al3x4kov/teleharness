// FEAT-04.12 stage B: a tenant chat created under the per-chat scheme has its own
// working folder <tenant>\chats\<session id without ses_> (made by the portal,
// lib/chat-folder.js). The session directory stays the tenant root (one opencode
// instance); the plugin points bash, relative paths and searches at the chat
// folder and tells the model. Old chats (no folder) keep the root.
// Run: node --test ops/opencode/tests/vault-cache-chatdir.test.mjs
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vc-chatdir-"))
const P = (...x) => path.join(ROOT, ...x)
const F = (p) => p.replace(/\\/g, "/")
const ALICE = P("tenants", "home", "alice")
const CHAT = path.join(ALICE, "chats", "new1")
const JAIL = P("ops", "sandbox", "zai-jail.exe")
const PY = P("zai-sandbox", "python")
const RENDER = P("ops", "render", "zai_render.py")

let hooks, hook
const sessions = {
  ses_new1: { id: "ses_new1", directory: ALICE },
  ses_old1: { id: "ses_old1", directory: ALICE },
  ses_kid1: { id: "ses_kid1", directory: ALICE, parentID: "ses_new1" },
  ses_admin: { id: "ses_admin", directory: P("admin-project") },
}

before(async () => {
  for (const d of [CHAT, path.join(ALICE, ".zai-uploads"), P("admin-project"), P("tenants", "vault", "alice")]) fs.mkdirSync(d, { recursive: true })
  for (const f of [JAIL, path.join(PY, "Scripts", "python.exe"), path.join(PY, "Lib", "site-packages", "certifi", "cacert.pem"), RENDER]) {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, "")
  }
  fs.writeFileSync(P("users.json"), JSON.stringify({ users: [{ name: "admin", role: "admin", directories: [] }] }))
  Object.assign(process.env, {
    ZAI_TENANT_HOME: P("tenants", "home"),
    ZAI_TENANT_VAULT: P("tenants", "vault"),
    ZAI_USERS_FILE: P("users.json"),
    VAULT_CACHE_ROOT: P("vault", "agents"),
    VAULT_CACHE_PROTECT: P("vault"),
    VAULT_CACHE_LOG: P("vault-cache.log"),
    ZAI_JAIL_EXE: JAIL,
    ZAI_SANDBOX_PY: PY,
    ZAI_RENDER_SCRIPT: RENDER,
  })
  const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "vault-cache.ts")).href)
  const client = { session: { get: async ({ path: { id } }) => ({ data: sessions[id] }), messages: async () => ({ data: [] }) } }
  hooks = await mod.default({ client })
  hook = hooks["tool.execute.before"]
})
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const call = async (sessionID, tool, args) => {
  await hook({ tool, sessionID, callID: "c" }, { args })
  return args
}
const cwdOf = (cmd) => { const t = cmd.split(" "); return t[t.indexOf("--cwd") + 1] }

test("bash без workdir — в подпапке чата; относительный workdir — от неё; старый чат — корень", async () => {
  assert.equal(cwdOf((await call("ses_new1", "bash", { command: "python a.py", description: "x" })).command), F(CHAT))
  assert.equal(cwdOf((await call("ses_new1", "bash", { command: "dir", description: "x", workdir: "sub" })).command), F(path.join(CHAT, "sub")))
  assert.equal(cwdOf((await call("ses_old1", "bash", { command: "dir", description: "x" })).command), F(ALICE))
  assert.equal(cwdOf((await call("ses_kid1", "bash", { command: "dir", description: "x" })).command), F(CHAT), "субагент — папка корневого чата")
  assert.equal(cwdOf((await call("ses_new1", "bash", { command: "zai-render deck.pptx", description: "x" })).command), F(CHAT), "zai-render тоже из подпапки")
})

test("файлы: относительный путь → подпапка чата; абсолютный не трогается; вложения через .zai-uploads", async () => {
  assert.equal(F((await call("ses_new1", "write", { filePath: "deck.pptx", content: "x" })).filePath), F(path.join(CHAT, "deck.pptx")))
  assert.equal(F((await call("ses_new1", "read", { filePath: ".zai-uploads/a.xlsx" })).filePath), F(path.join(CHAT, ".zai-uploads", "a.xlsx")))
  const abs = path.join(ALICE, "old.txt")
  assert.equal((await call("ses_new1", "write", { filePath: abs, content: "x" })).filePath, abs)
  assert.equal(F((await call("ses_old1", "write", { filePath: "deck.pptx", content: "x" })).filePath), "deck.pptx", "старый чат: как было")
})

test("list/glob/grep без path — в подпапке чата; с относительным — от неё", async () => {
  assert.equal(F((await call("ses_new1", "glob", { pattern: "*.pptx" })).path), F(CHAT))
  assert.equal(F((await call("ses_new1", "grep", { pattern: "x" })).path), F(CHAT))
  assert.equal(F((await call("ses_new1", "list", {})).path), F(CHAT))
  assert.equal(F((await call("ses_new1", "glob", { pattern: "*", path: "out" })).path), F(path.join(CHAT, "out")))
  assert.equal((await call("ses_old1", "glob", { pattern: "*" })).path, undefined)
})

test("системный промпт называет рабочую папку чата; админ и старый чат — без неё", async () => {
  const t = hooks["experimental.chat.system.transform"]
  const out = { system: ["base"] }
  await t({ sessionID: "ses_new1" }, out)
  assert.ok(out.system.some((s) => s.includes(CHAT) && /рабоч/i.test(s)), out.system.join("\n"))
  const old = { system: ["base"] }
  await t({ sessionID: "ses_old1" }, old)
  assert.ok(!old.system.some((s) => s.includes(path.join("chats", ""))))
  const adm = { system: ["base"] }
  await t({ sessionID: "ses_admin" }, adm)
  assert.ok(!adm.system.some((s) => s.includes("chats")))
})
