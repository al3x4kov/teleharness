// Admin-only list & start sheet for external Temporal workflows.
import { useEffect, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";
import { navigate } from "../../lib/router.js";
import { Banner, Empty, Sheet, Skeleton, StatusPill, errorText, formatDurationStr, useNow, when } from "./ui.jsx";

const STATUS_KEYS = [
  ["", "temporal.ext.st.all"],
  ["Running", "temporal.ext.st.running"],
  ["Completed", "temporal.ext.st.completed"],
  ["Failed", "temporal.ext.st.failed"],
  ["Canceled", "temporal.ext.st.canceled"],
  ["Terminated", "temporal.ext.st.terminated"],
];

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

function StartWorkflowSheet({ defaultAddress, defaultNamespace, onClose, onStarted }) {
  const [workflowType, setWorkflowType] = useState("");
  const [taskQueue, setTaskQueue] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [inputText, setInputText] = useState("");
  const [address, setAddress] = useState(defaultAddress || "");
  const [namespace, setNamespace] = useState(defaultNamespace || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    if (!workflowType.trim() || !taskQueue.trim()) {
      setErr(t("temporal.ext.errTypeQueue"));
      return;
    }
    if (inputText.trim()) {
      try { JSON.parse(inputText); } catch {
        setErr(t("temporal.ext.errJsonInput"));
        return;
      }
    }
    setBusy(true);
    try {
      const res = await api.adminStartExternalWorkflow({
        workflowType: workflowType.trim(),
        taskQueue: taskQueue.trim(),
        ...(workflowId.trim() ? { workflowId: workflowId.trim() } : {}),
        ...(inputText.trim() ? { input: inputText.trim() } : {}),
        ...(address.trim() ? { address: address.trim() } : {}),
        ...(namespace.trim() ? { namespace: namespace.trim() } : {}),
      });
      onStarted?.(res);
    } catch (ex) {
      setErr(errorText(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={t("temporal.ext.startTitle")} onClose={onClose}>
      <form class="t-stack" onSubmit={onSubmit}>
        {err && <Banner tone="err" icon="✕" title={t("temporal.ext.errTitle")}>{err}</Banner>}
        <label class="t-field">
          <span>{t("temporal.ext.wfTypeReq")}</span>
          <input class="t-input" name="workflowType" required placeholder={t("temporal.ext.wfTypePh")}
            value={workflowType} onInput={(e) => setWorkflowType(e.currentTarget.value)} />
        </label>
        <label class="t-field">
          <span>{t("temporal.ext.tqReq")}</span>
          <input class="t-input" name="taskQueue" required placeholder={t("temporal.ext.tqPh")}
            value={taskQueue} onInput={(e) => setTaskQueue(e.currentTarget.value)} />
        </label>
        <label class="t-field">
          <span>{t("temporal.ext.wfIdOpt")}</span>
          <input class="t-input t-mono" name="workflowId" placeholder={t("temporal.ext.wfIdPh")}
            value={workflowId} onInput={(e) => setWorkflowId(e.currentTarget.value)} />
        </label>
        <label class="t-field">
          <span>{t("temporal.ext.inputJson")}</span>
          <textarea class="t-input t-mono" name="input" rows={4} placeholder='{"orderId": 42}'
            value={inputText} onInput={(e) => setInputText(e.currentTarget.value)} />
        </label>
        <details class="t-more">
          <summary>{t("temporal.ext.connSummary")}</summary>
          <div class="t-ext-grid2" style="margin-top:8px">
            <label class="t-field">
              <span>{t("temporal.ext.address")}</span>
              <input class="t-input t-mono" name="address" placeholder="127.0.0.1:7233"
                value={address} onInput={(e) => setAddress(e.currentTarget.value)} />
            </label>
            <label class="t-field">
              <span>Namespace</span>
              <input class="t-input t-mono" name="namespace" placeholder="default"
                value={namespace} onInput={(e) => setNamespace(e.currentTarget.value)} />
            </label>
          </div>
        </details>
        <div class="t-row t-end">
          <button type="button" class="t-btn" onClick={onClose} disabled={busy}>{t("temporal.cancel")}</button>
          <button type="submit" class="t-btn t-primary" data-action="submit-start-workflow" disabled={busy}>
            {busy ? t("temporal.ext.starting") : t("temporal.ext.startBtn")}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export default function ExternalWorkflowsList() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [workflowType, setWorkflowType] = useState("");
  const [taskQueue, setTaskQueue] = useState("");
  const [excludePortal, setExcludePortal] = useState(true);
  const [customQuery, setCustomQuery] = useState("");
  const [address, setAddress] = useState("");
  const [namespace, setNamespace] = useState("");
  const [showStart, setShowStart] = useState(false);
  const now = useNow(15000);

  async function load(overrides = {}) {
    setLoading(true);
    setError(null);
    const params = {
      status: overrides.status !== undefined ? overrides.status : status,
      workflowType: overrides.workflowType !== undefined ? overrides.workflowType : workflowType.trim(),
      taskQueue: overrides.taskQueue !== undefined ? overrides.taskQueue : taskQueue.trim(),
      excludePortal: overrides.excludePortal !== undefined ? overrides.excludePortal : excludePortal,
      query: overrides.query !== undefined ? overrides.query : customQuery.trim(),
      address: overrides.address !== undefined ? overrides.address : address.trim(),
      namespace: overrides.namespace !== undefined ? overrides.namespace : namespace.trim(),
      limit: 50,
    };
    try {
      const res = await api.adminExternalWorkflows(params);
      setData(res);
    } catch (ex) {
      setError(ex);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [status, excludePortal]);

  function onFilterSubmit(e) {
    e.preventDefault();
    load();
  }

  function detailHref(item) {
    const q = new URLSearchParams();
    if (item.runId) q.set("runId", item.runId);
    if (address.trim()) q.set("address", address.trim());
    if (namespace.trim()) q.set("namespace", namespace.trim());
    const qs = q.toString();
    return `#/temporal/external/${encodeURIComponent(item.workflowId)}${qs ? "?" + qs : ""}`;
  }

  const items = data?.items ?? [];

  return (
    <div class="t-stack" data-testid="external-workflows-list">
      <div class="t-head-row t-ext-head">
        <div>
          <h1>{t("temporal.ext.title")}</h1>
          <p class="t-muted t-small">
            {data ? `${data.namespace} @ ${data.address}` : t("temporal.ext.subtitle")}
          </p>
        </div>
        <div class="t-row">
          <button type="button" class="t-btn" data-action="refresh-external" onClick={() => load()} disabled={loading}>
            {loading ? "…" : t("temporal.ext.refresh")}
          </button>
          <button type="button" class="t-btn t-primary" data-action="open-start-workflow" onClick={() => setShowStart(true)}>
            {t("temporal.ext.openStart")}
          </button>
        </div>
      </div>

      <div class="t-chips" role="group" aria-label={t("temporal.ext.statusFilterAria")}>
        {STATUS_KEYS.map(([val, key]) => (
          <button
            key={val || "all"}
            type="button"
            class={"t-chip" + (status === val ? " t-chip-on" : "")}
            aria-pressed={status === val}
            onClick={() => setStatus(val)}
          >
            {t(key)}
          </button>
        ))}
        <label class="t-ext-toggle">
          <input
            type="checkbox"
            checked={excludePortal}
            onChange={(e) => setExcludePortal(e.currentTarget.checked)}
          />
          <span>{t("temporal.ext.onlyExternal")}</span>
        </label>
      </div>

      <form class="t-card t-ext-filters" onSubmit={onFilterSubmit}>
        <div class="t-ext-grid3">
          <input
            class="t-input"
            aria-label={t("temporal.ext.wfTypeAria")}
            placeholder={t("temporal.ext.wfTypeFilterPh")}
            value={workflowType}
            onInput={(e) => setWorkflowType(e.currentTarget.value)}
          />
          <input
            class="t-input"
            aria-label={t("temporal.ext.tqAria")}
            placeholder={t("temporal.ext.tqFilterPh")}
            value={taskQueue}
            onInput={(e) => setTaskQueue(e.currentTarget.value)}
          />
          <button type="submit" class="t-btn" disabled={loading}>{t("temporal.ext.find")}</button>
        </div>
        <details class="t-more" style="margin-top:8px">
          <summary>{t("temporal.ext.connQuery")}</summary>
          <div class="t-stack" style="margin-top:8px">
            <div class="t-ext-grid2">
              <label class="t-field">
                <span>{t("temporal.ext.address")}</span>
                <input
                  class="t-input t-mono"
                  placeholder={data?.address || "127.0.0.1:7233"}
                  value={address}
                  onInput={(e) => setAddress(e.currentTarget.value)}
                />
              </label>
              <label class="t-field">
                <span>Namespace</span>
                <input
                  class="t-input t-mono"
                  placeholder={data?.namespace || "default"}
                  value={namespace}
                  onInput={(e) => setNamespace(e.currentTarget.value)}
                />
              </label>
            </div>
            <label class="t-field">
              <span>{t("temporal.ext.visQuery")}</span>
              <input
                class="t-input t-mono"
                placeholder='ExecutionStatus = "Running" AND WorkflowType != "TeleharnessPipelineV1"'
                value={customQuery}
                onInput={(e) => setCustomQuery(e.currentTarget.value)}
              />
            </label>
          </div>
        </details>
      </form>

      {error && (
        <Banner
          tone="err"
          icon="⚠"
          title={t("temporal.ext.loadErr")}
          action={<button type="button" class="t-btn" onClick={() => load()}>{t("temporal.retry")}</button>}
        >
          {errorText(error)}
        </Banner>
      )}

      {!data && !error && <Skeleton rows={4} />}

      {data && !error && items.length === 0 && (
        <Empty
          icon="⇄"
          title={t("temporal.ext.empty")}
          actions={
            <>
              {excludePortal && (
                <button type="button" class="t-btn" onClick={() => setExcludePortal(false)}>
                  {t("temporal.ext.showWithPortal")}
                </button>
              )}
              <button type="button" class="t-btn t-primary" onClick={() => setShowStart(true)}>
                {t("temporal.ext.openStart")}
              </button>
            </>
          }
        >
          <p>{t("temporal.ext.emptyTextPre")}<code>{data.namespace}</code>{t("temporal.ext.emptyTextPost")}</p>
        </Empty>
      )}

      {items.length > 0 && (
        <div class="t-list">
          {items.map((item) => (
            <a
              key={`${item.workflowId}:${item.runId}`}
              class="t-card t-ext-row"
              href={detailHref(item)}
              aria-label={`${item.workflowType || "Workflow"} · ${item.workflowId}${item.status ? " · " + item.status : ""}`}
              data-testid={`ext-wf-${item.workflowId}`}
            >
              <div class="t-ext-row-main">
                <div class="t-ext-row-top">
                  <StatusPill kind={statusToKind(item.status)} />
                  <b class="t-ext-type">{item.workflowType || "Workflow"}</b>
                  {item.isPortal && <span class="t-pill t-off">{t("temporal.ext.portalPipe")}</span>}
                </div>
                <div class="t-meta t-mono t-ext-id">{item.workflowId}</div>
                <div class="t-meta">
                  {item.taskQueue ? t("temporal.ext.rowQueue", { queue: item.taskQueue }) : ""}
                  {item.historyLength != null ? t("temporal.ext.rowEvents", { count: item.historyLength }) : ""}
                </div>
              </div>
              <div class="t-ext-row-right">
                <span class="t-meta">{when(item.startTime, now)}</span>
                {item.executionDuration && <span class="t-meta t-mono">{formatDurationStr(item.executionDuration)}</span>}
              </div>
            </a>
          ))}
        </div>
      )}

      {showStart && (
        <StartWorkflowSheet
          defaultAddress={address || data?.address || ""}
          defaultNamespace={namespace || data?.namespace || ""}
          onClose={() => setShowStart(false)}
          onStarted={(res) => {
            setShowStart(false);
            const q = new URLSearchParams();
            if (res.runId) q.set("runId", res.runId);
            if (res.address && res.address !== data?.address) q.set("address", res.address);
            if (res.namespace && res.namespace !== data?.namespace) q.set("namespace", res.namespace);
            const qs = q.toString();
            navigate(`/temporal/external/${encodeURIComponent(res.workflowId)}${qs ? "?" + qs : ""}`);
          }}
        />
      )}
    </div>
  );
}
