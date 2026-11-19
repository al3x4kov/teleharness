// FEAT-19.14: one run — step timeline, the decision next to the result it is
// about, pause/resume, cancel and terminate behind sheets with consequences.
// Commands target the exact runId of the last read (FEAT-19.6) and keep their
// actionId across a retry of the same command (idempotent on the server).
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";
import { me } from "../../lib/store.js";
import { Banner, Empty, Sheet, Skeleton, StatusPill, STEP_TYPES_UI, errorText, usePoll, useNow, when, duration } from "./ui.jsx";
import Markdown from "../chat/Markdown.jsx";
import FileCard from "../chat/FileCard.jsx";
import FileViewer from "../chat/FileViewer.jsx";

const ACTIVE = new Set(["wait", "run", "quota", "paused"]);
const STEP_STATE = {
  completed: ["done", "✓"], running: ["cur", "↻"], quota_wait: ["wait", "⧗"], rejected: ["fail", "✕"], waiting: ["todo", ""], skipped: ["skip", "↷"],
};

function Result({ workflowId, step, open: initiallyOpen = false, label = null }) {
  const [open, setOpen] = useState(initiallyOpen), [text, setText] = useState(null), [error, setError] = useState("");
  useEffect(() => {
    if (!open || text !== null) return;
    api.temporalResult(workflowId, step).then((r) => setText(r.text ?? ""), (e) => setError(errorText(e)));
  }, [open]);
  return (
    <div class="t-result">
      <button type="button" class="t-btn t-ghost t-tight" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? t("temporal.rd.hide") : (label ?? t("temporal.rd.show"))}</button>
      {open && (error ? <p class="t-err-text" role="alert">{error}</p> : text === null ? <p class="t-muted t-small">{t("temporal.rd.loadingResult")}</p> : <div class="t-out md"><Markdown text={text || t("temporal.rd.noText")} /></div>)}
    </div>
  );
}

export default function RunDetail({ workflowId }) {
  const [run, setRun] = useState(null), [error, setError] = useState(null), [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false), [toast, setToast] = useState(""), [sheet, setSheet] = useState(null);
  const [reason, setReason] = useState(""), [comment, setComment] = useState(""), [viewer, setViewer] = useState(null);
  const retry = useRef(null);
  const now = useNow(15000);
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
  const steps = run.steps ?? [];
  const files = run.files ?? [];
  // FEAT-19.16: «Итог» — the answer of the last completed model step (or the source of the last artifact).
  const decide = pending.map((id) => steps.find((x) => x.id === id) ?? { id, name: id, type: "approval" });
  const before = (id) => { const i = steps.findIndex((x) => x.id === id); return steps.slice(0, Math.max(0, i)).reverse().find((x) => results.has(x.id)); };
  const lastAnswer = [...steps].reverse().find((x) => x.type === "model" && (run.resultSteps ?? []).includes(x.id)) ?? null;
  // The decision block already shows that answer — no second copy as an interim result.
  const finalStep = lastAnswer && !decide.some((d) => before(d.id)?.id === lastAnswer.id) ? lastAnswer : null;
  const next = (id) => { const i = steps.findIndex((x) => x.id === id); return steps[i + 1]; };

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
      <a class="t-btn t-primary" href={"#/temporal/start/" + encodeURIComponent(run.definitionId) + "?v=" + run.version}>{t("temporal.rd.rerun")}</a>
      <a class="t-btn" href={"#/temporal/pipe/" + encodeURIComponent(run.definitionId)}>{t("temporal.rd.openPipe")}</a>
    </>
  );

  return (
    <div class="t-rundetail">
      <div class="t-head">
        <div><h1>{run.name}</h1>
          <p class="t-facts"><span>{t("temporal.runs.version", { n: run.version })}</span><span>{t(run.source === "schedule" ? "temporal.source.schedule" : "temporal.source.manual")}</span>
            {run.startTime && <span>{t("temporal.rd.started", { when: when(run.startTime, now) })}</span>}
            {run.startTime && <span>{running ? t("temporal.rd.running") : t("temporal.rd.took")}{duration(run.startTime, run.closeTime, now)}</span>}
            {ACTIVE.has(kind) && <span>{t("temporal.rd.autoRefresh")}</span>}{run.pipeDeleted && <span>{t("temporal.rd.pipeDeleted")}</span>}</p></div>
        <StatusPill kind={kind} />
      </div>
      {state.paused && running && <Banner icon="❚❚" title={t("temporal.rd.paused")}>{t("temporal.rd.pausedText")}</Banner>}
      {kind === "err" && <Banner tone="err" icon="✕" title={t("temporal.rd.failed")}>{t("temporal.rd.failedText")}</Banner>}
      {kind === "unavailable" && <Banner tone="err" icon="?" title={t("temporal.view.down")}>{t("temporal.rd.downText")}</Banner>}
      <div class="t-grid2">
        <div>
          {running && decide.map((step) => {
            const prev = before(step.id), after = next(step.id);
            return (
              <section class="t-decide" key={step.id} aria-labelledby={"t-d-" + step.id}>
                <StatusPill kind="wait" />
                <h2 id={"t-d-" + step.id}>{t("temporal.rd.decide", { name: step.name })}</h2>
                {prev ? <><p class="t-muted t-small">{t("temporal.rd.resultOf", { name: prev.name })}</p><Result workflowId={workflowId} step={prev.id} open /></> : null}
                <div class="t-row t-stretch">
                  <button class="t-btn t-primary" type="button" data-action="approve" disabled={busy || !allowed("approve")}
                    onClick={() => act("approve", { stepId: step.id, generation: state.generation })}>{t("temporal.rd.approve")}</button>
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
                const cut = !running && ["running", "quota_wait"].includes(stepState[step.id]) && run.status !== "COMPLETED";
                const st = cut ? "stop" : pending.includes(step.id) ? "wait" : (STEP_STATE[stepState[step.id]]?.[0] ?? (run.status === "COMPLETED" ? "done" : "todo"));
                const icon = st === "skip" ? "↷" : st === "stop" ? "■" : st === "wait" ? "◆" : st === "done" ? "✓" : st === "fail" ? "✕" : st === "cur" ? "↻" : String(i + 1);
                const ty = STEP_TYPES_UI[step.type] ?? { label: step.type };
                const note = st === "wait" ? t(stepState[step.id] === "quota_wait" ? "temporal.rd.st.quota" : "temporal.rd.st.wait")
                  : ["skip", "stop", "cur", "done", "fail"].includes(st) ? t("temporal.rd.st." + st) : t(running ? "temporal.rd.st.ahead" : "temporal.rd.st.notRun");
                const quota = running && stepState[step.id] === "quota_wait";
                return (
                  <li key={step.id} class={"t-tl t-tl-" + (quota ? "wait" : st)}>
                    <span class="t-node" aria-hidden="true">{quota ? "⧗" : icon}</span>
                    <div class="t-tlbody">
                      <b>{step.name}</b>
                      <span class="t-meta">{ty.label}{step.type === "model" && step.model ? " · " + (step.engine === "codex" ? "Codex " : "") + step.model : ""} · {quota ? t("temporal.rd.st.quota") : note}{step.type === "condition" && step.id in (state.conditions ?? {}) ? (state.conditions[step.id] ? t("temporal.rd.condYes") : t("temporal.rd.condNo")) : ""}</span>
                      {run.chats?.[step.id] && <a class="t-btn t-ghost t-tight" href={"#/chat/" + encodeURIComponent(run.chats[step.id])}>{t("temporal.rd.openStepChat")}</a>}
                      {quota && <Banner tone="warn" icon="⧗" title={t("temporal.rd.quotaTitle")}>{t("temporal.rd.quotaText")}</Banner>}
                      {results.has(step.id) && !decide.some((d) => before(d.id)?.id === step.id) && step.id !== finalStep?.id && <Result workflowId={workflowId} step={step.id} />}
                    </div>
                  </li>
                );
              })}
            </ol>
            {!steps.length && <p class="t-muted">{t("temporal.rd.noSteps")}</p>}
          </section>
        </div>
        <aside class="t-side">
          <section class="t-card">
            <h2>{t("temporal.rd.about")}</h2>
            <dl class="t-kv">
              <dt>{t("temporal.rd.kv.pipe")}</dt><dd>{run.pipeDeleted ? <>{run.name} <span class="t-muted">{t("temporal.rd.kv.deleted")}</span></> : <a href={"#/temporal/pipe/" + encodeURIComponent(run.definitionId)}>{run.name}</a>}</dd>
              <dt>{t("temporal.rd.kv.version")}</dt><dd>{t("temporal.rd.kv.versionFixed", { n: run.version })}</dd>
              <dt>{t("temporal.rd.kv.run")}</dt><dd>{t(run.source === "schedule" ? "temporal.source.schedule" : "temporal.source.manual")}</dd>
              {run.startTime && <><dt>{t("temporal.rd.kv.started")}</dt><dd>{when(run.startTime, now)}</dd></>}
              {run.closeTime && <><dt>{t("temporal.rd.kv.finished")}</dt><dd>{when(run.closeTime, now)}</dd></>}
              {Object.keys(run.inputs ?? {}).length > 0 && <><dt>{t("temporal.rd.kv.inputs")}</dt><dd>{Object.entries(run.inputs).map(([k, v]) => <div key={k}><span class="t-mono">{k}</span>: {Array.isArray(v) ? v.join(", ") : String(v)}</div>)}</dd></>}
              {run.runFolder && <><dt>{t("temporal.rd.kv.folder")}</dt><dd class="t-mono">{run.runFolder}</dd></>}
              {me.value?.role === "admin" && run.directory && <><dt>{t("temporal.rd.kv.project")}</dt><dd class="t-mono">{run.directory}</dd></>}
              <dt>ID</dt><dd class="t-mono">{workflowId}</dd>
            </dl>
          </section>
          <section class="t-card t-hide-phone"><h2>{t("temporal.rd.actions")}</h2><div class="t-actcol">{actions}</div></section>
        </aside>
      </div>
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
    </div>
  );
}
