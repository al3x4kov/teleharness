// Model/agent pills above the composer (BRIEF-10, FEAT-11.4/11.5): the chat's
// OWN binding, not the Settings defaults. Before the first message any model
// of any engine can be picked; after it the engine is locked (opencode and
// claude histories do not cross) and the sheet lists only the chat's engine.
// Claude chats pick a portal Claude agent or «Без агента» (FEAT-13.17) — at
// any time, also after the first message; opencode names never show there
// (BUG-11.2).
import { useState } from "preact/hooks";
import { claudeAgents, effectivePrefs, me, providerCfg, sessions, setSessionBinding } from "../../lib/store.js";
import { bindingOf, claudeAgentName, defaultBinding, engineOf, modelName } from "../../lib/engine.js";
import { AgentPicker, ClaudeAgentPicker, Glyph, ModelPicker, PickerSheet } from "../Pickers.jsx";
import { t } from "../../lib/i18n.js";

const lockNote = () => t("modelBar.lockNote");

export default function ModelBar({ sessionId, hasMessages = false }) {
  const [sheet, setSheet] = useState(null); // "model" | "agent" | null
  const session = sessions.value.find((s) => s.id === sessionId);
  if (!session) return null;
  const bound = bindingOf(session);
  // A chat nobody has bound yet (created by a pre-binding client or the CLI)
  // will bind to the defaults on its first prompt — show exactly that.
  // effectivePrefs (ISSUE-001): what this user may really run.
  const defs = effectivePrefs();
  const b = bound ?? defaultBinding(defs);
  if (!b) return null;
  const locked = Boolean(bound?.prompted) || hasMessages;
  const claude = b.engine === "claude";
  // BUG-160: Claude agents are admin-only (GET /claude/agents → 403 for a
  // tenant; Settings tells tenants «У Claude-чатов агентов нет») — no pill.
  const tenant = Boolean(me.value?.role) && me.value.role !== "admin";
  const claudeAgentPill = claude && !tenant;
  const name = modelName(providerCfg.value, b.model);
  const agentLabel = claude ? claudeAgentName(b.agent, claudeAgents.value ?? []) ?? t("modelBar.noAgent") : null;

  async function pickModel(m) {
    setSheet(null);
    if (m.providerID === b.model.providerID && m.modelID === b.model.modelID) return;
    const patch = { model: m };
    // Crossing engines (only possible before the first message): the agent
    // follows the engine — the Settings default of that engine (Claude: none
    // unless the user picked one, FEAT-13.17).
    if (engineOf(m.providerID) !== b.engine) patch.agent = engineOf(m.providerID) === "claude" ? defs.claudeAgent ?? null : defs.agent ?? null;
    else if (!bound) patch.agent = b.agent;
    await setSessionBinding(sessionId, patch);
  }

  async function pickAgent(a) {
    setSheet(null);
    if (a === b.agent) return;
    await setSessionBinding(sessionId, bound ? { agent: a } : { model: b.model, agent: a });
  }

  return (
    <div class="model-bar">
      {/* BUG-105: обе пилюли — одной строкой (на 402 px имя режется многоточием). */}
      <div class="model-pills">
        <button class="model-pill" type="button" onClick={() => setSheet("model")}
          aria-label={t("modelBar.modelLabel", { name, engine: claude ? "Claude" : "opencode" })}>
          <span class={"engine-dot" + (claude ? " is-claude" : "")} aria-hidden="true" />
          <span class="pill-label">{name}</span>
          <span class="pill-chev"><Glyph name="chevron" size={14} /></span>
        </button>
        {claude ? (claudeAgentPill && (
          <button class="model-pill" type="button" aria-haspopup="dialog" onClick={() => setSheet("claude-agent")}
            aria-label={b.agent ? t("modelBar.claudeAgentLabel", { name: agentLabel }) : t("modelBar.claudeAgentNone")}>
            <span class="pill-label">{agentLabel}</span>
            <span class="pill-chev"><Glyph name="chevron" size={14} /></span>
          </button>
        )) : (
          <button class="model-pill" type="button" onClick={() => setSheet("agent")}
            aria-label={t("modelBar.agentLabel", { name: b.agent ?? t("modelBar.agentDefault") })}>
            <span class="pill-label">{b.agent ?? t("modelBar.agentPill")}</span>
            <span class="pill-chev"><Glyph name="chevron" size={14} /></span>
          </button>
        )}
      </div>
      {!locked && (
        <div class="model-bar-note">
          {claude && !claudeAgentPill
            ? t("modelBar.note.model")
            : claude
            ? t("modelBar.note.claude")
            : t("modelBar.note.opencode")}
        </div>
      )}
      {sheet === "model" && (
        <PickerSheet title={t("modelBar.modelSheet")} onClose={() => setSheet(null)}>
          <ModelPicker value={b.model} engine={locked ? b.engine : null} note={locked ? lockNote() : null} onPick={pickModel} />
        </PickerSheet>
      )}
      {sheet === "claude-agent" && claudeAgentPill && (
        <PickerSheet title={t("modelBar.agentSheet")} onClose={() => setSheet(null)}>
          <ClaudeAgentPicker value={b.agent} onPick={pickAgent} />
        </PickerSheet>
      )}
      {sheet === "agent" && (
        <PickerSheet title={t("modelBar.agentSheet")} onClose={() => setSheet(null)}>
          <AgentPicker value={b.agent} onPick={pickAgent} />
        </PickerSheet>
      )}
    </div>
  );
}