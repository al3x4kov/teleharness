// Engines behind the portal - the ONE place that knows them (ARCH-S15,
// TASK-13.13). Imported by the server (lib/binding.js, lib/claude.js) and
// meant to be re-exported by the client (src/lib/engine.js, bundled by
// esbuild), so the claude model catalog and the default model are never
// duplicated again.
//
// Pure, zero dependencies, node- and browser-importable.

export const CLAUDE_PROVIDER = "anthropic";

export function engineOf(providerID) {
  return providerID === CLAUDE_PROVIDER ? "claude" : "opencode";
}

// Claude models of the subscription, freshest Opus first (FEAT-11.10). The
// lineup mirrors the account's live /v1/models list (checked 2026-11-02).
// The server may override it without a code change: data/claude-models.json
// (see ClaudeRunner, loadClaudeCatalog) - same shape, an array of entries.
export const CLAUDE_MODELS = Object.freeze([
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", context: 200_000 },
  { id: "claude-opus-5", name: "Claude Opus 5", context: 200_000 },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", context: 200_000 },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", context: 200_000 },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", context: 200_000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context: 200_000 },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", context: 200_000 },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", context: 200_000 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", context: 200_000 },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", context: 200_000 },
  { id: "claude-fable-5", name: "Claude Fable 5", context: 200_000 },
]);

// Default for new claude chats and for claude-only chats without a recorded
// model: the freshest Opus (tops the anthropic group in the picker).
export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODELS[0].id;

// A model id the claude CLI may receive: plain catalog-like ids only, never
// anything that could be parsed as a CLI option.
const MODEL_ID_RE = /^claude-[a-z0-9][a-z0-9.-]*$/i;

// Normalizes a catalog candidate (file override or built-in): keeps valid
// entries, drops junk; null when nothing usable is left.
export function normalizeCatalog(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const m of list) {
    const id = typeof m?.id === "string" ? m.id.trim() : "";
    if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const context = Number(m.context);
    out.push({ id, name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : id, context: Number.isFinite(context) && context > 0 ? context : 200_000 });
  }
  return out.length > 0 ? out : null;
}

export function isClaudeModel(modelID, catalog = CLAUDE_MODELS) {
  return typeof modelID === "string" && catalog.some((m) => m.id === modelID);
}

// Claude agent ids of the portal catalog (FEAT-13.17, lib/claude-agents.js):
// the file name, the key in `--agents` and the value of `--agent` — never
// anything that could be parsed as a CLI option. opencode agent names
// («Sisyphus - ultraworker») never match, so they cannot reach a claude chat.
export const CLAUDE_AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function isClaudeAgentId(id) {
  return typeof id === "string" && CLAUDE_AGENT_ID.test(id);
}
