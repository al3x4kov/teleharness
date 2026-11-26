// teleharness server: static UI from public/ plus /teleharness/api/* served either by the
// fixture mock (TELEHARNESS_MOCK=1) or by the real opencode proxy + SSE hub.
// Zero runtime dependencies - node stdlib only.
import http from "node:http";
import {createHash} from "node:crypto";
import { tenantJailFor, tenantKit } from "./lib/claude-tenant.js";
import { chatFolderFor, ensureChatFolder, existingChatFolder } from "./lib/chat-folder.js";
import { Worktrees, WorktreeStore } from "./lib/worktrees.js"; // FEAT-20.7
import { worktreeRoutes } from "./routes/worktrees.js"; // FEAT-20.7
import { worktreeRule } from "./shared/worktree.js"; // FEAT-20.7
import { linuxJailLine } from "./lib/linux-jail.mjs"; // FEAT-20.7: тесты тенанта в песочнице
import { GitError } from "./lib/git.js"; // FEAT-20.7
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, configErrors, configSources, describeConfig, PROD_UPSTREAM_PORTS } from "./lib/config.js"; // BUG-224
import { mockHandler } from "./lib/mock.js";
import { pageParams, paginateMessages, proxyRequest } from "./lib/proxy.js";
import { applySecurityHeaders, serveStatic } from "./lib/static.js";
import { createListCache } from "./lib/list-cache.js"; // BUG-260
import { setCapped } from "./lib/capped-map.js";
import { EventHub } from "./lib/hub.js";
import { createOcClient } from "./lib/oc-client.js"; // FEAT-16.3 (3.3): клиент для хаба
import { hostStats, opencodeVersion, harnessVersions, setOpencodeInfoSource } from "./lib/host.js";
import { usageStats } from "./lib/usage.js";
import { subscriptionCards } from "./lib/subscriptions.js";
import { JournalWriter, isJournalAccess, journalRule } from "./lib/chat-journal.js";
import { ChatSearchIndex } from "./lib/chat-search.js"; // FEAT-01.60
import { RelayStore, marksForJournal, mergeFeeds, missedTurns, planRelay, relayMark, relayRule, withCatchUp } from "./lib/relay.js";
import { AUTO_RELAY_ORDER_MAX, cleanAutoRelay, createAutoRelay, readAutoRelay } from "./lib/auto-relay.js"; // FEAT-18.6
import { isLimitError } from "./shared/turn-error.js"; // FEAT-18.6: общий с клиентом классификатор
import { RELAY_REASON_AUTO, RELAY_RESUME_TEXT } from "./shared/relay.js";
import { Readable, Writable } from "node:stream";
import { materializeFileParts, modelAcceptsImages, openUnique, sanitizeFilename, UPLOAD_DIR, visionSibling } from "./lib/attach.js";
import { serveWorkspaceFile, workspaceFileExists } from "./lib/file.js";
import { parseWindows, turnFiles } from "./lib/turn-files.js";
import { dirProblem, dirProblemText, driveProblem, isUnderAny, pathInside } from "./lib/paths.js";
import { accessLogger, auditTemporalCommand, clientIp, errLog, requestId, upstreamErrors5m } from "./lib/accesslog.js";
import { markClean, markStarted, readPrevious } from "./lib/run-state.js"; // TASK-12.29
import { adminAgentFor, adminDefaultAgent, agentAllowedForTenant, defaultTenantAgent, modelInCatalog, parseModelRef, pickDefaultModel, providerForUser, publicAgent, redactMessages, redactPart, setTenantVaultRoots, tenantAgents, tenantEvent, tenantMustReject } from "./lib/policy.js";
import { PendingRemovals, findOwnerlessTenantDirs, planGc, runEmptyChatGc, sweepOwnerlessTenantDirs, sweepTurnUndo } from "./lib/gc.js";
import { TurnUndo, isInside, physicalDir } from "./lib/turn-undo.js";
import { AutoTitler, TitleStore, makeClaudeTitler } from "./lib/title.js";
import { markEmptyTail } from "./lib/empty-turn.js";
import { buildSnapshot as buildKbSnapshot, zoneForUser as kbZoneForUser } from "./lib/kb-cache.js";
import { storeKbTrace } from "./lib/kb-trace.js";
import { dispatchRoute, validateTable } from "./routes/router.js";
import { fileRoutes } from "./routes/files.js";
import { catalogRoutes } from "./routes/catalog.js";
import { GeminiLoginSessions } from "./lib/acp-login-session.js";
import { CopilotLoginSessions } from "./lib/acp-copilot-login.js";
import { AgyLoginSessions } from "./lib/acp-agy-login.js";
import { launchCopilotLogin, launchGeminiLogin, launchAgyLogin, markAcpProfile, acpProfileReady } from "./lib/acp-login-launch.js";
import { cachedAcpModels, discoverAcpModels } from "./lib/acp-models.js";
import { acpProviderCatalog, AcpRegistry } from "./lib/acp-registry.js";
import { AcpInstaller } from "./lib/acp-install.js";
import { acpCatalogRoutes } from "./routes/acp-catalog.js";
import { acpLoginRoute } from "./routes/acp-login.js";
import { adminRoutes } from "./routes/admin.js";
import { gitRoutes } from "./routes/git.js"; // FEAT-18.8
import { temporalRoutes } from "./routes/temporal.js"; // FEAT-19.4
import {chatRoutingForPortal,chatRecoveryGuard} from "./lib/temporal/chat-routing.js";
import {connectPipeline} from "./lib/temporal/portal-runtime.js";
import {scheduleRoutes} from "./routes/temporal-schedules.js";
import { stageTimerStarter } from "./lib/temporal/stage-timer.js";
import { socketPathProblem } from "./lib/temporal/cli.js";
import { CommandCatalog } from "./lib/temporal/command-catalog.js";
import { ExternalWorkflowsClient } from "./lib/temporal/external-workflows.js";
import { DefinitionStore } from "./lib/temporal/definitions.js";
import { chatStepRunner } from "./lib/temporal/chat-step.js";
import { prStepRunner } from "./lib/temporal/pr-step.js";
import { projectCandidate } from "./lib/temporal/workspace.js";
import { PORTAL_FILE_RULE, SYSTEM_PROMPT_MAX, cleanSystemPrompt, withUserSystem, withUserSystemBody } from "./lib/user-prompt.js";
import { withGlmVariant, withGlmVariantBody } from "./lib/glm-variant.js";
import { commandBody, parseSlash } from "./lib/slash.js";
import { createInstanceHealth } from "./lib/instance-health.js";
import { createInstanceReaper } from "./lib/instance-reaper.js";
import { sessionRoutes } from "./routes/session.js";
import { clearReverting, isReverting, markReverting, withSessionLock } from "./lib/session-lock.js"; // BUG-218 (design §1)
import { pushRoutes } from "./routes/push.js";
import { githubRoutes } from "./routes/github.js";
import { loadKey, encrypt as encryptSecret, decrypt as decryptSecret, last4, redact } from "./lib/github/secrets.js";
import { connectionService } from "./lib/github/connections.js";
import { checkConnection, ghFetch, ghText, GhError } from "./lib/github/client.js";
import { createTokenWatchdog } from "./lib/github/watchdog.js";
import { triggerService } from "./lib/github/triggers.js";
import { createDispatcher, cleanInputs, eventFace } from "./lib/github/dispatch.js";
import { frameAgentText, fetchCiLog } from "./lib/github/ci-logs.js";
import { createPermissionCache } from "./lib/github/permissions.js";
import { createGithubHookHandler } from "./lib/github/hook.js";
import { createGithubPoller } from "./lib/github/poller.js";
import { triggerRoutes, checkGitOrigin } from "./routes/temporal-triggers.js";
import { randomUUID } from "node:crypto";
import { attentionRoutes } from "./routes/attention.js"; // FEAT-20.2
import { reviewRoutes } from "./routes/review.js"; // FEAT-20.1
import { ReviewService, ReviewStore } from "./lib/review.js"; // FEAT-20.1
import { planExecText, planReviseText } from "./shared/review-message.js"; // FEAT-20.1
import { AttentionStore, OutcomeObserver, outcomeOfError, clip as attentionClip } from "./lib/attention.js";
import { turnErrorKind } from "./shared/turn-error.js";
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
  getAutoRelay,
  setAutoRelay,
  getGitSettings, // FEAT-18.8
  setGitSettings,
  cleanGitSettings,
  PINS_MAX,
  engineAllowed,
  adminUser,
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
  // TASK-04.15: hourly session sweep + healthz inactivity counter + login limits
  sweepSessions,
  authSessionsStale90d,
  loginThrottled,
  loginFailure,
  loginSuccess,
  // FEAT-18.2: one-time phone sign-in codes
  createPairCode,
  claimPairCode,
  claimThrottled,
  claimFailure,
} from "./lib/auth.js";
import { ClaudeRunner, DEFAULT_BIN as CLAUDE_DEFAULT_BIN, checkMcpConfig } from "./lib/claude.js";
import { ClaudeAgentCatalog, isClaudeAgentId } from "./lib/claude-agents.js";
import { VoiceQuota, VoiceService } from "./lib/voice.js";
import { voiceRoutes } from "./routes/voice.js";
import { BindingStore, OC_PLAN_RULES, applyBinding, cleanModel, cleanPermMode, effectivePermMode, engineOf, makeBinding, ocPermRules, patchBinding, planUnsupported, resolveBinding } from "./lib/binding.js";
import { isRunnerEngine, CLAUDE_PROVIDER, CODEX_PROVIDER, CLAUDE_MODELS, ACP_PROVIDERS } from "./shared/engine.js";
import { createCodexCatalog } from "./lib/codex-catalog.js"; // FEAT-18.7 // FEAT-18.7: claude и codex — ходы раннера CLI
import { CostLedger } from "./lib/cost/ledger.js"; // FEAT-20.6: журнал расхода по ценам API
import { CostReports } from "./lib/cost/report.js";
import { CostRecorder } from "./lib/cost/recorder.js";
import { CostBackfill } from "./lib/cost/backfill.js";
import { costRoutes } from "./routes/costs.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// TASK-12.19 / ADR-006: a typo in env (TELEHARNESS_STALL_ABORT_MS=9oo000) is a
// startup error with a readable message, not a silently disabled watchdog.
if (configErrors.length > 0) {
  for (const e of configErrors) console.error(`[teleharness-config] ${e}`);
  process.exit(1);
}
console.log(`[teleharness-config] ${describeConfig(config, configSources)}`);

const PORT = config.PORT;
const MOCK = config.TELEHARNESS_MOCK;
const UPSTREAM = config.TELEHARNESS_UPSTREAM;
// FEAT-16.3 (tasks 3.2): ОДИН клиент opencode на процесс — его получают хаб,
// instance-health и все маршруты. api: "v1" (1.19.5, по умолчанию) | "v2";
// пароль v2 живёт только в Authorization клиента (lib/oc-client.js).
const OC = createOcClient({
  api: config.TELEHARNESS_OC_API === "v2" ? "v2" : "v1",
  base: UPSTREAM,
  ...(config.TELEHARNESS_OC_PASSWORD ? { password: config.TELEHARNESS_OC_PASSWORD } : {}),
});
// BUG-190: версия opencode 2.x — из /api/info через адаптер (на /global/health у v2 HTML)
if (OC.api === "v2") setOpencodeInfoSource(() => OC.healthInfo({ timeoutMs: 2000 }));
// Защита «закрыто при отказе» (FEAT-16.3, v2fix1 2026-11-08): opencode 2.x при
// непогрузке плагина пишет только WARN в свой лог и продолжает работать БЕЗ
// песочницы. Портал в v2-режиме не пускает ходы тенантов (403 с понятным
// текстом), пока serve не подтвердит плагин через plugin.list — GET /api/plugin
// («Retrieve enabled server plugins and their current status»); админ-ходы не
// затронуты. Форма ответа не нормализуется — ищем id плагина в теле.
// Fail-closed: сетевая ошибка / не-2xx / нет id — ход закрыт. Кэш короткий:
// позитив 15 с, негатив 3 с (плагин мог загрузиться между попытками).
const SANDBOX_PLUGIN_ID = "teleharness-tenant-v2";
let pluginGate = { ok: false, until: 0 };
async function sandboxPluginConfirmed() {
  const now = Date.now();
  if (now < pluginGate.until) return pluginGate.ok;
  let ok = false;
  try {
    const out = await OC.pluginList({ timeoutMs: 5_000 });
    // Claude review: the plugin must be listed AND active — a plugin that failed to load may still
    // be listed with another status; a bare substring match would confirm it (open on failure).
    // Live 2.2.6 shape: {data:[{id, source, state:{status:"active"}}]}.
    let json = out?.json;
    if (json == null && typeof out?.text === "string") try { json = JSON.parse(out.text); } catch {}
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    ok = list.some((p) => p?.id === SANDBOX_PLUGIN_ID && p?.state?.status === "active");
    if (!ok) errLog("pluginGate", new Error(`serve не подтвердил активный плагин ${SANDBOX_PLUGIN_ID} — тенантские ходы закрыты`));
  } catch (err) {
    errLog("pluginGate", err);
  }
  pluginGate = { ok, until: now + (ok ? config.TELEHARNESS_PLUGIN_GATE_TTL_MS : config.TELEHARNESS_PLUGIN_GATE_TTL_NEG_MS) };
  return ok;
}
// BUG-183: poisoned opencode per-folder services (lib/instance-health.js) — warm-up and self-heal.
const instanceHealth = createInstanceHealth({ upstream: UPSTREAM, oc: OC, log: (m) => console.log(m) });
// BUG-195: opencode держит экземпляр (+ MCP-процессы) каждой папки, к которой
// обращался портал, до рестарта serve. Реапер освобождает папки после простоя
// TELEHARNESS_INSTANCE_IDLE_MIN минут, если там не идёт ход; HOME/папка чатов — никогда.
// Активность = прогрев/лечение перед ходом и созданием чата (обёртка warm/ready
// ниже) и чтение истории (sessionMessagesRoute).
const instanceReaper = createInstanceReaper({
  idleMs: Math.max(1, config.TELEHARNESS_INSTANCE_IDLE_MIN) * 60_000,
  isProtected: (d) => {
    const n = normDir(d);
    return !n || n === normDir(HOME_DIR) || n === normDir(CHAT_DIR);
  },
  isBusy: (d) => instanceHealth.busy(d),
  dispose: async (d) => {
    if (!(await disposeInstance(d))) throw new Error("dispose failed");
    instanceHealth.forget(d);
  },
  log: (m) => console.log(m),
});
for (const m of ["warm", "ready"]) {
  const orig = instanceHealth[m];
  instanceHealth[m] = (dir, ...rest) => {
    instanceReaper.touch(dir);
    return orig(dir, ...rest);
  };
}
// BUG-171: Sandbox may reach the tenants' knowledge-base root (each tenant its own zone — plugin guard).
setTenantVaultRoots([config.TELEHARNESS_TENANT_VAULT]);
// ADR-003 п.2 (Г8): a stand/test instance never talks to the prod opencode —
// the stand used to see, prompt and delete every prod session (BUG-12.8).
// BUG-224: prod upstream ports are ONE list (lib/config.js) — 1.x :4096 AND
// 2.x :4196 (the v2 prod serve; the guard used to know only :4096).
if (config.TELEHARNESS_ENV !== "prod" && !MOCK) {
  let upPort = "";
  try {
    const u = new URL(UPSTREAM);
    upPort = u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {}
  if (PROD_UPSTREAM_PORTS.includes(Number(upPort))) {
    console.error(`[teleharness-config] TELEHARNESS_ENV=${config.TELEHARNESS_ENV} отказывается работать с прод-upstream :${upPort} (${UPSTREAM})`);
    process.exit(1);
  }
}
// Auto-unstick: a turn stuck busy with zero events for this long gets a
// server-side abort (opencode has no watchdog; hung sessions would otherwise
// stay dead forever — live incident 2026-10-31). 0 disables.
const STALL_ABORT_MS = config.TELEHARNESS_STALL_ABORT_MS;
// Auto-unstick part 2: an open permission/question dialog older than this is
// auto-denied server-side (permission → {reply:"reject"}, question → reject).
// 0 (the default, FEAT-07.15) = never auto-deny: a dialog waits for the human.
const DIALOG_TIMEOUT_MS = config.TELEHARNESS_DIALOG_TIMEOUT_MS;
// Auto-unstick part 3: the hub re-posts the last unanswered prompt once it
// has sat this long while idle; STALL_REPLAY_MAX caps the chain. 0 disables.
const STALL_REPLAY_MS = config.TELEHARNESS_STALL_REPLAY_MS;
const STALL_REPLAY_MAX = config.TELEHARNESS_STALL_REPLAY_MAX;
// Merged /teleharness/api/status cache TTL (the cache lives in routes/catalog.js).
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
  console.error(`[teleharness-fatal] uncaughtException: ${err?.stack ?? err}`);
  // TASK-13.27: last chance to land the deferred claude store write before
  // the watchdog restart takes over.
  try {
    claude?.flushNow();
  } catch {}
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
  console.error(`[teleharness-auth] ${err.message}`);
  process.exit(1);
}

const logAccess = accessLogger({ dir: config.TELEHARNESS_LOG_DIR, enabled: config.TELEHARNESS_ACCESS_LOG });

// Server-side session index (id -> directory): the authorization source for
// every session-scoped call. The client-supplied ?directory= is a hint, never
// a trust anchor — the record in the upstream index decides.
const INDEX_TTL_MS = 10_000;
let sessionIndex = { at: 0, byId: new Map(), recById: new Map() };

async function fetchSessionIndex(force = false) {
  if (!force && Date.now() - sessionIndex.at < INDEX_TTL_MS) return sessionIndex.byId;
  try {
    const list = await OC.listSessions({}, { timeoutMs: 8000 }); // v2: /api/session → записи с directory
    if (Array.isArray(list)) {
      const byId = new Map();
      const recById = new Map();
      for (const s of list) {
        if (typeof s?.id !== "string") continue;
        byId.set(s.id, s.directory ?? null);
        recById.set(s.id, s);
      }
      sessionIndex = { at: Date.now(), byId, recById };
    }
    sessionIndex.failAt = 0;
  } catch (err) {
    sessionIndex.failAt = Date.now(); // FEAT-20.2: доска — «Неизвестно — нет связи с opencode»
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
    const list = await OC.listAgents({ timeoutMs: 10_000 }); // v2: /api/agent с mode/permissions (api-map №21)
    if (Array.isArray(list)) agentCache = { at: Date.now(), list };
  } catch (err) {
    errLog("agentList", err);
  }
  return agentCache.list ?? [];
}

// BUG-188: names of the slash commands of a chat folder (v1 GET /command,
// v2 GET /api/command — api-map «Команды», tasks 3.8), 60 s cache per folder —
// the same TTL as the agent catalog. On upstream failure the stale set lives
// on; nothing known → empty set → the text goes as a plain prompt (a command
// never blocks a turn).
const commandCache = new Map(); // dir → {at, names:Set}
async function commandNames(dir) {
  const key = dir ?? "";
  const hit = commandCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.names;
  try {
    const list = await OC.listCommands({ directory: dir, timeoutMs: 10_000 }); // v2 отдаёт тот же язык 1.x (адаптер разворачивает конверт)
    if (Array.isArray(list)) {
      const names = new Set(list.map((c) => (typeof c?.name === "string" ? c.name : "")).filter(Boolean));
      setCapped(commandCache, key, { at: Date.now(), names }, 500); // SRV-23: без потолка кэш рос с каждой новой папкой
      return names;
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
  const rid = res.teleharnessRid ?? null;
  errLog(`${place} rid=${rid}`, err, { throttleMs: 0 });
  if (res.headersSent) return void res.destroy();
  return sendJson(res, 500, { error: "Внутренняя ошибка сервера", rid });
}

function upstreamError(res, err, place) {
  errLog(place, err);
  if (res.headersSent) return void res.destroy();
  return sendJson(res, 502, { error: "Сервер агента недоступен", rid: res.teleharnessRid ?? null });
}

// ---- FEAT-16.3 (tasks 3.2/3.4): общий faces для веток OC --------------------
// Определённый отказ upstream (OcError.status ≥ 400) — читаемый статус и тело
// {_tag}; сеть/таймаут — прежний 502 «Сервер агента недоступен».
function ocUpstreamError(res, err, place) {
  if ((err?.status ?? 0) >= 400) return sendJson(res, err.status, err.body && typeof err.body === "object" ? err.body : { error: `upstream: ${err.status}` });
  return upstreamError(res, err, place);
}

// Вся история чата через адаптер (для reverт-логики и полного просмотра —
// там, где v1 забирал список целиком).
async function ocWholeMessages(id, dir) {
  const out = await OC.listMessages(id, { directory: dir ?? null, all: true });
  return Array.isArray(out.messages) ? out.messages : null;
}

// Страница из listMessages адаптера (уже нарезана) с теми же заголовками
// x-teleharness-has-more / x-teleharness-next-before, что у sendPaged (BUG-08.8).
function sendOcPage(res, out, mapList = null) {
  const page = mapList && Array.isArray(out.messages) ? mapList(out.messages) : out.messages;
  res.setHeader("x-teleharness-has-more", out.hasMore ? "1" : "0");
  if (out.nextBefore) res.setHeader("x-teleharness-next-before", out.nextBefore);
  return sendJson(res, 200, page);
}

// The edge sets x-forwarded-proto from its listener (ADR-009); this server
// listens on loopback only, so the header is trusted.
function isHttps(req) {
  return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

// POST /teleharness/api/auth/login {token}: the token is the credential itself; a
// match mints a random session id cookie (TASK-12.21) — the raw token never
// sits in the cookie jar. JSON only (BUG-12.9: a text/plain form could log a
// victim into the attacker's account).
// TASK-04.15 (SRV-21): >10 failed attempts per address per minute → 429
// before any token check; a success resets the address (lib/auth.js keeps
// the windowed counter). SRV-22: oversize body → 413, broken JSON → 400 —
// readJsonBody conflates both into null, so the body is read here directly;
// its other callers stay unchanged.
async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (loginThrottled(ip)) {
    req.resume();
    return sendJson(res, 429, { error: "too many attempts" });
  }
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
    req.resume();
    loginFailure(ip);
    return sendJson(res, 415, { error: "ожидается application/json" });
  }
  const raw = await readBody(req, 16 * 1024);
  if (raw === null) {
    loginFailure(ip);
    return sendJson(res, 413, { error: "тело больше лимита" });
  }
  let body = null;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    loginFailure(ip);
    return sendJson(res, 400, { error: "тело не является JSON" });
  }
  const user = typeof body?.token === "string" ? userByToken(body.token) : null;
  if (!user) {
    loginFailure(ip);
    return sendJson(res, 401, { error: "invalid token" });
  }
  loginSuccess(ip);
  setAuthCookie(res, createSession(user), isHttps(req));
  return sendJson(res, 200, { user: await meFace(user) });
}

// FEAT-18.2: POST /teleharness/api/auth/pair/claim {code} — the phone that scanned
// the QR swaps the one-time code for an ordinary session (the same cookie as
// a token login). Unauthenticated by design; JSON only (BUG-12.9). Failures
// count per address and globally (lib/auth.js claimThrottled → 429). A phone
// that already had a session of its own drops it (the cookie is replaced).
async function handlePairClaim(req, res) {
  const ip = clientIp(req);
  if (claimThrottled(ip)) {
    req.resume();
    return sendJson(res, 429, { error: "слишком много попыток — подождите минуту" });
  }
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
    req.resume();
    claimFailure(ip);
    return sendJson(res, 415, { error: "ожидается application/json" });
  }
  const body = await readJsonBody(req, 4 * 1024);
  let user;
  try {
    user = claimPairCode(body?.code);
  } catch (err) {
    claimFailure(ip);
    return apiError(res, err);
  }
  const prev = authFromReq(req);
  if (prev?.kind === "sid") destroySession(prev.sid);
  setAuthCookie(res, createSession(user), isHttps(req));
  res.teleharnessUser = user.id;
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
    out.defaultAgent = defaultTenantAgent(agents, config.TELEHARNESS_TENANT_AGENT);
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

// TASK-19.9. Only the staging v2 cohort advertises optional durable inbox IDs.
const turnIdsFrom=config.TELEHARNESS_ENV==="stand" && OC.api==="v2" ? Date.parse(process.env.TELEHARNESS_TEMPORAL_TURN_IDS_FROM) : NaN;
const stableTurnIds=session=>Number.isFinite(turnIdsFrom) && Number.isSafeInteger(session?.time?.created) && session.time.created>=turnIdsFrom;
const recovery=chatRecoveryGuard({
  checkTurn:(user,sid)=>chatRouting.checkTurn(user,sid),
  lookup:Number.isFinite(turnIdsFrom) ? async sid=>{
    const record=await sessionRecord(sid,true);
    return record && {cohort:stableTurnIds(record),directory:record.directory};
  } : null,
  authorize:(id,dir)=>{
    const user=getUser(id);
    return user && !user.disabled && dir && dirAllowed(user,dir) && engineAllowed(user,"opencode");
  }
});
const hub = new EventHub({
  canRecoverChat:sid=>recovery.allowed(sid),
  replayInboxId:async (sid,id)=>/^msg_19f5[a-f0-9]{28}$/.test(id) && stableTurnIds(await sessionRecord(sid)) ? id : null,
  stallAbortMs: STALL_ABORT_MS,
  dialogTimeoutMs: DIALOG_TIMEOUT_MS,
  stallReplayMs: STALL_REPLAY_MS,
  maxPromptReplays: STALL_REPLAY_MAX,
  pendingStatePath: path.join(DATA_DIR, "hub-pending.json"), // BUG-07.12: replay counters survive restarts
  loopAbortCount: config.TELEHARNESS_LOOP_ABORT_COUNT, // BUG-07.7 (0 disables)
  promptUnstickMs: config.TELEHARNESS_PROMPT_UNSTICK_MS, // BUG-07.10
  // FEAT-16.3 (tasks 3.3): все обращения хаба к opencode — через общий
  // клиент OC (TELEHARNESS_OC_API, пароль — только Authorization).
  oc: OC,
});

// FEAT-12.16 + BUG-197: tenants never see raw tool input/output in the live
// stream, and only the event types the client understands reach them —
// tenantEvent (lib/policy.js) is the SSE transform of a tenant connection.

// BUG-01.28: smoke/QA probes create chats under the system temp tree
// (%TEMP%\teleharness-claude-smoke, Temp\oc_*); those never belong in «Чаты».
const TEMP_ROOTS = [os.tmpdir(), process.env.TEMP, process.env.TMP].filter(Boolean);
function isTempSessionDir(dir) {
  return config.TELEHARNESS_HIDE_TEMP_SESSIONS && isUnderAny(dir, TEMP_ROOTS);
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
const voiceService = config.TELEHARNESS_VOICE
  ? new VoiceService({ python: config.TELEHARNESS_VOICE_PYTHON, script: config.TELEHARNESS_VOICE_WORKER || path.join(ROOT, "ops", "voice", "voice-worker.py"), models: config.TELEHARNESS_VOICE_MODELS })
  : null;
const voiceQuota = new VoiceQuota({ ttsChars: config.TELEHARNESS_VOICE_TENANT_TTS_CHARS, sttSeconds: config.TELEHARNESS_VOICE_TENANT_STT_SEC });
// FEAT-13.10: Playwright (and other) MCP servers for ADMIN claude chats; a
// missing/broken file is logged and ignored instead of failing every turn.
const claudeMcp = checkMcpConfig(config.TELEHARNESS_CLAUDE_MCP_CONFIG || null);
if (claudeMcp.error) console.warn(`[teleharness-claude] MCP config ignored: ${claudeMcp.error}`);
else if (claudeMcp.file) console.log(`[teleharness-claude] MCP for admin chats: ${claudeMcp.servers.join(", ")} (${claudeMcp.file})`);
// BUG-146: backups of opencode turns, written by the vault-cache plugin
// (ops/opencode) into the same root as the Claude ones.
const ocUndo = new TurnUndo({ root: config.TELEHARNESS_TURN_UNDO_ROOT });
let temporalChatSteps = null; // FEAT-19.16: model steps of pipes run as chat turns
// FEAT-20.2: доска внимания — исходы ходов и личные отметки (<data>/attention).
let attentionInterrupted = 0; // ходов прервано перезапуском (восстановление раннера при старте)
const attention = new AttentionStore({ dir: path.join(DATA_DIR, "attention"), log: (m) => console.error(m) });
const ATTENTION_EVENT_TEXT = { done: "Готово", error: "Упало", limit: "Лимит подписки", auth: "Нужен вход в движок", restart: "Остановлен перезапуском сервера", stalled: "Остановлен: ход завис" };
// Исход хода → хранилище, событие сводки «Пока вас не было» и личное событие
// владельцам папки чата (правило pushRecipients: тенант — свои, admin — ничьи).
function attentionOutcome(sid, rec, dir = null) {
  try {
    const d = claude.dirOf(sid) ?? sessionIndex.byId.get(sid) ?? dir ?? null; // папка — из индекса, поток событий — запасной вариант
    const out = attention.setOutcome(sid, { ...rec, dir: d });
    if (!out) return;
    const users = pushRecipients(d);
    const title = claude.titleInfo(sid)?.title || sessionIndex.recById.get(sid)?.title || "чат";
    const kind = out.kind === "done" ? "done" : out.kind === "limit" ? "limit" : "failed";
    attention.addEvent(users, { at: out.at, kind, key: `chat:${sid}`, text: `${ATTENTION_EVENT_TEXT[out.kind] ?? out.kind}: «${title}»` });
    attentionPing(users, "outcome");
  } catch (err) {
    errLog("attention.outcome", err);
  }
}
function attentionPing(users, reason) {
  const evt = JSON.stringify({ type: "teleharness.attention", properties: { reason } });
  for (const u of new Set(users ?? [])) hub.broadcastToUser(u, evt);
}
// Строка-итог готового хода Claude/Codex — первая строка последнего ответа.
function lastAnswerSnippet(sid) {
  try {
    const list = claude.messages(sid) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m?.info?.role !== "assistant") continue;
      const text = (m.parts ?? []).filter((p) => p?.type === "text").map((p) => p.text ?? "").join(" ");
      if (text.trim()) return attentionClip(text);
    }
  } catch {}
  return null;
}
const claude = new ClaudeRunner({
  hub,
  storePath: path.join(DATA_DIR, "claude-sessions.json"),
  undoRoot: config.TELEHARNESS_TURN_UNDO_ROOT,
  onTurnEnd: (e) => {
    if (temporalChatSteps?.owns(e?.sid)) { temporalChatSteps.onTurnEnd(e); return titler?.claudeTurnDone(e); } // a pipe step: no push, no auto-relay
    if (e?.sid && e.reason !== "deleted") reviewTurnEnd(e.sid, e.dir ?? null, { interrupted: Boolean(e.reason || e.error) }); // FEAT-20.1
    webPush?.notifier.claudeTurnEnd(e); // FEAT-07.20: «Готово: <чат>»
    // FEAT-20.2: исход хода для доски; остановка человеком/удаление — не исход
    if (e?.sid && !["user", "cancelled", "deleted"].includes(e.reason)) {
      const engine = engineOfChat(e.sid);
      const kind = e.reason === "restart" ? "restart" : e.reason ? "error" : e.error ? outcomeOfError(e.error, { engine }) : "done";
      if (kind) attentionOutcome(e.sid, { kind, errorKind: e.error ? turnErrorKind(e.error, { engine }) : null, snippet: kind === "done" ? lastAnswerSnippet(e.sid) : e.error ? String(e.error?.message ?? e.error) : null }, e.dir ?? null);
    }
    // FEAT-18.6 / BUG-295: ход раннера (Claude/Codex/ACP) упал по лимиту подписки → авто-передача
    if (e?.error && isLimitError(e.error, { engine: engineOfChat(e.sid) })) autoRelayOnLimit(e.sid, e.dir ?? null);
    if (e?.sid && e.reason !== "deleted") chatSearch?.syncClaudeSession(e.sid, claude.messages(e.sid)); // FEAT-01.60
    return titler?.claudeTurnDone(e);
  },
  // BUG-142: title as soon as the first question is stored (a Workflow turn
  // runs for hours); onTurnEnd above retries if this attempt failed.
  onTurnStart: (e) => {
    reviewTurnStart(e?.sid, e?.dir ?? null); // FEAT-20.1: база ревью — снимок перед ходом
    if (e?.sid) chatSearch?.syncClaudeSession(e.sid, claude.messages(e.sid)); // FEAT-01.60
    return titler?.claudeTurnDone(e);
  },
  // FEAT-20.1: ExitPlanMode план-хода; ход уже закончился (фоновый субагент, BUG-237) — план заменяет ответ
  onPlan: (e) => {
    if (!e?.sid) return;
    if (planTurns.has(e.sid)) return void planCaptured.set(e.sid, e.plan ?? "");
    const dir = reviewChatDir(e.sid, e.dir ?? null);
    if (dir) for (const user of pushRecipients(dir)) reviews.planFromTool(user, e.sid, e.plan ?? "");
  },
  // FEAT-20.2: ходы, прерванные перезапуском, — в «Упало или остановлено»
  onInterrupted: (list) => {
    attentionInterrupted = list.length;
    for (const x of list) attention.setOutcome(x.sid, { kind: "restart", at: x.at, dir: x.dir, snippet: null });
  },
  agents: claudeAgents,
  onAgentMissing: (e) => claudeAgentGone(e),
  mcpConfig: claudeMcp.file,
  // FEAT-04.11: tenants' Claude chats get the same kit as opencode tenants
  // (jailed cmd/Python, teleharness-* skills, marketplace).
  tenantKit: tenantKit({ dataDir: DATA_DIR, jailExe: process.env.TELEHARNESS_JAIL_EXE, sandboxPy: process.env.TELEHARNESS_SANDBOX_PY }),
  portalRule: PORTAL_FILE_RULE, // FEAT-05.29
  // FEAT-13.11: knowledge-base snapshot of a chat's first turn (only when the
  // zone folder exists: a missing vault means no cache, not an empty one).
  kbSnapshot: ({ dir, sid, zone }) => (zone?.root && existsSync(zone.root) ? buildKbSnapshot({ dir, sid, zone }) : null),
});

// A bound Claude agent vanished from the catalog (file removed/disabled):
// the turn already runs without it; the binding drops it and the chat says
// so (FEAT-13.17, mockup model-binding frame 14). BUG-218: the store update
// runs under the chat lock and reads the record afresh — a parallel PATCH
// must not be clobbered by a stale copy.
function claudeAgentGone({ sid, dir, name }) {
  void withSessionLock(sid, () => {
    const cur = bindings.get(sid);
    if (cur?.engine === "claude" && cur.agent) {
      const next = { ...cur, agent: null };
      bindings.set(sid, next);
      hub.emit({ type: "session.updated", properties: { sessionID: sid, info: { id: sid, teleharness: { ...makeBinding(next, { prompted: next.prompted }), source: "stored" } } } }, dir ?? null);
    }
  });
  hub.emit({ type: "teleharness.notice", properties: { sessionID: sid, text: `Агент «${name}» больше недоступен — ответ без агента.` } }, dir ?? null);
}

// BUG-218 (design §1): the turn-start write under the chat lock — it re-reads
// the stored record and flips ONLY prompted, so a parallel PATCH (its own
// lock section) is never overwritten by the prompt's stale copy. A turn
// starting while a revert is under way is refused: 409 revert in progress.
async function markPrompted(id, binding) {
  return withSessionLock(id, () => {
    if (isReverting(id)) return "revert in progress";
    const cur = bindings.get(id) ?? binding;
    bindings.set(id, { ...cur, prompted: true });
    // FEAT-11.18: журнал чата пересобирается и при приёме хода — событие конца прошлого хода
    // изредка не доходит, и журнал отставал бы на ход
    journal.schedule(id);
    chatSearch?.markDirty(id); // FEAT-01.60
    return null;
  });
}

// Chat binding (engine + model + agent per chat, lib/binding.js): the ONLY
// thing that decides where a prompt goes.
const bindings = new BindingStore({ storePath: path.join(DATA_DIR, "session-bindings.json") });
// FEAT-11.18 (шаг В): отметки передачи чата между движками и моделями.
// FEAT-18.7: каталог Codex (подписка ChatGPT владельца) — из кэша сразу, свежий в фоне;
// пока он пуст, модели Codex не предлагаются и не принимаются.
const codexCatalog = createCodexCatalog({ dataDir: DATA_DIR, onChange: (models) => claude.setCodexCatalog(models) });
if (MOCK) codexCatalog.load();
else codexCatalog.start();
const relays = new RelayStore(MOCK ? null : path.join(DATA_DIR, "relays.json"));
// Какой движок ведёт чат СЕЙЧАС: после передачи история Claude у чата остаётся, но ведёт его
// тот движок, что записан в привязке. Без записи — прежнее правило «есть история Claude».
function engineOfChat(id, binding = null) {
  return (binding ?? bindings.get(id))?.engine ?? (claude.has(id) ? "claude" : "opencode");
}
// Вся лента чата: у чата с передачами — истории обоих движков, слитые по времени.
async function wholeChatMessages(id, dir) {
  const own = claude.has(id) ? claude.messages(id) ?? [] : [];
  const live = claude.has(id) ? claude.liveAnswer(id) : null;
  if (live && !own.some((m) => m.info?.id === live.info.id)) own.push(live);
  let oc = [];
  try {
    oc = (await ocWholeMessages(id, dir)) ?? [];
  } catch {} // движок недоступен: история Claude всё равно показывается
  return mergeFeeds(oc, own);
}
// BUG-232: ходы, сделанные в другом движке и неизвестные нынешнему, вкладываются в запрос скрытой
// частью (lib/relay.js). Разово само собой: после своего хода пропущенных не остаётся.
async function withRelayCatchUp(id, dir, body, binding) {
  try {
    const mine = claude.has(id) ? claude.messages(id) ?? [] : [];
    let oc = [];
    try {
      oc = (await ocWholeMessages(id, dir)) ?? [];
    } catch {} // движок недоступен: остаются журнал и строка системного промпта
    // FEAT-18.7 / BUG-296: в сторе раннера ходы Claude, Codex и ACP вместе — определяем движок через engineOf
    const target = engineOfChat(id, binding);
    const runnerMsgEngine = (pid) => {
      const e = engineOf(pid);
      return isRunnerEngine(e) ? e : "claude";
    };
    const answerEngine = new Map();
    for (const m of mine) if (m?.info?.role === "assistant" && m.info.parentID) answerEngine.set(m.info.parentID, runnerMsgEngine(m.info.providerID));
    const engineOfMsg = (m) => (m?.info?.role === "assistant" ? runnerMsgEngine(m.info.providerID) : answerEngine.get(m?.info?.id) ?? target);
    const own = target === "opencode" ? oc : mine.filter((m) => engineOfMsg(m) === target);
    const other = target === "opencode" ? mine : [...oc, ...mine.filter((m) => engineOfMsg(m) !== target)];
    const missed = missedTurns(own, other);
    return withCatchUp(body, missed, { journalFile: journal.fileOf(id, kbZoneOfDir(dir)?.root ?? null) });
  } catch (err) {
    errLog("relay.catchUp", err);
    return body;
  }
}

// Auto titles (BUG-13.14 claude chats, BUG-01.27 snapshot-derived opencode
// titles). The generator is a short claude CLI call (cheapest model) with a
// heuristic fallback; TELEHARNESS_TITLE_LLM=0 → heuristic only.
titler = new AutoTitler({
  upstream: UPSTREAM,
  claude,
  hub,
  store: new TitleStore({ storePath: path.join(DATA_DIR, "session-titles.json") }),
  record: (id) => sessionRecord(id, true),
  llm:
    config.TELEHARNESS_TITLE_LLM && !MOCK
      ? makeClaudeTitler({
          binPath: process.env.TELEHARNESS_CLAUDE_BIN || CLAUDE_DEFAULT_BIN,
          model: config.TELEHARNESS_TITLE_MODEL,
          timeoutMs: config.TELEHARNESS_TITLE_TIMEOUT_MS,
          token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
        })
      : null,
});
if (!MOCK) hub.onEvent((data, dir) => titler.noteEvent(data, dir));

// FEAT-11.18 (шаг Б): журнал чата в базе знаний владельца чата — полная история обоих
// движков, пересобирается по концу каждого хода (lib/chat-journal.js).
// Зона: тенант, которому принадлежит папка чата, → его зона; иначе зона администратора.
function kbZoneOfDir(dir) {
  const owner = dir ? listUsers().find((u) => u.role !== "admin" && !u.disabled && dirAllowed(u, dir)) : null;
  return owner
    ? kbZoneForUser(owner, { admin: false, adminRoot: config.TELEHARNESS_KB_ROOT, tenantVault: config.TELEHARNESS_TENANT_VAULT })
    : kbZoneForUser(null, { admin: true, adminRoot: config.TELEHARNESS_KB_ROOT, tenantVault: config.TELEHARNESS_TENANT_VAULT, home: HOME_DIR });
}
const journal = new JournalWriter({
  debounceMs: Number(process.env.TELEHARNESS_JOURNAL_DEBOUNCE_MS) > 0 ? Number(process.env.TELEHARNESS_JOURNAL_DEBOUNCE_MS) : 3000,
  log: (m) => console.error(m),
  resolve: async (sid) => {
    let rec = await sessionRecord(sid, true);
    if (!rec && !claude.has(sid)) { await fetchSessionIndex(true); rec = sessionIndex.recById.get(sid) ?? null; }
    const jdbg = process.env.TELEHARNESS_JOURNAL_DEBUG ? (m) => console.error(`[teleharness/journal] ${sid}: ${m}`) : () => {};
    if (rec?.parentID) return null; // дочерняя сессия субагента — её работа видна в журнале родителя
    const isClaude = claude.has(sid);
    const dir = (isClaude ? claude.dirOf(sid) : null) ?? (await resolveSessionDir(sid));
    if (dir == null) { jdbg(`нет папки чата (запись: ${rec ? "есть" : "нет"})`); return rec ? null : { retry: true }; }
    const zone = kbZoneOfDir(dir);
    if (!zone?.root) { jdbg(`нет зоны базы знаний для ${dir} (тенант: ${zone?.tenant ?? "—"})`); return null; }
    const marks = relays.get(sid);
    const messages = marks.length ? await wholeChatMessages(sid, dir) : isClaude ? await claude.mergedMessages(sid, dir ?? HOME_DIR, UPSTREAM) : await ocWholeMessages(sid, dir);
    return { zoneRoot: zone.root, title: rec?.title ?? "", dir, messages: messages ?? [], relays: marksForJournal(marks) };
  },
});
if (!MOCK) hub.onEvent((data) => journal.note(data));
// Агент открывает журнал чата (он лежит в базе знаний, вне папки чата) — движок спрашивает
// доступ к папке. На папку журналов зоны ЭТОГО чата портал отвечает сам, один раз на запрос.
if (!MOCK)
  hub.onEvent((data, evtDir) => {
    if (typeof data !== "string" || (!data.includes('"permission.asked"') && !data.includes('"question.asked"'))) return;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    const type = evt?.type;
    if (type !== "permission.asked" && type !== "question.asked") return;
    const p = evt.properties ?? null;
    const requestID = p?.id ?? p?.requestID;
    if (!p?.sessionID || typeof requestID !== "string") return;
    if (isRunnerEngine(p.teleharness?.engine)) return; // FEAT-18.4: the Claude bridge asks the person (FEAT-18.7: Codex too)
    // FEAT-19.31: фоновый OpenCode-шаг пайпа не должен зависать на интерактивном диалоге.
    if (temporalChatSteps?.owns(p.sessionID)) {
      (async () => {
        const meta = temporalChatSteps.meta?.(p.sessionID);
        const dir = meta?.directory ?? evtDir ?? (await resolveSessionDir(p.sessionID));
        if (type === "permission.asked") {
          const reply = meta?.admin === true ? "once" : "reject";
          await OC.replyPermission({ directory: dir, sessionID: p.sessionID, requestID, reply, timeoutMs: DEFAULT_OPTS.timeoutMs });
        } else {
          await OC.rejectQuestion({ directory: dir, requestID, formID: p.formID ?? requestID, message: "Автоматический шаг пайпа без интерактивного пользователя; действуй по инструкции самостоятельно.", timeoutMs: DEFAULT_OPTS.timeoutMs });
        }
      })().catch((err) => errLog("temporal.opencode.dialog", err));
      return;
    }
    if (type !== "permission.asked") return;
    (async () => {
      const dir = evtDir ?? (await resolveSessionDir(p.sessionID));
      if (!dir || !isJournalAccess(p, kbZoneOfDir(dir)?.root ?? null)) return;
      await OC.replyPermission({ directory: dir, sessionID: p.sessionID, requestID, reply: "once", timeoutMs: DEFAULT_OPTS.timeoutMs });
    })().catch((err) => errLog("journal.permission", err));
  });
// Чат удалён — его журнал в базе знаний уходит вместе с ним.
function dropJournal(id, dir) {
  try {
    const file = journal.fileOf(id, dir ? kbZoneOfDir(dir)?.root ?? null : null);
    journal.forget(id);
    relays.forget(id);
    if (file) unlinkSync(file);
  } catch (err) {
    if (err?.code !== "ENOENT") errLog("journal.drop", err);
  }
}
// Правила портала для хода: показ файлов + (когда журнал уже есть) где лежит журнал чата.
function portalRulesFor(sid, dir) {
  let file = null;
  try {
    file = journal.fileOf(sid, kbZoneOfDir(dir)?.root ?? null);
  } catch {}
  return [PORTAL_FILE_RULE, file ? journalRule(file) : "", relayRule(relays.get(sid), file), worktreeNote(sid)].filter(Boolean).join("\n\n"); // FEAT-20.7
}

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
if (config.TELEHARNESS_PUSH) {
  const pushDir = path.join(DATA_DIR, "push");
  const vapid = loadOrCreateVapid(pushDir);
  if (vapid) {
    const store = new PushStore({ file: path.join(pushDir, "subscriptions.json"), maxPerUser: config.TELEHARNESS_PUSH_MAX_PER_USER, log: (m) => console.error(m) });
    const notifier = new PushNotifier({
      store,
      vapid,
      keyObject: vapidKeyObject(vapid),
      subject: config.TELEHARNESS_PUSH_SUBJECT,
      recipients: pushRecipients,
      chatInfo: pushChatInfo,
      isManaged: (sid) => isRunnerEngine(engineOfChat(sid)) || Boolean(temporalChatSteps?.owns(sid)),
      prefsOf: (userId) => attention.user(userId)?.push ?? null, // FEAT-20.2: виды и тихие часы
      activeAt: (userId) => attention.user(userId)?.lastActiveAt ?? null, // FEAT-20.2: смотрит портал на любом устройстве
      debounceMs: config.TELEHARNESS_PUSH_DEBOUNCE_MS,
      summaryWindowMs: config.TELEHARNESS_PUSH_SUMMARY_MS, // FEAT-20.2
      log: (m) => console.log(m),
    });
    webPush = { store, notifier, vapid, extraOrigins: config.TELEHARNESS_PUSH_EXTRA_ORIGINS };
    if (!MOCK) hub.onEvent((data, dir) => notifier.observe(data, dir));
  }
}
// GitHub integration: encrypted PAT storage, watchdog, triggers, dispatcher, webhook & poller.
const github = (() => {
  const key = loadKey(DATA_DIR);
  const box = { encrypt: (t) => encryptSecret(key, t), decrypt: (b) => decryptSecret(key, b), last4, redact };
  const connections = connectionService(path.join(DATA_DIR, "github-triggers.sqlite"));
  const check = (token) => checkConnection(token, config.TELEHARNESS_GITHUB_API ? { apiBase: config.TELEHARNESS_GITHUB_API } : {});
  const notify = (userId, kind, info) => {
    const text = kind === "expired"
      ? { title: `GitHub token expired (${info.login})`, body: "Background agents cannot start — reconnect in Settings → GitHub" }
      : { title: `GitHub token expires in ${info.days}d (${info.login})`, body: "Refresh your connection in Settings → GitHub" };
    const payload = { ...text, url: "/teleharness/#/settings/github", tag: "teleharness-github-token", kind: "error" };
    return webPush?.notifier ? webPush.notifier.deliver(userId, "error", payload).catch(() => 0) : Promise.resolve(0);
  };
  const watchdog = createTokenWatchdog({ connections, check, secrets: box, notify, log: (m) => console.log(m) });
  watchdog.start();
  const gstore = triggerService(path.join(DATA_DIR, "github-triggers.sqlite"), { secrets: box });
  const latestPublished = async (owner, definitionId) => {
    try {
      const versions = temporalDeps.store.get(owner, definitionId)?.versions ?? [];
      return versions.length ? Math.max(...versions.map((v) => v.version)) : null;
    } catch { return null; }
  };
  // BUG-312: does the pipe version behind a trigger use Claude in a model step?
  // Used by the daily background Claude limit (only Claude pipes are counted).
  const pipeUsesClaude = (owner, definitionId, version = null) => {
    try {
      const rec = temporalDeps.store.get(owner, definitionId, { deleted: true });
      const ver = version != null
        ? rec?.versions?.find((v) => v.version === version)?.definition
        : rec?.versions?.at(-1)?.definition ?? rec?.draft;
      return Array.isArray(ver?.steps) && ver.steps.some((s) => s?.type === "model" && (s.engine ?? "claude") === "claude");
    } catch {
      return true;
    }
  };
  const triggerUsesClaude = (trigger) => pipeUsesClaude(trigger.owner, trigger.definitionId, trigger.version ?? null);
  const frame = (s) => frameAgentText(s, 20_000);
  const launch = async (trigger, ev, requestId, extra = {}) => {
    if (!temporalDeps.startPipeline) throw new Error("Temporal-пайпы не подключены");
    const version = trigger.version ?? (await latestPublished(trigger.owner, trigger.definitionId));
    if (!version) throw new Error("У пайпа нет опубликованной версии");
    const record = temporalDeps.store.get(trigger.owner, trigger.definitionId);
    const versionDef = record?.versions?.find((v) => v.version === version)?.definition ?? null;
    // Human text always rides inside the "data, not instructions" frame (BUG-323 p.3: title included).
    const framed = { ...ev, title: frame(ev.title), body: frame(ev.body), comment: ev.kind === "comment_command" ? frame(ev.body) : "" };
    const inputs = cleanInputs(framed, Array.isArray(versionDef?.inputs) ? versionDef.inputs : []);
    const face = eventFace(ev);
    const eventRef = face.ref;
    return temporalDeps.startPipeline({ owner: trigger.owner, definitionId: trigger.definitionId, version, requestId, inputs, source: "github", triggerId: trigger.id, eventRef, eventUrl: face.url, attempt: extra?.attempt ?? null });
  };
  const permissions = createPermissionCache({ apiBase: config.TELEHARNESS_GITHUB_API || undefined, log: (m) => console.log(m) });
  const githubPermissionCheck = async (login, repo, trigger) => {
    const token = connections.get(trigger.owner);
    return permissions.has(login, repo, token?.tokenEnc ? box.decrypt(token.tokenEnc) : null);
  };
  const dispatcher = createDispatcher({
    store: gstore, connections, launch, usesClaude: triggerUsesClaude, log: (m) => console.log(m),
    describeRun: (id) => temporalDeps.describeRun(id),
    ciLogFetch: async (userId, repo, runId) => {
      const c = connections.get(userId);
      if (!c?.tokenEnc) throw new Error("Нет подключения GitHub");
      return fetchCiLog({
        ghText: (_uid, pathname) => ghText(box.decrypt(c.tokenEnc), pathname, { apiBase: config.TELEHARNESS_GITHUB_API || undefined }),
        userId,
      }, repo, runId);
    },
    permissionCheck: githubPermissionCheck,
  });
  const githubHook = createGithubHookHandler({ store: gstore, dispatcher, sendJson, log: (m) => console.log(m) });
  setImmediate(() => { dispatcher.resume().then((n) => { if (n) console.log(`github: доиграно доставок после рестарта: ${n}`); }).catch(() => {}); });
  setInterval(() => { try { gstore.gc(); } catch (e) { console.error(`github gc: ${e?.message ?? e}`); } }, 3600_000).unref?.();
  const poller = createGithubPoller({
    store: gstore, dispatcher,
    connectionToken: (owner) => {
      const c = connections.get(owner);
      return c?.tokenEnc ? box.decrypt(c.tokenEnc) : null;
    },
    apiBase: config.TELEHARNESS_GITHUB_API || undefined,
    log: (m) => console.log(m),
  });
  poller.start();
  setImmediate(() => { dispatcher.sweep().catch((e) => console.error(`github sweep: ${e?.message ?? e}`)); });
  setInterval(() => { dispatcher.sweep().catch((e) => console.error(`github sweep: ${e?.message ?? e}`)); }, 60_000).unref?.();
  const cancelRun = async (trigger, workflowId) => {
    const described = await temporalDeps.describeRun(workflowId);
    await temporalDeps.applyAction(trigger.owner, workflowId, { action: "cancel", runId: described.runId, actionId: randomUUID() });
    return true;
  };
  return { connections, check, box, store: gstore, dispatcher, launch, cancelRun, hook: githubHook, poller, usesClaude: triggerUsesClaude, pipeUsesClaude, permissionCheck: githubPermissionCheck };
})();
// FEAT-20.2: исходы opencode-чатов (busy → idle/error) и «ждёт вас» для сводки.
const attentionObserver = new OutcomeObserver({
  isManaged: (sid) => isRunnerEngine(engineOfChat(sid)),
  onTurnStart: (sid, dir) => reviewTurnStart(sid, dir), // FEAT-20.1
  onTurnEnd: (sid, rec, dir) => {
    if (temporalChatSteps?.owns(sid)) {
      temporalChatSteps.onTurnEnd({
        sid,
        error: rec?.error ?? (rec?.kind === "done" || rec?.kind === "stopped" ? null : rec?.kind),
        reason: rec?.kind === "stopped" ? "user" : rec?.kind === "stalled" ? "stalled" : null,
      });
      return;
    }
    reviewTurnEnd(sid, dir, { interrupted: rec?.kind !== "done" }); // FEAT-20.1
  },
  onOutcome: (sid, rec, dir) => {
    if (temporalChatSteps?.owns(sid) || sessionIndex.recById.get(sid)?.parentID) return; // шаг пайпа / исход субагента — не исход чата
    attentionOutcome(sid, rec, dir);
  },
  onAsk: (sid, dir) => {
    if (temporalChatSteps?.owns(sid)) return;
    void (async () => {
      const d = claude.dirOf(sid) ?? (await resolveSessionDir(sid).catch(() => null)) ?? dir;
      const users = pushRecipients(d);
      const rec = sessionIndex.recById.get(sid);
      const root = rec?.parentID ?? sid;
      const title = claude.titleInfo(root)?.title || sessionIndex.recById.get(root)?.title || "чат";
      attention.addEvent(users, { kind: "needs", key: `chat:${root}`, text: `Ждёт вас: «${title}»` });
      attentionPing(users, "needs");
    })().catch((err) => errLog("attention.ask", err));
  },
});
hub.onEvent((data, dir) => attentionObserver.observe(data, dir));

// ---- FEAT-20.6: журнал расхода по ценам API (<data>/usage-ledger.sqlite) -----------------
// Запись — готовый ответ любого движка (`message.updated` с time.completed) через поток хаба;
// служебные вызовы — routes/git.js recordService; шаги пайпов — registerStep (chat-step.js).
// Сбой журнала не трогает ход: ошибка видна admin в «Расходах», пропущенное добирает учёт истории.
const costLedger = new CostLedger({ file: process.env.TELEHARNESS_COST_LEDGER || path.join(DATA_DIR, "usage-ledger.sqlite"), log: (m) => console.error(m) });
const costUserName = (id) => {
  try {
    const u = getUser(id);
    return u ? u.name ?? id : null;
  } catch {
    return null;
  }
};
const costReports = new CostReports({
  ledger: costLedger,
  chatExists: (sid) => (claude.has(sid) || sessionIndex.recById.has(sid) ? true : sessionIndex.at ? false : null),
  userName: costUserName,
});
const costRecorder = new CostRecorder({
  ledger: costLedger,
  deps: {
    dirOf: (sid) => claude.dirOf(sid) ?? sessionIndex.byId.get(sid) ?? null,
    resolveDir: MOCK ? null : (sid) => resolveSessionDir(sid),
    // opencode v2: модель шага, если session.step.started пропущен (рестарт посреди хода) — привязка чата
    modelOf: (sid) => {
      const m = bindings.get(sid)?.model;
      return m?.modelID ? { providerID: m.providerID ?? null, modelID: m.modelID } : null;
    },
    parentOf: (sid) => sessionIndex.recById.get(sid)?.parentID ?? null,
    titleOf: (sid) => chatTitleOf(sid),
    ownerOf: (_sid, dir) => {
      const u = chatOwner(dir);
      return u ? { id: u.id, name: u.name ?? u.id } : null;
    },
    log: (m) => console.error(m),
    onRecorded: ({ row, alerts }) => costRecorded(row, alerts),
  },
});
function costRecorded(row, alerts) {
  if (!row?.user_id) return;
  const evt = JSON.stringify({ type: "teleharness.cost.updated", properties: { sessionID: row.parent_sid ?? row.sid ?? null, runId: row.run_id ?? null } });
  hub.broadcastToUser(row.user_id, evt);
  for (const a of alerts ?? []) {
    // бюджет 80/100 %: пользователю — событие (баннер в «Расходах» и чате), admin — push (кр. 12)
    hub.broadcastToUser(row.user_id, JSON.stringify({ type: "teleharness.cost.budget", properties: a }));
    const name = costUserName(row.user_id) ?? row.user_name ?? row.user_id;
    const payload = { title: `Бюджет ${name}: ${a.pct} %`, body: `Израсходовано ${a.pct} % месячного бюджета по ценам API. Ходы не ограничиваются.`, kind: "budget", url: "/teleharness/#/settings/costs", tag: `teleharness-budget-${row.user_id}-${a.month}-${a.threshold}` };
    for (const admin of listUsers().filter((u) => u.role === "admin" && !u.disabled)) void webPush?.notifier.sendToUser(admin.id, payload, { urgency: "normal", ttl: 24 * 3600 }).catch(() => {});
  }
}
hub.onEvent((data, dir) => costRecorder.observe(data, dir));
const costBackfill = new CostBackfill({
  ledger: costLedger,
  recorder: costRecorder,
  deps: {
    claudeSessions: () => claude.storeSnapshot?.() ?? null,
    ...(MOCK ? {} : {
      ocSessions: async () => {
        await fetchSessionIndex();
        return [...sessionIndex.recById.values()].filter((r) => r?.id && !claude.has(r.id)).map((r) => ({ id: r.id, directory: r.directory ?? sessionIndex.byId.get(r.id) ?? null, parentID: r.parentID ?? null }));
      },
      ocMessages: (sid, dir) => ocWholeMessages(sid, dir),
    }),
    log: (m) => console.error(m),
  },
});
// Учёт истории — после старта, не в момент запуска (кр. 15); журнал ожил после сбоя — добор (кр. 16).
if (!process.env.TELEHARNESS_COST_NO_BACKFILL) setTimeout(() => void costBackfill.start(), Number(process.env.TELEHARNESS_COST_BACKFILL_DELAY_MS) || 15_000).unref?.();
setInterval(() => {
  if (costLedger.missed > 0 && costLedger.db && !costLedger.error) {
    costLedger.missed = 0;
    void costBackfill.start({ force: true });
  }
}, 60_000).unref?.();

// FEAT-01.60: полнотекстовый индекс сообщений чатов (opencode + Claude/Codex/ACP).
const chatSearch = new ChatSearchIndex({
  dbPath: MOCK ? ":memory:" : path.join(DATA_DIR, "chat-search.sqlite"),
  log: (m) => console.error(m),
  deps: {
    claudeSessions: () => claude.storeSnapshot?.() ?? null,
    ...(MOCK ? {} : {
      ocSessions: async () => {
        await fetchSessionIndex();
        return [...sessionIndex.recById.values()].filter((r) => r?.id).map((r) => ({ id: r.id, directory: r.directory ?? sessionIndex.byId.get(r.id) ?? null, time: r.time }));
      },
      ocMessages: (sid, dir) => ocWholeMessages(sid, dir),
    }),
  },
});
if (!MOCK) {
  hub.onEvent((data) => {
    if (typeof data !== "string" || (!data.includes('"session.idle"') && !data.includes('"session.updated"'))) return;
    try {
      const evt = JSON.parse(data);
      const p = evt?.payload ?? evt;
      const sid = p?.properties?.sessionID ?? p?.properties?.info?.id ?? p?.sessionID ?? null;
      if (typeof sid === "string" && sid) chatSearch.markDirty(sid);
    } catch {}
  });
  if (!process.env.TELEHARNESS_SEARCH_NO_BG) {
    setTimeout(() => void chatSearch.start(), Number(process.env.TELEHARNESS_SEARCH_INDEX_DELAY_MS) || 10_000).unref?.();
  }
}

// ---- FEAT-20.1: ревью изменений и «Сначала план» -----------------------------------
// Пункт ревью на чат (lib/review.js): конец хода с правками → ревизия; база —
// снимок перед ходом. Владельцы — как у доски (pushRecipients). Событие
// teleharness.review.updated — только владельцу; доска перечитывается по teleharness.attention.
const reviews = new ReviewService({
  store: new ReviewStore({ dir: path.join(DATA_DIR, "review"), log: (m) => console.error(m) }),
  objectsRoot: path.join(DATA_DIR, "review-objects"),
  tmpDir: path.join(DATA_DIR, "tmp", "review"),
  busy: (sid) => Boolean(sid && (claude.busySnapshot()[sid] || hub.busySnapshot()[sid])),
  post: ({ user, sid, dir, text }) => {
    const u = getUser(user);
    if (!u || u.disabled) return { ok: false, status: 403, error: "user disabled" };
    return internalPrompt({ sid, dir, user: u, text, autoRelay: false });
  },
  emit: (users, props) => {
    const evt = JSON.stringify({ type: props?.plan ? "teleharness.plan.updated" : "teleharness.review.updated", properties: props });
    for (const u of new Set(users ?? [])) hub.broadcastToUser(u, evt);
    attentionPing(users, "review");
  },
  log: (m) => console.error(m),
  // BUG-273: проект карточки ревью — проект чата (как у чата на доске), а не папка
  // рабочей копии / подпапка чата тенанта; копия без чата — её основной репозиторий
  // BUG-277: название — текущее название чата (автозаголовок приходит после первого хода)
  titleOf: (it) => {
    const sid = it?.source?.sid;
    if (!sid) return null;
    const rec = sessionIndex.recById.get(sid);
    return claude.titleInfo(sid)?.title || (rec ? titler.overlay([rec])[0]?.title : null) || rec?.title || null;
  },
  projectDirOf: (it) => {
    const sid = it?.source?.sid;
    if (sid) return reviewChatDir(sid);
    const wt = it?.source?.kind === "branch" && it.source.wtId ? worktrees.store.byId(it.source.wtId) : null;
    return wt?.repoRoot ?? null;
  },
});
// ---- FEAT-20.7: рабочие копии (git worktree) ------------------------------------
// Копия на чат/запуск (lib/worktrees.js): создаётся при первом сообщении, ход
// идёт в ней; пересечения, слияние с тестами, удаление без потери работы.
// Событие teleharness.worktree.updated — владельцу копии (и admin); лист перечитывается.
const worktrees = new Worktrees({
  store: new WorktreeStore({ dir: path.join(DATA_DIR, "worktrees"), log: (m) => console.error(m) }),
  dataDir: path.join(DATA_DIR, "worktrees"),
  log: (m) => console.error(m),
  busy: (sid) => Boolean(sid && (claude.busySnapshot()[sid] || hub.busySnapshot()[sid])),
  author: (uid) => {
    const g = getGitSettings(uid);
    return { name: g.authorName, email: g.authorEmail };
  },
  tenantJail: (dir) => tenantJailFor(dir, config.TELEHARNESS_TENANT_HOME),
  jailLine: linuxJailLine,
  emit: (item, what) => {
    const evt = JSON.stringify({ type: "teleharness.worktree.updated", properties: { id: item.id, sid: item.sid ?? null, runId: item.runId ?? null, what, state: item.state } });
    const to = new Set([item.owner, ...listUsers().filter((u) => u.role === "admin").map((u) => u.id)]);
    for (const u of to) hub.broadcastToUser(u, evt);
    if (["merged", "op"].includes(what)) attentionPing([item.owner], "worktree");
  },
});
// Папка хода чата с копией (null — копии нет).
const worktreeDirOf = (sid) => worktrees.workDirOf(sid);
const worktreeNote = (sid) => {
  const it = worktrees.forChat(sid);
  return it ? worktreeRule({ branch: it.branch, base: it.base, port: it.port, path: it.tenant ? null : it.path }) : "";
};
const chatTitleOf = (sid) => claude.titleInfo(sid)?.title || sessionIndex.recById.get(sid)?.title || null;
const tenantTestsOk = () => process.platform === "linux" && Boolean(config.TELEHARNESS_TENANT_HOME);
const planTurns = new Map(); // sid → {user, engine, model, at} — идёт план-ход
const planCaptured = new Map(); // sid → текст плана из ExitPlanMode (Claude)
const ocPlanRulesOn = new Set(); // opencode-чаты, где на сессии стоят правила план-хода
const tenantRoots = () => [config.TELEHARNESS_TENANT_HOME, ...listUsers().filter((u) => u.role !== "admin").flatMap((u) => u.directories ?? [])].filter(Boolean);
const reviewUntrusted = (admin, dir) => !admin || (dir ? isUnderAny(dir, tenantRoots()) : true);
// Папка, где агент правит: у чата тенанта — своя подпапка (FEAT-04.12), если есть.
function reviewWorkDir(sid, dir) {
  if (!dir) return null;
  const wtDir = worktreeDirOf(sid); // FEAT-20.7: чат в рабочей копии
  if (wtDir) return wtDir;
  return (isUnderAny(dir, tenantRoots()) ? existingChatFolder(dir, sid) : null) ?? dir;
}
function reviewChatDir(sid, hint = null) {
  return claude.dirOf(sid) ?? sessionIndex.byId.get(sid) ?? hint ?? null;
}
function reviewTurnStart(sid, hint = null) {
  if (!sid || temporalChatSteps?.owns(sid) || sessionIndex.recById.get(sid)?.parentID) return;
  const dir = reviewChatDir(sid, hint);
  if (!dir || isTempSessionDir(dir)) return;
  const work = reviewWorkDir(sid, dir);
  const wtItem = worktrees.forChat(sid); // FEAT-20.7: HEAD до хода — предупреждение «Коммит останется в ветке»
  if (wtItem) worktrees.headOf(wtItem).then((h) => worktrees.noteTurnStart(sid, h)).catch(() => {});
  reviews.turnStart({ users: pushRecipients(dir), sid, dir: work, untrusted: isUnderAny(work, tenantRoots()) }).catch((err) => errLog("review.turnStart", err));
}
// Части последнего хода (после последнего сообщения пользователя) — режим «по ходам».
async function reviewTurnParts(sid, dir) {
  let list = null;
  try {
    list = isRunnerEngine(engineOfChat(sid)) ? claude.messages(sid) : await ocWholeMessages(sid, dir);
  } catch {}
  if (!Array.isArray(list)) return { parts: [], turnId: null };
  let i = list.length - 1;
  while (i >= 0 && list[i]?.info?.role !== "user") i--;
  const turn = list.slice(i + 1);
  return { parts: turn.flatMap((m) => m?.parts ?? []), turnId: turn.at(-1)?.info?.id ?? list[i]?.info?.id ?? null, answer: turn.filter((m) => m?.info?.role === "assistant").flatMap((m) => (m.parts ?? []).filter((p) => p?.type === "text" && !p.synthetic).map((p) => p.text ?? "")).join("\n").trim() };
}
function reviewTurnEnd(sid, hint, { interrupted = false } = {}) {
  void (async () => {
    if (!sid || temporalChatSteps?.owns(sid) || sessionIndex.recById.get(sid)?.parentID) return;
    const dir = reviewChatDir(sid, hint);
    const plan = planTurns.get(sid) ?? null;
    planTurns.delete(sid);
    if (!dir || isTempSessionDir(dir)) return;
    const work = reviewWorkDir(sid, dir);
    // FEAT-20.7: конец хода — пересчёт пересечений копий репозитория (кр. 7)
    if (worktrees.forChat(sid)) worktrees.touchRepoOf(sid, { titleOf: chatTitleOf }).catch((err) => errLog("worktree.touch", err));
    else worktrees.touchDir(work).catch(() => {});
    const users = pushRecipients(dir);
    const { parts, turnId, answer } = await reviewTurnParts(sid, dir);
    const b = bindingFor(sid, sessionIndex.recById.get(sid) ?? null);
    const title = claude.titleInfo(sid)?.title || sessionIndex.recById.get(sid)?.title || null;
    const out = await reviews.turnEnd({ users, sid, dir: work, untrusted: isUnderAny(work, tenantRoots()), turnId, parts, ended: interrupted ? "interrupted" : "done", planTurn: Boolean(plan), meta: { title, engine: b?.engine ?? engineOfChat(sid), model: b?.model?.modelID ?? null } });
    if (plan) {
      const text = planCaptured.get(sid) ?? (interrupted ? "" : answer);
      const violations = out.flatMap((x) => (x.planViolation ?? []).map((f) => f.path));
      const source = planCaptured.has(sid) ? "tool" : "answer";
      for (const user of users) reviews.createPlan(user, { sid, turnId, engine: plan.engine, model: plan.model, text, source, violations: [...new Set(violations)] });
      planCaptured.delete(sid);
    }
  })().catch((err) => errLog("review.turnEnd", err));
}
// План-ход: «Сначала план» включён и это не ход выполнения одобренного плана.
function notePlanTurn(sid, binding, user, req) {
  if (!binding?.planFirst || req?.teleharnessPlanExec) {
    planTurns.delete(sid);
    return false;
  }
  if (binding.engine === "opencode" && !isAdmin(user)) return false; // тенант: режим недоступен (409 при включении)
  planTurns.set(sid, { user: user.id, engine: binding.engine, model: binding.model?.modelID ?? null, at: Date.now() });
  planCaptured.delete(sid);
  return true;
}
async function planBlockedReason(binding, admin) {
  if (binding.engine === "opencode" && OC.api !== "v2") return "«Сначала план» доступен на opencode 2.x";
  let tenantPlanAgent = false;
  if (!admin && binding.engine === "opencode") tenantPlanAgent = false; // спайк 1.4: агента plan среди агентов тенанта нет
  return planUnsupported({ engine: binding.engine, admin, tenantPlanAgent });
}
// Решение по плану → ход выполнения / новый план-ход тем же путём, что сообщение пользователя.
async function planRun({ user, action, plan, text, edited, comment }) {
  const dir = reviewChatDir(plan.sid);
  if (!dir) return { ok: false, status: 404, error: "чат удалён" };
  if (action === "approve") {
    const b = bindingFor(plan.sid, sessionIndex.recById.get(plan.sid) ?? null);
    const r = await internalPrompt({ sid: plan.sid, dir, user, text: planExecText(text, { edited }), autoRelay: false, flags: { teleharnessPlanExec: true } });
    return { ...r, engine: b?.engine ?? null, model: b?.model?.modelID ?? null };
  }
  return internalPrompt({ sid: plan.sid, dir, user, text: planReviseText(comment), autoRelay: false });
}

// Deletes a session upstream (directory-pinned) and every local trace of it
// (claude history/run, binding, title mark). A 404 upstream counts as gone.
async function deleteSessionEverywhere(id, dir) {
  let ok = false;
  try {
    await OC.deleteSession(id, { directory: dir ?? undefined, timeoutMs: DEFAULT_OPTS.timeoutMs }); // v2: DELETE /api/session/:id (204)
    ok = true;
  } catch (err) {
    if ((err?.status ?? 0) === 404) ok = true; // уже нет upstream — считаем удалённым, как раньше
    else errLog("session.deleteEverywhere", err);
  }
  if (ok) {
    claude.forget(id);
    bindings.forget(id);
    titler.forget(id);
    dropJournal(id, dir); // FEAT-11.18
    dropPinEverywhere(id); // FEAT-01.69: no «ghost» pins of a deleted chat
    attention.forgetKey(`chat:${id}`, { sid: id }); // FEAT-20.2: отметки и исход удалённого чата
    reviews.chatDeleted(id); // FEAT-20.1: пункт «Чат удалён»
    chatSearch?.forget(id); // FEAT-01.60
    autoRelay.forget(id); // FEAT-18.6
    worktrees.cancelPending(id); // FEAT-20.7: пустой чат — заявка на копию уходит с ним
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
    await OC.disposeInstance({ directory: dir, timeoutMs: 10_000 }); // v1 POST /instance/dispose; v2 DELETE /api/debug/location
    return true;
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
  const root = normDir(config.TELEHARNESS_TENANT_HOME);
  return Boolean(n && root && pathInside(n, root)); // BUG-17.14: по платформе
};
// BUG-089: tenant-home subfolders no account owns (same rule for GET and POST).
function ownerlessTenantDirs(sessions) {
  return findOwnerlessTenantDirs({
    home: config.TELEHARNESS_TENANT_HOME,
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
    const cfg = await OC.configGet({ timeoutMs: 10_000 }); // v2: слои /api/config + /api/model/default (Э1, Э3)
    const name = cfg?.default_agent ?? null;
    if (typeof name === "string" && name) defaultAgentCache = { at: Date.now(), name };
  } catch (err) {
    errLog("defaultAgent.config", err);
  }
  return defaultAgentCache.name;
}

// v2fix2 (лейн A, FEAT-16.3): источник каталога моделей в v2-режиме для
// claude.handleProvider ({catalog}). opencode 2.x не имеет v1-пути /provider,
// поэтому upstream-часть даёт клиент адаптера: OC.listProviders() собирает
// форму 1.x {all, default, connected} и сам доклеивает модели из /api/model
// в элементы all (см. lib/oc-client.js — Provider.Info v2 моделей не несёт).
// Ошибка источника — исключение: handleProvider отдаст 502/устаревший кэш
// как в v1. В v1-режиме источник null — handleProvider читает
// ${upstream}/provider как раньше, бит в бит.
const providerCatalog = OC.api === "v2" ? () => OC.listProviders({ timeoutMs: 10_000 }) : null;

// BUG-11.13 / BUG-082: model for a prompt without one in an unbound chat.
let defaultModelCache = { at: 0, model: null };
async function defaultModel() {
  if (defaultModelCache.model && Date.now() - defaultModelCache.at < 60_000) return defaultModelCache.model;
  let configModel = null;
  let catalog = null;
  if (config.TELEHARNESS_DEFAULT_MODEL) {
    const m = parseModelRef(config.TELEHARNESS_DEFAULT_MODEL);
    if (m) return m;
  }
  try {
    const cfg = await OC.configGet({ timeoutMs: 10_000 });
    configModel = cfg?.model ?? null; // v2: {providerID, id[, variant]} — cleanModel понимает `id`
  } catch (err) {
    errLog("defaultModel.config", err);
  }
  const captured = await captureResponse((shim) => claude.handleProvider({ headers: {} }, shim, UPSTREAM, { catalog: providerCatalog }));
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
  if (isRunnerEngine(binding?.engine)) return true;
  const model = binding?.model ?? cleanModel(parsed?.model);
  if (!model || isRunnerEngine(engineOf(model.providerID))) return true;
  const captured = await captureResponse((shim) => claude.handleProvider({ headers: {} }, shim, UPSTREAM, { catalog: providerCatalog }));
  if (captured.status !== 200) return true;
  try {
    return modelAcceptsImages(JSON.parse(captured.body), model) !== false;
  } catch {
    return true;
  }
}

// BUG-163: a tenant has no vision subagent (Sandbox: task deny), so a turn
// with pictures on a text-only opencode model goes to a same-provider model
// that sees them (TELEHARNESS_TENANT_VISION_MODEL first, only from the tenant's own
// catalog). The chat binding is not touched. Admin → null (look_at, BUG-140).
async function tenantVisionModel(user, binding, parsed) {
  if (isAdmin(user) || isRunnerEngine(binding?.engine)) return null;
  const parts = Array.isArray(parsed?.parts) ? parsed.parts : [];
  if (!parts.some((x) => x?.type === "file" && String(x.mime ?? "").startsWith("image/"))) return null;
  const model = binding?.model ?? cleanModel(parsed?.model);
  if (!model || isRunnerEngine(engineOf(model.providerID))) return null;
  const captured = await captureResponse((shim) => claude.handleProvider({ headers: {} }, shim, UPSTREAM, { catalog: providerCatalog }));
  if (captured.status !== 200) return null;
  try {
    const catalog = JSON.parse(captured.body);
    const claudeAllowed = engineAllowed(user, "claude");
    const codexAllowed = engineAllowed(user, "codex");
    return visionSibling(catalog, model, {
      preferred: config.TELEHARNESS_TENANT_VISION_MODEL,
      allowed: (m) => modelInCatalog(catalog, m, { claudeAllowed, codexAllowed, paidOpencodeAllowed: isAdmin(user) }) !== false,
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
  const catalog = await providerCatalogJson(user);
  if (!catalog) return null;
  return modelInCatalog(catalog, model, { claudeAllowed: engineAllowed(user, "claude"), codexAllowed: engineAllowed(user, "codex"), acpAllowed: engineAllowed(user, "acp") }) === false
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
  if (stableTurnIds(s)) out.stableTurnIds=true;
  else delete out.stableTurnIds;
  if (rv) out.revert = rv;
  else delete out.revert;
  if (b) out.teleharness = relays.has(s.id) ? { ...b, relays: relays.get(s.id) } : b;
  return out;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// A message list answered whole (pp == null) or as one page with the
// x-teleharness-has-more / x-teleharness-next-before headers (BUG-08.8, lib/proxy.js).
function sendPaged(res, list, pp) {
  if (!pp) return sendJson(res, 200, list);
  const r = paginateMessages(list, pp);
  if (r.error) return sendJson(res, r.error === "unknown before cursor" ? 400 : 502, { error: r.error });
  res.setHeader("x-teleharness-has-more", r.hasMore ? "1" : "0");
  if (r.nextBefore) res.setHeader("x-teleharness-next-before", r.nextBefore);
  return sendJson(res, 200, r.page);
}

function withQuery(pathname, search) {
  return search ? pathname + search : pathname;
}

// All session-scoped upstream calls carry an explicit ?directory= — after a
// watchdog restart opencode serve runs with cwd=system32.
const HOME_DIR = config.TELEHARNESS_HOME;
// BUG-02.5: the directory of a chat created without a project. Explicit and
// configurable (TELEHARNESS_CHAT_DIR, default = HOME as before); never the service
// cwd. Tenants always land in their own first folder (defaultDir).
const CHAT_DIR = config.TELEHARNESS_CHAT_DIR;
// BUG-02.5 / BUG-057 decision: a chat without a project lives in TELEHARNESS_CHAT_DIR
// (default HOME). Neither it nor HOME may ever be the system tree (the
// service cwd C:\Windows\System32 is where those chats used to land): such a
// configuration is a startup error, not a silent fallback.
for (const [name, dir] of [["TELEHARNESS_HOME", HOME_DIR], ["TELEHARNESS_CHAT_DIR", CHAT_DIR]]) {
  const problem = dirProblem(dir);
  if (problem) {
    console.error(`[teleharness-config] ${name}=${dir} недопустим как каталог чатов: ${dirProblemText(problem)} (${problem})`);
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
  const limit = config.TELEHARNESS_TENANT_RATE_PER_MIN;
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

// POST /teleharness/api/upload?name=filename — raw binary body streamed to
// <dir>/.teleharness-uploads/<unique name>; dir arrives scope-resolved from handleApi.
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
  // BUG-218 (SRV-05, design §2): the file is created EXCLUSIVELY (flag "wx")
  // — the old pick-by-existsSync then open pair raced parallel uploads of the
  // same name onto one path and clobbered each other.
  let stored, target, ws;
  try {
    const opened = openUnique(dirAbs, sanitizeFilename(url.searchParams.get("name")));
    stored = opened.name;
    target = opened.path;
    ws = createWriteStream(target, { fd: opened.fd });
  } catch {
    req.resume();
    return sendJson(res, 500, { error: "disk write error" });
  }
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
// BUG-201: tenant reject-only permissions — tenantMustReject (lib/policy.js, v1 permission / v2 action)

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
const chatRouting=chatRoutingForPortal({directory:DATA_DIR,stage:process.env.TELEHARNESS_ENV==="stand",
  enabled:process.env.TELEHARNESS_TEMPORAL_NEW_CHATS==="1",service:process.env.TELEHARNESS_TEMPORAL_CHAT_PGSERVICE});
const acpLogins = {
  "antigravity":new AgyLoginSessions((owner,extraEnv)=>launchAgyLogin(DATA_DIR,owner,extraEnv),(owner,status)=>markAcpProfile(DATA_DIR,owner,"antigravity",status),owner=>acpProfileReady(DATA_DIR,owner,"antigravity")),
  gemini:new GeminiLoginSessions(owner=>launchGeminiLogin(DATA_DIR,owner),(owner,status)=>markAcpProfile(DATA_DIR,owner,"gemini",status)),
  "github-copilot-cli":new CopilotLoginSessions(owner=>launchCopilotLogin(DATA_DIR,owner),(owner,status)=>markAcpProfile(DATA_DIR,owner,"github-copilot-cli",status),owner=>acpProfileReady(DATA_DIR,owner,"github-copilot-cli"))
};
const ACP_PUBLIC_IDS = ["antigravity","github-copilot-cli"];
const acpAuthOwner = user => (isAdmin(user) ? user.id : adminUser()?.id ?? null);
const acpReady = user => {
  const owner = acpAuthOwner(user);
  return owner && engineAllowed(user,"acp") ? ACP_PUBLIC_IDS.filter(id=>acpLogins[id].get(owner).status==="ready" || acpProfileReady(DATA_DIR,owner,id)) : [];
};
const acpTemporalCatalog = () => {
  if (process.env.TELEHARNESS_ACP === "off") return [];
  const owner = adminUser()?.id ?? null;
  if (!owner) return [];
  const readyIds = ACP_PUBLIC_IDS.filter(id => acpLogins[id].get(owner).status === "ready" || acpProfileReady(DATA_DIR, owner, id));
  const out = [];
  const seen = new Set();
  for (const id of readyIds) {
    const providerID = "acp-" + id;
    const cat = cachedAcpModels(DATA_DIR, owner, id);
    const list = cat?.availableModels ?? [];
    for (const m of list) {
      if (!m?.modelId || seen.has(m.modelId)) continue;
      seen.add(m.modelId);
      out.push({ id: m.modelId, name: m.name || m.modelId, providerID });
    }
    if (!list.length && !seen.has(providerID)) {
      seen.add(providerID);
      out.push({ id: providerID, name: id === "antigravity" ? "Google Antigravity" : id, providerID });
    }
  }
  return out;
};
// FEAT-19.31: каталог моделей OpenCode (zai-coding-plan: GLM-5.3-Flash / GLM-5.3 и др.) для Temporal пайпов.
const OPENCODE_FALLBACK_MODELS = [
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", providerID: "zai-coding-plan" },
  { id: "glm-5.3", name: "GLM-5.3", providerID: "zai-coding-plan" },
];
let opencodeCatalogCache = { at: 0, list: [] };
let opencodeCatalogBusy = null;
async function refreshOpencodeCatalog() {
  if (MOCK) return opencodeCatalogCache.list;
  if (opencodeCatalogBusy) return opencodeCatalogBusy;
  opencodeCatalogBusy = (async () => {
    try {
      const cat = OC.api === "v2" ? await OC.listProviders({ timeoutMs: 10_000 }) : null;
      const connected = new Set(Array.isArray(cat?.connected) ? cat.connected : []);
      const providers = Array.isArray(cat?.all) ? cat.all.filter((p) => p?.id && (!connected.size || connected.has(p.id)) && !isRunnerEngine(engineOf(p.id))) : [];
      providers.sort((a, b) => (a.id === "zai-coding-plan" ? -1 : b.id === "zai-coding-plan" ? 1 : a.id.localeCompare(b.id)));
      const out = [];
      const seen = new Set();
      for (const p of providers) {
        const entries = Object.entries(p.models ?? {});
        entries.sort(([a], [b]) => (a === "glm-5.3-flash" ? -1 : b === "glm-5.3-flash" ? 1 : a.localeCompare(b)));
        for (const [mid, info] of entries) {
          if (!mid || seen.has(mid)) continue;
          seen.add(mid);
          const name = typeof info?.name === "string" && info.name.trim() ? info.name.trim() : mid === "glm-5.3-flash" ? "GLM-5.3-Flash" : mid === "glm-5.3" ? "GLM-5.3" : mid;
          out.push({ id: mid, name, providerID: p.id });
        }
      }
      if (out.length) opencodeCatalogCache = { at: Date.now(), list: out };
    } catch (err) {
      errLog("temporal.opencode.catalog", err);
    } finally {
      opencodeCatalogBusy = null;
    }
    return opencodeCatalogCache.list;
  })();
  return opencodeCatalogBusy;
}
const opencodeTemporalCatalog = () => {
  if (!MOCK && Date.now() - opencodeCatalogCache.at > 60_000) refreshOpencodeCatalog().catch(() => {});
  return opencodeCatalogCache.list.length ? opencodeCatalogCache.list : OPENCODE_FALLBACK_MODELS;
};
const temporalDeps={sendJson,readJsonBody,dirAllowed,engineAllowed,getUser,errLog,
  // FEAT-19.30 / FEAT-19.31: читаемые названия моделей для UI Temporal (отдаются с фильтрацией по правам пользователя).
  get modelLabels() {
    const out = {};
    for (const m of CLAUDE_MODELS) out[m.id] = m.name;
    for (const m of codexCatalog.models()) out[m.id] = m.name;
    for (const m of acpTemporalCatalog()) out[m.id] = m.name;
    for (const m of opencodeTemporalCatalog()) out[m.id] = m.name;
    return out;
  },
  // BUG-251 / FEAT-19.16: pipe folders and the project picker (no typed paths).
  ensureDir:(d)=>mkdirSync(d,{recursive:true}),
  defaultProject:(user)=>defaultDir(user,CHAT_DIR),
  projectsFor:async(user)=>{
    if(!isAdmin(user)) return user.directories??[];
    const counts=new Map();
    for(const d of (await fetchSessionIndex()).values()) if(typeof d==="string"&&d) counts.set(d,(counts.get(d)??0)+1);
    return [...counts.entries()].sort((a,b)=>b[1]-a[1]).map(([d])=>d)
      .filter(d=>projectCandidate(d,{tenantHome:config.TELEHARNESS_TENANT_HOME,problem:dirProblem,exists:x=>{try{return statSync(x).isDirectory();}catch{return false;}}}))
      .slice(0,60); // BUG-253
  },
  store:new DefinitionStore({file:path.join(DATA_DIR,"temporal-definitions.json")}),
  enabledTriggers:(user,definitionId)=>github.store.list(user.id).filter(t=>t.definitionId===definitionId&&t.enabled),
  publicUrl: config.TELEHARNESS_PUBLIC_URL,
  adminStopped: () => github.store.setting("adminStopped", false) === true,
  claudeLeftToday: () => {
    const limit = github.store.setting("claude_background_per_day", 10) ?? 10;
    let used = 0;
    for (const row of github.store.startedPerDayByTrigger()) {
      const tr = github.store.getById(row.triggerId);
      if (tr && github.usesClaude(tr)) used += row.n;
    }
    return Math.max(0, limit - used);
  },
  ledger: config.TELEHARNESS_TEMPORAL_LEDGER,
  socketPathError: null,
  commandCatalog: new CommandCatalog({
    file: path.join(DATA_DIR, "temporal-commands.json"),
    allowedRoots: config.TELEHARNESS_TEMPORAL_COMMAND_ROOTS.length ? config.TELEHARNESS_TEMPORAL_COMMAND_ROOTS : config.TELEHARNESS_FILE_ROOTS,
    cli: config.TELEHARNESS_TEMPORAL_CLI,
    address: config.TELEHARNESS_TEMPORAL_ADDRESS,
    namespace: config.TELEHARNESS_TEMPORAL_NAMESPACE,
  }),
  externalWorkflows: new ExternalWorkflowsClient({
    cli: config.TELEHARNESS_TEMPORAL_CLI,
    address: config.TELEHARNESS_TEMPORAL_ADDRESS,
    namespace: config.TELEHARNESS_TEMPORAL_NAMESPACE,
    uiBase: config.TELEHARNESS_TEMPORAL_UI_URL,
  }),
  auditCommand: (entry) => auditTemporalCommand(logAccess, entry),
};
if (process.env.TELEHARNESS_TEMPORAL_PIPELINES === "1") {
  const stage=config.TELEHARNESS_ENV === "stand";
  const socketPath=config.TELEHARNESS_TEMPORAL_MODEL_SOCKET || path.join(DATA_DIR,"temporal-private","worker.sock");
  temporalDeps.socketPathError=socketPathProblem(socketPath);
  const testQueue = process.env.TELEHARNESS_TEMPORAL_TEST_QUEUE ?? "";
  const options={socketPath,
    databasePath:path.join(DATA_DIR,"temporal-stage-starts.sqlite"),
    cli:config.TELEHARNESS_TEMPORAL_CLI,
    address:config.TELEHARNESS_TEMPORAL_ADDRESS,
    namespace:config.TELEHARNESS_TEMPORAL_NAMESPACE,
    taskQueue:stage && /^qa-[a-z0-9-]{1,72}$/.test(testQueue)
      ? testQueue : config.TELEHARNESS_TEMPORAL_QUEUE,
    ledger:config.TELEHARNESS_TEMPORAL_LEDGER,
    commandSlots:config.TELEHARNESS_TEMPORAL_COMMAND_SLOTS,
    tenantHome:config.TELEHARNESS_TENANT_HOME,
    drain:process.env.TELEHARNESS_TEMPORAL_DRAIN==="1",
    openCodeDirectory:stage ? process.env.TELEHARNESS_TEMPORAL_OC_DIRECTORY : undefined,openCodeAddress:stage?"http://127.0.0.1:4168":"http://127.0.0.1:4169",
    subscriptionToken:stage ? process.env.CLAUDE_CODE_OAUTH_TOKEN : undefined};
  // FEAT-19.15: model steps on the owner's subscriptions, switched on explicitly
  // (TELEHARNESS_TEMPORAL_MODELS=claude,codex); TELEHARNESS_TEMPORAL_SUBSCRIPTION_ATTESTED=1 —
  // the owner confirmed subscription-only billing (no usage API for this token).
  const enabled=new Set(String(process.env.TELEHARNESS_TEMPORAL_MODELS??"").split(",").map(s=>s.trim()).filter(Boolean));
  // FEAT-19.16: a model step = a portal chat turn in the pipe folder (same engine
  // runner, tenant jail, permissions and limits as chats).
  const prepareRunWorktree=({user,project,workspace,workflowId,pipeName})=>{
    const existing=workflowId?worktrees.store.byRun(workflowId):null;
    if(existing&&existing.state!=="orphaned") return existing;
    const admin=isAdmin(user);
    return worktrees.create({runId:workflowId,kind:"run",owner:user.id,tenant:!admin,dir:project,untrusted:!admin||isUnderAny(project,tenantRoots()),
      title:pipeName,chatFolder:admin?null:path.join(workspace,".teleharness-run-copies",String(workflowId??"run").replace(/[^A-Za-z0-9_-]/g,"").slice(-24))});
  };
  temporalChatSteps=chatStepRunner({
    registerStep:(x)=>costLedger.registerStep(x),
    createSession:async({user,directory,project,engine,model,worktree=null})=>{
      const admin=isAdmin(user);
      const targetDir=engine==="opencode"?(admin?(worktree?.path??directory):(project||directory)):(admin||!project?directory:project);
      mkdirSync(directory,{recursive:true});
      mkdirSync(targetDir,{recursive:true});
      const created=await OC.createSession({directory:targetDir,timeoutMs:DEFAULT_OPTS.timeoutMs});
      const providerID=engine==="codex"?CODEX_PROVIDER:engine==="acp"?(acpTemporalCatalog().find(m=>m.id===model)?.providerID??(Object.hasOwn(ACP_PROVIDERS,model)?model:"acp-antigravity")):engine==="opencode"?(opencodeTemporalCatalog().find(m=>m.id===model)?.providerID??"zai-coding-plan"):CLAUDE_PROVIDER;
      const binding=makeBinding({model:{providerID,modelID:model}});
      if(!created?.id||!binding) throw new Error("step chat not created");
      bindings.set(created.id,binding);hub.syncDirectories();fetchSessionIndex(true).catch(()=>{});
      return created.id;
    },
    dispatchTurn:async({res,sid,directory,project,user,text,engine=null,worktree=null})=>{
      const admin=isAdmin(user),binding=bindings.get(sid);
      const effEngine=engine??binding?.engine??"claude";
      if(effEngine==="opencode") {
        const dir=admin?(worktree?.path??directory):(project||directory);
        if(!admin && OC.api==="v2" && !(await sandboxPluginConfirmed())) { res.writeHead(403); return res.end(JSON.stringify({error:"sandbox plugin inactive"})); }
        let agent=null;
        if(!admin) {
          const agents=await agentList();
          agent=defaultTenantAgent(agents,config.TELEHARNESS_TENANT_AGENT);
          if(!agent || !agentAllowedForTenant(agent,agents)) { res.writeHead(403); return res.end(JSON.stringify({error:"agent not allowed"})); }
        }
        const race=await markPrompted(sid,binding);if(race){res.writeHead(409);return res.end(race);}
        try { await instanceHealth.ready(dir); await instanceHealth.heal(dir); instanceHealth.warm(dir); } catch (err) { errLog("temporal.opencode.health", err); }
        const sysTurn=withUserSystem({parts:[{type:"text",text}]},getSystemPrompt(user.id),{admin,portal:""});
        const sysMeta=typeof sysTurn?.system==="string" && sysTurn.system ? {system:sysTurn.system} : null;
        const modelRef=cleanModel(binding?.model);
        const variant=modelRef ? withGlmVariant({model:modelRef},config.TELEHARNESS_GLM_VARIANT).variant??null : null;
        try {
          if(OC.api==="v2") {
            await OC.enqueueTurn(sid,async()=>{
              if(modelRef) await OC.setSessionModel(sid,{model:{providerID:modelRef.providerID,modelID:modelRef.modelID,...(variant?{variant}:{})},timeoutMs:DEFAULT_OPTS.timeoutMs});
              if(agent) await OC.setSessionAgent(sid,{agent,timeoutMs:DEFAULT_OPTS.timeoutMs});
              if(admin) await applyOcPermMode(sid,dir,"full");
              await OC.prompt({directory:dir,sessionID:sid,parts:sysTurn.parts,...(sysMeta?{metadata:sysMeta}:{}),timeoutMs:PROMPT_OPTS.timeoutMs});
            });
          } else {
            await OC.prompt({directory:dir,sessionID:sid,parts:sysTurn.parts,...(modelRef?{model:modelRef}:{}),...(agent?{agent}:{}),...(variant?{variant}:{}),...(sysMeta?.system?{system:sysMeta.system}:{}),timeoutMs:PROMPT_OPTS.timeoutMs});
          }
          res.writeHead(204);
          return res.end();
        } catch (err) {
          res.writeHead(err?.status || 502);
          return res.end(JSON.stringify({error:err?.message ?? "opencode prompt failed"}));
        }
      }
      const chatDir=admin||!project?directory:project,workDir=worktree?.path??(admin||!project?null:directory);
      const race=await markPrompted(sid,binding);if(race){res.writeHead(409);return res.end(race);}
      return claude.dispatch({res,sid,dir:chatDir,body:Buffer.from(JSON.stringify(applyBinding({parts:[{type:"text",text}]},binding))),
        access:admin?"admin":"tenant",acpOwner:engineAllowed(user,"acp")?acpAuthOwner(user):null,agent:null,
        kbZone:kbZoneForUser(user,{admin,adminRoot:config.TELEHARNESS_KB_ROOT,tenantVault:config.TELEHARNESS_TENANT_VAULT,home:admin?HOME_DIR:null}),
        jail:admin?null:tenantJailFor(chatDir,config.TELEHARNESS_TENANT_HOME),systemPrompt:getSystemPrompt(user.id),portalNote:"",workDir,permMode:null,
        nonInteractive:true,
        writableRoots:worktree?.commonDir?[worktree.commonDir]:null});
    },
    prepareWorktree:prepareRunWorktree,
    messagesOf:async(sid,meta)=>meta?.engine==="opencode"?(await OC.listMessages(sid,{directory:meta.directory,timeoutMs:DEFAULT_OPTS.timeoutMs})).messages:claude.messages(sid),
    abort:(sid,meta)=>{if(meta?.engine==="opencode") OC.abort(sid,{directory:meta.directory}).catch(()=>{}); else claude.abort(sid);},
    setTitle:(sid,title,meta)=>{if(meta?.engine==="opencode") OC.patchSession(sid,{directory:meta.directory,title,timeoutMs:DEFAULT_OPTS.timeoutMs}).catch(()=>{}); else claude.setTitle(sid,title,"user");},
    isLimit:(err,engine)=>isLimitError(err,{engine}),
  });
  if(enabled.has("claude")) options.chatModels={...options.chatModels,claude:()=>CLAUDE_MODELS.map(m=>m.id)};
  if(enabled.has("codex")) Object.assign(options,{chatModels:{...options.chatModels,codex:()=>codexCatalog.models().map(m=>m.id)},
    codexModels:()=>codexCatalog.models().map(m=>m.id),codexHome:process.env.TELEHARNESS_TEMPORAL_CODEX_HOME||undefined});
  if(enabled.has("acp")) {
    options.chatModels={...options.chatModels,acp:()=>acpTemporalCatalog().map(m=>m.id)};
    const acpOwnerId=adminUser()?.id??null;
    if(acpOwnerId && process.env.TELEHARNESS_ACP!=="off") {
      for(const id of ACP_PUBLIC_IDS) {
        if((acpLogins[id].get(acpOwnerId).status==="ready" || acpProfileReady(DATA_DIR,acpOwnerId,id)) && !cachedAcpModels(DATA_DIR,acpOwnerId,id)) {
          discoverAcpModels(DATA_DIR,acpOwnerId,id).catch(()=>{});
        }
      }
    }
  }
  // FEAT-19.31: OpenCode (GLM-5.3-Flash / GLM-5.3) в модельных шагах Temporal + прогрев каталога провайдеров.
  if(enabled.has("opencode")) {
    options.chatModels={...options.chatModels,opencode:()=>opencodeTemporalCatalog().map(m=>m.id)};
    refreshOpencodeCatalog().catch(()=>{});
  }
  options.chatSteps=temporalChatSteps;
  options.prStep=prStepRunner({
    prepareWorktree:prepareRunWorktree,
    gitAuthor:(uid)=>{const g=getGitSettings(uid);return {name:g.authorName,email:g.authorEmail};},
    githubApi:async(userId,method,pathname,body)=>{
      const c=github?.connections?.get(userId);
      if(!c?.tokenEnc) throw new GhError(401,"auth","Нет подключения GitHub");
      return ghFetch(github.box.decrypt(c.tokenEnc),pathname,{method,body,apiBase:config.TELEHARNESS_GITHUB_API||undefined});
    },
    githubToken:(userId)=>{
      const c=github?.connections?.get(userId);
      return c?.tokenEnc?github.box.decrypt(c.tokenEnc):null;
    },
    onPushed:({repo,branch,sha})=>github?.store?.recordAgentBranchPush?.(repo,branch,sha),
    log:(m)=>console.log(m),
  });
  if (temporalDeps.socketPathError) {
    errLog("temporal.socket", new Error(temporalDeps.socketPathError));
  } else {
    Object.assign(temporalDeps,await connectPipeline(temporalDeps,options));
    Object.defineProperty(temporalDeps,"subscriptionModels",{get:()=>temporalDeps.listSubscriptionModels(),enumerable:true});
  }
} else if (config.TELEHARNESS_ENV==="stand" && process.env.TELEHARNESS_TEMPORAL_STAGE_TIMERS==="1") {
  Object.assign(temporalDeps,stageTimerStarter(path.join(DATA_DIR,"temporal-stage-starts.sqlite"),{
    cli:config.TELEHARNESS_TEMPORAL_CLI,address:config.TELEHARNESS_TEMPORAL_ADDRESS,namespace:config.TELEHARNESS_TEMPORAL_NAMESPACE,
  }));
}
// FEAT-20.2: чаты доски пользователя — тенант: свои папки; admin: папки, не
// принадлежащие ни одному тенанту (правило pushRecipients). Временные папки — нет.
const PIPE_STEP_DIR_RE = /[\\/]pipelines[\\/][^\\/]+$/;
async function attentionChats(user, admin) {
  await fetchSessionIndex();
  const tenants = admin ? listUsers().filter((u) => !u.disabled && u.role !== "admin") : [];
  const mine = (dir) => (admin ? !tenants.some((t) => dirAllowed(t, dir)) : dirAllowed(user, dir));
  const recs = new Map(sessionIndex.recById);
  for (const sid of claude.sessionIds()) if (!recs.has(sid)) recs.set(sid, { id: sid, directory: claude.dirOf(sid), title: claude.titleInfo(sid)?.title ?? null });
  const out = [];
  for (const [id, rec] of recs) {
    const dir = rec?.directory ?? claude.dirOf(id) ?? null;
    if (!dir || isTempSessionDir(dir) || !mine(dir)) continue;
    const b = bindingFor(id, rec);
    const title = claude.titleInfo(id)?.title || titler.overlay([rec])[0]?.title || rec?.title || null;
    out.push({
      id, dir, title, parentID: rec?.parentID ?? null, agent: rec?.agent ?? null,
      engine: b?.engine ?? engineOfChat(id), model: b?.model?.modelID ?? null,
      step: (typeof title === "string" && title.startsWith("⇄ ")) || PIPE_STEP_DIR_RE.test(dir) || !!temporalChatSteps?.owns(id),
    });
  }
  return out;
}
// Живое состояние: занятость (хаб: opencode и раннер), тишина хода, фоновые агенты, открытые запросы.
function attentionLive() {
  const busy = {};
  for (const r of hub.sessionsReport()) if (r.state === "busy" || (r.state === "dialog" && r.lastEventAt)) busy[r.sessionID] = { since: r.since, lastEvent: r.lastEventAt };
  const live = claude.liveness();
  for (const [sid, st] of Object.entries(claude.busySnapshot())) {
    const l = live[sid];
    busy[sid] = { since: l?.startedAt ?? busy[sid]?.since ?? Date.now(), lastEvent: st.bg ? null : l?.lastOutputAt ?? busy[sid]?.lastEvent ?? null, bg: !!st.bg };
  }
  const seen = new Set();
  const dialogs = [];
  for (const d of [...claude.dialogs(), ...hub.dialogsSnapshot()]) {
    if (!d?.id || seen.has(d.id)) continue;
    seen.add(d.id);
    dialogs.push(d);
  }
  return { busy, dialogs };
}
const API_ROUTES = validateTable([
  ...attentionRoutes({
    sendJson, readJsonBody, store: attention, chatsFor: attentionChats, live: attentionLive,
    sources: () => ({ opencode: MOCK ? "ok" : sessionIndex.failAt > sessionIndex.at || !sessionIndex.at ? "down" : "ok", claude: "ok" }),
    boardRuns: (user) => temporalDeps.boardRuns?.(user) ?? null,
    reviews: (user) => reviews.summaries(user.id), // FEAT-20.1: элементы ревью по общему контракту
    pinsOf: (id) => getPins(id), epoch: () => hub.epoch ?? null,
    ping: (id, reason) => attentionPing([id], reason),
    projectName: (dir) => String(dir ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "",
  }),
  // FEAT-20.6: расход по ценам API (routes/costs.js)
  ...costRoutes({
    sendJson, readJsonBody, errLog, ledger: costLedger, reports: costReports, backfill: costBackfill, dirAllowed, userName: costUserName,
    chatAllowed: async (user, sid) => {
      const dir = claude.dirOf(sid) ?? (await resolveSessionDir(sid).catch(() => null));
      return dir ? dirAllowed(user, dir) : true; // удалённый чат: решают строки журнала (только свои)
    },
  }),
  // FEAT-20.1: ревью и план (routes/review.js)
  ...reviewRoutes({ sendJson, readJsonBody, errLog, reviews, untrusted: reviewUntrusted, planRun }),
  ...githubRoutes({ sendJson, readJsonBody, errLog, connections: github.connections, check: github.check, secrets: github.box, log: (m) => console.log(m) }),
  ...temporalRoutes(temporalDeps),
  ...scheduleRoutes(temporalDeps),
  ...triggerRoutes({
    sendJson, readJsonBody, errLog, store: github.store, connections: github.connections,
    usesClaude: github.usesClaude,
    permissionCheck: github.permissionCheck,
    dirAllowed,
    checkOrigin: (dir, repo, user) => checkGitOrigin(dir, repo, { untrusted: !isAdmin(user) }),
    engineModels: () => temporalDeps.subscriptionModels ?? {},
    pipelinesEnabled: () => Boolean(temporalDeps.startPipeline), pipeOf: async (user, definitionId) => {
      try {
        const rec = temporalDeps.store.get(user.id, definitionId);
        const latest = rec?.versions?.length ? rec.versions[rec.versions.length - 1] : null;
        const version = latest?.version ?? null;
        const dir = latest?.definition?.directory ?? rec.draft?.directory ?? rec.directory;
        if (!version || !dirAllowed(user, dir)) return null;
        return { version, directory: dir, usesClaude: github.pipeUsesClaude(user.id, definitionId, version) };
      } catch { return null; }
    },
    launch: github.launch, cancelRun: github.cancelRun, publicUrl: config.TELEHARNESS_PUBLIC_URL, log: (m) => console.log(m),
    connectionToken: (owner) => {
      const c = github.connections.get(owner);
      return c?.tokenEnc ? github.box.decrypt(c.tokenEnc) : null;
    },
    apiBase: config.TELEHARNESS_GITHUB_API || undefined,
  }),
  ...fileRoutes({
    sendJson, homeDir: HOME_DIR, fileRoots, serveWorkspaceFile, workspaceFileExists, turnFiles, parseWindows, errLog,
    dirProblem, driveProblem, dirProblemText, dirAllowed, config, path, defaultDir, chatDir: CHAT_DIR, handleUpload,
    tenantUploadBytes, uploadLimit: UPLOAD_LIMIT, sanitizeFilename, uploadDir: UPLOAD_DIR, unlinkSync,
  }),
  ...catalogRoutes({
    sendJson, errLog, usageStats, subscriptionCards, hub, claude, claudeAgents, upstream: UPSTREAM, statusTtlMs: STATUS_TTL_MS,
    fetchSessionIndex, dirAllowed, captureResponse, providerForUser, acpReady, acpProviderCatalog, discoverModels: (user,id) => { const owner = acpAuthOwner(user); return owner ? discoverAcpModels(DATA_DIR,owner,id) : null; }, engineAllowed, proxyRequest, withQuery,
    defaultOpts: DEFAULT_OPTS, tenantAgents, agentList, publicAgent, upstreamError, hostStats, opencodeVersion, harnessVersions,
    version: VERSION, defaultDir, chatDir: CHAT_DIR, instanceHealth,
    // FEAT-16.3 (tasks 3.2): каталог идёт через клиент только в v2-режиме —
    // v1 сохраняет прежние raw-вызовы бит в бит (веер /session/status с
    // явным ?directory=, ETag-кэш /agent и /project).
    oc: OC.api === "v2" ? OC : null,
    // v2fix2 (лейн A): источник каталога /teleharness/api/provider для v2 (форма 1.x
    // собирается в OC.listProviders, см. провайдер выше); null в v1 — прежний путь бит в бит.
    providerCatalog,
    ocUpstreamError,
  }),
  ...acpCatalogRoutes({registry:new AcpRegistry(DATA_DIR), installer:new AcpInstaller(DATA_DIR), sendJson, readJsonBody}),
  acpLoginRoute({ sendJson, readJsonBody, agent:"github-copilot-cli", login:acpLogins["github-copilot-cli"] }),
  acpLoginRoute({ sendJson, readJsonBody, agent:"antigravity", login:acpLogins.antigravity }),
  ...adminRoutes({
    sendJson, apiError, readJsonBody, bodyLimit: DEFAULT_OPTS.bodyLimit, listUsers, createUser, regenerateToken, updateUser,
    bridgeDialogs: () => claude.dialogs(), // BUG-264 п.3
    deleteAccount, closeUserStreams, hub, fetchSessionIndex, sessionIndex: () => sessionIndex, planGc, dataDir: DATA_DIR, path,
    runEmptyChatGc, emptyChatGcInput, gcEmptyMin: config.TELEHARNESS_GC_EMPTY_MIN, pendingRemovals, ownerlessTenantDirs,
    lastGc: () => lastGc, gcRunning: () => gcRunning, gcSweep, rotateOwnToken, setAuthCookie, createSession, isHttps,
    getSystemPrompt, setSystemPrompt, cleanSystemPrompt, SYSTEM_PROMPT_MAX,
    getPins, setPins, cleanPins, PINS_MAX, visibleIds: visiblePinIds,
    createPairCode, publicUrl: config.TELEHARNESS_PUBLIC_URL,
    getAutoRelay, setAutoRelay, cleanAutoRelay, readAutoRelay, AUTO_RELAY_ORDER_MAX, autoRelayModelOk, // FEAT-18.6
    storeKbTrace: (t) => storeKbTrace(config.TELEHARNESS_LOG_DIR, t),
    commandCatalog: temporalDeps.commandCatalog,
    externalWorkflows: temporalDeps.externalWorkflows,
    auditCommand: temporalDeps.auditCommand,
  }),
  // FEAT-18.8: /teleharness/api/git/* and /teleharness/api/me/git (routes/git.js)
  ...gitRoutes({
    sendJson, readJsonBody, apiError, errLog, dirAllowed, existingChatFolder, isUnderAny,
    // the chat's folder: the runner's record for Claude/Codex chats, else the upstream index
    chatDirOf: async (sid) => claude.dirOf(sid) ?? (await resolveSessionDir(sid)),
    worktreeDirOf, // FEAT-20.7: Git чата с рабочей копией — это копия
    // TASK-18.13 D1 (P1): any folder INSIDE a tenant's folders (chats<id> subfolders) or the tenant home is the
    // tenant's — its repo config is untrusted for the admin too (a named program must never run as the server)
    tenantDir: (dir) => isUnderAny(dir, [config.TELEHARNESS_TENANT_HOME, ...listUsers().filter((u) => u.role !== "admin").flatMap((u) => u.directories ?? [])].filter(Boolean)),
    bindingOf: async (sid) => bindingFor(sid, await sessionRecord(sid, true).catch(() => null)),
    engineAllowed,
    recordService: (x) => costRecorder.service(x), // FEAT-20.6: расход «Предложить сообщение»
    tenantAgent: async () => defaultTenantAgent(await agentList(), config.TELEHARNESS_TENANT_AGENT),
    getGitSettings, setGitSettings, cleanGitSettings,
    suggest: {
      claudeBin: process.env.TELEHARNESS_CLAUDE_BIN || CLAUDE_DEFAULT_BIN,
      codexShim: process.env.TELEHARNESS_CODEX_SHIM || path.join(ROOT, "lib", "codex-shim.mjs"),
      acpShim: path.join(ROOT, "lib", "acp-shim.mjs"),
      dataDir: DATA_DIR,
      acpOwner: acpAuthOwner,
      token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
      oc: OC,
    },
  }),
  // FEAT-20.7: рабочие копии (routes/worktrees.js)
  ...worktreeRoutes({
    sendJson, readJsonBody, errLog, wt: worktrees, dirAllowed, isUnderAny,
    chatDirOf: async (sid) => claude.dirOf(sid) ?? (await resolveSessionDir(sid)),
    tenantDir: (dir) => isUnderAny(dir, tenantRoots()),
    titleOf: chatTitleOf,
    tenantTestsOk,
    sessionPrompted: (sid) => Boolean(bindings.get(sid)?.prompted) || claude.messages(sid)?.length > 0,
    gitAuthor: (uid) => {
      const g = getGitSettings(uid);
      return { name: g.authorName, email: g.authorEmail };
    },
    review: ({ user, admin, item }) => reviews.branchItem(user.id, { sid: item.sid, wtId: item.id, dir: item.path, base: item.base, title: (item.sid ? chatTitleOf(item.sid) : null) ?? item.title ?? item.branch, branch: item.branch, untrusted: !admin || isUnderAny(item.path, tenantRoots()) }),
  }),
  ...pushRoutes({ sendJson, readJsonBody, push: () => webPush }),
  ...voiceRoutes({ sendJson, readBody, readJsonBody, voice: voiceService, quota: voiceQuota }),
  ...sessionRoutes({
    search: (c) => sessionSearchRoute(c),
    binding: (c) => sessionBindingRoute(c),
    action: (c) => sessionActionRoute(c),
    plan: (c) => sessionPlanRoute(c),
    revert: async (c) => {
      await sessionRevertRoute(c);
      // FEAT-01.60: откат/возврат хода меняет историю — обновляем поисковый индекс.
      if (c.req.method === "POST" && c.res.statusCode === 200 && c.match?.[1]) {
        const sid = c.match[1];
        chatSearch?.markDirty(sid);
        if (claude.has(sid)) chatSearch?.syncClaudeSession(sid, claude.messages(sid));
      }
      // FEAT-20.1: «Отменить ход» вернул файлы — пункт ревью пересчитывается
      if (c.req.method === "POST" && c.res.statusCode === 200 && /\/revert$/.test(c.url.pathname)) {
        const sid = c.match?.[1];
        const dir = sid ? reviewChatDir(sid) : null;
        if (dir) { const work = reviewWorkDir(sid, dir); reviews.turnUndone({ users: pushRecipients(dir), sid, dir: work, untrusted: isUnderAny(work, tenantRoots()) }).catch((err) => errLog("review.undo", err)); }
      }
    },
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

// FEAT-11.18 (шаг В): передача чата на другой движок или модель — ОДИН путь для ручной
// кнопки (PATCH binding {relay:true}) и авто-передачи при лимите (FEAT-18.6).
// Вызывается под локом чата (withSessionLock) с только что прочитанной привязкой.
// → {status, body} — ответ маршрута.
async function relayUnderLock({ id, dir, user, admin, current, target, reason = null }) {
  const busy = Boolean(hub.busySnapshot()[id] || claude.busySnapshot()[id]);
  const plan = planRelay({ current, target, busy, claudeAgentOk: (a) => admin && claudeAgents.has(a) });
  if (plan.error) return { status: plan.status, body: { error: plan.error, teleharness: current } };
  if (!engineAllowed(user, plan.binding.engine)) return { status: 403, body: { error: "engine not allowed" } };
  const problem = await tenantModelProblem(user, plan.binding.model);
  if (problem) return { status: problem.status, body: { error: problem.error, teleharness: current } };
  if (!admin && plan.binding.engine === "opencode" && plan.binding.agent && !agentAllowedForTenant(plan.binding.agent, await agentList()))
    return { status: 403, body: { error: "agent not allowed" } };
  const rdir = dir ?? claude.dirOf(id) ?? null;
  // журнал — до смены привязки: новый движок должен найти в нём всё сделанное
  try {
    await journal.flush(id);
  } catch (err) {
    errLog("relay.journal", err);
  }
  const marks = relays.add(id, relayMark(current, plan.binding, { reason }));
  // FEAT-18.4: the chat's permission mode goes along with the chat
  if (cleanPermMode(current?.permMode)) plan.binding.permMode = current.permMode;
  bindings.set(id, plan.binding);
  if (!isRunnerEngine(plan.binding.engine)) hub.unmarkManaged(id);
  const teleharness = { ...plan.binding, source: "stored", relays: marks };
  hub.emit({ type: "session.updated", properties: { sessionID: id, info: { id, teleharness } } }, rdir);
  journal.schedule(id); // отметка передачи попадает в журнал
  return { status: 200, body: { id, teleharness, relay: marks.at(-1) } };
}

// ---- FEAT-18.6: авто-передача при лимите ---------------------------------------
// Модель доступна пользователю: движок разрешён и модель есть в его каталоге
// (тот же каталог, что видит клиент; каталог недоступен — не отказываем здесь,
// передача сама перепроверит модель тенанта).
async function providerCatalogJson(user = null) {
  const captured = await captureResponse((shim) => claude.handleProvider({ headers: {} }, shim, UPSTREAM, { catalog: providerCatalog }));
  if (captured.status !== 200) return null;
  let catalog;
  try {
    catalog = JSON.parse(captured.body);
  } catch {
    return null;
  }
  if (user && engineAllowed(user, "acp")) {
    const acpIds = acpReady(user);
    if (acpIds.length) {
      const owner = acpAuthOwner(user);
      const models = Object.fromEntries(await Promise.all(acpIds.map(async (id) => [id, owner ? await discoverAcpModels(DATA_DIR, owner, id) : null])));
      catalog = acpProviderCatalog(catalog, acpIds, models);
    }
  }
  return catalog;
}
async function autoRelayModelOk(user, model) {
  const m = cleanModel(model);
  if (!m || !engineAllowed(user, engineOf(m.providerID))) return false;
  const catalog = await providerCatalogJson(user);
  return modelInCatalog(catalog, m, { claudeAllowed: engineAllowed(user, "claude"), codexAllowed: engineAllowed(user, "codex"), acpAllowed: engineAllowed(user, "acp"), paidOpencodeAllowed: isAdmin(user) }) !== false;
}

// Чья настройка действует для чата: тенант, которому принадлежит папка чата (как журнал
// и push), иначе администратор.
function chatOwner(dir) {
  const users = listUsers().filter((u) => !u.disabled);
  const tenant = dir ? users.find((u) => u.role !== "admin" && dirAllowed(u, dir)) : null;
  if (tenant) return getUser(tenant.id);
  const admins = users.filter((u) => u.role === "admin");
  const on = admins.find((u) => readAutoRelay(getAutoRelay(u.id)).on) ?? admins[0];
  return on ? getUser(on.id) : null;
}

// Внутренний ход «продолжи» — тот же маршрут prompt, что у клиента (гейты, привязка,
// вложение пропущенных ходов, системный промпт), без HTTP: синтетические req/res.
// req.teleharnessAutoRelay: этот ход не открывает новый цикл авто-передачи.
function internalPrompt({ sid, dir, user, text, autoRelay = true, flags = null }) {
  const admin = isAdmin(user);
  const body = Buffer.from(JSON.stringify({ parts: [{ type: "text", text }] }), "utf8");
  const req = Readable.from([body]);
  Object.assign(req, { method: "POST", url: `/teleharness/api/session/${sid}/prompt`, headers: { "content-type": "application/json", "content-length": String(body.length) }, teleharnessAutoRelay: autoRelay, ...(flags ?? {}) });
  const q = dir ? `?directory=${encodeURIComponent(dir)}` : "";
  const url = new URL(`http://internal/teleharness/api/session/${encodeURIComponent(sid)}/prompt${q}`);
  return new Promise((resolve) => {
    let status = 200;
    let text = "";
    const res = new Writable({
      write(c, _e, cb) {
        if (text.length < 300) text += Buffer.from(c).toString("utf8").slice(0, 300);
        cb();
      },
    });
    res.headersSent = false;
    res.setHeader = () => {};
    res.writeHead = (s) => {
      status = s;
      res.headersSent = true;
      return res;
    };
    res.on("finish", () => resolve({ ok: status < 300, status, error: status < 300 ? null : text }));
    res.on("error", () => resolve({ ok: false, status: 502 }));
    sessionActionRoute({ req, res, url, user, admin, match: [null, sid, "prompt"] }).catch((err) => {
      errLog("autoRelay.prompt", err);
      resolve({ ok: false, status: 502 });
    });
  });
}

const autoRelay = createAutoRelay({
  ownerOf: (_sid, dir) => chatOwner(dir),
  settingOf: (user) => getAutoRelay(user.id),
  bindingOf: async (sid) => bindingFor(sid, await sessionRecord(sid, true).catch(() => null)),
  available: autoRelayModelOk,
  relay: ({ sid, dir, user, model }) =>
    withSessionLock(sid, async () => {
      const current = bindingFor(sid, await sessionRecord(sid, true).catch(() => null));
      const out = await relayUnderLock({ id: sid, dir, user, admin: isAdmin(user), current, target: { model }, reason: RELAY_REASON_AUTO });
      if (out.status === 200) {
        // FEAT-20.2: событие сводки «Пока вас не было»
        const title = claude.titleInfo(sid)?.title || sessionIndex.recById.get(sid)?.title || "чат";
        attention.addEvent(pushRecipients(dir), { kind: "relay", key: `chat:${sid}`, text: `Relay: «${title}» автоматически продолжен на ${model?.modelID ?? "запасной модели"}` });
      }
      return { ok: out.status === 200, status: out.status, error: out.body?.error ?? null };
    }),
  resume: ({ sid, dir, user }) => internalPrompt({ sid, dir, user, text: RELAY_RESUME_TEXT }),
  log: (m) => console.log(m),
});

// Лимит хода: Claude — по тексту ошибки хода (onTurnEnd раннера), opencode — по
// session.error хаба. Классификатор — общий с клиентом (shared/turn-error.js).
const AUTO_RELAY_DELAY_MS = Number(process.env.TELEHARNESS_AUTO_RELAY_DELAY_MS) >= 0 && process.env.TELEHARNESS_AUTO_RELAY_DELAY_MS ? Number(process.env.TELEHARNESS_AUTO_RELAY_DELAY_MS) : 1500;
function autoRelayOnLimit(sid, dir) {
  // ход ещё доедает свои события (session.idle после session.error) — передаём чуть позже
  const t = setTimeout(() => void autoRelay.onLimit({ sid, dir }), AUTO_RELAY_DELAY_MS);
  t.unref?.();
}
if (!MOCK)
  hub.onEvent((data, dir) => {
    if (!data.includes('"session.error"')) return;
    let evt = null;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    const sid = evt?.properties?.sessionID;
    if (evt?.type !== "session.error" || typeof sid !== "string" || !sid) return;
    if (isRunnerEngine(engineOfChat(sid))) return; // Claude/Codex/ACP — через onTurnEnd
    if (!isLimitError(evt.properties.error)) return;
    // папка — из индекса чатов (по ней определяется владелец настройки), поток событий — запасной вариант
    void (async () => autoRelayOnLimit(sid, claude.dirOf(sid) ?? (await resolveSessionDir(sid).catch(() => null)) ?? dir ?? null))();
  });

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
  // BUG-218 (SRV-06, design §1): the read, every check and the store write run
  // under the chat lock — between the old read and the write there were awaits
  // (model/agent catalogs), and a parallel prompt mark or agent reset was lost.
  return withSessionLock(id, async () => {
    const current = bindingFor(id, await sessionRecord(id));
    // FEAT-11.18 (шаг В): {relay: true, model, agent?} — передача чата на другой движок или модель.
    // Единственный разрешённый способ сменить движок у чата с сообщениями.
    if (body.relay === true) {
      // FEAT-18.6: «лимит, авто» ставит только сервер (lib/auto-relay.js), не клиент
      const reason = typeof body.reason === "string" && body.reason !== RELAY_REASON_AUTO ? body.reason : null;
      const out = await relayUnderLock({ id, dir, user, admin, current, target: { model: body.model, ...(Object.prototype.hasOwnProperty.call(body, "agent") ? { agent: body.agent } : {}) }, reason });
      return sendJson(res, out.status, out.body);
    }
    // FEAT-13.17: Claude agents are admin-only and must exist in the catalog.
    const r = patchBinding(current, body, { claudeAgentOk: (a) => admin && claudeAgents.has(a) });
    if (r.error) return sendJson(res, r.status, { error: r.error, teleharness: current });
    // FEAT-18.4: the permission mode — acts from the next turn, never changes
    // mid-turn (409); «Без вопросов» is admin-only; opencode
    // chats take it on the 2.x API, admin only (tenant Sandbox rules stay).
    if (Object.prototype.hasOwnProperty.call(body, "permMode") && (body.permMode ?? null) !== (current?.permMode ?? null)) {
      if (hub.busySnapshot()[id] || claude.busySnapshot()[id]) return sendJson(res, 409, { error: "turn is running: the permission mode changes between turns", teleharness: current });
      if (!admin && body.permMode === "full") return sendJson(res, 403, { error: "permission mode not allowed", teleharness: current });
      // FEAT-18.7: без песочницы Codex/ACP «Правки без вопросов» не могут писать — в этом чате их нет
      if (body.permMode === "edits" && (r.binding.engine === "codex" || r.binding.engine === "acp")) return sendJson(res, 400, { error: "permission mode not supported for this chat", teleharness: current });
      if (body.permMode !== null && r.binding.engine === "opencode" && (!admin || OC.api !== "v2"))
        return sendJson(res, 400, { error: "permission mode not supported for this chat", teleharness: current });
    }
    // FEAT-20.1 «Сначала план»: только где запрет правок обеспечен (иначе 409 plan-unsupported с причиной)
    if (body.planFirst === true && current?.planFirst !== true) {
      const why = await planBlockedReason(r.binding, admin);
      if (why) return sendJson(res, 409, { error: why, code: "plan-unsupported", teleharness: current });
    }
    // ADR-004 / BUG-12.5: the engine and the agent are policy-checked.
    if (!engineAllowed(user, r.binding.engine)) return sendJson(res, 403, { error: "engine not allowed" });
    const modelProblem = await tenantModelProblem(user, r.binding.model);
    if (modelProblem) return sendJson(res, modelProblem.status, { error: modelProblem.error, teleharness: current });
    if (!admin && r.binding.engine === "opencode" && r.binding.agent && !agentAllowedForTenant(r.binding.agent, await agentList()))
      return sendJson(res, 403, { error: "agent not allowed" });
    bindings.set(id, r.binding);
    return sendJson(res, 200, { id, teleharness: { ...r.binding, source: "stored" } });
  });
}

async function sessionPlanRoute({ res, user, admin, match }) {
  const id = match[1];
  if (!admin) {
    const dir = claude.dirOf(id) ?? (await resolveSessionDir(id));
    if (dir == null) return sendJson(res, 404, { error: "session not found" });
    if (!dirAllowed(user, dir)) return sendJson(res, 403, { error: "outside your scope" });
  }
  return sendJson(res, 200, { sessionID: id, todos: hub.planOf(id) ?? [] });
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
  if (req.method === "POST" && (action === "prompt" || action === "abort")) {
    if (action==="abort" && Number.isFinite(turnIdsFrom) && !await recovery.allowed(id,user.id)) {
      req.resume();return sendJson(res,403,{error:"Отмена недоступна для текущего владельца хода"});
    }
    const problem=await chatRouting.checkTurn(user.id,id);
    if (problem) {req.resume();return sendJson(res,problem.status ?? 503,problem);}
  }
  if (action === "message" && req.method === "GET") {
    // BUG-08.8: history pages (?limit=&before=) — opencode 1.19.5 answers
    // 400 on `before`, so the slice is cut here (lib/proxy.js contract).
    const pp = pageParams(`/x${q}`);
    if (pp?.error) return sendJson(res, 400, { error: pp.error });
    if (relays.has(id)) {
      // FEAT-11.18: чат с передачами — истории обоих движков одной лентой
      const rdir = claude.dirOf(id) ?? (await resolveSessionDir(id));
      if (!admin) {
        if (rdir == null) return sendJson(res, 404, { error: "session not found" });
        if (!dirAllowed(user, rdir)) return sendJson(res, 403, { error: "outside your scope" });
      }
      const merged = await wholeChatMessages(id, rdir);
      return sendPaged(res, admin ? merged : redactMessages(merged), pp);
    }
    if (claude.has(id)) {
      const cdir = claude.dirOf(id);
      if (!admin) {
        if (cdir == null) return sendJson(res, 404, { error: "session not found" });
        if (!dirAllowed(user, cdir)) return sendJson(res, 403, { error: "outside your scope" });
      }
      const merged = await claude.mergedMessages(id, cdir ?? HOME_DIR, UPSTREAM);
      return sendPaged(res, admin ? merged : redactMessages(merged), pp);
    }
    if (OC.api === "v2") {
      // История через адаптер: нарезка limit/below — в listMessages (та же
      // математика paginateMessages), лицо и x-teleharness-* — прежние (3.4).
      try {
        const dirHint = admin ? (url.searchParams.get("directory") ?? null) : tenantDir;
        instanceReaper.touch(sessionIndex.recById.get(id)?.directory ?? dirHint); // BUG-195: чтение истории поднимает экземпляр папки
        if (pp) {
          const out = await OC.listMessages(id, { directory: dirHint, limit: pp.limit ?? null, before: pp.before ?? null, timeoutMs: PROMPT_OPTS.timeoutMs });
          return sendOcPage(res, out, admin ? markEmptyTail : (list) => markEmptyTail(redactMessages(list)));
        }
        const whole = await ocWholeMessages(id, dirHint); // без limit/before — вся история, как раньше
        if (!whole) return sendJson(res, 502, { error: "upstream error" });
        return sendPaged(res, admin ? markEmptyTail(whole) : markEmptyTail(redactMessages(whole)), null);
      } catch (err) {
        return ocUpstreamError(res, err, "message");
      }
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
    const limit = admin ? PROMPT_OPTS.bodyLimit : config.TELEHARNESS_TENANT_PROMPT_LIMIT || PROMPT_OPTS.bodyLimit;
    const raw = await readBody(req, limit);
    if (raw === null) return sendJson(res, 413, { error: "body too large" });
    // Защита «закрыто при отказе» — ДО любых побочных эффектов (binding,
    // материалзация файлов, dial upstream, spawn claude): без подтверждённого
    // плагина песочницы тенантский ход не начинается.
    if (!admin && OC.api === "v2" && !(await sandboxPluginConfirmed()))
      return sendJson(res, 403, { error: "sandbox plugin not confirmed: tenant turns are disabled until the sandbox plugin is loaded on the opencode serve" });
    // BUG-218 (SRV-07): a turn never starts during a revert — refused before
    // any side effect. The authoritative re-check sits under the chat lock in
    // markPrompted (a revert may start right after this line).
    if (isReverting(id)) return sendJson(res, 409, { error: "revert in progress" });
    // FEAT-18.6: ход пользователя открывает новый цикл авто-передачи (авто-«продолжи» — нет)
    if (!req.teleharnessAutoRelay) autoRelay.userTurn(id);
    const dir = admin ? await adminSessionDir(id, url) : tenantDir;
    if (admin) upQ = scopedQuery(q, dir);
    let parsed = null;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {}
    // Route by the CHAT's binding, never by the body. No binding yet → the
    // first prompt's body becomes the binding and is frozen from now on.
    const clientTurnId=req.headers?.["x-teleharness-turn-id"];
    const record = await sessionRecord(id, Boolean(clientTurnId) && Number.isFinite(turnIdsFrom));
    if (clientTurnId && !record && Number.isFinite(turnIdsFrom))
      return sendJson(res,503,{error:"Не удалось проверить принадлежность хода к чату"});
    if (clientTurnId && !Number.isFinite(turnIdsFrom))
      return sendJson(res,409,{error:"Режим повторной отправки хода отключён"});
    const inboxId=stableTurnIds(record) && typeof clientTurnId==="string" && /^[a-f0-9]{32}$/.test(clientTurnId)
      ? "msg_19f5"+createHash("sha256").update(JSON.stringify([id,user.id,clientTurnId])).digest("hex").slice(0,28) : null;
    let binding = bindingFor(id, record);
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
    if (inboxId && (isRunnerEngine(binding?.engine) || !Array.isArray(parsed?.parts) ||
        parsed.parts.some(part => part?.type !== "text" || typeof part.text !== "string" || part.text.trimStart().startsWith("/"))))
      return sendJson(res,409,{error:"Этот режим повтора доступен для текстового хода OpenCode"});
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
      if (!agent) agent = defaultTenantAgent(agents, config.TELEHARNESS_TENANT_AGENT);
      // 2026-11-05: a chat bound to an agent tenants no longer get (multimodal-looker
      // before subagents were hidden) continues on the tenant default instead of a 403.
      if (agent && !agentAllowedForTenant(agent, agents) && boundAgent === agent) agent = defaultTenantAgent(agents, config.TELEHARNESS_TENANT_AGENT);
      if (!agent || !agentAllowedForTenant(agent, agents)) return sendJson(res, 403, { error: "agent not allowed" });
      if (binding) binding = { ...binding, agent };
      else if (parsed) parsed = { ...parsed, agent };
    } else if (binding?.engine === "opencode" && binding.agent) {
      // FEAT-16.2: an admin chat on an agent gone from the catalog (OmO → slim)
      // continues on the opencode default agent; the binding follows (saved below).
      const agent = adminAgentFor(binding.agent, await agentList(), await upstreamDefaultAgent());
      if (agent !== binding.agent) binding = { ...binding, agent };
    }
    // FEAT-20.7: чат с включённой «Отдельной рабочей копией» — копия создаётся
    // первым сообщением (ход ждёт создания, кр. 2); сбой — ход не начинается,
    // сообщение остаётся в композере (клиент получает kind).
    let wtDir = null;
    if (worktrees.pendingOf(id) || worktrees.forChat(id)) {
      try {
        const firstText = Array.isArray(parsed?.parts) ? parsed.parts.filter((x) => x?.type === "text" && !x.synthetic).map((x) => x.text).join(" ") : "";
        const it = await worktrees.ensureForTurn({ sid: id, text: firstText, chatFolder: admin ? null : chatFolderFor(dir, id) });
        wtDir = it?.path ?? null;
      } catch (err) {
        if (err instanceof GitError) return sendJson(res, err.status, { error: err.message, ...(err.extra ?? {}), worktree: true });
        errLog("worktree.create", err);
        return sendJson(res, 500, { error: "Не удалось создать рабочую копию", kind: "create-failed", worktree: true });
      }
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
      const race = await markPrompted(id, binding); // BUG-218: под локом чата
      if (race) return sendJson(res, 409, { error: race });
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
      // tasks 3.8 (BUG-188 на v2): v2-тело команды {name, text} не принимает
      // agent/model — привязка чата ставится на сессию той же per-session
      // очередью «модель → ход», что у обычного v2-хода (3.5). v1 — тело из
      // commandBody, синхронный upstream-ход (BUG-183): без await в обоих
      // режимах клиент получает 204 сразу.
      if (OC.api === "v2") {
        fireCommandTurnV2({ id, dir, name: slash.name, text: slash.arguments, agent: binding.agent ?? null, model: binding.model, permMode: binding.permMode ?? null });
      } else {
        fireCommandTurn({ id, dir, query: upQ, name: slash.name, body: commandBody({ command: slash.name, arguments: slash.arguments, agent: binding.agent ?? null, model: binding.model, variantSetting: config.TELEHARNESS_GLM_VARIANT }) });
      }
      res.writeHead(204); // the same face a prompt shows the client
      res.end();
      return;
    }
    // Non-image file parts are written to <session dir>/.teleharness-uploads/ and
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
        const race = await markPrompted(id, binding); // BUG-218: под локом чата
        if (race) return sendJson(res, 409, { error: race });
        const turn = applyBinding(relays.has(id) ? await withRelayCatchUp(id, dir, mat, binding) : mat, binding);
        if (vision) turn.model = { providerID: vision.providerID, modelID: vision.modelID };
        out = Buffer.from(JSON.stringify(turn), "utf8");
      }
    }
    // FEAT-13.9: the CLI permission profile follows the caller's role.
    // FEAT-13.17: the agent comes from the binding only (admin chats).
    const planTurn = notePlanTurn(id, binding, user, req);
    if (isRunnerEngine(binding?.engine))
      return claude.dispatch({
        res, sid: id, dir, body: Buffer.isBuffer(out) ? out : Buffer.from(String(out)),
        access: admin ? "admin" : "tenant", acpOwner: engineAllowed(user, "acp") ? acpAuthOwner(user) : null,
        agent: admin ? binding.agent ?? null : null,
        // FEAT-13.11: admin → TELEHARNESS_KB_ROOT; tenant → only its own zone.
        kbZone: kbZoneForUser(user, { admin, adminRoot: config.TELEHARNESS_KB_ROOT, tenantVault: config.TELEHARNESS_TENANT_VAULT, home: admin ? HOME_DIR : null }),
        // FEAT-04.11: the tenant's AppContainer for its Bash (chat folder inside its home)
        jail: admin ? null : tenantJailFor(dir, config.TELEHARNESS_TENANT_HOME),
        // FEAT-03.22: the user's own system prompt (added to the built-in one).
        systemPrompt: getSystemPrompt(user.id),
        // FEAT-11.18: где лежит журнал этого чата (если он уже есть)
        portalNote: [journalRule(journal.fileOf(id, kbZoneOfDir(dir)?.root ?? null)), relayRule(relays.get(id), journal.fileOf(id, kbZoneOfDir(dir)?.root ?? null)), worktreeNote(id)].filter(Boolean).join("\n\n"),
        // FEAT-04.12 stage B: a tenant chat with its own subfolder runs the CLI there.
        // FEAT-20.7: чат с рабочей копией — CLI в копии; Codex пишет в общий .git.
        workDir: wtDir ?? (admin ? null : existingChatFolder(dir, id)),
        writableRoots: wtDir ? [worktrees.forChat(id)?.commonDir].filter(Boolean) : null,
        // FEAT-18.4: the chat's permission mode (null = the role default, as before).
        // FEAT-20.1: «Сначала план» — ход без одобренного плана идёт в режиме plan (только чтение).
        permMode: planTurn ? "plan" : cleanPermMode(binding.permMode) ? effectivePermMode(binding, { admin }) : null,
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
    // BUG-180: a GLM-5.3 turn without a variant runs on TELEHARNESS_GLM_VARIANT (default max).
    if (OC.api === "v2") {
      // FEAT-16.3 (tasks 3.5): модель/агент/вариант в v2 — состояние сессии
      // (POST /model, /agent ПЕРЕД ходом), system — плагин-мост (4.4, пока
      // не едет). Очередь на сессию: смена модели чужого хода не перетирается
      // параллельным ходом/replay (design §116).
      let turn = null;
      try {
        turn = JSON.parse((Buffer.isBuffer(out) ? out : Buffer.from(String(out))).toString("utf8"));
      } catch {}
      // BUG-209: свой системный промпт (FEAT-03.22) — в metadata.system хода (плагин-мост
      // plugin-v2: prompt-хук → context на каждом шаге хода); напоминание — synthetic-частью
      // (адаптер → metadata.teleharnessHidden, BUG-193). Раньше в v2 не ехал вовсе.
      if (turn && typeof turn === "object" && !Array.isArray(turn)) turn = withUserSystem(turn, getSystemPrompt(user.id), { admin, portal: portalRulesFor(id, dir) }); // FEAT-05.29, FEAT-11.18
      const sysMeta = typeof turn?.system === "string" && turn.system ? { system: turn.system } : null;
      const model = cleanModel(turn?.model);
      const agent = typeof turn?.agent === "string" && turn.agent ? turn.agent : null;
      // BUG-180 в языке v2: вариант едет в POST /model (design §115), а не в
      // тело хода — тот же withGlmVariant, только к паре модель+вариант.
      const variant = turn?.variant ?? (model ? withGlmVariant({ model }, config.TELEHARNESS_GLM_VARIANT).variant ?? null : null);
      const parts = Array.isArray(turn?.parts) ? turn.parts : [{ type: "text", text: String(out) }];
      try {
        await OC.enqueueTurn(id, async () => {
          if (inboxId) {
            const current=getUser(user.id);
            if (!current || current.disabled || !dirAllowed(current,dir) || !engineAllowed(current,"opencode") ||
                await chatRouting.checkTurn(current.id,id)) {
              const error=new Error("Доступ к ходу отозван");
              error.status=403;
              throw error;
            }
          }
          if (model) {
            await OC.setSessionModel(id, { model: { providerID: model.providerID, modelID: model.modelID, ...(variant ? { variant } : {}) }, timeoutMs: DEFAULT_OPTS.timeoutMs });
          }
          if (agent) await OC.setSessionAgent(id, { agent, timeoutMs: DEFAULT_OPTS.timeoutMs });
          if (planTurn && admin) {
            await applyOcRules(id, dir, OC_PLAN_RULES); // FEAT-20.1: план-ход — правки запрещены
            ocPlanRulesOn.add(id);
          } else if (admin && ocPlanRulesOn.delete(id)) await applyOcRules(id, dir, ocPermRules(binding?.permMode) ?? []); // снять правила плана
          else await applyOcPermMode(id, dir, admin ? binding?.permMode : null);
          await OC.prompt({ directory: (admin ? wtDir : null) ?? dir ?? null, sessionID: id, ...(inboxId ? {id:inboxId} : {}), parts, ...(sysMeta ? { metadata: sysMeta } : {}), timeoutMs: PROMPT_OPTS.timeoutMs });
          if (stableTurnIds(record)) recovery.accepted(id,user.id);
        });
        res.writeHead(204); // тот же ход, что v1 показывал после приёма prompt_async
        res.end();
      } catch (err) {
        return ocUpstreamError(res, err, "prompt");
      }
      return;
    }
    out = withUserSystemBody(out, getSystemPrompt(user.id), admin, portalRulesFor(id, dir)); // FEAT-05.29, FEAT-11.18
    out = withGlmVariantBody(out, config.TELEHARNESS_GLM_VARIANT);
    return proxyRequest(req, res, withDir(`/session/${id}/prompt_async`, upQ), { ...PROMPT_OPTS, body: Buffer.isBuffer(out) ? out : Buffer.from(String(out)) });
  }
  if (action === "abort" && req.method === "POST") {
    attentionObserver.noteUserStop(id); // FEAT-20.2: «Стоп» человека — не «упало»
    const finish = new URLSearchParams(q).get("finish") === "1";
    if (finish ? claude.finishHungAcp(id) : claude.abort(id)) return sendJson(res, 200, { ok: true });
    if (OC.api === "v2") {
      try {
        await OC.abort(id, { directory: (admin ? null : tenantDir) ?? null }); // №8: POST /interrupt
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return ocUpstreamError(res, err, "abort");
      }
    }
    return proxyRequest(req, res, withDir(`/session/${id}/abort`, admin ? q : upQ), DEFAULT_OPTS);
  }
  return sendJson(res, 405, { error: "method not allowed" });
}

// BUG-188: the upstream POST /session/:id/command run of a slash command,
// fire-and-forget. The client already got 204; a failure (network, 4xx/5xx —
// opencode answers 400 on an unknown command and 404 on an unknown session)
// is logged and announced to the chat via teleharness.notice, the way other turn
// problems reach the user (claudeAgentGone). The same long deadline as
// prompt_async: a command turn runs a full agent turn upstream.
const COMMAND_TURN_BACKSTOP_MS = 6 * 3600_000;
function fireCommandTurn({ id, dir, query, name, body }) {
  void (async () => {
    try {
      // NOT the prompt deadline: /command holds the request for the WHOLE turn, and
      // in opencode 1.19.5 an aborted request is a ClientAbort that interrupts the
      // turn's fiber (BUG-183 mechanism). Only a backstop far beyond any real turn;
      // «Стоп» goes through /abort as for any turn. v1-only: v2 идёт через
      // fireCommandTurnV2 (ход команды v2 асинхронный — api-map «Команды»).
      const out = await OC.runCommand(id, { directory: dir ?? undefined, body, timeoutMs: COMMAND_TURN_BACKSTOP_MS });
      if (out.status >= 400) {
        const detail = String(out.text ?? "").slice(0, 300);
        errLog("commandTurn", new Error(`upstream ${out.status} for /${name} in ${id}: ${detail}`));
        hub.emit({ type: "teleharness.notice", properties: { sessionID: id, text: `Команда «/${name}» не выполнена (upstream ${out.status}).` } }, dir ?? null);
        return;
      }
    } catch (err) {
      errLog("commandTurn", err);
      hub.emit({ type: "teleharness.notice", properties: { sessionID: id, text: `Команда «/${name}» не отправлена: ${err?.cause?.code || err?.name || "ошибка сети"}.` } }, dir ?? null);
    }
  })();
}

// tasks 3.8 (BUG-188 на v2): the same fire-and-forget face over v2
// POST /api/session/:id/command {name, text} — v2 answers 204 immediately and
// runs the turn in background (api-map «Команды»), so the backstop only caps a
// stuck call. The v2 command body has NO agent/model: the chat binding lands
// on the session first (POST /model, /agent — with the variant rule of a v2
// prompt, BUG-180) under the SAME per-session queue «модель → ход» as a v2
// prompt (3.5, design §116) — a parallel prompt/replay can't interleave and
// switch the model under the command turn. A failure (upstream 4xx/5xx,
// transport) is logged and announced via teleharness.notice, like v1.
// FEAT-18.4 (design §2): the chat's permission mode → opencode 2.x session
// rules before the turn (admin chats; null = no override). An upstream that
// refuses them must not cost the turn: a notice, the turn goes on with the
// server rules.
async function applyOcPermMode(id, dir, permMode) {
  const rules = ocPermRules(permMode);
  if (!rules) return;
  return applyOcRules(id, dir, rules);
}
async function applyOcRules(id, dir, rules) {
  try {
    await OC.patchSession(id, { directory: dir ?? undefined, permissions: rules, timeoutMs: DEFAULT_OPTS.timeoutMs });
  } catch (err) {
    errLog("permMode.opencode", err);
    hub.emit({ type: "teleharness.notice", properties: { sessionID: id, text: "Режим прав не применён: движок opencode его не принял — ход идёт с правами сервера." } }, dir ?? null);
  }
}

function fireCommandTurnV2({ id, dir, name, text, agent, model, permMode = null }) {
  void (async () => {
    try {
      await OC.enqueueTurn(id, async () => {
        const m = cleanModel(model);
        const variant = m ? withGlmVariant({ model: m }, config.TELEHARNESS_GLM_VARIANT).variant ?? null : null;
        if (m) {
          await OC.setSessionModel(id, { model: { providerID: m.providerID, modelID: m.modelID, ...(variant ? { variant } : {}) }, timeoutMs: DEFAULT_OPTS.timeoutMs });
        }
        if (agent) await OC.setSessionAgent(id, { agent, timeoutMs: DEFAULT_OPTS.timeoutMs });
        await applyOcPermMode(id, dir, permMode); // admin only: slash commands never expand for tenants
        const out = await OC.runCommand(id, { directory: dir ?? undefined, body: { name, text }, timeoutMs: COMMAND_TURN_BACKSTOP_MS });
        if (out.status >= 400) {
          const detail = String(out.text ?? "").slice(0, 300);
          errLog("commandTurn", new Error(`upstream ${out.status} for /${name} in ${id}: ${detail}`));
          hub.emit({ type: "teleharness.notice", properties: { sessionID: id, text: `Команда «/${name}» не выполнена (upstream ${out.status}).` } }, dir ?? null);
        }
      });
    } catch (err) {
      errLog("commandTurn", err);
      hub.emit({ type: "teleharness.notice", properties: { sessionID: id, text: `Команда «/${name}» не отправлена: ${err?.cause?.code || err?.name || "ошибка сети"}.` } }, dir ?? null);
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
    const cfg = await OC.configGet({ directory: dir ?? undefined, timeoutMs: 10_000 }); // v2: snapshots:false в слоях конфига (Э1)
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
  return ocWholeMessages(id, dir); // v2: курсорные страницы до конца (tasks 3.4)
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
    const diff = await OC.sessionDiff(id, { directory: dir ?? undefined, messageID, timeoutMs: DEFAULT_OPTS.timeoutMs }); // v2: ?from= (№10)
    for (const d of Array.isArray(diff) ? diff : []) {
      const p = typeof d?.file === "string" ? d.file : typeof d?.path === "string" ? d.path : null;
      if (p) files.set(p.toLowerCase(), { path: p, action: d.status === "added" ? "delete" : "restore" });
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
    return (await OC.getSession(id, { directory: dir ?? undefined, timeoutMs: DEFAULT_OPTS.timeoutMs })) ?? null;
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
  const isClaude = relays.has(id) ? isRunnerEngine(engineOfChat(id, binding)) : isRunnerEngine(binding?.engine) || claude.has(id);
  // Scope: the prompt's rules (tenant → its own folders, engine grant).
  const dir = isClaude ? claude.dirOf(id) ?? (await resolveSessionDir(id)) : await resolveSessionDir(id);
  if (dir == null && !isClaude) return sendJson(res, 404, { error: "session not found" });
  if (!admin) {
    if (dir == null) return sendJson(res, 404, { error: "session not found" });
    if (!dirAllowed(user, dir)) return sendJson(res, 403, { error: "outside your scope" });
  }
  if (!engineAllowed(user, isClaude ? (binding?.engine ?? "claude") : "opencode")) return sendJson(res, 403, { error: "engine not allowed" });
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
  // BUG-218 (SRV-07, design §1): «ход не идёт» и флаг «идёт откат» ставятся
  // под блокировкой чата; флаг снимается в finally, старт хода видит его и
  // отвечает 409 (см. sessionActionRoute). Окно подготовки (история, план)
  // пере-проверяется занятостью непосредственно перед изменениями файлов.
  const gate = await withSessionLock(id, () => {
    if (liveSessionIds().has(id)) return { status: 409, error: "turn in progress" };
    markReverting(id);
    return null;
  });
  if (gate) return sendJson(res, gate.status, { error: gate.error });
  try {
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
        // BUG-218: повторная проверка занятости непосредственно перед изменениями —
        // ход, стартовавший в окне подготовки, откат не получает
        if (liveSessionIds().has(id)) return sendJson(res, 409, { error: "turn in progress" });
        try {
          await OC.unrevert(id, { directory: dir, timeoutMs: PROMPT_OPTS.timeoutMs }); // v2: DELETE /api/session/:id/revert (№12)
        } catch (err) {
          return ocUpstreamError(res, err, "session.unrevert");
        }
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
      // BUG-218: повторная проверка занятости непосредственно перед откатом
      // файлов (ocUndo.revert ниже) — окно подготовки закрыто 409-ом
      if (liveSessionIds().has(id)) return sendJson(res, 409, { error: "turn in progress" });
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
        if (OC.api === "v2") {
          // №11: двухфазный revert (stage → commit); превью портала — ответ stage
          await OC.revert(id, { directory: dir, messageID, timeoutMs: PROMPT_OPTS.timeoutMs });
          r = { ok: true };
        } else {
          r = await fetch(`${UPSTREAM}${withDir(`/session/${id}/revert`, upQ)}`, {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({ messageID }),
            signal: AbortSignal.timeout(PROMPT_OPTS.timeoutMs),
          });
          await r.text().catch(() => "");
        }
      } catch (err) {
        // определённый отказ upstream (4xx/5xx) — как !r.ok ниже; сеть — наверх
        if (OC.api === "v2" && (err?.status ?? 0) >= 400) {
          r = { ok: false, status: err.status };
        } else {
          r = null;
          if (undone) ocUndo.unrevert(id, messageID); // the turn stays: so do its files
          throw err;
        }
      }
      if (r && !r.ok) {
        if (undone) ocUndo.unrevert(id, messageID);
        return sendJson(res, (r.status ?? 502) >= 500 ? 502 : r.status ?? 502, { error: "upstream error" });
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
  } finally {
    clearReverting(id); // BUG-218: конец отката (успех или отказ) — флаг снят
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
      titler.userRenamed(id, body.title.trim(), { claudeChat: isRunnerEngine(bindingFor(id, await sessionRecord(id))?.engine) });
    // A claude-only chat unknown upstream: the claude store is its home.
    if (claude.titleInfo(id) && typeof body?.title === "string" && !(await resolveSessionDir(id))) return sendJson(res, 200, { id, title: body.title.trim() });
    if (OC.api === "v2") {
      // №4: PATCH отвечает 204 — подтверждение повторным GET, лицо прежнее
      try {
        const updated = await OC.patchSession(id, {
          directory: (admin ? null : scopeDir) ?? undefined,
          ...(typeof body?.title === "string" ? { title: body.title } : {}),
          ...(body && typeof body === "object" && Array.isArray(body?.parts) ? { parts: body.parts } : {}),
          timeoutMs: DEFAULT_OPTS.timeoutMs,
        });
        return sendJson(res, 200, updated ?? { id, title: body?.title ?? null });
      } catch (err) {
        return ocUpstreamError(res, err, "session.patch");
      }
    }
    return proxyRequest(req, res, withDir(`/session/${id}`, upQ), { ...DEFAULT_OPTS, body: raw });
  }
  // DELETE: local data (binding, claude history, live claude run) dies only
  // after the upstream confirmed the delete with a 2xx — a 5xx leaves the
  // session intact everywhere. A claude-only chat unknown upstream (404)
  // is still forgotten locally.
  // FEAT-20.7: чат с рабочей копией — копия убирается ДО удаления чата и без
  // потери работы: ?worktree=auto|keep-branch|all (по умолчанию keep-branch:
  // незакоммиченное коммитится в ветку, ветка остаётся), all — только с confirm=1.
  const wtItem = worktrees.forChat(id);
  if (wtItem) {
    const mode = ["auto", "keep-branch", "all"].includes(url.searchParams.get("worktree")) ? url.searchParams.get("worktree") : "keep-branch";
    try {
      await worktrees.remove(wtItem, { mode, confirm: url.searchParams.get("confirm") === "1" });
    } catch (err) {
      if (err instanceof GitError) return sendJson(res, err.status, { error: err.message, ...(err.extra ?? {}), worktree: true });
      return internalError(res, err, "session.delete.worktree");
    }
  }
  worktrees.cancelPending(id);
  // BUG-210: папка чата — ДО удаления (после него upstream сессию уже не знает)
  const preDir = admin ? await resolveSessionDir(id).catch(() => null) : scopeDir;
  try {
    let status = 0;
    let text = "";
    let faceType = "application/json";
    if (OC.api === "v2") {
      try {
        await OC.deleteSession(id, { directory: (admin ? null : scopeDir) ?? undefined, timeoutMs: DEFAULT_OPTS.timeoutMs }); // №5: 204, дочерние вместе
        status = 200;
      } catch (err) {
        status = err?.status ?? 0;
        text = JSON.stringify(err?.body ?? { error: `upstream: ${status}` });
        if (status === 0) return upstreamError(res, err, "session.delete");
      }
    } else {
      const r = await fetch(`${UPSTREAM}${withDir(`/session/${id}`, upQ)}`, {
        method: "DELETE",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(DEFAULT_OPTS.timeoutMs),
      });
      status = r.status;
      faceType = r.headers.get("content-type") ?? "application/json";
      text = await r.text();
    }
    const localOnly = status === 404 && (claude.has(id) || bindings.get(id));
    if (status >= 200 && status < 300 || localOnly) {
      claude.forget(id);
      ocUndo.forget(id); // BUG-146: the opencode turn backups go with the chat
      bindings.forget(id);
      titler.forget(id);
      dropPinEverywhere(id); // FEAT-01.69: the chat leaves every user's pins
      attention.forgetKey(`chat:${id}`, { sid: id }); // FEAT-20.2
      reviews.chatDeleted(id); // FEAT-20.1
      chatSearch?.forget(id); // FEAT-01.60
      // BUG-186 / BUG-07.23: the hub learns about deletes only from upstream's
      // session.deleted on /event — which never arrives when the chat's folder
      // has no hub subscription (probe/temp dirs): prod 2026-11-07 kept a
      // deleted chat «busy» in /status and healthz for 4 hours, and every
      // deploy waited for a quiet window that never came. The portal KNOWS
      // the delete succeeded — tell the hub the same way gcSweep does, so the
      // exact session.deleted cleanup runs (busy, dialogs, pending, clients).
      const delDir = (admin ? await resolveSessionDir(id) : scopeDir) ?? preDir;
      dropJournal(id, delDir ?? null); // FEAT-11.18: журнал чата уходит вместе с чатом
      hub.emit({ type: "session.deleted", properties: { sessionID: id, info: { id, directory: delDir ?? null } } }, delDir ?? null);
      // BUG-210: последний чат папки удалён — освобождаем экземпляр opencode этой папки
      // (иначе он держит её открытой: удаление папки чата — EPERM; память — BUG-195).
      fetchSessionIndex(true)
        .then(async () => {
          const n = normDir(delDir);
          if (!n || [...sessionIndex.recById.values()].some((r) => normDir(r?.directory) === n)) return;
          if (await disposeInstance(delDir)) instanceHealth.forget(delDir);
        })
        .catch(() => {});
    }
    if (localOnly) return sendJson(res, 200, true);
    if (OC.api === "v2") {
      // v2: мутация отвечала 204 без тела — лицо успеха, как у v1 (true);
      // отказ — тело {_tag} от адаптера.
      if (status >= 400) {
        let face = null;
        try {
          face = JSON.parse(text);
        } catch {}
        return sendJson(res, status, face && typeof face === "object" ? face : { error: `upstream: ${status}` });
      }
      return sendJson(res, 200, true);
    }
    res.writeHead(status, { "content-type": faceType });
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

const sessionListCache = createListCache({ staleMs: config.TELEHARNESS_LIST_STALE_MS }); // BUG-260

// FEAT-01.60: серверный полнотекстовый поиск по вопросам и ответам доступных пользователю чатов.
async function sessionSearchRoute({ req, res, url, user, admin }) {
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Number(url.searchParams.get("limit")) || 30;
  if (!q) return sendJson(res, 200, { query: "", hits: [], indexing: chatSearch.status() });
  try {
    let list = [];
    try {
      const key = OC.api === "v2" ? "v2:" : "v1:";
      ({ value: list } = await sessionListCache.get(key, async () => {
        if (OC.api === "v2") {
          const l = await OC.listSessions({}, { timeoutMs: DEFAULT_OPTS.timeoutMs });
          return Array.isArray(l) ? l : [];
        }
        const r = await fetch(`${UPSTREAM}/session`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(DEFAULT_OPTS.timeoutMs),
        });
        if (!r.ok) return [];
        const j = await r.json();
        return Array.isArray(j) ? j : [];
      }));
    } catch {
      if (sessionIndex.recById?.size) list = [...sessionIndex.recById.values()];
    }
    const allowedList = (admin ? list : list.filter((s) => dirAllowed(user, s?.directory))).filter((s) => s?.id && !isTempSessionDir(s?.directory));
    const allowedIds = new Set(allowedList.map((s) => s.id));
    // Локальные чаты раннера (если upstream временно не ответил) тоже проверяются через dirAllowed.
    const claudeSnap = claude.storeSnapshot?.() ?? {};
    for (const [sid, entry] of Object.entries(claudeSnap)) {
      if (allowedIds.has(sid)) continue;
      const dir = entry?.directory ?? null;
      if (isTempSessionDir(dir)) continue;
      if (admin || (dir && dirAllowed(user, dir))) allowedIds.add(sid);
    }
    await chatSearch.ensureFresh(allowedList, { budget: 15, timeoutMs: 2500 });
    if (!chatSearch.status().ready && !process.env.TELEHARNESS_SEARCH_NO_BG) void chatSearch.start();
    const out = chatSearch.search(q, { allowedIds, limit });
    return sendJson(res, 200, out);
  } catch (err) {
    return upstreamError(res, err, "session.search");
  }
}

// GET: admins stream the full upstream list; tenants get the
// SERVER-filtered list. Every record carries the chat binding under `teleharness`.
async function sessionListRoute({ req, res, url, user, admin, match }) {
  const p = url.pathname;
  const q = url.search;
  // BUG-260: одинаковые одновременные чтения — один поход в движок; при его
  // сбое — последний удачный список (≤ 2 мин) вместо 502. Ключ — upstream-запрос
  // (фильтр тенанта применяется ниже к каждому ответу, кэш общий и сырой).
  const dirHint = OC.api === "v2" && admin ? url.searchParams.get("directory") : null;
  const key = OC.api === "v2" ? `v2:${dirHint ?? ""}` : `v1:${admin ? q : ""}`;
  try {
    let list;
    try {
      ({ value: list } = await sessionListCache.get(key, async () => {
        if (OC.api === "v2") {
          // №1: /api/session фильтруется обычным ?directory=; админ-хвосты прочих
          // query-параметров v1 не переносятся (их у списка нет) (tasks 3.2)
          const l = await OC.listSessions(dirHint ? { directory: dirHint } : {}, { timeoutMs: DEFAULT_OPTS.timeoutMs });
          if (!Array.isArray(l)) throw Object.assign(new Error("upstream: bad list"), { listError: "upstream: bad list" });
          return l;
        }
        const r = await fetch(`${UPSTREAM}${admin ? withQuery("/session", q) : "/session"}`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(DEFAULT_OPTS.timeoutMs),
        });
        if (!r.ok) throw Object.assign(new Error(`upstream: ${r.status}`), { listError: `upstream: ${r.status}` });
        return r.json();
      }));
    } catch (err) {
      // BUG-264 п.10: движок перезапускается (выкат) — общий список без фильтра папки
      // берётся из индекса чатов сервера (тот же /api/session, обновляется постоянно).
      const idxAge = Date.now() - sessionIndex.at;
      if (key === "v2:" && sessionIndex.at > 0 && idxAge <= config.TELEHARNESS_LIST_INDEX_STALE_MS && sessionIndex.recById?.size) {
        list = [...sessionIndex.recById.values()];
      } else {
        if (err?.listError) return sendJson(res, 502, { error: err.listError });
        throw err;
      }
    }
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
  const enrollmentProblem=chatRouting.checkCreate();
  if (enrollmentProblem) return sendJson(res,503,enrollmentProblem);
  // BUG-262: папку задаёт только проверенный ?directory= (dirAllowed, абсолютный путь);
  // directory/location из тела отбрасываются — иначе они перекрывали проверенную папку.
  const { model: wantModel, agent: wantAgent, directory: _bodyDir, location: _bodyLoc, ...upBody } = body && typeof body === "object" && !Array.isArray(body) ? body : {};
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
      const def = defaultTenantAgent(agents, config.TELEHARNESS_TENANT_AGENT);
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
    let created = null;
    if (OC.api === "v2") {
      // №2: папка — в теле location:{directory}; запись в языке 1.x (tasks 3.2)
      try {
        created = await OC.createSession({ directory: dir, ...upBody, timeoutMs: DEFAULT_OPTS.timeoutMs });
      } catch (err) {
        if ((err?.status ?? 0) >= 400) {
          const face = err.body && typeof err.body === "object" ? err.body : { error: `upstream: ${err.status}` };
          return sendJson(res, err.status, face);
        }
        return upstreamError(res, err, "session.create");
      }
    } else {
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
      try {
        created = JSON.parse(text);
      } catch {}
    }
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
    if (!isRunnerEngine(want?.engine) && created?.directory) instanceHealth.warm(created.directory);
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
  // FEAT-18.4: a request of the Claude permission bridge — answered into the
  // live CLI (control_response). Tenants: only a dialog of their own folder;
  // the tenant CLI stays --restricted + jail, so «Разрешить» adds no right.
  const bridged = m[1] === "permission" ? claude.dialogOf(m[2]) : null;
  if (bridged) {
    if (!admin && !dirAllowed(user, bridged.dir)) {
      req.resume();
      return sendJson(res, 404, { error: "dialog not found" });
    }
    const raw = await readBody(req, DEFAULT_OPTS.bodyLimit);
    if (raw === null) return sendJson(res, 413, { error: "body too large" });
    let body = null;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {}
    if (!["once", "always", "reject"].includes(body?.reply)) return sendJson(res, 400, { error: "bad reply" });
    if (!claude.replyDialog(m[2], { reply: body.reply, message: typeof body?.message === "string" ? body.message : null })) return sendJson(res, 410, { error: "dialog is gone" });
    return sendJson(res, 200, { ok: true });
  }
  if (OC.api === "v2") {
    // v2: ответpermission — {decision} на /api/session/:sid/permission/:rid/reply,
    // ответ формы — {answer:{...}} (Э5). Адрес диалога — из открытых диалогов хаба
    // (для админа тоже: ?directory клиента не доверенный якорь).
    // BUG-260: ?directory= клиента — только подсказка, где искать (без веера по всем папкам)
    const open = (await hub.collectDialogs({ alsoDirs: [url.searchParams.get("directory")] })).find((e) => e?.id === m[2] && (admin || dirAllowed(user, e.directory ?? e.dir)));
    if (!open) {
      req.resume();
      return sendJson(res, 404, { error: "dialog not found" });
    }
    const raw = await readBody(req, DEFAULT_OPTS.bodyLimit);
    if (raw === null) return sendJson(res, 413, { error: "body too large" });
    let body = null;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {}
    if (!admin && m[1] === "permission" && tenantMustReject(open)) {
      if (body?.reply !== "reject") return sendJson(res, 403, { error: "permission not allowed for tenants" });
    }
    const dir = open.directory ?? open.dir ?? undefined;
    try {
      if (m[1] === "permission") {
        await OC.replyPermission({ directory: dir, sessionID: open.sessionID, requestID: m[2], reply: body?.reply, message: body?.message, timeoutMs: DEFAULT_OPTS.timeoutMs });
      } else if (body?.answers && typeof body.answers === "object") {
        // BUG-204: клиент шлёт answers string[][] (1.x) — адаптер раскладывает по полям формы; объект — как есть
        await OC.replyQuestion({ directory: dir, sessionID: open.sessionID, formID: m[2], ...(Array.isArray(body.answers) ? { answers: body.answers } : { answer: body.answers }), timeoutMs: DEFAULT_OPTS.timeoutMs });
      } else {
        await OC.rejectQuestion({ directory: dir, sessionID: open.sessionID, formID: m[2], message: body?.message, timeoutMs: DEFAULT_OPTS.timeoutMs });
      }
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return ocUpstreamError(res, err, `dialog.${m[1]}`);
    }
  }
  if (admin) return proxyRequest(req, res, withDir(`/${m[1]}/${m[2]}/reply`, q), DEFAULT_OPTS);
  const open = (await hub.collectDialogs()).find((e) => e?.id === m[2] && dirAllowed(user, e.directory ?? e.dir));
  if (!open) {
    req.resume();
    return sendJson(res, 404, { error: "dialog not found" });
  }
  const raw = await readBody(req, DEFAULT_OPTS.bodyLimit);
  if (raw === null) return sendJson(res, 413, { error: "body too large" });
  if (m[1] === "permission" && tenantMustReject(open)) {
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
  hub.handleClient(req, res, admin ? { userId: user.id } : { visible: (dir) => dirAllowed(user, dir), transform: tenantEvent, userId: user.id }); // BUG-197: белый список типов + редакция tool-частей; FEAT-20.2: личные события
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
  // BUG-276: рабочие копии аккаунта — из реестра (до удаления папок: git ещё видит репозитории)
  try {
    const wts = await worktrees.dropOwner(uid);
    if (wts.length) console.log(`[teleharness-auth] account ${uid}: ${wts.length} worktree(s) removed`);
  } catch (err) {
    errLog("account.worktrees", err);
    warnings.push({ kind: "worktrees", reason: "рабочие копии учётной записи не убраны — уберёт уборка" });
  }

  const out = deleteUser(uid);
  webPush?.store.dropUser(uid); // FEAT-07.20: a deleted account's devices get nothing more
  attention.dropUser(uid); // FEAT-20.2: отметки доски удалённого аккаунта
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
    console.error(`[teleharness-err] account ${uid} deleted, folder left behind: ${f.path} — ${f.reason}; retried by the gc sweep`);
    warnings.push({ kind: "folder", path: f.path, reason: f.reason, retry: true });
  }
  console.log(`[teleharness-auth] account ${uid} deleted: ${removedSessions} chat(s), ${removed.length} folder(s) removed, ${failed.length} left`);
  return { ok: true, removedSessions, removedDirs: removed.length, warnings };
}

// ---- gc sweep (BUG-01.48 / BUG-078, BUG-04.6) -------------------------------------
let gcRunning = false;
let lastGc = null;

async function countUpstreamMessages(id, dir) {
  // BUG-212: via the oc-client adapter (v1/v2 + auth), not a direct 1.x-path
  // fetch — on v2 that path 404s, every chat looked "unknown" and stayed.
  try {
    const { messages } = await OC.listMessages(id, { directory: dir ?? undefined, limit: 1 });
    return messages.length;
  } catch {
    return null;
  }
}

function liveSessionIds() {
  return new Set([...Object.keys(hub.busySnapshot()), ...Object.keys(hub.stalledSnapshot()), ...Object.keys(claude.busySnapshot())]);
}

// Single source of the empty-chat rule inputs (threshold TELEHARNESS_GC_EMPTY_MIN,
// protected busy/dialog/claude sets, message-count confirm) — shared by the
// dry-run GET /admin/gc report and the APPLY sweep, so they never disagree.
function emptyChatGcInput(sessions) {
  return {
    sessions,
    minAgeMs: config.TELEHARNESS_GC_EMPTY_MIN * 60_000,
    busy: liveSessionIds(),
    dialogs: hub.dialogSessions(),
    claude: new Set(sessions.map((s) => s.id).filter((id) => claude.has(id) || claude.titleInfo(id))),
    countMessages: countUpstreamMessages,
    isBusy: (id) => liveSessionIds().has(id) || hub.dialogSessions().has(id),
  };
}

async function gcSweep() {
  if (!config.TELEHARNESS_GC_ENABLED) return { disabled: true };
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
      out.turnUndo = sweepTurnUndo({ root: config.TELEHARNESS_TURN_UNDO_ROOT, keep, log: (m) => console.log(m) }).removed.length;
    }
    if (sessionIndex.at !== 0) {
      out.ownerless = await sweepOwnerlessTenantDirs(ownerlessTenantDirs([...sessionIndex.recById.values()]), {
        beforeRemove: (p) => disposeInstance(p),
        log: (m) => console.log(m),
      });
    }
    const minAgeMs = config.TELEHARNESS_GC_EMPTY_MIN * 60_000;
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
    // FEAT-20.7: копии удалённых чатов и устаревшие копии запусков — работа в ветку, папка убирается
    if (sessionIndex.at >= indexAsked) {
      try {
        const g = await worktrees.gc({ isLive: (x) => (x.kind === "run" ? true : Boolean(x.sid && (sessionIndex.recById.has(x.sid) || claude.has(x.sid)))) });
        out.worktrees = { saved: g.saved.length, pruned: g.pruned.length };
      } catch (err) {
        errLog("gc.worktrees", err);
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

// GET /teleharness/api/healthz (ADR-007): unauthenticated, loopback-only and only for
// DIRECT callers — anything relayed by the edge carries x-forwarded-for and
// gets 404 (the edge also refuses the path itself).
// TASK-12.29: mem/errors/degraded/lastCrashAt — observability for the
// watchdog; the response code still depends only on engine availability
// (degraded is a signal, not a refusal).
let lastCrashAt = null; // set at start when run-state.json says the previous run ended uncleanly
async function handleHealthz(req, res) {
  const remote = req.socket?.remoteAddress ?? "";
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  // Until the edge is restarted with ADR-009 (x-forwarded-for always set),
  // relayed requests are recognized by their Host: the edge forwards the
  // browser's host, direct watchdog probes use 127.0.0.1/localhost.
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  const localHost = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (!loopback || !localHost || req.headers["x-forwarded-for"]) return sendJson(res, 404, { error: "unknown route" });
  const memUsage = process.memoryUsage();
  const mem = { rssMb: Math.round(memUsage.rss / 1048576), heapUsedMb: Math.round(memUsage.heapUsed / 1048576) };
  if (MOCK) return sendJson(res, 200, { ok: true, mock: true, version: VERSION, uptimeS: Math.round((Date.now() - STARTED_AT) / 1000), mem });
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
    store: { bindings: bindings.size(), authSessions: sessionCount(), authSessionsStale90d: authSessionsStale90d() },
    mem,
    degraded: config.TELEHARNESS_MEM_WARN_MB > 0 && mem.rssMb > config.TELEHARNESS_MEM_WARN_MB,
    errors: { upstream5m: upstreamErrors5m() },
    ...(lastCrashAt ? { lastCrashAt } : {}),
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
    const rawHost = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim();
    if (!rawHost || /[\s/@\\]/.test(rawHost)) return true;
    const xfp = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
    const expectedProto = xfp === "https" || xfp === "http" ? `${xfp}:` : (req.socket?.encrypted ? "https:" : "http:");
    const expected = new URL(`${expectedProto}//${rawHost}`);
    const parsed = new URL(origin);
    return parsed.origin !== expected.origin;
  } catch {
    return true;
  }
}

function route(req, res, url) {
  const p = url.pathname;

  if (p === "/teleharness/api/healthz" && req.method === "GET") return handleHealthz(req, res);

  if (p.startsWith("/teleharness/hooks/github/") && req.method === "POST") return github.hook(req, res, url);

  if (p.startsWith("/teleharness/api/") && crossSite(req)) return sendJson(res, 403, { error: "cross-site request refused" });

  // ---- token auth --------------------------------------------------------
  // Login exchanges the token for a session cookie (TASK-12.21); that cookie
  // keeps a device logged in for a year and is what EventSource / file
  // downloads authenticate with.
  if (p === "/teleharness/api/auth/login" && req.method === "POST") return handleLogin(req, res);
  if (p === "/teleharness/api/auth/pair/claim" && req.method === "POST") return handlePairClaim(req, res);
  if (p === "/teleharness/api/auth/logout" && req.method === "POST") {
    // Logout REVOKES the session server-side, not just the cookie (BUG-12.9).
    const a = authFromReq(req);
    if (a?.kind === "sid") destroySession(a.sid);
    clearAuthCookie(res, isHttps(req));
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/teleharness/api/auth/me" && req.method === "GET") {
    const a = authFromReq(req);
    if (!a) {
      // Mock/dev surface: a canned identity lets QA harnesses open the app.
      if (MOCK) return sendJson(res, 200, { user: { id: "mock", name: "QA", role: "admin" } });
      return sendJson(res, 401, { error: "unauthorized" });
    }
    res.teleharnessUser = a.user.id;
    if (a.kind === "legacy") setAuthCookie(res, createSession(a.user), isHttps(req));
    return meFace(a.user).then((u) => sendJson(res, 200, { user: u }));
  }

  if (p.startsWith("/teleharness/api/")) {
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
    res.teleharnessUser = a.user.id;
    // ADR-009 п.4: a legacy raw-token cookie is swapped for a session cookie
    // on the first authenticated response.
    if (a.kind === "legacy") setAuthCookie(res, createSession(a.user), isHttps(req));
    if (rateLimited(a.user, req.method)) {
      req.resume();
      return sendJson(res, 429, { error: "слишком много запросов, повторите через минуту" });
    }
    // BUG-260: изменение через API — следующие чтения списка чатов не склеиваются с начатыми до него
    if (req.method !== "GET" && req.method !== "HEAD") {
      sessionListCache.bump();
      res.once("finish", () => sessionListCache.bump());
    }
    Promise.resolve()
      .then(() => handleApi(req, res, url, a.user))
      .catch((err) => internalError(res, err, "handleApi"));
    return;
  }

  if (!p.startsWith("/teleharness")) return sendJson(res, 404, { error: "not found" });
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
  serveStatic(req, res, p);
}

const server = http.createServer((req, res) => {
  // Request id + access log (ADR-007): one line per request when it ends;
  // the path only (no query — it can carry file paths), never cookies.
  const rid = requestId();
  const started = Date.now();
  res.teleharnessRid = rid;
  res.setHeader("x-request-id", rid);
  applySecurityHeaders(res); // TASK-12.30
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
      user: res.teleharnessUser ?? null,
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

// FEAT-20.7: незавершённые слияния после перезапуска — к определённому итогу (кр. 17)
worktrees.recover().then((ops) => { if (ops.length) console.log(`[teleharness-wt] recovered ${ops.length} merge op(s)`); }).catch((err) => errLog("worktrees.recover", err));
server.listen(PORT, config.TELEHARNESS_LISTEN_HOST, () => { // TASK-17.1: по умолчанию 127.0.0.1
  // TASK-12.29: did the previous run end uncleanly? Log it, push the owner
  // (best effort — a push failure never blocks the start), remember for
  // healthz `lastCrashAt`. uncaughtException (below) deliberately leaves
  // clean:false, so a kill/crash is detected here on the next boot.
  try {
    const prev = readPrevious(DATA_DIR);
    // FEAT-20.2: перезапуск (аварийный — отдельно) — событие сводки «Пока вас не было»
    if (prev.startedAt) {
      const hhmm = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      attention.addEvent(listUsers().filter((u) => !u.disabled).map((u) => u.id), {
        kind: prev.crashed ? "crash" : "restart",
        text: (prev.crashed ? `Сервер аварийно перезапустился в ${hhmm}` : `Сервер перезапущен в ${hhmm}`) + (attentionInterrupted ? ` — прервано ходов: ${attentionInterrupted}` : ""),
      });
    }
    if (prev.crashed) {
      console.log(`[teleharness-fatal] previous run ended uncleanly (pid ${prev.pid ?? "?"}, started ${prev.startedAt ?? "?"})`);
      lastCrashAt = prev.startedAt;
      if (webPush) {
        webPush.notifier
          .sendToUser("admin", { title: "Портал перезапущен после сбоя", body: prev.startedAt ?? "" }, { ttl: 24 * 3600 })
          .catch(() => {});
      }
    }
    markStarted(DATA_DIR);
  } catch (err) {
    errLog("runState", err);
  }
  // TASK-04.15 (SEC-26): hourly sweep of sessions past the cookie life.
  setInterval(() => {
    const n = sweepSessions();
    if (n > 0) console.log(`[teleharness-gc] auth sessions swept: ${n} expired`);
  }, 3_600_000).unref();
  if (!MOCK) {
    hub.start(UPSTREAM, { directory: HOME_DIR });
    hub.syncDirectories(); // subscribe to every directory that has sessions
    // gc sweep (empty chats, leftover tenant folders): once shortly after the
    // start (the hub has seeded busy/dialog state by then), then periodically.
    if (config.TELEHARNESS_GC_ENABLED) {
      const every = config.TELEHARNESS_GC_INTERVAL_MS;
      setTimeout(() => gcSweep(), Math.min(every, 30_000)).unref();
      setInterval(() => gcSweep(), every).unref();
    }
    // BUG-195: папки индекса чатов — под учёт реапера (экземпляры, поднятые до рестарта портала), проход раз в 5 мин
    if (config.TELEHARNESS_INSTANCE_IDLE_MIN > 0) {
      fetchSessionIndex(true)
        .then(() => instanceReaper.seed([...sessionIndex.recById.values()].map((r) => r?.directory)))
        .catch(() => {});
      setInterval(() => instanceReaper.sweep().catch(() => {}), config.TELEHARNESS_INSTANCE_SWEEP_MS).unref();
    }
  }
  const { port } = server.address();
  console.log(`teleharness listening on http://127.0.0.1:${port} (mock:${MOCK ? 1 : 0})`);
});
// Startup failures (e.g. port taken) exit with one clean line, not a stack.
server.on("error", (err) => {
  console.error(`teleharness server error: ${err.message}`);
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
  // TASK-13.27: the store write is deferred — unsaved chat history lands
  // here, before the process exits (spec: «Остановка сервера сразу после
  // ответа» — история на месте).
  try {
    claude.flushNow();
  } catch (err) {
    errLog("claude.flushNow", err);
  }
  try { chatSearch?.stop(); } catch {}
  hub.stop();
  // TASK-12.29: a graceful stop marks run-state clean — the next boot does
  // not report a crash. uncaughtException exits without this mark.
  try {
    markClean(DATA_DIR);
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref(); // force-exit stragglers
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
