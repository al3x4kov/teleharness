// Multi-tenant auth for the Teleharness portal. Zero runtime deps — node stdlib only.
//
// Model:
//   • Every user carries one long API token (64 hex). The store keeps only its
//     SHA-256; the plaintext is shown ONCE at creation and never again.
//   • Login = POST the token, server answers with a persistent HttpOnly cookie
//     (the "device remembers" part — EventSource and file downloads ride the
//     same cookie, no headers needed). Logout clears it.
//   • A tenant scope = chat directories + extra file roots (the Obsidian
//     zone). role:"admin" is UNRESTRICTED: every session in every directory,
//     the whole vault — the pre-tenancy world became the admin tenant.
//   • Non-admin users never touch admin routes (user management, usage) and
//     their chats/files/events are filtered to their own scope server-side,
//     so the portal cannot be administered from a tenant chat.
//
// Storage: data/users.json (atomic tmp+rename writes). The admin user is
// seeded on first boot; the bootstrap token comes from TELEHARNESS_ADMIN_TOKEN (or is
// random) and is also written to data/admin-token.txt for the owner.
//
// Sessions (TASK-12.21, 2026-11-02): the cookie no longer carries the raw
// year-long token. Login mints a random sid; data/sessions.json keeps only
// sha256(sid) → userId. Logout, token regeneration, disable and delete
// revoke the sids. Legacy cookies (raw token, Path=/) are still accepted
// once and migrated to a sid cookie by server.js (ADR-009 п.4).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { dirProblem, dirProblemText, scopeReferenced } from "./paths.js";

export const DATA_DIR = config.TELEHARNESS_DATA_DIR;
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, "admin-token.txt");
const COOKIE = config.TELEHARNESS_COOKIE_NAME;
// Isolated instances (QA stand on 127.0.0.1:4172 next to prod on :4170) MUST
// override this: cookies are scoped by domain, NOT port, so two instances on
// 127.0.0.1 share the cookie jar — logging into one silently logs the other
// out (their tokens live in different users.json stores).
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year: the device stays logged in
// ADR-009: the portal cookie is scoped to /teleharness — it must not ride along to
// /tv/* (TV API on :8099 and its logs) or the static tree of the same origin.
export const COOKIE_PATH = "/teleharness";

// Defaults for tenants created without explicit paths.
const TENANT_HOME = config.TELEHARNESS_TENANT_HOME;
const TENANT_VAULT = config.TELEHARNESS_TENANT_VAULT;

// Engines (ADR-004 п.1): admin gets both; a tenant gets opencode only unless
// the admin enables claude explicitly (users.json field `engines`).
export const ENGINES = ["opencode", "claude", "codex", "acp"];
// FEAT-18.7: Codex — только admin. Песочница Codex на Windows не
// настроена: разрешённая команда идёт с правами сервера — тенанту Codex не включается.
export const TENANT_ENGINES = ["opencode", "claude", "codex", "acp"];

let users = []; // cache; every mutation persists synchronously
// sha256(sid) → {userId, createdAt, lastSeenAt?}; persisted in sessions.json.
let sessions = new Map();
// TASK-04.15: lastSeenAt is refreshed in memory on every successful sid auth
// but rewritten to disk at most once per hour per session (SEC-26: the whole
// file is rewritten on every save). In-memory only; the file format gains a
// single optional field.
const lastSeenSaved = new Map(); // sidHash → ms of the last persisted save
const SEEN_SAVE_MS = 60 * 60 * 1000;

// --- token primitives --------------------------------------------------------

const sha256 = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");
const newToken = () => randomBytes(32).toString("hex");

function constantEquals(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// --- persistence --------------------------------------------------------------

function writeAtomic(file, obj) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, file);
}

function persist() {
  writeAtomic(USERS_FILE, { users });
}

function persistSessions() {
  try {
    writeAtomic(SESSIONS_FILE, { sessions: Object.fromEntries(sessions) });
  } catch (err) {
    console.error(`[teleharness-err] auth.persistSessions: ${err.message}`);
  }
}

// Thrown when users.json exists but cannot be used. server.js exits with
// the message instead of reseeding (BUG-12.13: a typo in the file used to
// silently recreate admin and drop every tenant).
export class StoreCorruptError extends Error {}

// null → no store yet (first boot). A file that exists but does not parse
// (or has no users array) is copied aside and reported — never overwritten.
function load() {
  if (!existsSync(USERS_FILE)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(USERS_FILE, "utf8"));
  } catch (err) {
    raw = { __error: err.message };
  }
  if (Array.isArray(raw?.users) && raw.users.every((u) => u && typeof u.id === "string" && typeof u.tokenHash === "string")) {
    return raw.users;
  }
  const aside = `${USERS_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    copyFileSync(USERS_FILE, aside);
  } catch {}
  throw new StoreCorruptError(
    `users.json повреждён (${raw?.__error ?? "нет массива users"}); копия: ${aside}. Исправьте файл или восстановите из копии — сервер не стартует, чтобы не потерять тенантов.`,
  );
}

function loadSessions() {
  lastSeenSaved.clear();
  try {
    const raw = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    const now = Date.now();
    const out = new Map();
    for (const [h, s] of Object.entries(raw?.sessions ?? {})) {
      // Records without lastSeenAt (pre TASK-04.15) load exactly as before.
      if (typeof s?.userId === "string" && now - Number(s.createdAt ?? 0) < COOKIE_MAX_AGE * 1000) out.set(h, s);
    }
    return out;
  } catch {
    return new Map(); // missing/corrupt: everyone re-logs in with the token
  }
}

// First boot: seed the admin tenant. The token is TELEHARNESS_ADMIN_TOKEN or random;
// the plaintext lands in the server log once and in admin-token.txt.
export function initAuth() {
  const existing = load();
  sessions = loadSessions();
  if (existing) {
    users = existing;
    return null;
  }
  const token = config.TELEHARNESS_ADMIN_TOKEN || newToken();
  users = [
    {
      id: "admin",
      name: "admin",
      role: "admin",
      tokenHash: sha256(token),
      // Admin = the world as it was before tenancy: every directory (empty
      // list = unrestricted) and the default file roots (null = server
      // default: the whole vault + portal).
      directories: [],
      extraRoots: [],
      obsidianRoot: null,
      createdAt: new Date().toISOString(),
      disabled: false,
    },
  ];
  persist();
  try {
    writeFileSync(ADMIN_TOKEN_FILE, token + "\n", "utf8");
  } catch {}
  console.log(`[teleharness-auth] admin token (bootstrap, also written to ${ADMIN_TOKEN_FILE}): ${token}`);
  return token;
}

// --- user records --------------------------------------------------------------

export function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    directories: u.directories ?? [],
    extraRoots: u.extraRoots ?? [],
    obsidianRoot: u.obsidianRoot ?? null,
    engines: enginesOf(u),
    createdAt: u.createdAt ?? null,
    disabled: !!u.disabled,
  };
}

export function enginesOf(u) {
  if (u?.role === "admin") return ENGINES.slice();
  const list = Array.isArray(u?.engines) ? u.engines.filter((e) => TENANT_ENGINES.includes(e)) : [];
  return list.length > 0 ? list : ["opencode"];
}

// ADR-004: may this user run chats on `engine`?
export function engineAllowed(user, engine) {
  if (!user) return false;
  if (engine === "acp" && process.env.TELEHARNESS_ACP === "off") return false;
  return enginesOf(user).includes(engine);
}

// Shared ACP auth profile owner (the portal admin performs the login).
export function adminUser() {
  return users.find((u) => u.role === "admin" && !u.disabled) ?? users.find((u) => u.role === "admin") ?? null;
}

function findUser(id) {
  return users.find((u) => u.id === id) ?? null;
}

// Resolve a presented token to a live user (timing-safe per candidate).
export function userByToken(token) {
  if (typeof token !== "string" || token.length < 16) return null;
  const h = sha256(token);
  const u = users.find((x) => constantEquals(x.tokenHash, h));
  if (!u || u.disabled) return null;
  return u;
}

export function listUsers() {
  return users.map(publicUser);
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,31}$/;
const cleanList = (v) =>
  Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// BUG-12.11: tenant directories and file roots go through the shared path
// policy (no drive roots, UNC, \\?\, system tree, portal tree, DATA_DIR,
// the owner's profile root). Throws ApiError(400) naming the field.
const tenantPathOpts = () => ({ tenant: true, dataDir: DATA_DIR, profileRoot: config.TELEHARNESS_HOME });
function assertTenantPaths(key, list) {
  for (const d of list) {
    const problem = dirProblem(d, tenantPathOpts());
    if (problem) throw new ApiError(400, `${key}: ${dirProblemText(problem)} (${d})`);
  }
}

function cleanEngines(v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((e) => !TENANT_ENGINES.includes(e))) throw new ApiError(400, `engines: допустимо ${TENANT_ENGINES.join(", ")}`);
  const list = [...new Set(v)];
  if (!list.includes("opencode")) list.unshift("opencode");
  return list;
}

// Create a tenant: name is a slug, directories default to a personal folder,
// extraRoots default to the personal Obsidian zone. Folders are created up
// front — a session in a missing directory dies on its first prompt
// (PlatformError realPath NotFound, live 2026-10-31). The token rides back
// ONCE in the response; only its hash is stored.
export function createUser({ name, directories, extraRoots, obsidianRoot, engines } = {}) {
  const slug = String(name ?? "").trim();
  if (!NAME_RE.test(slug)) throw new ApiError(400, "bad name (2-32 chars: letters, digits, - _)");
  if (findUser(slug)) throw new ApiError(409, "name already taken");
  const dirs = cleanList(directories);
  assertTenantPaths("directories", dirs);
  const roots = cleanList(extraRoots);
  assertTenantPaths("extraRoots", roots);
  const vault = obsidianRoot == null || String(obsidianRoot).trim() === "" ? path.join(TENANT_VAULT, slug) : String(obsidianRoot).trim();
  assertTenantPaths("obsidianRoot", [vault]);
  const eng = cleanEngines(engines);

  const chatDirs = dirs.length > 0 ? dirs : [path.join(TENANT_HOME, slug)];
  const fileRoots = roots.length > 0 ? roots : [vault];

  const user = {
    id: slug,
    name: slug,
    role: "user",
    tokenHash: null, // set below; the record never stores plaintext
    directories: chatDirs,
    extraRoots: fileRoots,
    obsidianRoot: vault,
    engines: eng ?? ["opencode"],
    createdAt: new Date().toISOString(),
    disabled: false,
  };
  // Provision before persisting: a tenant must be usable immediately.
  for (const d of [...new Set([...chatDirs, ...fileRoots, vault])]) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {}
  }
  const token = newToken();
  user.tokenHash = sha256(token);
  users.push(user);
  persist();
  return { user: publicUser(user), token };
}

// Body patch. Token material is never touchable here (regenerate instead);
// role stays admin-only-by-seeding: this endpoint cannot mint another admin.
export function updateUser(id, patch = {}) {
  const u = findUser(id);
  if (!u || u.role === "admin") throw new ApiError(404, "user not found");
  const next = {};
  if (patch.disabled !== undefined) next.disabled = !!patch.disabled;
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!NAME_RE.test(name)) throw new ApiError(400, "bad name");
    next.name = name;
  }
  for (const key of ["directories", "extraRoots"]) {
    if (patch[key] !== undefined) {
      const list = cleanList(patch[key]);
      assertTenantPaths(key, list);
      if (key === "directories" && list.length === 0) throw new ApiError(400, "directories cannot be empty");
      next[key] = list;
    }
  }
  if (patch.obsidianRoot !== undefined) {
    const v = String(patch.obsidianRoot).trim();
    if (v !== "") assertTenantPaths("obsidianRoot", [v]);
    next.obsidianRoot = v === "" ? null : v;
  }
  const eng = cleanEngines(patch.engines);
  if (eng) next.engines = eng;
  Object.assign(u, next);
  if (next.disabled) revokeUserSessions(u.id);
  // Scope widened? Make sure the folders exist before the tenant relies on them.
  for (const d of [...(next.directories ?? []), ...(next.extraRoots ?? [])]) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {}
  }
  persist();
  return publicUser(u);
}

// New token for an existing tenant; the old one stops working immediately.
export function regenerateToken(id) {
  const u = findUser(id);
  if (!u || u.role === "admin") throw new ApiError(404, "user not found");
  const token = newToken();
  u.tokenHash = sha256(token);
  persist();
  revokeUserSessions(id);
  return token;
}

// Self-service rotation (FEAT-03.11 server part, ADR-009 п.5 / TASK-12.21):
// any user — the admin included — swaps their own token; every existing
// session of that user dies. The caller mints a fresh session cookie.
export function rotateOwnToken(id) {
  const u = findUser(id);
  if (!u) throw new ApiError(404, "user not found");
  const token = newToken();
  u.tokenHash = sha256(token);
  persist();
  revokeUserSessions(id);
  return token;
}

// FEAT-03.22: the user's own system prompt (already cleaned by
// lib/user-prompt.js cleanSystemPrompt). Never part of publicUser: nobody but
// the user reads it (the admin's user list included).
export function getSystemPrompt(id) {
  const u = findUser(id);
  return typeof u?.systemPrompt === "string" ? u.systemPrompt : "";
}

export function setSystemPrompt(id, text) {
  const u = findUser(id);
  if (!u) throw new ApiError(404, "user not found");
  if (text) u.systemPrompt = text;
  else delete u.systemPrompt;
  persist();
  return getSystemPrompt(id);
}

// FEAT-18.6: «Продолжать автоматически при лимите» — {on, order} already
// cleaned by lib/auto-relay.js cleanAutoRelay (the route also checks that each
// model is available to the user). Off with no order = nothing stored.
export function getAutoRelay(id) {
  const u = findUser(id);
  const v = u?.autoRelay;
  return v && typeof v === "object" ? structuredClone(v) : null;
}

export function setAutoRelay(id, value) {
  const u = findUser(id);
  if (!u) throw new ApiError(404, "user not found");
  if (value && (value.on || value.order?.length)) u.autoRelay = { on: Boolean(value.on), order: value.order ?? [] };
  else delete u.autoRelay;
  persist();
  return getAutoRelay(id);
}

// FEAT-18.8: Настройки → Git — the user's own defaults for the Git screen:
// {authorName, authorEmail, messageLang: "ui"|"en", preselect:
// "modified"|"none", pushAllowed}. Nothing stored = the defaults: the
// account name, «<name in Latin letters>@teleharness.local», ui, modified,
// push allowed for the admin (owner mockup: the box is ticked) and NEVER for a
// tenant, whatever the store says (decision «5 а»).
export const GIT_NAME_MAX = 100;
export const GIT_EMAIL_MAX = 254;
const GIT_LANGS = ["ui", "en"];
const GIT_PRESELECT = ["modified", "none"];
const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n",
  о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

// "Анна Петрова" → "anna-petrova"; "admin" → "admin". Pure.
export function emailLocalPart(name) {
  const s = [...String(name ?? "").toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join("");
  const out = s.replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").replace(/-{2,}/g, "-").slice(0, 64);
  return out || "user";
}

export function gitDefaults(user) {
  const name = String(user?.name ?? user?.id ?? "user").trim() || "user";
  return { authorName: name, authorEmail: `${emailLocalPart(name)}@teleharness.local`, messageLang: "ui", preselect: "modified", pushAllowed: isAdmin(user) };
}

// A PUT body → the stored record (only the fields given; "" / null → back to
// the default). Throws ApiError(400) naming the field. Pure.
const GIT_FIELD_LABEL = { authorName: "Имя", authorEmail: "Почта", messageLang: "Язык сообщений", preselect: "Отмечать изменённые", pushAllowed: "Отправка" };
export function cleanGitSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "bad json body");
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  // TASK-18.13 D12: the text reaches Настройки → Git — field names in Russian
  const label = (k) => GIT_FIELD_LABEL[k] ?? k;
  const text = (k, max) => {
    const v = body[k];
    if (v === null || v === "") return null;
    if (typeof v !== "string") throw new ApiError(400, `${label(k)}: нужна строка`);
    const t = v.trim();
    if (!t) return null;
    if (t.length > max) throw new ApiError(400, `${label(k)}: не длиннее ${max} символов`);
    // newlines / control chars / <> would break the git ident line
    if (/[\u0000-\u001f\u007f<>]/.test(t)) throw new ApiError(400, `${label(k)}: недопустимые символы`);
    return t;
  };
  if (has("authorName")) out.authorName = text("authorName", GIT_NAME_MAX);
  if (has("authorEmail")) {
    const e = text("authorEmail", GIT_EMAIL_MAX);
    if (e !== null && !/^[^\s@]+@[^\s@]+$/.test(e)) throw new ApiError(400, "Почта: нужен адрес вида имя@домен");
    out.authorEmail = e;
  }
  if (has("messageLang")) {
    if (!GIT_LANGS.includes(body.messageLang)) throw new ApiError(400, "Язык сообщений: выберите один из вариантов");
    out.messageLang = body.messageLang;
  }
  if (has("preselect")) {
    if (!GIT_PRESELECT.includes(body.preselect)) throw new ApiError(400, "Отмечать изменённые: выберите один из вариантов");
    out.preselect = body.preselect;
  }
  if (has("pushAllowed")) {
    if (typeof body.pushAllowed !== "boolean") throw new ApiError(400, "Отправка: нужно включить или выключить");
    out.pushAllowed = body.pushAllowed;
  }
  return out;
}

// The effective settings of a user (defaults filled in).
export function getGitSettings(id) {
  const u = findUser(id);
  const def = gitDefaults(u ?? { id });
  const v = u?.git && typeof u.git === "object" ? u.git : {};
  const pick = (k) => (v[k] !== undefined && v[k] !== null ? v[k] : def[k]);
  return {
    authorName: pick("authorName"),
    authorEmail: pick("authorEmail"),
    messageLang: GIT_LANGS.includes(v.messageLang) ? v.messageLang : def.messageLang,
    preselect: GIT_PRESELECT.includes(v.preselect) ? v.preselect : def.preselect,
    pushAllowed: isAdmin(u) ? (typeof v.pushAllowed === "boolean" ? v.pushAllowed : def.pushAllowed) : false,
  };
}

// patch: cleanGitSettings output. A tenant's pushAllowed is never stored.
export function setGitSettings(id, patch) {
  const u = findUser(id);
  if (!u) throw new ApiError(404, "user not found");
  const next = { ...(u.git && typeof u.git === "object" ? u.git : {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k === "pushAllowed" && !isAdmin(u)) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  if (Object.keys(next).length) u.git = next;
  else delete u.git;
  persist();
  return getGitSettings(id);
}

// FEAT-01.69: the user's pinned chats — session ids in pin order (the oldest
// pin first), stored in the account so every device of the user sees the
// same list; another user never reads it (not in publicUser either).
// Visibility (a foreign / unknown id) is the route's job — it knows the
// session index; here only the shape: strings of the session-id alphabet,
// duplicates collapsed, at most PINS_MAX.
export const PINS_MAX = 200;
const PIN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function cleanPins(list) {
  if (!Array.isArray(list)) throw new ApiError(400, "ids: нужен массив id чатов");
  const out = [];
  const seen = new Set();
  for (const x of list) {
    if (typeof x !== "string" || !PIN_ID_RE.test(x) || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= PINS_MAX) break;
  }
  return out;
}

export function getPins(id) {
  const u = findUser(id);
  return Array.isArray(u?.pins) ? u.pins.filter((x) => typeof x === "string" && PIN_ID_RE.test(x)) : [];
}

export function setPins(id, ids) {
  const u = findUser(id);
  if (!u) throw new ApiError(404, "user not found");
  const clean = cleanPins(ids);
  if (clean.length > 0) u.pins = clean;
  else delete u.pins;
  persist();
  return getPins(id);
}

// A deleted chat leaves every user's pins (an admin may have pinned a
// tenant's chat). Returns how many lists changed; persists only then.
export function dropPinEverywhere(sessionId) {
  let changed = 0;
  for (const u of users) {
    if (!Array.isArray(u.pins) || !u.pins.includes(sessionId)) continue;
    u.pins = u.pins.filter((x) => x !== sessionId);
    if (u.pins.length === 0) delete u.pins;
    changed++;
  }
  if (changed) persist();
  return changed;
}

// rm is injectable for tests (default: recursive rmSync with retries).
// The pins live in the record — deleting the account deletes them too.
export function deleteUser(id, { rm = null } = {}) {
  const u = findUser(id);
  if (!u || u.role === "admin") throw new ApiError(404, "user not found");
  users = users.filter((x) => x.id !== id);
  persist();
  revokeUserSessions(id);
  const { removed, failed } = removeTenantFolders(u, rm);
  return { removedDirs: removed, failedDirs: failed };
}

// A copy of a user record (directories included) — server.js needs the
// scope of an account it is about to delete. null when unknown.
export function getUser(id) {
  const u = findUser(id);
  return u ? structuredClone(u) : null;
}

// True when any CURRENT user's directories / roots contain, equal or sit
// inside `dir` (a pending folder removal must never touch a live scope).
// exceptId: ignore that user (the account being deleted).
export function dirReferenced(dir, exceptId = null) {
  // BUG-17.14: сравнение по платформе — lib/paths.js (на POSIX склейка с «\\» не работала)
  return scopeReferenced(users, dir, { exceptId, norm: normDir });
}

// ISSUE-015 (final review 2026-11-02): deleting an account removes the
// folders the portal PROVISIONED for it — and nothing else. A folder goes
// only when ALL hold:
//   • it is exactly <TELEHARNESS_TENANT_HOME>\<id> or <TELEHARNESS_TENANT_VAULT>\<id> (the
//     createUser defaults), never a custom directory the admin typed in;
//   • it is still one of the deleted user's own directories/roots;
//   • no remaining user references it (or anything inside/above it);
//   • it is a real directory, not a junction/symlink pointing elsewhere.
// Returns {removed: [path], failed: [{path, reason}]} — BUG-04.6 / BUG-077: a
// folder that could not be removed (opencode still holds it) is REPORTED,
// never swallowed; server.js answers it as `warnings` and retries later.
const defaultRm = (p) => rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

function removeTenantFolders(u, rm = null) {
  const own = new Set([...(u.directories ?? []), ...(u.extraRoots ?? []), u.obsidianRoot].filter(Boolean).map(normDir));
  const removed = [];
  const failed = [];
  for (const root of [TENANT_HOME, TENANT_VAULT]) {
    if (!root) continue;
    const cand = path.join(root, u.id);
    const n = normDir(cand);
    if (!n || !own.has(n)) continue;
    if (path.basename(cand) !== u.id || normDir(path.dirname(cand)) !== normDir(root)) continue;
    const shared = scopeReferenced(users, n, { norm: normDir }); // BUG-17.14
    if (shared) continue;
    let st;
    try {
      st = lstatSync(cand);
    } catch {
      continue; // nothing there
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    try {
      (rm ?? defaultRm)(cand);
      if (existsSync(cand)) throw Object.assign(new Error("папка осталась после удаления (занята процессом)"), { code: "EBUSY" });
      removed.push(cand);
    } catch (err) {
      failed.push({ path: cand, reason: `${err?.code ?? "ERR"}: ${err?.message ?? err}` });
    }
  }
  return { removed, failed };
}

// --- server-side sessions (TASK-12.21) -------------------------------------------

export function createSession(user) {
  const sid = randomBytes(32).toString("base64url");
  const now = Date.now();
  sessions.set(sha256(sid), { userId: user.id, createdAt: now, lastSeenAt: now });
  lastSeenSaved.set(sha256(sid), now);
  persistSessions();
  return sid;
}

export function destroySession(sid) {
  if (typeof sid !== "string" || !sid) return;
  if (sessions.delete(sha256(sid))) {
    lastSeenSaved.delete(sha256(sid));
    persistSessions();
  }
}

export function revokeUserSessions(userId) {
  dropUserPairCodes(userId); // FEAT-18.2: a pending phone link dies with the sessions
  let n = 0;
  for (const [h, s] of sessions) {
    if (s.userId === userId) {
      sessions.delete(h);
      lastSeenSaved.delete(h);
      n++;
    }
  }
  if (n > 0) persistSessions();
  return n;
}

// TASK-04.15 (SEC-26): hourly sweep — records older than the cookie life are
// dead (the browser drops its cookie by Max-Age anyway). Inactivity-based
// removal is NOT introduced (that would log devices out — owner's call);
// inactivity is only counted, see authSessionsStale90d. Returns the number
// of removed records; the file is rewritten only when something was removed.
export function sweepSessions(now = Date.now()) {
  let n = 0;
  for (const [h, s] of sessions) {
    if (now - s.createdAt >= COOKIE_MAX_AGE * 1000) {
      sessions.delete(h);
      lastSeenSaved.delete(h);
      n++;
    }
  }
  if (n > 0) persistSessions();
  return n;
}

// TASK-04.15: how many sessions have not been seen for 90 days (lastSeenAt;
// records from before the field existed fall back to createdAt). Reported in
// healthz `store.authSessionsStale90d`; deletes nothing.
export function authSessionsStale90d(now = Date.now()) {
  let n = 0;
  for (const s of sessions.values()) {
    if (now - Number(s.lastSeenAt ?? s.createdAt ?? 0) >= 90 * 86_400_000) n++;
  }
  return n;
}

function userBySid(sid, now = Date.now()) {
  if (typeof sid !== "string" || sid.length < 20) return null;
  const h = sha256(sid);
  const s = sessions.get(h);
  if (!s) return null;
  if (now - s.createdAt > COOKIE_MAX_AGE * 1000) {
    sessions.delete(h);
    lastSeenSaved.delete(h);
    return null;
  }
  const u = findUser(s.userId);
  if (!u || u.disabled) return null;
  // TASK-04.15: touch on every successful auth; to disk at most once per
  // hour per session.
  s.lastSeenAt = now;
  if (now - (lastSeenSaved.get(h) ?? 0) >= SEEN_SAVE_MS) {
    lastSeenSaved.set(h, now);
    persistSessions();
  }
  return u;
}

export function sessionCount() {
  return sessions.size;
}

// --- scope (tenant visibility) --------------------------------------------------

export function isAdmin(user) {
  return user?.role === "admin";
}

// Windows paths are case-insensitive; normalize for comparison.
// TASK-17.1: on POSIX the case is significant (/home/A ≠ /home/a) — no folding.
// Один аргумент: normDir идёт в .map(normDir) — второй аргумент там индекс.
export function normDir(d) {
  return normDirFor(d, process.platform);
}

export function normDirFor(d, platform) {
  try {
    if (platform === "win32") return path.win32.resolve(String(d)).replace(/[\\/]+$/, "").toLowerCase();
    const r = path.posix.resolve(String(d));
    return r.length > 1 ? r.replace(/\/+$/, "") : r;
  } catch {
    return null;
  }
}

export function dirAllowed(user, dir) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  const n = normDir(dir);
  if (!n) return false;
  return (user.directories ?? []).some((d) => normDir(d) === n);
}

// First directory for unscoped calls: admins pin the classic HOME, a tenant
// pins its own first chat folder (never the owner's home!).
export function defaultDir(user, home) {
  if (isAdmin(user)) return home;
  return (user.directories ?? [])[0] ?? home;
}

// Extra file roots for /teleharness/api/file: tenants are pinned to their own roots.
// BUG-249: the admin owns the machine and works everywhere (stage worktrees,
// /tmp) — a file the agent shows by absolute path must open for him, so the
// admin gets the server default plus every filesystem root. Lexical+realpath
// checks and the CSP sandbox for active documents (lib/file.js) still apply.
export function fileRoots(user, serverDefault) {
  if (isAdmin(user)) return [...(serverDefault ?? config.TELEHARNESS_FILE_ROOTS ?? []), ...filesystemRoots()];
  return (user.extraRoots ?? []).filter(Boolean);
}

function filesystemRoots() {
  if (process.platform !== "win32") return ["/"];
  const roots = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ":\\";
    if (existsSync(d)) roots.push(d);
  }
  return roots;
}

// --- cookies ---------------------------------------------------------------------

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    // A malformed %-escape in ANY cookie (even a foreign one) threw URIError
    // and crashed server.js for an unauthenticated request (full review
    // 2026-11-02, P0). Undecodable values are kept raw — never thrown.
    const raw = part.slice(i + 1).trim();
    let val = raw;
    try {
      val = decodeURIComponent(raw);
    } catch {}
    out[part.slice(0, i).trim()] = val;
  }
  return out;
}

// Every value carried under `name` (a browser mid-migration sends both the
// new Path=/teleharness cookie and the legacy Path=/ one under the same name).
export function cookieValues(header, name = COOKIE) {
  const out = [];
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    const raw = part.slice(i + 1).trim();
    let val = raw;
    try {
      val = decodeURIComponent(raw);
    } catch {}
    out.push(val);
  }
  return out;
}

// The legacy cookie lived on Path=/; expiring it is part of every cookie
// write until the migration window closes (ADR-009 п.4, remove after
// 2026-12-02).
const LEGACY_CLEAR = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// Session cookie: Path=/teleharness, HttpOnly, SameSite=Lax, Secure behind https.
// The new cookie goes FIRST (tests and simple clients take the first match).
export function setAuthCookie(res, sid, secure) {
  const main = [`${COOKIE}=${sid}`, `Path=${COOKIE_PATH}`, "HttpOnly", "SameSite=Lax", `Max-Age=${COOKIE_MAX_AGE}`, ...(secure ? ["Secure"] : [])].join("; ");
  res.setHeader("set-cookie", [main, LEGACY_CLEAR]);
}

export function clearAuthCookie(res, secure = false) {
  const main = `${COOKIE}=; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  res.setHeader("set-cookie", [main, LEGACY_CLEAR]);
}

// Full auth resolution: {user, kind, sid?, legacy?} or null.
//   kind "bearer" — Authorization: Bearer <token> (scripts/curl);
//   kind "sid"    — a live server session;
//   kind "legacy" — a raw-token cookie from before TASK-12.21: accepted, and
//                   server.js swaps it for a sid cookie on the same response.
// Every cookie value under the name is tried (old + new during migration).
// TASK-04.15 (SEC-27): the legacy branch is accepted only while now is on or
// before TELEHARNESS_LEGACY_COOKIE_UNTIL (inclusive — through the end of that UTC
// day); after the deadline a legacy cookie acts as no cookie at all. A
// garbage date closes the window at once (fail closed). Tests inject "now"
// via the second argument; production callers use the real clock.
const LEGACY_UNTIL_MS = (() => {
  const t = Date.parse(`${config.TELEHARNESS_LEGACY_COOKIE_UNTIL}T00:00:00Z`);
  return Number.isFinite(t) ? t + 86_400_000 : 0;
})();

export function authFromReq(req, now = Date.now()) {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const user = userByToken(auth.slice(7).trim());
    return user ? { user, kind: "bearer" } : null;
  }
  const values = cookieValues(req.headers.cookie);
  for (const v of values) {
    const user = userBySid(v, now);
    if (user) return { user, kind: "sid", sid: v };
  }
  if (now < LEGACY_UNTIL_MS) {
    for (const v of values) {
      const user = userByToken(v);
      if (user) return { user, kind: "legacy" };
    }
  }
  return null;
}

// The request's user, or null. Bearer tokens are accepted for scripting/curl.
export function userFromReq(req) {
  return authFromReq(req)?.user ?? null;
}

// --- login throttling (TASK-04.15, SRV-21) --------------------------------------

// Failed logins per client address, fixed 60 s window. Once 10 failures are
// on record, further attempts from that address are throttled: handleLogin
// answers 429 without touching the token. A success resets the address. The
// map cannot grow without bound: every failure prunes expired windows and
// beyond a hard cap the oldest entries are dropped.
const LOGIN_FAIL_WINDOW_MS = 60_000;
const LOGIN_FAIL_MAX = 10;
const LOGIN_FAIL_CAP = 10_000;
const loginFails = new Map(); // address → {start, n}

function pruneLoginFails(now) {
  for (const [k, w] of loginFails) {
    if (now - w.start >= LOGIN_FAIL_WINDOW_MS) loginFails.delete(k);
  }
  while (loginFails.size > LOGIN_FAIL_CAP) {
    const oldest = [...loginFails.entries()].sort((a, b) => a[1].start - b[1].start)[0];
    loginFails.delete(oldest[0]);
  }
}

// True when this address already has LOGIN_FAIL_MAX failures in the window.
export function loginThrottled(ip, now = Date.now()) {
  const w = loginFails.get(ip);
  if (!w) return false;
  if (now - w.start >= LOGIN_FAIL_WINDOW_MS) return false; // expired window
  return w.n >= LOGIN_FAIL_MAX;
}

export function loginFailure(ip, now = Date.now()) {
  pruneLoginFails(now);
  let w = loginFails.get(ip);
  if (!w || now - w.start >= LOGIN_FAIL_WINDOW_MS) {
    w = { start: now, n: 0 };
    loginFails.set(ip, w);
  }
  w.n += 1;
  return w.n;
}

export function loginSuccess(ip) {
  loginFails.delete(ip);
}

// --- phone pairing (FEAT-18.2) ----------------------------------------------------

// «Подключить телефон»: a signed-in user mints a one-time sign-in code for
// THEIR OWN account (nobody — the admin included — mints one for another
// user; the route passes the caller's id only). The code is 32 random bytes
// (base64url), shown once as a QR / link; only sha256(code) is kept, in
// memory: a code lives PAIR_TTL_MS and dies on a restart (the user shows a
// new QR). claimPairCode swaps it for an ordinary session exactly once.
// A used or expired code stays on record until its TTL runs out so the
// phone hears «истекла или уже использована» (410), not «неизвестна» (401).
export const PAIR_TTL_MS = 10 * 60 * 1000;
export const PAIR_MAX_ACTIVE = 5; // live (unused, unexpired) codes per user
const PAIR_CAP = 10_000; // hard cap of the map (expired records are pruned first)
const PAIR_CODE_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes in base64url, no padding
const pairCodes = new Map(); // sha256(code) → {userId, createdAt, expiresAt, usedAt}

function prunePairCodes(now) {
  for (const [h, c] of pairCodes) if (now >= c.expiresAt) pairCodes.delete(h);
  while (pairCodes.size > PAIR_CAP) pairCodes.delete(pairCodes.keys().next().value);
}

// → {code, expiresAt (ms)}; ApiError 429 beyond PAIR_MAX_ACTIVE live codes.
export function createPairCode(userId, now = Date.now()) {
  const u = findUser(userId);
  if (!u || u.disabled) throw new ApiError(404, "user not found");
  prunePairCodes(now);
  let live = 0;
  for (const c of pairCodes.values()) if (c.userId === u.id && !c.usedAt) live++;
  if (live >= PAIR_MAX_ACTIVE) throw new ApiError(429, "слишком много активных кодов — подождите несколько минут");
  const code = randomBytes(32).toString("base64url");
  const expiresAt = now + PAIR_TTL_MS;
  pairCodes.set(sha256(code), { userId: u.id, createdAt: now, expiresAt, usedAt: 0 });
  return { code, expiresAt };
}

// → the live user the code belongs to; the code is burnt on success.
// ApiError 401 — unknown / malformed code (or its account is gone);
// ApiError 410 — known but already used or expired.
export function claimPairCode(code, now = Date.now()) {
  if (typeof code !== "string" || !PAIR_CODE_RE.test(code)) throw new ApiError(401, "ссылка недействительна");
  const h = sha256(code);
  const c = pairCodes.get(h);
  if (!c) throw new ApiError(401, "ссылка недействительна");
  if (c.usedAt || now >= c.expiresAt) throw new ApiError(410, "ссылка истекла или уже использована");
  c.usedAt = now; // burnt before anything else can fail: one use, whatever happens next
  const u = findUser(c.userId);
  if (!u || u.disabled) throw new ApiError(401, "ссылка недействительна");
  return u;
}

// Codes of a user die with their sessions (token rotation, disable, delete).
function dropUserPairCodes(userId) {
  for (const [h, c] of pairCodes) if (c.userId === userId) pairCodes.delete(h);
}

export function pairCodeCount() {
  return pairCodes.size;
}

// Claim attempts: failures per client address (fixed 60 s window, like the
// login throttle) plus one global failure window — a botnet guessing codes
// from many addresses is throttled too. 32 random bytes are not guessable;
// the limits keep the endpoint cheap, not the secret safe.
const CLAIM_WINDOW_MS = 60_000;
const CLAIM_FAIL_MAX = 10;
const CLAIM_FAIL_GLOBAL_MAX = 100;
const claimFails = new Map(); // address → {start, n}
let claimGlobal = { start: 0, n: 0 };

export function claimThrottled(ip, now = Date.now()) {
  if (now - claimGlobal.start < CLAIM_WINDOW_MS && claimGlobal.n >= CLAIM_FAIL_GLOBAL_MAX) return true;
  const w = claimFails.get(ip);
  return !!w && now - w.start < CLAIM_WINDOW_MS && w.n >= CLAIM_FAIL_MAX;
}

export function claimFailure(ip, now = Date.now()) {
  for (const [k, w] of claimFails) if (now - w.start >= CLAIM_WINDOW_MS) claimFails.delete(k);
  while (claimFails.size > LOGIN_FAIL_CAP) claimFails.delete(claimFails.keys().next().value);
  let w = claimFails.get(ip);
  if (!w) {
    w = { start: now, n: 0 };
    claimFails.set(ip, w);
  }
  w.n += 1;
  if (now - claimGlobal.start >= CLAIM_WINDOW_MS) claimGlobal = { start: now, n: 0 };
  claimGlobal.n += 1;
  return w.n;
}

// Tests: forget the claim windows (the module state outlives a test case).
export function resetClaimThrottle() {
  claimFails.clear();
  claimGlobal = { start: 0, n: 0 };
}
