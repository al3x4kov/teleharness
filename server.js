// zai server: static UI from public/ plus /zai/api/* served either by the
// fixture mock (ZAI_MOCK=1) or by the real opencode proxy + SSE hub.
// Zero runtime dependencies - node stdlib only.
import http from "node:http";
import { tenantJailFor, tenantKit } from "./lib/claude-tenant.js";
import { ensureChatFolder, existingChatFolder } from "./lib/chat-folder.js";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, configErrors, configSources, describeConfig } from "./lib/config.js";
import { mockHandler } from "./lib/mock.js";
import { pageParams, paginateMessages, proxyRequest } from "./lib/proxy.js";
import { serveStatic } from "./lib/static.js";
import { EventHub } from "./lib/hub.js";
import { hostStats, opencodeVersion, harnessVersions } from "./lib/host.js";
import { usageStats } from "./lib/usage.js";
import { materializeFileParts, modelAcceptsImages, pickUniqueName, sanitizeFilename, UPLOAD_DIR, visionSibling } from "./lib/attach.js";
import { serveWorkspaceFile, workspaceFileExists } from "./lib/file.js";
import { parseWindows, turnFiles } from "./lib/turn-files.js";
import { dirProblem, dirProblemText, driveProblem, isUnderAny } from "./lib/paths.js";
import { accessLogger, clientIp, errLog, requestId } from "./lib/accesslog.js";
import { adminAgentFor, adminDefaultAgent, agentAllowedForTenant, defaultTenantAgent, modelInCatalog, parseModelRef, pickDefaultModel, providerForUser, publicAgent, redactMessages, redactPart, setTenantVaultRoots, tenantAgents } from "./lib/policy.js";
import { PendingRemovals, findOwnerlessTenantDirs, planGc, runEmptyChatGc, sweepOwnerlessTenantDirs, sweepTurnUndo } from "./lib/gc.js";
import { TurnUndo, isInside, physicalDir } from "./lib/turn-undo.js";
import { AutoTitler, TitleStore, makeClaudeTitler } from "./lib/title.js";
import { markEmptyTail } from "./lib/empty-turn.js";
import { buildSnapshot as buildKbSnapshot, zoneForUser as kbZoneForUser } from "./lib/kb-cache.js";
import { storeKbTrace } from "./lib/kb-trace.js";
import { dispatchRoute, validateTable } from "./routes/router.js";
import { fileRoutes } from "./routes/files.js";
import { catalogRoutes } from "./routes/catalog.js";
import { adminRoutes } from "./routes/admin.js";
import { SYSTEM_PROMPT_MAX, cleanSystemPrompt, withUserSystemBody } from "./lib/user-prompt.js";
import { withGlmVariantBody } from "./lib/glm-variant.js";
import { commandBody, parseSlash } from "./lib/slash.js";
import { createInstanceHealth } from "./lib/instance-health.js";
import { sessionRoutes } from "./routes/session.js";
import { pushRoutes } from "./routes/push.js";
import { PushNotifier, PushStore, loadOrCreateVapid, vapidKeyObject } from "./lib/push.js";
import {
  initAuth,
  authFromReq,
  userByToken,
  setAuthCookie,
  clearAuthCookie,
  createSession,
  destroySession,
  rotateOwnToken,
  getSystemPrompt,
  setSystemPrompt,
  cleanPins,
  getPins,
  setPins,
  dropPinEverywhere,
  PINS_MAX,
  engineAllowed,
  enginesOf,
  sessionCount,
  isAdmin,
  dirAllowed,
  defaultDir,
  fileRoots,
  listUsers,
  createUser,
  updateUser,
  regenerateToken,
  deleteUser,
  getUser,
  dirReferenced,
  normDir,
  ApiError,
  DATA_DIR,
} from "./lib/auth.js";
import { ClaudeRunner, DEFAULT_BIN as CLAUDE_DEFAULT_BIN, checkMcpConfig } from "./lib/claude.js";
import { ClaudeAgentCatalog, isClaudeAgentId } from "./lib/claude-agents.js";
import { VoiceQuota, VoiceService } from "./lib/voice.js";
import { voiceRoutes } from "./routes/voice.js";
import { BindingStore, applyBinding, cleanModel, engineOf, makeBinding, patchBinding, resolveBinding } from "./lib/binding.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// TASK-12.19 / ADR-006: a typo in env (ZAI_STALL_ABORT_MS=9oo000) is a
// startup error with a readable message, not a silently disabled watchdog.
if (configErrors.length > 0) {
  for (const e of configErrors) console.error(`[zai-config] ${e}`);
  process.exit(1);
}
console.log(`[zai-config] ${describeConfig(config, configSources)}`);

const PORT = config.PORT;
const MOCK = config.ZAI_MOCK;
const UPSTREAM = config.ZAI_UPSTREAM;
// BUG-183: poisoned opencode per-folder services (lib/instance-health.js) — warm-up and self-heal.
const instanceHealth = createInstanceHealth({ upstream: UPSTREAM, log: (m) => console.log(m) });
// BUG-171: Sandbox may reach the tenants' knowledge-base root (each tenant its own zone — plugin guard).
setTenantVaultRoots([config.ZAI_TENANT_VAULT]);
// ADR-003 п.2 (Г8): a stand/test instance never talks to the prod opencode —
// the stand used to see, prompt and delete every prod session (BUG-12.8).
if (config.ZAI_ENV !== "prod" && !MOCK) {
  let upPort = "";
  try {
    const u = new URL(UPSTREAM);
    upPort = u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {}
  if (upPort === "4096") {
    console.error(`[zai-config] ZAI_ENV=${config.ZAI_ENV} отказывается работать с прод-upstream :4096 (${UPSTREAM})`);
    process.exit(1);
  }
}
// Auto-unstick: a turn stuck busy with zero events for this long gets a
// server-side abort (opencode has no watchdog; hung sessions would otherwise
// stay dead forever — live incident 2026-10-31). 0 disables.
const STALL_ABORT_MS = config.ZAI_STALL_ABORT_MS;
// Auto-unstick part 2: an open permission/question dialog older than this is
// auto-denied server-side (permission → {reply:"reject"}, question → reject).
// 0 (the default, FEAT-07.15) = never auto-deny: a dialog waits for the human.
const DIALOG_TIMEOUT_MS = config.ZAI_DIALOG_TIMEOUT_MS;
// Auto-unstick part 3: the hub re-posts the last unanswered prompt once it
// has sat this long while idle; STALL_REPLAY_MAX caps the chain. 0 disables.
const STALL_REPLAY_MS = config.ZAI_STALL_REPLAY_MS;
const STALL_REPLAY_MAX = config.ZAI_STALL_REPLAY_MAX;
// Merged /zai/api/status cache TTL (the cache lives in routes/catalog.js).
const STATUS_TTL_MS = 3000;
const STARTED_AT = Date.now();
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
})();

// ADR-007 п.5: the reason of a crash must reach the log. Route-level errors
// never get here (every request is guarded below and answers 500); what
// arrives is a throw from a timer/stream callback — the process state is
// unknown, so log with the stack and exit for the watchdog to restart.
// A stray rejected promise is logged and the process keeps serving.
process.on("uncaughtException", (err) => {
  console.error(`[zai-fatal] uncaughtException: ${err?.stack ?? err}`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  errLog("unhandledRejection", err);
});

// Tenant store: data/users.json seeded on first boot. A corrupt store stops
// the server with a readable reason (BUG-12.13) instead of reseeding.
try {
  initAuth();
} catch (err) {
  console.error(`[zai-auth] ${err.message}`);
  process.exit(1);
}

const logAccess = accessLogger({ dir: config.ZAI_LOG_DIR, enabled: config.ZAI_ACCESS_LOG });

// Server-side session index (id -> directory): the authorization source for
// every session-scoped call. The client-supplied ?directory= is a hint, never
// a trust anchor — the record in the upstream index decides.
const INDEX_TTL_MS = 10_000;
let sessionIndex = { at: 0, byId: new Map(), recById: new Map() };

async function fetchSessionIndex(force = false) {
  if (!force && Date.now() - sessionIndex.at < INDEX_TTL_MS) return sessionIndex.byId;
  try {
    const r = await fetch(`${UPSTREAM}/session`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const list = await r.json();
      const byId = new Map();
      const recById = new Map();
      if (Array.isArray(list)) {
        for (const s of list) {
          if (typeof s?.id !== "string") continue;
          byId.set(s.id, s.directory ?? null);
          recById.set(s.id, s);
        }
      }
      sessionIndex = { at: Date.now(), byId, recById };
    } else {
      errLog("fetchSessionIndex", new Error(`upstream ${r.status}`));
    }
  } catch (err) {
    errLog("fetchSessionIndex", err); // upstream down: keep serving the last known index
  }
  return sessionIndex.byId;
}

// Full upstream record (model/agent live here once opencode ran a turn) —
// binding inference input. force: a chat created seconds ago.
async function sessionRecord(id, force = false) {
  await fetchSessionIndex();
  if (!sessionIndex.recById.has(id) && force) await fetchSessionIndex(true);
  return sessionIndex.recById.get(id) ?? null;
}

// A session created seconds ago is missing from a warm cache: one forced
// refresh closes that gap before any 403/404 is decided.
async function resolveSessionDir(id) {
  let byId = await fetchSessionIndex();
  if (!byId.has(id)) {
    byId = await fetchSessionIndex(true);
  }
  return byId.get(id) ?? null;
}

// Upstream query where the directory is NOT taken from the client (tenants).
function scopedQuery(q, dir) {
  const u = new URLSearchParams(q ?? "");
  u.set("directory", dir);
  const s = u.toString();
  return s ? `?${s}` : "";
}

// Upstream agent catalog (60s cache) — the tenant policy input (BUG-12.5).
let agentCache = { at: 0, list: null };
async function agentList() {
  if (agentCache.list && Date.now() - agentCache.at < 60_000) return agentCache.list;
  try {
    const r = await fetch(`${UPSTREAM}/agent`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const list = await r.json();
      if (Array.isArray(list)) agentCache = { at: Date.now(), list };
    }
  } catch (err) {
    errLog("agentList", err);
  }
  return agentCache.list ?? [];
}

// BUG-188: names of the slash commands of a chat folder (GET /command?directory=…),
// 60 s cache per folder — the same TTL as the agent catalog. On upstream
// failure the stale set lives on; nothing known → empty set → the text goes
// as a plain prompt (a command never blocks a turn).
const commandCache = new Map(); // dir → {at, names:Set}
async function commandNames(dir) {
  const key = dir ?? "";
  const hit = commandCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.names;
  try {
    const r = await fetch(`${UPSTREAM}/command${scopedQuery("", dir)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const list = await r.json();
      if (Array.isArray(list)) {
        const names = new Set(list.map((c) => (typeof c?.name === "string" ? c.name : "")).filter(Boolean));
        commandCache.set(key, { at: Date.now(), names });
        return names;
      }
    }
  } catch (err) {
    errLog("commandNames", err);
  }
  return hit?.names ?? new Set();
}

async function readJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  if (raw === null) return null;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

// BUG-12.12: ApiError messages are written for the client; anything else is
// internal (paths, upstream addresses) — logged with the request id, the
// client gets a generic text plus that id.
function apiError(res, err) {
  if (err instanceof ApiError) return sendJson(res, err.status, { error: err.message });
  return internalError(res, err, "apiError");
}

function internalError(res, err, place = "handler") {
  const rid = res.zaiRid ?? null;
  errLog(`${place} rid=${rid}`, err, { throttleMs: 0 });
  if (res.headersSent) return void res.destroy();
  return sendJson(res, 500, { error: "Внутренняя ошибка сервера", rid });
}

function upstreamError(res, err, place) {
  errLog(place, err);
  if (res.headersSent) return void res.destroy();
  return sendJson(res, 502, { error: "Сервер агента недоступен", rid: res.zaiRid ?? null });
}

// The edge sets x-forwarded-proto from its listener (ADR-009); this server
// listens on loopback only, so the header is trusted.
function isHttps(req) {
  return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

// POST /zai/api/auth/login {token}: the token is the credential itself; a
// match mints a random session id cookie (TASK-12.21) — the raw token never
// sits in the cookie jar. JSON only (BUG-12.9: a text/plain form could log a
// victim into the attacker's account).
async function handleLogin(req, res) {
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
    req.resume();
    return sendJson(res, 415, { error: "ожидается application/json" });
  }
  const body = await readJsonBody(req, 16 * 1024);
  const user = typeof body?.token === "string" ? userByToken(body.token) : null;
  if (!user) return sendJson(res, 401, { error: "invalid token" });
  setAuthCookie(res, createSession(user), isHttps(req));
  return sendJson(res, 200, { user: await meFace(user) });
}

// What the client needs to know about the caller (ISSUE-001/002, final
// review 2026-11-02): engines it may run, and for tenants the server-side
// default agent and their chat folders — the client sanitizes its stored
// defaults/projects against these instead of sending a request the policy
// will refuse with 403.
async function meFace(user) {
  const out = { id: user.id, name: user.name, role: user.role, engines: enginesOf(user) };
  if (!isAdmin(user)) {
    let agents = [];
    try {
      agents = await agentList();
    } catch {}
    out.defaultAgent = defaultTenantAgent(agents, config.ZAI_TENANT_AGENT);
    out.directories = (user.directories ?? []).slice();
  } else {
    // FEAT-16.2: the admin's default agent for new chats (opencode default_agent),
    // so a saved default gone from the catalog is replaced on the client.
    let agents = [];
    try {
      agents = await agentList();
    } catch {}
    const def = adminDefaultAgent(agents, await upstreamDefaultAgent());
    if (def) out.defaultAgent = def;
  }
  return out;
}

// prompt_async accepts huge context payloads and runs long upstream; the
// response itself (204) comes back immediately.
const PROMPT_OPTS = { method: "POST", timeoutMs: 600_000, bodyLimit: 64 * 1024 * 1024 };
const DEFAULT_OPTS = { timeoutMs: 30_000, bodyLimit: 2 * 1024 * 1024 };
// Binary uploads stream straight to disk (no base64, no V8 string limit):
// 100MB per file is the user-facing cap; tenants have their own (smaller)
// per-file limit and a total quota (BUG-12.10).
const UPLOAD_LIMIT = 100 * 1024 * 1024;

const hub = new EventHub({
  stallAbortMs: STALL_ABORT_MS,
  dialogTimeoutMs: DIALOG_TIMEOUT_MS,
  stallReplayMs: STALL_REPLAY_MS,
  maxPromptReplays: STALL_REPLAY_MAX,
  pendingStatePath: path.join(DATA_DIR, "hub-pending.json"), // BUG-07.12: replay counters survive restarts
  loopAbortCount: config.ZAI_LOOP_ABORT_COUNT, // BUG-07.7 (0 disables)
  promptUnstickMs: config.ZAI_PROMPT_UNSTICK_MS, // BUG-07.10
});

// FEAT-12.16: tenants never see raw tool input/output in the live stream
// either — the same redaction /message applies, as an SSE transform.
function redactEventForTenant(data) {
  if (!data.includes('"message.part.updated"')) return data;
  let ev;
  try {
    ev = JSON.parse(data);
  } catch {
    return data;
  }
  const part = ev?.properties?.part;
  if (ev?.type !== "message.part.updated" || !part || (part.type !== "tool" && part.type !== "patch")) return data;
  return JSON.stringify({ ...ev, properties: { ...ev.properties, part: redactPart(part) } });
}

// BUG-01.28: smoke/QA probes create chats under the system temp tree
// (%TEMP%\zai-claude-smoke, Temp\oc_*); those never belong in «Чаты».
const TEMP_ROOTS = [os.tmpdir(), process.env.TEMP, process.env.TMP].filter(Boolean);
function isTempSessionDir(dir) {
  return config.ZAI_HIDE_TEMP_SESSIONS && isUnderAny(dir, TEMP_ROOTS);
}

// Claude runner: prompts whose binding engine is "claude" run via the claude
// CLI instead of the opencode proxy.
// BUG-13.14: every finished claude turn pings the auto-titler (it acts once
// per chat). `titler` is assigned right below; the hook fires much later.
let titler = null;
// FEAT-07.20: Web Push context ({store, notifier, vapid, extraOrigins}),
// assigned below once the key is loaded; null = feature off.
let webPush = null;
// FEAT-13.17: Claude agents — shared/claude-agents (shipped) + data/claude-agents
// (local, override by id), compiled for the CLI into data/.
const claudeAgents = new ClaudeAgentCatalog({
  shippedDir: path.join(ROOT, "shared", "claude-agents"),
  dataDir: path.join(DATA_DIR, "claude-agents"),
  compiledPath: path.join(DATA_DIR, "claude-agents.compiled.json"),
  log: (m) => console.warn(m),
});
// FEAT-06.2: voice mode worker (Piper + GigaAM), started on first use.
const voiceService = config.ZAI_VOICE
  ? new VoiceService({ python: config.ZAI_VOICE_PYTHON, script: config.ZAI_VOICE_WORKER || path.join(ROOT, "ops", "voice", "voice-worker.py"), models: config.ZAI_VOICE_MODELS })
  : null;
const voiceQuota = new VoiceQuota({ ttsChars: config.ZAI_VOICE_TENANT_TTS_CHARS, sttSeconds: config.ZAI_VOICE_TENANT_STT_SEC });
// FEAT-13.10: Playwright (and other) MCP servers for ADMIN claude chats; a
// missing/broken file is logged and ignored instead of failing every turn.
const claudeMcp = checkMcpConfig(config.ZAI_CLAUDE_MCP_CONFIG || null);
if (claudeMcp.error) console.warn(`[zai-claude] MCP config ignored: ${claudeMcp.error}`);
else if (claudeMcp.file) console.log(`[zai-claude] MCP for admin chats: ${claudeMcp.servers.join(", ")} (${claudeMcp.file})`);
// BUG-146: backups of opencode turns, written by the vault-cache plugin
// (ops/opencode) into the same root as the Claude ones.
const ocUndo = new TurnUndo({ root: config.ZAI_TURN_UNDO_ROOT });
const claude = new ClaudeRunner({
  hub,
  storePath: path.join(DATA_DIR, "claude-sessions.json"),
  undoRoot: config.ZAI_TURN_UNDO_ROOT,
  onTurnEnd: (e) => {
    webPush?.notifier.claudeTurnEnd(e); // FEAT-07.20: «Готово: <чат>»
    return titler?.claudeTurnDone(e);
  },
  // BUG-142: title as soon as the first question is stored (a Workflow turn
  // runs for hours); onTurnEnd above retries if this attempt failed.
  onTurnStart: (e) => titler?.claudeTurnDone(e),
  agents: claudeAgents,
  onAgentMissing: (e) => claudeAgentGone(e),
  mcpConfig: claudeMcp.file,
  // FEAT-04.11: tenants' Claude chats get the same kit as opencode tenants
  // (jailed cmd/Python, zai-* skills, marketplace).
  tenantKit: tenantKit({ dataDir: DATA_DIR, jailExe: process.env.ZAI_JAIL_EXE, sandboxPy: process.env.ZAI_SANDBOX_PY }),
  // FEAT-13.11: knowledge-base snapshot of a chat's first turn (only when the
  // zone folder exists: a missing vault means no cache, not an empty one).
  kbSnapshot: ({ dir, sid, zone }) => (zone?.root && existsSync(zone.root) ? buildKbSnapshot({ dir, sid, zone }) : null),
});

// A bound Claude agent vanished from the catalog (file removed/disabled):
// the turn already runs without it; the binding drops it and the chat says
// so (FEAT-13.17, mockup model-binding frame 14).
function claudeAgentGone({ sid, dir, name }) {
  const cur = bindings.get(sid);
  if (cur?.engine === "claude" && cur.agent) {
    const next = { ...cur, agent: null };
    bindings.set(sid, next);
    hub.emit({ type: "session.updated", properties: { sessionID: sid, info: { id: sid, zai: { ...makeBinding(next, { prompted: next.prompted }), source: "stored" } } } }, dir ?? null);
  }
  hub.emit({ type: "zai.notice", properties: { sessionID: sid, text: `Агент «${name}» больше недоступен — ответ без агента.` } }, dir ?? null);
}

// Chat binding (engine + model + agent per chat, lib/binding.js): the ONLY
// thing that decides where a prompt goes.
const bindings = new BindingStore({ storePath: path.join(DATA_DIR, "session-bindings.json") });

// Auto titles (BUG-13.14 claude chats, BUG-01.27 snapshot-derived opencode
// titles). The generator is a short claude CLI call (cheapest model) with a
// heuristic fallback; ZAI_TITLE_LLM=0 → heuristic only.
titler = new AutoTitler({
  upstream: UPSTREAM,
  claude,
  hub,
  store: new TitleStore({ storePath: path.join(DATA_DIR, "session-titles.json") }),
  record: (id) => sessionRecord(id, true),
  llm:
    config.ZAI_TITLE_LLM && !MOCK
      ? makeClaudeTitler({
          binPath: process.env.ZAI_CLAUDE_BIN || CLAUDE_DEFAULT_BIN,
          model: config.ZAI_TITLE_MODEL,
          timeoutMs: config.ZAI_TITLE_TIMEOUT_MS,
          token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
        })
      : null,
});
if (!MOCK) hub.onEvent((data, dir) => titler.noteEvent(data, dir));

// FEAT-07.20: Web Push. Keys and subscriptions live in <data>/push/ (secrets,
// not in git). Recipients of a chat = the tenants whose scope holds its folder;
// a folder no tenant owns is the admins' (admin — свои, тенант — свои).
function pushRecipients(dir) {
  const users = listUsers().filter((u) => !u.disabled);
  const tenants = dir ? users.filter((u) => u.role !== "admin" && dirAllowed(u, dir)) : [];
  if (tenants.length > 0) return tenants.map((u) => u.id);
  return users.filter((u) => u.role === "admin").map((u) => u.id);
}
async function pushChatInfo(sid) {
  const own = claude.titleInfo(sid);
  const rec = await sessionRecord(sid, true).catch(() => null);
  return {
    dir: rec?.directory ?? claude.dirOf(sid) ?? null,
    title: own?.title || rec?.title || null,
    parentID: rec?.parentID ?? null,
  };
}
if (config.ZAI_PUSH) {
  const pushDir = path.join(DATA_DIR, "push");
  const vapid = loadOrCreateVapid(pushDir);
  if (vapid) {
    const store = new PushStore({ file: path.join(pushDir, "subscriptions.json"), maxPerUser: config.ZAI_PUSH_MAX_PER_USER, log: (m) => console.error(m) });
    const notifier = new PushNotifier({
      store,
      vapid,
      keyObject: vapidKeyObject(vapid),
      subject: config.ZAI_PUSH_SUBJECT,
      recipients: pushRecipients,
      chatInfo: pushChatInfo,
      isManaged: (sid) => claude.has(sid),
      debounceMs: config.ZAI_PUSH_DEBOUNCE_MS,
      log: (m) => console.log(m),
    });
    webPush = { store, notifier, vapid, extraOrigins: config.ZAI_PUSH_EXTRA_ORIGINS };
    if (!MOCK) hub.onEvent((data, dir) => notifier.observe(data, dir));
  }
}

// Deletes a session upstream (directory-pinned) and every local trace of it
// (claude history/run, binding, title mark). A 404 upstream counts as gone.
async function deleteSessionEverywhere(id, dir) {
  let ok = false;
  try {
    const r = await fetch(`${UPSTREAM}${withDir(`/session/${encodeURIComponent(id)}`, dir ? scopedQuery("", dir) : "")}`, {
      method: "DELETE",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DEFAULT_OPTS.timeoutMs),
    });
    await r.text().catch(() => "");
    ok = r.ok || r.status === 404;
  } catch (err) {
    errLog("session.deleteEverywhere", err);
  }
  if (ok) {
    claude.forget(id);
    bindings.forget(id);
    titler.forget(id);
    dropPinEverywhere(id); // FEAT-01.69: no «ghost» pins of a deleted chat
  }
  return ok;
}

// FEAT-01.69: which of `ids` the user sees in their OWN chat list — the same
// rules as GET /session (admin: every live chat outside temp folders; a
// tenant: its scope only). The /me/pins route keeps only these, so a pin can
// never carry a foreign or a dead id. null = the session index never loaded
// (upstream down since boot): nothing can be decided.
async function visiblePinIds(user, admin, ids) {
  if (!ids.length) return [];
  await fetchSessionIndex();
  const known = (id) => sessionIndex.byId.has(id) || claude.has(id) || claude.dirOf(id) != null;
  if (ids.some((id) => !known(id))) await fetchSessionIndex(true);
  if (!sessionIndex.at) return null;
  const out = [];
  for (const id of ids) {
    if (!known(id)) continue;
    const dir = sessionIndex.byId.has(id) ? sessionIndex.byId.get(id) : claude.dirOf(id);
    if (isTempSessionDir(dir)) continue;
    if (!admin && !dirAllowed(user, dir)) continue;
    out.push(id);
  }
  return out;
}

// BUG-04.6: release the opencode instance of a directory (opencode 1.19.5
// POST /instance/dispose?directory=) so the folder is no longer held open.
// Never for the owner's HOME / chat dir.
async function disposeInstance(dir) {
  const n = normDir(dir);
  if (!n || n === normDir(HOME_DIR) || n === normDir(CHAT_DIR)) return false;
  try {
    const u = new URL("/instance/dispose", UPSTREAM);
    u.searchParams.set("directory", dir);
    const r = await fetch(u, { method: "POST", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    await r.text().catch(() => "");
    return r.ok;
  } catch (err) {
    errLog("instance.dispose", err);
    return false;
  }
}

// Tenant folders that survived their account's deletion: retried at start
// and on every gc sweep (BUG-04.6 / BUG-077).
const pendingRemovals = new PendingRemovals(path.join(DATA_DIR, "pending-removals.json"));
const underTenantHome = (p) => {
  const n = normDir(p);
  const root = normDir(config.ZAI_TENANT_HOME);
  return Boolean(n && root && n.startsWith(root + path.sep));
};
// BUG-089: tenant-home subfolders no account owns (same rule for GET and POST).
function ownerlessTenantDirs(sessions) {
  return findOwnerlessTenantDirs({
    home: config.ZAI_TENANT_HOME,
    isReferenced: (p) => dirReferenced(p),
    sessionDirs: (sessions ?? []).map((s) => s?.directory),
  });
}
function retryPendingRemovals() {
  return pendingRemovals.retry({
    isReferenced: (p) => dirReferenced(p),
    beforeRemove: (p) => (underTenantHome(p) ? disposeInstance(p) : null),
    log: (m) => console.log(m),
  });
}

// FEAT-16.2: opencode's default_agent (oh-my-opencode-slim sets «orchestrator»),
// 60 s cache; null when opencode does not answer.
let defaultAgentCache = { at: 0, name: null };
async function upstreamDefaultAgent() {
  if (defaultAgentCache.name && Date.now() - defaultAgentCache.at < 60_000) return defaultAgentCache.name;
  try {
    const r = await fetch(`${UPSTREAM}/config`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    const name = r.ok ? (await r.json())?.default_agent ?? null : null;
    if (typeof name === "string" && name) defaultAgentCache = { at: Date.now(), name };
  } catch (err) {
    errLog("defaultAgent.config", err);
  }
  return defaultAgentCache.name;
}

// BUG-11.13 / BUG-082: model for a prompt without one in an unbound chat.
let defaultModelCache = { at: 0, model: null };
async function defaultModel() {
  if (defaultModelCache.model && Date.now() - defaultModelCache.at < 60_000) return defaultModelCache.model;
  let configModel = null;
  let catalog = null;
  if (config.ZAI_DEFAULT_MODEL) {
    const m = parseModelRef(config.ZAI_DEFAULT_MODEL);
    if (m) return m;
  }
  try {
    const r = await fetch(`${UPSTREAM}/config`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (r.ok) configModel = (await r.json())?.model ?? null;
  } catch (err) {
    errLog("defaultModel.config", err);
  }
  const captured = await captureResponse((shim) => claude.handleProvider({ headers: {} }, shim, UPSTREAM));
  if (captured.status === 200) {
    try {
      catalog = JSON.parse(captured.body);
    } catch {}
  }
  const model = pickDefaultModel({ configModel, catalog });
  if (model) defaultModelCache = { at: Date.now(), model };
  return model;
}

// BUG-140 (FEAT-03.12): may this prompt's pictures ride inline? Only an
// opencode model the provider catalog marks as text-only gets false; the
// Claude engine (runner saves pictures itself), vision models, unknown
// models and prompts without a picture keep the old behaviour (true).
async function imagesInline(binding, parsed) {
  const parts = Array.isArray(parsed?.parts) ? parsed.parts : [];
  if (!parts.some((x) => x?.type === "file" && String(x.mime ?? "").startsWith("image/"))) return true;
  if (binding?.engine === "claude") return true;
  const model = binding?.model ?? cleanModel(parsed?.model);
  if (!model || engineOf(model.providerID) === "claude") return true;
  const captured = await captureResponse((shim) => claude.handleProvider({ headers: {} }, shim, UPSTREAM));
  if (captured.status !== 200) return true;
  try {
    return modelAcceptsImages(JSON.parse(captured.body), model) !== false;
  } catch {
    return true;
  }
}

// BUG-163: a tenant has no vision subagent (Sandbox: task deny), so a turn
// with pictures on a text-only opencode model goes to a same-provider model
// that sees them (ZAI_TENANT_VISION_MODEL first, only from the tenant's own
// catalog). The chat binding is not touched. Admin → null (look_at, BUG-140).
async function tenantVisionModel(user, binding, parsed) {
  if (isAdmin(user) || binding?.engine === "claude") return null;
  const parts = Array.isArray(parsed?.parts) ? parsed.parts : [];
  if (!parts.some((x) => x?.type === "file" && String(x.mime ?? "").startsWith("image/"))) return null;
  const model = binding?.model ?? cleanModel(parsed?.model);
  if (!model || engineOf(model.providerID) === "claude") return null;
  const captured = await captureResponse((shim) => claude.handleProvider({ headers: {} }, shim, UPSTREAM));
  if (captured.status !== 200) return null;
  try {
    const catalog = JSON.parse(captured.body);
    const claudeAllowed = engineAllowed(user, "claude");
    return visionSibling(catalog, model, {
      preferred: config.ZAI_TENANT_VISION_MODEL,
      allowed: (m) => modelInCatalog(catalog, m, { claudeAllowed }) !== false,
    });
  } catch {
    return null;
  }
}

// BUG-159: a tenant binds only models of its own /provider view (connected
// providers; claude only with the engine) — anything else used to bind and
// then run an empty turn with no error. Admin: unchanged. Catalog unknown →
// let it pass (the empty-turn detector stays the safety net).
async function tenantModelProblem(user, model) {
  if (!model || isAdmin(user)) return null;
  const captured = await captureResponse((shim) => claude.handleProvider({ headers: {} }, shim, UPSTREAM));
  if (captured.status !== 200) return null;
  let catalog = null;
  try {
    catalog = JSON.parse(captured.body);
  } catch {
    return null;
  }
  return modelInCatalog(catalog, model, { claudeAllowed: engineAllowed(user, "claude") }) === false
    ? { status: 403, error: "model not allowed" }
    : null;
}

function bindingFor(id, record) {
  return resolveBinding({
    stored: bindings.get(id),
    session: record,
    claudeKnown: claude.has(id),
    claudeModelID: claude.lastModelOf(id),
    // A stored claude agent stays while its id is well-formed; one gone from
    // the catalog is reset (with a notice) by its next turn.
    claudeAgentOk: isClaudeAgentId,
  });
}

function withBinding(s) {
  if (!s || typeof s !== "object" || typeof s.id !== "string") return s;
  const b = bindingFor(s.id, s);
  // FEAT-01.57/01.58: a hidden last turn. opencode's own record carries
  // `revert` (its snapshot and diff stay server-side); a Claude chat's comes
  // from the portal store.
  const rv = claude.revertOf(s.id) ?? (s.revert?.messageID ? { messageID: s.revert.messageID, ...(s.revert.partID ? { partID: s.revert.partID } : {}) } : null);
  const out = { ...s };
  if (rv) out.revert = rv;
  else delete out.revert;
  if (b) out.zai = b;
  return out;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// A message list answered whole (pp == null) or as one page with the
// x-zai-has-more / x-zai-next-before headers (BUG-08.8, lib/proxy.js).
function sendPaged(res, list, pp) {
  if (!pp) return sendJson(res, 200, list);
  const r = paginateMessages(list, pp);
  if (r.error) return sendJson(res, r.error === "unknown before cursor" ? 400 : 502, { error: r.error });
  res.setHeader("x-zai-has-more", r.hasMore ? "1" : "0");
  if (r.nextBefore) res.setHeader("x-zai-next-before", r.nextBefore);
  return sendJson(res, 200, r.page);
}

function withQuery(pathname, search) {
  return search ? pathname + search : pathname;
}

// All session-scoped upstream calls carry an explicit ?directory= — after a
// watchdog restart opencode serve runs with cwd=system32.
const HOME_DIR = config.ZAI_HOME;
// BUG-02.5: the directory of a chat created without a project. Explicit and
// configurable (ZAI_CHAT_DIR, default = HOME as before); never the service
// cwd. Tenants always land in their own first folder (defaultDir).
const CHAT_DIR = config.ZAI_CHAT_DIR;
// BUG-02.5 / BUG-057 decision: a chat without a project lives in ZAI_CHAT_DIR
// (default HOME). Neither it nor HOME may ever be the system tree (the
// service cwd C:\Windows\System32 is where those chats used to land): such a
// configuration is a startup error, not a silent fallback.
for (const [name, dir] of [["ZAI_HOME", HOME_DIR], ["ZAI_CHAT_DIR", CHAT_DIR]]) {
  const problem = dirProblem(dir);
  if (problem) {
    console.error(`[zai-config] ${name}=${dir} недопустим как каталог чатов: ${dirProblemText(problem)} (${problem})`);
    process.exit(1);
  }
}

function withDir(pathname, search) {
  const u = new URL(pathname + (search ?? ""), "http://x");
  if (!u.searchParams.has("directory")) u.searchParams.set("directory", HOME_DIR);
  return u.pathname + u.search;
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let sent = 0;
    let over = false;
    req.on("data", (c) => {
      if (over) return;
      sent += c.length;
      if (sent > limit) {
        over = true;
        resolve(null); // caller answers 413
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => !over && resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

// ---- tenant quotas / rate limit (BUG-12.10) ------------------------------------

// Mutating requests per user per minute (fixed window). GET polls are free.
const rateWindows = new Map();
function rateLimited(user, method = "POST") {
  const limit = config.ZAI_TENANT_RATE_PER_MIN;
  // BUG-158: the comment above always said so, the code counted every GET.
  if (!limit || isAdmin(user) || method === "GET" || method === "HEAD") return false;
  const now = Date.now();
  let w = rateWindows.get(user.id);
  if (!w || now - w.start >= 60_000) {
    w = { start: now, n: 0 };
    rateWindows.set(user.id, w);
  }
  w.n += 1;
  return w.n > limit;
}

function dirBytes(dir) {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      try {
        const st = statSync(path.join(dir, name));
        if (st.isFile()) total += st.size;
      } catch {}
    }
  } catch {}
  return total;
}

function tenantUploadBytes(user) {
  return (user.directories ?? []).reduce((sum, d) => sum + dirBytes(path.join(d, UPLOAD_DIR)), 0);
}

// ---- SSE streams per user (BUG-12.10 / BUG-12.17) ------------------------------

// Live /event responses by user id: disabling a user, regenerating or
// deleting them closes their streams at once (they would otherwise keep
// receiving events until the browser reloads).
const MAX_STREAMS_PER_USER = 8;
const userStreams = new Map();
function trackStream(user, res) {
  let set = userStreams.get(user.id);
  if (!set) userStreams.set(user.id, (set = new Set()));
  // Cap per user: the oldest stream is dropped (EventSource reconnects).
  while (set.size >= MAX_STREAMS_PER_USER) {
    const oldest = set.values().next().value;
    set.delete(oldest);
    oldest.destroy();
  }
  set.add(res);
  res.on("close", () => {
    set.delete(res);
    if (set.size === 0 && userStreams.get(user.id) === set) userStreams.delete(user.id);
  });
}
function closeUserStreams(userId) {
  const set = userStreams.get(userId);
  if (!set) return 0;
  userStreams.delete(userId);
  for (const r of set) r.destroy();
  return set.size;
}
function streamCount() {
  let n = 0;
  for (const s of userStreams.values()) n += s.size;
  return n;
}

// POST /zai/api/upload?name=filename — raw binary body streamed to
// <dir>/.zai-uploads/<unique name>; dir arrives scope-resolved from handleApi.
// BUG-12.17: piped with backpressure; a client that disconnects mid-upload
// leaves no partial file behind.
function handleUpload(req, res, url, dir, limit = UPLOAD_LIMIT) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return sendJson(res, 413, { error: "file too large" });
  }
  const dirAbs = path.join(dir, UPLOAD_DIR);
  try {
    mkdirSync(dirAbs, { recursive: true });
  } catch {
    req.resume();
    return sendJson(res, 400, { error: "bad directory" });
  }
  const stored = pickUniqueName(dirAbs, sanitizeFilename(url.searchParams.get("name")));
  const target = path.join(dirAbs, stored);
  const ws = createWriteStream(target);
  let size = 0;
  let done = false;
  const cleanup = () => {
    ws.destroy();
    try {
      unlinkSync(target);
    } catch {}
  };
  const fail = (status, msg) => {
    if (done) return;
    done = true;
    req.unpipe(ws);
    cleanup();
    req.resume();
    if (!res.headersSent && !res.destroyed) sendJson(res, status, { error: msg });
  };
  req.on("data", (c) => {
    size += c.length;
    if (size > limit) fail(413, "file too large");
  });
  req.on("aborted", () => fail(400, "upload aborted"));
  req.on("close", () => {
    if (!req.complete) fail(400, "upload aborted");
  });
  req.on("error", () => fail(400, "upload read error"));
  ws.on("error", () => fail(500, "disk write error"));
  ws.on("finish", () => {
    if (done) return;
    done = true;
    sendJson(res, 200, { name: stored, size });
  });
  req.pipe(ws);
}

// The directory of an admin prompt (BUG-12.11): the session index decides;
// a not-yet-indexed session may use the client hint if it passes the path
// policy; otherwise HOME.
async function adminSessionDir(id, url) {
  const indexed = await resolveSessionDir(id);
  if (indexed) return indexed;
  const hint = url.searchParams.get("directory");
  if (hint && !dirProblem(hint)) return hint;
  return HOME_DIR;
}

// Permission kinds whose approval would let a tenant's agent leave its
// folder or run a shell with the owner's rights (BUG-12.5): a tenant can
// only reject those.
const TENANT_REJECT_ONLY = new Set(["bash", "external_directory", "doom_loop"]);

// BUG-141: the dirProblem codes that are never a legitimate directory, even
// to read (see handleApi). Every ?directory= value is checked (duplicates too).
const REJECT_DIR_SHAPES = new Set(["unc", "device-namespace", "alias", "not-absolute"]);
function directoryShapeProblem(url) {
  for (const d of url.searchParams.getAll("directory")) {
    if (!d) continue;
    const code = dirProblem(d);
    if (code && REJECT_DIR_SHAPES.has(code)) return code;
  }
  return null;
}

// TASK-12.18 / ADR-001: the declarative route table (routes/*). Each record
// declares its scope; the common gate (routes/router.js) runs before the
// handler. Groups not migrated yet stay in the if-chain of handleApi below.
const API_ROUTES = validateTable([
  ...fileRoutes({
    sendJson, homeDir: HOME_DIR, fileRoots, serveWorkspaceFile, workspaceFileExists, turnFiles, parseWindows, errLog,
    dirProblem, driveProblem, dirProblemText, dirAllowed, config, path, defaultDir, chatDir: CHAT_DIR, handleUpload,
    tenantUploadBytes, uploadLimit: UPLOAD_LIMIT, sanitizeFilename, uploadDir: UPLOAD_DIR, unlinkSync,
  }),
  ...catalogRoutes({
    sendJson, errLog, usageStats, hub, claude, claudeAgents, upstream: UPSTREAM, statusTtlMs: STATUS_TTL_MS,
    fetchSessionIndex, dirAllowed, captureResponse, providerForUser, engineAllowed, proxyRequest, withQuery,
    defaultOpts: DEFAULT_OPTS, tenantAgents, agentList, publicAgent, upstreamError, hostStats, opencodeVersion, harnessVersions,
    version: VERSION, defaultDir, chatDir: CHAT_DIR, instanceHealth,
  }),
  ...adminRoutes({
    sendJson, apiError, readJsonBody, bodyLimit: DEFAULT_OPTS.bodyLimit, listUsers, createUser, regenerateToken, updateUser,
    deleteAccount, closeUserStreams, hub, fetchSessionIndex, sessionIndex: () => sessionIndex, planGc, dataDir: DATA_DIR, path,
    runEmptyChatGc, emptyChatGcInput, gcEmptyMin: config.ZAI_GC_EMPTY_MIN, pendingRemovals, ownerlessTenantDirs,
    lastGc: () => lastGc, gcRunning: () => gcRunning, gcSweep, rotateOwnToken, setAuthCookie, createSession, isHttps,
    getSystemPrompt, setSystemPrompt, cleanSystemPrompt, SYSTEM_PROMPT_MAX,
    getPins, setPins, cleanPins, PINS_MAX, visibleIds: visiblePinIds,
    storeKbTrace: (t) => storeKbTrace(config.ZAI_LOG_DIR, t),
  }),
  ...pushRoutes({ sendJson, readJsonBody, push: () => webPush }),
  ...voiceRoutes({ sendJson, readBody, readJsonBody, voice: voiceService, quota: voiceQuota }),
  ...sessionRoutes({
    binding: (c) => sessionBindingRoute(c),
    action: (c) => sessionActionRoute(c),
    revert: (c) => sessionRevertRoute(c),
    patchDelete: (c) => sessionPatchDeleteRoute(c),
    list: (c) => sessionListRoute(c),
    create: (c) => sessionCreateRoute(c),
    reply: (c) => dialogReplyRoute(c),
    event: (c) => eventStreamRoute(c),
  }),
]);

async function handleApi(req, res, url, user) {
  const p = url.pathname;
  const q = url.search; // pass queries through (limit/before on messages)
  const admin = isAdmin(user);

  // BUG-141 (BUG-12.11): a ?directory= of a malformed shape never reaches
  // upstream or the disk, on ANY route and for every role (a UNC path made
  // opencode dial SMB). Read-only-safe shapes (drive root, system tree) pass
  // here: old chats in System32 must still open and delete (BUG-02.5); the
  // routes that create/write keep their own stricter checks.
  const badDir = directoryShapeProblem(url);
  if (badDir) {
    req.resume();
    return sendJson(res, 400, { error: dirProblemText(badDir), code: badDir });
  }

  // TASK-12.18: routes migrated to the table (gate → handler).
  if (await dispatchRoute(API_ROUTES, { req, res, url, user, admin }, { sendJson, dirAllowed })) return;


  // /session/:id/binding, /session/:id/(message|prompt|abort), /session/:id
  // PATCH/DELETE, /session GET/POST, /permission|question/:id/reply, /event
  // → routes/session.js (TASK-12.18).

  // /status, /dialogs, /provider, /claude/agents, /agent, /project, /mcp,
  // /host, /about, /usage → routes/catalog.js; /dircheck → routes/files.js
  // (TASK-12.18).

  // /upload POST/DELETE, /file, /file/exists, /turn-files → routes/files.js (TASK-12.18).

  sendJson(res, 404, { error: "unknown route" });
}

// ---- session routes (TASK-12.18): handler bodies moved verbatim out of
// handleApi; the table (paths, methods, scopes) lives in routes/session.js.
// They keep their own session/directory resolution — see ADR-001 «Ход
// миграции» for why the common «session» scope is not used yet.

// PATCH {model?, agent?}: change the chat's own model/agent (pills above
// the composer). The engine is locked once the chat has messages (409).
async function sessionBindingRoute({ req, res, url, user, admin, match }) {
  const p = url.pathname;
  const q = url.search;
  const bm = match;
  if (req.method !== "PATCH") return sendJson(res, 405, { error: "method not allowed" });
  const id = bm[1];
  const dir = await resolveSessionDir(id);
  if (dir == null && !claude.has(id) && !bindings.get(id)) return sendJson(res, 404, { error: "session not found" });
  if (!admin) {
    if (dir == null) return sendJson(res, 404, { error: "session not found" });
    if (!dirAllowed(user, dir)) return sendJson(res, 403, { error: "outside your scope" });
  }
  const body = await readJsonBody(req, DEFAULT_OPTS.bodyLimit);
  if (body === null) return sendJson(res, 400, { error: "bad json body" });
  const current = bindingFor(id, await sessionRecord(id));
  // FEAT-13.17: Claude agents are admin-only and must exist in the catalog.
  const r = patchBinding(current, body, { claudeAgentOk: (a) => admin && claudeAgents.has(a) });
  if (r.error) return sendJson(res, r.status, { error: r.error, zai: current });
  // ADR-004 / BUG-12.5: the engine and the agent are policy-checked.
  if (!engineAllowed(user, r.binding.engine)) return sendJson(res, 403, { error: "engine not allowed" });
  const modelProblem = await tenantModelProblem(user, r.binding.model);
  if (modelProblem) return sendJson(res, modelProblem.status, { error: modelProblem.error, zai: current });
  if (!admin && r.binding.engine === "opencode" && r.binding.agent && !agentAllowedForTenant(r.binding.agent, await agentList()))
    return sendJson(res, 403, { error: "agent not allowed" });
  bindings.set(id, r.binding);
  return sendJson(res, 200, { id, zai: { ...r.binding, source: "stored" } });
}

async function sessionActionRoute({ req, res, url, user, admin, match }) {
  const p = url.pathname;
  const q = url.search;
  const m = match;
  const [, id, action] = m;
  // Tenancy: the session's home directory is resolved from the upstream
  // index, never trusted from the client query.
  let upQ = q;
  let tenantDir = null;
  if (!admin) {
    tenantDir = await resolveSessionDir(id);
    if (tenantDir == null) return sendJson(res, 404, { error: "session not found" });
    if (!dirAllowed(user, tenantDir)) return sendJson(res, 403, { error: "outside your scope" });
    upQ = scopedQuery(q, tenantDir);
  }
  if (action === "message" && req.method === "GET") {
    // BUG-08.8: history pages (?limit=&before=) — opencode 1.19.5 answers
    // 400 on `before`, so the slice is cut here (lib/proxy.js contract).
    const pp = pageParams(`/x${q}`);
    if (pp?.error) return sendJson(res, 400, { error: pp.error });
    if (claude.has(id)) {
      const cdir = claude.dirOf(id);
      if (!admin) {
        if (cdir == null) return sendJson(res, 404, { error: "session not found" });
        if (!dirAllowed(user, cdir)) return sendJson(res, 403, { error: "outside your scope" });
      }
      const merged = await claude.mergedMessages(id, cdir ?? HOME_DIR, UPSTREAM);
      return sendPaged(res, admin ? merged : redactMessages(merged), pp);
    }
    if (admin) return proxyRequest(req, res, withDir(`/session/${id}/message`, q), { ...DEFAULT_OPTS, paginate: true, mapList: markEmptyTail });
    // FEAT-12.16: tenants never receive raw commands / server paths. The
    // body is buffered (redaction), so the deadline is generous: a long
    // history over a slow upstream must not be cut at 30 s (CC-28).
    const full = withDir(`/session/${id}/message`, upQ);
    const upPath = pp ? pageParams(full).path : full; // limit/before stripped
    try {
      const r = await fetch(`${UPSTREAM}${upPath}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(PROMPT_OPTS.timeoutMs),
      });
      if (!r.ok) return sendJson(res, r.status >= 500 ? 502 : r.status, { error: "upstream error" });
      return sendPaged(res, markEmptyTail(redactMessages(await r.json())), pp);
    } catch (err) {
      return upstreamError(res, err, "message");
    }
  }
  if (action === "prompt" && req.method === "POST") {
    const limit = admin ? PROMPT_OPTS.bodyLimit : config.ZAI_TENANT_PROMPT_LIMIT || PROMPT_OPTS.bodyLimit;
    const raw = await readBody(req, limit);
    if (raw === null) return sendJson(res, 413, { error: "body too large" });
    const dir = admin ? await adminSessionDir(id, url) : tenantDir;
    if (admin) upQ = scopedQuery(q, dir);
    let parsed = null;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {}
    // Route by the CHAT's binding, never by the body. No binding yet → the
    // first prompt's body becomes the binding and is frozen from now on.
    let binding = bindingFor(id, await sessionRecord(id));
    const boundAgent = binding?.agent ?? null; // the chat's own agent before this prompt
    const boundBefore = Boolean(binding); // BUG-159: only a binding made by this prompt is model-checked
    if (!binding && parsed) {
      // BUG-11.13 / BUG-082: a prompt without a model in an unbound chat
      // runs on the role's default (never the claude engine implicitly) —
      // opencode would otherwise finish the turn with an empty answer.
      // No default resolvable (upstream config without a model, catalog
      // down): the body goes as before and the empty-turn detector stays
      // the safety net.
      const model = cleanModel(parsed.model) ?? (await defaultModel());
      if (model) binding = makeBinding({ model, agent: parsed.agent });
      else errLog("prompt.defaultModel", new Error(`no default model for ${id}; prompt sent without one`));
    }
    if (binding && parsed && binding.engine === "opencode" && !binding.agent && typeof parsed.agent === "string" && parsed.agent) {
      binding = { ...binding, agent: parsed.agent };
    }
    // ADR-004 / BUG-12.5 gate — BEFORE any side effect (binding write,
    // file materialization, upstream dial, claude spawn).
    if (binding && !engineAllowed(user, binding.engine)) return sendJson(res, 403, { error: "engine not allowed" });
    // BUG-159: only a binding made by THIS prompt (unbound chat) is checked —
    // an existing binding was checked when it was made.
    if (!boundBefore) {
      const promptModelProblem = await tenantModelProblem(user, binding?.model);
      if (promptModelProblem) return sendJson(res, promptModelProblem.status, { error: promptModelProblem.error });
    }
    if (!admin) {
      const agents = await agentList();
      let agent = binding?.agent ?? (typeof parsed?.agent === "string" ? parsed.agent : null);
      if (!agent) agent = defaultTenantAgent(agents, config.ZAI_TENANT_AGENT);
      // 2026-11-05: a chat bound to an agent tenants no longer get (multimodal-looker
      // before subagents were hidden) continues on the tenant default instead of a 403.
      if (agent && !agentAllowedForTenant(agent, agents) && boundAgent === agent) agent = defaultTenantAgent(agents, config.ZAI_TENANT_AGENT);
      if (!agent || !agentAllowedForTenant(agent, agents)) return sendJson(res, 403, { error: "agent not allowed" });
      if (binding) binding = { ...binding, agent };
      else if (parsed) parsed = { ...parsed, agent };
    } else if (binding?.engine === "opencode" && binding.agent) {
      // FEAT-16.2: an admin chat on an agent gone from the catalog (OmO → slim)
      // continues on the opencode default agent; the binding follows (saved below).
      const agent = adminAgentFor(binding.agent, await agentList(), await upstreamDefaultAgent());
      if (agent !== binding.agent) binding = { ...binding, agent };
    }
    // BUG-188: a slash command of an ADMIN opencode chat expands upstream —
    // POST /session/:id/command instead of prompt_async (the OmO → slim move
    // lost the auto-slash-command hook, so the raw text reached the model).
    // Gate: one non-synthetic text part whose text is «/name» with the name in
    // the folder's command list. Tenants NEVER expand: a command may carry its
    // own agent and bypass the Sandbox — their text goes as a plain prompt.
    // Attachments (file parts), several parts and unknown names — as before.
    let slash = null;
    if (
      admin && binding?.engine === "opencode" && parsed
      && Array.isArray(parsed.parts) && parsed.parts.length === 1
      && parsed.parts[0]?.type === "text" && typeof parsed.parts[0]?.text === "string"
      && parsed.parts[0].synthetic !== true
    ) {
      slash = parseSlash(parsed.parts[0].text, await commandNames(dir));
    }
    if (slash) {
      // The turn accounting mirrors a prompt: the binding is marked prompted
      // (engine lock), a busy-but-silent run is unstuck first, the folder's
      // provider/MCP are warmed (BUG-183). /command is SYNCHRONOUS upstream
      // (200 answers only after the whole turn), so it fires without await —
      // the client gets 204 immediately, like prompt_async's own 204. The
      // hub needs no further accounting: busy/pending tracking is event-driven
      // over the same SSE stream, ocUndo backups are written upstream-side by
      // the vault-cache plugin (BUG-146) — both work for a command turn as-is.
      bindings.set(id, { ...binding, prompted: true });
      try {
        await hub.prepareForPrompt(id, dir);
      } catch (err) {
        errLog("prepareForPrompt", err);
      }
      try {
        await instanceHealth.ready(dir);
        await instanceHealth.heal(dir);
        instanceHealth.warm(dir);
      } catch (err) {
        errLog("instanceHealth", err);
      }
      fireCommandTurn({ id, dir, query: upQ, name: slash.name, body: commandBody({ command: slash.name, arguments: slash.arguments, agent: binding.agent ?? null, model: binding.model, variantSetting: config.ZAI_GLM_VARIANT }) });
      res.writeHead(204); // the same face a prompt shows the client
      res.end();
      return;
    }
    // Non-image file parts are written to <session dir>/.zai-uploads/ and
    // referenced from a text part (provider does not accept them inline).
    const src = parsed && !binding ? Buffer.from(JSON.stringify(parsed), "utf8") : raw;
    // BUG-140: pictures too, when the chat's opencode model has no image
    // input (catalog says so) — the agent hands the path to look_at.
    // BUG-163: a tenant's picture on a text-only model → this turn runs on a
    // vision model of the same provider, the picture stays inline.
    const vision = await tenantVisionModel(user, binding, parsed);
    const inlineImages = vision ? true : await imagesInline(binding, parsed);
    let out = materializeFileParts(src, dir, { inlineImages });
    if (binding) {
      let mat = null;
      try {
        mat = JSON.parse((Buffer.isBuffer(out) ? out : Buffer.from(String(out))).toString("utf8"));
      } catch {}
      if (mat) {
        bindings.set(id, { ...binding, prompted: true });
        const turn = applyBinding(mat, binding);
        if (vision) turn.model = { providerID: vision.providerID, modelID: vision.modelID };
        out = Buffer.from(JSON.stringify(turn), "utf8");
      }
    }
    // FEAT-13.9: the CLI permission profile follows the caller's role.
    // FEAT-13.17: the agent comes from the binding only (admin chats).
    if (binding?.engine === "claude")
      return claude.dispatch({
        res, sid: id, dir, body: Buffer.isBuffer(out) ? out : Buffer.from(String(out)),
        access: admin ? "admin" : "tenant",
        agent: admin ? binding.agent ?? null : null,
        // FEAT-13.11: admin → ZAI_KB_ROOT; tenant → only its own zone.
        kbZone: kbZoneForUser(user, { admin, adminRoot: config.ZAI_KB_ROOT, tenantVault: config.ZAI_TENANT_VAULT, home: admin ? HOME_DIR : null }),
        // FEAT-04.11: the tenant's AppContainer for its Bash (chat folder inside its home)
        jail: admin ? null : tenantJailFor(dir, config.ZAI_TENANT_HOME),
        // FEAT-03.22: the user's own system prompt (added to the built-in one).
        systemPrompt: getSystemPrompt(user.id),
        // FEAT-04.12 stage B: a tenant chat with its own subfolder runs the CLI there.
        workDir: admin ? null : existingChatFolder(dir, id),
      });
    // BUG-07.10: a busy-but-silent hung run would swallow «Продолжай» —
    // the hub aborts it first so this prompt starts a fresh run.
    try {
      await hub.prepareForPrompt(id, dir);
    } catch (err) {
      errLog("prepareForPrompt", err);
    }
    // BUG-183: the folder's Provider/MCP are initialized by the warm-up (never by this turn, whose
    // «Стоп» would poison them); a folder already poisoned gets its instance disposed first.
    try {
      await instanceHealth.ready(dir);
      await instanceHealth.heal(dir);
      instanceHealth.warm(dir);
    } catch (err) {
      errLog("instanceHealth", err);
    }
    // FEAT-03.22: the user's own system prompt rides `system` of every turn
    // (opencode adds it to the agent's prompt); a tenant cannot send its own.
    out = withUserSystemBody(out, getSystemPrompt(user.id), admin);
    // BUG-180: a GLM-5.3 turn without a variant runs on ZAI_GLM_VARIANT (default max).
    out = withGlmVariantBody(out, config.ZAI_GLM_VARIANT);
    return proxyRequest(req, res, withDir(`/session/${id}/prompt_async`, upQ), { ...PROMPT_OPTS, body: Buffer.isBuffer(out) ? out : Buffer.from(String(out)) });
  }
  if (action === "abort" && req.method === "POST") {
    if (claude.abort(id)) return sendJson(res, 200, { ok: true });
    return proxyRequest(req, res, withDir(`/session/${id}/abort`, admin ? q : upQ), DEFAULT_OPTS);
  }
  return sendJson(res, 405, { error: "method not allowed" });
}

// BUG-188: the upstream POST /session/:id/command run of a slash command,
// fire-and-forget. The client already got 204; a failure (network, 4xx/5xx —
// opencode answers 400 on an unknown command and 404 on an unknown session)
// is logged and announced to the chat via zai.notice, the way other turn
// problems reach the user (claudeAgentGone). The same long deadline as
// prompt_async: a command turn runs a full agent turn upstream.
const COMMAND_TURN_BACKSTOP_MS = 6 * 3600_000;
function fireCommandTurn({ id, dir, query, name, body }) {
  void (async () => {
    try {
      const r = await fetch(`${UPSTREAM}${withDir(`/session/${encodeURIComponent(id)}/command`, query)}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        // NOT the prompt deadline: /command holds the request for the WHOLE turn, and
        // in opencode 1.19.5 an aborted request is a ClientAbort that interrupts the
        // turn's fiber (BUG-183 mechanism). Only a backstop far beyond any real turn;
        // «Стоп» goes through /abort as for any turn.
        signal: AbortSignal.timeout(COMMAND_TURN_BACKSTOP_MS),
      });
      if (!r.ok) {
        const detail = (await r.text().catch(() => "")).slice(0, 300);
        errLog("commandTurn", new Error(`upstream ${r.status} for /${name} in ${id}: ${detail}`));
        hub.emit({ type: "zai.notice", properties: { sessionID: id, text: `Команда «/${name}» не выполнена (upstream ${r.status}).` } }, dir ?? null);
        return;
      }
      await r.arrayBuffer().catch(() => {}); // drain: the response carries the finished turn
    } catch (err) {
      errLog("commandTurn", err);
      hub.emit({ type: "zai.notice", properties: { sessionID: id, text: `Команда «/${name}» не отправлена: ${err?.cause?.code || err?.name || "ошибка сети"}.` } }, dir ?? null);
    }
  })();
}

// ---- FEAT-01.57 / FEAT-01.58: «Изменить», «Сгенерировать заново»,
// «Отменить ход» — only the LAST turn, only while nothing runs; the scope
// and engine rules are the prompt's.
//   GET  /session/:id/revert?messageID= → {engine, files:[{path, action, skipped?}], shell}
//   POST /session/:id/revert {messageID} → {ok, revert, files, skipped}
//   POST /session/:id/unrevert          → {ok}
// opencode: upstream session.revert / unrevert (its snapshots roll the files
// back; the next prompt drops the hidden messages). Claude: the runner's
// own revert (lib/turn-undo.js backups, CLI transcript cut on the next turn).

// A path for the file list: relative inside the chat folder.
// BUG-145: the git work tree a chat folder belongs to (a `.git` dir or file —
// worktrees and submodules use a file — in the folder or any parent), or null.
function gitWorkTreeOf(dir) {
  if (typeof dir !== "string" || !dir) return null;
  let cur = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    try {
      if (existsSync(path.join(cur, ".git"))) return cur;
    } catch {}
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

// BUG-145: true only when opencode (for this folder) reports `snapshot: false`;
// any error or other answer → false (the git-dir block stays).
async function upstreamSnapshotOff(dir) {
  try {
    const r = await fetch(`${UPSTREAM}${withDir("/config", scopedQuery("", dir))}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return false;
    const cfg = await r.json();
    return cfg?.snapshot === false;
  } catch {
    return false;
  }
}

function revertPathFace(p, dir) {
  if (typeof p !== "string" || !p) return null;
  if (dir && path.isAbsolute(p)) {
    // The CLI reports physical paths (POSIX: macOS /var/... is /private/var/...).
    for (const base of new Set([dir, physicalDir(dir)])) {
      const rel = path.relative(base, p);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/");
    }
  }
  return p.replace(/\\/g, "/");
}

// The opencode history of a chat (directory-pinned) or null.
async function upstreamMessages(id, dir) {
  const u = new URL(`/session/${encodeURIComponent(id)}/message`, UPSTREAM);
  if (dir) u.searchParams.set("directory", dir);
  const r = await fetch(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(PROMPT_OPTS.timeoutMs) });
  if (!r.ok) return null;
  const list = await r.json();
  return Array.isArray(list) ? list : null;
}

const lastUserId = (list) => {
  for (let i = (list?.length ?? 0) - 1; i >= 0; i--) if (list[i]?.info?.role === "user") return list[i].info.id ?? null;
  return null;
};

// opencode: what the revert to `messageID` rolls back. session.diff of the
// question first; the turn's patch parts when it has none.
async function opencodeRevertFiles(id, dir, messageID, list, within = null) {
  const files = new Map();
  // BUG-146: the vault-cache plugin kept the files of the turn — the portal
  // rolls them back itself; a file the turn's tools touched without a
  // backup is still listed as «не откатится».
  const recs = ocUndo.records(id, messageID);
  if (recs.length > 0) {
    const known = new Set(recs.map((r) => path.resolve(r.path).toLowerCase()));
    for (const f of ocUndo.preview(id, messageID, { within })) files.set(f.path.toLowerCase(), f);
    for (const f of turnToolFiles(list, messageID)) {
      const abs = path.resolve(dir ?? "", f);
      if (!known.has(abs.toLowerCase()) && (!within || within(abs))) files.set(abs.toLowerCase(), { path: abs, action: "restore", skipped: "no-snapshot" });
    }
    return [...files.values()];
  }
  try {
    const u = new URL(`/session/${encodeURIComponent(id)}/diff`, UPSTREAM);
    if (dir) u.searchParams.set("directory", dir);
    u.searchParams.set("messageID", messageID);
    const r = await fetch(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(DEFAULT_OPTS.timeoutMs) });
    if (r.ok) {
      const diff = await r.json();
      for (const d of Array.isArray(diff) ? diff : []) {
        const p = typeof d?.file === "string" ? d.file : typeof d?.path === "string" ? d.path : null;
        if (p) files.set(p.toLowerCase(), { path: p, action: d.status === "added" ? "delete" : "restore" });
      }
    }
  } catch (err) {
    errLog("revert.diff", err);
  }
  if (files.size === 0) {
    const at = (list ?? []).findIndex((m) => m?.info?.id === messageID);
    for (const m of at >= 0 ? list.slice(at + 1) : []) {
      for (const part of m?.parts ?? []) {
        if (part?.type !== "patch" || !Array.isArray(part.files)) continue;
        for (const f of part.files) if (typeof f === "string" && f) files.set(f.toLowerCase(), { path: f, action: "restore" });
      }
    }
  }
  // No snapshot (opencode keeps none outside git projects — stand 2026-11-04):
  // the turn's write/edit tools still say which files it touched — listed as
  // «не откатится», so the confirm never promises a rollback that won't happen.
  if (files.size === 0) {
    for (const f of turnToolFiles(list, messageID)) files.set(f.toLowerCase(), { path: f, action: "restore", skipped: "no-snapshot" });
  }
  return [...files.values()];
}

// The files the write/edit tools of the turn after `messageID` named.
function turnToolFiles(list, messageID) {
  const out = [];
  const at = (list ?? []).findIndex((m) => m?.info?.id === messageID);
  for (const m of at >= 0 ? list.slice(at + 1) : []) {
    for (const part of m?.parts ?? []) {
      if (part?.type !== "tool" || !/^(write|edit|multiedit|patch|apply_patch)$/i.test(String(part.tool ?? ""))) continue;
      const inp = part.state?.input ?? {};
      const f = inp.filePath ?? inp.file_path ?? inp.path;
      if (typeof f === "string" && f) out.push(f);
    }
  }
  return out;
}

// The upstream record of one session (GET /session/:id, directory-pinned).
async function upstreamRecord(id, dir) {
  try {
    const r = await fetch(`${UPSTREAM}${withDir(`/session/${encodeURIComponent(id)}`, scopedQuery("", dir))}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(DEFAULT_OPTS.timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function sessionRevertRoute({ req, res, url, user, admin, match }) {
  const id = match[1];
  const op = match[2]; // "revert" | "unrevert"
  if (op === "unrevert" && req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
  const record = await sessionRecord(id, true);
  const binding = bindingFor(id, record);
  const isClaude = binding?.engine === "claude" || claude.has(id);
  // Scope: the prompt's rules (tenant → its own folders, engine grant).
  const dir = isClaude ? claude.dirOf(id) ?? (await resolveSessionDir(id)) : await resolveSessionDir(id);
  if (dir == null && !isClaude) return sendJson(res, 404, { error: "session not found" });
  if (!admin) {
    if (dir == null) return sendJson(res, 404, { error: "session not found" });
    if (!dirAllowed(user, dir)) return sendJson(res, 403, { error: "outside your scope" });
  }
  if (!engineAllowed(user, isClaude ? "claude" : "opencode")) return sendJson(res, 403, { error: "engine not allowed" });
  let messageID = null;
  if (op === "revert") {
    if (req.method === "GET") messageID = url.searchParams.get("messageID");
    else {
      const body = await readJsonBody(req, DEFAULT_OPTS.bodyLimit);
      messageID = typeof body?.messageID === "string" ? body.messageID : null;
    }
    if (!messageID || !/^[A-Za-z0-9_-]{1,128}$/.test(messageID)) return sendJson(res, 400, { error: "messageID required" });
  }
  const access = admin ? "admin" : "tenant";

  if (isClaude) {
    const r =
      op === "unrevert" ? claude.unrevert(id) : req.method === "GET" ? claude.revertPreview(id, messageID, { access }) : claude.revert(id, messageID, { access });
    if (r.status) return sendJson(res, r.status, { error: r.error });
    const face = (list) => (list ?? []).map((f) => ({ ...f, path: revertPathFace(f.path, dir) }));
    if (op === "unrevert") return sendJson(res, 200, { ok: true, files: face(r.files) });
    if (req.method === "GET") return sendJson(res, 200, { engine: "claude", files: face(r.files), shell: true });
    return sendJson(res, 200, { ok: true, revert: r.revert, files: face(r.files), skipped: face(r.skipped) });
  }

  // opencode
  if (liveSessionIds().has(id)) return sendJson(res, 409, { error: "turn in progress" });
  // BUG-145: opencode revert/unrevert inside a git work tree rolled back
  // uncommitted edits that were NOT made by the turn (stand, 2026-11-04;
  // mechanism unknown). Until it is understood, file rollback is off there:
  // the preview says why, revert/unrevert answer 409 "git-dir".
  // Mechanism (stand, 2026-11-04, throwaway repo): opencode's unrevert restores
  // its whole snapshot tree, and for files outside the chat folder that tree
  // holds the repo's INDEX state — a dirty tracked file went back to HEAD.
  // With `"snapshot": false` in the opencode config (ops/opencode/opencode.json)
  // opencode touches no file at all; the portal rolls back only the turn's
  // files from the plugin's backups (BUG-146), as outside git. The block
  // stays whenever upstream does not report snapshot:false.
  const gitRoot = gitWorkTreeOf(dir);
  if (gitRoot && !(await upstreamSnapshotOff(dir))) {
    if (req.method === "GET" && op === "revert") return sendJson(res, 200, { engine: "opencode", files: [], shell: false, blocked: "git-dir" });
    return sendJson(res, 409, { error: "git-dir" });
  }
  const upQ = scopedQuery("", dir);
  // BUG-146: a tenant's list and rollback stay inside its chat folder.
  const within = admin ? null : (p) => Boolean(dir) && isInside(p, dir);
  try {
    if (op === "unrevert") {
      const fresh = await upstreamRecord(id, dir);
      const reverted = fresh ? fresh.revert ?? null : record?.revert ?? null;
      if (!reverted) return sendJson(res, 409, { error: "nothing to restore" });
      const r = await fetch(`${UPSTREAM}${withDir(`/session/${id}/unrevert`, upQ)}`, { method: "POST", headers: { accept: "application/json" }, signal: AbortSignal.timeout(PROMPT_OPTS.timeoutMs) });
      await r.text().catch(() => "");
      if (!r.ok) return sendJson(res, r.status >= 500 ? 502 : r.status, { error: "upstream error" });
      fetchSessionIndex(true).catch(() => {});
      // «Вернуть»: the turn's result goes back into the files it rolled back.
      let files = [];
      try {
        if (reverted.messageID) files = ocUndo.unrevert(id, reverted.messageID).files;
      } catch (err) {
        errLog("revert.redo", err);
      }
      return sendJson(res, 200, { ok: true, files: files.map((f) => ({ ...f, path: revertPathFace(f.path, dir) })) });
    }
    const list = await upstreamMessages(id, dir);
    if (!list) return sendJson(res, 502, { error: "upstream error" });
    const current = (await upstreamRecord(id, dir))?.revert ?? null;
    if (current?.messageID && req.method === "POST") {
      if (current.messageID === messageID) return sendJson(res, 200, { ok: true, revert: { messageID }, files: [], skipped: [] });
      return sendJson(res, 409, { error: "already reverted" });
    }
    if (lastUserId(list) !== messageID) return sendJson(res, 409, { error: "not the last turn" });
    const face = (arr) => arr.map((f) => ({ ...f, path: revertPathFace(f.path, dir) }));
    const planned = await opencodeRevertFiles(id, dir, messageID, list, within);
    if (req.method === "GET") return sendJson(res, 200, { engine: "opencode", files: face(planned), shell: false });
    // BUG-146: the portal rolls the turn's files back from the plugin's
    // backups first; the upstream revert then only hides the messages
    // (outside git opencode has no snapshot and touches no file).
    const backed = ocUndo.records(id, messageID).length > 0;
    let undone = null;
    if (backed) {
      try {
        undone = ocUndo.revert(id, messageID, { within });
      } catch (err) {
        errLog("revert.undo", err);
        undone = { files: [], skipped: [] };
      }
    }
    let r;
    try {
      r = await fetch(`${UPSTREAM}${withDir(`/session/${id}/revert`, upQ)}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ messageID }),
        signal: AbortSignal.timeout(PROMPT_OPTS.timeoutMs),
      });
      await r.text().catch(() => "");
    } catch (err) {
      r = null;
      if (undone) ocUndo.unrevert(id, messageID); // the turn stays: so do its files
      throw err;
    }
    if (!r.ok) {
      if (undone) ocUndo.unrevert(id, messageID);
      return sendJson(res, r.status >= 500 ? 502 : r.status, { error: "upstream error" });
    }
    fetchSessionIndex(true).catch(() => {});
    if (undone) {
      // files the turn's tools named without a backup: still «не откатится»
      const noSnap = planned.filter((f) => f.skipped === "no-snapshot");
      return sendJson(res, 200, { ok: true, revert: { messageID }, files: face(undone.files), skipped: face([...undone.skipped, ...noSnap]) });
    }
    return sendJson(res, 200, { ok: true, revert: { messageID }, files: face(planned.filter((f) => !f.skipped)), skipped: face(planned.filter((f) => f.skipped)) });
  } catch (err) {
    return upstreamError(res, err, `session.${op}`);
  }
}

async function sessionPatchDeleteRoute({ req, res, url, user, admin, match }) {
  const p = url.pathname;
  const q = url.search;
  const m = match;
  const id = m[1];
  // ADR-001 step 1 / BUG-12.6: the scope gate runs FIRST.
  let upQ = q;
  let scopeDir = null; // the chat's own folder (null: claude-only chats)
  if (!admin) {
    scopeDir = await resolveSessionDir(id);
    if (scopeDir == null) return sendJson(res, 404, { error: "session not found" });
    if (!dirAllowed(user, scopeDir)) return sendJson(res, 403, { error: "outside your scope" });
    upQ = scopedQuery(q, scopeDir);
  }
  if (req.method === "PATCH") {
    // BUG-13.14: a title set by a human is marked and never auto-replaced.
    const raw = await readBody(req, DEFAULT_OPTS.bodyLimit);
    if (raw === null) return sendJson(res, 413, { error: "body too large" });
    let body = null;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {}
    if (typeof body?.title === "string" && body.title.trim())
      titler.userRenamed(id, body.title.trim(), { claudeChat: bindingFor(id, await sessionRecord(id))?.engine === "claude" });
    // A claude-only chat unknown upstream: the claude store is its home.
    if (claude.titleInfo(id) && typeof body?.title === "string" && !(await resolveSessionDir(id))) return sendJson(res, 200, { id, title: body.title.trim() });
    return proxyRequest(req, res, withDir(`/session/${id}`, upQ), { ...DEFAULT_OPTS, body: raw });
  }
  // DELETE: local data (binding, claude history, live claude run) dies only
  // after the upstream confirmed the delete with a 2xx — a 5xx leaves the
  // session intact everywhere. A claude-only chat unknown upstream (404)
  // is still forgotten locally.
  try {
    const r = await fetch(`${UPSTREAM}${withDir(`/session/${id}`, upQ)}`, {
      method: "DELETE",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DEFAULT_OPTS.timeoutMs),
    });
    const text = await r.text();
    const localOnly = r.status === 404 && (claude.has(id) || bindings.get(id));
    if (r.ok || localOnly) {
      claude.forget(id);
      ocUndo.forget(id); // BUG-146: the opencode turn backups go with the chat
      bindings.forget(id);
      titler.forget(id);
      dropPinEverywhere(id); // FEAT-01.69: the chat leaves every user's pins
      // BUG-186 / BUG-07.23: the hub learns about deletes only from upstream's
      // session.deleted on /event — which never arrives when the chat's folder
      // has no hub subscription (probe/temp dirs): prod 2026-11-07 kept a
      // deleted chat «busy» in /status and healthz for 4 hours, and every
      // deploy waited for a quiet window that never came. The portal KNOWS
      // the delete succeeded — tell the hub the same way gcSweep does, so the
      // exact session.deleted cleanup runs (busy, dialogs, pending, clients).
      const delDir = admin ? await resolveSessionDir(id) : scopeDir;
      hub.emit({ type: "session.deleted", properties: { sessionID: id, info: { id, directory: delDir ?? null } } }, delDir ?? null);
      fetchSessionIndex(true).catch(() => {});
    }
    if (localOnly) return sendJson(res, 200, true);
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    return res.end(text);
  } catch (err) {
    return upstreamError(res, err, "session.delete");
  }
}

// BUG-13.16: claude turns never touch the upstream record, so its
// time.updated stays at creation and the chat never climbs the list.
// The claude store's last activity lifts it (never lowers: a rename PATCH
// upstream can be newer).
const withClaudeActivity = (list) =>
  list.map((s) => {
    const at = typeof s?.id === "string" ? claude.activityOf(s.id) : null;
    if (!at) return s;
    const up = Number(s.time?.updated);
    return Number.isFinite(up) && up >= at ? s : { ...s, time: { ...s.time, updated: at } };
  });

// GET: admins stream the full upstream list; tenants get the
// SERVER-filtered list. Every record carries the chat binding under `zai`.
async function sessionListRoute({ req, res, url, user, admin, match }) {
  const p = url.pathname;
  const q = url.search;
  try {
    const r = await fetch(`${UPSTREAM}${admin ? withQuery("/session", q) : "/session"}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DEFAULT_OPTS.timeoutMs),
    });
    if (!r.ok) return sendJson(res, 502, { error: `upstream: ${r.status}` });
    const list = await r.json();
    if (!Array.isArray(list)) return sendJson(res, 200, list);
    const out = (admin ? list : list.filter((s) => dirAllowed(user, s?.directory))).filter((s) => !isTempSessionDir(s?.directory));
    return sendJson(res, 200, withClaudeActivity(titler.overlay(out)).map(withBinding));
  } catch (err) {
    return upstreamError(res, err, "session.list");
  }
}

async function sessionCreateRoute({ req, res, url, user, admin, match }) {
  const p = url.pathname;
  const q = url.search;
  // A session can be CREATED in a missing directory, but its first prompt
  // dies with PlatformError realPath NotFound — create the folder up front.
  let dir = url.searchParams.get("directory");
  if (dir) {
    // BUG-013 / BUG-12.11: one path policy (relative, UNC, \\?\, drive
    // roots, system tree) before mkdir and before upstream.
    const problem = dirProblem(dir);
    if (problem) return sendJson(res, 400, { error: dirProblemText(problem), code: problem });
    if (!dirAllowed(user, dir)) return sendJson(res, 403, { error: "outside your scope" });
    // ISSUE-006: a missing drive (Z:\nope) is refused up front.
    const drive = driveProblem(dir);
    if (drive) return sendJson(res, 400, { error: dirProblemText(drive), code: drive });
  } else {
    dir = defaultDir(user, CHAT_DIR);
  }
  const body = await readJsonBody(req, DEFAULT_OPTS.bodyLimit);
  const { model: wantModel, agent: wantAgent, ...upBody } = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  // ADR-004: the requested binding is policy-checked before the create.
  let want = makeBinding({ model: wantModel, agent: wantAgent }, { claudeAgentOk: (a) => admin && claudeAgents.has(a) });
  if (want && !engineAllowed(user, want.engine)) return sendJson(res, 403, { error: "engine not allowed" });
  const wantProblem = await tenantModelProblem(user, want?.model);
  if (wantProblem) return sendJson(res, wantProblem.status, { error: wantProblem.error });
  if (!admin && want?.engine === "opencode") {
    const agents = await agentList();
    if (want.agent && !agentAllowedForTenant(want.agent, agents)) return sendJson(res, 403, { error: "agent not allowed" });
    // ISSUE-001: a tenant chat without an agent is bound to the tenant
    // default right away — the pill shows the agent the turn will run on.
    if (!want.agent) {
      const def = defaultTenantAgent(agents, config.ZAI_TENANT_AGENT);
      if (def) want = { ...want, agent: def };
    }
  } else if (admin && want?.engine === "opencode" && want.agent) {
    // FEAT-16.2: a new chat asking for an agent gone from the catalog → the default agent.
    const agent = adminAgentFor(want.agent, await agentList(), await upstreamDefaultAgent());
    if (agent !== want.agent) want = { ...want, agent };
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    // The first prompt would die with PlatformError realPath NotFound
    // (ISSUE-006) — refuse the create with a readable reason instead.
    errLog("session.create.mkdir", err);
    return sendJson(res, 400, { error: dirProblemText("unreachable"), code: "unreachable" });
  }
  try {
    const r = await fetch(`${UPSTREAM}${withDir("/session", admin ? scopedQuery(q, dir) : scopedQuery(q, dir))}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(upBody),
      signal: AbortSignal.timeout(DEFAULT_OPTS.timeoutMs),
    });
    const text = await r.text();
    if (!r.ok) {
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      return res.end(text);
    }
    let created = null;
    try {
      created = JSON.parse(text);
    } catch {}
    if (typeof created?.id === "string" && want) bindings.set(created.id, want);
    // FEAT-04.12 stage B: a NEW tenant chat gets its own working subfolder
    // (<tenant>\chats\<id>); its presence switches both engines to it.
    if (!admin && typeof created?.id === "string") {
      try {
        ensureChatFolder(dir, created.id);
      } catch (err) {
        errLog("session.create.chatFolder", err);
      }
    }
    // BUG-183: initialize the folder's Provider/MCP now, while the user types the first message.
    if (want?.engine !== "claude" && created?.directory) instanceHealth.warm(created.directory);
    hub.syncDirectories();
    fetchSessionIndex(true).catch(() => {});
    return sendJson(res, 200, withBinding(created));
  } catch (err) {
    return upstreamError(res, err, "session.create");
  }
}

async function dialogReplyRoute({ req, res, url, user, admin, match }) {
  const p = url.pathname;
  const q = url.search;
  const m = match;
  // Directory-pinned like every session-scoped route (404 incident
  // 2026-11-01). Tenants (BUG-12.10 / BUG-12.5): the request id must be an
  // OPEN dialog in their own scope, the upstream call is pinned to that
  // dialog's directory (never the raw client query — duplicate
  // ?directory= params used to slip through), and shell / outside-folder
  // permissions can only be rejected.
  if (admin) return proxyRequest(req, res, withDir(`/${m[1]}/${m[2]}/reply`, q), DEFAULT_OPTS);
  const open = (await hub.collectDialogs()).find((e) => e?.id === m[2] && dirAllowed(user, e.directory ?? e.dir));
  if (!open) {
    req.resume();
    return sendJson(res, 404, { error: "dialog not found" });
  }
  const raw = await readBody(req, DEFAULT_OPTS.bodyLimit);
  if (raw === null) return sendJson(res, 413, { error: "body too large" });
  if (m[1] === "permission" && TENANT_REJECT_ONLY.has(open.permission)) {
    let reply = null;
    try {
      reply = JSON.parse(raw.toString("utf8"))?.reply;
    } catch {}
    if (reply !== "reject") return sendJson(res, 403, { error: "permission not allowed for tenants" });
  }
  return proxyRequest(req, res, withDir(`/${m[1]}/${m[2]}/reply`, scopedQuery(q, open.directory ?? open.dir)), { ...DEFAULT_OPTS, body: raw });
}

async function eventStreamRoute({ req, res, url, user, admin, match }) {
  const p = url.pathname;
  const q = url.search;
  // SSE hub, never a direct proxy. Tenants get a visibility filter; every
  // stream is tracked per user so it can be closed on disable/regenerate.
  trackStream(user, res);
  hub.handleClient(req, res, admin ? {} : { visible: (dir) => dirAllowed(user, dir), transform: redactEventForTenant });
  return;
}


// ---- account deletion (BUG-04.6 / BUG-077) ----------------------------------------
// Order matters: the account is locked out, then EVERY chat in its own
// folders is deleted (upstream + binding + claude history), the hub drops its
// subscriptions and the opencode instances of those folders are disposed —
// only then the folders go. A folder that still cannot be removed is NOT
// swallowed: it is logged, listed in `warnings` and retried by the gc sweep.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deleteAccount(uid) {
  const target = getUser(uid);
  if (!target || target.role === "admin") throw new ApiError(404, "user not found");
  try {
    updateUser(uid, { disabled: true });
  } catch {}
  closeUserStreams(uid);
  // Only folders no other account shares.
  const own = (target.directories ?? []).filter((d) => !dirReferenced(d, uid));
  const ownN = new Set(own.map(normDir).filter(Boolean));
  const inScope = (d) => typeof d === "string" && ownN.has(normDir(d));
  const warnings = [];

  await fetchSessionIndex(true);
  if (sessionIndex.at === 0) warnings.push({ kind: "sessions", reason: "сервер агента недоступен — чаты учётной записи не удалены" });
  const ids = new Map();
  for (const [id, rec] of sessionIndex.recById) if (inScope(rec?.directory)) ids.set(id, rec.directory);
  for (const id of claude.sessionIds()) {
    const d = claude.dirOf(id);
    if (inScope(d) && !ids.has(id)) ids.set(id, d);
  }
  let removedSessions = 0;
  for (const [id, d] of ids) {
    claude.abort(id);
    if (await deleteSessionEverywhere(id, d)) removedSessions++;
    else warnings.push({ kind: "session", sessionID: id, reason: "сервер агента не удалил чат" });
  }
  await fetchSessionIndex(true);
  try {
    await hub.syncDirectories(); // drops the /event subscriptions of the emptied folders
  } catch {}
  for (const d of own) await disposeInstance(d);

  const out = deleteUser(uid);
  webPush?.store.dropUser(uid); // FEAT-07.20: a deleted account's devices get nothing more
  const removed = [...out.removedDirs];
  let failed = out.failedDirs;
  if (failed.length > 0) {
    pendingRemovals.add(failed.map((f) => ({ ...f, userId: uid })));
    await sleep(1000); // opencode releases handles asynchronously after dispose
    const r = await retryPendingRemovals();
    const wanted = new Set(failed.map((f) => f.path.toLowerCase()));
    removed.push(...r.removed.filter((p) => wanted.has(p.toLowerCase())));
    failed = r.left.filter((f) => wanted.has(f.path.toLowerCase()));
  }
  for (const f of failed) {
    console.error(`[zai-err] account ${uid} deleted, folder left behind: ${f.path} — ${f.reason}; retried by the gc sweep`);
    warnings.push({ kind: "folder", path: f.path, reason: f.reason, retry: true });
  }
  console.log(`[zai-auth] account ${uid} deleted: ${removedSessions} chat(s), ${removed.length} folder(s) removed, ${failed.length} left`);
  return { ok: true, removedSessions, removedDirs: removed.length, warnings };
}

// ---- gc sweep (BUG-01.48 / BUG-078, BUG-04.6) -------------------------------------
let gcRunning = false;
let lastGc = null;

async function countUpstreamMessages(id, dir) {
  const u = new URL(`/session/${encodeURIComponent(id)}/message`, UPSTREAM);
  if (dir) u.searchParams.set("directory", dir);
  u.searchParams.set("limit", "1");
  const r = await fetch(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  const list = await r.json();
  return Array.isArray(list) ? list.length : null;
}

function liveSessionIds() {
  return new Set([...Object.keys(hub.busySnapshot()), ...Object.keys(hub.stalledSnapshot()), ...Object.keys(claude.busySnapshot())]);
}

// Single source of the empty-chat rule inputs (threshold ZAI_GC_EMPTY_MIN,
// protected busy/dialog/claude sets, message-count confirm) — shared by the
// dry-run GET /admin/gc report and the APPLY sweep, so they never disagree.
function emptyChatGcInput(sessions) {
  return {
    sessions,
    minAgeMs: config.ZAI_GC_EMPTY_MIN * 60_000,
    busy: liveSessionIds(),
    dialogs: hub.dialogSessions(),
    claude: new Set(sessions.map((s) => s.id).filter((id) => claude.has(id) || claude.titleInfo(id))),
    countMessages: countUpstreamMessages,
    isBusy: (id) => liveSessionIds().has(id) || hub.dialogSessions().has(id),
  };
}

async function gcSweep() {
  if (gcRunning || MOCK) return null;
  gcRunning = true;
  try {
    const out = { at: new Date().toISOString(), pending: null, empty: null };
    if (pendingRemovals.list().length > 0) out.pending = await retryPendingRemovals();
    // BUG-089: empty tenant-home folders no account owns. Without the session
    // index a chat folder could look ownerless — then skip this step.
    const indexAsked = Date.now();
    await fetchSessionIndex(true).catch(() => {});
    // FEAT-01.58 / BUG-146: turn backups (Claude and opencode) of deleted
    // chats and stale last turns. The opencode chats come from a FRESH index
    // only — a stale one would make a new chat's backups look orphaned.
    if (sessionIndex.at >= indexAsked) {
      const keep = new Set([...claude.sessionIds(), ...sessionIndex.recById.keys()]);
      out.turnUndo = sweepTurnUndo({ root: config.ZAI_TURN_UNDO_ROOT, keep, log: (m) => console.log(m) }).removed.length;
    }
    if (sessionIndex.at !== 0) {
      out.ownerless = await sweepOwnerlessTenantDirs(ownerlessTenantDirs([...sessionIndex.recById.values()]), {
        beforeRemove: (p) => disposeInstance(p),
        log: (m) => console.log(m),
      });
    }
    const minAgeMs = config.ZAI_GC_EMPTY_MIN * 60_000;
    if (minAgeMs > 0) {
      await fetchSessionIndex(true);
      if (sessionIndex.at !== 0) {
        const sessions = [...sessionIndex.recById.values()];
        out.empty = await runEmptyChatGc({
          ...emptyChatGcInput(sessions),
          deleteSession: deleteSessionEverywhere,
          log: (m) => console.log(m),
        });
        if (out.empty.deleted.length > 0) {
          fetchSessionIndex(true).catch(() => {});
          const dirOf = new Map(sessions.map((s) => [s.id, s.directory ?? null]));
          for (const id of out.empty.deleted) hub.emit({ type: "session.deleted", properties: { sessionID: id, info: { id, directory: dirOf.get(id) } } }, dirOf.get(id));
        }
      }
    }
    lastGc = out;
    return out;
  } catch (err) {
    errLog("gcSweep", err);
    return null;
  } finally {
    gcRunning = false;
  }
}

// Runs a handler that writes to a response object and captures what it
// wrote (status + body) — lets /provider be filtered without touching
// ClaudeRunner.handleProvider (lib/claude.js belongs to another group).
function captureResponse(run) {
  return new Promise((resolve) => {
    let status = 200;
    const chunks = [];
    const shim = {
      headersSent: false,
      setHeader() {},
      writeHead(s) {
        status = s;
        this.headersSent = true;
        return this;
      },
      write(c) {
        if (c) chunks.push(Buffer.from(c));
        return true;
      },
      end(c) {
        if (c) chunks.push(Buffer.from(c));
        resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
      },
    };
    Promise.resolve()
      .then(() => run(shim))
      .catch((err) => {
        errLog("captureResponse", err);
        resolve({ status: 502, body: "" });
      });
  });
}

// GET /zai/api/healthz (ADR-007): unauthenticated, loopback-only and only for
// DIRECT callers — anything relayed by the edge carries x-forwarded-for and
// gets 404 (the edge also refuses the path itself).
async function handleHealthz(req, res) {
  const remote = req.socket?.remoteAddress ?? "";
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  // Until the edge is restarted with ADR-009 (x-forwarded-for always set),
  // relayed requests are recognized by their Host: the edge forwards the
  // browser's host, direct watchdog probes use 127.0.0.1/localhost.
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  const localHost = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (!loopback || !localHost || req.headers["x-forwarded-for"]) return sendJson(res, 404, { error: "unknown route" });
  if (MOCK) return sendJson(res, 200, { ok: true, mock: true, version: VERSION, uptimeS: Math.round((Date.now() - STARTED_AT) / 1000) });
  await fetchSessionIndex();
  const indexAgeS = sessionIndex.at ? Math.round((Date.now() - sessionIndex.at) / 1000) : null;
  const ok = indexAgeS !== null && indexAgeS <= 60;
  return sendJson(res, ok ? 200 : 503, {
    ok,
    version: VERSION,
    epoch: hub.epoch ?? null,
    uptimeS: Math.round((Date.now() - STARTED_AT) / 1000),
    upstream: { ok, indexAgeS, directories: hub.directories().length },
    hub: { streams: streamCount(), busy: Object.keys(hub.busySnapshot()).length, stalled: Object.keys(hub.stalledSnapshot()).length },
    claude: { runs: Object.keys(claude.busySnapshot()).length },
    store: { bindings: bindings.size(), authSessions: sessionCount() },
  });
}

// CSRF (BUG-12.9): a mutating request from another site is refused. Browsers
// send Origin on cross-origin POST/PATCH/DELETE and Sec-Fetch-Site on all
// modern requests; curl/scripts send neither and pass (they authenticate
// with a Bearer token or a cookie they own).
function crossSite(req) {
  const m = req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  const site = String(req.headers["sec-fetch-site"] ?? "");
  if (site === "cross-site") return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  if (origin === "null") return true; // sandboxed documents (lib/file.js CSP)
  try {
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim().toLowerCase();
    return new URL(origin).host.toLowerCase() !== host;
  } catch {
    return true;
  }
}

function route(req, res, url) {
  const p = url.pathname;

  if (p === "/zai/api/healthz" && req.method === "GET") return handleHealthz(req, res);

  if (p.startsWith("/zai/api/") && crossSite(req)) return sendJson(res, 403, { error: "cross-site request refused" });

  // ---- token auth --------------------------------------------------------
  // Login exchanges the token for a session cookie (TASK-12.21); that cookie
  // keeps a device logged in for a year and is what EventSource / file
  // downloads authenticate with.
  if (p === "/zai/api/auth/login" && req.method === "POST") return handleLogin(req, res);
  if (p === "/zai/api/auth/logout" && req.method === "POST") {
    // Logout REVOKES the session server-side, not just the cookie (BUG-12.9).
    const a = authFromReq(req);
    if (a?.kind === "sid") destroySession(a.sid);
    clearAuthCookie(res, isHttps(req));
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/zai/api/auth/me" && req.method === "GET") {
    const a = authFromReq(req);
    if (!a) {
      // Mock/dev surface: a canned identity lets QA harnesses open the app.
      if (MOCK) return sendJson(res, 200, { user: { id: "mock", name: "QA", role: "admin" } });
      return sendJson(res, 401, { error: "unauthorized" });
    }
    res.zaiUser = a.user.id;
    if (a.kind === "legacy") setAuthCookie(res, createSession(a.user), isHttps(req));
    return meFace(a.user).then((u) => sendJson(res, 200, { user: u }));
  }

  if (p.startsWith("/zai/api/")) {
    if (MOCK) {
      // Fixture/dev surface: canned data, no tenancy semantics.
      try {
        if (!mockHandler(req, res)) sendJson(res, 404, { error: "unknown route" });
      } catch (err) {
        errLog("mock", err);
        if (!res.headersSent) sendJson(res, 500, { error: "mock error" });
      }
      return;
    }
    const a = authFromReq(req);
    if (!a) return sendJson(res, 401, { error: "unauthorized" });
    res.zaiUser = a.user.id;
    // ADR-009 п.4: a legacy raw-token cookie is swapped for a session cookie
    // on the first authenticated response.
    if (a.kind === "legacy") setAuthCookie(res, createSession(a.user), isHttps(req));
    if (rateLimited(a.user, req.method)) {
      req.resume();
      return sendJson(res, 429, { error: "слишком много запросов, повторите через минуту" });
    }
    Promise.resolve()
      .then(() => handleApi(req, res, url, a.user))
      .catch((err) => internalError(res, err, "handleApi"));
    return;
  }

  if (!p.startsWith("/zai")) return sendJson(res, 404, { error: "not found" });
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
  serveStatic(req, res, p);
}

const server = http.createServer((req, res) => {
  // Request id + access log (ADR-007): one line per request when it ends;
  // the path only (no query — it can carry file paths), never cookies.
  const rid = requestId();
  const started = Date.now();
  res.zaiRid = rid;
  res.setHeader("x-request-id", rid);
  res.on("close", () => {
    let pathOnly = "";
    try {
      pathOnly = new URL(req.url, "http://x").pathname;
    } catch {
      pathOnly = "(bad url)";
    }
    logAccess({
      ts: new Date(started).toISOString(),
      rid,
      method: req.method,
      path: pathOnly.slice(0, 300),
      status: res.statusCode,
      ms: Date.now() - started,
      user: res.zaiUser ?? null,
      ip: clientIp(req),
      ...(res.writableFinished ? {} : { aborted: true }),
    });
  });

  // BUG-12.12: no synchronous throw in routing may take the process down.
  try {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return sendJson(res, 400, { error: "bad request" });
    }
    const out = route(req, res, url);
    if (out && typeof out.catch === "function") out.catch((err) => internalError(res, err, "route"));
  } catch (err) {
    internalError(res, err, "route");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  if (!MOCK) {
    hub.start(UPSTREAM, { directory: HOME_DIR });
    hub.syncDirectories(); // subscribe to every directory that has sessions
    // gc sweep (empty chats, leftover tenant folders): once shortly after the
    // start (the hub has seeded busy/dialog state by then), then periodically.
    const every = config.ZAI_GC_INTERVAL_MS;
    setTimeout(() => gcSweep(), Math.min(every, 30_000)).unref();
    setInterval(() => gcSweep(), every).unref();
  }
  const { port } = server.address();
  console.log(`zai listening on http://127.0.0.1:${port} (mock:${MOCK ? 1 : 0})`);
});
// Startup failures (e.g. port taken) exit with one clean line, not a stack.
server.on("error", (err) => {
  console.error(`zai server error: ${err.message}`);
  process.exit(1);
});

function shutdown() {
  // FEAT-06.2: the voice worker also exits on its own when its stdin closes
  // (a hard kill of this process), see ops/voice/voice-worker.py.
  try {
    voiceService?.stop();
  } catch {}
  // BUG-13.5: kill live claude CLIs; claude-runs.json lets the next start
  // answer the interrupted questions honestly.
  try {
    claude.shutdown();
  } catch (err) {
    errLog("claude.shutdown", err);
  }
  hub.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref(); // force-exit stragglers
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
