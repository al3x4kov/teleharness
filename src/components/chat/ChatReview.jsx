// FEAT-20.1 в чате: плашка «Ждёт ревью · Проверить» под ответом (кр. 1),
// свёрнутый пузырь сообщения ревью (кр. 6), карточки плана «Сначала план»
// (кр. 12–13; кадры T-19…T-22) и переключатель режима в листе прав.
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import "../review.css";
import { STATUS, commentsWord, filesWord, hhmm, newKey, reviewApi, reviewMarker, reviewTick, shortModel } from "../../lib/review-client.js";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";
import { sessions, setNotice } from "../../lib/store.js";
import { upsertSession } from "../../lib/normalize.js";

// sid → {review, plans, sends, at}; общий для всех пузырей чата.
export const chatReviews = signal({});
const inflight = new Map();
export function loadChatReview(sid) {
  if (!sid || inflight.has(sid)) return;
  const p = reviewApi.chat(sid).then(
    (r) => { chatReviews.value = { ...chatReviews.value, [sid]: { ...r, at: Date.now() } }; },
    () => {},
  ).finally(() => inflight.delete(sid));
  inflight.set(sid, p);
}
function useChatReview(sid) {
  const tick = reviewTick.value;
  useEffect(() => { loadChatReview(sid); }, [sid, tick]);
  return chatReviews.value[sid] ?? null;
}

export function ReviewPlaque({ sid }) {
  const st = useChatReview(sid);
  const r = st?.review;
  if (!r) return null;
  const s = STATUS[r.status] ?? STATUS.waiting;
  return (
    <div class="rv-plaque" role="status" data-req="FEAT-20.1 кр. 1">
      <span><span aria-hidden="true">{s.icon}</span> {s.word}{r.revision > 1 ? ` · ${t("review.rev", { n: r.revision })}` : ""} · {filesWord(r.files)}</span>
      <a href={r.href}>{r.status === "returned" ? t("review.open") : t("review.inspect")}</a>
    </div>
  );
}

// Пузырь пользователя с маркером ревью — свёрнут «Ревью · N комментариев к M файлам».
export function reviewBubbleOf(text) {
  const m = reviewMarker(text);
  if (!m) return null;
  const head = /^## (Ревью · [^\n(]+?)\s*(\(ревизия \d+\))?\n/.exec(text);
  return { ...m, title: head ? head[1].trim() : t("review.defaultTitle"), body: text.replace(/\n?<!-- teleharness-review:[^>]+-->\s*$/, "") };
}
export function ReviewBubble({ text }) {
  const b = reviewBubbleOf(text);
  if (!b) return null;
  return (
    <details class="rv-bubble">
      <summary class="rv-bubble-sum">💬 {b.title} · {t("review.rev", { n: b.revision })}</summary>
      <div class="rv-bubble-body">{b.body}</div>
      <a class="rv-link" href={`#/review/${b.id}`}>{t("review.open")}</a>
    </details>
  );
}

const PLAN_STATE_KEY = {
  waiting: "plan.state.waiting",
  approved: "plan.state.approved",
  "approved-edited": "plan.state.approvedEdited",
  revised: "plan.state.revised",
  rejected: "plan.state.rejected",
  superseded: "plan.state.superseded",
  failed: "plan.state.failed",
};
const planStateText = (st) => (PLAN_STATE_KEY[st] ? t(PLAN_STATE_KEY[st]) : st);

function PlanCard({ p, sid, chatModel }) {
  const [mode, setMode] = useState(null); // "edit" | "revise" | "reject"
  const [text, setText] = useState(p.text);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const keyName = `teleharness.plan.${p.id}`;
  async function act(action, body = {}) {
    setBusy(true);
    setErr(null);
    const key = sessionStorage.getItem(keyName) ?? newKey("pl");
    sessionStorage.setItem(keyName, key); // двойной тап / повтор — тот же ключ (N-25)
    try {
      await reviewApi.plan(p.id, action, { key, ...body });
      sessionStorage.removeItem(keyName);
      setMode(null);
      loadChatReview(sid);
    } catch (e) {
      sessionStorage.removeItem(keyName);
      if (e.status === 409) setErr(t("plan.err.alreadyDecided", { state: planStateText(e.body?.state), hhmm: hhmm(e.body?.decidedAt) }));
      else setErr(e.status ? e.message : t("plan.err.offline"));
      loadChatReview(sid);
    } finally {
      setBusy(false);
    }
  }
  const waiting = p.state === "waiting";
  const by = p.model ? shortModel(p.model) : p.engine;
  const execBy = p.execModel ? shortModel(p.execModel) : chatModel && chatModel !== p.model ? shortModel(chatModel) : null;
  return (
    <div class={"pl-card" + (waiting ? "" : " is-done")} data-req="FEAT-20.1 кр. 13" data-plan={p.id}>
      <h3><span>{t("plan.title", { n: p.n })}</span><span class="rv-tag">{planStateText(p.state)}{p.decidedAt && !waiting ? t("plan.at", { hhmm: hhmm(p.decidedAt) }) : ""}{p.state === "superseded" && p.supersededBy ? t("plan.supersededBy", { n: p.supersededBy }) : ""}</span></h3>
      {by && <p class="rv-hint">{t("plan.meta", { by, exec: execBy && execBy !== by ? t("plan.metaExec", { execBy }) : "" })}</p>}
      {p.violations?.length > 0 && (
        <p class="pl-warn" role="alert">⚠ {t("plan.violationWarn", { files: filesWord(p.violations.length), list: p.violations.slice(0, 5).join(", ") })}</p>
      )}
      {p.state === "failed" ? (
        <p class="rv-hint">{t("plan.failedHint")}</p>
      ) : mode === "edit" ? (
        <textarea class="rv-textarea" rows={10} aria-label={t("plan.textAria")} value={text} onInput={(e) => setText(e.currentTarget.value)} />
      ) : (
        <div class="pl-text">{p.edited ?? p.text}</div>
      )}
      {mode === "revise" && <textarea class="rv-textarea" rows={3} placeholder={t("plan.revisePlaceholder")} aria-label={t("plan.revisePlaceholder")} value={text === p.text ? "" : text} onInput={(e) => setText(e.currentTarget.value)} />}
      {err && <p class="rv-error" role="alert">{err}</p>}
      {waiting && (
        <div class="pl-actions">
          {mode === "edit" ? (
            <>
              <button type="button" class="bd-btn bd-primary" disabled={busy || !text.trim()} onClick={() => act("approve", { text })}>{t("plan.approveEdited")}</button>
              <button type="button" class="bd-btn" disabled={busy} onClick={() => { setText(p.text); setMode(null); }}>{t("plan.resetEdits")}</button>
            </>
          ) : mode === "revise" ? (
            <>
              <button type="button" class="bd-btn bd-primary" disabled={busy} onClick={() => act("revise", { comment: text === p.text ? "" : text })}>{t("plan.requestNew")}</button>
              <button type="button" class="bd-btn" disabled={busy} onClick={() => { setText(p.text); setMode(null); }}>{t("plan.cancel")}</button>
            </>
          ) : (
            <>
              <button type="button" class="bd-btn bd-primary" disabled={busy} onClick={() => act("approve")}>{busy ? t("plan.starting") : t("plan.approveRun")}</button>
              <button type="button" class="bd-btn" disabled={busy} onClick={() => setMode("edit")}>{t("plan.edit")}</button>
              <button type="button" class="bd-btn" disabled={busy} onClick={() => { setText(""); setMode("revise"); }}>{t("plan.revise")}</button>
              <button type="button" class="bd-btn is-danger" disabled={busy} onClick={() => act("reject")}>{t("plan.reject")}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Карточки планов хода: по id последнего сообщения хода; последний ход
// показывает и план, чей ход не нашёлся в ленте (идентификаторы после рестарта).
export function PlanCards({ sid, turnLast, isLastTurn, feedIds, chatModel }) {
  const st = useChatReview(sid);
  const plans = st?.plans ?? [];
  const mine = plans.filter((p) => p.turn === turnLast || (isLastTurn && p === plans.at(-1) && (!p.turn || !feedIds?.has(p.turn))));
  if (!mine.length) return null;
  return mine.map((p) => <PlanCard key={p.id} p={p} sid={sid} chatModel={chatModel} />);
}

// Переключатель «Сначала план» в листе режима (T-19, T-23).
export function PlanFirstToggle({ session, engine, admin, busy, binding = null, bound = true }) {
  const on = session?.teleharness?.planFirst === true;
  const reason = engine === "opencode" && !admin ? t("plan.toggle.noPlanAgent") : null;
  const [saving, setSaving] = useState(false);
  async function flip() {
    if (reason || saving || busy) return;
    setSaving(true);
    try {
      const body = bound || !binding ? { planFirst: !on } : { model: binding.model, agent: binding.agent, planFirst: !on };
      const r = await api.patchBinding(session.id, body, {});
      if (r?.teleharness) sessions.value = upsertSession(sessions.value, { id: session.id, teleharness: r.teleharness });
    } catch (e) {
      setNotice(e?.body?.error ?? (e?.status === 400 ? t("plan.toggle.chooseModelFirst") : t("plan.toggle.failed")), 8000);
    } finally {
      setSaving(false);
    }
  }
  return (
    <label class={"pl-toggle" + (reason ? " is-off" : "")} data-req="FEAT-20.1 кр. 12">
      <input type="checkbox" checked={on} disabled={Boolean(reason) || saving || busy} onChange={flip} />
      <span>
        <b>{t("review.planFirst")}</b>
        <span class="picker-row-desc" style="display:block">{reason ?? t("plan.toggle.desc")}</span>
      </span>
    </label>
  );
}
