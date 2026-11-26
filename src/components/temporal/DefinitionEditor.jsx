// FEAT-19.14 (was FEAT-19.4): pipe editor v2 — project from your own list,
// steps as cards top to bottom (dependencies follow the order, no ids typed),
// a «Готовность» panel that names every reason a version would not run,
// autosave of the draft with a choice on a conflict (409), immutable versions
// with start/schedule next to them.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { t, locale } from "../../lib/i18n.js";
import { navigate, setLeaveGuard } from "../../lib/router.js";
import { me } from "../../lib/store.js";
import { projectDisplayName } from "../../lib/normalize.js";
import { validateDefinition, sameDefinition } from "../../../shared/temporal-definition.js";
import { Banner, Sheet, STEP_TYPES_UI, errorText, hashQuery } from "./ui.jsx";
import { unsupportedReasons } from "./readiness.js";
import { CommandFormSheet } from "./CommandsList.jsx";
import { inputToken, stepToken } from "../../../shared/temporal-template.js";
import { TEMPLATES } from "./PipesList.jsx";

const blank = () => ({ name: "", directory: "", inputs: [], steps: [] });
const UNITS = [[1, "sec"], [60, "min"], [3600, "hour"], [86400, "day"]];
const unitLabel = (u) => t("temporal.unit." + UNITS.find((x) => x[0] === u)[1]);
function chain(steps) { return steps.map((s, i) => ({ ...s, dependsOn: i ? [steps[i - 1].id] : [] })); }
function fromTemplate(id) {
  const tpl = TEMPLATES.find((x) => x.id === id);
  if (!tpl) return blank();
  return { ...blank(), name: tpl.id === "blank" ? "" : tpl.name, inputs: (tpl.inputs ?? []).map((x) => ({ ...x })), steps: chain(tpl.steps.map((s) => ({ ...s }))) };
}
function unitOf(seconds) { return [...UNITS].reverse().find(([u]) => seconds >= u && seconds % u === 0)?.[0] ?? 1; }
const ENGINE_LABELS = { claude: "Claude", codex: "Codex", acp: "Gemini (ACP)", opencode: "OpenCode" };
const engineLabel = (e) => ENGINE_LABELS[e] ?? e;

function stepSummary(step, steps, modelLabels = {}) {
  const label = STEP_TYPES_UI[step.type]?.label ?? step.type;
  const after = step.dependsOn?.length ? t("temporal.ed.after", { list: step.dependsOn.map((d) => t("temporal.quote", { text: steps.find((x) => x.id === d)?.name || d })).join(", ") }) : t("temporal.ed.atStart");
  if (step.type === "timer") { const u = unitOf(step.seconds || 1); return `${label} · ${t("temporal.ed.waitFor", { count: (step.seconds || 0) / u, unit: unitLabel(u) })} · ${after}`; }
  if (step.type === "model") return `${label} · ${engineLabel(step.engine)} · ${modelLabels[step.model] ?? step.model} · ${after}`;
  return `${label} · ${after}`;
}

// BUG-251: projects come from the server (the user's own, no typed paths).
function useProjects(current, onDefault) {
  const [state, setState] = useState({ list: null, error: null });
  useEffect(() => {
    api.temporalProjects().then((r) => {
      setState({ list: r.projects ?? [], error: null });
      if (!current && r.default) onDefault(r.default);
    }, (e) => setState({ list: [], error: e }));
  }, []);
  const list = state.list ?? [];
  const withCurrent = current && !list.some((p) => p.directory === current) ? [{ directory: current, name: projectDisplayName(current) }, ...list] : list;
  return { list: withCurrent, loading: state.list === null, error: state.error };
}

function StepCard({ step, index, steps, open, onToggle, onChange, onMove, onRemove, errors, engines, subscriptionModels, modelLabels = {}, inputs = [], codexTextOnly = false, commands = [], commandsLoading = false, commandsError = null, isAdmin = false, ledger = "postgres", onCreateCommand = null }) {
  const ty = STEP_TYPES_UI[step.type] ?? { icon: "?", label: step.type };
  const unsupported = unsupportedReasons({ inputs: [], steps: [step] }, subscriptionModels, { ledger, commands: commandsLoading ? undefined : commands });
  const selectedCmd = step.type === "command" ? commands.find((c) => c.id === step.command) ?? null : null;
  const bad = errors.length > 0;
  const earlier = steps.slice(0, index);
  const unit = unitOf(step.seconds || 60);
  return (
    <div class={"t-stepc" + (open ? " is-open" : "") + (bad ? " is-bad" : unsupported.length ? " is-warn" : "")}>
      <div class="t-row t-nowrap">
        <span class="t-typeic" aria-hidden="true">{ty.icon}</span>
        <button type="button" class="t-stepc-head" aria-expanded={open} onClick={onToggle}>
          <b>{step.name || t("temporal.untitled")}</b><span class="t-meta">{stepSummary(step, steps, modelLabels)}</span>
        </button>
        <button type="button" class="t-iconbtn" aria-label={t("temporal.ed.up", { name: step.name || index + 1 })} disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button type="button" class="t-iconbtn" aria-label={t("temporal.ed.down", { name: step.name || index + 1 })} disabled={index === steps.length - 1} onClick={() => onMove(1)}>↓</button>
        <button type="button" class="t-iconbtn t-danger-text" aria-label={t("temporal.ed.removeStep", { n: index + 1 })} onClick={onRemove}>✕</button>
      </div>
      {errors.map((e) => <p key={e} class="t-err-text">✕ {e}</p>)}
      {unsupported.map((e) => <p key={e} class="t-warn-text">⚠ {e}</p>)}
      {open && (
        <div class="t-stepc-body">
          <label class="t-field"><span>{t("temporal.ed.stepName")}</span>
            <input class="t-input" aria-label={t("temporal.ed.stepNameAria", { n: index + 1 })} maxLength={160} value={step.name} onInput={(e) => onChange({ name: e.currentTarget.value })} /></label>
          {step.type === "timer" && (
            <div class="t-field"><span>{t("temporal.ed.wait")}</span>
              <div class="t-row t-nowrap">
                <input class="t-input t-num" type="number" min="1" aria-label={t("temporal.ed.wait")} value={(step.seconds || 0) / unit}
                  onInput={(e) => onChange({ seconds: Math.round(Number(e.currentTarget.value) * unit) })} />
                <select class="t-input t-auto" aria-label={t("temporal.ed.waitUnit")} value={unit} onChange={(e) => onChange({ seconds: Math.round((step.seconds || 0) / unit * Number(e.currentTarget.value)) })}>
                  {UNITS.map(([u]) => <option key={u} value={u}>{unitLabel(u)}</option>)}</select>
              </div><span class="t-help">{t("temporal.ed.waitHelp")}</span></div>
          )}
          {step.type === "command" && (
            <>
              {commandsError && (
                <Banner tone="err" icon="⚠" title={t("temporal.ed.cmd.loadErr")}>
                  {errorText(commandsError)}
                </Banner>
              )}
              {!commandsLoading && !commandsError && commands.length === 0 ? (
                <div class="t-cmd-empty" data-testid="command-empty-catalog">
                  <b>{isAdmin ? t("temporal.cmd.empty") : t("temporal.ed.cmd.noAvail")}</b>
                  <p class="t-help">
                    {isAdmin ? t("temporal.ed.cmd.emptyAdmin") : t("temporal.ed.cmd.emptyUser")}
                  </p>
                  {isAdmin && (
                    <div class="t-row">
                      <button type="button" class="t-btn t-primary t-tight" data-action="quick-new-command"
                        onClick={() => onCreateCommand?.(step.id)}>{t("temporal.ed.cmd.quickNew")}</button>
                      <a class="t-btn t-tight" href="#/temporal/commands">{t("temporal.ed.cmd.openTab")}</a>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div class="t-field">
                    <span>{t("temporal.ed.cmd.selectLabel")}</span>
                    <div class="t-row t-nowrap">
                      <select class="t-input" aria-label={t("temporal.ed.cmd.selectLabel")} disabled={commandsLoading} value={step.command ?? ""}
                        onChange={(e) => {
                          const nextId = e.currentTarget.value;
                          const nextCmd = commands.find((c) => c.id === nextId);
                          onChange({
                            command: nextId,
                            args: {},
                            ...(nextCmd?.timeoutSeconds ? { timeoutSeconds: nextCmd.timeoutSeconds } : {}),
                          });
                        }}>
                        <option value="" disabled>{commandsLoading ? t("temporal.ed.cmd.loading") : t("temporal.ed.cmd.pick")}</option>
                        {step.command && !commands.some((c) => c.id === step.command) && (
                          <option value={step.command}>{t("temporal.ed.cmd.missingOpt", { id: step.command })}</option>
                        )}
                        {commands.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.kind === "temporal-workflow" ? t("temporal.cmd.kindWf") : "exec"})
                          </option>
                        ))}
                      </select>
                      {isAdmin && (
                        <button type="button" class="t-btn t-tight" data-action="quick-new-command"
                          onClick={() => onCreateCommand?.(step.id)}>{t("temporal.ed.cmd.quickNew")}</button>
                      )}
                    </div>
                  </div>

                  {selectedCmd && (
                    <div class="t-cmd-preview" data-testid="command-preview">
                      <div class="t-cmd-preview-head">
                        <b>{t("temporal.ed.cmd.previewTitle")}</b>
                        <span class="t-pill t-off">{selectedCmd.kind === "temporal-workflow" ? t("temporal.cmd.kindWf") : t("temporal.ed.cmd.scriptBadge")}</span>
                      </div>
                      {selectedCmd.description && <p class="t-meta">{selectedCmd.description}</p>}
                      {isAdmin && selectedCmd.kind === "exec" && selectedCmd.exec && (
                        <code class="t-cmd-line">
                          {selectedCmd.exec.file}{selectedCmd.exec.argv?.length ? " " + selectedCmd.exec.argv.join(" ") : ""}
                        </code>
                      )}
                      {isAdmin && selectedCmd.kind === "temporal-workflow" && selectedCmd.temporal && (
                        <code class="t-cmd-line">
                          {selectedCmd.temporal.address} · {selectedCmd.temporal.namespace} ·{" "}
                          {selectedCmd.temporal.schedule
                            ? `schedule: ${selectedCmd.temporal.schedule}`
                            : `workflow: ${selectedCmd.temporal.workflow} (${selectedCmd.temporal.taskQueue})`}
                        </code>
                      )}
                    </div>
                  )}

                  {selectedCmd?.params?.length > 0 && (
                    <div class="t-cmd-params">
                      {selectedCmd.params.map((p) => {
                        const val = step.args?.[p.name] ?? "";
                        const setVal = (next) => onChange({ args: { ...(step.args ?? {}), [p.name]: next } });
                        const outputSteps = earlier.filter((x) => x.type === "model" || x.type === "command");
                        return (
                          <div class="t-field" key={p.name}>
                            <span>
                              <span class="t-mono">{p.name}</span>
                              {p.required && <span class="t-err-text"> *</span>}
                              {p.description && <span class="t-muted t-small"> — {p.description}</span>}
                            </span>
                            <input class="t-input t-mono" maxLength={500} aria-label={t("temporal.ed.cmd.paramAria", { name: p.name })}
                              placeholder={p.pattern ? t("temporal.ed.cmd.paramPatternPh", { pattern: p.pattern }) : t("temporal.ed.cmd.paramPh")}
                              value={val} onInput={(e) => setVal(e.currentTarget.value)} />
                            {(inputs.length > 0 || outputSteps.length > 0) && (
                              <div class="t-tokens">
                                {inputs.map((x) => (
                                  <button key={x.name} type="button" class="t-token"
                                    onClick={() => setVal(val + inputToken(x.name))}>{t("temporal.ed.tokInput", { name: x.name })}</button>
                                ))}
                                {outputSteps.map((x) => (
                                  <button key={x.id} type="button" class="t-token"
                                    onClick={() => setVal(val + stepToken(x.id))}>{t("temporal.ed.cmd.tokOutput", { name: x.name || x.id })}</button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              <div class="t-two">
                <label class="t-field"><span>{t("temporal.ed.cmd.timeout")}</span>
                  <input class="t-input" type="number" min="1" max="86400" aria-label={t("temporal.ed.cmd.timeoutAria")}
                    value={step.timeoutSeconds ?? 300}
                    onInput={(e) => onChange({ timeoutSeconds: Number(e.currentTarget.value) })} /></label>
                <label class="t-field"><span>{t("temporal.ed.attempts")}</span>
                  <input class="t-input" type="number" min="1" max="10" aria-label={t("temporal.ed.cmd.attemptsAria")}
                    value={step.maxAttempts ?? 1}
                    onInput={(e) => onChange({ maxAttempts: Number(e.currentTarget.value) })} /></label>
              </div>
              <label class="t-field"><span>{t("temporal.ed.cmd.successWhen")}</span>
                <select class="t-input" aria-label={t("temporal.ed.cmd.successWhenAria")} value={step.successWhen ?? "exit0"}
                  onChange={(e) => onChange({ successWhen: e.currentTarget.value })}>
                  <option value="exit0">{t("temporal.ed.cmd.exit0")}</option>
                  <option value="always">{t("temporal.ed.cmd.always")}</option>
                </select>
              </label>
            </>
          )}
          {step.type === "model" && (
            <>
              <div class="t-two">
                <label class="t-field"><span>{t("temporal.ed.engine")}</span>
                  <select class="t-input" aria-label={t("temporal.ed.engine")} value={step.engine} onChange={(e) => onChange({ engine: e.currentTarget.value, model: subscriptionModels?.[e.currentTarget.value]?.[0] ?? step.model })}>
                    {[...new Set([...engines, step.engine])].map((x) => <option key={x} value={x} disabled={!engines.includes(x)}>{engineLabel(x)}{engines.includes(x) ? "" : t("temporal.ed.unavailable")}</option>)}</select></label>
                <label class="t-field"><span>{t("temporal.ed.subModel")}</span>
                  <select class="t-input" aria-label={t("temporal.ed.subModel")} value={step.model} onChange={(e) => onChange({ model: e.currentTarget.value })}>
                    {[...new Set([...(subscriptionModels?.[step.engine] ?? []), step.model])].map((m) => <option key={m} value={m} disabled={!subscriptionModels?.[step.engine]?.includes(m)}>{modelLabels[m] ?? m}</option>)}</select></label>
              </div>
              <label class="t-field"><span>{t("temporal.ed.instrLabel")}</span>
                <textarea class="t-input" rows="5" maxLength={16000} aria-label={t("temporal.ed.instrAria")} placeholder={t("temporal.ed.instrPh")} value={step.instruction} onInput={(e) => onChange({ instruction: e.currentTarget.value })} /></label>
              {(inputs.length > 0 || earlier.some((x) => x.type === "model" || x.type === "command")) && (
                <div class="t-field"><span class="t-small">{t("temporal.ed.insert")}</span>
                  <div class="t-tokens">
                    {inputs.map((x) => <button key={x.name} type="button" class="t-token" onClick={() => onChange({ instruction: (step.instruction || "") + inputToken(x.name) })}>{t("temporal.ed.tokInput", { name: x.name })}</button>)}
                    {earlier.filter((x) => x.type === "model" || x.type === "command").map((x) => <button key={x.id} type="button" class="t-token" onClick={() => onChange({ instruction: (step.instruction || "") + stepToken(x.id) })}>{t("temporal.ed.tokAnswer", { name: x.name || x.id })}</button>)}
                  </div></div>)}
              <p class="t-help">{t("temporal.ed.modelHelp")}{step.engine === "codex" && codexTextOnly ? t("temporal.ed.codexText") : ""}{step.engine === "acp" && codexTextOnly ? t("temporal.ed.acpTenantText") : ""}</p>
              {/* FEAT-20.7 */}
              <label class="t-field wt-check" data-req="FEAT-20.7">
                <input type="checkbox" aria-label={t("temporal.ed.worktree")} checked={Boolean(step.worktree)} disabled={step.engine === "codex" && codexTextOnly}
                  onChange={(e) => onChange({ worktree: e.currentTarget.checked })} />
                <span>{t("temporal.ed.worktree")} <small class="t-help">{step.engine === "codex" && codexTextOnly ? t("temporal.ed.worktreeCodexRo") : t("temporal.ed.worktreeHelp")}</small></span>
              </label>
              <div class="t-two">
                <label class="t-field"><span>{t("temporal.ed.timeout")}</span>
                  <input class="t-input" type="number" min="1" max="60" aria-label={t("temporal.ed.timeoutAria")} value={Math.round((step.timeoutSeconds || 60) / 60)} onInput={(e) => onChange({ timeoutSeconds: Math.round(Number(e.currentTarget.value) * 60) })} /></label>
                <label class="t-field"><span>{t("temporal.ed.attempts")}</span>
                  <input class="t-input" type="number" min="1" max="10" aria-label={t("temporal.ed.attempts")} value={step.maxAttempts} onInput={(e) => onChange({ maxAttempts: Number(e.currentTarget.value) })} /></label>
              </div>
            </>
          )}
          {step.type === "condition" && (
            <div class="t-two">
              <label class="t-field"><span>{t("temporal.ed.check")}</span>
                <select class="t-input" aria-label={t("temporal.ed.check")} value={(step.check?.source ?? "step") + ":" + (step.check?.ref ?? "")}
                  onChange={(e) => { const [source, ref] = e.currentTarget.value.split(":"); onChange({ check: { op: "contains", value: "", ...step.check, source, ref } }); }}>
                  <option value="step:" disabled>{t("temporal.ed.choose")}</option>
                  {earlier.filter((x) => x.type === "model" || x.type === "command").map((x) => <option key={x.id} value={"step:" + x.id}>{t("temporal.ed.answerOf", { name: x.name || x.id })}</option>)}
                  {inputs.map((x) => <option key={x.name} value={"input:" + x.name}>{t("temporal.ed.inputOf", { name: x.name })}</option>)}
                </select></label>
              <label class="t-field"><span>{t("temporal.ed.condition")}</span>
                <select class="t-input" aria-label={t("temporal.ed.opAria")} value={step.check?.op ?? "contains"} onChange={(e) => onChange({ check: { source: "step", ref: "", value: "", ...step.check, op: e.currentTarget.value } })}>
                  {["contains", "not_contains", "equals", "yes", "no"].map((op) => <option key={op} value={op}>{t("temporal.ed.op." + op)}</option>)}</select></label>
              {!["yes", "no"].includes(step.check?.op) && <label class="t-field"><span>{t("temporal.ed.value")}</span>
                <input class="t-input" aria-label={t("temporal.ed.valueAria")} maxLength={500} value={step.check?.value ?? ""} onInput={(e) => onChange({ check: { source: "step", ref: "", op: "contains", ...step.check, value: e.currentTarget.value } })} /></label>}
              <span class="t-help">{t("temporal.ed.condHelp")}</span>
            </div>
          )}
          {step.type === "artifact" && (
            <div class="t-two">
              <label class="t-field"><span>{t("temporal.ed.saveAnswer")}</span>
                <select class="t-input" aria-label={t("temporal.ed.saveAnswerAria")} value={step.source ?? ""} onChange={(e) => onChange({ source: e.currentTarget.value })}>
                  <option value="" disabled>{t("temporal.ed.chooseStep")}</option>
                  {earlier.filter((x) => x.type === "model" || x.type === "command").map((x) => <option key={x.id} value={x.id}>{t("temporal.quote", { text: x.name || x.id })}</option>)}
                </select></label>
              <label class="t-field"><span>{t("temporal.ed.fileName")}</span>
                <input class="t-input" aria-label={t("temporal.ed.fileName")} maxLength={100} placeholder={t("temporal.ed.defaultFile")} value={step.filename ?? ""} onInput={(e) => onChange({ filename: e.currentTarget.value })} />
                <span class="t-help">{t("temporal.ed.fileHelp")}</span></label>
            </div>
          )}
          {step.type === "approval" && earlier.some((x) => x.type === "model") && (
            <div class="t-two">
              <label class="t-field"><span>{t("temporal.ed.reworkLabel")}</span>
                <select class="t-input" aria-label={t("temporal.ed.reworkAria")} value={step.reworkTarget ?? ""} onChange={(e) => {
                  const v = e.currentTarget.value;
                  onChange(v ? { reworkTarget: v, maxReworks: step.maxReworks ?? 3 } : { reworkTarget: undefined, maxReworks: undefined });
                }}>
                  <option value="">{t("temporal.ed.reworkNone")}</option>
                  {earlier.filter((x) => x.type === "model").map((x) => <option key={x.id} value={x.id}>{t("temporal.quote", { text: x.name || x.id })}</option>)}
                </select></label>
              {step.reworkTarget && (
                <label class="t-field"><span>{t("temporal.ed.reworkMaxLabel")}</span>
                  <input class="t-input" type="number" min="1" max="3" aria-label={t("temporal.ed.reworkMaxAria")} value={step.maxReworks ?? 3}
                    onInput={(e) => onChange({ maxReworks: Number(e.currentTarget.value) })} /></label>
              )}
            </div>
          )}
          {step.type === "parallel" && (
            <label class="t-field"><span>{t("temporal.ed.whenNext")}</span>
              <select class="t-input" aria-label={t("temporal.ed.joinAria")} value={step.join} onChange={(e) => onChange({ join: e.currentTarget.value })}>
                <option value="all-success">{t("temporal.ed.join.all")}</option><option value="collect-results">{t("temporal.ed.join.collect")}</option></select></label>
          )}
          {earlier.length > 0 && (
            <div class="t-field"><span>{t("temporal.ed.startAfter")}</span>
              <div class="t-chips" role="group" aria-label={t("temporal.ed.startAfterAria", { n: index + 1 })}>
                {earlier.map((x) => {
                  const on = step.dependsOn.includes(x.id);
                  return <button key={x.id} type="button" class={"t-chip" + (on ? " is-on" : "")} aria-pressed={on}
                    onClick={() => onChange({ dependsOn: on ? step.dependsOn.filter((d) => d !== x.id) : [...step.dependsOn, x.id] })}>{x.name || x.id}</button>;
                })}
              </div>
              <span class="t-help">{step.dependsOn.length ? t("temporal.ed.depsHelp") : t("temporal.ed.noDepsHelp")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddMenu({ onAdd, onClose, engines, subscriptionModels, ledger = "postgres" }) {
  const noModels = ledger === "none" || !engines.some((e) => subscriptionModels?.[e]?.length);
  const opt = (type, text, disabled) => (
    <button key={type} type="button" class="t-tile" aria-disabled={disabled ? "true" : undefined} data-type={type}
      onClick={() => !disabled && onAdd(type)}>
      <span class="t-typeic" aria-hidden="true">{STEP_TYPES_UI[type].icon}</span>
      <span><b>{STEP_TYPES_UI[type].label}</b><small>{text}</small></span>
    </button>
  );
  return (
    <div class="t-addmenu">
      <h3>{t("temporal.ed.addWhich")}</h3>
      <div class="t-tiles">
        {opt("timer", t("temporal.ed.add.timer"))}
        {opt("approval", t("temporal.ed.add.approval"))}
        {opt("command", t("temporal.ed.add.command"))}
        {opt("model", ledger === "none" ? t("temporal.ed.add.modelNoLedger") : noModels ? t("temporal.ed.add.modelOff") : t("temporal.ed.add.model"), noModels)}
        {opt("parallel", t("temporal.ed.add.parallel"))}
        {opt("condition", t("temporal.ed.add.condition"))}
        {opt("artifact", t("temporal.ed.add.artifact"))}
      </div>
      <button type="button" class="t-btn t-ghost" onClick={onClose}>{t("temporal.cancel")}</button>
    </div>
  );
}

export default function DefinitionEditor({ record = null, engines = [], pipelineAvailable = false, schedulesAvailable = false, subscriptionModels, modelLabels = {}, codexTextOnly = false, ledger = "postgres" }) {
  const [saved, setSaved] = useState(record);
  const [draft, setDraft] = useState(() => structuredClone(record?.draft ?? fromTemplate(hashQuery().get("template"))));
  const [dirty, setDirty] = useState(!record && !!hashQuery().get("template"));
  const [status, setStatus] = useState(record ? "saved" : "new"); // new | saving | saved | error | conflict
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(() => (record ? null : draft.steps[0]?.id ?? null)), [adding, setAdding] = useState(false);
  const [showIssues, setShowIssues] = useState(false), [removed, setRemoved] = useState(null);
  const [deleting, setDeleting] = useState(null); // BUG-264 п.6: null | { busy, error, gone }
  const savedAt = useRef(record ? new Date() : null);
  const latest = useRef({ draft, saved, dirty });
  latest.current = { draft, saved, dirty };
  const modelEngines = engines.filter((e) => subscriptionModels?.[e]?.length);
  const isAdmin = me.value?.role === "admin";
  const [cmdState, setCmdState] = useState({ items: null, allowedRoots: [], error: null });
  const [creatingCmdFor, setCreatingCmdFor] = useState(null);
  function loadCommands() {
    const req = api.temporalCommands();
    req.then(
      (r) => setCmdState({ items: r.items ?? [], allowedRoots: r.allowedRoots ?? [], error: null }),
      (e) => setCmdState((prev) => ({ items: prev.items ?? [], allowedRoots: prev.allowedRoots, error: e }))
    );
  }
  useEffect(() => { loadCommands(); }, [isAdmin]);
  const commands = cmdState.items ?? [];
  const commandsLoading = cmdState.items === null && !cmdState.error;
  const allowedRoots = cmdState.allowedRoots ?? [];
  const openQuickCreateCommand = (stepId) => setCreatingCmdFor(stepId);

  useEffect(() => {
    const before = (e) => { if (latest.current.dirty) { e.preventDefault(); e.returnValue = ""; } };
    addEventListener("beforeunload", before);
    setLeaveGuard(() => !latest.current.dirty || globalThis.confirm(t("temporal.ed.leave")));
    return () => { removeEventListener("beforeunload", before); setLeaveGuard(null); };
  }, []);

  const canSave = draft.name.trim() && draft.directory.trim();
  async function save() {
    const { draft: d, saved: s } = latest.current;
    if (!d.name.trim() || !d.directory.trim()) return s;
    setStatus("saving");
    try {
      const next = s ? await api.temporalSave(s.id, s.revision, d) : await api.temporalCreate(d);
      setSaved(next); savedAt.current = new Date();
      if (latest.current.draft === d) setDirty(false);
      setStatus("saved"); setError("");
      if (!s && typeof history !== "undefined") history.replaceState(null, "", "#/temporal/pipe/" + encodeURIComponent(next.id));
      return next;
    } catch (e) {
      if (e.status === 409) setStatus("conflict");
      else { setStatus("error"); setError(errorText(e)); }
      return null;
    }
  }
  // Autosave 1.2 s after the last change.
  useEffect(() => {
    if (!dirty || !canSave || status === "conflict") return undefined;
    const timer = setTimeout(save, 1200);
    return () => clearTimeout(timer);
  }, [draft, dirty, status]);

  function update(fields) { setDraft((d) => ({ ...d, ...fields })); setDirty(true); setMessage(""); }
  function setSteps(steps) { update({ steps }); }
  function patch(id, p) { setSteps(draft.steps.map((s) => (s.id === id ? { ...s, ...p } : s))); }
  function addStep(type) {
    let n = draft.steps.length + 1; while (draft.steps.some((s) => s.id === "step" + n)) n++;
    const id = "step" + n;
    const last = draft.steps.at(-1);
    const lastOut = [...draft.steps].reverse().find((x) => x.type === "model" || x.type === "command")?.id ?? "";
    const firstCmd = commands[0];
    const step = { id, type, name: STEP_TYPES_UI[type].label, dependsOn: last ? (type === "parallel" ? draft.steps.map((s) => s.id).filter((x) => !draft.steps.some((o) => o.dependsOn.includes(x))) : [last.id]) : [],
      ...(type === "model" ? { engine: modelEngines[0] ?? "opencode", model: subscriptionModels?.[modelEngines[0]]?.[0] ?? "project-default", instruction: "", timeoutSeconds: 600, maxAttempts: 2 } : {}),
      ...(type === "command" ? { command: firstCmd?.id ?? "", args: {}, timeoutSeconds: firstCmd?.timeoutSeconds ?? 300, maxAttempts: 1, successWhen: "exit0" } : {}),
      ...(type === "timer" ? { seconds: 60 } : {}), ...(type === "parallel" ? { join: "all-success" } : {}),
      ...(type === "condition" ? { check: { source: "step", ref: lastOut, op: "contains", value: "" } } : {}),
      ...(type === "artifact" ? { source: lastOut, filename: t("temporal.ed.defaultFile") } : {}) };
    setSteps([...draft.steps, step]); setOpen(id); setAdding(false);
  }
  function move(index, delta) {
    const steps = draft.steps.slice(); const [s] = steps.splice(index, 1); steps.splice(index + delta, 0, s);
    // Keep the simple chain simple: a step that followed its neighbour keeps following whoever is above it now.
    const wasChain = draft.steps.every((x, i) => i === 0 ? !x.dependsOn.length : x.dependsOn.length === 1 && x.dependsOn[0] === draft.steps[i - 1].id);
    setSteps(wasChain ? chain(steps) : steps);
  }
  function remove(index) {
    const gone = draft.steps[index];
    const steps = draft.steps.filter((_, i) => i !== index).map((s) => s.dependsOn.includes(gone.id)
      ? { ...s, dependsOn: [...new Set([...s.dependsOn.filter((d) => d !== gone.id), ...gone.dependsOn])] } : s);
    setRemoved({ steps: draft.steps, name: gone.name }); setSteps(steps);
  }
  async function reloadTheirs() {
    try { const r = await api.temporalDefinition(saved.id); setSaved(r); setDraft(structuredClone(r.draft)); setDirty(false); setStatus("saved"); }
    catch (e) { setError(errorText(e)); }
  }
  async function overwrite() {
    try { const r = await api.temporalDefinition(saved.id); setSaved(r); latest.current.saved = r; setStatus("saved"); await save(); }
    catch (e) { setError(errorText(e)); }
  }
  async function publish() {
    setShowIssues(true);
    if (!checks.valid) return;
    setBusy(true); setError("");
    try {
      let s = latest.current.dirty || !latest.current.saved ? await save() : latest.current.saved;
      if (!s) return;
      s = await api.temporalPublish(s.id, s.revision);
      setSaved(s); setMessage(t("temporal.ed.published", { n: s.versions.at(-1).version })); setShowIssues(false);
    } catch (e) {
      if (e.status === 409 && e.body?.unchanged) setError(t("temporal.ed.unchanged", { n: e.body.unchanged })); // the server's «nothing changed» (not a revision conflict)
      else if (e.status === 409) setStatus("conflict"); else setError(errorText(e));
    } finally { setBusy(false); }
  }

  // BUG-264 п.6: delete without cascade — the server refuses (409) while runs go or a schedule is on.
  async function deletePipe() {
    setDeleting({ busy: true });
    try {
      await api.temporalDelete(saved.id);
      latest.current.dirty = false; setDirty(false); setDeleting(null);
      navigate("/temporal/pipes");
    } catch (e) {
      const error = e.status === 409 ? e.body?.error || t("temporal.ed.deleteBusy")
        : e.status === 403 ? t("temporal.ed.deleteNoAccess")
          : e.status === 404 ? t("temporal.ed.deleteGone") : errorText(e);
      setDeleting({ error, gone: e.status === 404 });
    }
  }

  const catalogOpt = !commandsLoading && !cmdState.error ? commands : undefined;
  const validation = validateDefinition(draft, catalogOpt ? { tr: t, catalog: catalogOpt } : { tr: t });
  const stepErrors = (id) => validation.errors.filter((e) => e.field === id).map((e) => e.message);
  const general = validation.errors.filter((e) => !draft.steps.some((s) => s.id === e.field));
  const reasons = unsupportedReasons(draft, subscriptionModels, { ledger, commands: catalogOpt });
  const checks = { valid: validation.valid };
  const projects = useProjects(draft.directory, (d) => setDraft((x) => (x.directory ? x : { ...x, directory: d })));
  const versions = saved?.versions ?? [];
  const nextVersion = versions.length + 1;
  // BUG-259: nothing changed since the last version — nothing to publish.
  const unchanged = versions.length > 0 && sameDefinition(versions.at(-1).definition, draft);
  const statusText = status === "saving" ? t("temporal.ed.st.saving") : status === "error" ? t("temporal.ed.st.error") : status === "conflict" ? t("temporal.ed.st.conflict")
    : dirty ? (canSave ? t("temporal.ed.st.dirty") : t("temporal.ed.st.needFields")) : saved ? (savedAt.current ? t("temporal.ed.st.savedAt", { time: savedAt.current.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) }) : t("temporal.ed.st.saved")) : t("temporal.ed.st.new");

  return (
    <div class="t-editor">
      {status === "conflict" && (
        <Banner tone="err" icon="⇆" title={t("temporal.ed.conflict")}>
          {t("temporal.ed.conflictText")}
          <div class="t-row"><button class="t-btn" type="button" onClick={reloadTheirs}>{t("temporal.ed.loadSaved")}</button>
            <button class="t-btn t-danger" type="button" onClick={overwrite}>{t("temporal.ed.overwrite")}</button></div>
        </Banner>
      )}
      {status === "error" && <Banner tone="err" icon="⚠" title={t("temporal.ed.notSaved")} action={<button class="t-btn" type="button" onClick={save}>{t("temporal.retry")}</button>}>{error}</Banner>}
      {message && <Banner icon="✓" title={message} action={<a class="t-btn t-primary" href={"#/temporal/start/" + encodeURIComponent(saved.id) + "?v=" + versions.at(-1)?.version}>{t("temporal.pipes.run")}</a>}>
        {t("temporal.ed.publishedText")}</Banner>}
      {error && status !== "error" && <Banner tone="err" icon="✕" title={t("temporal.ed.failed")}>{error}</Banner>}
      {removed && <div class="t-toast" role="status">{t("temporal.ed.removed", { name: removed.name })} <button class="t-link" type="button" onClick={() => { setSteps(removed.steps); setRemoved(null); }}>{t("temporal.ed.undo")}</button></div>}
      <div class="t-head">
        <div><h1>{draft.name.trim() || t("temporal.title.new")}</h1>
          <p class="t-lead">{versions.length ? t("temporal.ed.publishedCount", { count: versions.length }) : t("temporal.ed.notPublished")}</p></div>
        <span class="t-pill t-off" role="status">✎ {statusText}</span>
      </div>
      <div class="t-ed">
        <div>
          <section class="t-card t-sec">
            <h2><span class="t-n">1</span>{t("temporal.ed.basics")}</h2>
            <label class="t-field"><span>{t("temporal.ed.name")}</span>
              <input class={"t-input" + (showIssues && !draft.name.trim() ? " is-bad" : "")} aria-label={t("temporal.ed.nameAria")} maxLength={160} placeholder={t("temporal.ed.namePh")} value={draft.name} onInput={(e) => update({ name: e.currentTarget.value })} />
              {showIssues && !draft.name.trim() && <span class="t-err-text">{t("temporal.ed.nameErr")}</span>}</label>
            <label class="t-field"><span>{t("temporal.ed.project")}</span>
              <select class={"t-input" + (showIssues && !draft.directory.trim() ? " is-bad" : "")} aria-label={t("temporal.ed.project")} value={draft.directory}
                disabled={projects.loading} onChange={(e) => update({ directory: e.currentTarget.value })}>
                <option value="" disabled>{projects.loading ? t("temporal.ed.loadingProjects") : t("temporal.ed.chooseProject")}</option>
                {projects.list.map((p) => <option key={p.directory} value={p.directory} selected={p.directory === draft.directory}>{projectDisplayName(p.directory)}</option>)}
              </select>
              <span class="t-help">{saved?.folder ? <>{t("temporal.ed.folderPre")}<span class="t-mono">{saved.folder}</span>{t("temporal.ed.folderPost")}</>
                : t("temporal.ed.folderNew")}</span>
              {!projects.loading && !projects.list.length && <span class="t-err-text">{t("temporal.ed.noProjects")}</span>}
              {showIssues && !draft.directory.trim() && projects.list.length > 0 && <span class="t-err-text">{t("temporal.ed.projectErr")}</span>}</label>
          </section>
          <section class="t-card t-sec">
            <h2><span class="t-n">2</span>{t("temporal.ed.steps")} <span class="t-muted t-small">{t("temporal.ed.stepsHint")}</span></h2>
            {draft.steps.length === 0 && <p class="t-muted">{t("temporal.ed.noSteps")}</p>}
            <div class="t-flow">
              {draft.steps.map((step, i) => (
                <div key={step.id}>
                  {i > 0 && <div class="t-conn" aria-hidden="true" />}
                  <StepCard step={step} index={i} steps={draft.steps} open={open === step.id} onToggle={() => setOpen(open === step.id ? null : step.id)}
                    onChange={(p) => patch(step.id, p)} onMove={(d) => move(i, d)} onRemove={() => remove(i)}
                    errors={showIssues ? stepErrors(step.id) : []} engines={engines} subscriptionModels={subscriptionModels} modelLabels={modelLabels}
                    inputs={draft.inputs} codexTextOnly={codexTextOnly} commands={commands} commandsLoading={commandsLoading}
                    commandsError={cmdState.error} isAdmin={isAdmin} ledger={ledger} onCreateCommand={openQuickCreateCommand} />
                </div>
              ))}
            </div>
            {adding ? <AddMenu onAdd={addStep} onClose={() => setAdding(false)} engines={engines} subscriptionModels={subscriptionModels} ledger={ledger} />
              : <button type="button" class="t-btn t-block t-dashed" disabled={draft.steps.length >= 64} onClick={() => setAdding(true)}>{t("temporal.ed.addStep")}</button>}
          </section>
          <section class="t-card t-sec">
            <h2><span class="t-n">3</span>{t("temporal.ed.inputs")} <span class="t-muted t-small">{t("temporal.ed.inputsHint")}</span></h2>
            {draft.inputs.length === 0 && <p class="t-muted">{t("temporal.ed.noInputs")}</p>}
            {draft.inputs.map((input, i) => (
              <div class="t-inputrow" key={i}>
                <label class="t-field"><span>{t("temporal.ed.inputName")}</span><input class="t-input t-mono" aria-label={t("temporal.ed.inputNameAria", { n: i + 1 })} maxLength={64} value={input.name}
                  onInput={(e) => update({ inputs: draft.inputs.map((x, j) => (j === i ? { ...x, name: e.currentTarget.value.replace(/[^a-zA-Z0-9_-]/g, "") } : x)) })} /></label>
                <label class="t-field"><span>{t("temporal.ed.type")}</span><select class="t-input" aria-label={t("temporal.ed.inputTypeAria", { n: i + 1 })} value={input.type}
                  onChange={(e) => update({ inputs: draft.inputs.map((x, j) => (j === i ? { ...x, type: e.currentTarget.value } : x)) })}>
                  {["string", "number", "boolean", "array"].map((ty) => <option key={ty} value={ty}>{t("temporal.ed.it." + ty)}</option>)}</select></label>
                <label class="t-check"><input type="checkbox" checked={input.required} onChange={(e) => update({ inputs: draft.inputs.map((x, j) => (j === i ? { ...x, required: e.currentTarget.checked } : x)) })} /> {t("temporal.ed.required")}</label>
                <button class="t-iconbtn t-danger-text" type="button" aria-label={t("temporal.ed.removeInput", { name: input.name })} onClick={() => update({ inputs: draft.inputs.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            <button class="t-btn" type="button" disabled={draft.inputs.length >= 32} onClick={() => { let n = draft.inputs.length + 1; while (draft.inputs.some((x) => x.name === "input" + n)) n++; update({ inputs: [...draft.inputs, { name: n === 1 ? "task" : "input" + n, type: "string", required: true }] }); }}>{t("temporal.ed.addInput")}</button>
            {draft.inputs.length > 0 && <p class="t-help">{t("temporal.ed.inputHelpPre")}<span class="t-mono">{t("temporal.ed.inputToken")}</span>{t("temporal.ed.inputHelpPost")}</p>}
          </section>
        </div>
        <aside class="t-side">
          <section class="t-card t-ready" aria-live="polite">
            <h2>{t("temporal.ed.readiness")}</h2>
            {!validation.valid && !showIssues && <p class="t-help" style="margin-top:0">{t("temporal.ed.toPublish")}</p>}
            <ul>
              {validation.valid ? <li class="t-ok-text">{t("temporal.ed.schemaOk")}</li> : [...general, ...validation.errors.filter((e) => draft.steps.some((s) => s.id === e.field))].slice(0, 8).map((e, i) =>
                <li key={i} class={showIssues ? "t-err-text" : "t-todo-text"}>{showIssues ? "✕" : "○"} {draft.steps.find((s) => s.id === e.field) ? t("temporal.quote", { text: draft.steps.find((s) => s.id === e.field).name || e.field }) + ": " : ""}{e.message}</li>)}
              {reasons.length ? reasons.map((r) => <li key={r} class="t-warn-text">⚠ {r}</li>) : validation.valid && <li class="t-ok-text">{t("temporal.ed.allRunnable")}</li>}
              {!pipelineAvailable && <li class="t-warn-text">{t("temporal.ed.noExec")}</li>}
            </ul>
            <p class="t-help">{reasons.length ? t("temporal.ed.publishButCant") : t("temporal.ed.readyHelp")}</p>
          </section>
          {versions.length > 0 && (
            <section class="t-card">
              <h2>{t("temporal.ed.versions")}</h2>
              <ul class="t-versions">
                {versions.slice().reverse().map((v) => {
                  const why = unsupportedReasons(v.definition, subscriptionModels, { ledger, commands: catalogOpt });
                  return (
                    <li key={v.version}>
                      <b>{t("temporal.runs.version", { n: v.version })}</b> <span class="t-meta">{v.definition.steps.map((s) => s.name).join(" → ")}</span>
                      {why.length ? <details><summary class="t-warn-text">{t("temporal.ed.cannotRun")}</summary><ul>{why.map((r) => <li key={r}>{r}</li>)}</ul></details>
                        : <div class="t-row">
                          {pipelineAvailable && <a class="t-btn t-tight" data-action="start" href={"#/temporal/start/" + encodeURIComponent(saved.id) + "?v=" + v.version}>{t("temporal.pipes.run")}</a>}
                          {schedulesAvailable && <a class="t-btn t-tight" href={"#/temporal/schedules/new?def=" + encodeURIComponent(saved.id) + "&v=" + v.version}>{t("temporal.ed.schedule")}</a>}
                        </div>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {saved && (
            <section class="t-card">
              <button class="t-btn t-danger t-block" type="button" data-action="delete-pipe" onClick={() => setDeleting({})}>{t("temporal.ed.delete")}</button>
            </section>
          )}
        </aside>
      </div>
      {deleting && (
        <Sheet title={t("temporal.ed.deleteTitle", { name: saved.draft?.name || draft.name || t("temporal.untitled") })} onClose={() => setDeleting(null)}>
          <ul class="t-consequences"><li>{t("temporal.ed.deleteC1")}</li>
            <li>{t("temporal.ed.deleteC2")}</li>
            <li>{t("temporal.ed.deleteC3")}</li></ul>
          {deleting.error && <p class="t-err-text" role="alert">{deleting.error}</p>}
          <div class="t-row t-stretch">
            {deleting.gone ? <button class="t-btn t-primary" type="button" onClick={() => { latest.current.dirty = false; setDirty(false); navigate("/temporal/pipes"); }}>{t("temporal.view.toPipes")}</button> : <>
              <button class="t-btn" type="button" onClick={() => setDeleting(null)}>{t("temporal.ed.keep")}</button>
              <button class="t-btn t-danger-fill" type="button" data-action="confirm-delete" disabled={deleting.busy} onClick={deletePipe}>{deleting.busy ? t("temporal.ed.deleting") : t("temporal.ed.deleteConfirm")}</button></>}
          </div>
        </Sheet>
      )}
      {creatingCmdFor && (
        <CommandFormSheet
          allowedRoots={allowedRoots}
          onClose={() => setCreatingCmdFor(null)}
          onSaved={(created) => {
            const targetStep = creatingCmdFor;
            setCreatingCmdFor(null);
            loadCommands();
            if (created?.id && targetStep) {
              patch(targetStep, {
                command: created.id,
                args: {},
                ...(created.timeoutSeconds ? { timeoutSeconds: created.timeoutSeconds } : {}),
              });
            }
          }}
        />
      )}
      <div class="t-savebar">
        <span class="t-muted t-small t-hide-phone t-grow">{statusText}</span>
        <button class="t-btn t-primary" type="button" data-action="publish" aria-disabled={!validation.valid ? "true" : undefined} disabled={busy || unchanged} title={unchanged ? t("temporal.ed.changeToPublish") : undefined} onClick={publish}>
          {busy ? t("temporal.ed.publishing") : unchanged ? t("temporal.ed.upToDate", { n: versions.length }) : t("temporal.ed.publish", { n: nextVersion })}</button>
      </div>
    </div>
  );
}
