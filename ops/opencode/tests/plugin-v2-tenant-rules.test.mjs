// FEAT-16.3 шаг C (v2fix2), п.2: системные правила тенанта (vault-cache.ts
// experimental.chat.system.transform, 1246-1264; BUG-169 personalRule) в
// ctx.session.hook("context") плагина v2 — вырезание admin-блока _index.md,
// вставка правил зоны и строки рабочей папки чата (FEAT-04.12).
// Run: node --test ops/opencode/tests/plugin-v2-tenant-rules.test.mjs
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pv2-rules-"))
const P = (...x) => path.join(ROOT, ...x)
const FWD = (p) => p.replace(/\\/g, "/")
const sessions = {}
const contexts = {}
const reg = { session: {}, tool: {} }
let cleanup
let hooks

before(async () => {
  for (const d of [P("vault"), P("home", "alice", "work"), P("home", "alice", "chats", "t"), P("admin", "ws"), P("data")])
    fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(P("data", "users.json"), JSON.stringify({ users: [] }))
  Object.assign(process.env, {
    VAULT_CACHE_ROOT: P("vault"),
    VAULT_CACHE_PROTECT: P("vault"),
    ZAI_TENANT_HOME: P("home"),
    ZAI_TENANT_VAULT: P("tvault"),
    ZAI_USERS_FILE: P("data", "users.json"),
    ZAI_TURN_UNDO_ROOT: P("turn-undo"),
    VAULT_CACHE_LOG: P("vault-cache.log"),
    XDG_DATA_HOME: P("xdg-data"), // BUG-194: metaStore плагина — zai-turn-meta внутри
  })
  hooks = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "plugin-v2", "hooks.mjs")).href)
  sessions.ses_t = { id: "ses_t", location: { directory: FWD(P("home", "alice", "work")) } }
  sessions.ses_a = { id: "ses_a", location: { directory: FWD(P("admin", "ws")) } }
  contexts.ses_t = []
  contexts.ses_a = []
  const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "plugin-v2", "index.ts")).href)
  const plugin = mod.default
  cleanup = await plugin.setup({
    session: {
      get: async ({ sessionID }) => sessions[sessionID] ?? null,
      context: async ({ sessionID }) => contexts[sessionID] ?? [],
      hook: async (name, cb) => {
        reg.session[name] = cb
      },
    },
    tool: {
      hook: async (name, cb) => {
        reg.tool[name] = cb
      },
    },
    event: { subscribe: () => (async function* () {})() },
  })
})
after(() => {
  if (typeof cleanup === "function") cleanup()
  fs.rmSync(ROOT, { recursive: true, force: true })
})

const ctxEvent = (sessionID) => ({
  sessionID,
  agent: "orchestrator",
  model: { id: "glm-5.3-flash", providerID: "zai-coding-plan" },
  system: [
    // admin-блок с путём _index.md ИЗ ОКРУЖЕНИЯ (stripAdminRules сверяет с ADMIN_INDEX)
    { type: "text", text: `Instructions from: ${hooks.ADMIN_INDEX.replace(/\//g, "\\")}\n# База знаний агентов (активный кэш)\nПравила admin-зоны.\n` },
    { type: "text", text: "You are a helpful assistant." },
  ],
  messages: [{ type: "user", text: "вопрос пользователя", metadata: { kbContext: "SNAP-ТЕКСТ" } }],
  options: {},
})

test("context тенанта: admin-блок _index.md вырезан, правила зоны добавлены", async () => {
  const ev = ctxEvent("ses_t")
  await reg.session.context(ev)
  assert.ok(!ev.system.some((p) => p.text?.includes("_index.md")), "admin-блок вырезан")
  const joined = ev.system.map((p) => p.text).join("\n")
  assert.ok(joined.includes("Твоя база знаний (Obsidian) — только"), "tenantRules добавлены")
  assert.ok(joined.includes("Вопрос о самом пользователе"), "BUG-169 personal rule")
  assert.ok(ev.system[1]?.text === "You are a helpful assistant.", "чужие блоки не тронуты")
})

test("context тенанта: строка рабочей папки чата (FEAT-04.12, папка существует)", async () => {
  const ev = ctxEvent("ses_t")
  await reg.session.context(ev)
  const joined = ev.system.map((p) => p.text).join("\n")
  assert.ok(joined.includes("Рабочая папка этого чата:"), "строка про рабочую папку")
  const norm = (s) => s.replace(/[\\/]+/g, "/")
  assert.ok(norm(joined).includes(norm(FWD(P("home", "alice", "chats", "t")))), "путь папки чата (path.join даёт смешанные разделители — как в 1.x)")
})

test("context admin: system не изменяется (кроме kb-склейки текста модели)", async () => {
  const ev = ctxEvent("ses_a")
  await reg.session.context(ev)
  const joined = ev.system.map((p) => p.text).join("\n")
  assert.ok(joined.includes("_index.md"), "admin-блок остаётся")
  assert.ok(!joined.includes("Твоя база знаний (Obsidian) — только"), "tenantRules не добавляются")
})

test("kb-склейка в context: модель видит «снапшот --- текст» и у тенанта, и у admin", async () => {
  for (const sid of ["ses_t", "ses_a"]) {
    const ev = ctxEvent(sid)
    await reg.session.context(ev)
    assert.equal(ev.messages[0].text, "SNAP-ТЕКСТ\n\n---\n\nвопрос пользователя", sid)
  }
})

test("BUG-209 (было: one-shot FEAT-03.22): системный текст хода — на каждом шаге хода; снимается следующим ходом без system", async () => {
  await reg.session.prompt({ sessionID: "ses_t", messageID: "msg_p1", prompt: { text: "ход" }, metadata: { system: "Начинай со слова ЗЕБРА." } })
  const ev = ctxEvent("ses_t")
  await reg.session.context(ev)
  assert.ok(ev.system.some((p) => p.text === "Начинай со слова ЗЕБРА."), "шаг 1: применён")
  const ev2 = ctxEvent("ses_t")
  await reg.session.context(ev2)
  assert.ok(ev2.system.some((p) => p.text === "Начинай со слова ЗЕБРА."), "шаг 2 того же хода: тоже применён (живьём context зовётся на каждом шаге)")
  await reg.session.prompt({ sessionID: "ses_t", messageID: "msg_p1b", prompt: { text: "следующий ход" } })
  const ev3 = ctxEvent("ses_t")
  await reg.session.context(ev3)
  assert.ok(!ev3.system.some((p) => p.text === "Начинай со слова ЗЕБРА."), "ход без system — промпт снят")
})

// BUG-194: у живого 2.2.6 в context сообщения {id, role, content[]} без metadata;
// metadata хода — из prompt-хука (карта) или из истории сессии (после рестарта serve).
test("BUG-194: снапшот и скрытая подсказка доходят до модели в живой форме сообщений 2.2.6", async () => {
  await reg.session.prompt({ sessionID: "ses_a", messageID: "msg_k1", prompt: { text: "вопрос" }, metadata: { kbContext: "SNAP-194", zaiHidden: "[ГОЛОС]" } })
  const ev = { ...ctxEvent("ses_a"), messages: [{ id: "msg_k1", role: "user", content: [{ type: "text", text: "вопрос" }] }] }
  await reg.session.context(ev)
  assert.equal(ev.messages[0].content[0].text, "SNAP-194\n\n---\n\nвопрос\n\n[ГОЛОС]")
})

test("BUG-194: после рестарта serve metadata хода — с диска (metaStore), без вызовов opencode из context-хука", async () => {
  // «рестарт»: карты в памяти нет, файл сессии есть (записал прошлый процесс)
  const dir = P("xdg-data", "zai-turn-meta")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "ses_r.json"), JSON.stringify({ msg_old: { kbContext: "SNAP-OLD" } }))
  sessions.ses_r = { id: "ses_r", location: { directory: FWD(P("admin", "ws")) } }
  let calls = 0
  contexts.ses_r = new Proxy([], { get: (t, k) => { calls++; return t[k] } })
  const ev = { ...ctxEvent("ses_r"), messages: [{ id: "msg_old", role: "user", content: [{ type: "text", text: "старый вопрос" }] }, { id: "msg_new", role: "user", content: [{ type: "text", text: "без metadata" }] }] }
  await reg.session.context(ev)
  assert.equal(ev.messages[0].content[0].text, "SNAP-OLD\n\n---\n\nстарый вопрос")
  assert.equal(ev.messages[1].content[0].text, "без metadata")
  assert.equal(calls, 0, "context-хук не читает историю через opencode (вешало ход тенанта)")
})

test("BUG-194: prompt-хук сохраняет metadata хода на диск", async () => {
  await reg.session.prompt({ sessionID: "ses_a", messageID: "msg_disk", prompt: { text: "q" }, metadata: { kbContext: "SNAP-DISK" } })
  const saved = JSON.parse(fs.readFileSync(P("xdg-data", "zai-turn-meta", "ses_a.json"), "utf8"))
  assert.equal(saved.msg_disk.kbContext, "SNAP-DISK")
})
