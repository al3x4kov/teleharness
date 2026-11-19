// FEAT-19.14: run list — status of every run without extra taps, a «waiting
// for you» block on top, filters, search, self-refresh while anything runs.
import { useEffect, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { t, locale } from "../../lib/i18n.js";
import { navigate } from "../../lib/router.js";
import { me } from "../../lib/store.js";
import { Banner, Empty, KINDS, Skeleton, StatusPill, errorText, usePoll, useNow, when, duration } from "./ui.jsx";

const ACTIVE = new Set(["wait", "run", "quota", "paused", "queued"]);
const FILTERS = [
  ["all", () => true],
  ["wait", (r) => r.kind === "wait"],
  ["run", (r) => ["run", "quota", "paused", "queued"].includes(r.kind)],
  ["err", (r) => ["err", "rejected", "unavailable"].includes(r.kind)],
  ["ok", (r) => ["ok", "cancel", "term"].includes(r.kind)],
  ["schedule", (r) => r.source === "schedule"],
];

export const runHref = (id) => "#/temporal/run/" + encodeURIComponent(id);
const kindOf = (r) => r.summary?.kind ?? (r.accepted ? "unavailable" : "queued");

export function RunRow({ run, now }) {
  const s = run.summary ?? {};
  const kind = kindOf(run);
  const total = s.stepsTotal || run.steps?.length || 0;
  const step = s.current ? t("temporal.runs.stepOf", { index: s.current.index, total: s.stepsTotal, name: s.current.name })
    : kind === "ok" ? t("temporal.runs.stepsDone", { done: total, count: total }) : "";
  return (
    <a class="t-runrow" href={runHref(run.workflowId)} data-kind={kind}>
      <span class={"t-runicon " + (KINDS[kind] ?? KINDS.unavailable).cls} aria-hidden="true">{(KINDS[kind] ?? KINDS.unavailable).icon}</span>
      <span class="t-runmain">
        <b>{run.name}</b>
        <span class="t-meta">{run.pipeDeleted ? t("temporal.runs.pipeDeleted") : ""}{t("temporal.runs.version", { n: run.version })} · {t(run.source === "schedule" ? "temporal.source.schedule" : "temporal.source.manual")}{s.startTime ? " · " + when(s.startTime, now) : ""}</span>
      </span>
      <span class="t-runside">
        <StatusPill kind={kind} />
        {(step || s.startTime) && <span class="t-meta">{step}{step && s.startTime ? " · " : ""}{s.startTime ? duration(s.startTime, s.closeTime, now) : ""}</span>}
      </span>
    </a>
  );
}

export default function RunsList() {
  const [runs, setRuns] = useState(null), [error, setError] = useState(null), [stale, setStale] = useState(null);
  const [filter, setFilter] = useState("all"), [query, setQuery] = useState("");
  const now = useNow(30000);
  async function load() {
    try {
      const value = await api.temporalRuns();
      setRuns(value); setError(null); setStale(null);
    } catch (e) {
      setError(e);
      if (runs) setStale(new Date());
    }
  }
  useEffect(() => { load(); }, []);
  const rows = (runs ?? []).map((r) => ({ ...r, kind: kindOf(r) }));
  usePoll(load, 5000, rows.some((r) => ACTIVE.has(r.kind)));

  const startBtn = <button class="t-btn t-primary" type="button" onClick={() => navigate("/temporal/start")}>{t("temporal.runs.startPipe")}</button>;
  const head = (
    <div class="t-head">
      <div><h1>{t("temporal.runs.title")}</h1><p class="t-lead">{t("temporal.runs.lead")}</p></div>
      <span class="t-hide-phone">{startBtn}</span>
    </div>
  );
  if (!runs && error) {
    return <>{head}<Empty icon="⚠" title={t("temporal.runs.loadError")}
      actions={<button class="t-btn t-primary" type="button" onClick={load}>{t("temporal.retry")}</button>}>
      <p>{errorText(error)}</p><p class="t-small t-muted">{t("temporal.runs.keepGoing")}</p></Empty></>;
  }
  if (!runs) return <>{head}<Skeleton rows={5} /></>;
  if (rows.length === 0) {
    return (
      <Empty icon="⇄" title={t("temporal.runs.empty")} actions={<>
        <button class="t-btn t-primary" type="button" onClick={() => navigate("/temporal/new")}>{t("temporal.runs.createPipe")}</button>
        <button class="t-btn" type="button" onClick={() => navigate("/temporal/pipes")}>{t("temporal.runs.myPipes")}</button></>}>
        <p>{t("temporal.runs.emptyText")}</p>
        <div class="t-steps3">
          <div class="t-card"><b>{t("temporal.runs.how1")}</b><span>{t("temporal.runs.how1t")}</span></div>
          <div class="t-card"><b>{t("temporal.runs.how2")}</b><span>{t("temporal.runs.how2t")}</span></div>
          <div class="t-card"><b>{t("temporal.runs.how3")}</b><span>{t("temporal.runs.how3t")}</span></div>
        </div>
      </Empty>
    );
  }
  const waiting = rows.filter((r) => r.kind === "wait");
  // A dead Temporal turns every unfinished run into «unavailable» (closed runs stay cached).
  const allUnavailable = rows.some((r) => r.kind === "unavailable") && !rows.some((r) => ACTIVE.has(r.kind));
  const q = query.trim().toLowerCase();
  const pred = FILTERS.find((f) => f[0] === filter)[1];
  const shown = rows.filter((r) => pred(r) && (!q || r.name.toLowerCase().includes(q) || r.workflowId.toLowerCase().includes(q)));
  const count = (id) => rows.filter(FILTERS.find((f) => f[0] === id)[1]).length;
  return (
    <>
      {head}
      {stale && <Banner tone="warn" icon="⚠" title={t("temporal.runs.offline")}
        action={<button class="t-btn" type="button" onClick={load}>{t("temporal.retry")}</button>}>
        {t("temporal.runs.staleText", { time: stale.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) })}</Banner>}
      {allUnavailable && <Banner tone="err" icon="⛔" title={t("temporal.view.down")}>
        {t("temporal.runs.downText")}{me.value?.role === "admin" ? t("temporal.runs.downAdmin") : ""}</Banner>}
      {waiting.length > 0 && filter === "all" && !q && (
        <section class="t-attn" aria-labelledby="t-attn-h">
          <div class="t-row t-between"><h2 id="t-attn-h">{t("temporal.runs.waiting")}</h2><span class="t-muted">{waiting.length}</span></div>
          <div class="t-list">{waiting.map((r) => <RunRow key={r.workflowId} run={r} now={now} />)}</div>
        </section>
      )}
      <div class="t-search"><input class="t-input" type="search" placeholder={t("temporal.runs.search")}
        aria-label={t("temporal.runs.searchAria")} value={query} onInput={(e) => setQuery(e.currentTarget.value)} /></div>
      <div class="t-filters" role="group" aria-label={t("temporal.runs.filterAria")}>
        {FILTERS.map(([id]) => {
          const n = id === "all" ? 0 : count(id);
          return <button key={id} type="button" class={"t-chip" + (filter === id ? " is-on" : "")} aria-pressed={filter === id}
            onClick={() => setFilter(id)}>{t("temporal.filter." + id)}{n ? " · " + n : ""}</button>;
        })}
      </div>
      {shown.length === 0 ? (
        <Empty icon={filter === "err" ? "✓" : "∅"} title={q ? t("temporal.runs.nothingFound") : filter === "err" ? t("temporal.runs.noErrors") : t("temporal.runs.emptyFilter")}
          actions={<button class="t-btn" type="button" onClick={() => { setFilter("all"); setQuery(""); }}>{t("temporal.runs.showAll")}</button>}>
          <p>{q ? t("temporal.runs.checkQuery") : t("temporal.runs.noMatch")} {t("temporal.runs.history14")}</p>
        </Empty>
      ) : (
        <div class="t-list">{shown.filter((r) => !(filter === "all" && !q && r.kind === "wait")).map((r) => <RunRow key={r.workflowId} run={r} now={now} />)}</div>
      )}
      <p class="t-muted t-small t-foot">{t("temporal.runs.foot")}{rows.some((r) => ACTIVE.has(r.kind)) ? t("temporal.runs.autoRefresh") : ""}</p>
      <div class="t-actbar t-hide-desk">{startBtn}</div>
    </>
  );
}
