// Store state: every signal + the tiny shared helpers that read/patch them.
// No network here (TASK-01.42 split): actions live in session/dialogs/
// stream/catalog modules; src/lib/store.js re-exports the public surface.
// Node-safe: localStorage access is guarded.
import { effect, signal } from "@preact/signals";
import { firstUserText, validateProjectDir } from "../normalize.js";
import { bindingOf, engineOf, isClaudeAgentId, modelAvailable, modelName } from "../engine.js";
import { t } from "../i18n.js";

// Legacy device-wide keys (before ISSUE-002): read only until a user is
// known; afterwards every key carries the user id (`zai.prefs.<id>`), so an
// admin's Claude default / projects never leak into a tenant on the same
// device. The admin inherits the legacy values once (migration).
const PREFS_KEY = "zai.prefs";
const PROJECTS_KEY = "zai.projects";
let storageUser = null; // {id, role} once bindUserStorage() ran
const prefsKey = () => (storageUser ? `${PREFS_KEY}.${storageUser.id}` : PREFS_KEY);
const projectsKey = () => (storageUser ? `${PROJECTS_KEY}.${storageUser.id}` : PROJECTS_KEY);

function rawGet(key) {
  try {
    return globalThis.localStorage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

// Default for fresh users (and the effective default for every new chat
// unless the user explicitly picked something else in Settings). glm-5.3-flash
// + Sisyphus is the user-mandated pairing (2026-10-31); glm-5.3-highspeed hung
// at the provider that day (zero tokens for 120s+), so it must never be
// selected by default.
const DEFAULT_MODEL = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
// FEAT-16.2 (2026-11-07): OmO → oh-my-opencode-slim; its primary agent is «orchestrator»
// (Sisyphus is gone from the catalog — a saved one is replaced in sanitizePrefs).
const DEFAULT_AGENT = "orchestrator";

// Prefs saved while these were the defaults (2026-10-31 morning) must not
// shadow the new pairing forever on already-deployed devices: treat the exact
// old combo as stale and re-seed it with the new defaults. Any other saved
// combo is an explicit user choice and stays.
const LEGACY_DEFAULTS = {
  modelID: "glm-5.3",
  providerID: "zai-coding-plan",
  agent: "build",
};

// claudeAgent (FEAT-13.17): the Claude agent for NEW Claude chats; null =
// «Без агента». Never seeded by a default or a migration — only an explicit
// pick in Настройки sets it.
const claudeAgentOf = (saved) => (isClaudeAgentId(saved?.claudeAgent) ? saved.claudeAgent : null);

// FEAT-03.19: «Детализация выполнения» — off unless the user turned it on.
// The key is stored only when true, so an untouched prefs object keeps its
// shape and every older record reads as «off».
const execDetailOf = (saved) => (saved?.execDetail === true ? { execDetail: true } : {});
export const execDetailOn = (p) => p?.execDetail === true;

// FEAT-06.2: «Голосовой режим» settings (prefs.voice, per user like every
// pref). voice null = the server default (irina); the choices are the
// Настройки rows: rate 0.8/1.0/1.2/1.4, pause before sending 0.8–2.0 s,
// short spoken answers on unless turned off (owner 2026-11-05).
export const VOICE_RATES = [0.8, 1, 1.2, 1.4];
export const VOICE_PAUSES = [800, 1200, 1600, 2000];
export const VOICE_DEFAULTS = Object.freeze({ voice: null, rate: 1, pauseMs: 1200, shortAnswers: true });
export function sanitizeVoicePrefs(v) {
  const src = v && typeof v === "object" ? v : {};
  return {
    voice: typeof src.voice === "string" && /^[a-z]{2,24}$/.test(src.voice) ? src.voice : null,
    rate: VOICE_RATES.includes(Number(src.rate)) ? Number(src.rate) : VOICE_DEFAULTS.rate,
    pauseMs: VOICE_PAUSES.includes(Number(src.pauseMs)) ? Number(src.pauseMs) : VOICE_DEFAULTS.pauseMs,
    shortAnswers: src.shortAnswers !== false,
  };
}
// Stored only once the user changed something (an untouched prefs object
// keeps its shape, like execDetail).
const voiceOf = (saved) => (saved?.voice && typeof saved.voice === "object" ? { voice: sanitizeVoicePrefs(saved.voice) } : {});
export const voicePrefs = (p) => sanitizeVoicePrefs(p?.voice);

function loadPrefs(key = PREFS_KEY) {
  const fresh = { model: DEFAULT_MODEL, agent: DEFAULT_AGENT, claudeAgent: null };
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem?.(key) ?? "null");
    if (
      saved?.model?.modelID === LEGACY_DEFAULTS.modelID &&
      saved?.model?.providerID === LEGACY_DEFAULTS.providerID &&
      saved?.agent === LEGACY_DEFAULTS.agent
    ) {
      return { ...fresh, ...execDetailOf(saved), ...voiceOf(saved) };
    }
    return {
      model: saved?.model?.modelID ? saved.model : DEFAULT_MODEL,
      agent: saved?.agent ?? DEFAULT_AGENT,
      claudeAgent: claudeAgentOf(saved),
      ...execDetailOf(saved),
      ...voiceOf(saved),
    };
  } catch {
    return fresh;
  }
}

function readJsonList(key) {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem?.(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
  } catch {
    return [];
  }
}

export const sessions = signal([]);
export const sessionsError = signal(false); // last GET /session failed (BUG-01.40: «Повторить», not an empty list)
export const providerCfg = signal(null);
export const providerError = signal(false); // /provider failed with no catalog yet (picker «Повторить»)
export const agents = signal([]);
export const agentsError = signal(false); // /agent failed with no list yet — picker «Повторить» instead of an endless skeleton
// FEAT-13.17: the portal's Claude agents [{id, name, description}] (admin
// only); null while not loaded, claudeAgentsError = failed with no list.
export const claudeAgents = signal(null);
export const claudeAgentsError = signal(false);
export const mcp = signal(null); // normalized [{name, status, error}] | null while loading
export const mcpError = signal(false); // last fetch failed — Настройки offer «Повторить»
export const host = signal(null); // {cpu, ram, disks, tempC, tempStuck} | null while loading
export const hostError = signal(false); // host fetch failed with no data — «Повторить»
export const usage = signal(null); // {ok, plan, windows:[{kind, percent, used, total, resetAt}]} | null while loading
// FEAT-11.18: карточки раздела «Подписки» — [{id,title,badge,state,…}] | null пока грузится
export const subscriptions = signal(null);
export const subscriptionsError = signal(false);
export const usageError = signal(false); // usage fetch failed with no data — «Повторить»
export const about = signal(null); // {version, opencodeVersion} from /about — every role (ISSUE-008)
// FEAT-06.2: GET /voice — {enabled, ready, parked, voices, stt, defaultVoice};
// null until asked. enabled:false hides the voice-mode button.
export const voiceInfo = signal(null);
export const userProjects = signal(readJsonList(PROJECTS_KEY)); // [directory] added via «Добавить проект»
// The open chat: {id, title, status: idle|busy|stopping, lastEventAt,
// lastActivityAt, lastAction, messages: [], loading, loadError, turnError,
// incomplete}. turnError = describeTurnError() face of the last failed turn;
// incomplete = {reason, todosOpen?, todosTotal?} when the turn ended unfinished.
export const active = signal(null);
// BUG-01.27 (client half): raw first user text per chat id, remembered from
// the open chat — the chat list titles an untitled chat (Claude chats, a
// fresh opencode chat before its auto-title) with displayTitle(title, text)
// like the header does. Unknown (never opened in this tab) → «Без названия».
export const firstTexts = signal({});
effect(() => {
  const act = active.value;
  // BUG-08.8: with older pages still on the server the loaded head is not the
  // chat's first question.
  if (!act?.id || act.hasOlder) return;
  const t = firstUserText(act.messages);
  if (t && firstTexts.peek()[act.id] !== t) firstTexts.value = { ...firstTexts.peek(), [act.id]: t };
});
// Id of the chat ChatView currently shows (TASK-01.42: replaces the old
// globalThis.__zaiActiveId stamp). Set by ChatView, read by uploads/files.
export const activeId = signal(null);
export const dialogs = signal([]);
// FEAT-01.57: «Изменить» — the last question being edited in the composer:
// {sid, messageID, text, parts} | null (parts = its files, kept on send).
export const editing = signal(null);
// FEAT-01.58: a turn action in flight ({sid, kind: "revert"|"unrevert"|
// "edit"|"regenerate"}) — the buttons are disabled meanwhile.
export const rewindBusy = signal(null);
// Transient portal-wide notice («ответ не отправлен: запрос истёк» etc.) —
// rendered by AppShell as a slim closable bar, auto-expires. null = nothing.
export const notice = signal(null);
// FEAT-01.69 (П31.Н1, кадр E1): an optional action next to the notice text —
// {label, run} («Повторить» after a failed pin). Cleared with the notice.
export const noticeAction = signal(null);
// FEAT-01.69: the user's pinned chats (ids in pin order), mirrored from the
// account (GET/PUT /zai/api/me/pins) — every device of the user sees them.
export const pins = signal([]);
export const prefs = signal(loadPrefs());
// Authoritative busy state (upstream /session/status via 10s poll + SSE
// maintenance): { "<sessionID>": sinceMs }. Powers the stop button on a
// freshly opened chat that is actually running (or hung) server-side.
export const busyMap = signal({});
// True while the open session is busy but produced no events for STALL_MS:
// no banner reads it since FEAT-07.22 (the activity line shows the silence).
export const stalled = signal(false);
// Server-tracked unanswered prompts: { "<sessionID>": {at, replays, max} }.
// A poisoned session is IDLE upstream (the run fiber died, its queued prompt
// was never replayed) — no busy flag, no spinner, nothing. This map (from
// /zai/api/status pending entries) is the only thing that makes that state
// visible in the UI (2026-11-01, «в чате вообще ничего не происходит»).
export const pendingMap = signal({});
// Live-stream face (R-20, BUG-07.11): state "online" | "offline";
// restoredAt = ms of the last offline→online flip (the shell flashes «Связь
// восстановлена» for a few seconds), null otherwise.
export const connection = signal({ state: "online", restoredAt: null });
// Session identity: null = boot check in flight, false = anonymous (login
// screen), {id, name, role} = logged in. The server owns the state (the
// year-long HttpOnly cookie) — this signal only mirrors /auth/me.
export const me = signal(null);

let noticeTimer = null;
export function setNotice(text, ms = 6000, action = null) {
  notice.value = text;
  noticeAction.value = text && action && typeof action.run === "function" ? action : null;
  clearTimeout(noticeTimer);
  if (text) {
    noticeTimer = setTimeout(() => {
      notice.value = null;
      noticeAction.value = null;
    }, ms);
    noticeTimer?.unref?.();
  }
}

export function setPrefs(patch) {
  prefs.value = { ...prefs.value, ...patch };
  try {
    globalThis.localStorage?.setItem?.(prefsKey(), JSON.stringify(prefs.value));
  } catch {}
}

function saveUserProjects(list) {
  try {
    globalThis.localStorage?.setItem?.(projectsKey(), JSON.stringify(list));
  } catch {}
}

// Same-folder test the server's dirAllowed uses (case-insensitive, trailing
// separators ignored, / == \).
const normDir = (d) => String(d ?? "").trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

// Projects a user may open (ISSUE-002): admins — everything; a tenant —
// only its own chat folders (anything else is 403 «outside your scope»).
export function sanitizeProjects(list, user) {
  const clean = (Array.isArray(list) ? list : []).filter((x) => typeof x === "string" && x);
  if (!user || user.role === "admin" || !Array.isArray(user.directories)) return clean;
  const allowed = new Set(user.directories.map(normDir));
  return clean.filter((d) => allowed.has(normDir(d)));
}

// The defaults a NEW chat really gets (ISSUE-001/002). Pure. Admins keep
// what they chose. A tenant never asks for an engine or agent the server
// refuses: Claude without the grant → the z.ai default model; an agent
// missing from the tenant's catalog → the server-side default
// (user.defaultAgent), else the first primary agent, else null (the server
// picks). With the catalog not loaded yet the server default is trusted.
// claudeAgent: kept for admins while the Claude catalog has it (or is not
// loaded yet); a tenant never has one (Claude agents are admin-only).
// BUG-137: catalog (providerCfg) loaded → a saved model gone from the working
// list (zai/glm-4.5 of case 82) is replaced by the default; staleModel names
// the saved one so the UI can say «недоступна — выбрана X» (the saved value
// itself stays in storage).
export function sanitizePrefs(p, { user = null, agents: list = [], claudeAgents: cAgents = null, catalog = null } = {}) {
  const saved = p?.model?.modelID ? p.model : DEFAULT_MODEL;
  const stale = modelAvailable(saved, catalog) === false;
  const model = stale ? DEFAULT_MODEL : saved;
  const staleMark = stale ? { staleModel: saved } : {};
  const agent = p?.agent ?? DEFAULT_AGENT;
  let claudeAgent = claudeAgentOf(p);
  if (claudeAgent && Array.isArray(cAgents) && !cAgents.some((a) => a?.id === claudeAgent)) claudeAgent = null;
  if (!user) return { model, agent, claudeAgent, ...staleMark };
  if (user.role === "admin") {
    // FEAT-16.2: a saved agent gone from the loaded catalog → the server default
    // (opencode default_agent), else the first primary; catalog unknown → kept.
    const names = (Array.isArray(list) ? list : []).map((a) => a?.name).filter(Boolean);
    if (names.length === 0 || names.includes(agent)) return { model, agent, claudeAgent, ...staleMark };
    const primary = list.find((x) => x?.mode === "primary")?.name ?? null;
    const a = user.defaultAgent && names.includes(user.defaultAgent) ? user.defaultAgent : primary ?? agent;
    return { model, agent: a, claudeAgent, ...staleMark };
  }
  const engines = Array.isArray(user.engines) && user.engines.length > 0 ? user.engines : ["opencode"];
  const m = engines.includes(engineOf(model.providerID)) ? model : DEFAULT_MODEL;
  const names = (Array.isArray(list) ? list : []).map((a) => a?.name).filter(Boolean);
  let a = agent;
  if (names.length > 0) {
    if (!names.includes(a)) {
      const primary = list.find((x) => x?.mode === "primary")?.name ?? list.find((x) => x?.mode !== "subagent")?.name ?? null;
      a = user.defaultAgent && names.includes(user.defaultAgent) ? user.defaultAgent : primary;
    }
  } else if (a !== user.defaultAgent) {
    a = user.defaultAgent ?? null;
  }
  return { model: m, agent: a, claudeAgent: null, ...staleMark };
}

// Live effective defaults (reads the signals): every new chat / unbound send
// goes through this, never raw prefs.
export function effectivePrefs() {
  return sanitizePrefs(prefs.value, { user: me.value || null, agents: agents.value, claudeAgents: claudeAgents.value, catalog: providerCfg.value });
}

// BUG-137: «Модель «GLM-4.5» из Настроек недоступна — выбрана GLM-5.3-Flash.»
// for a stale saved default (eff = effectivePrefs()); "" when all is well.
export function staleModelText(eff, cfg = providerCfg.value) {
  if (!eff?.staleModel) return "";
  return t("store.staleModel", { stale: modelName(cfg, eff.staleModel), model: modelName(cfg, eff.model) });
}

// Point prefs/projects at the logged-in user's own keys (boot / login).
// The admin inherits the legacy device keys once; a tenant starts clean.
export function bindUserStorage(user) {
  if (!user || typeof user.id !== "string" || !user.id) return;
  storageUser = { id: user.id, role: user.role };
  const admin = user.role === "admin";
  const ownPrefs = rawGet(prefsKey());
  prefs.value = loadPrefs(ownPrefs != null || !admin ? prefsKey() : PREFS_KEY);
  const ownProjects = rawGet(projectsKey());
  const list = ownProjects != null || !admin ? readJsonList(projectsKey()) : readJsonList(PROJECTS_KEY);
  userProjects.value = sanitizeProjects(list, user);
  if (admin && ownPrefs == null && rawGet(PREFS_KEY) != null) setPrefs({});
  if (admin && ownProjects == null && rawGet(PROJECTS_KEY) != null) saveUserProjects(userProjects.value);
}

// ---- composer drafts (ISSUE-015) --------------------------------------------
// Unsent text survives a reload / leaving the chat: per user + chat id.
const draftKey = (sid) => `zai.draft.${storageUser?.id ?? "-"}.${sid}`;

export function loadDraft(sid) {
  if (!sid) return "";
  const v = rawGet(draftKey(sid));
  return typeof v === "string" ? v : "";
}

export function saveDraft(sid, text) {
  if (!sid) return;
  try {
    const t = String(text ?? "");
    if (t.trim()) globalThis.localStorage?.setItem?.(draftKey(sid), t);
    else globalThis.localStorage?.removeItem?.(draftKey(sid));
  } catch {}
}

export function addUserProject(dir) {
  const d = String(dir ?? "").trim();
  if (!d || validateProjectDir(d)) return; // BUG-013: the modal shows why
  const low = d.toLowerCase();
  if (userProjects.value.some((x) => x.toLowerCase() === low)) return;
  const next = [...userProjects.value, d];
  userProjects.value = next;
  saveUserProjects(next);
}

export function removeUserProject(dir) {
  const low = String(dir ?? "").toLowerCase();
  const next = userProjects.value.filter((x) => x.toLowerCase() !== low);
  userProjects.value = next;
  saveUserProjects(next);
}

// The directory a session lives in — every session-scoped upstream call must
// carry it (cross-directory calls silently return empty payloads, 1.19.5).
export function sessionDir(id) {
  return sessions.value.find((s) => s.id === id)?.directory ?? null;
}

export function engineOfSession(id) {
  return bindingOf(sessions.value.find((s) => s.id === id))?.engine ?? "opencode";
}

export function setActiveId(id) {
  activeId.value = id ?? null;
}

// Directory of the session currently open in ChatView. File chips and
// uploads resolve against it.
export function activeSessionDir() {
  return sessionDir(activeId.value);
}

// BUG-228: когда клиент сам увидел конец хода (id → время). Сервер кэширует
// /zai/api/status на 3 с, поэтому опрос сразу после конца хода может ещё
// ответить «занят» — pollBusy такому ответу в пределах окна не верит.
export const idleSeenAt = new Map();
export const STATUS_STALE_MS = 5000;
// Зовётся из событий конца хода (events.js), а не из setBusyTracked: отметки
// занятости в busyMap к этому моменту может и не быть (её стёр такой же опрос).
export function noteIdle(id) {
  if (id) idleSeenAt.set(id, Date.now());
}

export function setBusyTracked(id, busy) {
  if (!id) return;
  const m = { ...busyMap.value };
  if (busy) {
    if (!m[id]) m[id] = Date.now();
    idleSeenAt.delete(id);
  } else {
    delete m[id];
  }
  busyMap.value = m;
}

export function clearPending(id) {
  if (!id || !pendingMap.value[id]) return;
  const pm = { ...pendingMap.value };
  delete pm[id];
  pendingMap.value = pm;
}

export function patchActive(sessionID, fn) {
  const act = active.value;
  if (!act || !sessionID || act.id !== sessionID) return;
  active.value = fn(act);
}
