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
import { PlanFirstToggle } from "./ChatReview.jsx"; // FEAT-20.1

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
  const acp = b.engine === "acp";
  const gemini = b.model.providerID === "acp-antigravity";
  const codex = b.engine === "codex";
  // BUG-160: Claude agents are admin-only (GET /claude/agents → 403 for a
  // tenant; Settings tells tenants «У Claude-чатов агентов нет») — no pill.
  const tenant = Boolean(me.value?.role) && me.value.role !== "admin";
  const claudeAgentPill = (claude || codex || gemini) && !tenant;
  const roleEngine = gemini ? "Gemini" : codex ? "Codex" : "Claude";
  const name = modelName(providerCfg.value, b.model);
  const agentLabel = (claude || codex || gemini) ? claudeAgentName(b.agent, claudeAgents.value ?? []) ?? t("modelBar.noAgent") : null;
  const admin = !tenant;
  const showMode = permModeAvailable({ engine: b.engine, admin });
  const rawModeId = permModeOf(session, { admin });
  const mode = PERM_MODES.find((x) => x.id === ((codex || acp) && rawModeId === "edits" ? "ask" : rawModeId));
  const busy = Boolean(busyMap.value[sessionId]);
  const planFirst = session?.teleharness?.planFirst === true; // FEAT-20.1

  async function pickModel(m) {
    setSheet(null);
    if (m.providerID === b.model.providerID && m.modelID === b.model.modelID) return;
    const patch = { model: m };
    // Crossing engines (only possible before the first message): the agent
    // follows the engine — the Settings default of that engine (Claude: none
    // unless the user picked one, FEAT-13.17).
    if (engineOf(m.providerID) !== b.engine) patch.agent = (m.providerID === "acp-antigravity" || engineOf(m.providerID) === "claude") ? defs.claudeAgent ?? null : engineOf(m.providerID) === "codex" ? defs.codexAgent ?? null : engineOf(m.providerID) === "acp" ? null : defs.agent ?? null;
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
          aria-label={t("modelBar.modelLabel", { name, engine: claude ? "Claude" : codex ? "Codex" : gemini ? "Gemini" : acp ? "ACP" : "opencode" })}>
          <span class={"engine-dot" + (claude ? " is-claude" : codex ? " is-codex" : acp ? " is-acp" : "")} aria-hidden="true" />
          <span class="pill-label">{name}</span>
          <span class="pill-chev"><Glyph name="chevron" size={14} /></span>
        </button>
        {(claude || codex || acp) ? (claudeAgentPill && (
          <button class="model-pill" type="button" aria-haspopup="dialog" onClick={() => setSheet("claude-agent")}
            aria-label={b.agent ? t("modelBar.claudeAgentLabel", { engine: roleEngine, name: agentLabel }) : t("modelBar.claudeAgentNone", { engine: roleEngine })}>
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
        {showMode ? (
          <button class={"perm-pill" + (mode.id === "ask" ? " is-ask" : "")} type="button" aria-haspopup="dialog" onClick={() => setSheet("mode")}
            aria-label={t(planFirst ? "modelBar.modeLabelPlan" : "modelBar.modeLabel", { mode: mode.label })} title={t("modelBar.modeTitle", { mode: mode.label })}>
            <Glyph name="shield" size={15} />
            <span class="pill-label">{planFirst ? t("modelBar.planPrefix") : ""}{mode.short}</span>
          </button>
        ) : (
          /* FEAT-20.1: у тенанта opencode режима прав нет — пилюля ведёт к «Сначала план» (недоступно с причиной, T-23) */
          <button class="perm-pill" type="button" aria-haspopup="dialog" onClick={() => setSheet("mode")} aria-label={t("modelBar.planUnavailableLabel")}>
            <Glyph name="shield" size={15} />
            <span class="pill-label">{t("modelBar.planShort")}</span>
          </button>
        )}
      </div>
      {!locked && (
        <div class="model-bar-note">
          {(claude || codex || acp) && !claudeAgentPill
            ? t("modelBar.note.model")
            : (claude || codex || gemini)
            ? t("modelBar.note.claude", { engine: roleEngine })
            : t("modelBar.note.opencode")}
        </div>
      )}
      {locked && messages && <ContextMeter messages={messages} sid={sessionId} />}
      {sheet === "model" && (
        <PickerSheet title={t("modelBar.modelSheet")} onClose={() => setSheet(null)}>
          <ModelPicker value={b.model} engine={locked ? b.engine : null} note={locked ? lockNote() : null} onPick={pickModel} />
        </PickerSheet>
      )}
      {sheet === "claude-agent" && claudeAgentPill && (
        <PickerSheet title={t("modelBar.agentSheet")} onClose={() => setSheet(null)}>
          <ClaudeAgentPicker engine={gemini ? "gemini" : b.engine} value={b.agent} onPick={pickAgent} />
        </PickerSheet>
      )}
      {sheet === "mode" && (
        <PickerSheet title={showMode ? t("modelBar.modeSheet") : t("review.planFirst")} onClose={() => setSheet(null)}>
          <div class="picker">
            {busy && <p class="picker-empty" role="status">{t("modelBar.modeBusy")}</p>}
            <PlanFirstToggle session={session} engine={b.engine} admin={admin} busy={busy} binding={b} bound={Boolean(bound)} />
            {showMode && permModeChoices({ admin, engine: b.engine }).map((m) => {
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
            {showMode && <p class="picker-foot">{t("modelBar.modeFoot")}{admin ? "" : t("modelBar.modeFootTenant")}</p>}
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