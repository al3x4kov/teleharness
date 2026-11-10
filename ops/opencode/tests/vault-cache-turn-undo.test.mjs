// BUG-146 / FEAT-01.58 of vault-cache.ts (2026-11-04): before a write tool
// changes a file, its first state in the turn is kept in
// <ZAI_TURN_UNDO_ROOT>/<root session>/<question>/ — the format of
// lib/turn-undo-hook.mjs backup(), so the portal's TurnUndo can undo it. Run:
//   node --test ops/opencode/tests/vault-cache-turn-undo.test.mjs
// Throwaway layout under %TEMP%; never touches the real vault or users.json.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { TurnUndo } from "../../../lib/turn-undo.js"
import { recordKey } from "../../../lib/turn-undo-hook.mjs"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vc-undo-"))
const P = (...x) => path.join(ROOT, ...x)
const ADMIN_DIR = P("admin-project")
const ALICE = P("tenants", "home", "alice")
const UNDO = P("data", "turn-undo")
let hooks
const sessions = {
  ses_admin: { id: "ses_admin", directory: ADMIN_DIR },
  ses_child: { id: "ses_child", directory: ADMIN_DIR, parentID: "ses_admin" },
  ses_grand: { id: "ses_grand", directory: ADMIN_DIR, parentID: "ses_child" },
  ses_alice: { id: "ses_alice", directory: ALICE },
  ses_restart: { id: "ses_restart", directory: ADMIN_DIR },
}
const history = { ses_restart: [{ info: { id: "msg_r1", role: "user", time: { created: 1 } }, parts: [] }] }
let gets = 0

before(async () => {
  for (const d of [ADMIN_DIR, ALICE, P("tenants", "vault", "alice"), P("vault", "agents"), P("data")]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(P("data", "users.json"), JSON.stringify({ users: [{ name: "admin", role: "admin", directories: [] }] }))
  delete process.env.ZAI_TURN_UNDO_ROOT // default: <dirname(users.json)>/turn-undo
  Object.assign(process.env, {
    ZAI_TENANT_HOME: P("tenants", "home"),
    ZAI_TENANT_VAULT: P("tenants", "vault"),
    ZAI_USERS_FILE: P("data", "users.json"),
    VAULT_CACHE_ROOT: P("vault", "agents"),
    VAULT_CACHE_PROTECT: P("vault"),
    VAULT_CACHE_LOG: P("vault-cache.log"),
  })
  const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "vault-cache.ts")).href)
  assert.deepEqual(Object.keys(mod), ["default"], "only the default export")
  const client = {
    session: {
      get: async ({ path: { id } }) => {
        gets++
        return { data: sessions[id] }
      },
      messages: async ({ path: { id } }) => ({ data: history[id] ?? [] }),
    },
  }
  hooks = await mod.default({ client })
})

after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const ask = (sessionID, messageID) =>
  hooks["chat.message"]({ sessionID, messageID }, { message: { id: messageID, sessionID, role: "user" }, parts: [{ type: "text", text: "x" }] })
const tool = (sessionID, name, args) => hooks["tool.execute.before"]({ tool: name, sessionID, callID: "c" }, { args })
const rec = (sid, mid, abs) => {
  const f = path.join(UNDO, sid, mid, `${recordKey(abs)}.json`)
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null
}

test("write/edit: the first state of the file is kept before the change; a second edit changes nothing", async () => {
  const a = path.join(ADMIN_DIR, "a.txt")
  fs.writeFileSync(a, "A")
  await ask("ses_admin", "msg_1")
  await tool("ses_admin", "edit", { filePath: "a.txt", oldString: "A", newString: "B" })
  fs.writeFileSync(a, "B") // the tool ran
  await tool("ses_admin", "write", { filePath: a, content: "C" })
  fs.writeFileSync(a, "C")
  const r = rec("ses_admin", "msg_1", a)
  assert.equal(r.path, a)
  assert.equal(r.existed, true)
  assert.equal(r.complete, true)
  assert.equal(typeof r.at, "number")
  assert.equal(fs.readFileSync(path.join(UNDO, "ses_admin", "msg_1", `${recordKey(a)}.bak`), "utf8"), "A")

  await tool("ses_admin", "write", { filePath: "new.txt", content: "N" })
  fs.writeFileSync(path.join(ADMIN_DIR, "new.txt"), "N")
  assert.equal(rec("ses_admin", "msg_1", path.join(ADMIN_DIR, "new.txt")).existed, false, "a created file")

  // apply_patch: every file header (Add/Update/Delete/Move to)
  await tool("ses_admin", "apply_patch", { patchText: "*** Begin Patch\n*** Add File: p1.txt\n+x\n*** Update File: sub/p2.txt\n*** Move to: sub/p3.txt\n*** End Patch" })
  for (const f of ["p1.txt", "sub/p2.txt", "sub/p3.txt"]) assert.ok(rec("ses_admin", "msg_1", path.resolve(ADMIN_DIR, f)), f)
  // read-only tools leave nothing
  await tool("ses_admin", "read", { filePath: "other.txt" })
  assert.equal(rec("ses_admin", "msg_1", path.join(ADMIN_DIR, "other.txt")), null)
})

test("the portal's TurnUndo undoes and redoes the plugin's backups; session.idle seals the result", async () => {
  const a = path.join(ADMIN_DIR, "a.txt")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_admin" } } })
  assert.ok(fs.existsSync(path.join(UNDO, "ses_admin", "msg_1", `${recordKey(a)}.after.json`)), "sealed")
  const undo = new TurnUndo({ root: UNDO })
  const plan = undo.preview("ses_admin", "msg_1")
  assert.deepEqual(plan.find((f) => f.path === a), { path: a, action: "restore" })
  assert.deepEqual(plan.find((f) => f.path === path.join(ADMIN_DIR, "new.txt")), { path: path.join(ADMIN_DIR, "new.txt"), action: "delete" })
  undo.revert("ses_admin", "msg_1")
  assert.equal(fs.readFileSync(a, "utf8"), "A")
  assert.equal(fs.existsSync(path.join(ADMIN_DIR, "new.txt")), false)
  // an idle while the turn is undone must not record the pre-turn state as its result
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_admin" } } })
  undo.unrevert("ses_admin", "msg_1")
  assert.equal(fs.readFileSync(a, "utf8"), "C")
  assert.deepEqual(undo.preview("ses_admin", "msg_1").find((f) => f.path === a), { path: a, action: "restore" }, "still undoable, not «changed after»")
})

test("subagent sessions (task) write into the turn of the root session; parentID is cached", async () => {
  const b = path.join(ADMIN_DIR, "b.txt")
  fs.writeFileSync(b, "child-before")
  await ask("ses_admin", "msg_2")
  await ask("ses_child", "msg_child_q") // the subagent's own prompt: no new turn
  const n = gets
  await tool("ses_grand", "write", { filePath: b, content: "x" })
  await tool("ses_grand", "edit", { filePath: path.join(ADMIN_DIR, "b2.txt"), oldString: "", newString: "y" })
  assert.ok(gets - n <= 1, `session.get cached (${gets - n} calls)`)
  assert.equal(rec("ses_admin", "msg_2", b).existed, true)
  assert.equal(fs.readFileSync(path.join(UNDO, "ses_admin", "msg_2", `${recordKey(b)}.bak`), "utf8"), "child-before")
  assert.equal(fs.existsSync(path.join(UNDO, "ses_child")), false)
  assert.equal(fs.existsSync(path.join(UNDO, "ses_grand")), false)
  assert.equal(fs.existsSync(path.join(UNDO, "ses_admin", "msg_1")), false, "a new question drops the backups of the previous turn")
})

test("after a serve restart (no chat.message seen) the last question of the history is the turn", async () => {
  await tool("ses_restart", "write", { filePath: "r.txt", content: "r" })
  assert.ok(rec("ses_restart", "msg_r1", path.join(ADMIN_DIR, "r.txt")))
})

test("a backup error never breaks the tool", async () => {
  // the turn folder path is taken by a FILE: mkdir fails
  fs.mkdirSync(path.join(UNDO, "ses_admin"), { recursive: true })
  await ask("ses_admin", "msg_3")
  fs.writeFileSync(path.join(UNDO, "ses_admin", "msg_3"), "not a folder")
  await assert.doesNotReject(tool("ses_admin", "write", { filePath: "c.txt", content: "c" }))
  // a weird argument shape
  await assert.doesNotReject(tool("ses_admin", "write", { filePath: 42 }))
  await assert.doesNotReject(tool("ses_admin", "apply_patch", { patchText: null }))
  // an unknown-turn session: nothing to back up into, still runs
  fs.rmSync(path.join(UNDO, "ses_admin", "msg_3"), { force: true })
})

test("tenant sandbox stays first: a refused call leaves no backup, an allowed one is backed up", async () => {
  await ask("ses_alice", "msg_t1")
  await assert.rejects(tool("ses_alice", "write", { filePath: "../bob/x.md", content: "x" }), /Доступ запрещён/)
  await assert.rejects(tool("ses_alice", "write", { filePath: ".opencode/plugin/p.ts", content: "x" }), /Доступ запрещён/)
  await assert.rejects(tool("ses_alice", "task", { subagent_type: "explore", prompt: "x" }), /недоступен/)
  assert.equal(fs.existsSync(path.join(UNDO, "ses_alice", "msg_t1")), false, "nothing kept for refused calls")
  await tool("ses_alice", "write", { filePath: "mine.md", content: "x" })
  assert.equal(rec("ses_alice", "msg_t1", path.join(ALICE, "mine.md")).existed, false)
  await assert.rejects(tool("ses_missing", "write", { filePath: "x", content: "x" }), /не удалось определить права/, "fail-closed stays")
})
