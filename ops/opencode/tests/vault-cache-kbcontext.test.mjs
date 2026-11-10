// FEAT-01.32 / BUG-01.27 of vault-cache.ts (2026-11-04): the user's text stays
// clean, the snapshot rides as metadata.kbContext and reaches the model only
// through experimental.chat.messages.transform. Run:
//   node --test ops/opencode/tests/vault-cache-kbcontext.test.mjs
// Throwaway layout under %TEMP%; never touches the real vault or users.json.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vc-kbctx-"))
const P = (...x) => path.join(ROOT, ...x)
const ADMIN_DIR = P("admin-project")
const ALICE = P("tenants", "home", "alice")
let hooks
const sessions = {
  ses_admin: { id: "ses_admin", directory: ADMIN_DIR },
  ses_alice: { id: "ses_alice", directory: ALICE },
  ses_old: { id: "ses_old", directory: ADMIN_DIR },
}
const history = { ses_old: [{ info: { id: "m0", role: "user", time: { created: 1 } }, parts: [] }] }

before(async () => {
  for (const d of [ADMIN_DIR, ALICE, P("tenants", "vault", "alice", "tasks"), P("vault", "agents", "tasks")]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(P("vault", "agents", "tasks", "t1.md"), "---\nstatus: active\n---\n# Задача администратора\n")
  fs.writeFileSync(P("tenants", "vault", "alice", "tasks", "a1.md"), "---\nstatus: active\n---\n# Задача Алисы\n")
  fs.writeFileSync(P("users.json"), JSON.stringify({ users: [{ name: "admin", role: "admin", directories: [] }] }))
  Object.assign(process.env, {
    ZAI_TENANT_HOME: P("tenants", "home"),
    ZAI_TENANT_VAULT: P("tenants", "vault"),
    ZAI_USERS_FILE: P("users.json"),
    VAULT_CACHE_ROOT: P("vault", "agents"),
    VAULT_CACHE_PROTECT: P("vault"),
    VAULT_CACHE_LOG: P("vault-cache.log"),
  })
  const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "vault-cache.ts")).href)
  assert.deepEqual(Object.keys(mod), ["default"], "opencode calls every export as a plugin: only the default one")
  const client = {
    session: {
      get: async ({ path: { id } }) => ({ data: sessions[id] }),
      messages: async ({ path: { id } }) => ({ data: history[id] ?? [] }),
    },
  }
  hooks = await mod.default({ client })
})

after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const firstMessage = async (sessionID, text) => {
  const part = { id: "p1", type: "text", text }
  await hooks["chat.message"]({ sessionID, messageID: "m1" }, { message: { id: "m1", agent: "build" }, parts: [part] })
  return part
}

test("admin: the typed text stays clean, the snapshot is metadata.kbContext", async () => {
  const part = await firstMessage("ses_admin", "Привет")
  assert.equal(part.text, "Привет")
  assert.match(part.metadata.kbContext, /^\[obsidian-cache\] Активный кэш проекта/)
  assert.match(part.metadata.kbContext, /Задача администратора/)
  assert.match(part.metadata.kbContext, /Правила кэша: .*_index\.md/)
})

test("tenant: only its own zone, no admin rules or admin vault", async () => {
  const part = await firstMessage("ses_alice", "Привет")
  assert.equal(part.text, "Привет")
  const s = part.metadata.kbContext
  assert.match(s, /пользователя «alice»/)
  assert.match(s, /Задача Алисы/)
  assert.doesNotMatch(s, /Задача администратора|Правила кэша|_index\.md/)
})

test("later turns get no snapshot", async () => {
  const part = await firstMessage("ses_old", "второй вопрос")
  assert.equal(part.text, "второй вопрос")
  assert.equal(part.metadata, undefined)
})

test("messages.transform: the model sees snapshot --- text; the stored part is not mutated; legacy passes", async () => {
  const stored = { id: "p1", type: "text", text: "Привет", metadata: { kbContext: "[obsidian-cache] X" } }
  const legacy = { id: "p2", type: "text", text: "[obsidian-cache] Y\n\n---\n\nстарый" , metadata: { kbContext: "[obsidian-cache] Y" } }
  const plain = { id: "p3", type: "text", text: "без кэша" }
  const asst = { id: "p4", type: "text", text: "ответ", metadata: { kbContext: "[obsidian-cache] Z" } }
  const out = {
    messages: [
      { info: { role: "user" }, parts: [stored] },
      { info: { role: "assistant" }, parts: [asst] },
      { info: { role: "user" }, parts: [legacy, plain] },
    ],
  }
  await hooks["experimental.chat.messages.transform"]({}, out)
  assert.equal(out.messages[0].parts[0].text, "[obsidian-cache] X\n\n---\n\nПривет")
  assert.equal(stored.text, "Привет", "the stored part object is untouched")
  assert.equal(out.messages[1].parts[0].text, "ответ", "assistant parts pass")
  assert.equal(out.messages[2].parts[0].text, legacy.text, "a legacy message is not doubled")
  assert.equal(out.messages[2].parts[1], plain)
})
