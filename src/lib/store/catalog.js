// Auth + boot + catalogs (sessions, providers, agents, MCP, host, usage) and
// the store-level api facade for components (TASK-01.42: components never
// import api.js directly — Composer/FileViewer/AccessSection migrate here).
import { api, explainApiError } from "../api.js";
import { mergeSessionList, normalizeAgents, normalizeMcp, normalizeProviders } from "../normalize.js";
import {
  about,
  activeSessionDir,
  agents,
  agentsError,
  bindUserStorage,
  claudeAgents,
  claudeAgentsError,
  host,
  hostError,
  mcp,
  mcpError,
  me,
  providerCfg,
  providerError,
  sessions,
  sessionsError,
  setNotice,
  usage,
  usageError,
  subscriptions,
  subscriptionsError,
  voiceInfo,
} from "./state.js";
import { seedDialogs } from "./dialogs.js";
import { pollBusy } from "./session.js";
import { refreshPins } from "./pins.js";
import { closeEventStream, installEventStream } from "./stream.js";
import { t } from "../i18n.js";

const BUSY_POLL_MS = 10_000;

// Boot: resolve the cookie → user or the login screen. SSE/polls start only
// through init() once a user exists (views call it on mount).
export async function boot() {
  if (me.value) return; // already logged in
  try {
    const user = await api.me();
    bindUserStorage(user); // ISSUE-002: prefs/projects per user, before any view reads them
    me.value = user;
  } catch {
    me.value = false; // 401 or a network hiccup: the login screen retries cleanly
  }
}

// Token paste → cookie → full store boot. The redirect home is handled by
// the caller (LoginView); init() here is what pulls sessions/dialogs/SSE.
// A stream left over from the dead cookie (401-closed) is dropped first.
export async function loginWithToken(token) {
  const user = await api.login(token);
  bindUserStorage(user);
  // П31.Н10 (ревью шагов 2026-11-05): плашки прошлой (истёкшей) сессии с её
  // «Повторить» после нового входа только путают — снимаем.
  setNotice(null);
  me.value = user;
  closeEventStream();
  await init();
  return user;
}

// Drop the cookie; reload lands on the login screen with zero stale state
// (signals, SSE stream and busy polls are all page-lifetime by design).
export async function logout() {
  try {
    await api.logout();
  } catch {}
  globalThis.location?.reload?.();
}

// The list screens read sessionsError (BUG-01.40) instead of probing the
// endpoint themselves; a failure keeps the last known list.
let sessionsInflight = null;
export function refreshSessions() {
  const p = (async () => {
    try {
      sessions.value = mergeSessionList(sessions.value, (await api.listSessions()) ?? []); // BUG-088
      sessionsError.value = false;
      return true;
    } catch {
      sessionsError.value = true;
      return false;
    }
  })();
  sessionsInflight = p;
  p.finally(() => {
    if (sessionsInflight === p) sessionsInflight = null;
  });
  return p;
}

// BUG-01.19: a fresh list for «is this chat still there?» — rides the list
// request already in flight (init() on a cold deep link) instead of a second.
export function freshSessionList() {
  return sessionsInflight ?? refreshSessions();
}

// Model catalog (the picker's «Повторить» calls this too). true = loaded.
export async function refreshProvider() {
  try {
    providerCfg.value = normalizeProviders(await api.getProvider());
    providerError.value = false;
    return true;
  } catch {
    if (providerCfg.value == null) providerError.value = true;
    return false;
  }
}

export async function refreshHost() {
  try {
    host.value = await api.getHost();
    hostError.value = false;
  } catch {
    if (host.value == null) hostError.value = true; // без данных — «Повторить» вместо вечной «Загрузки…»
  }
}

// FEAT-11.18: раздел «Подписки» (все пользователи). Сбой без данных → «Повторить».
export async function refreshSubscriptions() {
  try {
    const r = await api.getSubscriptions();
    subscriptions.value = Array.isArray(r?.providers) ? r.providers : [];
    subscriptionsError.value = false;
  } catch {
    if (subscriptions.value == null) subscriptionsError.value = true;
  }
}

export async function refreshUsage() {
  try {
    usage.value = await api.getUsage();
    usageError.value = false;
  } catch {
    if (usage.value == null) usageError.value = true;
  }
}

// Agent catalog (the agent picker's «Повторить» calls this too). true = loaded.
export async function refreshAgents() {
  try {
    agents.value = normalizeAgents(await api.getAgents());
    agentsError.value = false;
    return true;
  } catch {
    if (agents.value.length === 0) agentsError.value = true;
    return false;
  }
}

// FEAT-13.17: the portal's Claude agents (admin only; the sheet's
// «Повторить» calls this too). true = loaded.
export async function refreshClaudeAgents() {
  try {
    const r = await api.getClaudeAgents();
    const list = Array.isArray(r?.agents) ? r.agents : [];
    claudeAgents.value = list
      .filter((a) => a && typeof a.id === "string" && typeof a.name === "string")
      .map((a) => ({ id: a.id, name: a.name, description: typeof a.description === "string" ? a.description : "" }));
    claudeAgentsError.value = false;
    return true;
  } catch {
    if (claudeAgents.value == null) claudeAgentsError.value = true;
    return false;
  }
}

// FEAT-06.2: is the voice mode on the server? Asked once per page (the
// composer / Настройки); a failure reads as «off» — the wave button stays
// hidden, dictation (FEAT-06.1) is not affected. The first ask may take a
// few seconds: it starts the voice worker.
let voiceInflight = null;
export function refreshVoice({ force = false } = {}) {
  if (voiceInflight) return voiceInflight;
  if (voiceInfo.value && !force) return Promise.resolve(voiceInfo.value);
  voiceInflight = api
    .voiceInfo()
    .then(
      (r) => (voiceInfo.value = r && typeof r === "object" ? r : { enabled: false, voices: [] }),
      () => (voiceInfo.value = voiceInfo.value ?? { enabled: false, voices: [], failed: true }),
    )
    .finally(() => {
      voiceInflight = null;
    });
  return voiceInflight;
}
export const voiceApi = {
  tts: (body, opts) => api.voiceTts(body, opts),
  stt: (pcm, opts) => api.voiceStt(pcm, opts),
};

// «О приложении» versions — every role (ISSUE-008).
export async function refreshAbout() {
  try {
    about.value = await api.getAbout();
  } catch {}
}

// BUG-234: the first /mcp of a cold opencode folder (a new tenant, a fresh
// serve) answers `{}` while the MCP servers are still connecting. An empty
// answer is retried in the background (the list stays as it was — a skeleton
// on first load) and becomes «Не настроены» only after the last try. A list
// with a server still «pending» is shown and asked again too ({} → {a: connected,
// b: pending} → both connected). A cold folder can stay «pending» for 15 s and
// more while other catalogs load — so 6 tries every 2.5 s, then 6 more every
// 5 s (~45 s total).
export const MCP_EMPTY_RETRY = { tries: 12, delayMs: 2500 };
let mcpRetryTimer = null;

export async function refreshMcp(attempt = 0) {
  if (typeof attempt !== "number") attempt = 0;
  clearTimeout(mcpRetryTimer);
  mcpRetryTimer = null;
  try {
    const list = normalizeMcp(await api.getMcp());
    mcpError.value = false;
    const settled = list.length > 0 && !list.some((s) => s.status === "pending");
    if (!settled && attempt < MCP_EMPTY_RETRY.tries) {
      if (list.length > 0) mcp.value = list;
      mcpRetryTimer = setTimeout(() => refreshMcp(attempt + 1), attempt < 6 ? MCP_EMPTY_RETRY.delayMs : MCP_EMPTY_RETRY.delayMs * 2);
      return;
    }
    mcp.value = list;
  } catch {
    if (mcp.value == null) mcpError.value = true; // показать «Повторить» вместо вечного «Загрузка…»
  }
}

let busyTimer = null;
let catalogsInflight = null;

// Cold start (bugfix-1.7.2): right after a server restart /mcp (and other
// catalogs) can take ~30 s while the MCP servers come up. init() resolves on
// /session alone — the chat list (or its empty state) shows at once — and the
// catalogs load in the background, each with its own loading/error signal
// (providerError, agentsError, mcpError…), never blocking the home screen.
export async function init() {
  installEventStream();
  if (!busyTimer) {
    busyTimer = setInterval(pollBusy, BUSY_POLL_MS);
    busyTimer.unref?.();
    pollBusy(); // immediate first sample: a hung chat must show busy right away
  }
  loadCatalogs();
  // FEAT-01.69: the account's pinned chats (background); until one load
  // succeeded every init() asks again.
  if (pinsState === "todo") {
    pinsState = "loading";
    refreshPins().then((ok) => (pinsState = ok ? "done" : "todo"));
  }
  await refreshSessions();
}
let pinsState = "todo";

// Background catalogs; a second init() while they are still in flight does
// not stack duplicate requests. Returns the shared promise (tests await it).
export function loadCatalogs() {
  if (catalogsInflight) return catalogsInflight;
  const isAdmin = me.value?.role === "admin";
  catalogsInflight = Promise.allSettled([
    seedDialogs(), // a fresh page must see dialogs asked before it opened
    refreshProvider(),
    refreshAgents(),
    // /mcp: every role — a tenant gets only its own servers (FEAT-03.21).
    refreshMcp(),
    // Claude agents are admin-only too (FEAT-13.17).
    isAdmin ? refreshClaudeAgents() : Promise.resolve(),
    refreshAbout(),
  ]).finally(() => {
    catalogsInflight = null;
  });
  return catalogsInflight;
}

// «Новый проект» (ISSUE-006): the server's verdict on a folder — null when
// usable, else the Russian reason. A network failure is not a verdict (null).
export async function checkProjectDir(directory) {
  try {
    const r = await api.checkDir(directory);
    return r?.ok === false ? r.error || t("store.dir.unavailable") : null;
  } catch (err) {
    if (!err?.status) return null;
    const reason = typeof err?.body?.error === "string" ? err.body.error : "";
    // 400s from the path policy already speak Russian; policy 403s do not.
    if (err.status === 400 && /[а-яё]/i.test(reason)) return `${reason[0].toUpperCase()}${reason.slice(1)}.`;
    return explainApiError(err, t("store.dir.addFailed"));
  }
}

// A removed attachment chip drops its uploaded file (ISSUE-009). Best effort.
export async function deleteUpload(directory, name) {
  try {
    return await api.deleteUpload(directory, name);
  } catch {
    return false;
  }
}

export const uploadFile = (file, directory = activeSessionDir(), opts = {}) => api.uploadFile(file, directory, opts);
export const fileUrl = (directory, path, download = false) => api.fileUrl(directory, path, download);
export const rotateOwnToken = () => api.rotateOwnToken();
export const admin = {
  users: () => api.adminUsers(),
  create: (body) => api.adminCreateUser(body),
  update: (id, body) => api.adminUpdateUser(id, body),
  regenerateToken: (id) => api.adminRegenerateToken(id),
  remove: (id) => api.adminDeleteUser(id),
  // «Активные ходы» (FEAT-07.16): merged run status (with `since` per busy
  // session since 1.7.0) and the regular abort route.
  status: () => api.getSessionStatus(),
  abort: (id, directory) => api.abort(id, { directory }),
};
