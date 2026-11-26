// Admin-only detail view for an external Temporal workflow:
// status, input/result/failure, pending activities, history with Reset points,
// Signal, Query, Reset, Cancel, Terminate.
import { useEffect, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";
import { navigate } from "../../lib/router.js";
import { Banner, Empty, Sheet, Skeleton, StatusPill, errorText, hashQuery, useNow, when } from "./ui.jsx";

function statusToKind(status) {
  switch (String(status || "").toUpperCase()) {
    case "RUNNING": return "run";
    case "COMPLETED": return "ok";
    case "FAILED":
    case "TIMED_OUT": return "err";
    case "CANCELED": return "cancel";
    case "TERMINATED": return "term";
    case "CONTINUED_AS_NEW": return "ok";
    default: return "unavailable";
  }
}

function fmtJson(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export default function ExternalWorkflowDetail({ workflowId }) {
  const hq = hashQuery();
  const [runId, setRunId] = useState(hq.get("runId") || "");
  const address = hq.get("address") || "";
  const namespace = hq.get("namespace") || "";

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState("");
  const [notice, setNotice] = useState(null);
  const [copiedKey, setCopiedKey] = useState("");
  const [queryOut, setQueryOut] = useState(null);

  const [sigName, setSigName] = useState("");
  const [sigInput, setSigInput] = useState("");
  const [qType, setQType] = useState("");
  const [qInput, setQInput] = useState("");
  const [resetMode, setResetMode] = useState("event");
  const [resetEventId, setResetEventId] = useState("");
  const [resetType, setResetType] = useState("LastWorkflowTask");
  const [resetReason, setResetReason] = useState("");
  const [reapplyExclude, setReapplyExclude] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [termReason, setTermReason] = useState("");

  const now = useNow(15000);

  async function load(overrideRunId) {
    setLoading(true);
    setError(null);
    const targetRunId = overrideRunId !== undefined ? overrideRunId : runId;
    try {
      const res = await api.adminExternalWorkflow(workflowId, {
        runId: targetRunId || undefined,
        address: address || undefined,
        namespace: namespace || undefined,
      });
      setData(res);
      if (res.resetPoints?.length && !resetEventId) {
        setResetEventId(String(res.resetPoints[0].eventId));
      }
    } catch (ex) {
      setError(ex);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [workflowId, runId]);

  async function copyText(key, text) {
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(""), 2000);
    } catch {}
  }

  function connExtra() {
    return {
      ...(runId ? { runId } : {}),
      ...(address ? { address } : {}),
      ...(namespace ? { namespace } : {}),
    };
  }

  function openSheet(kind, presetEventId = null) {
    setActionErr("");
    if (kind === "reset") {
      if (presetEventId) {
        setResetMode("event");
        setResetEventId(String(presetEventId));
      } else if (data?.resetPoints?.length) {
        setResetMode("event");
        setResetEventId(String(data.resetPoints[0].eventId));
      } else {
        setResetMode("type");
      }
    }
    setSheet(kind);
  }

  async function submitSignal(e) {
    e.preventDefault();
    setActionErr("");
    if (!sigName.trim()) return setActionErr(t("temporal.ext.errSigName"));
    if (sigInput.trim()) {
      try { JSON.parse(sigInput); } catch { return setActionErr(t("temporal.ext.errSigJson")); }
    }
    setBusy(true);
    try {
      await api.adminSignalExternalWorkflow(workflowId, {
        ...connExtra(),
        name: sigName.trim(),
        ...(sigInput.trim() ? { input: sigInput.trim() } : {}),
      });
      setSheet(null);
      setNotice({ tone: "info", title: t("temporal.ext.sigSentTitle", { name: sigName.trim() }), text: t("temporal.ext.sigSentText") });
      setSigInput("");
      await load();
    } catch (ex) {
      setActionErr(errorText(ex));
    } finally {
      setBusy(false);
    }
  }

  async function submitQuery(e) {
    e.preventDefault();
    setActionErr("");
    if (!qType.trim()) return setActionErr(t("temporal.ext.errQueryType"));
    if (qInput.trim()) {
      try { JSON.parse(qInput); } catch { return setActionErr(t("temporal.ext.errQueryJson")); }
    }
    setBusy(true);
    try {
      const res = await api.adminQueryExternalWorkflow(workflowId, {
        ...connExtra(),
        type: qType.trim(),
        ...(qInput.trim() ? { input: qInput.trim() } : {}),
      });
      setQueryOut({ type: qType.trim(), text: fmtJson(res.result ?? res.raw ?? "") });
      setSheet(null);
    } catch (ex) {
      setActionErr(errorText(ex));
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(e) {
    e.preventDefault();
    setActionErr("");
    if (!resetReason.trim()) return setActionErr(t("temporal.ext.errResetReason"));
    if (resetMode === "event" && (!resetEventId || !/^\d+$/.test(String(resetEventId)))) {
      return setActionErr(t("temporal.ext.errResetEventId"));
    }
    setBusy(true);
    try {
      const res = await api.adminResetExternalWorkflow(workflowId, {
        ...connExtra(),
        ...(resetMode === "event" ? { eventId: Number(resetEventId) } : { resetType }),
        reason: resetReason.trim(),
        ...(reapplyExclude ? { reapplyExclude } : {}),
      });
      setSheet(null);
      setResetReason("");
      setNotice({
        tone: "info",
        title: t("temporal.ext.resetDoneTitle"),
        text: res.runId ? t("temporal.ext.resetDoneNewRun", { runId: res.runId }) : t("temporal.ext.resetDoneText"),
        newRunId: res.runId || null,
      });
      if (res.runId) {
        setRunId(res.runId);
        const q = new URLSearchParams();
        q.set("runId", res.runId);
        if (address) q.set("address", address);
        if (namespace) q.set("namespace", namespace);
        navigate(`/temporal/external/${encodeURIComponent(workflowId)}?${q.toString()}`, { replace: true });
      } else {
        await load();
      }
    } catch (ex) {
      setActionErr(errorText(ex));
    } finally {
      setBusy(false);
    }
  }

  async function submitCancel(e) {
    e.preventDefault();
    setActionErr("");
    setBusy(true);
    try {
      await api.adminCancelExternalWorkflow(workflowId, {
        ...connExtra(),
        ...(cancelReason.trim() ? { reason: cancelReason.trim() } : {}),
      });
      setSheet(null);
      setCancelReason("");
      setNotice({ tone: "warn", title: t("temporal.ext.cancelDoneTitle"), text: t("temporal.ext.cancelDoneText") });
      await load();
    } catch (ex) {
      setActionErr(errorText(ex));
    } finally {
      setBusy(false);
    }
  }

  async function submitTerminate(e) {
    e.preventDefault();
    setActionErr("");
    if (!termReason.trim()) return setActionErr(t("temporal.ext.errTermReason"));
    setBusy(true);
    try {
      await api.adminTerminateExternalWorkflow(workflowId, {
        ...connExtra(),
        reason: termReason.trim(),
      });
      setSheet(null);
      setTermReason("");
      setNotice({ tone: "warn", title: t("temporal.ext.termDoneTitle"), text: t("temporal.ext.termDoneText") });
      await load();
    } catch (ex) {
      setActionErr(errorText(ex));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <Empty
        icon="⚠"
        title={t("temporal.ext.openErr")}
        actions={
          <>
            <button type="button" class="t-btn t-primary" onClick={() => load()}>{t("temporal.retry")}</button>
            <a class="t-btn" href="#/temporal/external">{t("temporal.ext.toList")}</a>
          </>
        }
      >
        <p>{errorText(error)}</p>
      </Empty>
    );
  }
  if (!data) return <Skeleton rows={5} />;

  const wf = data.workflow ?? {};
  const isRunning = wf.status === "RUNNING";
  const events = data.events ?? [];
  const resetPoints = data.resetPoints ?? [];
  const pending = data.pendingActivities ?? [];

  return (
    <div class="t-stack" data-testid="external-workflow-detail">
      <div class="t-head-row t-ext-head">
        <div class="t-ext-title-wrap">
          <div class="t-row" style="gap:8px;flex-wrap:wrap">
            <h2 class="t-h2">{wf.workflowType || "Workflow"}</h2>
            <StatusPill kind={statusToKind(wf.status)} />
          </div>
          <div class="t-row" style="gap:8px;margin-top:4px;flex-wrap:wrap">
            <span class="t-meta t-mono t-ext-id">{wf.workflowId}</span>
            <button
              type="button"
              class="t-btn t-ghost t-tight"
              onClick={() => copyText("wfid", wf.workflowId)}
            >
              {copiedKey === "wfid" ? t("temporal.ext.copied") : t("temporal.ext.copyId")}
            </button>
          </div>
        </div>
        <div class="t-row">
          <button type="button" class="t-btn" onClick={() => load()} disabled={loading}>
            {loading ? "…" : t("temporal.ext.refresh")}
          </button>
          {wf.uiUrl && (
            <a class="t-btn" href={wf.uiUrl} target="_blank" rel="noreferrer">
              Temporal UI ↗
            </a>
          )}
        </div>
      </div>

      {notice && (
        <Banner tone={notice.tone} icon={notice.tone === "warn" ? "⚠" : "✓"} title={notice.title}>
          {notice.text}
        </Banner>
      )}

      {data.failure && (
        <Banner tone="err" icon="✕" title={t("temporal.ext.wfErrTitle")}>
          <div>{data.failure.message}</div>
          {data.failure.cause && <div class="t-meta" style="margin-top:4px">{t("temporal.ext.cause", { cause: data.failure.cause })}</div>}
        </Banner>
      )}

      <div class="t-cols">
        <div class="t-main t-stack">
          <section class="t-card">
            <h3>{t("temporal.ext.controls")}</h3>
            <div class="t-row t-ext-actions">
              <button type="button" class="t-btn t-primary" data-action="open-signal" disabled={!isRunning} onClick={() => openSheet("signal")}>
                ⚡ Signal
              </button>
              <button type="button" class="t-btn" data-action="open-query" onClick={() => openSheet("query")}>
                🔍 Query
              </button>
              <button type="button" class="t-btn" data-action="open-reset" onClick={() => openSheet("reset")}>
                ↺ Reset
              </button>
              <button type="button" class="t-btn" data-action="open-cancel" disabled={!isRunning} onClick={() => openSheet("cancel")}>
                {t("temporal.ext.cancelBtn")}
              </button>
              <button type="button" class="t-btn t-danger" data-action="open-terminate" disabled={!isRunning} onClick={() => openSheet("terminate")}>
                {t("temporal.ext.termBtn")}
              </button>
            </div>
            {!isRunning && (
              <p class="t-help">{t("temporal.ext.closedHint")}</p>
            )}
          </section>

          {queryOut && (
            <section class="t-card" data-testid="query-result-card">
              <div class="t-head-row t-ext-head">
                <h3>{t("temporal.ext.queryOutTitle")} <span class="t-mono">{queryOut.type}</span></h3>
                <button type="button" class="t-btn t-tight" data-action="copy-query-result" onClick={() => copyText("query", queryOut.text)}>
                  {copiedKey === "query" ? t("temporal.ext.copied") : t("temporal.ext.copy")}
                </button>
              </div>
              <pre class="t-code">{queryOut.text || t("temporal.ext.emptyReply")}</pre>
            </section>
          )}

          {(data.input !== null || data.result !== null) && (
            <section class="t-card t-stack">
              <h3>{t("temporal.ext.payloadTitle")}</h3>
              {data.input !== null && (
                <div>
                  <p class="t-meta" style="margin-bottom:4px">{t("temporal.ext.inputLabel")}</p>
                  <pre class="t-code" data-testid="ext-input-payload">{fmtJson(data.input)}</pre>
                </div>
              )}
              {data.result !== null && (
                <div>
                  <p class="t-meta" style="margin-bottom:4px">{t("temporal.ext.resultLabel")}</p>
                  <pre class="t-code" data-testid="ext-result-payload">{fmtJson(data.result)}</pre>
                </div>
              )}
            </section>
          )}

          {pending.length > 0 && (
            <section class="t-card">
              <h3>{t("temporal.ext.pendingTitle", { count: pending.length })}</h3>
              <ul class="t-ext-pending">
                {pending.map((a) => (
                  <li key={`${a.activityId}-${a.activityType}`}>
                    <b>{a.activityType}</b> <span class="t-meta">{t("temporal.ext.pendingMeta", { id: a.activityId, state: a.state, attempt: a.attempt })}</span>
                    {a.lastFailure && <div class="t-err-text t-small">{a.lastFailure}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section class="t-card">
            <h3>{t("temporal.ext.historyTitle", { count: data.totalEvents ?? events.length })}</h3>
            {events.length === 0 ? (
              <p class="t-muted t-small">{t("temporal.ext.noEvents")}</p>
            ) : (
              <ol class="t-ext-events">
                {events.map((ev) => (
                  <li key={ev.eventId} class={"t-ext-ev" + (ev.resettable ? " t-ext-ev-reset" : "")}>
                    <span class="t-ext-evid t-mono">#{ev.eventId}</span>
                    <div class="t-ext-evbody">
                      <div class="t-row" style="gap:6px;flex-wrap:wrap">
                        <b>{ev.shortType || ev.eventType}</b>
                        {ev.resettable && (
                          <button type="button" class="t-btn t-ghost t-tight" onClick={() => openSheet("reset", ev.eventId)}>
                            {t("temporal.ext.resetHere")}
                          </button>
                        )}
                      </div>
                      <div class="t-meta">
                        {when(ev.eventTime, now)}{ev.summary ? ` · ${ev.summary}` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside class="t-side">
          <section class="t-card">
            <h3>{t("temporal.ext.about")}</h3>
            <dl class="t-kv">
              <dt>{t("temporal.ext.kvType")}</dt><dd>{wf.workflowType || "—"}</dd>
              <dt>{t("temporal.ext.kvQueue")}</dt><dd class="t-mono">{wf.taskQueue || "—"}</dd>
              <dt>Namespace</dt><dd class="t-mono">{data.namespace}</dd>
              <dt>{t("temporal.ext.kvAddress")}</dt><dd class="t-mono">{data.address}</dd>
              <dt>Run ID</dt><dd class="t-mono">{wf.runId || "—"}</dd>
              <dt>{t("temporal.ext.kvStarted")}</dt><dd>{when(wf.startTime, now) || "—"}</dd>
              {wf.closeTime && <><dt>{t("temporal.ext.kvClosed")}</dt><dd>{when(wf.closeTime, now)}</dd></>}
              {wf.executionDuration && <><dt>{t("temporal.ext.kvDuration")}</dt><dd class="t-mono">{wf.executionDuration}</dd></>}
              <dt>{t("temporal.ext.kvEvents")}</dt><dd>{data.totalEvents ?? wf.historyLength ?? 0}</dd>
            </dl>
          </section>
        </aside>
      </div>

      {sheet === "signal" && (
        <Sheet title={t("temporal.ext.sigTitle")} onClose={() => setSheet(null)}>
          <form class="t-stack" onSubmit={submitSignal}>
            {actionErr && <Banner tone="err" icon="✕" title={t("temporal.ext.errTitle")}>{actionErr}</Banner>}
            <label class="t-field">
              <span>{t("temporal.ext.sigNameReq")}</span>
              <input class="t-input" name="signalName" required placeholder={t("temporal.ext.sigNamePh")}
                value={sigName} onInput={(e) => setSigName(e.currentTarget.value)} />
            </label>
            <label class="t-field">
              <span>{t("temporal.ext.sigPayload")}</span>
              <textarea class="t-input t-mono" name="signalInput" rows={4} placeholder='{"approved": true}'
                value={sigInput} onInput={(e) => setSigInput(e.currentTarget.value)} />
            </label>
            <div class="t-row t-end">
              <button type="button" class="t-btn" onClick={() => setSheet(null)} disabled={busy}>{t("temporal.cancel")}</button>
              <button type="submit" class="t-btn t-primary" data-action="submit-signal" disabled={busy}>
                {busy ? t("temporal.ext.sigSending") : t("temporal.ext.sigSubmit")}
              </button>
            </div>
          </form>
        </Sheet>
      )}

      {sheet === "query" && (
        <Sheet title={t("temporal.ext.qTitle")} onClose={() => setSheet(null)}>
          <form class="t-stack" onSubmit={submitQuery}>
            {actionErr && <Banner tone="err" icon="✕" title={t("temporal.ext.errTitle")}>{actionErr}</Banner>}
            <label class="t-field">
              <span>{t("temporal.ext.qTypeReq")}</span>
              <input class="t-input" name="queryType" required placeholder={t("temporal.ext.qTypePh")}
                value={qType} onInput={(e) => setQType(e.currentTarget.value)} />
            </label>
            <label class="t-field">
              <span>{t("temporal.ext.qArg")}</span>
              <textarea class="t-input t-mono" name="queryInput" rows={3} placeholder='{"verbose": true}'
                value={qInput} onInput={(e) => setQInput(e.currentTarget.value)} />
            </label>
            <div class="t-row t-end">
              <button type="button" class="t-btn" onClick={() => setSheet(null)} disabled={busy}>{t("temporal.cancel")}</button>
              <button type="submit" class="t-btn t-primary" data-action="submit-query" disabled={busy}>
                {busy ? t("temporal.ext.qRunning") : t("temporal.ext.qSubmit")}
              </button>
            </div>
          </form>
        </Sheet>
      )}

      {sheet === "reset" && (
        <Sheet title="Reset workflow" onClose={() => setSheet(null)}>
          <form class="t-stack" onSubmit={submitReset}>
            {actionErr && <Banner tone="err" icon="✕" title={t("temporal.ext.errTitle")}>{actionErr}</Banner>}
            <p class="t-muted t-small">
              {t("temporal.ext.resetDescPre")}<code>WorkflowTaskCompleted</code>{t("temporal.ext.resetDescPost")}
            </p>
            <div class="t-chips">
              <button type="button" class={"t-chip" + (resetMode === "event" ? " t-chip-on" : "")} onClick={() => setResetMode("event")}>
                {t("temporal.ext.resetByEvent")}
              </button>
              <button type="button" class={"t-chip" + (resetMode === "type" ? " t-chip-on" : "")} onClick={() => setResetMode("type")}>
                {t("temporal.ext.resetByType")}
              </button>
            </div>
            {resetMode === "event" ? (
              resetPoints.length > 0 ? (
                <label class="t-field">
                  <span>{t("temporal.ext.resetPointReq")}</span>
                  <select class="t-input" name="resetEventId" value={resetEventId} onChange={(e) => setResetEventId(e.currentTarget.value)}>
                    {resetPoints.map((p) => (
                      <option key={p.eventId} value={String(p.eventId)}>
                        {p.label}{p.eventTime ? ` (${when(p.eventTime, now)})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label class="t-field">
                  <span>Event ID (WorkflowTaskCompleted) *</span>
                  <input class="t-input t-mono" name="resetEventId" type="number" min="1"
                    value={resetEventId} onInput={(e) => setResetEventId(e.currentTarget.value)} />
                </label>
              )
            ) : (
              <label class="t-field">
                <span>{t("temporal.ext.resetTypeReq")}</span>
                <select class="t-input" name="resetType" value={resetType} onChange={(e) => setResetType(e.currentTarget.value)}>
                  <option value="FirstWorkflowTask">{t("temporal.ext.rtFirst")}</option>
                  <option value="LastWorkflowTask">{t("temporal.ext.rtLast")}</option>
                  <option value="LastContinuedAsNew">{t("temporal.ext.rtContinue")}</option>
                </select>
              </label>
            )}
            <label class="t-field">
              <span>{t("temporal.ext.reapplyLabel")}</span>
              <select class="t-input" name="reapplyExclude" value={reapplyExclude} onChange={(e) => setReapplyExclude(e.currentTarget.value)}>
                <option value="">{t("temporal.ext.reapplyDefault")}</option>
                <option value="Signal">{t("temporal.ext.reapplySignal")}</option>
                <option value="Update">{t("temporal.ext.reapplyUpdate")}</option>
                <option value="All">{t("temporal.ext.reapplyAll")}</option>
              </select>
            </label>
            <label class="t-field">
              <span>{t("temporal.ext.resetReasonReq")}</span>
              <input class="t-input" name="resetReason" required placeholder={t("temporal.ext.resetReasonPh")}
                value={resetReason} onInput={(e) => setResetReason(e.currentTarget.value)} />
            </label>
            <div class="t-row t-end">
              <button type="button" class="t-btn" onClick={() => setSheet(null)} disabled={busy}>{t("temporal.cancel")}</button>
              <button type="submit" class="t-btn t-primary" data-action="submit-reset" disabled={busy || !resetReason.trim()}>
                {busy ? t("temporal.ext.resetting") : t("temporal.ext.resetSubmit")}
              </button>
            </div>
          </form>
        </Sheet>
      )}

      {sheet === "cancel" && (
        <Sheet title={t("temporal.ext.cancelTitle")} onClose={() => setSheet(null)}>
          <form class="t-stack" onSubmit={submitCancel}>
            {actionErr && <Banner tone="err" icon="✕" title={t("temporal.ext.errTitle")}>{actionErr}</Banner>}
            <p class="t-muted t-small">{t("temporal.ext.cancelDesc")}</p>
            <label class="t-field">
              <span>{t("temporal.ext.cancelReason")}</span>
              <input class="t-input" name="cancelReason" placeholder={t("temporal.ext.cancelReasonPh")}
                value={cancelReason} onInput={(e) => setCancelReason(e.currentTarget.value)} />
            </label>
            <div class="t-row t-end">
              <button type="button" class="t-btn" onClick={() => setSheet(null)} disabled={busy}>{t("temporal.ext.back")}</button>
              <button type="submit" class="t-btn t-primary" data-action="submit-cancel" disabled={busy}>
                {busy ? t("temporal.ext.canceling") : t("temporal.ext.cancelSubmit")}
              </button>
            </div>
          </form>
        </Sheet>
      )}

      {sheet === "terminate" && (
        <Sheet title={t("temporal.ext.termTitle")} onClose={() => setSheet(null)}>
          <form class="t-stack" onSubmit={submitTerminate}>
            {actionErr && <Banner tone="err" icon="✕" title={t("temporal.ext.errTitle")}>{actionErr}</Banner>}
            <p class="t-muted t-small">
              {t("temporal.ext.termDescPre")}<code>TERMINATED</code>{t("temporal.ext.termDescPost")}
            </p>
            <label class="t-field">
              <span>{t("temporal.ext.termReasonReq")}</span>
              <input class="t-input" name="terminateReason" required placeholder={t("temporal.ext.termReasonPh")}
                value={termReason} onInput={(e) => setTermReason(e.currentTarget.value)} />
            </label>
            <div class="t-row t-end">
              <button type="button" class="t-btn" onClick={() => setSheet(null)} disabled={busy}>{t("temporal.ext.back")}</button>
              <button type="submit" class="t-btn t-danger" data-action="submit-terminate" disabled={busy || !termReason.trim()}>
                {busy ? t("temporal.ext.terminating") : t("temporal.ext.termSubmit")}
              </button>
            </div>
          </form>
        </Sheet>
      )}
    </div>
  );
}
