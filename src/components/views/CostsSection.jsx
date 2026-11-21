// FEAT-20.6: Настройки → «Расходы» (макет design/mockups-v2/epic20-api-equivalent-cost.html, бриф
// BRIEF-20.6). Сумма «по ценам API» — никогда не «потрачено»: везде «≈» и подпись, у admin рядом —
// реальная стоимость подписок. «Нет данных» — отдельно с причиной, не $0 (кр. 4).
// admin: «Обзор · Люди · Прайс · Подписки · Бюджеты»; тенант — только свой «Обзор» (кр. 11).
import { useEffect, useRef, useState } from "preact/hooks";
import "../costs.css";
import { me, connection } from "../../lib/store.js";
import { navigate } from "../../lib/router.js";
import { NO_DATA_TEXT, clip, costApi, costFilterHint, costTick, dayTitle, fmtCost, fmtTokens, monthTitle, paybackText, plural, projectName, rangeTitle, turnsWord } from "../../lib/costs.js";
import { Modal } from "./HomeView.jsx";
import { lang, locale, t as tr } from "../../lib/i18n.js";

const NB = " ";
const offline = () => connection.value?.state === "offline" || (typeof navigator !== "undefined" && navigator.onLine === false);
const hhmm = (ms) => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
const CACHE_KEY = (uid) => `teleharness.costs.summary.${uid}`;
const ENGINE_CLASS = { claude: "is-claude", codex: "is-codex", acp: "is-acp", opencode: "is-teleharness" };

function Tabs({ tab, setTab, admin }) {
  if (!admin) return null;
  const list = [["overview", tr("costs.tabs.overview")], ["people", tr("costs.tabs.people")], ["prices", tr("costs.tabs.prices")], ["subs", tr("costs.tabs.subs")], ["budgets", tr("costs.tabs.budgets")]];
  return (
    <div class="seg cost-tabs" role="tablist" aria-label={tr("costs.tabs.aria")}>
      {list.map(([id, t]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} class={"seg-btn" + (tab === id ? " active" : "")} onClick={() => setTab(id)}>{t}</button>
      ))}
    </div>
  );
}

export default function CostsSection({ initialTab = "overview" } = {}) {
  const admin = me.value?.role === "admin";
  const [tab, setTab] = useState(initialTab);
  const [filter, setFilter] = useState(() => {
    const hint = costFilterHint.value;
    costFilterHint.value = null;
    return { period: "month", ...(hint ?? {}) };
  });
  return (
    <div class="costs" data-req="FEAT-20.6">
      <Tabs tab={tab} setTab={setTab} admin={admin} />
      {tab === "overview" || !admin ? <Overview admin={admin} filter={filter} setFilter={setFilter} goPrices={() => setTab("prices")} goSubs={() => setTab("subs")} />
        : tab === "people" ? <People filter={filter} open={(u) => { setFilter({ ...filter, user: u.userId, userName: u.name }); setTab("overview"); }} />
        : tab === "prices" ? <Prices />
        : tab === "subs" ? <Subscriptions />
        : <Budgets />}
    </div>
  );
}

// ---- Обзор -------------------------------------------------------------------------

function PeriodBar({ filter, setFilter, data }) {
  const month = data?.period?.kind === "month" ? data.period.month : null;
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prev = now.getMonth() === 0 ? `${now.getFullYear() - 1}-12` : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, "0")}`;
  const chips = [["month", monthTitle(month ?? cur)], ["prev", monthTitle(prev)], ["30d", tr("costs.period.30d")], ["custom", tr("costs.period.custom")]];
  return (
    <div class="cost-period">
      <div class="cost-chips" role="radiogroup" aria-label={tr("costs.period.aria")}>
        {chips.map(([id, t]) => (
          <button key={id} type="button" role="radio" aria-checked={filter.period === id} class={"cost-chip" + (filter.period === id ? " is-on" : "")} onClick={() => setFilter({ ...filter, period: id })}>{t}</button>
        ))}
      </div>
      {filter.period === "custom" && (
        <div class="cost-custom">
          <label>{tr("costs.period.from")} <input type="date" value={filter.from ?? ""} onInput={(e) => setFilter({ ...filter, from: e.currentTarget.value })} /></label>
          <label>{tr("costs.period.to")} <input type="date" value={filter.to ?? ""} onInput={(e) => setFilter({ ...filter, to: e.currentTarget.value })} /></label>
        </div>
      )}
    </div>
  );
}

function useSummary(filter) {
  const uid = me.value?.id ?? "anon";
  const [state, setState] = useState({ data: null, error: null, at: null, stale: false });
  const tick = costTick.value;
  const seq = useRef(0);
  useEffect(() => {
    if (filter.period === "custom" && (!filter.from || !filter.to)) return;
    const n = ++seq.current;
    costApi.summary(filter).then(
      (data) => {
        if (n !== seq.current) return;
        setState({ data, error: null, at: Date.now(), stale: false });
        try {
          if (filter.period === "month" && !filter.user && !filter.project) localStorage.setItem(CACHE_KEY(uid), JSON.stringify({ at: Date.now(), data }));
        } catch {}
      },
      (error) => {
        if (n !== seq.current) return;
        if (error?.status === 503 || error?.status === 403) return setState({ data: null, error, at: null, stale: false }); // журнал недоступен — не старые цифры
        // оффлайн: последние данные с меткой времени (N-17)
        let cached = null;
        try {
          cached = JSON.parse(localStorage.getItem(CACHE_KEY(uid)) ?? "null");
        } catch {}
        setState((s) => (s.data ? { ...s, error, stale: true } : cached && filter.period === "month" ? { data: cached.data, error, at: cached.at, stale: true } : { data: null, error, at: null, stale: false }));
      },
    );
  }, [filter.period, filter.from, filter.to, filter.user, filter.project, tick, connection.value?.state]);
  return state;
}

function Overview({ admin, filter, setFilter, goPrices, goSubs }) {
  const { data, error, at, stale } = useSummary(filter);
  const [table, setTable] = useState(false);
  const [noDataOpen, setNoDataOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  if (!data && error?.status === 503) return <LedgerDown admin={admin} />;
  if (!data && error) return (
    <div class="cost-fail" role="alert">
      <p><b>{tr("costs.overview.loadFailed")}</b></p>
      <p class="cost-muted">{offline() ? tr("costs.overview.offline") : tr("costs.overview.noResp")}</p>
    </div>
  );
  if (!data) return <div class="cost-skel" role="status" aria-label={tr("costs.overview.loadingAria")}><span /><span /><span /></div>;
  const t = data.totals;
  const subs = data.subscriptions;
  const pv = data.priceVersion;
  const tenant = !admin;
  const bf = (data.backfill ?? []).filter((b) => !b.done || b.error);
  return (
    <div class="cost-overview">
      <PeriodBar filter={filter} setFilter={setFilter} data={data} />
      <p class="cost-caption">
        {rangeTitle(data.period.from, data.period.to)}{tr("costs.overview.tz", { tz: data.tz })}{pv ? tr("costs.overview.priceVer", { v: pv.version, date: dayTitle(new Date(pv.createdAt).toISOString().slice(0, 10)) }) : ""}
        {filter.user ? <> · {filter.userName ?? filter.user} <button type="button" class="cost-link" onClick={() => setFilter({ ...filter, user: null, userName: null })}>{tr("costs.overview.allPeople")}</button></> : null}
        {filter.project ? <>{tr("costs.overview.projectPrefix", { name: projectName(filter.project) })} <button type="button" class="cost-link" onClick={() => setFilter({ ...filter, project: null })}>{tr("costs.overview.allProjects")}</button></> : null}
      </p>
      {stale && <div class="cost-banner is-offline" role="status">{tr("costs.overview.stale", { time: hhmm(at) })}</div>}
      {data.ledger && !data.ledger.ok && <LedgerDown admin={admin} inline detail={data.ledger.error} />}
      {bf.map((b) => (
        <div key={b.source} class={"cost-banner" + (b.error ? " is-warn" : "")} role="status">
          {b.error ? (
            <>
              <span aria-hidden="true">! </span>{tr("costs.overview.backfillErr", { source: b.source === "opencode" ? "opencode" : "Claude & Codex", error: b.error })}
              {admin && <button type="button" class="cost-link" onClick={() => costApi.backfill()}>{tr("costs.overview.backfillRetry")}</button>}
            </>
          ) : (
            <>{tr("costs.overview.backfillRun", { progress: b.progress ?? 0, total: tr(b.source === "opencode" ? "costs.backfillChats" : "costs.backfillTurns", { count: b.total }) })}</>
          )}
        </div>
      ))}
      {admin && data.noPriceModels > 0 && (
        <div class="cost-banner is-warn" role="status">
          <span aria-hidden="true">! </span>{tr("costs.overview.noPriceBanner", { models: tr("costs.modelsGen", { count: data.noPriceModels }) })}
          <button type="button" class="cost-link" onClick={goPrices}>{tr("costs.overview.addPrice")}</button>
        </div>
      )}
      {data.budget && data.budget.pct >= 80 && (
        <div class="cost-banner is-warn" role="status"><span aria-hidden="true">! </span>{tr(tenant ? "costs.overview.budgetTenant" : "costs.overview.budgetAdmin", { pct: data.budget.pct })}</div>
      )}

      <div class="cost-tiles">
        <section class="cost-tile is-main">
          <h3>{tr(tenant ? "costs.overview.tileMainTenant" : "costs.overview.tileMainAdmin")}</h3>
          <p class="cost-big">{fmtCost(t.subscriptionMicro, { total: true, approx: true })}</p>
          <p class="cost-muted">
            {turnsWord(t.subscriptionTurns)}
            {data.noData.count > 0 && <> · <button type="button" class="cost-link" onClick={() => setNoDataOpen(!noDataOpen)} aria-expanded={noDataOpen}>{tr("costs.overview.moreNoData", { n: data.noData.count })}</button></>}
          </p>
          {tenant && <p class="cost-muted cost-small">{tr("costs.overview.tenantExplain")}</p>}
        </section>
        {admin && subs && (subs.configured ? (
          <>
            <section class="cost-tile">
              <h3>{tr("costs.overview.tileSubs")}</h3>
              <p class="cost-big">{fmtCost(subs.costMicro, { total: true })}</p>
              <p class="cost-muted">{tr("costs.subsCount", { count: subs.items.length })}{tr(subs.prorated ? "costs.overview.prorated" : "costs.overview.perMonth")}</p>
            </section>
            <section class={"cost-tile " + (subs.savedMicro >= 0 ? "is-saved" : "is-loss")}>
              <h3>{subs.savedMicro >= 0 ? <><span aria-hidden="true">✓ </span>{tr("costs.overview.tileSaved")}</> : tr("costs.overview.tileLoss")}</h3>
              <p class="cost-big">{fmtCost(Math.abs(subs.savedMicro), { total: true, approx: true })}</p>
              <p class="cost-muted">{paybackText(subs.payback)}</p>
            </section>
          </>
        ) : (
          <section class="cost-tile is-invite">
            <h3>{tr("costs.overview.inviteTitle")}</h3>
            <p class="cost-muted">{tr("costs.overview.inviteText")}</p>
            <button type="button" class="btn" onClick={goSubs}>{tr("costs.overview.inviteBtn")}</button>
          </section>
        ))}
        {t.apiPaidMicro > 0 && (
          <section class="cost-tile">
            <h3>{tr("costs.overview.tileApiPaid")}</h3>
            <p class="cost-big">{fmtCost(t.apiPaidMicro, { total: true })}</p>
            <p class="cost-muted">{tr("costs.overview.tileApiPaidSub", { turns: turnsWord(t.apiTurns) })}</p>
          </section>
        )}
        {t.freeTurns > 0 && (
          <section class="cost-tile">
            <h3>{tr("costs.overview.tileFree")}</h3>
            <p class="cost-big">$0</p>
            <p class="cost-muted">{tr("costs.overview.tileFreeSub", { turns: turnsWord(t.freeTurns) })}</p>
          </section>
        )}
      </div>

      {(noDataOpen || (data.noData.count > 0 && t.turns === data.noData.count)) && <NoData noData={data.noData} />}

      <DayChart days={data.byDay} period={data.period} table={table} setTable={setTable} />

      {admin && subs?.configured && (
        <CostList title={tr("costs.overview.bySubs")} rows={subs.items.map((s) => ({ key: s.id, title: s.title, sub: tr("costs.overview.subPeriodPayback", { cost: fmtCost(s.costMicro), payback: paybackText(s.payback) }), micro: s.apiMicro }))} />
      )}
      <CostList title={tr("costs.overview.models")} rows={data.byModel.map((m) => ({ key: m.model + m.billing, title: m.title, full: m.model, sub: `${turnsWord(m.turns)}${m.billing === "api" ? tr("costs.overview.providerApi") : m.billing === "free" ? tr("costs.overview.freeTag") : ""}${m.noData ? tr("costs.chat.noDataCount", { n: m.noData }) : ""}`, micro: m.micro, tag: m.noPrice ? tr("costs.overview.noPriceTag") : null }))} />
      <CostList title={tr("costs.overview.projects")} rows={data.byProject.map((p) => ({ key: p.project ?? "-", title: projectName(p.project), full: p.project, sub: `${turnsWord(p.turns)}${p.runs ? ` · ${tr("costs.runs", { count: p.runs })}` : ""}`, micro: p.micro, onClick: p.project ? () => setFilter({ ...filter, project: p.project }) : null }))} />
      <CostList title={tr("costs.overview.topChats")} rows={data.topChats.map((c) => ({ key: c.sid, title: c.deleted ? tr("costs.overview.deletedChat") : c.title || tr("costs.overview.untitledChat"), full: c.title, sub: `${turnsWord(c.turns)}${c.step ? tr("costs.overview.pipeStep") : ""}${c.noData ? tr("costs.chat.noDataCount", { n: c.noData }) : ""}`, micro: c.micro, onClick: c.deleted ? null : () => navigate(`/chat/${encodeURIComponent(c.sid)}`) }))} />
      {data.runs.length > 0 && <CostList title={tr("costs.overview.pipeRuns")} rows={data.runs.map((r) => ({ key: r.runId, title: clip(r.runId, 36), full: r.runId, sub: `${turnsWord(r.turns)}${r.maxAttempt > 1 ? tr("costs.overview.hadRetries") : ""}`, micro: r.micro, onClick: () => navigate(`/temporal/run/${encodeURIComponent(r.runId)}`) }))} />}
      <CostList title={tr("costs.overview.byEngine")} rows={data.byEngine.map((e) => ({ key: e.engine, title: e.title, sub: turnsWord(e.turns), micro: e.micro, cls: ENGINE_CLASS[e.engine] }))} />

      <div class="cost-actions">
        <button type="button" class="btn" onClick={() => setExporting(true)} disabled={stale}>{tr("costs.overview.exportCsv")}</button>
        {admin && <TzRow tz={data.tz} />}
      </div>
      <p class="cost-muted cost-small">{tr("costs.overview.footer", { pv: pv ? ` v${pv.version}` : "" })}</p>
      {exporting && <ExportDialog filter={filter} admin={admin} onClose={() => setExporting(false)} />}
    </div>
  );
}

function LedgerDown({ admin, inline = false, detail = null }) {
  return (
    <div class={"cost-banner is-error" + (inline ? "" : " is-block")} role="alert">
      <span aria-hidden="true">✕ </span>
      {admin ? (
        <><b>{tr("costs.ledger.adminBold")}</b>{tr("costs.ledger.adminText")}{detail ? <span class="cost-small"> ({clip(detail, 120)})</span> : null}</>
      ) : (
        <>{tr("costs.ledger.tenant")}</>
      )}
    </div>
  );
}

function NoData({ noData }) {
  return (
    <section class="cost-card">
      <h3><span class="cost-tag is-nodata"><span aria-hidden="true">? </span>{tr("costs.noDataShort")}</span> {turnsWord(noData.count)}</h3>
      <ul class="cost-rows">
        {Object.entries(noData.byReason).map(([k, n]) => (
          <li key={k} class="cost-row"><span>{NO_DATA_TEXT[k] ?? k}</span><span class="cost-num">{n}</span></li>
        ))}
      </ul>
      <p class="cost-muted cost-small">{tr("costs.noDataCard.footer")}</p>
    </section>
  );
}

function CostList({ title, rows }) {
  if (!rows.length) return null;
  const max = Math.max(1, ...rows.map((r) => r.micro ?? 0));
  return (
    <section class="cost-card">
      <h3>{title}</h3>
      <ul class="cost-rows">
        {rows.map((r) => {
          const inner = (
            <>
              <span class="cost-row-main">
                <span class="cost-row-title" title={r.full ?? r.title}>{r.title}{r.tag && <span class="cost-tag is-warn"><span aria-hidden="true">! </span>{r.tag}</span>}</span>
                {r.sub && <span class="cost-muted cost-small">{r.sub}</span>}
                <span class={"cost-bar " + (r.cls ?? "")} aria-hidden="true"><span style={`width:${Math.max(1, Math.round(((r.micro ?? 0) / max) * 100))}%`} /></span>
              </span>
              <span class="cost-num">{fmtCost(r.micro)}</span>
            </>
          );
          return <li key={r.key}>{r.onClick ? <button type="button" class="cost-row is-link" onClick={r.onClick}>{inner}</button> : <div class="cost-row">{inner}</div>}</li>;
        })}
      </ul>
    </section>
  );
}

function DayChart({ days, period, table, setTable }) {
  const list = [];
  for (let d = period.from; d <= period.to && list.length < 400; d = new Date(Date.parse(d + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10)) {
    const hit = days.find((x) => x.day === d);
    list.push(hit ?? { day: d, micro: 0, noData: 0, turns: 0 });
  }
  const max = Math.max(1, ...list.map((x) => x.micro));
  const total = list.reduce((a, b) => a + b.micro, 0);
  const active = list.filter((x) => x.turns > 0).length || 1;
  const W = 100 / Math.max(1, list.length);
  return (
    <section class="cost-card">
      <div class="cost-chart-head">
        <h3>{tr("costs.chart.title")}</h3>
        {list.some((x) => x.turns > 0) && <span class="cost-muted cost-small">{tr("costs.chart.avg", { cost: fmtCost(Math.round(total / active)) })}</span>}
      </div>
      {/* BUG-277: без ходов — строка вместо пустого графика высотой 140 px */}
      {!list.some((x) => x.turns > 0) ? (
        <p class="cost-muted cost-chart-empty">{tr("costs.chart.empty")}</p>
      ) : !table ? (
        <svg class="cost-chart" viewBox="0 0 100 44" preserveAspectRatio="none" role="img" aria-label={tr("costs.chart.aria", { days: list.length, total: fmtCost(total) })}>
          {list.map((x, i) => (
            <g key={x.day}>
              <rect class="cost-chart-bar" x={i * W + W * 0.15} width={W * 0.7} y={38 - (x.micro / max) * 36} height={(x.micro / max) * 36}><title>{`${dayTitle(x.day)}: ${fmtCost(x.micro)}`}</title></rect>
              {x.noData > 0 && <rect class="cost-chart-nodata" x={i * W + W * 0.15} width={W * 0.7} y="40" height="3"><title>{`${dayTitle(x.day)}: ${x.noData} ${tr("costs.noDataShort")}`}</title></rect>}
            </g>
          ))}
        </svg>
      ) : (
        <div class="cost-table-wrap">
          <table class="cost-table">
            <thead><tr><th scope="col">{tr("costs.chart.colDay")}</th><th scope="col">{tr("costs.chart.colApi")}</th><th scope="col">{tr("costs.chart.colTurns")}</th><th scope="col">{tr("costs.chart.colNoData")}</th></tr></thead>
            <tbody>{list.filter((x) => x.turns > 0).map((x) => <tr key={x.day}><td>{dayTitle(x.day)}</td><td class="cost-num">{fmtCost(x.micro)}</td><td class="cost-num">{x.turns}</td><td class="cost-num">{x.noData || "—"}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {list.some((x) => x.turns > 0) && <p class="cost-legend cost-small">
        <span class="cost-legend-item"><span class="cost-key is-money" aria-hidden="true" />{tr("costs.chart.legendApi")}</span>
        <span class="cost-legend-item"><span class="cost-key is-nodata" aria-hidden="true" />{tr("costs.chart.legendNoData")}</span>
        <button type="button" class="cost-link" onClick={() => setTable(!table)} aria-pressed={table}>{tr(table ? "costs.chart.asChart" : "costs.chart.asTable")}</button>
      </p>}
    </section>
  );
}

function TzRow({ tz }) {
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState(tz);
  const [err, setErr] = useState(null);
  if (!edit) return <button type="button" class="cost-link" onClick={() => setEdit(true)}>{tr("costs.tz.btn", { tz })}</button>;
  const save = async () => {
    try {
      const s = await costApi.settings();
      await costApi.saveSettings({ tz: val.trim() }, s.version);
      setEdit(false);
      costTick.value += 1;
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <span class="cost-tz">
      <label>{tr("costs.tz.label")} <input value={val} onInput={(e) => setVal(e.currentTarget.value)} aria-invalid={Boolean(err)} /></label>
      <button type="button" class="btn" onClick={save}>{tr("common.save")}</button>
      {err && <span class="cost-err" role="alert">{err}</span>}
    </span>
  );
}

// Выгрузка CSV: прогресс, отмена (неполный файл не сохраняется), скачивание (кр. 13; N-28).
function ExportDialog({ filter, admin, onClose }) {
  const [noData, setNoData] = useState(true);
  const [state, setState] = useState({ phase: "idle", bytes: 0, url: null, name: null, error: null });
  const ctl = useRef(null);
  useEffect(() => () => {
    ctl.current?.abort();
    if (state.url) URL.revokeObjectURL(state.url);
  }, []);
  const start = async () => {
    const c = new AbortController();
    ctl.current = c;
    setState({ phase: "run", bytes: 0, url: null, name: null, error: null });
    try {
      const res = await fetch(costApi.exportUrl(filter, { noData }), { signal: c.signal });
      if (!res.ok) throw new Error(res.status === 403 ? tr("costs.export.err403") : tr("costs.export.errStatus", { status: res.status }));
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "teleharness-usage.csv";
      const reader = res.body.getReader();
      const parts = [];
      let bytes = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parts.push(value);
        bytes += value.length;
        setState((s) => ({ ...s, bytes }));
      }
      setState({ phase: "done", bytes, url: URL.createObjectURL(new Blob(parts, { type: "text/csv" })), name, error: null });
    } catch (e) {
      setState({ phase: e.name === "AbortError" ? "idle" : "error", bytes: 0, url: null, name: null, error: e.name === "AbortError" ? null : e.message });
    }
  };
  return (
    <Modal title={tr("costs.export.title")} onClose={onClose}>
      <p class="modal-text">{tr("costs.export.period", { period: filter.period === "custom" ? `${filter.from} – ${filter.to}` : { month: tr("costs.period.monthWord"), prev: tr("costs.period.prevWord"), "30d": tr("costs.period.30d") }[filter.period], scope: admin ? (filter.user ? ` · ${filter.userName ?? filter.user}` : tr("costs.export.allUsers")) : tr("costs.export.onlyYours") })}</p>
      <label class="cost-check"><input type="checkbox" checked={noData} onChange={(e) => setNoData(e.currentTarget.checked)} /> {tr("costs.export.includeNoData")}</label>
      {state.phase === "run" && <p class="modal-text" role="status">{tr("costs.export.running", { kb: Math.round(state.bytes / 1024) })}</p>}
      {state.error && <p class="modal-error" role="alert">{state.error}</p>}
      <div class="modal-actions">
        {state.phase === "run" ? <button type="button" class="btn" onClick={() => ctl.current?.abort()}>{tr("common.cancel")}</button> : <button type="button" class="btn" onClick={onClose}>{tr("common.close")}</button>}
        {state.phase === "done" ? <a class="btn-primary" href={state.url} download={state.name}>{tr("costs.export.download")}</a> : <button type="button" class="btn-primary" disabled={state.phase === "run"} onClick={start}>{tr("costs.export.start")}</button>}
      </div>
    </Modal>
  );
}

// ---- Люди --------------------------------------------------------------------------

function People({ filter, open }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const tick = costTick.value;
  useEffect(() => {
    costApi.users(filter).then(setData, setErr);
  }, [filter.period, filter.from, filter.to, tick]);
  if (err) return <p class="cost-fail" role="alert">{tr("costs.people.loadErr", { msg: err.message })}</p>;
  if (!data) return <div class="cost-skel" role="status" aria-label={tr("common.loading")}><span /><span /></div>;
  if (!data.users.length) return <p class="cost-muted">{tr("costs.chart.empty")}</p>;
  return (
    <section class="cost-card">
      <h3>{tr("costs.people.title", { range: rangeTitle(data.period.from, data.period.to) })}</h3>
      <ul class="cost-rows">
        {data.users.map((u) => (
          <li key={u.userId ?? "-"}>
            {u.deleted ? (
              <div class="cost-row is-deleted"><span class="cost-row-main"><span class="cost-row-title">{tr("costs.people.deleted", { name: u.name })}</span><span class="cost-muted cost-small">{turnsWord(u.turns)} · {u.share}{NB}%</span></span><span class="cost-num">{fmtCost(u.micro)}</span></div>
            ) : (
              <button type="button" class="cost-row is-link" onClick={() => open(u)}>
                <span class="cost-row-main">
                  <span class="cost-row-title">{u.name}</span>
                  <span class="cost-muted cost-small">{turnsWord(u.turns)} · {u.share}{NB}%{u.noData ? tr("costs.chat.noDataCount", { n: u.noData }) : ""}{u.budget ? tr("costs.people.budget", { limit: fmtCost(u.budget.usdMonthMicro, { total: true }), pct: u.budget.pct }) : ""}</span>
                </span>
                <span class="cost-num">{fmtCost(u.micro)}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- Прайс -------------------------------------------------------------------------

const FIELDS = [["input", "costs.field.input", true], ["output", "costs.field.output", true], ["cacheRead", "costs.field.cacheRead"], ["cacheWrite5m", "costs.field.cacheWrite5m"], ["cacheWrite1h", "costs.field.cacheWrite1h"]];

// Проверка поля прайса (те же правила, что на сервере): null — верно.
export function priceFieldError(raw, required) {
  const s = String(raw ?? "").trim().replace(",", ".");
  if (!s) return required ? tr("costs.val.required") : null;
  const n = Number(s);
  if (!Number.isFinite(n)) return tr("costs.val.number");
  if (n < 0) return tr("costs.val.min0");
  if (n > 10000) return tr("costs.val.max10000");
  return null;
}
const numOrUndef = (s) => (String(s ?? "").trim() === "" ? undefined : Number(String(s).trim().replace(",", ".")));

function Prices() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null); // модель | {} новая
  const [importing, setImporting] = useState(false);
  const [recalc, setRecalc] = useState(false);
  const load = () => costApi.prices().then((d) => { setData(d); setErr(null); }, setErr);
  useEffect(() => { load(); }, []);
  if (err && !data) return <p class="cost-fail" role="alert">{tr("costs.prices.loadErr", { msg: err.message })}</p>;
  if (!data) return <div class="cost-skel" role="status" aria-label={tr("costs.prices.loadingAria")}><span /><span /></div>;
  const w = data.warnings;
  return (
    <div class="cost-prices">
      <p class="cost-caption">{tr("costs.prices.caption", { v: data.version, date: dayTitle(new Date(data.createdAt).toISOString().slice(0, 10)), by: data.createdBy ?? tr("costs.prices.builtin") })}</p>
      {w.noPrice.length > 0 && (
        <div class="cost-banner is-warn" role="status">
          <span aria-hidden="true">! </span>{tr("costs.prices.noPriceList", { models: tr("costs.modelsGen", { count: w.noPrice.length }), list: w.noPrice.map((m) => `${m.model} (${turnsWord(m.turns)})`).join(", ") })}
          <button type="button" class="cost-link" onClick={() => setEdit({ id: w.noPrice[0].model, isNew: true })}>{tr("costs.overview.addPrice")}</button>
        </div>
      )}
      {w.mismatch.map((m) => (
        <div key={m.model} class="cost-banner is-warn" role="status"><span aria-hidden="true">! </span>{tr("costs.prices.mismatch", { title: m.title, dir: tr(m.pct > 0 ? "costs.prices.higher" : "costs.prices.lower"), pct: Math.abs(m.pct) })}</div>
      ))}
      {w.stale.length > 0 && <div class="cost-banner" role="status">{tr("costs.prices.stale", { models: tr("costs.modelsGen", { count: w.stale.length }), days: data.staleDays })}</div>}
      <div class="cost-actions">
        <button type="button" class="btn" onClick={() => setEdit({ isNew: true })}>{tr("costs.prices.newModel")}</button>
        <button type="button" class="btn" onClick={() => setImporting(true)}>{tr("costs.prices.importJson")}</button>
        <a class="btn" download={`teleharness-prices-v${data.version}.json`} href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({ currency: "USD", models: data.models }, null, 1))}`}>{tr("costs.prices.export")}</a>
        <button type="button" class="btn" onClick={() => setRecalc(true)}>{tr("costs.prices.recalcPeriod")}</button>
      </div>
      <section class="cost-card">
        <ul class="cost-rows">
          {data.models.map((m) => {
            const stale = w.stale.find((s) => s.id === m.id);
            return (
              <li key={m.id}>
                <button type="button" class="cost-row is-link" onClick={() => setEdit(m)}>
                  <span class="cost-row-main">
                    <span class="cost-row-title" title={m.id}>{m.title ?? m.id}{m.free && <span class="cost-tag">{tr("costs.prices.freeChip")}</span>}</span>
                    <span class="cost-muted cost-small">{m.free ? tr("costs.prices.freeLine") : `${tr("costs.prices.rateLine", { in: m.usdPerMTok.input, out: m.usdPerMTok.output })}${m.usdPerMTok.cacheRead != null ? tr("costs.prices.cachePart", { c: m.usdPerMTok.cacheRead }) : ""}${m.longContext ? tr("costs.prices.longCtxPart", { n: fmtTokens(m.longContext.aboveInputTokens) }) : ""}`}</span>
                    <span class={"cost-small " + (stale ? "cost-warn-text" : "cost-muted")}>{m.checkedAt ? `${tr("costs.prices.checkedAt", { date: dayTitle(m.checkedAt) })}${stale ? tr("costs.prices.checkedAge", { days: tr("costs.days", { count: stale.days }) }) : ""}` : tr("costs.prices.unchecked")}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section class="cost-card">
        <h3>{tr("costs.prices.history")}</h3>
        <ul class="cost-rows">{data.versions.map((v) => <li key={v.version} class="cost-row"><span>v{v.version} · {dayTitle(new Date(v.createdAt).toISOString().slice(0, 10))} · {v.createdBy ?? "—"}</span><span class="cost-muted cost-small">{v.note ?? ""}</span></li>)}</ul>
      </section>
      {edit && <PriceEditor model={edit} data={data} onClose={() => setEdit(null)} onSaved={(d) => { setData(d); setEdit(null); costTick.value += 1; }} reload={load} />}
      {importing && <ImportDialog data={data} onClose={() => setImporting(false)} onSaved={(d) => { setData(d); setImporting(false); costTick.value += 1; }} />}
      {recalc && <RecalcDialog version={data.version} onClose={() => setRecalc(false)} />}
    </div>
  );
}

function PriceEditor({ model, data, onClose, onSaved, reload }) {
  const p = model.usdPerMTok ?? {};
  const [v, setV] = useState({
    id: model.id ?? "", title: model.title ?? "", free: Boolean(model.free),
    ...Object.fromEntries(FIELDS.map(([f]) => [f, p[f] ?? ""])),
    lcAbove: model.longContext?.aboveInputTokens ?? "", lcInput: model.longContext?.usdPerMTok?.input ?? "", lcOutput: model.longContext?.usdPerMTok?.output ?? "",
    fastInput: model.fast?.input ?? "", fastOutput: model.fast?.output ?? "",
    source: model.source ?? "", checkedAt: model.checkedAt ?? new Date().toISOString().slice(0, 10),
  });
  const [conflict, setConflict] = useState(null);
  const [confirmHigh, setConfirmHigh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [srvErr, setSrvErr] = useState(null);
  const errs = {};
  if (!String(v.id).trim()) errs.id = tr("costs.val.required");
  if (!v.free) for (const [f, , req] of FIELDS) { const e = priceFieldError(v[f], req); if (e) errs[f] = e; }
  const high = !v.free && FIELDS.some(([f]) => Number(String(v[f]).replace(",", ".")) > 500);
  const set = (k) => (e) => setV({ ...v, [k]: e.currentTarget.type === "checkbox" ? e.currentTarget.checked : e.currentTarget.value });
  const save = async () => {
    if (high && !confirmHigh) return setConfirmHigh("ask");
    const m = { id: v.id.trim(), title: v.title.trim() || v.id.trim(), provider: model.provider ?? null, source: v.source.trim() || null, checkedAt: v.checkedAt || null };
    if (v.free) Object.assign(m, { free: true, usdPerMTok: {} });
    else {
      m.usdPerMTok = Object.fromEntries(FIELDS.map(([f]) => [f, numOrUndef(v[f])]).filter(([, x]) => x !== undefined));
      if (String(v.lcAbove).trim()) m.longContext = { aboveInputTokens: Number(v.lcAbove), usdPerMTok: { input: numOrUndef(v.lcInput), output: numOrUndef(v.lcOutput) } };
      if (String(v.fastInput).trim()) m.fast = { input: numOrUndef(v.fastInput), output: numOrUndef(v.fastOutput) };
    }
    const models = model.isNew ? [...data.models, m] : data.models.map((x) => (x.id === model.id ? m : x));
    setBusy(true);
    try {
      const r = await costApi.savePrices(models, data.version, { confirmHigh: Boolean(confirmHigh), note: tr(model.isNew ? "costs.prices.noteAdd" : "costs.prices.noteEdit", { id: m.id }) });
      onSaved(r.prices);
    } catch (e) {
      if (e.status === 409) setConflict(e.body);
      else setSrvErr(e.body?.errors?.[0] ? `${e.body.errors[0].field ?? ""}: ${e.body.errors[0].message}` : e.message);
    } finally {
      setBusy(false);
    }
  };
  const field = (k, label, extra = {}) => (
    <label class="cost-field">
      <span>{label}</span>
      <input value={v[k]} inputMode={extra.mode ?? "decimal"} onInput={set(k)} aria-invalid={Boolean(errs[k])} disabled={extra.disabled} type={extra.type ?? "text"} />
      {errs[k] && <span class="cost-err">{errs[k]}</span>}
    </label>
  );
  return (
    <Modal title={model.isNew ? tr("costs.prices.newModel") : model.title ?? model.id} onClose={onClose}>
      <div class="cost-form">
        {field("id", tr("costs.prices.modelId"), { mode: "text", disabled: !model.isNew || undefined })}
        {field("title", tr("costs.prices.modelTitle"), { mode: "text" })}
        <label class="cost-check"><input type="checkbox" checked={v.free} onChange={set("free")} /> {tr("costs.prices.freeCheck")}</label>
        {!v.free && FIELDS.map(([f, labelKey]) => <div key={f}>{field(f, tr(labelKey))}</div>)}
        {!v.free && (
          <details class="cost-more">
            <summary>{tr("costs.prices.longCtxSummary")}</summary>
            {field("lcAbove", tr("costs.prices.lcAbove"), { mode: "numeric" })}
            {field("lcInput", tr("costs.prices.lcInput"))}
            {field("lcOutput", tr("costs.prices.lcOutput"))}
            <p class="cost-muted cost-small">{tr("costs.prices.lcNote")}</p>
            {field("fastInput", tr("costs.prices.fastInput"))}
            {field("fastOutput", tr("costs.prices.fastOutput"))}
          </details>
        )}
        {field("source", tr("costs.prices.source"), { mode: "url" })}
        {field("checkedAt", tr("costs.prices.checkedField"), { type: "date" })}
        <p class="cost-muted cost-small">{tr("costs.prices.futureNote")}</p>
        {confirmHigh === "ask" && <p class="modal-error" role="alert">{tr("costs.prices.highWarn")}<button type="button" class="cost-link" onClick={() => setConfirmHigh(true)}>{tr("costs.prices.highConfirm")}</button></p>}
        {conflict && (
          <p class="modal-error" role="alert">{tr("costs.prices.conflict", { v: conflict.version, by: conflict.by ? `, ${conflict.by}` : "" })}<button type="button" class="cost-link" onClick={() => { reload(); onClose(); }}>{tr("costs.prices.reloadRetry")}</button></p>
        )}
        {srvErr && <p class="modal-error" role="alert">{srvErr}</p>}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" onClick={onClose}>{tr("common.cancel")}</button>
        <button type="button" class="btn-primary" disabled={busy || Object.keys(errs).length > 0 || Boolean(conflict)} onClick={save}>{tr("common.save")}</button>
      </div>
    </Modal>
  );
}

function ImportDialog({ data, onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const pick = async (e) => {
    const f = e.currentTarget.files?.[0];
    if (!f) return;
    const text = await f.text();
    setFile({ name: f.name, text });
    setPreview(null);
    setErr(null);
    try {
      setPreview(await costApi.importPrices(text, { dryRun: true, filename: f.name, version: data.version }));
    } catch (x) {
      const d = x.body?.detail;
      setErr(d ? tr("costs.import.rejected", { line: d.line ? tr("costs.import.line", { n: d.line }) : "", msg: d.message }) : x.message);
    }
  };
  const apply = async () => {
    try {
      const r = await costApi.importPrices(file.text, { filename: file.name, version: data.version, confirmHigh: true });
      onSaved(r.prices);
    } catch (x) {
      setErr(x.status === 409 ? tr("costs.import.conflict") : x.message);
    }
  };
  return (
    <Modal title={file ? tr("costs.import.titleFile", { name: clip(file.name, 30) }) : tr("costs.prices.importJson")} onClose={onClose}>
      <label class="cost-field"><span>{tr("costs.import.fileLabel")}</span><input type="file" accept="application/json,.json" onChange={pick} /></label>
      {preview && (
        <>
          <p class="modal-text">{tr("costs.import.verified", { models: tr("costs.modelsAcc", { count: preview.models }) })}</p>
          <p class="modal-text">{tr("costs.import.summary", { changed: preview.changed, added: preview.added, same: preview.same })}</p>
          <ul class="cost-rows">
            {preview.rows.slice(0, 30).map((r) => (
              <li key={r.id} class="cost-row"><span>{r.id}</span><span class="cost-small">{r.kind === "added" ? tr("costs.import.added") : tr("costs.import.diff", { bi: r.before?.usdPerMTok?.input ?? "—", bo: r.before?.usdPerMTok?.output ?? "—", ai: r.after?.usdPerMTok?.input ?? "—", ao: r.after?.usdPerMTok?.output ?? "—" })}</span></li>
            ))}
          </ul>
        </>
      )}
      {err && <p class="modal-error" role="alert">{err}</p>}
      <div class="modal-actions">
        <button type="button" class="btn" onClick={onClose}>{tr("common.cancel")}</button>
        <button type="button" class="btn-primary" disabled={!preview || preview.changed + preview.added === 0} onClick={apply}>{tr("costs.import.apply")}</button>
      </div>
    </Modal>
  );
}

function RecalcDialog({ version, onClose }) {
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  const [plan, setPlan] = useState(null);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState(null);
  const range = () => {
    const [y, m] = month.split("-").map(Number);
    return [`${month}-01`, `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`];
  };
  useEffect(() => {
    setPlan(null);
    const [f, t] = range();
    costApi.recalc(f, t, true).then(setPlan, (e) => setErr(e.message));
  }, [month]);
  const go = async () => {
    const [f, t] = range();
    try {
      setDone(await costApi.recalc(f, t, false));
      costTick.value += 1;
    } catch (e) {
      setErr(e.message);
    }
  };
  const title = lang.value === "ru" ? monthTitle(month).toLowerCase() : monthTitle(month);
  return (
    <Modal title={tr("costs.recalc.title", { month: title, v: version })} onClose={onClose}>
      <label class="cost-field"><span>{tr("costs.recalc.month")}</span><input type="month" value={month} onInput={(e) => setMonth(e.currentTarget.value)} /></label>
      {plan && !done && (
        <ul class="modal-text cost-ul">
          <li>{tr("costs.recalc.planTurns", { turns: turnsWord(plan.turns) })}</li>
          <li>{tr("costs.recalc.planDiff", { before: fmtCost(plan.beforeMicro), after: fmtCost(plan.afterMicro) })}</li>
          <li>{tr("costs.recalc.planSafe")}</li>
        </ul>
      )}
      {done && <p class="modal-text" role="status">{tr("costs.recalc.done", { turns: turnsWord(done.turns), after: fmtCost(done.afterMicro) })}</p>}
      {err && <p class="modal-error" role="alert">{err}</p>}
      <div class="modal-actions">
        <button type="button" class="btn" onClick={onClose}>{tr(done ? "common.close" : "costs.recalc.skip")}</button>
        {!done && <button type="button" class="btn-danger" disabled={!plan || plan.turns === 0} onClick={go}>{tr("costs.recalc.go")}</button>}
      </div>
    </Modal>
  );
}

// ---- Подписки ----------------------------------------------------------------------

const PROVIDERS = [["anthropic", "Claude (Anthropic)"], ["openai-codex", "ChatGPT / Codex"], ["zai-coding-plan", "z.ai Coding Plan"], ["acp-antigravity", "Google Antigravity (Gemini · ACP)"], ["acp-github-copilot-cli", "GitHub Copilot CLI (ACP)"]];

// «1990 ₽» / «abc» → текст ошибки; число в долларах → null.
export function usdFieldError(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return tr("costs.val.required");
  if (/[^\d.,\s$]/.test(s)) return tr("costs.val.usdOnly");
  const n = Number(s.replace(/[$\s]/g, "").replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return tr("costs.val.nonNeg");
  return null;
}

function Subscriptions() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = () => costApi.subscriptions().then(setData, setErr);
  useEffect(() => { load(); }, []);
  if (err && !data) return <p class="cost-fail" role="alert">{err.message}</p>;
  if (!data) return <div class="cost-skel" role="status" aria-label={tr("costs.subs.loadingAria")}><span /></div>;
  const save = async (items) => {
    try {
      setData(await costApi.saveSubscriptions(items, data.version));
      setEdit(null);
      costTick.value += 1;
      return null;
    } catch (e) {
      return e.status === 409 ? tr("costs.subs.conflict") : e.message;
    }
  };
  return (
    <div>
      <p class="cost-muted">{tr("costs.subs.desc")}</p>
      <section class="cost-card">
        <ul class="cost-rows">
          {data.items.length === 0 && <li class="cost-row cost-muted">{tr("costs.subs.empty")}</li>}
          {data.items.map((s) => (
            <li key={s.id}>
              <button type="button" class="cost-row is-link" onClick={() => setEdit(s)}>
                <span class="cost-row-main"><span class="cost-row-title">{s.title}</span><span class="cost-muted cost-small">{s.providers.map((p) => PROVIDERS.find((x) => x[0] === p)?.[1] ?? p).join(", ")} · {tr("costs.subs.since", { date: dayTitle(s.activeFrom) })}</span></span>
                <span class="cost-num">{fmtCost(s.usdMonthMicro)}{tr("costs.subs.perMo")}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <button type="button" class="btn" onClick={() => setEdit({})}>{tr("costs.subs.new")}</button>
      {edit && <SubEditor sub={edit} onClose={() => setEdit(null)} onSave={(s) => save(edit.id ? data.items.map((x) => (x.id === edit.id ? s : x)) : [...data.items, s]).then((e) => e)} onDelete={edit.id ? () => save(data.items.filter((x) => x.id !== edit.id)) : null} />}
    </div>
  );
}

function SubEditor({ sub, onClose, onSave, onDelete }) {
  const [title, setTitle] = useState(sub.title ?? "");
  const [provider, setProvider] = useState(sub.providers?.[0] ?? "anthropic");
  const [usd, setUsd] = useState(sub.usdMonthMicro != null ? String(sub.usdMonthMicro / 1e6) : "");
  const [from, setFrom] = useState(sub.activeFrom ?? new Date().toISOString().slice(0, 8) + "01");
  const [err, setErr] = useState(null);
  const usdErr = usd ? usdFieldError(usd) : null;
  const ok = title.trim() && usd && !usdErr && from;
  const save = async () => {
    const e = await onSave({ id: sub.id, title: title.trim(), providers: [provider], usdMonth: Number(usd.replace(/[$\s]/g, "").replace(",", ".")), activeFrom: from });
    if (e) setErr(e);
  };
  return (
    <Modal title={sub.id ? sub.title : tr("costs.subs.new")} onClose={onClose}>
      <div class="cost-form">
        <label class="cost-field"><span>{tr("costs.prices.modelTitle")}</span><input value={title} onInput={(e) => setTitle(e.currentTarget.value)} placeholder="Claude Max" /></label>
        <label class="cost-field"><span>{tr("costs.subs.provider")}</span>
          <select value={provider} onChange={(e) => setProvider(e.currentTarget.value)}>{PROVIDERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        </label>
        <label class="cost-field"><span>{tr("costs.subs.usdMonth")}</span><input value={usd} inputMode="decimal" onInput={(e) => setUsd(e.currentTarget.value)} aria-invalid={Boolean(usdErr)} />{usdErr && <span class="cost-err">{usdErr}</span>}</label>
        <label class="cost-field"><span>{tr("costs.subs.activeFrom")}</span><input type="date" value={from} onInput={(e) => setFrom(e.currentTarget.value)} /></label>
        {err && <p class="modal-error" role="alert">{err}</p>}
      </div>
      <div class="modal-actions">
        {onDelete && <button type="button" class="btn-danger" onClick={onDelete}>{tr("common.delete")}</button>}
        <button type="button" class="btn" onClick={onClose}>{tr("common.cancel")}</button>
        <button type="button" class="btn-primary" disabled={!ok} onClick={save}>{tr("common.save")}</button>
      </div>
    </Modal>
  );
}

// ---- Бюджеты -----------------------------------------------------------------------

function Budgets() {
  const [data, setData] = useState(null);
  const [users, setUsers] = useState([]);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = () => {
    costApi.budgets().then(setData, setErr);
    fetch("/teleharness/api/admin/users").then((r) => r.json()).then((d) => setUsers(d.users ?? d ?? []), () => {});
  };
  useEffect(() => { load(); }, []);
  if (err && !data) return <p class="cost-fail" role="alert">{err.message}</p>;
  if (!data) return <div class="cost-skel" role="status" aria-label={tr("costs.budgets.loadingAria")}><span /></div>;
  const list = (Array.isArray(users) ? users : []).filter((u) => !u.disabled).map((u) => ({ id: u.id, name: u.name ?? u.id, b: data.items.find((x) => x.userId === u.id) }));
  return (
    <div>
      <p class="cost-muted">{tr("costs.budgets.desc")}</p>
      <section class="cost-card">
        <ul class="cost-rows">
          {list.map((u) => (
            <li key={u.id}>
              <button type="button" class="cost-row is-link" onClick={() => setEdit(u)}>
                <span class="cost-row-main">
                  <span class="cost-row-title">{u.name}</span>
                  <span class="cost-muted cost-small">{u.b ? tr("costs.budgets.of", { spent: fmtCost(u.b.state?.spentMicro ?? 0), limit: fmtCost(u.b.usdMonthMicro, { total: true }), pct: u.b.state?.pct ?? 0 }) : tr("costs.budgets.none")}</span>
                  {u.b && <span class={"cost-bar" + ((u.b.state?.pct ?? 0) >= 80 ? " is-warn" : "")} aria-hidden="true"><span style={`width:${Math.min(100, u.b.state?.pct ?? 0)}%`} /></span>}
                </span>
                {u.b && (u.b.state?.pct ?? 0) >= 80 && <span class="cost-tag is-warn"><span aria-hidden="true">! </span>{u.b.state.pct}{NB}%</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {edit && <BudgetEditor u={edit} version={data.version} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

function BudgetEditor({ u, version, onClose, onSaved }) {
  const [usd, setUsd] = useState(u.b ? String(u.b.usdMonthMicro / 1e6) : "");
  const [err, setErr] = useState(null);
  const fe = usd ? usdFieldError(usd) : null;
  const save = async (value) => {
    try {
      await costApi.saveBudget(u.id, value, version);
      onSaved();
    } catch (e) {
      setErr(e.status === 409 ? tr("costs.budgets.conflict") : e.message);
    }
  };
  return (
    <Modal title={tr("costs.budgets.modalTitle", { name: u.name })} onClose={onClose}>
      <label class="cost-field"><span>{tr("costs.budgets.usdMonth")}</span><input value={usd} inputMode="decimal" onInput={(e) => setUsd(e.currentTarget.value)} aria-invalid={Boolean(fe)} />{fe && <span class="cost-err">{fe}</span>}</label>
      {err && <p class="modal-error" role="alert">{err}</p>}
      <div class="modal-actions">
        {u.b && <button type="button" class="btn-danger" onClick={() => save(null)}>{tr("costs.budgets.remove")}</button>}
        <button type="button" class="btn" onClick={onClose}>{tr("common.cancel")}</button>
        <button type="button" class="btn-primary" disabled={!usd || Boolean(fe)} onClick={() => save(Number(usd.replace(/[$\s]/g, "").replace(",", ".")))}>{tr("costs.budgets.set")}</button>
      </div>
    </Modal>
  );
}
