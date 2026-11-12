// FEAT-16.3 шаг C (v2fix2), п.1: KB-снапшот базы знаний (vault-cache.ts chat.message,
// 1152-1213 + buildSnapshot 277-341) — чистая логика в ops/opencode/plugin-v2/hooks.mjs.
// Зона сессии (admin vs тенант) приходит из sandbox-core zoneOf; снапшот строится
// строго по директории СВОЕЙ сессии, прошлые дайджесты — только той же директории
// (BUG-12.14). Run: node --test ops/opencode/tests/plugin-v2-kbsnapshot.test.mjs
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pv2-kb-"))
const P = (...x) => path.join(ROOT, ...x)
const FWD = (p) => p.replace(/\\/g, "/")
let hooks

before(async () => {
  for (const d of [
    P("vault", "projects"),
    P("vault", "tasks"),
    P("vault", "lessons"),
    P("vault", "sessions"),
    P("tvault", "projects"),
    P("home", "alice", "work"),
    P("data"),
  ])
    fs.mkdirSync(d, { recursive: true })
  // slug директории P("home","alice","work") = "work"
  fs.writeFileSync(P("vault", "projects", "work.md"), "---\ntype: project\n---\n\n# Проект work\n\nТело проектной заметки.\n")
  fs.writeFileSync(P("vault", "tasks", "a.md"), "---\nstatus: active\nproject: work\n---\n\n# Задача А\n")
  fs.writeFileSync(P("vault", "tasks", "b.md"), "---\nstatus: done\nproject: work\n---\n\n# Задача Б (done)\n")
  fs.writeFileSync(P("vault", "tasks", "c.md"), "---\nstatus: active\nproject: other\n---\n\n# Чужая задача\n")
  fs.writeFileSync(P("vault", "lessons", "l1.md"), "---\nstatus: active\narea: test\n---\n\n# Урок один\n")
  fs.writeFileSync(P("vault", "lessons", "l2.md"), "---\nstatus: stale\narea: test\n---\n\n# Урок старый\n")
  fs.writeFileSync(
    P("vault", "sessions", "2026-01-01-ses_prev.md"),
    "---\n_directory: x\ntype: session\nsession: ses_prev\ndirectory: " + FWD(P("home", "alice", "work")).replace(/\\/g, "\\\\") + "\nstatus: active\n---\n\n# Прошлая сессия этой директории\n",
  )
  fs.writeFileSync(
    P("vault", "sessions", "2026-01-02-ses_far.md"),
    "---\ntype: session\nsession: ses_far\ndirectory: D:/somewhere/else\nstatus: active\n---\n\n# Чужая сессия\n",
  )
  fs.writeFileSync(P("tvault", "projects", "work.md"), "---\ntype: project\n---\n\n# Тенантский проект\n")
  fs.writeFileSync(P("data", "users.json"), JSON.stringify({ users: [] }))
  Object.assign(process.env, {
    VAULT_CACHE_ROOT: P("vault"),
    VAULT_CACHE_PROTECT: P("vault"),
    ZAI_TENANT_HOME: P("home"),
    ZAI_TENANT_VAULT: P("tvault"),
    ZAI_USERS_FILE: P("data", "users.json"),
    VAULT_CACHE_LOG: P("vault-cache.log"),
  })
  hooks = await import(pathToFileURL(path.resolve(import.meta.dirname, "..", "plugin-v2", "hooks.mjs")).href)
})
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const DIR = P("home", "alice", "work")
const ADMIN = () => ({ tenant: null, root: FWD(P("vault")), home: FWD(P("home")) })
const TENANT = () => ({ tenant: "alice", root: FWD(P("tvault")), home: FWD(P("home", "alice")) })

test("admin-снапшот: проектная заметка, активные задачи/уроки, прошлые дайджесты той же директории", async () => {
  const s = { id: "ses_k", directory: DIR, title: "Т" }
  const snap = await hooks.buildSnapshot(s, ADMIN())
  assert.ok(snap.startsWith("[obsidian-cache]"))
  assert.ok(snap.includes("## Проектная заметка (projects/work.md)"), "проектная заметка")
  assert.ok(snap.includes("[[a]]"), "активная задача a")
  assert.ok(!snap.includes("[[b]]"), "done-задача не попадает")
  assert.ok(!snap.includes("[[c]]"), "чужая задача не попадает")
  assert.ok(snap.includes("Урок один"), "активный урок")
  assert.ok(!snap.includes("Урок старый"), "stale-урок не попадает")
  assert.ok(snap.includes("sessions/2026-01-01-ses_prev.md"), "прошлый дайджест той же директории")
  assert.ok(!snap.includes("ses_far"), "дайджест чужой директории не попадает (BUG-12.14)")
  assert.ok(snap.includes("Правила кэша:"), "admin rulesLine")
  assert.ok(snap.includes("Вопрос о самом пользователе"), "BUG-169 personal rule")
})

test("тенант-снапшот: правила зоны, без admin-подсказки о создании проектной заметки", async () => {
  const s = { id: "ses_k", directory: DIR, title: "Т" }
  const snap = await hooks.buildSnapshot(s, TENANT())
  assert.ok(snap.includes("Твоя база знаний (Obsidian) — только"), "tenantRules в снапшоте")
  assert.ok(snap.includes("Тенантский проект"), "проектная заметка тенантской зоны")
  assert.ok(!snap.includes("создай её по шаблону"), "подсказка про шаблон — только admin")
})

test("нет vault-зоны (root: null) → снапшот не строится", async () => {
  const s = { id: "ses_k", directory: DIR, title: "Т" }
  assert.equal(await hooks.buildSnapshot(s, { tenant: "x", root: null, home: null }), null)
})

test("снапшот обрезается до SNAPSHOT_MAX_CHARS", async () => {
  const long = "x".repeat(6000)
  fs.writeFileSync(P("vault", "projects", "work.md"), `---\ntype: project\n---\n\n# Проект\n\n${long}\n`)
  const snap = await hooks.buildSnapshot({ id: "ses_k", directory: DIR }, ADMIN())
  assert.ok(snap.length <= hooks.SNAPSHOT_MAX_CHARS + 100, `длина ${snap.length}`)
  assert.ok(snap.includes("снапшот обрезан"))
  fs.writeFileSync(P("vault", "projects", "work.md"), "---\ntype: project\n---\n\n# Проект work\n\nТело проектной заметки.\n")
})

test("kbSplice: модель видит «снапшот --- текст», хранимый текст не трогаем (FEAT-01.32)", () => {
  const m = { type: "user", text: "вопрос", metadata: { kbContext: "SNAP" } }
  hooks.kbSplice(m)
  assert.equal(m.text, "SNAP\n\n---\n\nвопрос")
  assert.equal(m.metadata.kbContext, "SNAP", "metadata остаётся (персистентность)")
})

test("kbSplice: legacy-текст и части без kbContext проходят как есть", () => {
  const legacy = { type: "user", text: "[obsidian-cache] старый", metadata: { kbContext: "SNAP" } }
  hooks.kbSplice(legacy)
  assert.equal(legacy.text, "[obsidian-cache] старый")
  const plain = { type: "user", text: "вопрос" }
  hooks.kbSplice(plain)
  assert.equal(plain.text, "вопрос")
  const other = { type: "assistant", text: "ответ", metadata: { kbContext: "SNAP" } }
  hooks.kbSplice(other)
  assert.equal(other.text, "ответ")
})

test("earlierUserTurns: на admission история содержит только ПРЕДЫДУЩИЕ ходы", () => {
  const history = [
    { info: { id: "m1", role: "user" } },
    { info: { id: "m2", role: "assistant" } },
  ]
  assert.equal(hooks.earlierUserTurns(history, "m3"), true, "второй ход: m1 уже в истории")
  assert.equal(hooks.earlierUserTurns([], "m1"), false, "первое сообщение сессии (admission: в истории пусто)")
})

test("toV1Message: плоские v2-сообщения → форма {info, parts} ядра", () => {
  const user = hooks.toV1Message({ id: "u1", type: "user", text: "привет", metadata: {} })
  assert.equal(user.info.role, "user")
  assert.equal(user.parts[0].type, "text")
  assert.equal(user.parts[0].text, "привет")
  const asst = hooks.toV1Message({ id: "a1", type: "assistant", agent: "build", content: [
    { type: "reasoning", text: "думаю" },
    { type: "tool", name: "edit", state: { input: { path: "D:/w/a/b.txt" } } },
    { type: "text", text: "готово" },
  ] })
  assert.equal(asst.info.role, "assistant")
  const tool = asst.parts.find((p) => p.type === "tool")
  assert.equal(tool.tool, "edit", "v2 name → tool")
  assert.equal(asst.parts.find((p) => p.type === "text").text, "готово")
  const passthrough = hooks.toV1Message({ info: { role: "user", id: "x" }, parts: [] })
  assert.equal(passthrough.info.id, "x")
  const marker = hooks.toV1Message({ id: "i1", type: "idle", outcome: "succeeded" })
  assert.equal(marker.info.role, "idle")
})

test("BUG-193: hiddenSplice — модель видит скрытую подсказку хода (metadata.zaiHidden), хранимый текст не меняется", () => {
  const m = { type: "user", text: "привет", metadata: { zaiHidden: "[ГОЛОС: коротко]" } }
  hooks.hiddenSplice(m)
  assert.equal(m.text, "привет\n\n[ГОЛОС: коротко]")
  assert.equal(m.metadata.zaiHidden, "[ГОЛОС: коротко]")
  const plain = { type: "user", text: "вопрос" }
  hooks.hiddenSplice(plain)
  assert.equal(plain.text, "вопрос")
  const other = { type: "assistant", text: "ответ", metadata: { zaiHidden: "X" } }
  hooks.hiddenSplice(other)
  assert.equal(other.text, "ответ")
  assert.equal(hooks.HIDDEN_KEY, "zaiHidden")
})

// BUG-194: живой 2.2.6 — в hook("context") сообщения в форме запроса к модели:
// {id, role, content:[{type:"text", text}, …]}, БЕЗ metadata. metadata хода
// плагин берёт из своей карты id → metadata (prompt-хук / история сессии).
test("BUG-194: spliceModelMessage — снапшот в начало первого текста, скрытая подсказка в конец", () => {
  const m = { id: "msg_1", role: "user", content: [{ type: "text", text: "вопрос" }, { type: "text", synthetic: true, text: "<system-reminder>slim</system-reminder>" }] }
  hooks.spliceModelMessage(m, { kbContext: "SNAP", zaiHidden: "[ГОЛОС]" })
  assert.equal(m.content[0].text, "SNAP\n\n---\n\nвопрос\n\n[ГОЛОС]")
  assert.equal(m.content[1].text, "<system-reminder>slim</system-reminder>", "чужие synthetic-части не трогаем")
})

test("BUG-194: spliceModelMessage — без metadata, не user, legacy [obsidian-cache], строковый content", () => {
  const a = { id: "a", role: "assistant", content: [{ type: "text", text: "ответ" }] }
  hooks.spliceModelMessage(a, { kbContext: "SNAP" })
  assert.equal(a.content[0].text, "ответ")
  const u = { id: "u", role: "user", content: [{ type: "text", text: "вопрос" }] }
  hooks.spliceModelMessage(u, null)
  assert.equal(u.content[0].text, "вопрос")
  const legacy = { id: "l", role: "user", content: [{ type: "text", text: "[obsidian-cache] старый" }] }
  hooks.spliceModelMessage(legacy, { kbContext: "SNAP" })
  assert.equal(legacy.content[0].text, "[obsidian-cache] старый")
  const str = { id: "s", role: "user", content: "вопрос" }
  hooks.spliceModelMessage(str, { kbContext: "SNAP", zaiHidden: "H" })
  assert.equal(str.content, "SNAP\n\n---\n\nвопрос\n\nH")
  const noText = { id: "f", role: "user", content: [{ type: "file", uri: "data:x" }] }
  hooks.spliceModelMessage(noText, { zaiHidden: "H" })
  assert.deepEqual(noText.content.at(-1), { type: "text", text: "H" }, "нет текста — подсказка отдельной частью")
})

test("BUG-194: metaById — карта id → metadata из сырой истории v2 (после рестарта serve)", () => {
  const map = hooks.metaById([
    { id: "m1", type: "user", text: "q", metadata: { kbContext: "S" } },
    { id: "m2", type: "assistant", content: [] },
    { id: "m3", type: "user", text: "q2" },
  ])
  assert.deepEqual([...map.entries()], [["m1", { kbContext: "S" }]])
})

// BUG-194 (доработка 1.16.3): metadata хода переживает рестарт serve — JSON на сессию
// в папке данных плагина; hook("context") читает её с диска синхронно, БЕЗ ctx.session.context
// (вызов изнутри context-хука вешал ход тенанта на 5 минут).
test("BUG-194: metaStore — запись/чтение карты хода на сессию; чужое id сессии не пишется", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zai-meta-"))
  try {
    const store = hooks.createMetaStore(dir)
    store.save("ses_abc", new Map([["msg_1", { kbContext: "S", zaiHidden: "H", other: 1 }]]))
    const back = store.load("ses_abc")
    assert.deepEqual([...back.entries()], [["msg_1", { kbContext: "S", zaiHidden: "H" }]], "хранится только kbContext/zaiHidden")
    assert.equal(store.load("ses_none").size, 0)
    store.save("../evil", new Map([["m", { kbContext: "x" }]]))
    assert.equal(fs.readdirSync(dir).length, 1, "небезопасный id не пишется")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
