// Engines behind the portal (2026-11-02): opencode serve (GLM on the z.ai
// Coding Plan, opencode agents — «Sisyphus - ultraworker» by default) and the
// claude CLI (Claude subscription, provider "anthropic", the portal's own
// Claude agents — none by default, FEAT-13.17). Every
// chat is bound to one engine + model (+ agent) on the server
// (lib/binding.js); the client reads that binding from the session record's
// `teleharness` field and never routes by the Settings defaults (BUG-11.1).
// Pure, node-importable. The engine identity and the claude catalog live in
// shared/engine.js (TASK-13.13) — one source for server and client.
export { CLAUDE_PROVIDER, CLAUDE_MODELS, CODEX_PROVIDER, DEFAULT_CLAUDE_MODEL, engineOf, isClaudeAgentId, isClaudeModel, isRunnerEngine } from "../../shared/engine.js";
import { CLAUDE_MODELS, engineOf, isClaudeAgentId, isRunnerEngine } from "../../shared/engine.js";
import { t } from "./i18n.js";

// A claude chat's agent: a Claude-agent id or null — an opencode agent name
// («Sisyphus - ultraworker») never passes (BUG-11.2).
const claudeAgent = (a) => (isClaudeAgentId(a) ? a : null);

export const ENGINE_LABEL = {
  opencode: "opencode",
  get claude() {
    return t("engine.label.claude");
  },
  get codex() {
    return t("engine.label.codex");
  },
  acp: "ACP",
};
export const ENGINE_SHORT = { opencode: "z.ai", claude: "Claude", codex: "Codex", acp: "ACP" };

export function engineShortOf(providerID) {
  if (providerID === "acp-antigravity") return "Gemini";
  if (providerID === "acp-github-copilot-cli") return "Copilot";
  return ENGINE_SHORT[engineOf(providerID)] ?? "";
}

function pickModel(m) {
  const providerID = typeof m?.providerID === "string" ? m.providerID : "";
  const raw = m?.modelID ?? m?.id;
  const modelID = typeof raw === "string" ? raw : "";
  return providerID && modelID ? { providerID, modelID } : null;
}

// FEAT-01.29 / review 212 (N-1): a message sent during a turn — Claude queues
// it until the turn ends; opencode weaves it into the running turn (the agent
// reads it at its next step). The labels must not promise opencode a queue.
export function queuedLabel(engine) {
  return isRunnerEngine(engine) ? t("engine.queued.claude") : t("engine.queued.opencode");
}
export function queuedSendLabel(engine) {
  return isRunnerEngine(engine) ? t("engine.queuedSend.claude") : t("engine.queuedSend.opencode");
}

// The chat's binding: the server's `teleharness` record first; fallback for records
// without it (mock fixtures, a pre-binding server) = what opencode itself
// remembered on the session (model/agent appear after its first turn).
export function bindingOf(session) {
  const z = session?.teleharness;
  const zm = pickModel(z?.model);
  if (zm) {
    const engine = engineOf(zm.providerID);
    return { engine, model: zm, agent: (engine === "claude" || zm.providerID === "acp-antigravity" || engine === "codex") ? claudeAgent(z.agent) : engine === "acp" ? null : z.agent ?? null, prompted: Boolean(z.prompted) };
  }
  const um = pickModel(session?.model);
  if (um) {
    const engine = engineOf(um.providerID);
    return { engine, model: um, agent: isRunnerEngine(engine) ? null : session.agent ?? null, prompted: true };
  }
  return null;
}

// FEAT-18.4: the chat's permission mode (server: lib/binding.js permMode).
// Admin chats default to «Без вопросов», a tenant's to «Правки без вопросов»
// (the behaviour before the switch); «Без вопросов» is admin-only.
export const PERM_MODES = [
  { id: "ask" },
  { id: "edits" },
  { id: "full" },
].map((m) => Object.defineProperties(m, {
  label: { get: () => t(`perm.${m.id}.label`), enumerable: true },
  short: { get: () => t(`perm.${m.id}.short`), enumerable: true },
  desc: { get: () => t(`perm.${m.id}.desc`), enumerable: true },
}));
export function permModeOf(session, { admin = false } = {}) {
  const m = PERM_MODES.some((x) => x.id === session?.teleharness?.permMode) ? session.teleharness.permMode : null;
  if (m === "full" && !admin) return "edits";
  return m ?? (admin ? "full" : "edits");
}
// FEAT-18.7: Codex-чат — только «Спрашивать» и «Без вопросов».
export function permModeChoices({ admin = false, engine = null } = {}) {
  const list = admin ? PERM_MODES : PERM_MODES.filter((x) => x.id !== "full");
  return engine === "codex" || engine === "acp" ? list.filter((x) => x.id !== "edits") : list;
}
// Claude chats: every user; opencode chats: admin only (the server overrides
// session rules on the 2.x API only — a tenant's Sandbox rules stay).
export function permModeAvailable({ engine, admin = false } = {}) {
  return isRunnerEngine(engine) || (engine === "opencode" && admin); // FEAT-18.7: Codex — как Claude
}

// A new chat's binding from the Settings defaults (prefs {model, agent,
// claudeAgent}): a Claude model takes the Claude agent default (null =
// «Без агента» unless the user picked one, FEAT-13.17).
export function defaultBinding(prefs) {
  const m = pickModel(prefs?.model);
  if (!m) return null;
  const engine = engineOf(m.providerID);
  return { engine, model: m, agent: (engine === "claude" || m.providerID === "acp-antigravity") ? claudeAgent(prefs?.claudeAgent) : engine === "codex" ? claudeAgent(prefs?.codexAgent) : engine === "acp" ? null : prefs?.agent ?? null, prompted: false };
}

// Display name of a Claude agent id from the catalog ([{id, name}]); the id
// itself while the catalog loads; null for none.
export function claudeAgentName(id, catalog = []) {
  if (!id) return null;
  return (Array.isArray(catalog) ? catalog : []).find((a) => a?.id === id)?.name ?? id;
}

// Tokens that are acronyms in model ids (glm-5.3-flash → GLM-5.3-Flash).
const MODEL_ACRONYMS = new Set(["glm", "gpt", "oss", "vl", "llm", "ai"]);

// Human face of a bare model id while the catalog is not loaded yet
// (ISSUE-008: the pill flashed the raw «glm-5.3-flash» for ~3.5 s after a
// reload). Known ids (the claude catalog) use their real name; anything else
// is formatted token by token: acronyms upper-cased, words capitalized,
// numbers and separators kept as they are.
export function prettyModelId(modelID) {
  const id = String(modelID ?? "").trim();
  if (!id) return "";
  const known = CLAUDE_MODELS.find((m) => m.id === id);
  if (known) return known.name;
  return id.replace(/[A-Za-z]+/g, (w) => {
    const low = w.toLowerCase();
    if (MODEL_ACRONYMS.has(low)) return low.toUpperCase();
    return w === low ? low[0].toUpperCase() + low.slice(1) : w;
  });
}

// Provider catalogs are huge; only models the server reports as connected and
// active are selectable. With no connected list, everything active shows.
function connectedModels(cfg) {
  const connected = Array.isArray(cfg?.connected) ? cfg.connected : [];
  return (cfg?.models ?? []).filter(
    (m) => m?.enabled !== false && (m.status ?? "active") === "active" && (connected.length === 0 || connected.includes(m.providerID)),
  );
}

// FEAT-11.23: автоподгрузка моделей opencode — жёсткий белый список на клиенте
// снят: доступность провайдеров и моделей управляется конфигом opencode и
// серверной политикой (lib/policy.js). WORKING_MODELS оставлен для совместимости
// импортов; workingModels возвращает все активные модели подключённых провайдеров.
export const WORKING_MODELS = {
  "zai-coding-plan": null,
  opencode: null,
  zai: null,
  anthropic: null,
  "acp-antigravity": null,
  "acp-gemini": null,
  "acp-github-copilot-cli": null,
  "openai-codex": null,
};

export const OPENCODE_PROVIDER_LABELS = Object.freeze({
  "zai-coding-plan": "Z.AI Coding Plan",
  opencode: "OpenCode",
  zai: "Z.AI",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  openai: "OpenAI",
  google: "Google Gemini",
  xai: "xAI",
  moonshotai: "Moonshot (Kimi)",
});

export function opencodeProviderName(providerID, providers = null) {
  const custom = providers && typeof providers[providerID] === "string" ? providers[providerID].trim() : "";
  if (custom) return custom;
  return OPENCODE_PROVIDER_LABELS[providerID] ?? prettyModelId(providerID);
}

export function workingModels(cfg, { keep = null } = {}) {
  const base = connectedModels(cfg);
  // The chat's current model stays visible (with its check) even if filtered.
  if (keep?.modelID && !base.some((m) => m.providerID === keep.providerID && m.id === keep.modelID)) {
    const cur = (cfg?.models ?? []).find((m) => m.providerID === keep.providerID && m.id === keep.modelID);
    if (cur) return [...base, cur];
  }
  return base;
}

// BUG-137: is a saved model still in the working list? null = cannot tell
// (catalog not loaded, or it carries no model of that engine — the Claude
// catalog may come separately).
export function modelAvailable(model, cfg) {
  if (!model?.modelID || !Array.isArray(cfg?.models) || cfg.models.length === 0) return null;
  const pool = workingModels(cfg);
  const engine = engineOf(model.providerID);
  if (!pool.some((m) => engineOf(m.providerID) === engine)) return null;
  return pool.some((m) => m.providerID === model.providerID && m.id === model.modelID);
}

// Human model name from the normalized catalog ({id, providerID, label});
// falls back to a formatted id (prettyModelId) while the catalog loads.
export const ACP_PROVIDER_LABELS = Object.freeze({
  "acp-antigravity": "Google Antigravity",
  "acp-github-copilot-cli": "GitHub Copilot CLI",
});

export function acpProviderName(providerID) {
  return ACP_PROVIDER_LABELS[providerID] ?? prettyModelId(String(providerID ?? "").replace(/^acp-/, ""));
}

export function modelName(cfg, model) {
  if (!model) return "";
  const hit = (cfg?.models ?? []).find((m) => m.providerID === model.providerID && m.id === model.modelID);
  if (!hit?.label) {
    if (ACP_PROVIDER_LABELS[model.modelID]) return ACP_PROVIDER_LABELS[model.modelID];
    return prettyModelId(model.modelID);
  }
  const suffix = ` (${hit.providerID})`;
  return hit.label.endsWith(suffix) ? hit.label.slice(0, -suffix.length) : hit.label;
}

// Chat header line: opencode «agent · model», claude «model · <agent>» or
// «model · Claude Code» without one (never the opencode default, BUG-11.2).
// claudeAgents: the Claude agents catalog for the display name.
export function bindingLine(binding, cfg, claudeAgents = []) {
  if (!binding) return "";
  const name = modelName(cfg, binding.model);
  if (binding.engine === "claude") return `${name} · ${claudeAgentName(claudeAgent(binding.agent), claudeAgents) ?? "Claude Code"}`;
  if (binding.model?.providerID === "acp-antigravity") return `${name} · ${claudeAgentName(claudeAgent(binding.agent), claudeAgents) ?? "Gemini"}`;
  if (binding.engine === "acp") return `${name} · ${binding.model?.providerID === "acp-github-copilot-cli" ? "Copilot" : "ACP"}`;
  if (binding.engine === "codex") return `${name} · ${claudeAgentName(claudeAgent(binding.agent), claudeAgents) ?? "Codex"}`;
  return [binding.agent, name].filter(Boolean).join(" · ");
}