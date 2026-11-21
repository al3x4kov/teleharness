// FEAT-20.6: лист «Расход чата» — открывается нажатием на полоску контекста (решение владельца Q1-а:
// в самой полоске и в строках ответов «$» нет, BUG-01.12). Телефон — нижний лист, широкий экран —
// тот же лист по центру. Итог «≈ по ценам API», модели (после Relay — обе), субагенты, служебные
// вызовы, токены по видам, «нет данных» с причиной. Баннер бюджета — один раз за порог за месяц.
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import "../costs.css";
import { NO_DATA_TEXT, costApi, costBudgetEvent, costTick, dayTitle, fmtCost, fmtTokens, plural, turnsWord } from "../../lib/costs.js";
import { navigate } from "../../lib/router.js";
import { locale, t } from "../../lib/i18n.js";

const NB = " ";
const ENGINE_CLASS = { claude: "is-claude", codex: "is-codex", acp: "is-acp", opencode: "is-teleharness" };
const hhmm = (ms) => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
const REASON_LONG = {
  interrupted: (l) => t("costs.reason.interrupted", { at: l?.at ? t("costs.reason.interruptedAt", { time: hhmm(l.at) }) : "", engine: l?.engine === "codex" ? "Codex" : l?.engine === "opencode" ? "opencode" : l?.engine === "acp" ? "ACP" : "Claude" }),
  legacy: () => t("costs.reason.legacy"),
  "no-price": (l) => t("costs.reason.noPrice", { model: l?.model ? ` (${l.model})` : "" }),
  "engine-silent": () => t("costs.reason.engineSilent"),
};

export function ChatCostSheet({ sid, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const tick = costTick.value;
  const ref = useRef(null);
  useEffect(() => {
    costApi.chat(sid).then(setData, setErr);
  }, [sid, tick]);
  useEffect(() => {
    const back = document.activeElement;
    ref.current?.querySelector("button")?.focus();
    const key = (e) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", key);
    return () => { removeEventListener("keydown", key); back?.focus?.(); };
  }, []);
  const node = (
    <div class="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet chat-cost-sheet" role="dialog" aria-modal="true" aria-labelledby="chat-cost-title" ref={ref} data-req="FEAT-20.6">
        <div class="sheet-handle" aria-hidden="true" />
        <div class="sheet-head">
          <h2 class="sheet-title" id="chat-cost-title">{t("costs.chat.title")}</h2>
          <button type="button" class="icon-btn" aria-label={t("common.close")} onClick={onClose}>✕</button>
        </div>
        <div class="chat-cost">{err ? <ChatCostError err={err} /> : !data ? <p class="cost-muted" role="status">{t("costs.chat.loading")}</p> : <ChatCostBody data={data} onClose={onClose} />}</div>
      </div>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(node, document.body) : node;
}

function ChatCostError({ err }) {
  if (err.status === 403) return <p class="cost-banner is-error" role="alert"><span aria-hidden="true">✕ </span>{t("costs.chat.err403")}</p>;
  if (err.status === 503) return <p class="cost-banner is-error" role="alert">{t("costs.chat.err503")}</p>;
  return <p class="cost-banner" role="alert">{t("costs.chat.errGeneric")}</p>;
}

export function ChatCostBody({ data, onClose }) {
  if (data.turns === 0) return <p class="cost-muted">{t("costs.chat.empty")}</p>;
  const nd = data.noData;
  const total = data.totalMicro;
  const sub = data.billing === "subscription";
  const pv = data.priceVersion;
  return (
    <>
      <div>
        <p class="cost-big">{fmtCost(total, { approx: true })}</p>
        <p class="cost-muted">{t("costs.chat.apiPricesMeta", { turns: turnsWord(data.turns) })}{sub ? t("costs.chat.subNote") : ""}</p>
        {nd.count > 0 && <p class="cost-small cost-warn-text"><span aria-hidden="true">? </span>{t("costs.chat.incomplete")}</p>}
      </div>
      {data.byModel.length > 1 && (
        <div class="chat-cost-shares" aria-hidden="true">
          {data.byModel.filter((m) => m.micro > 0).map((m) => <span key={m.model} class={ENGINE_CLASS[m.engine] ?? ""} style={`width:${total > 0 ? (m.micro / total) * 100 : 0}%`} />)}
        </div>
      )}
      <ul class="cost-rows">
        {data.byModel.map((m) => (
          <li key={m.model} class="cost-row">
            <span class="cost-row-main"><span class="cost-row-title" title={m.model}>{m.title}</span><span class="cost-muted cost-small">{t("costs.chat.modelMeta", { turns: turnsWord(m.turns), tokens: fmtTokens(m.tokens) })}{m.noData ? t("costs.chat.noDataCount", { n: m.noData }) : ""}</span></span>
            <span class="cost-num">{m.noData === m.turns ? <span class="cost-tag is-nodata"><span aria-hidden="true">? </span>{t("costs.noDataShort")}</span> : fmtCost(m.micro)}</span>
          </li>
        ))}
        {data.subagents.count > 0 && (
          <li class="cost-row"><span>{t("costs.chat.subagents", { n: data.subagents.count })}</span><span class="cost-num">{fmtCost(data.subagents.micro)}</span></li>
        )}
        {data.service.count > 0 && (
          <li class="cost-row"><span>{t("costs.chat.service", { n: data.service.count })}</span><span class="cost-num">{fmtCost(data.service.micro)}</span></li>
        )}
      </ul>
      <section class="cost-card">
        <h3>{t("costs.chat.tokens")}</h3>
        <ul class="cost-rows">
          <li class="cost-row"><span>{t("costs.chat.tokIn")}</span><span class="cost-num">{fmtTokens(data.tokens.in)}</span></li>
          <li class="cost-row"><span>{t("costs.chat.tokOut")}{data.tokens.reason ? t("costs.chat.tokReasoning", { n: fmtTokens(data.tokens.reason) }) : ""}</span><span class="cost-num">{fmtTokens(data.tokens.out)}</span></li>
          <li class="cost-row"><span>{t("costs.chat.tokCacheRead")}</span><span class="cost-num">{fmtTokens(data.tokens.cacheRead)}</span></li>
          <li class="cost-row"><span>{t("costs.chat.tokCacheWrite")}</span><span class="cost-num">{fmtTokens(data.tokens.w5m)} / {fmtTokens(data.tokens.w1h)}</span></li>
        </ul>
        {data.cacheSavingPct > 0 && <p class="cost-muted cost-small">{t("costs.chat.cacheSaved", { pct: data.cacheSavingPct })}</p>}
      </section>
      {nd.count > 0 && (
        <p class="cost-banner"><span class="cost-tag is-nodata"><span aria-hidden="true">? </span>{t("costs.noDataShort")}</span> {t("costs.chat.noDataLabel", { turns: turnsWord(nd.count), reason: Object.keys(nd.byReason).length === 1 ? (REASON_LONG[Object.keys(nd.byReason)[0]] ?? (() => NO_DATA_TEXT[Object.keys(nd.byReason)[0]]))(nd.last) : Object.entries(nd.byReason).map(([k, n]) => `${NO_DATA_TEXT[k] ?? k}: ${n}`).join(", ") })}</p>
      )}
      {(data.partialTurns > 0 || data.longCtxTurns > 0 || data.pricedLateTurns > 0 || data.engineEstimateTurns > 0) && (
        <ul class="cost-muted cost-small cost-ul">
          {data.partialTurns > 0 && <li>{t("costs.partialTurns", { count: data.partialTurns })}</li>}
          {data.longCtxTurns > 0 && <li>{t("costs.chat.longCtx", { n: data.longCtxTurns })}</li>}
          {data.pricedLateTurns > 0 && <li>{t("costs.chat.pricedLate", { n: data.pricedLateTurns })}</li>}
          {data.engineEstimateTurns > 0 && <li>{t("costs.chat.engineEst", { n: data.engineEstimateTurns })}</li>}
        </ul>
      )}
      <p class="cost-muted cost-small">{t("costs.chat.footer", { pv: pv ? t("costs.chat.pvFrom", { v: pv.version, date: dayTitle(new Date(pv.createdAt).toISOString().slice(0, 10)) }) : "" })}</p>
      <button type="button" class="cost-link" onClick={() => { onClose?.(); navigate("/settings/costs"); }}>{t("costs.chat.allCosts")}</button>
    </>
  );
}

// Баннер бюджета в чате: один раз за порог за месяц (кр. 12; T-18). Ход не блокируется.
export function BudgetBanner({ sid }) {
  const [b, setB] = useState(null);
  const ev = costBudgetEvent.value;
  useEffect(() => {
    if (!sid) return;
    let off = false;
    costApi.chat(sid).then((d) => { if (!off) setB(d.banner ?? null); }, () => {});
    return () => { off = true; };
  }, [sid, ev?.at]);
  if (!b) return null;
  const close = () => {
    setB(null);
    costApi.bannerSeen(sid).catch(() => {});
  };
  return (
    <div class="cost-budget-banner" role="status" data-req="FEAT-20.6">
      <span><span aria-hidden="true">! </span>{t("costs.budgetBanner.text", { pct: b.pct })}</span>
      <button type="button" class="cost-link" onClick={close}>{t("costs.budgetBanner.ok")}</button>
    </div>
  );
}
