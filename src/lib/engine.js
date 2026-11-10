// Engines behind the portal (2026-11-02): opencode serve (GLM on the z.ai
// Coding Plan, opencode agents — «Sisyphus - ultraworker» by default) and the
// claude CLI (Claude subscription, provider "anthropic", the portal's own
// Claude agents — none by default, FEAT-13.17). Every
// chat is bound to one engine + model (+ agent) on the server
// (lib/binding.js); the client reads that binding from the session record's
// `zai` field and never routes by the Settings defaults (BUG-11.1).
// Pure, node-importable. The engine identity and the claude catalog live in
// shared/engine.js (TASK-13.13) — one source for server and client.
export { CLAUDE_PROVIDER, CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, engineOf, isClaudeAgentId, isClaudeModel } from "../../shared/engine.js";
import { CLAUDE_MODELS, engineOf, isClaudeAgentId } from "../../shared/engine.js";
import { t } from "./i18n.js";

// A claude chat's agent: a Claude-agent id or null — an opencode agent name
// («Sisyphus - ultraworker») never passes (BUG-11.2).
const claudeAgent = (a) => (isClaudeAgentId(a) ? a : null);

export const ENGINE_LABEL = {
  opencode: "z.ai · opencode",
  get claude() {
    return t("engine.label.claude");
  },
};
export const ENGINE_SHORT = { opencode: "z.ai", claude: "Claude" };

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
  return engine === "claude" ? t("engine.queued.claude") : t("engine.queued.opencode");
}
export function queuedSendLabel(engine) {
  return engine === "claude" ? t("engine.queuedSend.claude") : t("engine.queuedSend.opencode");
}

// The chat's binding: the server's `zai` record first; fallback for records
// without it (mock fixtures, a pre-binding server) = what opencode itself
// remembered on the session (model/agent appear after its first turn).
export function bindingOf(session) {
  const z = session?.zai;
  const zm = pickModel(z?.model);
  if (zm) {
    const engine = engineOf(zm.providerID);
    return { engine, model: zm, agent: engine === "claude" ? claudeAgent(z.agent) : z.agent ?? null, prompted: Boolean(z.prompted) };
  }
  const um = pickModel(session?.model);
  if (um) {
    const engine = engineOf(um.providerID);
    return { engine, model: um, agent: engine === "claude" ? null : session.agent ?? null, prompted: true };
  }
  return null;
}

// A new chat's binding from the Settings defaults (prefs {model, agent,
// claudeAgent}): a Claude model takes the Claude agent default (null =
// «Без агента» unless the user picked one, FEAT-13.17).
export function defaultBinding(prefs) {
  const m = pickModel(prefs?.model);
  if (!m) return null;
  const engine = engineOf(m.providerID);
  return { engine, model: m, agent: engine === "claude" ? claudeAgent(prefs?.claudeAgent) : prefs?.agent ?? null, prompted: false };
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
    (m) => (m.status ?? "active") === "active" && (connected.length === 0 || connected.includes(m.providerID)),
  );
}

// FEAT-03.2: «connected» is not «works on my token». Of the opencode
// providers only the z.ai Coding Plan is paid by the user's token; the
// pay-per-token `zai` API contributes just its vision model (the plan has
// none), and the free `opencode` provider (Zen «*-free» models, big-pickle)
// is not on the token at all. List from BRIEF-09 / pickers.html (PK-3):
// GLM-5.3-Flash, GLM-5.3, GLM-5.3 Highspeed, GLM-5V-Turbo. null = every
// active model of that provider. Claude models come from the portal's own
// claude CLI catalog (server-side, Г3) and are all kept.
export const WORKING_MODELS = {
  "zai-coding-plan": null,
  zai: ["glm-5v-turbo"],
  anthropic: null,
};

export function workingModels(cfg, { keep = null } = {}) {
  const pool = connectedModels(cfg);
  const ok = pool.filter((m) => {
    if (!(m.providerID in WORKING_MODELS)) return false;
    const allow = WORKING_MODELS[m.providerID];
    return allow == null || allow.includes(m.id);
  });
  // Unknown catalog (other plan, mock without these providers): never show an
  // empty sheet — fall back to everything connected.
  const opencodeOk = ok.some((m) => engineOf(m.providerID) === "opencode");
  const base = opencodeOk ? ok : [...pool.filter((m) => engineOf(m.providerID) === "opencode"), ...ok];
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
export function modelName(cfg, model) {
  if (!model) return "";
  const hit = (cfg?.models ?? []).find((m) => m.providerID === model.providerID && m.id === model.modelID);
  if (!hit?.label) return prettyModelId(model.modelID);
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
  return [binding.agent, name].filter(Boolean).join(" · ");
}