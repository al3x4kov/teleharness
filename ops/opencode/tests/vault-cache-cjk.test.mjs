// BUG-180 / BUG-11.16 of vault-cache.ts (2026-11-06): GLM-5.3-Flash sometimes
// emits isolated CJK fragments inside Russian/English text (zai-org/GLM-5#142;
// prod opencode.db: «п丢弃 диалогов», «с逃生-клагом»). tool.execute.before
// refuses a write tool call that would put such a fragment into a file; text
// that is Chinese on purpose passes. Run:
//   node --test ops/opencode/tests/vault-cache-cjk.test.mjs
// Throwaway layout under %TEMP%; never touches the real vault or users.json.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vc-cjk-"))
const P = (...x) => path.join(ROOT, ...x)
const ADMIN_DIR = P("admin-project")
const ALICE = P("tenants", "home", "alice")
const UNDO = P("data", "turn-undo")
let hooks
const sessions = {
  ses_admin: { id: "ses_admin", directory: ADMIN_DIR },
  ses_admin2: { id: "ses_admin2", directory: ADMIN_DIR },
  ses_alice: { id: "ses_alice", directory: ALICE },
}

before(async () => {
  for (const d of [ADMIN_DIR, ALICE, P("tenants", "vault", "alice"), P("vault", "agents"), P("data")]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(P("data", "users.json"), JSON.stringify({ users: [{ name: "admin", role: "admin", directories: [] }] }))
  Object.assign(process.env, {
    ZAI_TENANT_HOME: P("tenants", "home"),
    ZAI_TENANT_VAULT: P("tenants", "vault"),
    ZAI_USERS_FILE: P("data", "users.json"),
    ZAI_TURN_UNDO_ROOT: UNDO,
    VAULT_CACHE_ROOT: P("vault", "agents"),
    VAULT_CACHE_PROTECT: P("vault"),
    VAULT_CACHE_LOG: P("vault-cache.log"),
  })
  const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "vault-cache.ts")).href)
  const client = {
    session: {
      get: async ({ path: { id } }) => ({ data: sessions[id] }),
      messages: async () => ({ data: [] }),
    },
  }
  hooks = await mod.default({ client })
  fs.writeFileSync(path.join(ADMIN_DIR, "ru.md"), "# Заметка\n\nЗащита диалогов в resync.\n")
  fs.writeFileSync(path.join(ADMIN_DIR, "zh.md"), "# 说明\n\n这是中文文档。\n")
  fs.writeFileSync(path.join(ADMIN_DIR, "app.js"), "export const x = 1\n")
})

after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const ask = (sessionID, messageID) =>
  hooks["chat.message"]({ sessionID, messageID }, { message: { id: messageID, sessionID, role: "user" }, parts: [{ type: "text", text: "x" }] })
const tool = (sessionID, name, args) => hooks["tool.execute.before"]({ tool: name, sessionID, callID: "c" }, { args })
const blocked = (p) => assert.rejects(p, /иероглиф|сбой генерации/i)

test("edit: CJK glued to Cyrillic in a Russian file is refused; no turn-undo backup is made", async () => {
  await ask("ses_admin", "msg_1")
  await blocked(tool("ses_admin", "edit", { filePath: "ru.md", oldString: "Защита диалогов", newString: "Защиту (п丢弃 диалогов)" }))
  assert.equal(fs.existsSync(path.join(UNDO, "ses_admin", "msg_1")), false, "a refused call leaves no backup")
})

test("write: an isolated CJK word in English code is refused (Latin neighbour, tiny share)", async () => {
  const body = "// store.test.js驱动 handleEvent\nexport function seedDialogs(list) {\n  return list.filter(Boolean).map((d) => ({ ...d, seen: true }))\n}\n"
  await blocked(tool("ses_admin", "write", { filePath: "app.js", content: body }))
})

test("write: U+FFFD (broken generation) in new text is refused", async () => {
  await blocked(tool("ses_admin", "write", { filePath: "new.md", content: "Итог: все тесты прошли �� успешно.\n" }))
})

test("multiedit and apply_patch are checked too; patch looks only at added lines", async () => {
  await blocked(tool("ses_admin", "multiedit", { filePath: "ru.md", edits: [{ oldString: "Заметка", newString: "Заметка" }, { oldString: "resync", newString: "resync на这台 машине" }] }))
  const patch = ["*** Begin Patch", "*** Update File: ru.md", "@@", "-Защита диалогов в resync.", "+Защита диалогов с逃生-клагом.", "*** End Patch"].join("\n")
  await blocked(tool("ses_admin", "apply_patch", { patchText: patch }))
  // a removed line with CJK (cleaning a leak up) is fine
  const cleanup = ["*** Begin Patch", "*** Update File: ru.md", "@@", "-Защита п丢弃 диалогов.", "+Защита диалогов.", "*** End Patch"].join("\n")
  await tool("ses_admin", "apply_patch", { patchText: cleanup })
})

test("tenant sessions are guarded the same way", async () => {
  fs.writeFileSync(path.join(ALICE, "note.md"), "Привет\n")
  await blocked(tool("ses_alice", "edit", { filePath: path.join(ALICE, "note.md"), oldString: "Привет", newString: "Привет, 所有 требования追踪ются" }))
})

test("allowed: plain Russian/English, emoji, symbols and fullwidth punctuation-free text", async () => {
  await tool("ses_admin", "edit", { filePath: "ru.md", oldString: "Защита диалогов", newString: "Защита диалогов — готово ✅ (см. «отчёт»)" })
  await tool("ses_admin", "write", { filePath: "app.js", content: "export const greet = (n) => `Hello, ${n}!`\n" })
})

test("allowed: the file already contains CJK (Chinese docs)", async () => {
  await tool("ses_admin", "edit", { filePath: "zh.md", oldString: "这是中文文档。", newString: "这是中文文档。Version 2 发布。" })
})

test("allowed: a deliberate Chinese text (high CJK share) in a new file", async () => {
  await tool("ses_admin", "write", { filePath: "hello-zh.md", content: "# 你好\n\n这是一个用中文写的说明文件，用于测试翻译。\n" })
  // a small i18n entry is mostly CJK too
  await tool("ses_admin", "write", { filePath: "i18n.json", content: '{"hello": "你好世界"}\n' })
})

test("override: the very same refused call repeated in the same session passes; other text is still refused", async () => {
  const args = () => ({ filePath: "ru.md", oldString: "Защита диалогов", newString: "Защита диалогов (термин 日志 — «журнал»)" })
  await blocked(tool("ses_admin2", "edit", args()))
  await tool("ses_admin2", "edit", args())
  await blocked(tool("ses_admin2", "edit", { filePath: "ru.md", oldString: "Защита", newString: "Защита п丢弃" }))
  // the override is per session
  await blocked(tool("ses_admin", "edit", args()))
})

test("non-write tools are never checked", async () => {
  await tool("ses_admin", "grep", { pattern: "丢弃", path: ADMIN_DIR })
  await tool("ses_admin", "read", { filePath: path.join(ADMIN_DIR, "zh.md") })
})
