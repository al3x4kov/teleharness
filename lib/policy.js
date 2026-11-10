// Tenant capability policy (BUG-12.5 / ADR-004, BUG-12.10). Pure, zero-dep.
//
// opencode serve runs with the OWNER's rights. Tenant shell commands are the
// exception: since FEAT-04.9 (2026-11-04) the opencode plugin vault-cache.ts
// rewrites every tenant `bash` call into ops/sandbox/zai-jail.exe — a Windows
// AppContainer of that tenant (writes only to its folder, no loopback, no
// portal/owner files). So a tenant agent MAY have `bash`. The portal still
// refuses, for non-admin users:
//   - the claude engine (unless the admin enabled it — auth.engineAllowed);
//   - any agent that can delegate (`task`): its subagents are not the tenant's
//     agent profile (Prometheus → Sisyphus-Junior, 2026-11-04);
//   - any agent that may touch files outside its directory (`external_directory`).
// The same predicate filters the agent list a tenant sees. The hard boundary is
// the tenant sandbox of the opencode plugin vault-cache.ts (tool allowlist, path
// confinement, jailed shell, no local network) — this filter keeps the UI and
// the API honest.
import { config } from "./config.js";

// opencode 1.19.5 agent.permission is an ordered ruleset
// [{permission, pattern, action}], evaluated last-match-wins. Older/other
// shapes ({bash: "allow" | {pattern: action}}) are handled conservatively.
// opencode appends to every agent `external_directory allow <data>/opencode/tool-output/*`
// (full output of truncated tool calls). It is opencode's own spool, not a user
// folder; the vault-cache sandbox refuses tenant reads there anyway.
const OPENCODE_SPOOL = /[\\/]opencode[\\/]tool-output[\\/]\*$/i;

// BUG-171 (BUG-12.24): Sandbox reaches the tenants' knowledge-base root
// (`external_directory: {"*": "deny", "<ZAI_TENANT_VAULT>\\*": "allow"}`) so a
// tenant reads/writes notes of its own zone; the vault-cache plugin confines
// each tenant to <root>\<its name>. Such an allow does not make an agent
// «not sandboxed». Default = lib/config.js default; server.js sets the real one.
let VAULT_ROOTS = [config.ZAI_TENANT_VAULT];
const normPath = (p) => String(p ?? "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
export function setTenantVaultRoots(roots) {
  VAULT_ROOTS = (Array.isArray(roots) ? roots : []).filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim());
}
export function tenantVaultRoots() {
  return [...VAULT_ROOTS];
}
function underVaultRoot(pattern) {
  const p = normPath(pattern);
  if (!p.endsWith("\\*") || p.includes("..")) return false;
  const dir = p.slice(0, -2);
  return VAULT_ROOTS.some((r) => {
    const root = normPath(r);
    return dir === root || dir.startsWith(root + "\\");
  });
}

// Can the agent use `permission` (bash, task, external_directory, …)?
export function agentCan(agent, permission) {
  const perm = agent?.permission;
  const exempt = (r) =>
    permission === "external_directory" && r?.permission === permission && r?.action !== "deny" &&
    (OPENCODE_SPOOL.test(String(r?.pattern ?? "")) || underVaultRoot(r?.pattern));
  const hits = (r) => (r?.permission === permission || r?.permission === "*") && !exempt(r);
  if (Array.isArray(perm)) {
    let lastWildcard = -1;
    perm.forEach((r, i) => {
      if (hits(r) && r?.pattern === "*") lastWildcard = i;
    });
    if (lastWildcard === -1) return true; // opencode default: allowed
    if (perm[lastWildcard].action !== "deny") return true;
    // A narrower allow/ask after the wildcard deny re-opens it.
    return perm.slice(lastWildcard + 1).some((r) => hits(r) && r?.action !== "deny");
  }
  if (perm && typeof perm === "object") {
    const b = perm[permission] ?? perm["*"];
    if (b === "deny") return false;
    if (b && typeof b === "object") return Object.values(b).some((a) => a !== "deny");
    return true;
  }
  if (agent?.tools && agent.tools[permission] === false) return false;
  return true;
}

export function agentHasShell(agent) {
  return agentCan(agent, "bash");
}

// Cannot delegate, confined to its directory. `bash` may be allowed: a tenant's
// shell runs only inside its AppContainer (vault-cache.ts → zai-jail, FEAT-04.9).
export function agentIsSandboxed(agent) {
  return !agentCan(agent, "task") && !agentCan(agent, "external_directory");
}

// Agents a tenant may run: known, not hidden, sandboxed (no delegation, no outside files; shell only jailed).
export function tenantAgents(list) {
  // 2026-11-05: OmO subagents (multimodal-looker …) are helpers, not chat agents — they lack the
  // tenant toolset (marketplace, skills, jailed shell); a chat on one could not do the work.
  return (Array.isArray(list) ? list : []).filter((a) => typeof a?.name === "string" && !a.hidden && a.mode !== "subagent" && agentIsSandboxed(a));
}

export function agentAllowedForTenant(name, list) {
  if (typeof name !== "string" || !name) return false;
  return tenantAgents(list).some((a) => a.name === name);
}

// FEAT-16.2 (EPIC-16, 2026-11-07): the admin's default agent for new chats and for
// chats whose agent left the catalog (OmO → oh-my-opencode-slim: «Sisyphus -
// ultraworker» etc. are gone). The opencode config's default_agent if it is a
// visible non-subagent of the catalog, else the first visible primary agent.
export function adminDefaultAgent(list, preferred = null) {
  const visible = (Array.isArray(list) ? list : []).filter((a) => typeof a?.name === "string" && !a.hidden && a.mode !== "subagent");
  if (preferred && visible.some((a) => a.name === preferred)) return preferred;
  return (visible.find((a) => a.mode === "primary") ?? visible[0] ?? null)?.name ?? null;
}

// The agent an admin chat bound to `name` runs on: unchanged while the catalog
// has it (subagents too) or the catalog is unknown (opencode down — no guessing);
// a name gone from the catalog (or hidden) → adminDefaultAgent. Nothing to fall
// back to → unchanged.
export function adminAgentFor(name, list, preferred = null) {
  if (typeof name !== "string" || !name || !Array.isArray(list) || list.length === 0) return name ?? null;
  if (list.some((a) => a?.name === name && !a.hidden)) return name;
  return adminDefaultAgent(list, preferred) ?? name;
}

// The agent a tenant prompt runs on when the chat names none: the
// configured default if it is allowed, else the first allowed primary agent.
export function defaultTenantAgent(list, preferred = "") {
  const ok = tenantAgents(list);
  if (preferred && ok.some((a) => a.name === preferred)) return preferred;
  return (ok.find((a) => a.mode === "primary") ?? ok.find((a) => a.mode !== "subagent") ?? null)?.name ?? null;
}

// FEAT-03.21: the MCP servers a tenant's agent may use — the SAME set as the
// sandbox plugin's TENANT_TOOL_PREFIXES (ops/opencode/vault-cache.ts;
// tests/tenant-mcp.test.js keeps them in step). Others (playwright, lsp, any
// new server of the owner) are never shown to a tenant.
export const TENANT_MCP = ["websearch", "context7", "grep_app", "marketplace"];

// /mcp for a tenant: whitelisted servers, status only — an upstream error
// text can carry the owner's paths and commands (BUG-12.10).
export function tenantMcpView(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  const entries = Array.isArray(raw) ? raw.map((s) => [s?.name, s]) : Object.entries(raw);
  for (const [name, s] of entries) {
    if (typeof name !== "string" || !TENANT_MCP.includes(name)) continue;
    const status = typeof s === "string" ? s : s?.status;
    out[name] = { status: typeof status === "string" ? status : "unknown" };
  }
  return out;
}

// The /agent record shown to a tenant: no system prompt, no permission
// rules, no options (BUG-12.10: those describe the owner's setup).
export function publicAgent(a) {
  const out = {};
  for (const k of ["name", "description", "mode", "native", "hidden", "color", "model", "variant"]) {
    if (a?.[k] !== undefined) out[k] = a[k];
  }
  return out;
}

// FEAT-12.16: what a non-admin receives for tool calls. The server never
// sends raw commands, absolute server paths, outputs or exit codes to a
// tenant — only the tool name, its status and a compact Russian title.
// Attachments (files the agent produced for the user) are kept.
const TOOL_TITLES = {
  bash: "Выполнена команда",
  read: "Прочитан файл",
  write: "Записан файл",
  edit: "Изменён файл",
  glob: "Поиск файлов",
  grep: "Поиск по файлам",
  list: "Просмотр каталога",
  webfetch: "Загрузка страницы",
  task: "Задача агенту",
  todowrite: "Список задач",
};

export function redactPart(part) {
  if (!part || typeof part !== "object") return part;
  if (part.type === "tool") {
    const st = part.state && typeof part.state === "object" ? part.state : {};
    const state = { status: st.status, title: TOOL_TITLES[part.tool] ?? "Выполнено действие", input: {}, output: "", metadata: {} };
    if (st.time) state.time = st.time;
    if (Array.isArray(st.attachments)) state.attachments = st.attachments;
    if (st.status === "error") state.error = "Действие завершилось ошибкой";
    return { ...part, state };
  }
  if (part.type === "patch") return { ...part, files: [] };
  return part;
}

export function redactMessages(list) {
  if (!Array.isArray(list)) return list;
  return list.map((m) => (m && Array.isArray(m.parts) ? { ...m, parts: m.parts.map(redactPart) } : m));
}

// /provider for a user: claude group only when the engine is allowed, and
// only CONNECTED providers (the full catalog is ~7 MB of models nobody can
// use). Never mutates the input.
export function providerForUser(catalog, { claudeAllowed, claudeProviderID = "anthropic" }) {
  if (!catalog || typeof catalog !== "object") return catalog;
  const connected = (Array.isArray(catalog.connected) ? catalog.connected : []).filter((id) => claudeAllowed || id !== claudeProviderID);
  const all = (Array.isArray(catalog.all) ? catalog.all : []).filter((p) => connected.includes(p?.id));
  const def = {};
  for (const [k, v] of Object.entries(catalog.default ?? {})) if (connected.includes(k)) def[k] = v;
  return { ...catalog, connected, all, default: def };
}

// BUG-159: is {providerID, modelID} offered to this user? true / false, or null
// when the catalog is unknown (upstream down — the caller lets it pass: the
// empty-turn detector stays the safety net). Same view as GET /provider:
// connected providers only, claude only when its engine is allowed.
export function modelInCatalog(catalog, model, { claudeAllowed = false, claudeProviderID = "anthropic" } = {}) {
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.all)) return null;
  if (!model || typeof model.providerID !== "string" || typeof model.modelID !== "string") return false;
  const view = providerForUser(catalog, { claudeAllowed, claudeProviderID });
  const p = view.all.find((x) => x?.id === model.providerID);
  const models = p?.models;
  if (!models || typeof models !== "object") return false;
  return Array.isArray(models) ? models.some((m) => m?.id === model.modelID) : Object.hasOwn(models, model.modelID);
}

// BUG-11.13 / BUG-082: the model of a prompt that names none, in a chat that
// has no binding yet. Order: the configured default (ZAI_DEFAULT_MODEL), the
// upstream opencode config `model`, then the upstream catalog defaults of the
// connected providers. The claude engine is never picked implicitly (a claude
// chat is always created with an explicit claude model), so a tenant lands on
// the z.ai (opencode) default. Strings are "provider/model". Pure.
//   catalog: upstream /provider shape {connected, default: {provider: model}}
export function parseModelRef(ref) {
  if (ref && typeof ref === "object") {
    const providerID = typeof ref.providerID === "string" ? ref.providerID.trim() : "";
    const modelID = typeof (ref.modelID ?? ref.id) === "string" ? String(ref.modelID ?? ref.id).trim() : "";
    return providerID && modelID ? { providerID, modelID } : null;
  }
  const s = typeof ref === "string" ? ref.trim() : "";
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) };
}

export function pickDefaultModel({ preferred = "", configModel = null, catalog = null, claudeProviderID = "anthropic" } = {}) {
  const connected = Array.isArray(catalog?.connected) ? catalog.connected : null;
  const usable = (m) => m && m.providerID !== claudeProviderID && (!connected || connected.includes(m.providerID));
  for (const ref of [preferred, configModel]) {
    const m = parseModelRef(ref);
    if (usable(m)) return m;
  }
  const defs = catalog?.default && typeof catalog.default === "object" ? catalog.default : {};
  const order = connected ?? Object.keys(defs);
  for (const providerID of order) {
    const modelID = defs[providerID];
    const m = typeof modelID === "string" ? { providerID, modelID } : null;
    if (usable(m)) return m;
  }
  return null;
}
