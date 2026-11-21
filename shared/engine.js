// Engines behind the portal - the ONE place that knows them (ARCH-S15,
// TASK-13.13). Imported by the server (lib/binding.js, lib/claude.js) and
// meant to be re-exported by the client (src/lib/engine.js, bundled by
// esbuild), so the claude model catalog and the default model are never
// duplicated again.
//
// Pure, zero dependencies, node- and browser-importable.

export const CLAUDE_PROVIDER = "anthropic";
// FEAT-18.7: Codex CLI (подписка ChatGPT) — третий движок; ходы идут через тот же
// раннер CLI, что у Claude (lib/claude.js), программой-посредником lib/codex-shim.mjs.
export const CODEX_PROVIDER = "openai-codex";

// FEAT-20.4: antigravity — Google Antigravity ACP-сервер (бинарная поставка);
// gemini оставлен, чтобы старые чаты продолжали работать.
export const ACP_PROVIDERS = {"acp-antigravity":"antigravity","acp-gemini":"gemini","acp-github-copilot-cli":"github-copilot-cli"};

export function engineOf(providerID) {
  if (Object.hasOwn(ACP_PROVIDERS,providerID)) return "acp";
  if (providerID === CLAUDE_PROVIDER) return "claude";
  if (providerID === CODEX_PROVIDER) return "codex";
  return "opencode";
}

// FEAT-18.7: движки, ходы которых ведёт раннер CLI портала (история в сторе портала,
// очередь, мост разрешений), — в отличие от opencode serve.
export function isRunnerEngine(engine) {
  return engine === "acp" || engine === "claude" || engine === "codex";
}

// FEAT-18.7: движок раннера для модели хода или null (opencode).
export function runnerEngineOfModel(model) {
  const e = engineOf(model?.providerID);
  return isRunnerEngine(e) ? e : null;
}

// FEAT-18.7: id модели Codex, который может уйти в аргумент посредника: простые id
// из model/list, ничего похожего на опцию CLI.
const CODEX_MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
export function isCodexModelId(id) {
  return typeof id === "string" && CODEX_MODEL_ID_RE.test(id);
}

// FEAT-18.7: каталог Codex из ответа model/list app-server (lib/codex-catalog.js):
// [{id, name, context, isDefault}], скрытые и негодные отброшены, основная модель —
// первой (по ней новый Codex-чат). null, если ничего не осталось. Окно контекста
// model/list не сообщает — 475000 (thread/tokenUsage/updated, спайк 2026-11-15);
// точное значение приходит в расходе хода.
export const CODEX_DEFAULT_CONTEXT = 475_000;
export function normalizeCodexCatalog(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const m of list) {
    const id = typeof m?.id === "string" ? m.id.trim() : typeof m?.model === "string" ? m.model.trim() : "";
    if (!isCodexModelId(id) || seen.has(id) || m.hidden === true) continue;
    seen.add(id);
    const name = typeof m.displayName === "string" && m.displayName.trim() ? m.displayName.trim() : typeof m.name === "string" && m.name.trim() ? m.name.trim() : id;
    const context = Number(m.context);
    out.push({ id, name, context: Number.isFinite(context) && context > 0 ? context : CODEX_DEFAULT_CONTEXT, isDefault: m.isDefault === true });
  }
  out.sort((x, y) => Number(y.isDefault) - Number(x.isDefault));
  return out.length > 0 ? out : null;
}

// Claude models of the subscription, freshest Opus first (FEAT-11.10). The
// lineup and each context window mirror what claude CLI reports for the
// account (modelUsage.contextWindow, CLI 2.1.322, probed 2026-11-10, FEAT-11.17).
// The server may override it without a code change: data/claude-models.json
// (see ClaudeRunner, loadClaudeCatalog) - same shape, an array of entries.
export const CLAUDE_MODELS = Object.freeze([
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", context: 1_000_000 },
  { id: "claude-opus-5", name: "Claude Opus 5", context: 1_000_000 },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", context: 1_000_000 },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", context: 1_000_000 },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", context: 1_000_000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context: 200_000 },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", context: 200_000 },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", context: 1_000_000 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", context: 200_000 },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", context: 1_000_000 },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", context: 1_000_000 },
  { id: "claude-fable-5", name: "Claude Fable 5", context: 1_000_000 },
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
