// FEAT-19.14: one run — step timeline, the decision next to the result it is
// about, pause/resume, cancel and terminate behind sheets with consequences.
// Commands target the exact runId of the last read (FEAT-19.6) and keep their
// actionId across a retry of the same command (idempotent on the server).
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";
import { navigate } from "../../lib/router.js";
import { me } from "../../lib/store.js";
import { useSeenOnOpen } from "../../lib/attention.js"; // FEAT-20.2
import { Banner, Empty, RunStatus, Sheet, Skeleton, STEP_TYPES_UI, errorText, ghWait, prOutcome, sourceText, stepErrorTitle, usePoll, useNow, when, duration } from "./ui.jsx";
import { CI_ATTEMPTS_MAX } from "../../../shared/temporal-templates.js";
import { previewResumeSelection } from "../../../shared/temporal-resume.js";
import Markdown from "../chat/Markdown.jsx";
import FileCard from "../chat/FileCard.jsx";
import FileViewer from "../chat/FileViewer.jsx";
import { RunWorktree } from "../chat/Worktree.jsx"; // FEAT-20.7
import { RunCost } from "./RunCost.jsx"; // FEAT-20.6

const ACTIVE = new Set(["wait", "run", "quota", "slot", "paused", "github"]);
const INPUT_PREVIEW = 240;
const STEP_STATE = {
  completed: ["done", "✓"], running: ["cur", "↻"], quota_wait: ["wait", "⧗"], slot_wait: ["wait", "⧗"], rejected: ["fail", "✕"], waiting: ["todo", ""], skipped: ["skip", "↷"], github_wait: ["wait", "⧗"],
};

function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return t("temporal.rd.cmd.ms", { n: Math.round(ms) });
  const s = Math.round(ms / 1000);
  if (s < 60) return t("temporal.rd.cmd.sec", { n: s });
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? t("temporal.rd.cmd.minSec", { m, s: rem }) : t("temporal.rd.cmd.min", { m });
}

function parentDir(filePath) {
  const s = String(filePath ?? "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i > 0 ? s.slice(0, i) : "/";
}

function baseName(filePath) {
  const s = String(filePath ?? "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function Result({ workflowId, step, open: initiallyOpen = false, label = null, hideLabel = null, copyable = false }) {
  const [open, setOpen] = useState(initiallyOpen), [text, setText] = useState(null), [error, setError] = useState(""), [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open || text !== null) return;
    api.temporalResult(workflowId, step).then((r) => setText(r.text ?? ""), (e) => setError(errorText(e)));
  }, [open]);
  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }
  return (
    <div class="t-result">
      <div class="t-row t-nowrap" style="gap:6px">
        <button type="button" class="t-btn t-ghost t-tight" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? (hideLabel ?? t("temporal.rd.hide")) : (label ?? t("temporal.rd.show"))}</button>
        {copyable && open && text && (
          <button type="button" class="t-btn t-tight" data-action="copy-output" onClick={copy}>
            {copied ? t("temporal.ext.copied") : t("temporal.ext.copy")}
          </button>
        )}
      </div>
      {open && (error ? <p class="t-err-text" role="alert">{error}</p> : text === null ? <p class="t-muted t-small">{t("temporal.rd.loadingResult")}</p> : <div class="t-out md"><Markdown text={text || t("temporal.rd.noText")} /></div>)}
    </div>
  );
}

function CommandStepBox({ workflowId, step, meta, workerCmd, hasResult, onOpenFile }) {
  const info = meta || workerCmd || null;
  if (!info) return null;
  const exitCode = info.exitCode ?? null;
  const durationMs = info.durationMs ?? null;
  const uiUrl = info.uiUrl ?? null;
  const stderrTail = info.stderrTail ?? null;
  const files = Array.isArray(info.files) ? info.files : [];
  const uncertain = info.state === "uncertain";
  return (
    <div class="t-cmdbox" data-testid={`command-step-${step.id}`}>
      {uncertain && (
        <Banner tone="warn" icon="⚠" title={t("temporal.rd.cmd.uncertainTitle")}>
          {stderrTail || t("temporal.rd.cmd.uncertainText")}
        </Banner>
      )}
      <div class="t-cmd-meta">
        {info.commandId && <span class="t-pill t-off t-mono">{info.commandId}</span>}
        {exitCode !== null && (
          <span class={"t-pill " + (exitCode === 0 ? "t-ok" : "t-err")}>{t("temporal.rd.cmd.exitCode", { code: exitCode })}</span>
        )}
        {durationMs !== null && <span class="t-meta">{fmtMs(durationMs)}</span>}
        {info.attempt > 1 && <span class="t-meta">{t("temporal.rd.cmd.attempt", { n: info.attempt })}</span>}
        {info.childWorkflowId && <span class="t-meta t-mono">wf: {info.childWorkflowId}</span>}
      </div>
      {uiUrl && (
        <div class="t-row">
          <a class="t-btn t-tight" href={uiUrl} target="_blank" rel="noreferrer">{t("temporal.rd.cmd.openUi")}</a>
        </div>
      )}
      {hasResult && (
        <Result workflowId={workflowId} step={step.id} label={t("temporal.rd.cmd.showStdout")} hideLabel={t("temporal.rd.cmd.hideStdout")} copyable />
      )}
      {stderrTail && !uncertain && (
        <details class="t-more" style="margin-top:6px">
          <summary>stderr</summary>
          <pre class="t-code">{stderrTail}</pre>
        </details>
      )}
      {files.length > 0 && (
        <div class="t-cmd-files">
          <span class="t-small t-muted">{t("temporal.rd.cmd.filesLabel")}</span>
          <div class="t-files">
            {files.map((f) => f.allowed ? (
              <FileCard key={f.path} name={baseName(f.path)}
                onOpen={() => onOpenFile({ name: baseName(f.path), path: f.path, directory: parentDir(f.path) })} />
            ) : (
              <span key={f.path} class="t-pill t-off t-mono" title={t("temporal.rd.cmd.outsideTitle")}>
                {t("temporal.rd.cmd.pathOnly", { path: f.path })}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RunDetail({ workflowId, modelLabels = {} }) {
  const [run, setRun] = useState(null), [error, setError] = useState(null), [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false), [toast, setToast] = useState(""), [sheet, setSheet] = useState(null);
  const [reason, setReason] = useState(""), [comment, setComment] = useState(""), [viewer, setViewer] = useState(null);
  const [resumeVersion, setResumeVersion] = useState(null), [resumeFromStep, setResumeFromStep] = useState(""), [resumeError, setResumeError] = useState("");
  const retry = useRef(null), resumeRetry = useRef(null);
  const now = useNow(15000);
  useSeenOnOpen(workflowId ? "run:" + workflowId : null); // FEAT-20.2 (кр. 5): запуск открыт ≥ 2 с — просмотрен
  async function load() {
    try { setRun(await api.temporalRun(workflowId)); setError(null); }
    catch (e) { if ([403, 404].includes(e.status)) setGone(true); else setError(e); }
  }
  useEffect(() => { load(); }, [workflowId]);
  const kind = run?.summary?.kind;
  usePoll(load, 5000, ACTIVE.has(kind) && !sheet);
  useEffect(() => { if (!toast) return undefined; const timer = setTimeout(() => setToast(""), 6000); return () => clearTimeout(timer); }, [toast]);

  async function act(action, extra = {}) {
    const body = { action, runId: run.runId, ...extra };
    const signature = JSON.stringify(body);
    if (retry.current?.signature !== signature) retry.current = { signature, id: crypto.randomUUID() };
    setBusy(true);
    try {
      await api.temporalRunAction(workflowId, { ...body, actionId: retry.current.id });
      retry.current = null; setSheet(null); setReason(""); setComment("");
      setToast(t("temporal.rd.toast." + action));
      await load();
    } catch (e) {
      retry.current = null; setSheet(null);
      if (e.status === 409) { setToast(t("temporal.rd.toast.changed")); await load(); }
      else if (e.status === 403 || e.status === 404) setGone(true);
      else setToast(errorText(e));
    } finally { setBusy(false); }
  }

  if (gone) {
    return <Empty icon="🔒" title={t("temporal.rd.gone")} actions={<a class="t-btn t-primary" href="#/temporal">{t("temporal.rd.toRuns")}</a>}>
      <p>{t("temporal.rd.goneText")}</p></Empty>;
  }
  if (!run && error) {
    return <Empty icon="⚠" title={t("temporal.rd.loadError")} actions={<button class="t-btn t-primary" type="button" onClick={load}>{t("temporal.retry")}</button>}>
      <p>{errorText(error)}</p></Empty>;
  }
  if (!run) return <Skeleton rows={3} />;

  const s = run.summary ?? {};
  const state = run.state ?? {};
  const stepState = state.steps ?? {};
  const running = run.status === "RUNNING";
  const pending = running && !state.paused ? (state.pending ?? []) : [];
  const allowed = (a) => !run.allowedActions || run.allowedActions.includes(a);
  const results = new Set(run.resultSteps ?? []);
  const resumedSet = new Set(run.resumedSteps ?? []);
  const resumeVersions = run.resumeOptions?.versions ?? [];
  const canResume = !running && !run.pipeDeleted && resumeVersions.length > 0;
  const chosenResumeVer = resumeVersions.find((v) => v.version === resumeVersion) ?? resumeVersions.find((v) => v.available) ?? resumeVersions[0] ?? null;
  const resumePreview = chosenResumeVer ? previewResumeSelection({ steps: chosenResumeVer.steps, reusableSteps: chosenResumeVer.reusableSteps, fromStepId: resumeFromStep || chosenResumeVer.defaultFromStepId }) : null;
  const openResume = () => {
    const defVer = resumeVersions.find((v) => v.available) ?? resumeVersions[0];
    if (!defVer) return;
    setResumeVersion(defVer.version);
    setResumeFromStep(defVer.defaultFromStepId ?? defVer.steps[0]?.id ?? "");
    setResumeError("");
    resumeRetry.current = null;
    setSheet("resume");
  };
  const submitResume = async () => {
    if (!chosenResumeVer || !chosenResumeVer.available) return;
    const fromStep = resumeFromStep || chosenResumeVer.defaultFromStepId;
    const payload = { version: chosenResumeVer.version, fromStepId: fromStep };
    const sig = JSON.stringify(payload);
    if (resumeRetry.current?.sig !== sig) resumeRetry.current = { sig, id: crypto.randomUUID() };
    setBusy(true);
    setResumeError("");
    try {
      const created = await api.temporalResume(workflowId, { ...payload, requestId: resumeRetry.current.id });
      resumeRetry.current = null;
      setSheet(null);
      navigate("/temporal/run/" + encodeURIComponent(created.workflowId));
    } catch (e) {
      resumeRetry.current = null;
      if (e.status === 409) { setResumeError(errorText(e)); await load(); }
      else if (e.status === 403 || e.status === 404) { setSheet(null); setGone(true); }
      else setResumeError(errorText(e));
    } finally { setBusy(false); }
  };
  const steps = run.steps ?? [];
  const files = run.files ?? [];
  // FEAT-19.16: «Итог» — the answer of the last completed model step (or the source of the last artifact).
  const decide = pending.map((id) => steps.find((x) => x.id === id) ?? { id, name: id, type: "approval" });
  const before = (id) => { const i = steps.findIndex((x) => x.id === id); return steps.slice(0, Math.max(0, i)).reverse().find((x) => results.has(x.id)); };
  const lastAnswer = [...steps].reverse().find((x) => x.type === "model" && (run.resultSteps ?? []).includes(x.id)) ?? null;
  // The decision block already shows that answer — no second copy as an interim result.
  const finalStep = lastAnswer && !decide.some((d) => before(d.id)?.id === lastAnswer.id) ? lastAnswer : null;
  const next = (id) => { const i = steps.findIndex((x) => x.id === id); return steps[i + 1]; };
  const prSteps = steps.filter((x) => x.type === "pull_request");
  const refusals = run.stepError && prSteps.some((x) => x.id === run.stepError.stepId) ? run.stepError : null;
  const waitCut = !running && ["FAILED", "TIMED_OUT"].includes(run.status) && prSteps.some((x) => stepState[x.id] === "github_wait");
  const lastAttempt = Number.isSafeInteger(run.attempt) && run.attempt >= CI_ATTEMPTS_MAX;
  const ciLog = typeof run.inputs?.ci_log === "string" ? run.inputs.ci_log.trim() : "";
  const shownInputs = Object.entries(run.inputs ?? {}).filter(([k]) => k !== "ci_log");
  const githubLink = run.eventUrl ? <a class="t-btn" href={run.eventUrl} target="_blank" rel="noreferrer">{t("temporal.gh.openGithub")}</a> : null;
  const toWorktree = () => {
    const card = typeof document === "undefined" ? null : document.querySelector('.t-rundetail [data-req="FEAT-20.7"]');
    if (card?.scrollIntoView) card.scrollIntoView({ block: "start", behavior: "smooth" });
    else setToast(t("temporal.rd.worktreeNotHere"));
  };

  const actions = running ? (
    <>
      {allowed(state.paused ? "resume" : "pause") && (state.paused
        ? <button class="t-btn t-primary" type="button" data-action="resume" disabled={busy} onClick={() => act("resume")}>{t("temporal.rd.resume")}</button>
        : <button class="t-btn" type="button" data-action="pause" disabled={busy} onClick={() => act("pause")}>{t("temporal.rd.pause")}</button>)}
      {allowed("cancel") && <button class="t-btn t-danger" type="button" data-action="cancel" disabled={busy} onClick={() => setSheet("cancel")}>{t("temporal.rd.cancel")}</button>}
      {allowed("terminate") && <button class="t-btn t-ghost t-danger-text" type="button" data-action="terminate" disabled={busy} onClick={() => setSheet("terminate")}>{t("temporal.rd.terminate")}</button>}
    </>
  ) : run.pipeDeleted ? (
    // BUG-264 п.6: the pipe is deleted — history stays readable, nothing to restart or open.
    <a class="t-btn" href="#/temporal">{t("temporal.rd.toRuns")}</a>
  ) : (
    <>
      {canResume && <button class="t-btn t-primary" type="button" data-action="open-resume" disabled={busy} onClick={openResume}>{t("temporal.rd.rs.button")}</button>}
      <a class={canResume ? "t-btn" : "t-btn t-primary"} href={"#/temporal/start/" + encodeURIComponent(run.definitionId) + "?v=" + run.version}>{t("temporal.rd.rerun")}</a>
      <a class="t-btn" href={"#/temporal/pipe/" + encodeURIComponent(run.definitionId)}>{t("temporal.rd.openPipe")}</a>
    </>
  );

  return (
    <div class="t-rundetail">
      <div class="t-head">
        <div><h1>{run.name}</h1>
          <p class="t-facts"><span>{t("temporal.runs.version", { n: run.version })}</span><span>{run.eventUrl ? <a href={run.eventUrl} target="_blank" rel="noreferrer">{sourceText(run)} ↗</a> : sourceText(run)}</span>
            {run.startTime && <span>{t("temporal.rd.started", { when: when(run.startTime, now) })}</span>}
            {run.startTime && <span>{running ? t("temporal.rd.running") : t("temporal.rd.took")}{duration(run.startTime, run.closeTime, now)}</span>}
            {run.resumedFrom && <span>{resumedSet.size ? t("temporal.rd.rs.fromTagN", { n: resumedSet.size }) : t("temporal.rd.rs.fromTag")}</span>}{ACTIVE.has(kind) && <span>{t("temporal.rd.autoRefresh")}</span>}{run.pipeDeleted && <span>{t("temporal.rd.pipeDeleted")}</span>}</p></div>
        <RunStatus kind={kind} stepError={run.stepError} />
      </div>
      {state.paused && running && <Banner icon="❚❚" title={t("temporal.rd.paused")}>{t("temporal.rd.pausedText")}</Banner>}
      {kind === "err" && !refusals && !waitCut && <Banner tone="err" icon="✕" title={t("temporal.rd.failed")}>{t("temporal.rd.failedText")}</Banner>}
      {kind === "unavailable" && <Banner tone="err" icon="?" title={t("temporal.view.down")}>{t("temporal.rd.downText")}</Banner>}
      {waitCut && <Banner tone="err" icon="⧗" title={t("temporal.rd.waitCutTitle")} action={<button class="t-btn" type="button" data-action="to-worktree" onClick={toWorktree}>{t("temporal.rd.worktreeBtn")}</button>}>{t("temporal.rd.waitCutText")}</Banner>}
      {lastAttempt && <Banner tone="warn" icon="✋" title={t("temporal.rd.lastAttemptTitle", { max: CI_ATTEMPTS_MAX })} action={githubLink}>{t("temporal.rd.lastAttemptText")}</Banner>}
      <div class="t-grid2">
        <div>
          {running && decide.map((step) => {
            const prev = before(step.id), after = next(step.id);
            const reworkTarget = step.type === "approval" ? step.reworkTarget : null;
            const maxReworks = step.maxReworks ?? 3;
            const reworkCount = state.reworks?.[step.id] ?? 0;
            const canRework = Boolean(reworkTarget) && reworkCount < maxReworks;
            return (
              <section class="t-decide" key={step.id} aria-labelledby={"t-d-" + step.id}>
                <RunStatus kind="wait" />
                <h2 id={"t-d-" + step.id}>{t("temporal.rd.decide", { name: step.name })}</h2>
                {reworkTarget && (
                  <p class="t-muted t-small" data-req="FEAT-20.1 кр. 14">
                    {canRework ? t("temporal.rd.reworkCount", { n: reworkCount, max: maxReworks }) : t("temporal.rd.reworkLimit", { max: maxReworks })}
                  </p>
                )}
                {step.type === "pull_request"
                  ? <p class="t-muted t-small">{t("temporal.rd.ciFilesNote")}</p>
                  : prev ? <><p class="t-muted t-small">{t("temporal.rd.resultOf", { name: prev.name })}</p><Result workflowId={workflowId} step={prev.id} open /></> : null}
                <div class="t-row t-stretch">
                  <button class="t-btn t-primary" type="button" data-action="approve" disabled={busy || !allowed("approve")}
                    onClick={() => act("approve", { stepId: step.id, generation: state.generation })}>{t("temporal.rd.approve")}</button>
                  {reworkTarget && (
                    <button class="t-btn" type="button" data-action="rework" disabled={busy || !canRework || !allowed("approve")}
                      onClick={() => setSheet({ rework: step })}>{t("temporal.rd.reworkBtn")}</button>
                  )}
                  <button class="t-btn t-danger" type="button" data-action="reject" disabled={busy || !allowed("reject")}
                    onClick={() => setSheet({ reject: step })}>{t("temporal.rd.reject")}</button>
                </div>
                <p class="t-help">{after ? t("temporal.rd.afterApprove", { name: after.name }) : t("temporal.rd.afterApproveEnd")} {t("temporal.rd.rejectEnds")}</p>
              </section>
            );
          })}
          {(finalStep || files.length > 0) && (
            <section class="t-card t-final" aria-labelledby="t-final-h">
              <h2 id="t-final-h">{run.status === "RUNNING" ? t("temporal.rd.interim") : t("temporal.rd.final")}</h2>
              {finalStep && <><p class="t-muted t-small">{t("temporal.rd.answerOf", { name: finalStep.name })}{run.chats?.[finalStep.id] ? <> · <a href={"#/chat/" + encodeURIComponent(run.chats[finalStep.id])}>{t("temporal.rd.conversation")}</a></> : null}</p>
                <Result key={finalStep.id} workflowId={workflowId} step={finalStep.id} open /></>}
              {files.length > 0 && <>
                <h3 class="t-files-h">{t("temporal.rd.files", { folder: run.runFolder })}</h3>
                <div class="t-files">{files.map((f) => <FileCard key={f.path} name={f.name} onOpen={() => setViewer({ name: f.name, path: f.path, directory: run.workspace })} />)}</div>
              </>}
            </section>
          )}
          <section class="t-card">
            <h2>{t("temporal.rd.steps")}</h2>
            <ol class="t-timeline">
              {steps.map((step, i) => {
                const refused = refusals?.stepId === step.id && step.type !== "command" ? refusals : null;
                const cmdErr = refusals?.stepId === step.id && step.type === "command" ? refusals : null;
                const cut = !running && ["running", "quota_wait", "slot_wait", "github_wait"].includes(stepState[step.id]) && run.status !== "COMPLETED";
                const st = (refused || cmdErr) ? "fail" : cut ? "stop" : pending.includes(step.id) ? "wait" : (STEP_STATE[stepState[step.id]]?.[0] ?? (run.status === "COMPLETED" ? "done" : "todo"));
                const icon = st === "skip" ? "↷" : st === "stop" ? "■" : st === "wait" ? "◆" : st === "done" ? "✓" : st === "fail" ? "✕" : st === "cur" ? "↻" : String(i + 1);
                const ty = step.type === "pull_request" ? { label: t("temporal.rd.portalStep") } : STEP_TYPES_UI[step.type] ?? { label: step.type };
                const note = st === "wait" ? t(stepState[step.id] === "quota_wait" ? "temporal.rd.st.quota" : stepState[step.id] === "slot_wait" ? "temporal.rd.st.slot" : stepState[step.id] === "github_wait" ? "temporal.rd.st.githubWait" : "temporal.rd.st.wait")
                  : st === "fail" ? t(refused ? "temporal.rd.st.refused" : "temporal.rd.st.fail")
                  : ["skip", "stop", "cur", "done"].includes(st) ? t("temporal.rd.st." + st) : t(running ? "temporal.rd.st.ahead" : "temporal.rd.st.notRun");
                const quota = running && stepState[step.id] === "quota_wait";
                const slotWait = running && stepState[step.id] === "slot_wait";
                const pr = step.type === "pull_request" ? state.pr?.[step.id] ?? null : null;
                const result = prOutcome(pr, step.mode);
                const ghw = running && stepState[step.id] === "github_wait" && step.type === "pull_request" ? ghWait(state.waitReasons?.[step.id]) : null;
                const cmdMeta = step.type === "command" ? run.commandMeta?.[step.id] ?? null : null;
                const workerCmd = step.type === "command" ? state.commands?.[step.id] ?? null : null;
                const showResultInline = results.has(step.id) && !decide.some((d) => before(d.id)?.id === step.id) && step.id !== finalStep?.id;
                const hasCmdBox = step.type === "command" && Boolean(cmdMeta || workerCmd);
                return (
                  <li key={step.id} class={"t-tl t-tl-" + (quota || slotWait ? "wait" : st)}>
                    <span class="t-node" aria-hidden="true">{quota || slotWait ? "⧗" : icon}</span>
                    <div class="t-tlbody">
                      <b>{step.name}</b>
                      <span class="t-meta">{ty.label}{step.type === "model" && step.model ? " · " + (step.engine === "codex" ? "Codex " : step.engine === "acp" ? "Gemini (ACP) · " : step.engine === "opencode" ? "OpenCode · " : "") + (modelLabels[step.model] ?? step.model) : ""} · {quota ? t("temporal.rd.st.quota") : slotWait ? t("temporal.rd.st.slot") : note}{resumedSet.has(step.id) ? t("temporal.rd.rs.carriedTag") : ""}{step.type === "pull_request" && step.mode === "same-branch" ? t("temporal.rd.sameBranchTag") : ""}{step.type === "condition" && step.id in (state.conditions ?? {}) ? (state.conditions[step.id] ? t("temporal.rd.condYes") : t("temporal.rd.condNo")) : ""}</span>
                      {result && (
                        <div class={"t-prbox" + (result.tone === "off" ? " t-prbox-off" : "")}>
                          <b>{result.title}</b>
                          {result.text && <p>{result.text}</p>}
                          {result.link && <div class="t-row"><a class="t-btn t-primary" href={result.url} target="_blank" rel="noreferrer">{result.link}</a></div>}
                        </div>
                      )}
                      {refused && (
                        <div class="t-prbox t-prbox-err" role="alert">
                          <b><span aria-hidden="true">✕ </span>{stepErrorTitle(refused.code)}</b>
                          <p>{refused.message}</p>
                          <div class="t-row"><button class="t-btn" type="button" data-action="to-worktree" onClick={toWorktree}>{t("temporal.rd.openWorktree")}</button></div>
                        </div>
                      )}
                      {cmdErr && (
                        <div class="t-prbox t-prbox-err" role="alert">
                          <b><span aria-hidden="true">✕ </span>{stepErrorTitle(cmdErr.code)}</b>
                          <p>{cmdErr.message}</p>
                        </div>
                      )}
                      {hasCmdBox && (
                        <CommandStepBox
                          workflowId={workflowId}
                          step={step}
                          meta={cmdMeta}
                          workerCmd={workerCmd}
                          hasResult={showResultInline}
                          onOpenFile={setViewer}
                        />
                      )}
                      {ghw && <Banner tone="warn" icon="⧗" title={ghw.title} action={ghw.needToken ? <a class="t-btn" href="#/settings/github">{t("temporal.rd.updateToken")}</a> : undefined}>{ghw.text}</Banner>}
                      {run.chats?.[step.id] && <a class="t-btn t-ghost t-tight" href={"#/chat/" + encodeURIComponent(run.chats[step.id])}>{t("temporal.rd.openStepChat")}</a>}
                      {quota && <Banner tone="warn" icon="⧗" title={t("temporal.rd.quotaTitle")}>{t("temporal.rd.quotaText")}</Banner>}
                      {slotWait && <Banner tone="warn" icon="⧗" title={t("temporal.rd.slotTitle")}>{t("temporal.rd.slotText")}</Banner>}
                      {showResultInline && !hasCmdBox && <Result workflowId={workflowId} step={step.id} copyable={step.type === "command"} />}
                    </div>
                  </li>
                );
              })}
            </ol>
            {!steps.length && <p class="t-muted">{t("temporal.rd.noSteps")}</p>}
          </section>
          {ciLog && (
            <section class="t-card" aria-labelledby="t-cilog-h">
              <h2 id="t-cilog-h">{t("temporal.rd.ciLogTitle")}</h2>
              <pre class="t-code">{ciLog}</pre>
              <p class="t-help">{t("temporal.rd.ciLogHelp")}</p>
            </section>
          )}
        </div>
        <aside class="t-side">
          <section class="t-card">
            <h2>{t("temporal.rd.about")}</h2>
            <dl class="t-kv">
              <dt>{t("temporal.rd.kv.pipe")}</dt><dd>{run.pipeDeleted ? <>{run.name} <span class="t-muted">{t("temporal.rd.kv.deleted")}</span></> : <a href={"#/temporal/pipe/" + encodeURIComponent(run.definitionId)}>{run.name}</a>}</dd>
              <dt>{t("temporal.rd.kv.version")}</dt><dd>{t("temporal.rd.kv.versionFixed", { n: run.version })}</dd>
              <dt>{t("temporal.rd.kv.run")}</dt><dd>{run.eventUrl ? <a href={run.eventUrl} target="_blank" rel="noreferrer">{sourceText(run)} ↗</a> : sourceText(run)}</dd>
              {run.resumedFrom && <><dt>{t("temporal.rd.kv.resumed")}</dt><dd><a href={"#/temporal/run/" + encodeURIComponent(run.resumedFrom)}>{run.resumedFrom.slice(0, 8)}…</a>{run.resumeFromStep ? t("temporal.rd.kv.resumedFromStep", { name: steps.find((x) => x.id === run.resumeFromStep)?.name ?? run.resumeFromStep }) : ""}</dd></>}
              {run.triggerId && <><dt>{t("temporal.rd.kv.trigger")}</dt><dd><a href={"#/temporal/triggers/" + encodeURIComponent(run.triggerId)}>{t("temporal.rd.kv.triggerLink")}</a></dd></>}
              {run.startTime && <><dt>{t("temporal.rd.kv.started")}</dt><dd>{when(run.startTime, now)}</dd></>}
              {run.closeTime && <><dt>{t("temporal.rd.kv.finished")}</dt><dd>{when(run.closeTime, now)}</dd></>}
              {shownInputs.length > 0 && <><dt>{t("temporal.rd.kv.inputs")}</dt><dd>{shownInputs.map(([k, v]) => {
                const text = Array.isArray(v) ? v.join(", ") : String(v);
                return (
                  <div key={k}><span class="t-mono">{k}</span>: {text.length > INPUT_PREVIEW
                    ? <>{text.slice(0, INPUT_PREVIEW).trim()}… <details class="t-more"><summary>{t("temporal.rd.showFull")}</summary><div class="t-prewrap">{text}</div></details></>
                    : text}</div>
                );
              })}</dd></>}
              {run.runFolder && <><dt>{t("temporal.rd.kv.folder")}</dt><dd class="t-mono">{run.runFolder}</dd></>}
              {me.value?.role === "admin" && run.directory && <><dt>{t("temporal.rd.kv.project")}</dt><dd class="t-mono">{run.directory}</dd></>}
              <dt>ID</dt><dd class="t-mono">{workflowId}</dd>
            </dl>
          </section>
          <RunWorktree workflowId={workflowId} />{/* FEAT-20.7 */}
          <RunCost workflowId={workflowId} steps={steps} />{/* FEAT-20.6 */}
          <section class="t-card t-hide-phone"><h2>{t("temporal.rd.actions")}</h2><div class="t-actcol">{actions}</div></section>
        </aside>
      </div>
      <div class="t-actbar-space t-hide-desk" aria-hidden="true" />
      <div class="t-actbar t-hide-desk">{running ? <>
        {allowed(state.paused ? "resume" : "pause") && (state.paused
          ? <button class="t-btn t-primary" type="button" data-action="resume" disabled={busy} onClick={() => act("resume")}>{t("temporal.rd.resume")}</button>
          : <button class="t-btn" type="button" data-action="pause" disabled={busy} onClick={() => act("pause")}>{t("temporal.rd.pause")}</button>)}
        {allowed("cancel") && <button class="t-btn t-danger" type="button" data-action="cancel" disabled={busy} onClick={() => setSheet("cancel")}>{t("temporal.rd.cancel")}</button>}
        {allowed("terminate") && <button class="t-btn t-more" type="button" data-action="terminate" aria-label={t("temporal.rd.moreTerminate")} disabled={busy} onClick={() => setSheet("terminate")}>⋯</button>}
      </> : actions}</div>
      {toast && <div class="t-toast" role="status">{toast}</div>}
      {viewer && <FileViewer file={viewer} onClose={() => setViewer(null)} />}
      {sheet === "cancel" && (
        <Sheet title={t("temporal.rd.cancelQ")} onClose={() => setSheet(null)}>
          <ul class="t-consequences"><li>{t("temporal.rd.cancel1")}</li>
            <li>{t("temporal.rd.cancel2")}</li></ul>
          <div class="t-row t-stretch"><button class="t-btn" type="button" onClick={() => setSheet(null)}>{t("temporal.rd.dontCancel")}</button>
            <button class="t-btn t-danger-fill" type="button" data-action="confirm-cancel" disabled={busy} onClick={() => act("cancel")}>{t("temporal.rd.cancelRun")}</button></div>
          {allowed("terminate") && <p class="t-help">{t("temporal.rd.stuck")} <button class="t-link" type="button" onClick={() => setSheet("terminate")}>{t("temporal.rd.stopNow")}</button></p>}
        </Sheet>
      )}
      {sheet === "terminate" && (
        <Sheet title={t("temporal.rd.termQ")} onClose={() => setSheet(null)}>
          <ul class="t-consequences"><li>{t("temporal.rd.term1")}</li>
            <li>{t("temporal.rd.term2")}</li>
            <li>{t("temporal.rd.term3")}</li></ul>
          <label class="t-field"><span>{t("temporal.rd.termReason")} <span class="t-muted">{t("temporal.rd.requiredTag")}</span></span>
            <input class="t-input" aria-label={t("temporal.rd.termReason")} maxLength={250} value={reason} onInput={(e) => setReason(e.currentTarget.value)} placeholder={t("temporal.rd.termPh")} /></label>
          <div class="t-row t-stretch"><button class="t-btn" type="button" onClick={() => setSheet(null)}>{t("temporal.back")}</button>
            <button class="t-btn t-danger-fill" type="button" data-action="confirm-terminate" disabled={busy || !reason.trim()} onClick={() => act("terminate", { reason: reason.trim() })}>{t("temporal.rd.stop")}</button></div>
        </Sheet>
      )}
      {sheet?.reject && (
        <Sheet title={t("temporal.rd.rejectQ", { name: sheet.reject.name })} onClose={() => setSheet(null)}>
          <ul class="t-consequences"><li>{t("temporal.rd.reject1")}</li>
            <li>{t("temporal.rd.reject2")}</li></ul>
          <label class="t-field"><span>{t("temporal.rd.comment")} <span class="t-muted">{t("temporal.rd.optionalTag")}</span></span>
            <textarea class="t-input" aria-label={t("temporal.rd.commentAria")} maxLength={250} value={comment} onInput={(e) => setComment(e.currentTarget.value)} placeholder={t("temporal.rd.commentPh")} /></label>
          <div class="t-row t-stretch"><button class="t-btn" type="button" onClick={() => setSheet(null)}>{t("temporal.back")}</button>
            <button class="t-btn t-danger-fill" type="button" data-action="confirm-reject" disabled={busy}
              onClick={() => act("reject", { stepId: sheet.reject.id, generation: state.generation, ...(comment.trim() ? { reason: comment.trim() } : {}) })}>{t("temporal.rd.rejectBtn")}</button></div>
        </Sheet>
      )}
      {sheet === "resume" && chosenResumeVer && (
        <Sheet title={t("temporal.rd.rs.title")} onClose={() => setSheet(null)}>
          {resumeError && <Banner tone="err" icon="✕" title={t("temporal.rd.rs.failed")}>{resumeError}</Banner>}
          {resumeVersions.length > 1 && (
            <label class="t-field"><span>{t("temporal.rd.rs.pipeVersion")}</span>
              <select class="t-input" aria-label={t("temporal.rd.rs.pipeVersion")} value={String(chosenResumeVer.version)} onChange={(e) => {
                const v = Number(e.currentTarget.value);
                const nextVer = resumeVersions.find((x) => x.version === v);
                setResumeVersion(v);
                setResumeFromStep(nextVer?.defaultFromStepId ?? nextVer?.steps[0]?.id ?? "");
                setResumeError("");
                resumeRetry.current = null;
              }}>
                {resumeVersions.map((v) => (
                  <option key={v.version} value={String(v.version)}>
                    {t("temporal.runs.version", { n: v.version })}{v.isLatest ? t("temporal.rd.rs.verLatest") : v.isOriginal ? t("temporal.rd.rs.verOriginal") : ""}{!v.available ? t("temporal.rd.rs.verUnavailable") : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!chosenResumeVer.available && (
            <Banner tone="err" icon="✕" title={t("temporal.rd.rs.unavailTitle")}>{t("temporal.rd.rs.unavailText")}</Banner>
          )}
          <label class="t-field"><span>{t("temporal.rd.rs.startFrom")}</span>
            <select class="t-input" aria-label={t("temporal.rd.rs.startFrom")} value={resumeFromStep || chosenResumeVer.defaultFromStepId || ""} onChange={(e) => { setResumeFromStep(e.currentTarget.value); setResumeError(""); resumeRetry.current = null; }}>
              {chosenResumeVer.steps.map((st, idx) => (
                <option key={st.id} value={st.id}>
                  {/^\d+[.)]\s/.test(st.name) ? st.name : `${idx + 1}. ${st.name}`}{st.id === chosenResumeVer.defaultFromStepId ? t("temporal.rd.rs.defaultTag") : ""}
                </option>
              ))}
            </select>
          </label>
          {resumePreview && (
            <div class="t-resume-preview">
              <div><b>{t("temporal.rd.rs.carriedTitle", { n: resumePreview.reusedSteps.length })}</b> {resumePreview.reusedSteps.length ? resumePreview.reusedSteps.map((id) => chosenResumeVer.steps.find((st) => st.id === id)?.name ?? id).join(", ") : t("temporal.rd.rs.carriedNone")}</div>
              <div class="t-muted"><b>{t("temporal.rd.rs.rerunTitle", { n: resumePreview.rerunSteps.length })}</b> {resumePreview.rerunSteps.map((id) => chosenResumeVer.steps.find((st) => st.id === id)?.name ?? id).join(", ")}</div>
              {run.runFolder && <div class="t-muted">{t("temporal.rd.rs.folderA")} <span class="t-mono">{run.runFolder}</span> {t("temporal.rd.rs.folderB")}</div>}
            </div>
          )}
          <div class="t-row t-stretch"><button class="t-btn" type="button" onClick={() => setSheet(null)}>{t("temporal.back")}</button>
            <button class="t-btn t-primary" type="button" data-action="confirm-resume" disabled={busy || !chosenResumeVer.available} onClick={submitResume}>{t("temporal.rd.rs.confirm")}</button></div>
        </Sheet>
      )}
      {sheet?.rework && (
        <Sheet title={t("temporal.rd.reworkQ", { name: sheet.rework.name })} onClose={() => setSheet(null)}>
          <ul class="t-consequences">
            <li>{t("temporal.rd.rework1")}</li>
            <li>{t("temporal.rd.rework2", { n: state.reworks?.[sheet.rework.id] ?? 0, max: sheet.rework.maxReworks ?? 3 })}</li>
          </ul>
          <label class="t-field"><span>{t("temporal.rd.reworkNote")} <span class="t-muted">{t("temporal.rd.requiredTag")}</span></span>
            <textarea class="t-input" rows="4" aria-label={t("temporal.rd.reworkNote")} maxLength={8000} value={comment} onInput={(e) => setComment(e.currentTarget.value)} placeholder={t("temporal.rd.reworkPh")} /></label>
          <div class="t-row t-stretch"><button class="t-btn" type="button" onClick={() => setSheet(null)}>{t("temporal.back")}</button>
            <button class="t-btn t-primary" type="button" data-action="confirm-rework" disabled={busy || !comment.trim()}
              onClick={() => act("rework", { stepId: sheet.rework.id, generation: state.generation, note: comment.trim() })}>{t("temporal.rd.reworkSend")}</button></div>
        </Sheet>
      )}
    </div>
  );
}
