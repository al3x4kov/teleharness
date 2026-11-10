/**
 * vault-cache — Obsidian как активный кэш opencode (сервер 192.168.0.10).
 *
 * Жизненный цикл, полностью нативный (без команд пользователя):
 *  1. Начало сессии: chat.message на первом сообщении → снапшот базы знаний
 *     ЗОНЫ сессии ([obsidian-cache] …) кладётся в metadata.kbContext текстовой
 *     части; текст пользователя не меняется (FEAT-01.32, 2026-11-04). Модель
 *     получает «снапшот --- текст» через experimental.chat.messages.transform.
 *  2. В течение диалога: агент сам читает/пишет заметки по правилам из
 *     D:\Obsidian\agents\_index.md (admin) или по правилам своей tenant-зоны.
 *  3. Конец итерации: событие session.idle → в <зона>/sessions/<дата>-<id>.md
 *     автоматически дописывается компактный дайджест хода.
 *  4. Компакция: experimental.session.compacting → контекст-указатель на
 *     дайджест, чтобы связь с кэшем не терялась в длинных сессиях.
 *  5. «Отменить ход» (BUG-146 / FEAT-01.58): tool.execute.before перед правкой
 *     write/edit/multiedit/patch/apply_patch копирует первое состояние файла
 *     хода в <ZAI_TURN_UNDO_ROOT | dirname(users.json)/turn-undo>/<сессия>/<вопрос>/;
 *     откат делает портал (lib/turn-undo.js).
 *  6. Shell тенанта (FEAT-04.9): tool.execute.before переписывает команду bash
 *     тенанта в вызов ops/sandbox/zai-jail.exe — Windows AppContainer тенанта
 *     (cmd.exe, Python D:\zai-sandbox\python); без запускателя — отказ.
 *  7. Скиллы и marketplace тенанта (FEAT-04.10): `skill` — только zai-*,
 *     MCP marketplace_* (кроме compare_browser_snapshot) — разрешены.
 *  8. Страж CJK (BUG-180): write/edit/multiedit/patch с изолированными
 *     иероглифами или U+FFFD в не-CJK тексте отклоняется (сбой GLM-5.3-Flash);
 *     намеренный китайский текст и повтор того же вызова проходят.
 *
 * Зоны (2026-11-02, FEAT-12.15 / BUG-12.14):
 *  - admin (любая директория вне тенантов): VAULT_CACHE_ROOT (по умолчанию D:/Obsidian/agents);
 *  - тенант (директория сессии входит в directories пользователя из users.json портала
 *    или лежит под ZAI_TENANT_HOME/<имя>): только его obsidianRoot
 *    (по умолчанию ZAI_TENANT_VAULT/<имя>). Снапшот читается и дайджест пишется
 *    только там; правила admin (_index.md) из system-промпта тенанта убираются;
 *    инструменты тенанта не могут адресовать vault вне его зоны (best effort,
 *    не OS-изоляция — см. BUG-12.5).
 *  - снапшот строится строго по директории СВОЕЙ сессии и только на первом
 *    сообщении (проверка по истории, а не только по in-memory Set — после рестарта
 *    serve старые сессии повторно не получают снапшот); содержимое чужих
 *    дайджестов в снапшот больше не попадает (источник BUG-12.14: все чаты в
 *    C:\Users\USER имели slug «user» и получали хвост последнего ЧУЖОГО дайджеста).
 *
 * Плагин никогда не ломает чат: любая ошибка пишется в лог (кроме намеренной
 * блокировки инструмента тенанта).
 */
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { appendFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs"
import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import os from "node:os"
import path from "node:path"

const env = process.env
// Portable defaults under the user's home (the same as the portal's lib/config.js:
// ZAI_TENANT_HOME = ~/.zai-tenants, ZAI_TENANT_VAULT = ~/.zai/tenants-vault).
const USER_HOME = fwd(os.homedir())
const VAULT = fwd(env.VAULT_CACHE_ROOT || `${USER_HOME}/.zai/kb`)
const LOG = env.VAULT_CACHE_LOG || `${USER_HOME}/.config/opencode/vault-cache.log`
const TENANT_HOME = fwd(env.ZAI_TENANT_HOME || `${USER_HOME}/.zai-tenants`)
const TENANT_VAULT = fwd(env.ZAI_TENANT_VAULT || `${USER_HOME}/.zai/tenants-vault`)
// The portal's <ZAI_DATA_DIR>/users.json — set ZAI_USERS_FILE for opencode serve.
const USERS_FILE = env.ZAI_USERS_FILE || "D:/Portal/zai/data/users.json"
// Everything under these roots is off-limits for tenant tools, except the tenant's own zone.
const PROTECTED_ROOTS = [fwd(env.VAULT_CACHE_PROTECT || `${USER_HOME}/.zai`), VAULT, TENANT_VAULT]
const ADMIN_INDEX = `${VAULT}/_index.md`
const HOME = fwd(os.homedir())
const MAX_NOTE_LINES = 260
const MAX_KEEP_LINES = 170
const SNAPSHOT_MAX_CHARS = 3500
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"])

// ---------- мелкие утилиты ----------

function pad(n: number) {
  return String(n).padStart(2, "0")
}
function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function hm(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** normalized forward-slash absolute path without trailing slash */
function fwd(p: string) {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "")
}
function lc(p: string) {
  return p.toLowerCase()
}
/** true if `p` equals `root` or lies inside it (case-insensitive, Windows) */
// ---------- FEAT-04.12 stage B: a working folder per tenant chat ----------
//
// The portal (lib/chat-folder.js) creates <tenant>\chats\<session id without ses_>
// for every NEW tenant chat; the session directory stays the tenant root (one
// opencode instance + one set of MCP processes per tenant, not per chat). Its
// presence switches the chat: bash without workdir runs there, relative file
// paths and searches resolve there. Old chats (no folder) keep the root.
const CHAT_ID = /^ses_([A-Za-z0-9]{1,64})$/
function chatFolderOf(home: string | null, sessionID: string | null): string | null {
  const m = CHAT_ID.exec(String(sessionID ?? ""))
  if (!home || !m) return null
  const dir = path.join(home, "chats", m[1])
  try {
    const st = lstatSync(dir)
    return st.isDirectory() && !st.isSymbolicLink() ? dir : null
  } catch {
    return null
  }
}
const isAbs = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)
const SEARCH_TOOLS = new Set(["glob", "grep", "list"])
/** Relative paths of a tenant tool call → the chat folder (args are rewritten in place). */
function pointToChat(tool: string, args: any, chatDir: string): void {
  if (!args || typeof args !== "object") return
  const rel = (p: unknown) => (typeof p === "string" && p && !isAbs(p) ? path.resolve(chatDir, p) : p)
  for (const k of ["filePath", "file_path"]) if (typeof args[k] === "string") args[k] = rel(args[k])
  if (tool === "bash") args.workdir = typeof args.workdir === "string" && args.workdir ? rel(args.workdir) : chatDir
  if (SEARCH_TOOLS.has(tool)) args.path = typeof args.path === "string" && args.path ? rel(args.path) : chatDir
}

function within(p: string, root: string) {
  const a = lc(fwd(p))
  const b = lc(fwd(root))
  return a === b || a.startsWith(b + "/")
}
function slugOf(dir: string) {
  const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "default"
  const s = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  return s || "default"
}
function oneLine(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}
function tail(s: string, n: number) {
  const t = s.trim()
  return t.length > n ? "…" + t.slice(t.length - n) : t
}
async function log(msg: string) {
  try {
    await appendFile(LOG, `${new Date().toISOString()} ${msg}\n`, "utf8")
  } catch {}
}
async function readIfExists(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8")
  } catch {
    return null
  }
}
async function listMd(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md")).sort()
  } catch {
    return []
  }
}
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":")
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
function headerOf(text: string): string {
  const m = text.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : ""
}
function stripFm(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
}

// ---------- зона vault по директории сессии ----------

/** tenant = null → admin zone; root = null → no vault for this session at all */
type Zone = { tenant: string | null; root: string | null; home: string | null }

type TenantRec = { name: string; dirs: string[]; root: string | null }
let usersCache: { at: number; list: TenantRec[] } = { at: 0, list: [] }

async function tenantsFromPortal(): Promise<TenantRec[]> {
  if (Date.now() - usersCache.at < 10_000) return usersCache.list
  const list: TenantRec[] = []
  try {
    const raw = JSON.parse((await readIfExists(USERS_FILE)) ?? "{}")
    for (const u of Array.isArray(raw?.users) ? raw.users : []) {
      if (!u || u.role === "admin" || !Array.isArray(u.directories) || !u.directories.length) continue
      const root = u.obsidianRoot || (Array.isArray(u.extraRoots) && u.extraRoots[0]) || null
      list.push({ name: String(u.name || u.id), dirs: u.directories.map((d: string) => fwd(d)), root: root ? fwd(root) : null })
    }
  } catch (e) {
    // keep the last good list: a transient read error must not turn tenants into admins
    await log(`users.json read error (${USERS_FILE}): ${String(e)}`)
    usersCache = { at: Date.now(), list: usersCache.list }
    return usersCache.list
  }
  usersCache = { at: Date.now(), list }
  return list
}

const SAFE_NAME = /^[^\\/:*?"<>|.][^\\/:*?"<>|]*$/

async function zoneOf(dir: string): Promise<Zone> {
  const d = fwd(dir || HOME)
  // 1) explicit tenant scope from the portal (directories → obsidianRoot)
  for (const t of await tenantsFromPortal()) {
    const hit = t.dirs.find((x) => within(d, x))
    if (hit) return { tenant: t.name, root: t.root ?? (SAFE_NAME.test(t.name) ? `${TENANT_VAULT}/${t.name}` : null), home: hit }
  }
  // 2) default tenant layout: ZAI_TENANT_HOME/<name>/… → ZAI_TENANT_VAULT/<name>
  if (within(d, TENANT_HOME)) {
    const name = d.slice(TENANT_HOME.length + 1).split("/")[0] ?? ""
    if (!name || !SAFE_NAME.test(name)) return { tenant: name || "?", root: null, home: null }
    return { tenant: name, root: `${TENANT_VAULT}/${name}`, home: `${TENANT_HOME}/${name}` }
  }
  return { tenant: null, root: VAULT, home: HOME }
}

// ---------- сессия: фильтры ----------

type Sess = { id: string; directory: string; parentID?: string; title: string }

async function getSession(client: PluginInput["client"], id: string): Promise<Sess | null> {
  try {
    const res = await client.session.get({ path: { id } })
    const d = (res as { data?: unknown }).data as Sess | undefined
    return d ?? null
  } catch {
    return null
  }
}

type MsgItem = { info: { id: string; role: string; agent?: string; time: { created: number } }; parts: any[] }

async function getMessages(client: PluginInput["client"], id: string): Promise<MsgItem[]> {
  try {
    const res = await client.session.messages({ path: { id } })
    const d = (res as { data?: unknown }).data as MsgItem[] | undefined
    return d ?? []
  } catch {
    return []
  }
}

/** основная сессия диалога (не субагент и не внутренний title/summary/compaction) */
function isPrimary(s: Sess | null, msgs: MsgItem[]): boolean {
  if (!s) return false
  if (s.parentID) return false
  const firstUser = msgs.find((m) => m.info.role === "user")
  if (firstUser?.info.agent && INTERNAL_AGENTS.has(firstUser.info.agent)) return false
  return true
}

// ---------- снапшот на начало сессии ----------

function tenantRules(z: Zone): string {
  const r = (z.root ?? "").replace(/\//g, "\\")
  return [
    `Твоя база знаний (Obsidian) — только ${r}. Подпапки: projects\\, tasks\\, decisions\\, lessons\\, sessions\\ (создавай при необходимости).`,
    `Дайджест диалога пишется автоматически в ${r}\\sessions — рутину не логируй; задачи/решения/уроки оформляй заметками в своей зоне.`,
    `Другие разделы D:\\Obsidian (в том числе D:\\Obsidian\\agents и зоны других пользователей) тебе недоступны: не читай и не пиши туда.`,
    personalRule(r),
  ].join(" ")
}

// BUG-169 (BUG-01.67): a question about the user himself → search the knowledge
// base first (same text as lib/kb-cache.js personalRule).
function personalRule(root: string): string {
  return `Вопрос о самом пользователе (его вещи, машина, семья, планы, прошлые разговоры и задачи) — сначала поищи в базе знаний ${root} файловыми инструментами (Glob/Grep/Read, не командной строкой): посмотри список заметок, grep по словам вопроса и вероятным названиям, открой подходящие заметки — и только потом отвечай; ничего нет — скажи, что поискал и не нашёл.`
}

function rulesLine(z: Zone): string {
  if (z.tenant) return tenantRules(z)
  return `Правила кэша: ${ADMIN_INDEX.replace(/\//g, "\\")}. Дайджест этого диалога пишется автоматически — рутину не логируй; задачи/решения/уроки оформляй заметками по шаблонам. ${personalRule(VAULT.replace(/\//g, "\\"))}`
}

async function buildSnapshot(s: Sess, z: Zone): Promise<string | null> {
  if (!z.root) return null
  const root = z.root
  const slug = slugOf(s.directory)
  const parts: string[] = []
  const who = z.tenant ? `пользователя «${z.tenant}»` : `проекта «${slug}»`
  parts.push(`[obsidian-cache] Активный кэш ${who} (${s.directory}), собран ${ymd()} ${hm()}.`)

  const proj = await readIfExists(`${root}/projects/${slug}.md`)
  if (proj) {
    const body = stripFm(proj).split(/\r?\n/).slice(0, 45).join("\n").trim()
    parts.push(`## Проектная заметка (projects/${slug}.md)\n${body}`)
  } else if (!z.tenant) {
    parts.push(`Проектной заметки projects/${slug}.md нет — если работа над этим репозиторием будет повторяться, создай её по шаблону _templates/project.md.`)
  }

  const tasks: string[] = []
  for (const f of await listMd(`${root}/tasks`)) {
    const t = await readIfExists(`${root}/tasks/${f}`)
    if (!t) continue
    const fm = frontmatter(t)
    if (fm.status !== "active" || (fm.project && fm.project !== slug)) continue
    tasks.push(`- [[${f.replace(/\.md$/, "")}]] — ${oneLine(headerOf(t) || fm.status, 90)}`)
    if (tasks.length >= 5) break
  }
  if (tasks.length) parts.push(`## Активные задачи\n${tasks.join("\n")}`)

  const lessons: string[] = []
  for (const f of await listMd(`${root}/lessons`)) {
    const t = await readIfExists(`${root}/lessons/${f}`)
    if (!t) continue
    const fm = frontmatter(t)
    if (fm.status !== "active") continue
    lessons.push(`- ${oneLine(headerOf(t), 80)} (area: ${fm.area || "—"})`)
    if (lessons.length >= 10) break
  }
  if (lessons.length) parts.push(`## Уроки (полный текст — grep по lessons/)\n${lessons.join("\n")}`)

  // Earlier digests: pointers only (never their content — that was BUG-12.14),
  // only for the exact same directory, and not for catch-all home dirs where
  // every unrelated chat lives.
  const generic = [HOME, z.home ?? HOME].some((h) => lc(fwd(s.directory)) === lc(fwd(h)))
  if (!generic) {
    const prev: string[] = []
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

// ---------- FEAT-01.32: снапшот рядом с текстом, а не в нём ----------

/** metadata key on the user text part; same key as the portal (shared/title.js, lib/kb-cache.js).
 * NOT exported: opencode calls every export of a plugin module as a plugin. */
const KB_CONTEXT_KEY = "kbContext"

/** the part as the model must see it: snapshot + separator + typed text */
function withKbContext(p: any): any {
  const snap = p?.metadata?.[KB_CONTEXT_KEY]
  if (p?.type !== "text" || typeof snap !== "string" || !snap || typeof p.text !== "string") return p
  if (p.text.startsWith("[obsidian-cache]")) return p
  return { ...p, text: `${snap}\n\n---\n\n${p.text}` }
}

// ---------- дайджест на session.idle ----------

function extractDigest(msgs: MsgItem[]): { ask: string; files: string[]; toolCalls: number; outcome: string } | null {
  const userMsgs = msgs.filter((m) => m.info.role === "user")
  const asstMsgs = msgs.filter((m) => m.info.role === "assistant")
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

  const files = new Set<string>()
  let toolCalls = 0
  for (const m of msgs) {
    for (const p of m.parts ?? []) {
      if (p.type !== "tool") continue
      toolCalls++
      const tool: string = p.tool ?? ""
      const input = (p.state as { input?: Record<string, unknown> } | undefined)?.input ?? {}
      const fp = (input.filePath ?? input.file_path ?? input.path) as string | undefined
      if (fp && (tool === "edit" || tool === "write")) {
        files.add(fp.replace(/\\/g, "/").split("/").slice(-2).join("/"))
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

function digestFile(root: string, sessionID: string) {
  return `${root}/sessions/${ymd()}-${sessionID}.md`
}

async function writeDigest(s: Sess, z: Zone, d: { ask: string; files: string[]; toolCalls: number; outcome: string }) {
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

// ---------- tenant guards: system prompt and tools ----------

/** Drop the admin vault rules block ("Instructions from: …/_index.md …") from system parts. */
// NB: not exported — opencode treats every module export as a plugin factory.
function stripAdminRules(system: string[], index = ADMIN_INDEX): number {
  const variants = [index, index.replace(/\//g, "\\")].map(lc)
  let n = 0
  for (let i = 0; i < system.length; i++) {
    const s = system[i]
    if (typeof s !== "string" || !variants.some((v) => lc(s).includes(v))) continue
    const re = /Instructions from: ([^\r\n]+)\r?\n[\s\S]*?(?=Instructions from: |$)/g
    const next = s.replace(re, (block, p: string) => (variants.includes(lc(p.trim())) ? "" : block))
    if (next !== s) {
      system[i] = next
      n++
    }
  }
  return n
}

const PATH_KEYS = ["filePath", "file_path", "path", "paths", "pattern", "include", "workdir", "cwd", "directory", "dir", "target", "source", "destination"]
const ABS_IN_TEXT = /[a-zA-Z]:[\\/]+[^\s"'`;|&<>()]*/g

/** Paths a tool call may touch that fall into the protected vault outside the tenant's zone. */
function forbiddenPaths(args: any, z: Zone, cwd: string): string[] {
  const bad: string[] = []
  const check = (p: string) => {
    if (!p || typeof p !== "string") return
    const abs = /^[a-zA-Z]:/.test(p) ? p : path.resolve(cwd, p)
    if (!PROTECTED_ROOTS.some((r) => within(abs, r))) return
    if (z.root && within(abs, z.root)) return
    bad.push(p)
  }
  const scanText = (t: string) => {
    for (const m of t.match(ABS_IN_TEXT) ?? []) check(m)
    // relative escapes towards the vault, e.g. ..\..\Obsidian\agents
    if (/\.\.[\\/][\s\S]*obsidian/i.test(t)) bad.push("…/Obsidian (относительный путь)")
  }
  if (!args || typeof args !== "object") return bad
  for (const k of PATH_KEYS) {
    const v = args[k]
    if (typeof v === "string") check(v)
    else if (Array.isArray(v)) v.forEach((x) => typeof x === "string" && check(x))
  }
  for (const k of ["command", "script", "patchText", "patch"]) if (typeof args[k] === "string") scanText(args[k])
  return [...new Set(bad)]
}

// ---------- tenant sandbox (2026-11-04, BUG-12.5 hardening) ----------
//
// Server-side boundary for tenant sessions (and their subagents), independent
// of the agent the portal picked and of what the model decides to do:
//  1. tool allowlist — no subagents/delegation, no MCP except public doc/code
//     search and read-only marketplace search, no LSP, no session/history tools;
//     `bash` only through the AppContainer launcher zai-jail (FEAT-04.9, see
//     jailCommand); `skill` only for the tenant set zai-* (FEAT-04.10);
//  2. every path a tool touches must resolve (realpath of the deepest existing
//     ancestor — junctions/symlinks included) inside the session directory or
//     the tenant's own vault zone;
//  3. no writes to files opencode/OmO/claude load as configuration or code
//     (.opencode, opencode.json(c), .omo, .claude): a planted project plugin
//     would run with the owner's rights on the next instance load;
//  4. webfetch only to public http(s) hosts: the opencode API (:4096/:4097),
//     the portal (:4170) and the LAN are not reachable from a tenant chat.
// Fail-closed: if the zone of a session cannot be determined, the tool is refused.

const TENANT_TOOLS = new Set([
  "bash", // FEAT-04.9: runs only through zai-jail (jailCommand below), never on the host
  "read", "glob", "grep", "list",
  "edit", "write", "multiedit", "apply_patch", "patch",
  "todowrite", "todoread", "question", "invalid",
  "webfetch", "websearch", "codesearch",
  "look_at",
])
// OmO built-in remote MCPs: public web/doc search only, no local access
// (stand 2026-11-04: context7_resolve-library-id, context7_query-docs, grep_app_searchGitHub).
// FEAT-04.10: MCP `marketplace` (ru-marketplace-mcp 2.7.0) — read-only storefront search;
// opencode names its tools `marketplace_<tool>`: marketplace_wb_search, marketplace_ozon_search,
// marketplace_yandex_search, marketplace_compare_prices, marketplace_wb_card, …
const TENANT_TOOL_PREFIXES = ["websearch_", "context7_", "grep_app_", "marketplace_"]
// compare_browser_snapshot returns a screenshot of a page retained in the owner's
// logged-in browser (Ozon via CDP); its handoff scope is the MCP client, which
// opencode shares between all sessions — not for tenants.
const TENANT_TOOL_DENY = new Set(["marketplace_compare_browser_snapshot"])
// FEAT-04.10: the `skill` tool (opencode's and OmO's — both take `name`; OmO strips a
// leading "/" and matches case-insensitively) loads only the tenant skill set zai-*
// (ops/opencode/skills). Admin skills (dogfood, …) and OmO commands are refused.
const TENANT_SKILL = /^zai-[a-z0-9][a-z0-9-]{0,40}$/i
const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "patch"])
const CONFIG_DIRS = new Set([".opencode", ".omo", ".claude", ".agents"])
const CONFIG_FILES = new Set(["opencode.json", "opencode.jsonc", ".mcp.json"])

// ---------- BUG-180: CJK leak guard for write tools ----------
// GLM-5.3-Flash sometimes drops isolated CJK words or U+FFFD into Russian/English
// text (zai-org/GLM-5#142; e.g. a stray CJK word in the middle of a Russian phrase).
// A write tool call whose NEW text carries such a fragment is refused, so the
// model rewrites it. Deliberate CJK passes: CJK ≥ 20 % of the letters of the new
// text, the target file already has CJK, or the model repeats the very same
// refused call in the same session (the refusal message says so).
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/
const CJK_ALL = new RegExp(CJK_CHAR.source, "g")
const CJK_NEXT_TO_CYR = new RegExp(`[\\u0400-\\u04ff]${CJK_CHAR.source}|${CJK_CHAR.source}[\\u0400-\\u04ff]`)
const CJK_MIN_SHARE = 0.2
const CJK_READ_MAX = 2 * 1024 * 1024
const cjkOverrides = new Map<string, Set<string>>() // sessionID → hashes of refused calls

// ---------- BUG-180: reasoning effort of GLM-5.3* ----------
// oh-my-openagent ≤ 5.1.62 (HEURISTIC_MODEL_FAMILY_REGISTRY, family "glm") still
// has the GLM-5.2 effort ladder: reasoningEfforts high|max, alias low → high —
// so its chat.params turned every `low` into `high` (stand tap 2026-11-06: the
// title, explore/librarian/multimodal-looker/quick and an explicit variant low).
// GLM-5.3 and GLM-5.3-Flash accept low|high|max (models.dev). This plugin is
// listed after OmO, so its chat.params runs last and restores the effort that
// was asked for: the user's/portal's message.model.variant, else OmO's agent
// variant (message.variant); the title agent — low (opencode's small options).
const GLM53 = /^glm-5\.3(?:$|-)/
const GLM_EFFORTS = new Set(["low", "high", "max"])
const LOW_EFFORT_AGENTS = new Set(["title"])

function glmEffort(input: any): string | null {
  const m = input?.model
  const id = m?.modelID ?? m?.id
  if (m?.providerID !== "zai-coding-plan" || typeof id !== "string" || !GLM53.test(id)) return null
  const agent = typeof input.agent === "string" ? input.agent : input.agent?.name
  const want = LOW_EFFORT_AGENTS.has(agent) ? "low" : (input.message?.model?.variant ?? input.message?.variant)
  return typeof want === "string" && GLM_EFFORTS.has(want) ? want : null
}

/** The text a write tool call adds (patch: only "+" lines). */
function addedText(tool: string, args: any): string {
  if (!args || typeof args !== "object") return ""
  if (tool === "write") return String(args.content ?? "")
  if (tool === "edit") return String(args.newString ?? args.new_string ?? "")
  if (tool === "multiedit")
    return (Array.isArray(args.edits) ? args.edits : []).map((e: any) => String(e?.newString ?? e?.new_string ?? "")).join("\n")
  const t = args.patchText ?? args.patch
  if (typeof t !== "string") return ""
  return t.split(/\r?\n/).filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n")
}

/** A suspicious fragment of `text`, or null. `before` — current content of the target files. */
function cjkLeak(text: string, before: string): string | null {
  const around = (i: number) => text.slice(Math.max(0, i - 24), i + 24).replace(/\s+/g, " ").trim()
  if (text.includes("�") && !before.includes("�")) return around(text.indexOf("�"))
  if (!CJK_CHAR.test(text) || CJK_CHAR.test(before)) return null
  const glued = CJK_NEXT_TO_CYR.exec(text)
  if (glued) return around(glued.index)
  const letters = (text.match(/\p{L}/gu) ?? []).length
  const cjk = (text.match(CJK_ALL) ?? []).length
  if (letters && cjk / letters >= CJK_MIN_SHARE) return null
  return around(text.search(CJK_CHAR))
}

/** Refusal message for a write call with a CJK leak, or null. Never throws. */
function cjkGuard(tool: string, sessionID: string, args: any, cwd: string): { why: string; fragment: string } | null {
  try {
    const text = addedText(tool, args)
    if (!text) return null
    let before = ""
    for (const f of writeTargets(tool, args, cwd)) {
      try {
        if (statSync(f).size <= CJK_READ_MAX) before += readFileSync(f, "utf8") + "\n"
      } catch {}
    }
    const fragment = cjkLeak(text, before)
    if (!fragment) return null
    const key = createHash("sha1").update(tool + "\0" + JSON.stringify(args)).digest("hex")
    const seen = cjkOverrides.get(sessionID) ?? new Set<string>()
    if (seen.has(key)) {
      seen.delete(key)
      return { why: "", fragment } // repeated on purpose
    }
    seen.add(key)
    if (seen.size > 50) seen.delete(seen.values().next().value as string)
    cjkOverrides.set(sessionID, seen)
    return {
      fragment,
      why:
        `Запись отклонена: в новом тексте изолированные иероглифы или битые символы («${fragment}») — похоже на сбой генерации модели. ` +
        "Перепиши этот фрагмент без иероглифов, на языке остального текста, и повтори запись. " +
        "Если иероглифы нужны намеренно (пользователь просил текст на китайском, японском или корейском), повтори тот же вызов без изменений.",
    }
  } catch {
    return null
  }
}

function tenantToolAllowed(tool: string): boolean {
  if (TENANT_TOOL_DENY.has(tool)) return false
  return TENANT_TOOLS.has(tool) || TENANT_TOOL_PREFIXES.some((p) => tool.startsWith(p))
}

/** Why a tenant may not load this skill, or null (FEAT-04.10). */
function skillViolation(args: any): string | null {
  const raw = typeof args?.name === "string" ? args.name.trim() : ""
  if (TENANT_SKILL.test(raw.replace(/^\//, ""))) return null
  return `скилл «${oneLine(raw || "?", 60)}» недоступен в пользовательской сессии: можно загружать только скиллы zai-* (zai-xlsx, zai-docx, zai-pptx, zai-pdf, zai-images, zai-html)`
}

/** realpath of the deepest existing ancestor + the not-yet-existing tail */
async function realish(p: string): Promise<string> {
  let cur = path.resolve(p)
  const tail: string[] = []
  for (let i = 0; i < 64; i++) {
    try {
      return fwd(path.join(await realpath(cur), ...tail))
    } catch {
      const up = path.dirname(cur)
      if (up === cur) break
      tail.unshift(path.basename(cur))
      cur = up
    }
  }
  return fwd(p)
}

/** Paths named by a tool call (args + paths inside patch text). */
function toolPaths(tool: string, args: any): string[] {
  const out: string[] = []
  if (!args || typeof args !== "object") return out
  for (const k of PATH_KEYS) {
    // grep's "pattern" is a regex; glob's "pattern" is a path only if it climbs or is absolute
    if (k === "pattern" && tool === "grep") continue
    const v = args[k]
    const add = (x: unknown) => {
      if (typeof x !== "string" || !x) return
      if (k === "pattern" || k === "include") {
        if (!/^[a-zA-Z]:|^[\\/]|(^|[\\/])\.\.([\\/]|$)/.test(x)) return
        x = x.replace(/[*?{[].*$/, "") || "."
      }
      out.push(x)
    }
    if (Array.isArray(v)) v.forEach(add)
    else add(v)
  }
  for (const k of ["patchText", "patch"]) {
    const t = args[k]
    if (typeof t !== "string") continue
    // only the file headers name targets; paths inside the patched content are just text
    for (const m of t.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) out.push((m[1] ?? m[2]).trim())
  }
  if (typeof args.url === "string" && /^file:/i.test(args.url)) out.push(args.url.replace(/^file:\/*/i, ""))
  return out
}

/** Why a tenant tool call is refused, or null when it may run. */
async function sandboxViolation(tool: string, args: any, z: Zone, cwd: string): Promise<string | null> {
  if (tool === "skill") return skillViolation(args)
  if (!tenantToolAllowed(tool)) return `инструмент «${tool}» недоступен в пользовательской сессии`
  const roots = [cwd, z.root].filter((r): r is string => !!r)
  const realRoots = await Promise.all(roots.map((r) => realish(r)))
  for (const raw of toolPaths(tool, args)) {
    const abs = /^[a-zA-Z]:|^[\\/]{2}/.test(raw) ? raw : path.resolve(cwd, raw)
    const real = await realish(abs)
    if (!realRoots.some((r) => within(real, r))) return `путь вне вашей рабочей папки: ${raw}`
    if (WRITE_TOOLS.has(tool)) {
      const segs = lc(real).split("/")
      if (segs.some((s) => CONFIG_DIRS.has(s)) || CONFIG_FILES.has(segs[segs.length - 1] ?? ""))
        return `запись в конфигурацию агента запрещена: ${raw}`
    }
  }
  if (typeof args?.url === "string" && !/^file:/i.test(args.url)) {
    const why = await urlViolation(args.url)
    if (why) return why
  }
  return null
}

function privateIp(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19))
  }
  const s = ip.toLowerCase()
  return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff")
}

async function urlViolation(url: string): Promise<string | null> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return `некорректный адрес: ${url}`
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `протокол ${u.protocol} недоступен`
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal") || host === lc(os.hostname()))
    return `локальные адреса недоступны: ${host}`
  let ips: string[]
  try {
    ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
  } catch {
    return null // unresolvable — the fetch itself will fail; nothing local to reach
  }
  const bad = ips.find(privateIp)
  return bad ? `локальные и внутренние адреса недоступны: ${host} (${bad})` : null
}

// ---------- tenant shell: zai-jail (FEAT-04.9, 2026-11-04) ----------
//
// A tenant `bash` call never runs on the host. Its command is replaced with
//   <jail> --name zai-t-<id> --dir <tenant home> --cwd <workdir> --net --cafile <pem>
//          --path-prepend <venv Scripts> --b64 <base64url of: cmd.exe /d /s /c "<command>">
// zai-jail.exe (ops/sandbox) runs it in the tenant's Windows AppContainer: write
// access only to the tenant home, no loopback/LAN, no portal/owner files.
// opencode 1.19.5 runs the bash tool through Git Bash (/usr/bin/bash, checked
// live on the stand 2026-11-04); the replacement holds only [A-Za-z0-9_-./:]
// tokens, so Git Bash, cmd.exe and PowerShell all pass it verbatim — no quotes,
// no `&|"$`, nothing that MSYS path conversion rewrites (base64url has no '/').
// Fail-closed: no launcher or no Python environment → the call is refused.
const JAIL_EXE = fwd(env.ZAI_JAIL_EXE || "D:/Portal/zai/ops/sandbox/zai-jail.exe")
const SANDBOX_PY = fwd(env.ZAI_SANDBOX_PY || "D:/zai-sandbox/python")
const SHELL_SAFE_PATH = /^[A-Za-z]:\/[A-Za-z0-9_.\/-]*$/
// macOS / Linux: no tenant sandbox exists (zai-jail is a Windows AppContainer).
// Fail-closed: every tenant bash call (zai-render too) is refused, never run on the host.
const NO_SANDBOX = process.platform === "win32" ? null : "командная строка недоступна: песочница пользователей (Windows AppContainer) есть только на Windows-сервере, на этом сервере команды пользователей отключены"
const JAIL_ID = /^[A-Za-z0-9_-]{1,40}$/

/** AppContainer name of a tenant: zai-t-<name>, or a stable hash for names outside [A-Za-z0-9_-]. */
function jailName(tenant: string): string {
  return `zai-t-${JAIL_ID.test(tenant) ? tenant : "h" + createHash("sha1").update(tenant, "utf8").digest("hex").slice(0, 16)}`
}

/** The jailed replacement of a tenant bash command, or `{ error }` when it must not run. */
async function jailCommand(command: unknown, z: Zone, workdir: string): Promise<{ command: string } | { error: string }> {
  if (typeof command !== "string" || !command.trim()) return { error: "пустая команда" }
  if (command.includes("\0")) return { error: "недопустимый символ в команде" }
  if (NO_SANDBOX) return { error: NO_SANDBOX }
  if (!z.tenant || !z.home) return { error: "у сессии нет папки пользователя" }
  const python = `${SANDBOX_PY}/Scripts/python.exe`
  const cafile = `${SANDBOX_PY}/Lib/site-packages/certifi/cacert.pem`
  if (!existsSync(JAIL_EXE)) return { error: `командная строка недоступна: нет запускателя песочницы (${JAIL_EXE})` }
  if (!existsSync(python) || !existsSync(cafile)) return { error: `командная строка недоступна: нет окружения Python песочницы (${SANDBOX_PY})` }
  const root = fwd(z.home)
  const cwd = fwd(workdir)
  const [realRoot, realCwd] = await Promise.all([realish(root), realish(cwd)])
  if (!within(realCwd, realRoot) || !within(cwd, root)) return { error: `рабочая папка команды вне вашей папки: ${workdir}` }
  for (const p of [JAIL_EXE, root, cwd, cafile, SANDBOX_PY])
    if (!SHELL_SAFE_PATH.test(p)) return { error: `путь с недопустимыми символами для песочницы: ${p}` }
  const b64 = Buffer.from(`cmd.exe /d /s /c "${command}"`, "utf8").toString("base64url")
  const argv = [JAIL_EXE, "--name", jailName(z.tenant), "--dir", root, "--cwd", cwd, "--net", "--cafile", cafile, "--path-prepend", `${SANDBOX_PY}/Scripts`, "--b64", b64]
  return { command: argv.join(" ") }
}

// FEAT-04.12 (2026-11-06): «cd /d <folder> && rest» — the container cannot walk
// C:\Users\USER, so cmd's own cd died with «Access is denied»; the folder becomes
// the jail --cwd (checked like any workdir) and only the rest runs.
// Same rule as lib/claude-jail-hook.mjs splitCd (Claude tenant chats).
function splitCd(command: unknown, cwd: string): { cwd: string; command: unknown } {
  const m = /^\s*cd(?:\s+\/d)?\s+(?:"([^"]+)"|([^\s&|<>"]+))\s*&&\s*([\s\S]+)$/i.exec(String(command ?? ""))
  if (!m) return { cwd, command }
  return { cwd: path.resolve(cwd, m[1] ?? m[2]), command: m[3] }
}

// FEAT-04.12: «zai-render <file> [--pages …]» as a WHOLE command runs the host
// renderer ops/render/zai_render.py (LibreOffice/Edge/pdfium do not run in the
// container): it confines the file to the user's folder and renders a sanitized
// copy into <folder>\_preview\<name>\page-NN.png. Inside a chain it stays a
// jailed command (the sandbox stub explains how to call it).
const RENDER_CMD = /^\s*zai-render(?:\s+([^&|<>^\r\n]*))?\s*$/i
async function renderCommand(args: string, z: Zone, workdir: string): Promise<{ command: string } | { error: string }> {
  if (NO_SANDBOX) return { error: NO_SANDBOX }
  if (!z.tenant || !z.home) return { error: "у сессии нет папки пользователя" }
  const script = fwd(env.ZAI_RENDER_SCRIPT || "D:/Portal/zai/ops/render/zai_render.py")
  const python = `${SANDBOX_PY}/Scripts/python.exe`
  if (!existsSync(python) || !existsSync(script)) return { error: "просмотр документов (zai-render) недоступен на сервере" }
  const root = fwd(z.home)
  const cwd = fwd(workdir)
  const [realRoot, realCwd] = await Promise.all([realish(root), realish(cwd)])
  if (!within(realCwd, realRoot) || !within(cwd, root)) return { error: `рабочая папка команды вне вашей папки: ${workdir}` }
  for (const p of [python, script, root, cwd])
    if (!SHELL_SAFE_PATH.test(p)) return { error: `путь с недопустимыми символами: ${p}` }
  const b64 = Buffer.from(args, "utf8").toString("base64url") || "-"
  return { command: [python, "-I", script, "--root", root, "--cwd", cwd, "--b64", b64].join(" ") }
}

// ---------- agent-config plants from the tenant shell (2026-11-04, FEAT-04.10 review) ----------
//
// zai-jail gives the tenant container Modify on the tenant home, so a jailed command
// can create <home>/.opencode/plugin/x.js, opencode.json, .claude/settings.json,
// .mcp.json, … The write guard above (CONFIG_DIRS/CONFIG_FILES) covers only the
// edit/write tools. opencode/OmO load such project config from the session directory
// and its ancestors with the OWNER's rights on the next instance load (stand
// 2026-11-04: a planted .opencode/plugins/*.js ran inside `opencode serve`).
// Containment: before and right after every tenant bash call the tenant home is
// scanned and every such entry is renamed to `<name>.zai-blocked-<ts>` (not loadable).
// The jail's job object kills the command tree when the launcher exits, so nothing
// re-creates it afterwards. Root fix: opencode serve runs with OPENCODE_DISABLE_PROJECT_CONFIG=1
// (ops/opencode/serve.cmd, stand.ps1) — project .opencode/opencode.json are not loaded at all
// (stand + :4098 trap check 2026-11-04); this scan stays as defense in depth for OmO's
// directory-scoped .claude/.agents (agents, commands, skills).
const PLANT_NAMES = new Set([".opencode", "opencode.json", "opencode.jsonc", ".claude", ".mcp.json", ".agents"])
const PLANT_OMO = new Set(["omo.jsonc", "omo.json", "config.jsonc", "config.json"])
const PLANT_SKIP = new Set([".appdata", "node_modules", ".git"])

/** Rename agent-config entries under the tenant home out of the way; returns what was moved. */
function quarantinePlants(root: string, maxDepth = 8, maxEntries = 50000): string[] {
  const moved: string[] = []
  let seen = 0
  const stamp = Date.now()
  const block = (p: string) => {
    const to = `${p}.zai-blocked-${stamp}`
    try {
      renameSync(p, to)
    } catch {
      try { rmSync(p, { recursive: true, force: true }) } catch {}
    }
    moved.push(fwd(p))
  }
  const walk = (dir: string, depth: number) => {
    let ents: import("node:fs").Dirent[]
    try {
      ents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (++seen > maxEntries) return
      const p = path.join(dir, e.name)
      const n = e.name.toLowerCase()
      if (PLANT_NAMES.has(n)) { block(p); continue }
      if (n === ".omo" && e.isDirectory()) {
        for (const f of (() => { try { return readdirSync(p) } catch { return [] } })())
          if (PLANT_OMO.has(f.toLowerCase())) block(path.join(p, f))
        continue
      }
      // never follow junctions/symlinks out of the home; plain dirs only
      if (e.isDirectory() && !e.isSymbolicLink() && depth < maxDepth && !PLANT_SKIP.has(n)) walk(p, depth + 1)
    }
  }
  walk(root, 0)
  return moved
}

async function blockPlants(z: Zone, sessionID: string, when: string): Promise<string[]> {
  if (!z.tenant || !z.home) return []
  let moved: string[] = []
  try {
    moved = quarantinePlants(z.home)
  } catch (e) {
    await log(`plant guard error (${sessionID.slice(0, 12)}): ${String(e)}`)
  }
  if (moved.length) await log(`plant blocked (${when}) for tenant ${z.tenant} (${sessionID.slice(0, 12)}): ${moved.join(", ")}`)
  return moved
}

/** The tenant's own command inside a jailed command line, or null. */
function unjailCommand(cmd: unknown): string | null {
  if (typeof cmd !== "string" || !cmd.includes(" --b64 ")) return null
  // FEAT-04.12: the host renderer line → the model's own «zai-render <args>»
  if (cmd.includes("zai_render.py")) {
    const r = cmd.match(/ --b64 ([A-Za-z0-9_-]+)$/)
    if (!r) return null
    return `zai-render ${r[1] === "-" ? "" : Buffer.from(r[1], "base64url").toString("utf8")}`.trim()
  }
  if (!cmd.includes("zai-jail")) return null
  const m = cmd.match(/ --b64 ([A-Za-z0-9_-]+)$/)
  if (!m) return null
  const inner = Buffer.from(m[1], "base64url").toString("utf8")
  const w = inner.match(/^cmd\.exe \/d \/s \/c "([\s\S]*)"$/)
  return w ? w[1] : null
}

// The model must see the command it wrote, not the launcher line: a model that
// saw `zai-jail.exe … --b64 …` in its history started to imitate it (stand
// probe 2026-11-04: nested jail calls, "Access is denied", wasted steps).
function unjailPart(p: any): any {
  if (p?.type !== "tool" || p.tool !== "bash" || !p.state?.input) return p
  const orig = unjailCommand(p.state.input.command)
  return orig === null ? p : { ...p, state: { ...p.state, input: { ...p.state.input, command: orig } } }
}

// ---------- сериализация записи по сессиям ----------

const queues = new Map<string, Promise<unknown>>()
function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const p = prev.then(fn, fn)
  const tail = p.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, tail)
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return p
}

// ---------- BUG-146 / FEAT-01.58: бэкап файлов хода для «Отменить ход» ----------
//
// opencode 1.19.5 не ведёт снапшоты вне git (revert скрывает сообщения, файлы
// остаются), а внутри git его откат задевает чужие правки (BUG-145). Поэтому
// откат файлов делает портал (lib/turn-undo.js), а плагин перед КАЖДОЙ правкой
// write/edit/multiedit/patch/apply_patch сохраняет первое состояние файла в
// ходе: <TURN_UNDO_ROOT>/<sessionID>/<messageID вопроса>/ — тот же формат, что
// у PreToolUse-хука Claude (lib/turn-undo-hook.mjs backup()): lock-файл `wx`
// <key>.json, копия <key>.bak, запись {path, existed, complete, at, skipped?}.
// Субагенты (task) пишут в ход корневой сессии. Новый вопрос корневой сессии
// удаляет бэкапы прежних ходов (откатывается только последний); session.idle
// фиксирует результат хода (<key>.after.json) — откат не затрёт файл,
// изменённый после хода. Ошибка бэкапа никогда не ломает инструмент.

const TURN_UNDO_ROOT = path.resolve(env.ZAI_TURN_UNDO_ROOT || path.join(path.dirname(path.resolve(USERS_FILE)), "turn-undo"))
const UNDO_SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const UNDO_MAX_COPY = 50 * 1024 * 1024

function undoKey(abs: string) {
  return createHash("sha1").update(String(abs).toLowerCase()).digest("hex").slice(0, 20)
}
function undoDir(sessionID: string, messageID: string): string | null {
  if (!UNDO_SAFE.test(String(sessionID)) || !UNDO_SAFE.test(String(messageID))) return null
  return path.join(TURN_UNDO_ROOT, sessionID, messageID)
}

/** Absolute files a write tool call is about to change (native separators). */
function writeTargets(tool: string, args: any, cwd: string): string[] {
  if (!WRITE_TOOLS.has(tool) || !args || typeof args !== "object") return []
  const out = new Set<string>()
  const add = (p: unknown) => {
    if (typeof p === "string" && p.trim()) out.add(path.resolve(cwd, p.trim()))
  }
  add(args.filePath ?? args.file_path)
  for (const k of ["patchText", "patch"]) {
    const t = args[k]
    if (typeof t !== "string") continue
    for (const m of t.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) add((m[1] ?? m[2]).trim())
  }
  return [...out]
}

/** lib/turn-undo-hook.mjs backup(): the state of `abs` before its first change in the turn. */
function undoBackup(dir: string, abs: string): boolean {
  mkdirSync(dir, { recursive: true })
  const key = undoKey(abs)
  const rec = path.join(dir, `${key}.json`)
  let fd: number
  try {
    fd = openSync(rec, "wx") // the lock: only the first call of the turn wins
  } catch {
    return false
  }
  try {
    writeSync(fd, JSON.stringify({ path: abs, complete: false }))
  } finally {
    closeSync(fd)
  }
  let st: ReturnType<typeof statSync> | null = null
  try {
    st = statSync(abs)
  } catch {}
  const out: Record<string, unknown> = { path: abs, existed: Boolean(st), complete: true, at: Date.now() }
  if (st && !st.isFile()) out.skipped = "not-a-file"
  else if (st && st.size > UNDO_MAX_COPY) out.skipped = "too-big"
  else if (st) copyFileSync(abs, path.join(dir, `${key}.bak`))
  writeFileSync(rec, JSON.stringify(out))
  return true
}

/** A new question: only the current turn of the session keeps its backups. */
function undoStartTurn(sessionID: string, messageID: string) {
  if (!undoDir(sessionID, messageID)) return
  const sdir = path.join(TURN_UNDO_ROOT, sessionID)
  let names: string[] = []
  try {
    names = readdirSync(sdir)
  } catch {
    return
  }
  for (const n of names) if (n !== messageID) rmSync(path.join(sdir, n), { recursive: true, force: true })
}

function sha1Of(file: string): string | null {
  try {
    return createHash("sha1").update(readFileSync(file)).digest("hex")
  } catch {
    return null
  }
}

/** TurnUndo.seal(): what the turn left in every file it touched. */
function undoSeal(sessionID: string, messageID: string): number {
  const dir = undoDir(sessionID, messageID)
  if (!dir) return 0
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  // the turn is undone right now (portal revert left *.redo.json): the files
  // hold the state BEFORE the turn — never record that as its result
  if (names.some((x) => x.endsWith(".redo.json"))) return 0
  let n = 0
  for (const name of names) {
    const m = /^([0-9a-f]{20})\.json$/.exec(name)
    if (!m) continue
    try {
      const r = JSON.parse(readFileSync(path.join(dir, name), "utf8"))
      if (!r?.complete || typeof r.path !== "string") continue
      const exists = existsSync(r.path)
      writeFileSync(path.join(dir, `${m[1]}.after.json`), JSON.stringify({ exists, hash: exists ? sha1Of(r.path) : null }))
      n++
    } catch {}
  }
  return n
}

// ---------- плагин ----------

type SessZone = { dir: string; zone: Zone; parentID?: string }

export default (async ({ client }: PluginInput) => {
  const injected = new Set<string>()
  // sessionID → directory/zone (the directory of a session never changes)
  const zones = new Map<string, SessZone>()

  async function zoneForSession(sessionID: string): Promise<SessZone | null> {
    const hit = zones.get(sessionID)
    if (hit) return hit
    const s = await getSession(client, sessionID)
    if (!s) return null
    const v = { dir: s.directory, zone: await zoneOf(s.directory), parentID: s.parentID }
    zones.set(sessionID, v)
    return v
  }

  /** zone of the root session (subagents inherit the tenant scope of their parent) */
  async function effectiveZone(sessionID: string): Promise<SessZone | null> {
    let cur = await zoneForSession(sessionID)
    for (let i = 0; i < 5 && cur && !cur.zone.tenant && cur.parentID; i++) {
      const up = await zoneForSession(cur.parentID)
      if (!up) break
      cur = up
    }
    return cur
  }

  // BUG-146: root sessionID → messageID of its current question
  const turns = new Map<string, string>()
  /** the root session of a subagent chain (parentID through the client, cached in `zones`) */
  async function rootSession(sessionID: string): Promise<string | null> {
    let id = sessionID
    for (let i = 0; i < 8; i++) {
      const v = await zoneForSession(id)
      if (!v) return null
      if (!v.parentID) return id
      id = v.parentID
    }
    return null
  }

  /** FEAT-04.12 stage B: the working folder of a tenant chat (of its ROOT session — a
   *  subagent works in its parent chat's folder), or null for an old chat / admin. */
  async function chatDirOf(sessionID: string, v: SessZone): Promise<string | null> {
    if (!v.zone.tenant) return null
    const rootID = (await rootSession(sessionID)) ?? sessionID
    return chatFolderOf(v.zone.home, rootID)
  }

  /** the current turn of a root session; after a serve restart — its last question */
  async function currentTurn(rootID: string): Promise<string | null> {
    const hit = turns.get(rootID)
    if (hit) return hit
    const msgs = await getMessages(client, rootID)
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.info?.role !== "user") continue
      turns.set(rootID, msgs[i].info.id)
      return msgs[i].info.id
    }
    return null
  }

  /** Keep the files a write tool is about to change. Never throws. */
  async function backupForTool(tool: string, sessionID: string, args: any, cwd: string) {
    try {
      const targets = writeTargets(tool, args, cwd)
      if (!targets.length) return
      const rootID = await rootSession(sessionID)
      const messageID = rootID ? await currentTurn(rootID) : null
      const dir = rootID && messageID ? undoDir(rootID, messageID) : null
      if (!dir) {
        await log(`turn-undo: no turn for ${tool} in ${sessionID.slice(0, 12)} — not backed up`)
        return
      }
      for (const abs of targets) {
        try {
          undoBackup(dir, abs)
        } catch (e) {
          await log(`turn-undo backup error (${abs}): ${String(e)}`)
        }
      }
    } catch (e) {
      await log(`turn-undo error (${tool}, ${sessionID?.slice(0, 12)}): ${String(e)}`)
    }
  }

  await log(`loaded: vault=${VAULT} tenantHome=${TENANT_HOME} tenantVault=${TENANT_VAULT} users=${USERS_FILE} turnUndo=${TURN_UNDO_ROOT}`)

  return {
    "chat.message": async (
      input: { sessionID: string; agent?: string; messageID?: string },
      output: { message: any; parts: any[] },
    ) => {
      // BUG-146: the question of a root session opens a new undoable turn
      try {
        const agentName: string = output.message?.agent ?? input.agent ?? ""
        const msgID: string | undefined = output.message?.id ?? input.messageID
        if (msgID && !(agentName && INTERNAL_AGENTS.has(agentName))) {
          const v = await zoneForSession(input.sessionID)
          if (v && !v.parentID && turns.get(input.sessionID) !== msgID) {
            turns.set(input.sessionID, msgID)
            undoStartTurn(input.sessionID, msgID)
          }
        }
      } catch (e) {
        await log(`turn-undo chat.message error: ${String(e)}`)
      }
      try {
        if (injected.has(input.sessionID)) return
        const agentName: string = output.message?.agent ?? input.agent ?? ""
        if (agentName && INTERNAL_AGENTS.has(agentName)) return

        const s = await getSession(client, input.sessionID)
        if (!s || s.parentID) return

        // единственная безопасная форма инъекции в 1.19.5 (как hephaestusAgentsMdInjector
        // в oh-my-openagent): дописать контекст в текст реальной пользовательской части.
        // Пуш новой части в output.parts ломает персист сообщения (500 на сервере).
        const textPart = (output.parts ?? []).find((p) => p.type === "text" && !p.synthetic && typeof p.text === "string")
        if (!textPart) return // сообщения без текста пропускаем, попробуем на следующем текстовом

        // Only the first user turn of a session gets a snapshot. The in-memory
        // Set is lost on serve restart, so check the stored history too —
        // otherwise old sessions got a fresh snapshot mid-conversation.
        const myId = output.message?.id ?? input.messageID
        const earlier = (await getMessages(client, input.sessionID)).filter((m) => m.info.role === "user" && m.info.id !== myId)
        if (earlier.length) {
          injected.add(input.sessionID)
          return
        }

        const zone = await zoneOf(s.directory)
        zones.set(s.id, { dir: s.directory, zone, parentID: s.parentID })
        const snapshot = await buildSnapshot(s, zone)
        injected.add(input.sessionID)
        if (!snapshot) {
          await log(`snapshot skipped for ${input.sessionID.slice(0, 8)} (tenant ${zone.tenant}: no vault zone)`)
          return
        }

        // FEAT-01.32 / BUG-01.27 (2026-11-04): the user's text stays exactly
        // what was typed (bubble, history, opencode's auto title). The snapshot
        // is stored on the SAME part as metadata (no new part: pushing one
        // broke persistence in 1.19.5) and spliced in front of the text only in
        // the copy sent to the model (experimental.chat.messages.transform).
        textPart.metadata = { ...(textPart.metadata ?? {}), [KB_CONTEXT_KEY]: snapshot }
        await log(`snapshot injected into ${input.sessionID.slice(0, 8)} (${slugOf(s.directory)}; zone ${zone.tenant ?? "admin"} -> ${zone.root})`)
      } catch (e) {
        await log(`chat.message error: ${String(e)}`)
      }
    },

    // FEAT-01.32: what the MODEL sees — the snapshot from metadata in front of
    // the typed text of that user part (a fresh part object: the stored one is
    // never mutated). Legacy messages (snapshot already inside the text) pass.
    "experimental.chat.messages.transform": async (_input: {}, output: { messages: { info: any; parts: any[] }[] }) => {
      try {
        for (const m of output.messages ?? []) {
          if (!Array.isArray(m?.parts)) continue
          if (m.info?.role === "user") m.parts = m.parts.map((p) => withKbContext(p))
          // FEAT-04.9: jailed tenant bash calls are shown to the model as typed
          else if (m.info?.role === "assistant") m.parts = m.parts.map((p) => unjailPart(p))
        }
      } catch (e) {
        await log(`messages.transform error: ${String(e)}`)
      }
    },

    // BUG-180: runs after OmO's chat.params (plugin order) — see glmEffort.
    "chat.params": async (input: any, output: any) => {
      try {
        const want = glmEffort(input)
        if (!want || !output || typeof output !== "object") return
        output.options = output.options && typeof output.options === "object" ? output.options : {}
        if (output.options.reasoningEffort !== want) {
          await log(`effort: ${input.model.modelID ?? input.model.id} ${String(output.options.reasoningEffort)} -> ${want} (agent ${typeof input.agent === "string" ? input.agent : input.agent?.name})`)
          output.options.reasoningEffort = want
        }
      } catch (e) {
        await log(`chat.params error: ${String(e)}`)
      }
    },

    "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system: string[] }) => {
      try {
        if (!input.sessionID) return
        const v = await effectiveZone(input.sessionID)
        if (!v || !v.zone.tenant) return
        const n = stripAdminRules(output.system)
        output.system.push(v.zone.root ? tenantRules(v.zone) : "База знаний Obsidian в этой сессии недоступна: не читай и не пиши в D:\\Obsidian.")
        // FEAT-04.12 stage B: the model must know its chat folder (the env block says the root).
        const cd = await chatDirOf(input.sessionID, v)
        if (cd)
          output.system.push(
            `Рабочая папка этого чата: ${cd}. Команды выполняются в ней, относительные пути — от неё: сохраняй результат сюда (рабочие файлы — в _work). ` +
              `Вложения пользователя — .zai-uploads/<имя> (доступны и из этой папки). Папки других чатов пользователя — рядом, в ${path.dirname(cd)}; открывай их, только если пользователь сам попросил.`,
          )
        await log(`system: tenant ${v.zone.tenant} (${input.sessionID.slice(0, 8)}): admin rules blocks stripped=${n}`)
      } catch (e) {
        await log(`system.transform error: ${String(e)}`)
      }
    },

    "tool.execute.before": async (input: { tool: string; sessionID: string; callID?: string }, output: { args: any }) => {
      let bad: string[] = []
      let v: SessZone | null = null
      let why: string | null = null
      try {
        v = await effectiveZone(input.sessionID)
        if (!v) throw new Error("session not found")
        if (v.zone.tenant) {
          // FEAT-04.12 stage B: a chat with its own folder works there (before the checks:
          // they then see absolute paths inside the tenant folder).
          const cd = await chatDirOf(input.sessionID, v)
          if (cd) pointToChat(input.tool, output.args, cd)
          why = await sandboxViolation(input.tool, output.args, v.zone, v.dir)
          bad = forbiddenPaths(output.args, v.zone, v.dir)
        }
      } catch (e) {
        // Fail-closed: a tool call whose session zone is unknown never runs.
        await log(`tool guard error (${input.tool}, ${input.sessionID?.slice(0, 12)}): ${String(e)}`)
        throw new Error("Инструмент недоступен: не удалось определить права сессии. Повторите запрос.")
      }
      if (why && v) {
        await log(`sandbox blocked for tenant ${v.zone.tenant}: ${input.tool} -> ${why}`)
        throw new Error(`Доступ запрещён: ${why}.`)
      }
      if (bad.length && v) {
        await log(`tool blocked for tenant ${v.zone.tenant}: ${input.tool} -> ${bad.join(", ")}`)
        throw new Error(
          `Доступ запрещён: путь вне вашей базы знаний (${bad.join(", ")}). Ваша зона Obsidian: ${(v.zone.root ?? "нет").replace(/\//g, "\\")}.`,
        )
      }
      // FEAT-04.9: an allowed tenant bash call runs only inside the tenant's AppContainer.
      if (v && v.zone.tenant && input.tool === "bash") {
        const own = zones.get(input.sessionID)?.dir ?? v.dir
        const wd = typeof output.args?.workdir === "string" && output.args.workdir
          ? (/^[a-zA-Z]:/.test(output.args.workdir) ? output.args.workdir : path.resolve(own, output.args.workdir))
          : own
        let jailed: { command: string } | { error: string }
        try {
          const sc = splitCd(output.args?.command, wd)
          const rm = RENDER_CMD.exec(String(sc.command ?? ""))
          jailed = rm ? await renderCommand(rm[1] ?? "", v.zone, sc.cwd) : await jailCommand(sc.command, v.zone, sc.cwd)
        } catch (e) {
          jailed = { error: `не удалось подготовить песочницу (${String(e)})` }
        }
        if ("error" in jailed) {
          await log(`jail refused for tenant ${v.zone.tenant}: ${jailed.error}`)
          throw new Error(`Доступ запрещён: ${jailed.error}.`)
        }
        await log(`jail: tenant ${v.zone.tenant} (${input.sessionID.slice(0, 12)}) cwd=${fwd(wd)} cmd=${oneLine(String(output.args.command), 160)}`)
        // The stored part keeps the launcher line (admin sees it; tenants get tool
        // parts redacted by the portal); the model's history is unjailed in
        // experimental.chat.messages.transform (unjailPart).
        output.args.command = jailed.command
        await blockPlants(v.zone, input.sessionID, "before")
        return
      }
      // BUG-180: a write with an isolated CJK / U+FFFD fragment is refused before
      // any backup (admin and tenant alike); a repeat of the same call passes.
      if (v && WRITE_TOOLS.has(input.tool)) {
        const own = zones.get(input.sessionID)?.dir ?? v.dir
        const leak = cjkGuard(input.tool, input.sessionID, output.args, own)
        if (leak) {
          await log(`cjk guard ${leak.why ? "blocked" : "override"}: ${input.tool} (${input.sessionID?.slice(0, 12)}) «${oneLine(leak.fragment, 60)}»`)
          if (leak.why) throw new Error(leak.why)
        }
      }
      // BUG-146: only an allowed call gets here; relative paths resolve against
      // the calling session's own folder. backupForTool never throws.
      if (v && WRITE_TOOLS.has(input.tool)) {
        const own = zones.get(input.sessionID)?.dir ?? v.dir
        await backupForTool(input.tool, input.sessionID, output.args, own)
      }
    },

    // Agent-config plants made by the tenant shell are moved away as soon as the
    // jailed command ends (see quarantinePlants).
    "tool.execute.after": async (input: { tool: string; sessionID: string }, output: { output?: unknown }) => {
      if (input.tool !== "bash") return
      try {
        const v = await effectiveZone(input.sessionID)
        if (!v?.zone.tenant) return
        const moved = await blockPlants(v.zone, input.sessionID, "after")
        if (moved.length && typeof output?.output === "string")
          output.output += `\n[песочница] Файлы конфигурации агента в папке пользователя запрещены и заблокированы: ${moved.map((p) => path.basename(p)).join(", ")}.`
      } catch (e) {
        await log(`plant guard error (${input.sessionID?.slice(0, 12)}): ${String(e)}`)
      }
    },

    event: async ({ event }: { event: { type: string; properties: any } }) => {
      try {
        if (event.type !== "session.idle") return
        const sessionID: string = event.properties?.sessionID
        if (!sessionID) return

        // BUG-146: the turn ended — remember what it left in its files
        try {
          const turn = turns.get(sessionID)
          if (turn) undoSeal(sessionID, turn)
        } catch (e) {
          await log(`turn-undo seal error: ${String(e)}`)
        }

        await enqueue(sessionID, async () => {
          const s = await getSession(client, sessionID)
          if (!s) return
          const msgs = await getMessages(client, sessionID)
          if (!isPrimary(s, msgs)) return
          const d = extractDigest(msgs)
          if (!d) return
          await writeDigest(s, await zoneOf(s.directory), d)
        })
      } catch (e) {
        await log(`event error: ${String(e)}`)
      }
    },

    "experimental.session.compacting": async (input: { sessionID: string }, output: { context: string[] }) => {
      try {
        const s = await getSession(client, input.sessionID)
        if (!s) return
        const z = await zoneOf(s.directory)
        if (!z.root) return
        const file = digestFile(z.root, input.sessionID)
        const prev = await readIfExists(file)
        if (!prev) return
        output.context.push(
          z.tenant
            ? `Активный кэш этой сессии: ${file}. При компакции сохрани ссылки на заметки из своей зоны ${z.root}.`
            : `Активный кэш этой сессии: ${file}. Ключевые файлы и итоги ходов там; при компакции сохрани ссылки на задачи/решения/уроки из D:\\Obsidian\\agents\\, упомянутые в диалоге.`,
        )
      } catch (e) {
        await log(`compacting error: ${String(e)}`)
      }
    },
  } as Awaited<ReturnType<Plugin>>
}) satisfies Plugin
