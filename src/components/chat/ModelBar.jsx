// Model/agent pills above the composer (BRIEF-10, FEAT-11.4/11.5): the chat's
// OWN binding, not the Settings defaults. Before the first message any model
// of any engine can be picked; after it the engine is locked (opencode and
// claude histories do not cross) and the sheet lists only the chat's engine.
// Claude chats pick a portal Claude agent or «Без агента» (FEAT-13.17) — at
// any time, also after the first message; opencode names never show there
// (BUG-11.2).
// FEAT-18.4: the third pill — the chat's permission mode («Спрашивать»,
// «Правки без вопросов», «Без вопросов» — the last one admin-only); it acts
// from the next turn and cannot change while the chat is answering.
import { useState } from "preact/hooks";
import { busyMap, claudeAgents, effectivePrefs, me, providerCfg, sessions, setSessionBinding } from "../../lib/store.js";
import { PERM_MODES, bindingOf, claudeAgentName, defaultBinding, engineOf, modelName, permModeAvailable, permModeChoices, permModeOf } from "../../lib/engine.js";
import { AgentPicker, ClaudeAgentPicker, Glyph, ModelPicker, PickerSheet } from "../Pickers.jsx";
import { t } from "../../lib/i18n.js";
import ContextMeter from "./ContextMeter.jsx";

const lockNote = () => t("modelBar.lockNote");

// FEAT-18.5: messages — лента чата для строки контекста и расхода (ContextMeter).
export default function ModelBar({ sessionId, hasMessages = false, messages = null }) {
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
  const codex = b.engine === "codex"; // FEAT-18.7: у Codex-чата нет агентов
  // BUG-160: Claude agents are admin-only (GET /claude/agents → 403 for a
  // tenant; Settings tells tenants «У Claude-чатов агентов нет») — no pill.
  const tenant = Boolean(me.value?.role) && me.value.role !== "admin";
  const claudeAgentPill = claude && !tenant;
  const name = modelName(providerCfg.value, b.model);
  const agentLabel = claude ? claudeAgentName(b.agent, claudeAgents.value ?? []) ?? t("modelBar.noAgent") : null;
  const admin = !tenant;
  const showMode = permModeAvailable({ engine: b.engine, admin });
  const mode = PERM_MODES.find((x) => x.id === permModeOf(session, { admin }));
  const busy = Boolean(busyMap.value[sessionId]);

  async function pickModel(m) {
    setSheet(null);
    if (m.providerID === b.model.providerID && m.modelID === b.model.modelID) return;
    const patch = { model: m };
    // Crossing engines (only possible before the first message): the agent
    // follows the engine — the Settings default of that engine (Claude: none
    // unless the user picked one, FEAT-13.17).
    if (engineOf(m.providerID) !== b.engine) patch.agent = engineOf(m.providerID) === "claude" ? defs.claudeAgent ?? null : engineOf(m.providerID) === "codex" ? null : defs.agent ?? null;
    else if (!bound) patch.agent = b.agent;
    await setSessionBinding(sessionId, patch);
  }

  async function pickMode(id) {
    setSheet(null);
    if (id === mode.id) return;
    await setSessionBinding(sessionId, bound ? { permMode: id } : { model: b.model, agent: b.agent, permMode: id });
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
          aria-label={t("modelBar.modelLabel", { name, engine: claude ? "Claude" : codex ? "Codex" : "opencode" })}>
          <span class={"engine-dot" + (claude ? " is-claude" : codex ? " is-codex" : "")} aria-hidden="true" />
          <span class="pill-label">{name}</span>
          <span class="pill-chev"><Glyph name="chevron" size={14} /></span>
        </button>
        {claude ? (claudeAgentPill && (
          <button class="model-pill" type="button" aria-haspopup="dialog" onClick={() => setSheet("claude-agent")}
            aria-label={b.agent ? t("modelBar.claudeAgentLabel", { name: agentLabel }) : t("modelBar.claudeAgentNone")}>
            <span class="pill-label">{agentLabel}</span>
            <span class="pill-chev"><Glyph name="chevron" size={14} /></span>
          </button>
        )) : codex ? null : (
          <button class="model-pill" type="button" onClick={() => setSheet("agent")}
            aria-label={t("modelBar.agentLabel", { name: b.agent ?? t("modelBar.agentDefault") })}>
            <span class="pill-label">{b.agent ?? t("modelBar.agentPill")}</span>
            <span class="pill-chev"><Glyph name="chevron" size={14} /></span>
          </button>
        )}
        {showMode && (
          <button class={"perm-pill" + (mode.id === "ask" ? " is-ask" : "")} type="button" aria-haspopup="dialog" onClick={() => setSheet("mode")}
            aria-label={t("modelBar.modeLabel", { mode: mode.label })} title={t("modelBar.modeTitle", { mode: mode.label })}>
            <Glyph name="shield" size={15} />
            <span class="pill-label">{mode.short}</span>
          </button>
        )}
      </div>
      {!locked && (
        <div class="model-bar-note">
          {(claude && !claudeAgentPill) || codex
            ? t("modelBar.note.model")
            : claude
            ? t("modelBar.note.claude")
            : t("modelBar.note.opencode")}
        </div>
      )}
      {locked && messages && <ContextMeter messages={messages} />}
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
      {sheet === "mode" && showMode && (
        <PickerSheet title={t("modelBar.modeSheet")} onClose={() => setSheet(null)}>
          <div class="picker">
            {busy && <p class="picker-empty" role="status">{t("modelBar.modeBusy")}</p>}
            {permModeChoices({ admin, engine: b.engine }).map((m) => {
              const on = m.id === mode.id;
              return (
                <button key={m.id} type="button" class={"picker-row" + (on ? " active" : "")} aria-pressed={on ? "true" : "false"} disabled={busy}
                  onClick={() => pickMode(m.id)}>
                  <span class="picker-row-main">
                    <span class="picker-row-title">{m.label}</span>
                    <span class="picker-row-desc">{m.desc}</span>
                  </span>
                  {on && (
                    <span class="picker-check">
                      <Glyph name="check" size={18} />
                    </span>
                  )}
                </button>
              );
            })}
            <p class="picker-foot">{t("modelBar.modeFoot")}{admin ? "" : t("modelBar.modeFootTenant")}</p>
          </div>
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