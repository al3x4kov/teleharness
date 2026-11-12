/**
 * sandbox-core — чистое ядро песочницы тенантов (FEAT-16.3, tasks 4.1).
 *
 * Источник логики: ops/opencode/vault-cache.ts (1.x, НЕ редактируется — там
 * незакоммиченные правки автора 1.14.11; дедупликация vault-cache.ts на модуль —
 * отдельной задачей, когда автор закоммитит). Функции перенесены как есть,
 * без зависимостей от plugin-API opencode: только node:fs/path/crypto/dns/net/os.
 *
 * Отвечает за (design.md §7):
 *  - зоны тенантов (users.json портала + ZAI_TENANT_HOME/<имя>), fail-closed;
 *  - allowlist инструментов с нормализацией имён v1/v2 (bash ↔ shell,
 *    task ↔ subagent) и codemode-обёрткой `execute` v2 (Э10: настоящие вызовы
 *    MCP видны в коде/`metadata.toolCalls`, имена `сервер.инструмент`);
 *  - confinement путей (realish: junction/`..`), запрет записи конфигов агента;
 *  - webfetch только на публичные хосты (локальные/частные адреса — отказ);
 *  - CJK-страж записей (BUG-180);
 *  - jail bash/shell через zai-jail.exe (FEAT-04.9), splitCd, zai-render;
 *  - карантин подсаженных конфигов агента (quarantinePlants, до и после shell);
 *  - бэкап файлов хода для «Отменить ход» (BUG-146 / turn-undo).
 *
 * Адаптеры (v1 vault-cache.ts — позже, v2 ops/opencode/plugin-v2/index.ts)
 * создают фабрику createSandbox({ getSession, getMessages }) и зовут
 * before()/after(): те же сообщения об отказе («Доступ запрещён: …»), та же
 * строка лога «sandbox blocked», что в 1.x.
 *
 * Примечание: CJK-диапазоны и U+FFFD в исходнике записаны \u-escape —
 * литеральные иероглифы триггерят собственный CJK-страж при записи файла.
 */
import { appendFile, mkdir, readFile, readdir, realpath } from "node:fs/promises"
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import os from "node:os"
import path from "node:path"

const env = process.env
export const VAULT = fwd(env.VAULT_CACHE_ROOT || "D:/Obsidian/agents")
export const LOG_FILE = env.VAULT_CACHE_LOG || "C:/Users/USER/.config/opencode/vault-cache.log"
export const TENANT_HOME = fwd(env.ZAI_TENANT_HOME || "C:/Users/USER/.zai-tenants")
export const TENANT_VAULT = fwd(env.ZAI_TENANT_VAULT || "D:/Obsidian/tenants")
export const USERS_FILE = env.ZAI_USERS_FILE || "D:/Portal/zai/data/users.json"
// Everything under these roots is off-limits for tenant tools, except the tenant's own zone.
export const PROTECTED_ROOTS = [fwd(env.VAULT_CACHE_PROTECT || "D:/Obsidian"), VAULT, TENANT_VAULT]
export const ADMIN_INDEX = `${VAULT}/_index.md`
const HOME = fwd(os.homedir())

// ---------- мелкие утилиты (vault-cache.ts:71-135) ----------

function pad(n) {
  return String(n).padStart(2, "0")
}
function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function hm(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** normalized forward-slash absolute path without trailing slash */
function fwd(p) {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "")
}
function lc(p) {
  return p.toLowerCase()
}
/** true if `p` equals `root` or lies inside it (case-insensitive, Windows) */
export function within(p, root) {
  const a = lc(fwd(p))
  const b = lc(fwd(root))
  return a === b || a.startsWith(b + "/")
}
function slugOf(dir) {
  const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "default"
  const s = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  return s || "default"
}
export function oneLine(s, n) {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}
function tail(s, n) {
  const t = s.trim()
  return t.length > n ? "…" + t.slice(t.length - n) : t
}
export async function log(msg) {
  try {
    await appendFile(LOG_FILE, `${new Date().toISOString()} ${msg}\n`, "utf8")
  } catch {}
}
async function readIfExists(p) {
  try {
    return await readFile(p, "utf8")
  } catch {
    return null
  }
}

// ---------- зона vault по директории сессии (vault-cache.ts:173-217) ----------

const SAFE_NAME = /^[^\\/:*?"<>|.][^\\/:*?"<>|]*$/

let usersCache = { at: 0, list: [] }

async function tenantsFromPortal() {
  if (Date.now() - usersCache.at < 10_000) return usersCache.list
  const list = []
  try {
    const raw = JSON.parse((await readIfExists(USERS_FILE)) ?? "{}")
    for (const u of Array.isArray(raw?.users) ? raw.users : []) {
      if (!u || u.role === "admin" || !Array.isArray(u.directories) || !u.directories.length) continue
      const root = u.obsidianRoot || (Array.isArray(u.extraRoots) && u.extraRoots[0]) || null
      list.push({ name: String(u.name || u.id), dirs: u.directories.map((d) => fwd(d)), root: root ? fwd(root) : null })
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

/** Сброс кэша users.json (тесты). */
export function resetUsersCache() {
  usersCache = { at: 0, list: [] }
}

export async function zoneOf(dir) {
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

// ---------- FEAT-04.12 stage B: рабочая папка чата (vault-cache.ts:88-116) ----------
//
// The portal (lib/chat-folder.js) creates <tenant>\chats\<session id without ses_>
// for every NEW tenant chat; the session directory stays the tenant root. Its
// presence switches the chat: shell without workdir runs there, relative file
// paths and searches resolve there. Old chats (no folder) keep the root.

const CHAT_ID = /^ses_([A-Za-z0-9]{1,64})$/
export function chatFolderOf(home, sessionID) {
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
const isAbs = (p) => /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)
const SEARCH_TOOLS = new Set(["glob", "grep", "list"])

/** Relative paths of a tenant tool call → the chat folder (args are rewritten in place). */
export function pointToChat(tool, args, chatDir) {
  const t = canonicalTool(tool)
  if (!args || typeof args !== "object") return
  const rel = (p) => (typeof p === "string" && p && !isAbs(p) ? path.resolve(chatDir, p) : p)
  for (const k of ["filePath", "file_path"]) if (typeof args[k] === "string") args[k] = rel(args[k])
  // BUG-199: opencode 2.x — read/edit/write берут `path` (у поиска `path` — корень, ниже)
  if (!SEARCH_TOOLS.has(t) && typeof args.path === "string") args.path = rel(args.path)
  if (t === "bash") args.workdir = typeof args.workdir === "string" && args.workdir ? rel(args.workdir) : chatDir
  if (SEARCH_TOOLS.has(t)) args.path = typeof args.path === "string" && args.path ? rel(args.path) : chatDir
}

// ---------- нормализация имён инструментов v1/v2 (FEAT-16.3, Э7/Э10) ----------
//
// v1 (opencode 1.x): bash, task, MCP `сервер_инструмент` (подчёркивание).
// v2 (opencode 2.x): shell, subagent; MCP — через codemode-обёртку `execute`
// с кодом `return await tools.<сервер>.<метод>({…})` (настоящий вызов также
// виден в state.metadata.toolCalls). Allowlist один для обоих плагинов:
// нормализация сводит v2-имена к каноническим v1.

const V2_ALIASES = { shell: "bash", subagent: "task" }

/** v2-имя (shell/subagent) → каноническое v1 (bash/task); остальные — как есть. */
export function canonicalTool(name) {
  const n = String(name ?? "")
  return V2_ALIASES[n.toLowerCase()] ?? n
}

/** Codemode-вызовы внутри v2-обёртки `execute`: имена `сервер.инструмент`. */
export function codemodeToolCalls(input) {
  const out = new Set()
  const code = typeof input === "string" ? input : typeof input?.code === "string" ? input.code : ""
  for (const m of code.matchAll(/tools\s*\.\s*([A-Za-z0-9_$-]+)\s*\.\s*([A-Za-z0-9_$-]+)/g)) out.add(`${m[1]}.${m[2]}`)
  const lists = [input?.toolCalls, input?.metadata?.toolCalls]
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const t of list) if (typeof t?.tool === "string" && t.tool) out.add(t.tool)
  }
  return [...out]
}

// ---------- tenant sandbox (vault-cache.ts:503-546) ----------

export const TENANT_TOOLS = new Set([
  "bash", // FEAT-04.9: runs only through zai-jail (jailCommand below), never on the host
  "read", "glob", "grep", "list",
  "edit", "write", "multiedit", "apply_patch", "patch",
  "todowrite", "todoread", "question", "invalid",
  "webfetch", "websearch", "codesearch",
  "look_at",
])
// OmO built-in remote MCPs: public web/doc search only, no local access
// (stand 2026-11-04: context7_resolve-library-id, context7_query-docs, grep_app_searchGitHub).
// FEAT-04.10: MCP `marketplace` (ru-marketplace-mcp 2.7.0) — read-only storefront search.
export const TENANT_TOOL_PREFIXES = ["websearch_", "context7_", "grep_app_", "marketplace_"]
// compare_browser_snapshot returns a screenshot of a page retained in the owner's
// logged-in browser (Ozon via CDP) — not for tenants.
export const TENANT_TOOL_DENY = new Set(["marketplace_compare_browser_snapshot"])
// FEAT-04.10: the `skill` tool loads only the tenant skill set zai-*.
export const TENANT_SKILL = /^zai-[a-z0-9][a-z0-9-]{0,40}$/i
export const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "patch"])
export const CONFIG_DIRS = new Set([".opencode", ".omo", ".claude", ".agents"])
export const CONFIG_FILES = new Set(["opencode.json", "opencode.jsonc", ".mcp.json"])

// ---------- BUG-180: CJK leak guard (vault-cache.ts:547-640) ----------
// Код-поинты как в vault-cache.ts: kana U+3040–U+30FF, CJK Ext A U+3400–U+4DBF,
// CJK U+4E00–U+9FFF, совместимые U+F900–U+FAFF, хангыл U+AC00–U+D7AF.
const CJK_CLASS = "[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af]"
const CJK_CHAR = new RegExp(CJK_CLASS)
const CJK_ALL = new RegExp(CJK_CLASS, "g")
const CJK_NEXT_TO_CYR = new RegExp(`[\\u0400-\\u04ff]${CJK_CLASS}|${CJK_CLASS}[\\u0400-\\u04ff]`)
const CJK_MIN_SHARE = 0.2
const CJK_READ_MAX = 2 * 1024 * 1024
const U_FFFD = "\uFFFD"

// ---------- BUG-180: GLM-5.3* effort (vault-cache.ts:561-581) ----------
const GLM53 = /^glm-5\.3(?:$|-)/
const GLM_EFFORTS = new Set(["low", "high", "max"])
const LOW_EFFORT_AGENTS = new Set(["title"])

/** Желаемый reasoningEffort GLM-5.3* (исправление ladder OmO), или null. */
export function glmEffort(input) {
  const m = input?.model
  const id = m?.modelID ?? m?.id
  if (m?.providerID !== "zai-coding-plan" || typeof id !== "string" || !GLM53.test(id)) return null
  const agent = typeof input.agent === "string" ? input.agent : input.agent?.name
  const want = LOW_EFFORT_AGENTS.has(agent) ? "low" : (input.message?.model?.variant ?? input.message?.variant)
  return typeof want === "string" && GLM_EFFORTS.has(want) ? want : null
}

/** The text a write tool call adds (patch: only "+" lines). */
export function addedText(tool, args) {
  const t = canonicalTool(tool)
  if (!args || typeof args !== "object") return ""
  if (t === "write") return String(args.content ?? "")
  if (t === "edit") return String(args.newString ?? args.new_string ?? "")
  if (t === "multiedit")
    return (Array.isArray(args.edits) ? args.edits : []).map((e) => String(e?.newString ?? e?.new_string ?? "")).join("\n")
  const pt = args.patchText ?? args.patch
  if (typeof pt !== "string") return ""
  return pt
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n")
}

/** A suspicious fragment of `text`, or null. `before` — current content of the target files. */
export function cjkLeak(text, before) {
  const around = (i) => text.slice(Math.max(0, i - 24), i + 24).replace(/\s+/g, " ").trim()
  if (text.includes(U_FFFD) && !before.includes(U_FFFD)) return around(text.indexOf(U_FFFD))
  if (!CJK_CHAR.test(text) || CJK_CHAR.test(before)) return null
  const glued = CJK_NEXT_TO_CYR.exec(text)
  if (glued) return around(glued.index)
  const letters = (text.match(/\p{L}/gu) ?? []).length
  const cjk = (text.match(CJK_ALL) ?? []).length
  if (letters && cjk / letters >= CJK_MIN_SHARE) return null
  return around(text.search(CJK_CHAR))
}

export function tenantToolAllowed(tool) {
  const t = canonicalTool(tool)
  if (TENANT_TOOL_DENY.has(t)) return false
  return TENANT_TOOLS.has(t) || TENANT_TOOL_PREFIXES.some((p) => t.startsWith(p))
}

/** Why a tenant may not load this skill, or null (FEAT-04.10). */
export function skillViolation(args) {
  // BUG-198: opencode 2.x — skill передаёт `id` (1.x — `name`)
  const v = typeof args?.name === "string" ? args.name : typeof args?.id === "string" ? args.id : ""
  const raw = v.trim()
  if (TENANT_SKILL.test(raw.replace(/^\//, ""))) return null
  return `скилл «${oneLine(raw || "?", 60)}» недоступен в пользовательской сессии: можно загружать только скиллы zai-* (zai-xlsx, zai-docx, zai-pptx, zai-pdf, zai-images, zai-html)`
}

/** realpath of the deepest existing ancestor + the not-yet-existing tail (vault-cache.ts:655-669). */
export async function realish(p) {
  let cur = path.resolve(p)
  const tail = []
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

const PATH_KEYS = ["filePath", "file_path", "path", "paths", "pattern", "include", "workdir", "cwd", "directory", "dir", "target", "source", "destination"]
const ABS_IN_TEXT = /[a-zA-Z]:[\\/]+[^\s"'`;|&<>()]*/g

/** Paths named by a tool call (args + paths inside patch text) (vault-cache.ts:672-698). */
export function toolPaths(tool, args) {
  const t = canonicalTool(tool)
  const out = []
  if (!args || typeof args !== "object") return out
  for (const k of PATH_KEYS) {
    // grep's "pattern" is a regex; glob's "pattern" is a path only if it climbs or is absolute
    if (k === "pattern" && t === "grep") continue
    const v = args[k]
    const add = (x) => {
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
    const tx = args[k]
    if (typeof tx !== "string") continue
    // only the file headers name targets; paths inside the patched content are just text
    for (const m of tx.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) out.push((m[1] ?? m[2]).trim())
  }
  if (typeof args.url === "string" && /^file:/i.test(args.url)) out.push(args.url.replace(/^file:\/*/i, ""))
  return out
}

/** Paths a tool call may touch that fall into the protected vault outside the tenant's zone (vault-cache.ts:479-501). */
export function forbiddenPaths(args, z, cwd) {
  const bad = []
  const check = (p) => {
    if (!p || typeof p !== "string") return
    const abs = /^[a-zA-Z]:/.test(p) ? p : path.resolve(cwd, p)
    if (!PROTECTED_ROOTS.some((r) => within(abs, r))) return
    if (z.root && within(abs, z.root)) return
    bad.push(p)
  }
  const scanText = (t) => {
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

/** Codemode-обёртка v2 `execute`: почему нельзя, или null (fail-closed). */
function executeViolation(args) {
  const calls = codemodeToolCalls(args)
  if (!calls.length)
    return "инструмент «execute» недоступен в пользовательской сессии: вызовы инструментов внутри кода не распознаны"
  for (const raw of calls) {
    if (!raw.includes(".")) return `инструмент «${raw}» недоступен в пользовательской сессии`
    const t = canonicalTool(raw.replace(/\./g, "_"))
    if (TENANT_TOOL_DENY.has(t)) return `инструмент «${raw}» недоступен в пользовательской сессии`
    if (!TENANT_TOOL_PREFIXES.some((p) => t.startsWith(p)))
      return `инструмент «${raw}» недоступен в пользовательской сессии: внутри execute разрешены только поисковые MCP (websearch_/context7_/grep_app_/marketplace_)`
  }
  return null
}

/** Why a tenant tool call is refused, or null when it may run (vault-cache.ts:701-721). */
export async function sandboxViolation(tool, args, z, cwd) {
  const t = canonicalTool(tool)
  if (t === "execute") return executeViolation(args)
  if (t === "skill") return skillViolation(args)
  if (!tenantToolAllowed(t)) return `инструмент «${tool}» недоступен в пользовательской сессии`
  const roots = [cwd, z.root].filter((r) => !!r)
  const realRoots = await Promise.all(roots.map((r) => realish(r)))
  for (const raw of toolPaths(t, args)) {
    const abs = /^[a-zA-Z]:|^[\\/]{2}/.test(raw) ? raw : path.resolve(cwd, raw)
    const real = await realish(abs)
    if (!realRoots.some((r) => within(real, r))) return `путь вне вашей рабочей папки: ${raw}`
    if (WRITE_TOOLS.has(t)) {
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

function privateIp(ip) {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19))
  }
  const s = ip.toLowerCase()
  return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff")
}

/** webfetch только на публичные http(s)-хосты (vault-cache.ts:734-753). */
export async function urlViolation(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return `некорректный адрес: ${url}`
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `протокол ${u.protocol} недоступен`
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal") || host === lc(os.hostname()))
    return `локальные адреса недоступны: ${host}`
  let ips
  try {
    ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
  } catch {
    return null // unresolvable — the fetch itself will fail; nothing local to reach
  }
  const bad = ips.find(privateIp)
  return bad ? `локальные и внутренние адреса недоступны: ${host} (${bad})` : null
}

// ---------- tenant shell: zai-jail (FEAT-04.9; vault-cache.ts:755-805) ----------

export const JAIL_EXE = fwd(env.ZAI_JAIL_EXE || "D:/Portal/zai/ops/sandbox/zai-jail.exe")
export const SANDBOX_PY = fwd(env.ZAI_SANDBOX_PY || "D:/zai-sandbox/python")
const SHELL_SAFE_PATH = /^[A-Za-z]:\/[A-Za-z0-9_.\/-]*$/
const JAIL_ID = /^[A-Za-z0-9_-]{1,40}$/

/** AppContainer name of a tenant: zai-t-<name>, or a stable hash for names outside [A-Za-z0-9_-]. */
export function jailName(tenant) {
  return `zai-t-${JAIL_ID.test(tenant) ? tenant : "h" + createHash("sha1").update(tenant, "utf8").digest("hex").slice(0, 16)}`
}

/** The jailed replacement of a tenant bash command, or `{ error }` when it must not run. */
export async function jailCommand(command, z, workdir) {
  if (typeof command !== "string" || !command.trim()) return { error: "пустая команда" }
  if (command.includes("\0")) return { error: "недопустимый символ в команде" }
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

// FEAT-04.12: «cd /d <folder> && rest» — the folder becomes the jail --cwd and only
// the rest runs. Same rule as lib/claude-jail-hook.mjs splitCd (Claude tenant chats).
export function splitCd(command, cwd) {
  const m = /^\s*cd(?:\s+\/d)?\s+(?:"([^"]+)"|([^\s&|<>"]+))\s*&&\s*([\s\S]+)$/i.exec(String(command ?? ""))
  if (!m) return { cwd, command }
  return { cwd: path.resolve(cwd, m[1] ?? m[2]), command: m[3] }
}

// FEAT-04.12: «zai-render <file> [--pages …]» as a WHOLE command runs the host
// renderer (LibreOffice/Edge/pdfium do not run in the container).
const RENDER_CMD = /^\s*zai-render(?:\s+([^&|<>^\r\n]*))?\s*$/i
export async function renderCommand(args, z, workdir) {
  if (!z.tenant || !z.home) return { error: "у сессии нет папки пользователя" }
  const script = fwd(env.ZAI_RENDER_SCRIPT || "D:/Portal/zai/ops/render/zai_render.py")
  const python = `${SANDBOX_PY}/Scripts/python.exe`
  if (!existsSync(python) || !existsSync(script)) return { error: "просмотр документов (zai-render) недоступен на сервере" }
  const root = fwd(z.home)
  const cwd = fwd(workdir)
  const [realRoot, realCwd] = await Promise.all([realish(root), realish(cwd)])
  if (!within(realCwd, realRoot) || !within(cwd, root)) return { error: `рабочая папка команды вне вашей папки: ${workdir}` }
  for (const p of [python, script, root, cwd]) if (!SHELL_SAFE_PATH.test(p)) return { error: `путь с недопустимыми символами: ${p}` }
  const b64 = Buffer.from(args, "utf8").toString("base64url") || "-"
  return { command: [python, "-I", script, "--root", root, "--cwd", cwd, "--b64", b64].join(" ") }
}

// ---------- agent-config plants (vault-cache.ts:828-896) ----------

const PLANT_NAMES = new Set([".opencode", "opencode.json", "opencode.jsonc", ".claude", ".mcp.json", ".agents"])
const PLANT_OMO = new Set(["omo.jsonc", "omo.json", "config.jsonc", "config.json"])
const PLANT_SKIP = new Set([".appdata", "node_modules", ".git"])

/** Rename agent-config entries under the tenant home out of the way; returns what was moved. */
export function quarantinePlants(root, maxDepth = 8, maxEntries = 50000) {
  const moved = []
  let seen = 0
  const stamp = Date.now()
  const block = (p) => {
    const to = `${p}.zai-blocked-${stamp}`
    try {
      renameSync(p, to)
    } catch {
      try { rmSync(p, { recursive: true, force: true }) } catch {}
    }
    moved.push(fwd(p))
  }
  const walk = (dir, depth) => {
    let ents
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

async function blockPlants(z, sessionID, when) {
  if (!z.tenant || !z.home) return []
  let moved = []
  try {
    moved = quarantinePlants(z.home)
  } catch (e) {
    await log(`plant guard error (${String(sessionID).slice(0, 12)}): ${String(e)}`)
  }
  if (moved.length) await log(`plant blocked (${when}) for tenant ${z.tenant} (${String(sessionID).slice(0, 12)}): ${moved.join(", ")}`)
  return moved
}

/** The tenant's own command inside a jailed command line, or null (vault-cache.ts:899-913). */
export function unjailCommand(cmd) {
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

/** The model must see the command it wrote, not the launcher line (vault-cache.ts:918-922). */
export function unjailPart(p) {
  if (p?.type !== "tool" || !["bash", "shell"].includes(canonicalTool(p.tool)) || !p.state?.input) return p
  const orig = unjailCommand(p.state.input.command)
  return orig === null ? p : { ...p, state: { ...p.state, input: { ...p.state.input, command: orig } } }
}

// ---------- BUG-146 / FEAT-01.58: бэкап файлов хода (vault-cache.ts:941-1058) ----------

export const TURN_UNDO_ROOT = path.resolve(env.ZAI_TURN_UNDO_ROOT || path.join(path.dirname(path.resolve(USERS_FILE)), "turn-undo"))
const UNDO_SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const UNDO_MAX_COPY = 50 * 1024 * 1024

function undoKey(abs) {
  return createHash("sha1").update(String(abs).toLowerCase()).digest("hex").slice(0, 20)
}
function undoDir(sessionID, messageID) {
  if (!UNDO_SAFE.test(String(sessionID)) || !UNDO_SAFE.test(String(messageID))) return null
  return path.join(TURN_UNDO_ROOT, sessionID, messageID)
}

/** Absolute files a write tool call is about to change (native separators). */
export function writeTargets(tool, args, cwd) {
  const t = canonicalTool(tool)
  if (!WRITE_TOOLS.has(t) || !args || typeof args !== "object") return []
  const out = new Set()
  const add = (p) => {
    if (typeof p === "string" && p.trim()) out.add(path.resolve(cwd, p.trim()))
  }
  add(args.filePath ?? args.file_path ?? args.path) // BUG-200: opencode 2.x — `path`
  for (const k of ["patchText", "patch"]) {
    const tx = args[k]
    if (typeof tx !== "string") continue
    for (const m of tx.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) add((m[1] ?? m[2]).trim())
  }
  return [...out]
}

/** lib/turn-undo-hook.mjs backup(): the state of `abs` before its first change in the turn. */
function undoBackup(dir, abs) {
  mkdirSync(dir, { recursive: true })
  const key = undoKey(abs)
  const rec = path.join(dir, `${key}.json`)
  let fd
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
  let st = null
  try {
    st = statSync(abs)
  } catch {}
  const out = { path: abs, existed: Boolean(st), complete: true, at: Date.now() }
  if (st && !st.isFile()) out.skipped = "not-a-file"
  else if (st && st.size > UNDO_MAX_COPY) out.skipped = "too-big"
  else if (st) copyFileSync(abs, path.join(dir, `${key}.bak`))
  writeFileSync(rec, JSON.stringify(out))
  return true
}

/** A new question: only the current turn of the session keeps its backups. */
export function undoStartTurn(sessionID, messageID) {
  if (!undoDir(sessionID, messageID)) return
  const sdir = path.join(TURN_UNDO_ROOT, sessionID)
  let names = []
  try {
    names = readdirSync(sdir)
  } catch {
    return
  }
  for (const n of names) if (n !== messageID) rmSync(path.join(sdir, n), { recursive: true, force: true })
}

function sha1Of(file) {
  try {
    return createHash("sha1").update(readFileSync(file)).digest("hex")
  } catch {
    return null
  }
}

/** TurnUndo.seal(): what the turn left in every file it touched. */
export function undoSeal(sessionID, messageID) {
  const dir = undoDir(sessionID, messageID)
  if (!dir) return 0
  let names = []
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

// ---------- фабрика песочницы: общая логика хуков tool.execute.before/after ----------
//
// Последовательность решений — точно из vault-cache.ts tool.execute.before
// (1266-1338) и tool.execute.after (1340-1353); адаптеры v1/v2 вызывают эти
// методы из своих хуков. Сообщения об отказе и строки лога — те же, что в 1.x.

const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"])

export function createSandbox({ getSession, getMessages } = {}) {
  const zones = new Map() // sessionID → { dir, zone, parentID }
  const turns = new Map() // root sessionID → messageID of its current question
  const cjkOverrides = new Map() // sessionID → hashes of refused calls

  async function zoneForSession(sessionID) {
    const hit = zones.get(sessionID)
    if (hit) return hit
    const s = getSession ? await getSession(sessionID) : null
    if (!s) return null
    const v = { dir: s.directory, zone: await zoneOf(s.directory), parentID: s.parentID }
    zones.set(sessionID, v)
    return v
  }

  /** zone of the root session (subagents inherit the tenant scope of their parent) */
  async function effectiveZone(sessionID) {
    let cur = await zoneForSession(sessionID)
    for (let i = 0; i < 5 && cur && !cur.zone.tenant && cur.parentID; i++) {
      const up = await zoneForSession(cur.parentID)
      if (!up) break
      cur = up
    }
    return cur
  }

  /** the root session of a subagent chain (parentID through the client, cached in `zones`) */
  async function rootSession(sessionID) {
    let id = sessionID
    for (let i = 0; i < 8; i++) {
      const v = await zoneForSession(id)
      if (!v) return null
      if (!v.parentID) return id
      id = v.parentID
    }
    return null
  }

  /** FEAT-04.12 stage B: the working folder of a tenant chat (of its ROOT session), or null. */
  async function chatDirOf(sessionID, v) {
    if (!v.zone.tenant) return null
    const rootID = (await rootSession(sessionID)) ?? sessionID
    return chatFolderOf(v.zone.home, rootID)
  }

  /** the current turn of a root session; after a serve restart — its last question */
  async function currentTurn(rootID) {
    const hit = turns.get(rootID)
    if (hit) return hit
    const msgs = getMessages ? await getMessages(rootID) : []
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.info?.role !== "user") continue
      turns.set(rootID, msgs[i].info.id)
      return msgs[i].info.id
    }
    return null
  }

  /** Keep the files a write tool is about to change. Never throws. */
  async function backupForTool(tool, sessionID, args, cwd) {
    try {
      const targets = writeTargets(tool, args, cwd)
      if (!targets.length) return
      const rootID = await rootSession(sessionID)
      const messageID = rootID ? await currentTurn(rootID) : null
      const dir = rootID && messageID ? undoDir(rootID, messageID) : null
      if (!dir) {
        await log(`turn-undo: no turn for ${tool} in ${String(sessionID).slice(0, 12)} — not backed up`)
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
      await log(`turn-undo error (${tool}, ${String(sessionID)?.slice(0, 12)}): ${String(e)}`)
    }
  }

  /** BUG-146: the question of a root session opens a new undoable turn. */
  async function startTurn(sessionID, messageID, agentName) {
    try {
      if (!messageID || (agentName && INTERNAL_AGENTS.has(agentName))) return
      const v = await zoneForSession(sessionID)
      if (v && !v.parentID && turns.get(sessionID) !== messageID) {
        turns.set(sessionID, messageID)
        undoStartTurn(sessionID, messageID)
      }
    } catch (e) {
      await log(`turn-undo startTurn error: ${String(e)}`)
    }
  }

  /** TurnUndo.seal() по текущему ходу сессии (idle-событие адаптера); хода нет → 0. */
  function seal(sessionID) {
    const t = turns.get(sessionID)
    return t ? undoSeal(sessionID, t) : 0
  }

  /**
   * Хук tool.execute.before (логика vault-cache.ts:1266-1338).
   * @param tool имя инструмента v1 или v2 (нормализуется внутри)
   * @param sessionID сессия вызова
   * @param args аргументы (мутируются: pointToChat, jail-подмена команды)
   * @throws Error с той же причиной, что в 1.x («Доступ запрещён: …» и т.п.)
   */
  async function before(tool, sessionID, args) {
    let bad = []
    let v = null
    let why = null
    try {
      v = await effectiveZone(sessionID)
      if (!v) throw new Error("session not found")
      if (v.zone.tenant) {
        // FEAT-04.12 stage B: a chat with its own folder works there (before the checks:
        // they then see absolute paths inside the tenant folder).
        const cd = await chatDirOf(sessionID, v)
        if (cd) pointToChat(tool, args, cd)
        why = await sandboxViolation(tool, args, v.zone, v.dir)
        bad = forbiddenPaths(args, v.zone, v.dir)
      }
    } catch (e) {
      // Fail-closed: a tool call whose session zone is unknown never runs.
      await log(`tool guard error (${tool}, ${String(sessionID)?.slice(0, 12)}): ${String(e)}`)
      throw new Error("Инструмент недоступен: не удалось определить права сессии. Повторите запрос.")
    }
    if (why && v) {
      await log(`sandbox blocked for tenant ${v.zone.tenant}: ${tool} -> ${why}`)
      throw new Error(`Доступ запрещён: ${why}.`)
    }
    if (bad.length && v) {
      await log(`tool blocked for tenant ${v.zone.tenant}: ${tool} -> ${bad.join(", ")}`)
      throw new Error(
        `Доступ запрещён: путь вне вашей базы знаний (${bad.join(", ")}). Ваша зона Obsidian: ${(v.zone.root ?? "нет").replace(/\//g, "\\")}.`,
      )
    }
    const t = canonicalTool(tool)
    // FEAT-04.9: an allowed tenant bash/shell call runs only inside the tenant's AppContainer.
    if (v && v.zone.tenant && t === "bash") {
      const own = zones.get(sessionID)?.dir ?? v.dir
      const wd = typeof args?.workdir === "string" && args.workdir
        ? (/^[a-zA-Z]:/.test(args.workdir) ? args.workdir : path.resolve(own, args.workdir))
        : own
      let jailed
      try {
        const sc = splitCd(args?.command, wd)
        const rm = RENDER_CMD.exec(String(sc.command ?? ""))
        jailed = rm ? await renderCommand(rm[1] ?? "", v.zone, sc.cwd) : await jailCommand(sc.command, v.zone, sc.cwd)
      } catch (e) {
        jailed = { error: `не удалось подготовить песочницу (${String(e)})` }
      }
      if ("error" in jailed) {
        await log(`jail refused for tenant ${v.zone.tenant}: ${jailed.error}`)
        throw new Error(`Доступ запрещён: ${jailed.error}.`)
      }
      await log(`jail: tenant ${v.zone.tenant} (${String(sessionID).slice(0, 12)}) cwd=${fwd(wd)} cmd=${oneLine(String(args.command), 160)}`)
      // The stored part keeps the launcher line (admin sees it; tenants get tool
      // parts redacted by the portal); the model's history is unjailed in the
      // messages-transform (unjailPart).
      args.command = jailed.command
      await blockPlants(v.zone, sessionID, "before")
      return
    }
    // BUG-180: a write with an isolated CJK / U+FFFD fragment is refused before
    // any backup (admin and tenant alike); a repeat of the same call passes.
    if (v && WRITE_TOOLS.has(t)) {
      const own = zones.get(sessionID)?.dir ?? v.dir
      const leak = cjkGuard(t, sessionID, args, own)
      if (leak) {
        await log(`cjk guard ${leak.why ? "blocked" : "override"}: ${t} (${String(sessionID)?.slice(0, 12)}) «${oneLine(leak.fragment, 60)}»`)
        if (leak.why) throw new Error(leak.why)
      }
    }
    // BUG-146: only an allowed call gets here; relative paths resolve against
    // the calling session's own folder. backupForTool never throws.
    if (v && WRITE_TOOLS.has(t)) {
      const own = zones.get(sessionID)?.dir ?? v.dir
      await backupForTool(t, sessionID, args, own)
    }
  }

  function cjkGuard(tool, sessionID, args, cwd) {
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
      const seen = cjkOverrides.get(sessionID) ?? new Set()
      if (seen.has(key)) {
        seen.delete(key)
        return { why: "", fragment } // repeated on purpose
      }
      seen.add(key)
      if (seen.size > 50) seen.delete(seen.values().next().value)
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

  /**
   * Хук tool.execute.after (логика vault-cache.ts:1340-1353): карантин
   * подсаженных конфигов после bash/shell тенанта. Возвращает дописку к выводу
   * («[песочница] …») или null; адаптер сам приписывает её к результату.
   */
  async function after(tool, sessionID) {
    if (canonicalTool(tool) !== "bash") return null
    try {
      const v = await effectiveZone(sessionID)
      if (!v?.zone.tenant) return null
      const moved = await blockPlants(v.zone, sessionID, "after")
      if (moved.length)
        return `\n[песочница] Файлы конфигурации агента в папке пользователя запрещены и заблокированы: ${moved.map((p) => path.basename(p)).join(", ")}.`
      return null
    } catch (e) {
      await log(`plant guard error (${String(sessionID)?.slice(0, 12)}): ${String(e)}`)
      return null
    }
  }

  return { zoneForSession, effectiveZone, rootSession, chatDirOf, startTurn, seal, before, after }
}
