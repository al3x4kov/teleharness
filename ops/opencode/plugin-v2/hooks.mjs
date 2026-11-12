/**
 * hooks.mjs — чистая логика vault-cache-хуков, НЕ являющаяся песочницей
 * (FEAT-16.3, шаг C v2fix2; источник: ops/opencode/vault-cache.ts, 1.x —
 * только чтение). Песочница (зоны/allowlist/jail/CJK/turn-undo) живёт в
 * ops/opencode/sandbox-core/index.mjs; здесь — база знаний и системные правила:
 *  - KB-снапшот начала сессии (vault-cache.ts buildSnapshot 277-341, FEAT-01.32,
 *    BUG-12.14): проекты/задачи/уроки/прошлые дайджесты СВОЕЙ зоны;
 *  - kb-склейка «снапшот --- текст» для модели (withKbContext 350-355);
 *  - системные правила тенанта (tenantRules/rulesLine, BUG-169 personalRule) и
 *    вырезание admin-блока _index.md (stripAdminRules 459-473);
 *  - строка рабочей папки чата (FEAT-04.12, system.transform 1254-1259);
 *  - дайджест сессии (extractDigest/writeDigest 359-453) и compaction-указатель
 *    (experimental.session.compacting 1383-1400);
 *  - сериализация записи по сессиям (enqueue 926-939).
 *
 * Модуль без зависимостей от plugin-API: только node:fs/path. Корневые
 * константы читаются из env при импорте (как в sandbox-core) — тесты задают
 * env до динамического import. Ошибки не глушатся: адаптер (index.ts) сам
 * решает, что логировать, и никогда не ломает чат.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const env = process.env
export const VAULT = (env.VAULT_CACHE_ROOT || "D:/Obsidian/agents").replace(/\\/g, "/")
export const ADMIN_INDEX = `${VAULT}/_index.md`
export const SNAPSHOT_MAX_CHARS = 3500
const MAX_NOTE_LINES = 260
const MAX_KEEP_LINES = 170
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"])
/** metadata key на user-части/ходе; тот же ключ, что у портала (Э8: персистентен). */
export const KB_CONTEXT_KEY = "kbContext"

// ---------- мелкие утилиты (vault-cache.ts:71-171) ----------

function pad(n) {
  return String(n).padStart(2, "0")
}
export function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function hm(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export function fwd(p) {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "")
}
function lc(p) {
  return p.toLowerCase()
}
function slugOf(dir) {
  const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "default"
  const s = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  return s || "default"
}
function oneLine(s, n) {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}
function tail(s, n) {
  const t = s.trim()
  return t.length > n ? "…" + t.slice(t.length - n) : t
}
export async function readIfExists(p) {
  try {
    return await readFile(p, "utf8")
  } catch {
    return null
  }
}
async function listMd(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md")).sort()
  } catch {
    return []
  }
}
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const out = {}
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":")
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
function headerOf(text) {
  const m = text.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : ""
}
function stripFm(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
}

// ---------- правила зоны (vault-cache.ts:256-275, BUG-169) ----------

export function tenantRules(z) {
  const r = (z.root ?? "").replace(/\//g, "\\")
  return [
    `Твоя база знаний (Obsidian) — только ${r}. Подпапки: projects\\, tasks\\, decisions\\, lessons\\, sessions\\ (создавай при необходимости).`,
    `Дайджест диалога пишется автоматически в ${r}\\sessions — рутину не логируй; задачи/решения/уроки оформляй заметками в своей зоне.`,
    `Другие разделы D:\\Obsidian (в том числе D:\\Obsidian\\agents и зоны других пользователей) тебе недоступны: не читай и не пиши туда.`,
    personalRule(r),
  ].join(" ")
}

/** BUG-169: вопрос о самом пользователе → сначала база знаний (same text as lib/kb-cache.js). */
export function personalRule(root) {
  return `Вопрос о самом пользователе (его вещи, машина, семья, планы, прошлые разговоры и задачи) — сначала поищи в базе знаний ${root} файловыми инструментами (Glob/Grep/Read, не командной строкой): посмотри список заметок, grep по словам вопроса и вероятным названиям, открой подходящие заметки — и только потом отвечай; ничего нет — скажи, что поискал и не нашёл.`
}

export function rulesLine(z) {
  if (z.tenant) return tenantRules(z)
  return `Правила кэша: ${ADMIN_INDEX.replace(/\//g, "\\")}. Дайджест этого диалога пишется автоматически — рутину не логируй; задачи/решения/уроки оформляй заметками по шаблонам. ${personalRule(VAULT.replace(/\//g, "\\"))}`
}

/** FEAT-04.12 stage B: модель знает свою рабочую папку чата (system.transform 1254-1259). */
export function chatDirLine(cd) {
  return (
    `Рабочая папка этого чата: ${cd}. Команды выполняются в ней, относительные пути — от неё: сохраняй результат сюда (рабочие файлы — в _work). ` +
    `Вложения пользователя — .zai-uploads/<имя> (доступны и из этой папки). Папки других чатов пользователя — рядом, в ${path.dirname(cd)}; открывай их, только если пользователь сам попросил.`
  )
}

/**
 * Drop the admin vault rules block ("Instructions from: …/_index.md …") from
 * system texts (vault-cache.ts:459-473); работает по месту, возвращает число
 * правленных блоков.
 */
export function stripAdminRules(system, index = ADMIN_INDEX) {
  const variants = [index, index.replace(/\//g, "\\")].map(lc)
  let n = 0
  for (let i = 0; i < system.length; i++) {
    const s = system[i]
    if (typeof s !== "string" || !variants.some((v) => lc(s).includes(v))) continue
    const re = /Instructions from: ([^\r\n]+)\r?\n[\s\S]*?(?=Instructions from: |$)/g
    const next = s.replace(re, (block, p) => (variants.includes(lc(p.trim())) ? "" : block))
    if (next !== s) {
      system[i] = next
      n++
    }
  }
  return n
}

// ---------- KB-снапшот (vault-cache.ts:277-341) ----------

/**
 * Снапшот базы знаний ЗОНЫ сессии; `s` = {id, directory, title}, `z` = зона из
 * sandbox-core zoneOf. Прошлые дайджесты — только той же директории (BUG-12.14)
 * и не для catch-all домашних директорий.
 */
export async function buildSnapshot(s, z) {
  if (!z.root) return null
  const root = z.root
  const slug = slugOf(s.directory)
  const parts = []
  const who = z.tenant ? `пользователя «${z.tenant}»` : `проекта «${slug}»`
  parts.push(`[obsidian-cache] Активный кэш ${who} (${s.directory}), собран ${ymd()} ${hm()}.`)

  const proj = await readIfExists(`${root}/projects/${slug}.md`)
  if (proj) {
    const body = stripFm(proj).split(/\r?\n/).slice(0, 45).join("\n").trim()
    parts.push(`## Проектная заметка (projects/${slug}.md)\n${body}`)
  } else if (!z.tenant) {
    parts.push(`Проектной заметки projects/${slug}.md нет — если работа над этим репозиторием будет повторяться, создай её по шаблону _templates/project.md.`)
  }

  const tasks = []
  for (const f of await listMd(`${root}/tasks`)) {
    const t = await readIfExists(`${root}/tasks/${f}`)
    if (!t) continue
    const fm = frontmatter(t)
    if (fm.status !== "active" || (fm.project && fm.project !== slug)) continue
    tasks.push(`- [[${f.replace(/\.md$/, "")}]] — ${oneLine(headerOf(t) || fm.status, 90)}`)
    if (tasks.length >= 5) break
  }
  if (tasks.length) parts.push(`## Активные задачи\n${tasks.join("\n")}`)

  const lessons = []
  for (const f of await listMd(`${root}/lessons`)) {
    const t = await readIfExists(`${root}/lessons/${f}`)
    if (!t) continue
    const fm = frontmatter(t)
    if (fm.status !== "active") continue
    lessons.push(`- ${oneLine(headerOf(t), 80)} (area: ${fm.area || "—"})`)
    if (lessons.length >= 10) break
  }
  if (lessons.length) parts.push(`## Уроки (полный текст — grep по lessons/)\n${lessons.join("\n")}`)

  // Pointers only, never content (BUG-12.14), only for the exact same directory.
  const generic = [z.home].filter(Boolean).some((h) => lc(fwd(s.directory)) === lc(fwd(h)))
  if (!generic) {
    const prev = []
    for (const f of (await listMd(`${root}/sessions`)).reverse()) {
      if (f.includes(s.id)) continue
      const t = await readIfExists(`${root}/sessions/${f}`)
      if (!t) continue
      const fm = frontmatter(t)
      if (!fm.directory || lc(fwd(fm.directory)) !== lc(fwd(s.directory))) continue
      prev.push(`- sessions/${f} — ${oneLine(headerOf(t), 80)}`)
      if (prev.length >= 3) break
    }
    if (prev.length)
      parts.push(
        `## Прошлые дайджесты этой директории (другие диалоги, не часть текущего разговора — открывай, только если задача их продолжает)\n${prev.join("\n")}`,
      )
  }

  parts.push(rulesLine(z))

  let out = parts.join("\n\n")
  if (out.length > SNAPSHOT_MAX_CHARS) out = out.slice(0, SNAPSHOT_MAX_CHARS) + "\n…(снапшот обрезан, полные данные в vault)"
  return out
}

// ---------- FEAT-01.32: снапшот видит модель, хранимый текст не меняется ----------

/** Плоское v2-сообщение в context: снапшот из metadata в начало text (копия хода, не история). */
export function kbSplice(m) {
  const snap = m?.metadata?.[KB_CONTEXT_KEY]
  if (m?.type !== "user" || typeof snap !== "string" || !snap || typeof m.text !== "string") return m
  if (m.text.startsWith("[obsidian-cache]")) return m
  m.text = `${snap}\n\n---\n\n${m.text}`
  return m
}

// ---------- BUG-193: скрытая подсказка хода (голосовой режим FEAT-06.2) ----------
// Портал (lib/oc-client.js) кладёт synthetic-части хода в metadata.zaiHidden,
// чтобы они не попали в видимое сообщение пользователя. Модель видит
// «текст + подсказка» только в исходящем запросе — история не меняется.
export const HIDDEN_KEY = "zaiHidden"

/** Плоское v2-сообщение в context: скрытая подсказка из metadata — в конец text. */
export function hiddenSplice(m) {
  const hidden = m?.metadata?.[HIDDEN_KEY]
  if (m?.type !== "user" || typeof hidden !== "string" || !hidden || typeof m.text !== "string") return m
  m.text = `${m.text}\n\n${hidden}`
  return m
}

// ---------- BUG-194: форма сообщений в hook("context") у живого 2.2.6 ----------
// {id, role: "user"|"assistant", content: [{type: "text", text, synthetic?}, …] | string}
// — без metadata. Её плагин берёт из карты id → metadata (prompt-хук хода или
// сырая история сессии после рестарта serve).

/** Карта id user-сообщения → metadata с kbContext/zaiHidden из сырой истории v2. */
export function metaById(raw) {
  const map = new Map()
  for (const m of raw ?? []) {
    const md = m?.metadata
    if (m?.id && m?.type === "user" && md && typeof md === "object" && (typeof md[KB_CONTEXT_KEY] === "string" || typeof md[HIDDEN_KEY] === "string")) map.set(m.id, md)
  }
  return map
}

/** Сообщение запроса к модели: снапшот — в начало первого текста, подсказка — в конец. */
export function spliceModelMessage(m, md) {
  if (!m || m.role !== "user" || !md || typeof md !== "object") return m
  const snap = typeof md[KB_CONTEXT_KEY] === "string" && md[KB_CONTEXT_KEY] ? md[KB_CONTEXT_KEY] : null
  const hidden = typeof md[HIDDEN_KEY] === "string" && md[HIDDEN_KEY] ? md[HIDDEN_KEY] : null
  if (!snap && !hidden) return m
  const wrap = (t) => {
    let out = t
    if (snap && !out.startsWith("[obsidian-cache]")) out = `${snap}\n\n---\n\n${out}`
    if (hidden) out = `${out}\n\n${hidden}`
    return out
  }
  if (typeof m.content === "string") {
    m.content = wrap(m.content)
    return m
  }
  if (!Array.isArray(m.content)) return m
  const first = m.content.find((p) => p && p.type === "text" && typeof p.text === "string" && !p.synthetic)
  if (first) first.text = wrap(first.text)
  else if (hidden) m.content.push({ type: "text", text: hidden })
  return m
}

/**
 * BUG-194: хранилище metadata ходов (kbContext/zaiHidden) на диске — JSON на сессию.
 * Переживает рестарт serve; читается синхронно — из hook("context") нельзя звать
 * ctx.session.context (вызов изнутри сборки контекста вешал ход тенанта).
 */
export function createMetaStore(dir) {
  const SAFE = /^[A-Za-z0-9_-]{1,128}$/
  const file = (sid) => (SAFE.test(String(sid)) ? path.join(dir, `${sid}.json`) : null)
  const keep = (md) => {
    const out = {}
    if (typeof md?.[KB_CONTEXT_KEY] === "string" && md[KB_CONTEXT_KEY]) out[KB_CONTEXT_KEY] = md[KB_CONTEXT_KEY]
    if (typeof md?.[HIDDEN_KEY] === "string" && md[HIDDEN_KEY]) out[HIDDEN_KEY] = md[HIDDEN_KEY]
    return out
  }
  return {
    load(sid) {
      const f = file(sid)
      if (!f) return new Map()
      try {
        const obj = JSON.parse(readFileSync(f, "utf8"))
        return new Map(Object.entries(obj ?? {}).map(([k, v]) => [k, keep(v)]))
      } catch {
        return new Map()
      }
    },
    save(sid, map) {
      const f = file(sid)
      if (!f) return false
      try {
        mkdirSync(dir, { recursive: true })
        const obj = {}
        for (const [k, v] of map ?? []) {
          const kv = keep(v)
          if (Object.keys(kv).length) obj[k] = kv
        }
        writeFileSync(f, JSON.stringify(obj))
        return true
      } catch {
        return false
      }
    },
  }
}

/** Первый ли это ход сессии: есть ли user-сообщения кроме текущего. */
export function earlierUserTurns(msgs, excludeId) {
  return (msgs ?? []).some((m) => m?.info?.role === "user" && m.info.id !== excludeId)
}

/** основная сессия диалога (не субагент и не внутренний title/summary/compaction) */
export function isPrimary(s, msgs) {
  if (!s) return false
  if (s.parentID) return false
  const firstUser = (msgs ?? []).find((m) => m?.info?.role === "user")
  if (firstUser?.info.agent && INTERNAL_AGENTS.has(firstUser.info.agent)) return false
  return true
}

// ---------- формы сообщений: плоское v2 → {info, parts} ядра ----------

/**
 * v2 history/context отдаёт плоские записи ({type:"user", text} /
 * {type:"assistant", content:[…], agent}); v1-форма ядра — {info, parts}.
 * Маркеры (idle, model-switched) проходят с role=type и отфильтровываются
 * потребителями (extractDigest/isPrimary смотрят только user/assistant).
 */
export function toV1Message(m) {
  if (m && m.info) return m
  const role = m?.info?.role ?? (m?.type === "user" ? "user" : m?.type === "assistant" ? "assistant" : (m?.type ?? ""))
  const info = { id: m?.id, role, ...(m?.agent ? { agent: m.agent } : {}), ...(m?.parentID ? { parentID: m.parentID } : {}), time: m?.time }
  let parts
  if (role === "assistant" && Array.isArray(m?.content)) {
    parts = m.content.map((c) => (c && typeof c === "object" ? { ...c, tool: c.tool ?? c.name } : c))
  } else if (role === "user" || typeof m?.text === "string") {
    parts = [{ type: "text", text: m?.text ?? "", synthetic: false }]
  } else {
    parts = []
  }
  return { info, parts }
}

// ---------- дайджест сессии (vault-cache.ts:359-453) ----------

export function extractDigest(msgs) {
  const list = msgs ?? []
  const userMsgs = list.filter((m) => m?.info?.role === "user")
  const asstMsgs = list.filter((m) => m?.info?.role === "assistant")
  if (!userMsgs.length) return null

  const lastUser = userMsgs[userMsgs.length - 1]
  let askText = (lastUser.parts ?? [])
    .filter((p) => p.type === "text" && !p.synthetic && p.text)
    .map((p) => p.text)
    .join(" ")
  // убрать инъецированный снапшот [obsidian-cache] ... --- из текста запроса
  if (askText.includes("[obsidian-cache]")) {
    const segs = askText.split("\n---\n")
    askText = segs[segs.length - 1]
  }
  if (!askText.trim() && !asstMsgs.length) return null

  const files = new Set()
  let toolCalls = 0
  for (const m of list) {
    for (const p of m.parts ?? []) {
      if (p.type !== "tool") continue
      toolCalls++
      const tool = p.tool ?? ""
      const input = p.state?.input ?? {}
      const fp = input.filePath ?? input.file_path ?? input.path
      if (fp && ["edit", "write"].includes(tool)) {
        files.add(String(fp).replace(/\\/g, "/").split("/").slice(-2).join("/"))
      }
    }
  }

  let outcome = ""
  if (asstMsgs.length) {
    const last = asstMsgs[asstMsgs.length - 1]
    outcome = (last.parts ?? [])
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n")
  }

  return { ask: oneLine(askText, 140), files: [...files].slice(0, 10), toolCalls, outcome: tail(outcome, 700) }
}

export function digestFile(root, sessionID) {
  return `${root}/sessions/${ymd()}-${sessionID}.md`
}

export async function writeDigest(s, z, d) {
  if (!z.root) return
  const slug = slugOf(s.directory)
  const file = digestFile(z.root, s.id)
  await mkdir(`${z.root}/sessions`, { recursive: true })

  const filesLine = d.files.length
    ? `Файлы (${d.files.length}): ${d.files.map((f) => "`" + f + "`").join(", ")} · инструментов: ${d.toolCalls}`
    : `Файлы: — · инструментов: ${d.toolCalls}`
  const entry = [
    "",
    `## ${hm()} — ${d.ask || "(без текста)"}`,
    `- ${filesLine}`,
    d.outcome ? `- Итог: ${d.outcome.replace(/\n+/g, " ⏎ ").trim()}` : "- Итог: (пусто)",
  ].join("\n")

  const prev = await readIfExists(file)
  if (!prev) {
    const fm = [
      "---",
      "type: session",
      `project: ${slug}`,
      ...(z.tenant ? [`tenant: ${z.tenant}`] : []),
      `session: ${s.id}`,
      `directory: ${s.directory}`,
      "status: active",
      `created: ${ymd()}`,
      `updated: ${ymd()}`,
      "---",
      "",
      `# Сессия ${ymd()} — ${oneLine(s.title || slug, 80)}`,
      "",
    ].join("\n")
    await writeFile(file, fm + "\n" + entry.slice(1) + "\n", "utf8")
    return
  }

  let next = prev.replace(/^updated:.*$/m, `updated: ${ymd()}`) + entry + "\n"
  const lines = next.split(/\r?\n/)
  if (lines.length > MAX_NOTE_LINES) {
    const headEnd = lines.findIndex((l) => l.startsWith("# "))
    const head = lines.slice(0, Math.max(headEnd + 1, 1))
    const kept = lines.slice(-MAX_KEEP_LINES)
    next = [...head, "<!-- старые записи обрезаны плагином -->", ...kept].join("\n")
  }
  await writeFile(file, next, "utf8")
}

// ---------- compaction-указатель (vault-cache.ts:1383-1400) ----------

/** Ссылка на дайджест сессии для компакции; дайджеста нет → null. */
export function compactionNote(z, sessionID, prev) {
  if (!z.root || !prev) return null
  const file = digestFile(z.root, sessionID)
  return z.tenant
    ? `Активный кэш этой сессии: ${file}. При компакции сохрани ссылки на заметки из своей зоны ${z.root}.`
    : `Активный кэш этой сессии: ${file}. Ключевые файлы и итоги ходов там; при компакции сохрани ссылки на задачи/решения/уроки из ${VAULT.replace(/\//g, "\\")}\\, упомянутые в диалоге.`
}

// ---------- сериализация записи по сессиям (vault-cache.ts:926-939) ----------

const queues = new Map()
export function enqueue(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve()
  const p = prev.then(fn, fn)
  const t = p.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, t)
  t.then(() => {
    if (queues.get(key) === t) queues.delete(key)
  })
  return p
}
