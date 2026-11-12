// FEAT-16.3 шаг C (v2fix2), п.4: compaction-правило (vault-cache.ts
// experimental.session.compacting, 1383-1400) → ctx.session.hook("compaction"):
// ссылка на дайджест сессии → event.system.push (таблица design §7).
// Run: node --test ops/opencode/tests/plugin-v2-compaction.test.mjs
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pv2-comp-"))
const P = (...x) => path.join(ROOT, ...x)
const FWD = (p) => p.replace(/\\/g, "/")
const sessions = {}
const reg = { session: {}, tool: {} }
let cleanup
let hooks

before(async () => {
  for (const d of [P("vault", "sessions"), P("tvault", "sessions"), P("home", "alice", "work"), P("data")]) fs.mkdirSync(d, { recursive: true })
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
  sessions.ses_t = { id: "ses_t", location: { directory: FWD(P("home", "alice", "work")) } }
  sessions.ses_a = { id: "ses_a", location: { directory: FWD(P("vault")) } }
  const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "plugin-v2", "index.ts")).href)
  cleanup = await mod.default.setup({
    session: {
      get: async ({ sessionID }) => sessions[sessionID] ?? null,
      context: async () => [],
      hook: async (name, cb) => {
        reg.session[name] = cb
      },
    },
    tool: { hook: async (name, cb) => { reg.tool[name] = cb } },
    event: { subscribe: () => (async function* () {})() },
  })
})
after(() => {
  if (typeof cleanup === "function") cleanup()
  fs.rmSync(ROOT, { recursive: true, force: true })
})

test("compactionNote: дайджеста нет → null", () => {
  const z = { tenant: "alice", root: FWD(P("tvault")), home: FWD(P("home", "alice")) }
  assert.equal(hooks.compactionNote(z, "ses_none", null), null)
})

test("compactionNote: формулировки тенанта и admin — путь к дайджесту и правило ссылок", () => {
  const tz = { tenant: "alice", root: FWD(P("tvault")), home: FWD(P("home", "alice")) }
  const az = { tenant: null, root: FWD(P("vault")), home: FWD(P("home")) }
  const file = hooks.digestFile(tz.root, "ses_t")
  const tn = hooks.compactionNote(tz, "ses_t", "prev")
  assert.ok(tn.includes(file), "путь к файлу дайджеста")
  assert.ok(tn.includes("При компакции сохрани ссылки на заметки из своей зоны"), "тенантская формулировка")
  const an = hooks.compactionNote(az, "ses_a", "prev")
  assert.ok(an.includes(hooks.digestFile(az.root, "ses_a")))
  assert.ok(an.includes("при компакции сохрани ссылки на задачи/решения/уроки"), "admin-формулировка")
})

test("хук compaction: дайджест существует → system.push; не существует → без правок", async () => {
  // root тенант-зоны из zoneOf = TENANT_VAULT/<имя>
  const z = { tenant: "alice", root: FWD(P("tvault", "alice")), home: FWD(P("home", "alice")) }
  await hooks.writeDigest({ id: "ses_t", directory: FWD(P("home", "alice", "work")), title: "Т" }, z, {
    ask: "вопрос",
    files: [],
    toolCalls: 0,
    outcome: "итог",
  })
  const ev = { sessionID: "ses_t", system: [{ type: "text", text: "base" }], messages: [], options: {} }
  await reg.session.compaction(ev)
  assert.equal(ev.system.length, 2, "дайджест есть → push")
  assert.ok(ev.system[1].text.includes("ses_t"), "ссылка на дайджест этой сессии")
  const ev2 = { sessionID: "ses_a", system: [{ type: "text", text: "base" }], messages: [], options: {} }
  await reg.session.compaction(ev2)
  assert.equal(ev2.system.length, 1, "дайджеста нет → без правок")
})
