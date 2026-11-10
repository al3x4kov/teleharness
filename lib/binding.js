// Chat binding: which ENGINE (opencode serve / claude CLI), MODEL and AGENT a
// chat runs on. Since 2026-11-02 the portal fronts two engines and the
// server used to pick one from the prompt body's model.providerID — the body
// carried the GLOBAL default from Настройки, so changing the default switched
// every open z.ai chat to Claude (BUG-11.1 / tracker BUG-004). The binding is
// now the server-side source of truth: the prompt body is coerced to it.
//
// Resolution order for a chat (resolveBinding):
//   1. stored record (data/session-bindings.json) — created with the chat or
//      frozen on its first prompt;
//   2. upstream session.model/agent — opencode remembers what it ran; wins
//      over claude history so chats polluted by BUG-11.1 return to their own
//      z.ai model;
//   3. claude-store history — the chat only ever ran claude turns;
//   4. null — nothing known yet; the first prompt's body becomes the binding.
//
// Zero runtime dependencies - node stdlib only.
import { CLAUDE_PROVIDER, DEFAULT_CLAUDE_MODEL, engineOf } from "../shared/engine.js";
import { readJsonStore, writeJsonAtomic } from "./json-store.js";

// Engine knowledge lives in shared/engine.js (TASK-13.13); re-exported for
// existing importers.
export { CLAUDE_PROVIDER, DEFAULT_CLAUDE_MODEL, engineOf };

// {providerID, modelID} from either the portal shape {providerID, modelID} or
// the upstream session shape {providerID, id}; null when incomplete.
export function cleanModel(m) {
  if (!m || typeof m !== "object") return null;
  const providerID = typeof m.providerID === "string" ? m.providerID.trim() : "";
  const raw = m.modelID ?? m.id;
  const modelID = typeof raw === "string" ? raw.trim() : "";
  return providerID && modelID ? { providerID, modelID } : null;
}

// The canonical record. A claude chat's agent is a Claude-agent id of the
// portal catalog (FEAT-13.17) or null: it survives only when claudeAgentOk
// says so (server.js injects the catalog check). Default validator = none →
// always null, the pre-catalog behaviour; opencode agent names («Sisyphus -
// ultraworker») never pass it (BUG-11.2).
const noClaudeAgents = () => false;

export function makeBinding({ model, agent } = {}, { prompted = false, claudeAgentOk = noClaudeAgents } = {}) {
  const m = cleanModel(model);
  if (!m) return null;
  const engine = engineOf(m.providerID);
  const name = typeof agent === "string" && agent.trim() ? agent.trim() : null;
  const a = engine === "claude" ? (name && claudeAgentOk(name) ? name : null) : name;
  return { engine, model: m, agent: a, prompted: Boolean(prompted) };
}

// Pure. stored: the store record or undefined; session: the upstream session
// record (may be null); claudeKnown/claudeModelID: what the claude store
// knows about the chat. Returns a binding + source, or null.
// claudeAgentOk: validator for a STORED claude agent (server.js: id format —
// an agent gone from the catalog is detected at the next turn, which resets
// it with a notice). Chats without a record never get an agent implicitly.
export function resolveBinding({ stored, session, claudeKnown = false, claudeModelID = null, claudeAgentOk = noClaudeAgents } = {}) {
  const fromStore = stored ? makeBinding(stored, { prompted: stored.prompted, claudeAgentOk }) : null;
  if (fromStore) return { ...fromStore, source: "stored" };
  const fromUpstream = cleanModel(session?.model)
    ? makeBinding({ model: session.model, agent: session.agent }, { prompted: true })
    : null;
  if (fromUpstream) return { ...fromUpstream, source: "upstream" };
  if (claudeKnown) {
    const b = makeBinding({ model: { providerID: CLAUDE_PROVIDER, modelID: claudeModelID || DEFAULT_CLAUDE_MODEL } }, { prompted: true });
    return { ...b, source: "claude" };
  }
  return null;
}

// Pure: the prompt body coerced to the binding. The model always comes from
// the binding; claude prompts never carry an agent in the body (the claude
// agent rides the binding straight into the runner, FEAT-13.17); an opencode binding
// without an agent keeps whatever the body asked for (opencode default).
export function applyBinding(body, binding) {
  const out = { ...(body && typeof body === "object" ? body : {}) };
  if (!binding) return out;
  out.model = { providerID: binding.model.providerID, modelID: binding.model.modelID };
  if (binding.engine === "claude") delete out.agent;
  else if (binding.agent) out.agent = binding.agent;
  return out;
}

// Pure: validate a PATCH {model?, agent?} against the current binding.
// → { binding } | { status, error }. The engine is locked once the chat has
// been prompted (opencode and claude histories do not cross engines); the
// agent may change at any time on both engines (FEAT-13.17: claude agents
// act from the next turn of the same claude session).
export function patchBinding(current, patch, { claudeAgentOk = noClaudeAgents } = {}) {
  const p = patch && typeof patch === "object" ? patch : {};
  const hasModel = Object.prototype.hasOwnProperty.call(p, "model");
  const hasAgent = Object.prototype.hasOwnProperty.call(p, "agent");
  if (!hasModel && !hasAgent) return { status: 400, error: "nothing to change" };
  const model = hasModel ? cleanModel(p.model) : current?.model ?? null;
  if (!model) return { status: 400, error: hasModel ? "bad model" : "chat has no model yet" };
  if (hasAgent && p.agent !== null && typeof p.agent !== "string") return { status: 400, error: "bad agent" };
  const engine = engineOf(model.providerID);
  if (current?.prompted && current.engine !== engine) {
    return { status: 409, error: "engine locked: the chat already has messages on another engine" };
  }
  // Switching engine in an empty chat without naming an agent: the old
  // engine's agent does not carry over (→ null; the client names the new
  // engine's default).
  const agent = hasAgent ? p.agent : current && current.engine === engine ? current.agent : null;
  return { binding: makeBinding({ model, agent }, { prompted: current?.prompted ?? false, claudeAgentOk }) };
}

// The persisted shape (no derived fields).
function record(binding) {
  return {
    engine: binding.engine,
    model: { providerID: binding.model.providerID, modelID: binding.model.modelID },
    agent: binding.agent ?? null,
    prompted: Boolean(binding.prompted),
    at: Date.now(),
  };
}

export class BindingStore {
  #path;
  #data = { version: 1, sessions: {} };

  constructor({ storePath }) {
    this.#path = storePath;
    // missing: start empty (inference covers old chats); corrupt: moved aside
    // to .corrupt-<ts> first, so the next write cannot destroy it.
    this.#data = readJsonStore(storePath, {
      fallback: () => ({ version: 1, sessions: {} }),
      validate: (raw) => Boolean(raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object"),
    });
  }

  get(sid) {
    const r = this.#data.sessions[sid];
    return r ? { ...r, model: { ...r.model } } : undefined;
  }

  set(sid, binding) {
    if (!sid || !binding?.model) return;
    this.#data.sessions[sid] = record(binding);
    this.#flush();
  }

  forget(sid) {
    if (!(sid in this.#data.sessions)) return;
    delete this.#data.sessions[sid];
    this.#flush();
  }

  size() {
    return Object.keys(this.#data.sessions).length;
  }

  // Atomic replace: a crash mid-write must never leave half a JSON (the
  // routing of every chat depends on this file).
  #flush() {
    writeJsonAtomic(this.#path, this.#data);
  }
}