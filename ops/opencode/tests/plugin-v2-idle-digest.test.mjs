// FEAT-16.3 шаг C (v2fix2), п.5: дайджест сессии на session.idle (vault-cache.ts
// event-хук, 1355-1381: undoSeal + extractDigest + writeDigest) → ctx.event.subscribe()
// с cleanup; п.1 дополнительно: seal хода (BUG-146) на idle.
// Run: node --test ops/opencode/tests/plugin-v2-idle-digest.test.mjs
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pv2-idle-"))
const P = (...x) => path.join(ROOT, ...x)
const FWD = (p) => p.replace(/\\/g, "/")
const sessions = {}
const contexts = {}
const reg = { session: {}, tool: {} }
let cleanup
let hooks
let emit // положить событие в поток ctx.event.subscribe

before(async () => {
  for (const d of [P("vault"), P("home", "alice", "work"), P("data")]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(P("data", "users.json"), JSON.stringify({ users: [] }))
  Object.assign(process.env, {
    VAULT_CACHE_ROOT: P("vault"),
    VAULT_CACHE_PROTECT: P("vault"),
    ZAI_TENANT_HOME: P("home"),
    ZAI_TENANT_VAULT: P("tvault"),
    ZAI_USERS_FILE: P("data", "users.json"),
    ZAI_TURN_UNDO_ROOT: P("turn-undo"),
    VAULT_CACHE_LOG: P("vault-cache.log"),
  })
  hooks = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "plugin-v2", "hooks.mjs")).href)
  sessions.ses_a = { id: "ses_a", location: { directory: FWD(P("vault")) }, title: "Админ-диалог" }
  contexts.ses_a = [
    { id: "u1", type: "user", text: "[obsidian-cache] снапшот\n\n---\n\nпочини баг" },
    { id: "a1", type: "assistant", content: [{ type: "tool", name: "edit", state: { input: { path: "D:/w/lib/x.js" } } }, { type: "text", text: "Починил. Итог работ." }] },
  ]
  let push
  let next = new Promise((res) => (push = res))
  emit = (ev) => push(ev)
  async function* gen() {
    for (;;) {
      yield await next
      next = new Promise((res) => (push = res))
    }
  }
  const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "plugin-v2", "index.ts")).href)
  cleanup = await mod.default.setup({
    session: {
      get: async ({ sessionID }) => sessions[sessionID] ?? null,
      context: async ({ sessionID }) => contexts[sessionID] ?? [],
      hook: async (name, cb) => {
        reg.session[name] = cb
      },
    },
    tool: { hook: async (name, cb) => { reg.tool[name] = cb } },
    event: { subscribe: () => gen() },
  })
})
after(() => {
  if (typeof cleanup === "function") cleanup()
  fs.rmSync(ROOT, { recursive: true, force: true })
})

const waitFor = async (fn, ms = 4000) => {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return true
    if (Date.now() - t0 > ms) return false
    await new Promise((r) => setTimeout(r, 50))
  }
}

test("extractDigest: запрос без снапшотного префикса, файлы правок, итог", () => {
  const msgs = contexts.ses_a.map(hooks.toV1Message)
  const d = hooks.extractDigest(msgs)
  assert.equal(d.ask, "почини баг")
  assert.ok(d.files.includes("lib/x.js"), "последние 2 сегмента пути")
  assert.equal(d.toolCalls, 1)
  assert.ok(d.outcome.includes("Починил"))
  assert.equal(hooks.extractDigest([]), null, "без user-сообщений → null")
})

test("writeDigest: первый вызов создаёт файл с frontmatter, второй дополняет и обновляет updated", async () => {
  const z = { tenant: null, root: FWD(P("vault")), home: FWD(P("home")) }
  const s = { id: "ses_w", directory: FWD(P("vault")), title: "Т" }
  await hooks.writeDigest(s, z, { ask: "первый ход", files: [], toolCalls: 0, outcome: "ок" })
  const file = hooks.digestFile(z.root, "ses_w")
  const first = fs.readFileSync(file, "utf8")
  assert.ok(first.includes("type: session"))
  assert.ok(first.includes("session: ses_w"))
  assert.ok(first.includes("directory: "), "directory в frontmatter (фильтр снапшота BUG-12.14)")
  assert.ok(first.includes("## "), "запись хода")
  await new Promise((r) => setTimeout(r, 20))
  await hooks.writeDigest(s, z, { ask: "второй ход", files: [], toolCalls: 0, outcome: "" })
  const second = fs.readFileSync(file, "utf8")
  assert.ok(second.includes("первый ход") && second.includes("второй ход"), "дополнение, не перезапись")
  assert.ok(second.includes("Итог: (пусто)"))
})

test("session.idle: дайджест сессии дописан в vault-зону, isPrimary-фильтр", async () => {
  emit({ type: "session.idle", properties: { sessionID: "ses_a" } })
  const file = hooks.digestFile(FWD(P("vault")), "ses_a")
  const ok = await waitFor(() => fs.existsSync(file))
  assert.ok(ok, `файл дайджеста создан: ${file}`)
  if (ok) {
    const text = fs.readFileSync(file, "utf8")
    assert.ok(text.includes("почини баг"), "вопрос без снапшотного префикса")
    assert.ok(text.includes("Итог: Починил"), "итог хода")
  }
  emit({ type: "session.idle", properties: { sessionID: "ses_nosuch" } })
  await new Promise((r) => setTimeout(r, 300)) // не падает на неизвестной сессии
})

test("session.idle: seal хода — после write-вызова появляется <hash>.after.json (BUG-146)", async () => {
  await reg.session.prompt({ sessionID: "ses_a", messageID: "msg_t1", prompt: { text: "ход" }, metadata: {} })
  const target = P("vault", "undo-me.txt")
  fs.writeFileSync(target, "before")
  await reg.tool["execute.before"]({ tool: "write", sessionID: "ses_a", input: { filePath: target, content: "after" } })
  emit({ type: "session.idle", properties: { sessionID: "ses_a" } })
  const dir = P("turn-undo", "ses_a", "msg_t1")
  const ok = await waitFor(() => fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n.endsWith(".after.json")))
  assert.ok(ok, "after.json создан при idle")
  if (ok) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((n) => n.endsWith(".after.json"))), "utf8"))
    assert.equal(rec.exists, true)
    assert.ok(rec.hash, "hash содержимого")
  }
})
