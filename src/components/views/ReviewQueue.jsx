// FEAT-20.1: очередь ревью — вкладка «Ждёт ревью» на «Доске» (FEAT-20.2,
// `#/board/review`; отдельного пункта меню нет — решение владельца 2026-11-20).
// Элементы — общий контракт ReviewSummary (GET /teleharness/api/attention → reviews).
// Фильтры «Все / Чаты / Пайпы / Агент правит», самые давние первыми, по 30,
// «Нечего проверять», данные на время при обрыве связи, «Принятые за 30 дней».
// Кадры T-10…T-12, P-1, P-6, D-1.
import { useEffect, useState } from "preact/hooks";
import "../review.css";
import { projectLabel } from "../../lib/attention.js";
import { t } from "../../lib/i18n.js";
import { STATUS, commentsWord, filesWord, hhmm, reviewApi, shortModel, turnsWord } from "../../lib/review-client.js";

export const PAGE = 30;
const FILTERS = [["all", "review.filter.all"], ["chats", "review.filter.chats"], ["runs", "review.filter.runs"], ["returned", "review.filter.returned"]];

export function filterQueue(list, f) {
  const all = [...(list ?? [])].sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
  if (f === "chats") return all.filter((x) => x.source === "chat");
  if (f === "runs") return all.filter((x) => x.source === "run");
  if (f === "returned") return all.filter((x) => x.status === "returned");
  return all;
}

function waited(ms, now) {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 1) return t("review.wait.justNow");
  if (m < 60) return t("review.wait.min", { m });
  const h = Math.round(m / 60);
  return h < 48 ? t("review.wait.h", { h }) : t("review.wait.d", { d: Math.round(h / 24) });
}

export default function ReviewQueue({ reviews, offline = false, at = null, now = Date.now(), selectedId = null, onSelect = null }) {
  const [f, setF] = useState("all");
  const [shown, setShown] = useState(PAGE);
  const [accepted, setAccepted] = useState(null);
  useEffect(() => setShown(PAGE), [f]);
  const list = filterQueue(reviews, f);
  const count = (k) => filterQueue(reviews, k).length;
  const loadAccepted = () => {
    if (accepted) return;
    reviewApi.list("all").then((r) => setAccepted(r.accepted ?? []), () => setAccepted([]));
  };
  return (
    <div class="rq" data-req="FEAT-20.1 кр. 11">
      {offline && <div class="bd-banner is-offline" role="status"><b>{t("review.offline")}</b> · {t("review.offlineDataAt", { hhmm: hhmm(at) })}</div>}
      {(reviews?.length ?? 0) > 0 && (
        <div class="rq-filters" role="group" aria-label={t("review.filterLabel")}>
          {FILTERS.map(([k, labelKey]) => <button key={k} type="button" aria-pressed={f === k ? "true" : "false"} onClick={() => setF(k)}>{t(labelKey)} · {count(k)}</button>)}
        </div>
      )}
      {(reviews?.length ?? 0) === 0 ? (
        <div class="bd-empty">
          <span class="bd-empty-icon" aria-hidden="true"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.5 2.5L16 9.5" /></svg></span>
          <h2>{t("review.queue.emptyTitle")}</h2>
          <p>{t("review.queue.emptyText")}</p>
        </div>
      ) : list.length === 0 ? (
        <p class="bd-hint">{t("review.queue.filterEmpty")}</p>
      ) : (
        <ul class="rq-list">
          {list.slice(0, shown).map((r) => {
            const s = STATUS[r.status] ?? STATUS.waiting;
            return (
              <li key={r.id}>
                <a class={"rq-item" + (selectedId === r.id ? " is-selected" : "")} href={r.href ?? `#/review/${r.id}`} data-key={r.key} aria-current={selectedId === r.id ? "true" : undefined} aria-label={t("review.queue.itemLabel", { status: s.word, title: r.title, files: filesWord(r.files), waited: waited(r.since, now) })} onClick={onSelect ? (e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) { e.preventDefault(); onSelect(r); } } : undefined}>
                  <span class={"rv-chip is-" + r.status}><span aria-hidden="true">{s.icon}</span> {s.word}{r.revision > 1 ? ` · ${t("review.rev", { n: r.revision })}` : ""}</span>
                  <b>{r.title}</b>
                  <span class="rq-meta">
                    <span>{r.source === "run" ? t("review.source.run") : t("review.source.chat")}{projectLabel(r.project) ? ` · ${projectLabel(r.project)}` : ""}</span>
                    <span>{turnsWord(r.turns)} · {filesWord(r.files)} · <span class="rv-plus">+{r.additions}</span> <span class="rv-minus">−{r.deletions}</span></span>
                    {r.drafts > 0 && <span>{t("review.draftsCount", { comments: commentsWord(r.drafts) })}</span>}
                    {r.model && <span>{shortModel(r.model)}</span>}
                    <span>{t("review.waitingTime", { waited: waited(r.since, now) })}</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {list.length > shown && <button type="button" class="bd-btn" style="margin-top:10px" onClick={() => setShown((n) => n + PAGE)}>{t("review.more", { count: Math.min(PAGE, list.length - shown) })}</button>}
      <details class="rq-accepted" onToggle={(e) => e.currentTarget.open && loadAccepted()}>
        <summary>{t("review.accepted30")}</summary>
        {accepted == null ? <p class="bd-hint">{t("review.loading")}</p> : accepted.length === 0 ? <p class="bd-hint">{t("review.noAccepted")}</p> : (
          <ul class="rq-list">
            {accepted.map((r) => <li key={r.id}><a class="rq-item" href={r.href}><span class="rv-chip">✓ {t("review.acceptedAt", { hhmm: hhmm(r.acceptedAt) })}</span><b>{r.title}</b><span class="rq-meta">{filesWord(r.files)}</span></a></li>)}
          </ul>
        )}
      </details>
    </div>
  );
}
