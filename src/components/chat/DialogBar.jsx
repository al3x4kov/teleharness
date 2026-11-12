// DialogBar: inline permission/question card sitting right above the composer.
// The old full-screen modal (gray backdrop, everything untappable) is gone on
// purpose (user request 2026-11-01): the chat keeps scrolling, the composer
// stays reachable, and the decision happens where the conversation happens.
// Dialogs of sessions that are not open wait in the store queue and surface
// as the «⏸ разрешение» badge on their chat card in the list.
//
// Questions (BUG-07.13): every question of the request is rendered and gets
// its own answer array (contract answers: string[][]); multi-select questions
// toggle options. A single single-choice question keeps the one-tap answer.
// The card re-arms after EVERY failed reply (dialog.attempt bumps), and an
// «Отправлено» card that is still mounted after SENT_STUCK_MS re-arms too —
// never a card without buttons.
import { useEffect, useRef, useState } from "preact/hooks";
import { replyDialog } from "../../lib/store.js";
import { copyText } from "../../lib/clipboard.js";
import { collectAnswers } from "../../lib/turn.js";
import { t } from "../../lib/i18n.js";
import "../dialogs.css";

const FLASH_MS = 150;
const SENT_STUCK_MS = 15_000;

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3 4.5 6v5c0 4.6 3.2 8.6 7.5 10 4.3-1.4 7.5-5.4 7.5-10V6L12 3z" />
      <path d="M12 8.5v4" />
      <path d="M12 15.6v.1" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.4 9.2a2.7 2.7 0 0 1 5.2 1c0 1.8-2.6 2.2-2.6 3.8" />
      <path d="M12 17.4v.1" />
    </svg>
  );
}

// Mono block, scroll-x (capped vertically), tap to copy (http fallback via
// the shared clipboard helper, R-24). The hint swaps text in a fixed row so
// the box never changes size between states.
function CommandBlock({ text }) {
  const [state, setState] = useState(null); // null | "ok" | "fail"
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copyText(text);
    setState(ok ? "ok" : "fail");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 1400);
  };
  return (
    <button type="button" class="dlg-cmd" onClick={copy}>
      <code>{text}</code>
      <span class={"dlg-cmd-hint" + (state === "ok" ? " is-ok" : "")} aria-live="polite">
        {state === "ok" ? t("common.copied") : state === "fail" ? t("message.copyFailed") : t("dialog.tapToCopy")}
      </span>
    </button>
  );
}

function ErrorLine({ dialog }) {
  if (!dialog.error) return null;
  return (
    <p class="dlg-error" role="alert">
      {dialog.attempt > 1 ? t("dialog.sendFailedAttempts", { count: dialog.attempt }) : t("dialog.sendFailed")}
      {dialog.errorReason && <span class="dlg-error-why"> — {dialog.errorReason}</span>}
    </p>
  );
}

function PermissionCard({ dialog, queue, sent, choose }) {
  const cmd = dialog.command ?? dialog.patterns?.[0] ?? null;
  return (
    <section class="dlg-card" role="region" aria-label={t("dialog.permission.title")}>
      <header class="dlg-head">
        <span class="dlg-head-icon"><ShieldIcon /></span>
        <h2 class="dlg-title">{t("dialog.permission.title")}</h2>
        {dialog.permission && <span class="dlg-tool">{dialog.permission}</span>}
        {queue > 0 && <span class="dlg-queue">+{queue}</span>}
      </header>
      <ErrorLine dialog={dialog} />
      {cmd && <CommandBlock text={cmd} />}
      {sent ? (
        <p class="dlg-sent" role="status">{t("dialog.sent")}</p>
      ) : (
        <div class="dlg-actions">
          <button type="button" class="dlg-btn dlg-btn--reject" onClick={() => choose("reject")}>
            {t("dialog.permission.reject")}
          </button>
          <button type="button" class="dlg-btn dlg-btn--allow" onClick={() => choose("once")}>
            {t("dialog.permission.allow")}
          </button>
          {dialog.always?.length > 0 && (
            <button type="button" class="dlg-btn dlg-btn--always" onClick={() => choose("always")}>
              {t("dialog.permission.always")}
              <span class="dlg-btn-sub">{dialog.always[0]}</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const optionsOf = (q) => (q?.options ?? []).map((o) => (typeof o === "string" ? { label: o } : o)).filter((o) => o?.label);


function QuestionCard({ dialog, queue, sent, choose }) {
  const questions = dialog.questions?.length ? dialog.questions : [{}];
  const oneTap = questions.length === 1 && !questions[0].multiple;
  const [picks, setPicks] = useState(() => questions.map(() => []));
  const [customs, setCustoms] = useState(() => questions.map(() => ""));
  const [customOpen, setCustomOpen] = useState(() => questions.map(() => false));

  const toggle = (qi, label) => {
    const q = questions[qi];
    setPicks((all) =>
      all.map((cur, i) => {
        if (i !== qi) return cur;
        if (q.multiple) return cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
        return cur[0] === label ? [] : [label];
      }),
    );
  };
  const setAt = (setter, qi, v) => setter((all) => all.map((x, i) => (i === qi ? v : x)));
  const answers = collectAnswers(questions, picks, customs);
  const head = questions.length === 1 ? questions[0].header || t("dialog.question.one") : t("dialog.question.many", { count: questions.length });

  return (
    <section class="dlg-card" role="region" aria-label={head}>
      <header class="dlg-head">
        <span class="dlg-head-icon"><HelpIcon /></span>
        <h2 class="dlg-title">{head}</h2>
        {queue > 0 && <span class="dlg-queue">+{queue}</span>}
      </header>
      <ErrorLine dialog={dialog} />
      {sent ? (
        <>
          {questions.map((q, qi) => q.question && <p class="dlg-question" key={qi}>{q.question}</p>)}
          <p class="dlg-sent" role="status">{t("dialog.sent")}</p>
        </>
      ) : (
        <>
          {questions.map((q, qi) => (
            <div class={questions.length > 1 ? "dlg-q" : undefined} key={qi}>
              {questions.length > 1 && q.header && <h3 class="dlg-q-head">{q.header}</h3>}
              {q.question && <p class="dlg-question">{q.question}</p>}
              {q.multiple && <p class="dlg-q-hint">{t("dialog.question.multiple")}</p>}
              <div class="dlg-options" role={q.multiple ? "group" : undefined}>
                {optionsOf(q).map((o) => {
                  const on = picks[qi]?.includes(o.label);
                  return (
                    <button
                      type="button" key={o.label}
                      class={"dlg-option" + (on ? " is-picked" : "")}
                      aria-pressed={oneTap ? undefined : on ? "true" : "false"}
                      onClick={() => (oneTap ? choose(o.label) : toggle(qi, o.label))}
                    >
                      <span class="dlg-option-label">{o.label}</span>
                      {o.description && <span class="dlg-option-desc">{o.description}</span>}
                    </button>
                  );
                })}
              </div>
              {customOpen[qi] ? (
                <div class="dlg-custom">
                  <textarea
                    class="dlg-custom-input" rows="2" placeholder={t("dialog.question.customPlaceholder")}
                    aria-label={t("dialog.question.customAria", { question: q.header || q.question || t("dialog.question.fallback") })}
                    value={customs[qi]} onInput={(e) => setAt(setCustoms, qi, e.currentTarget.value)}
                  />
                  {oneTap && (
                    <button
                      type="button" class="dlg-btn dlg-btn--allow dlg-custom-send"
                      disabled={!customs[qi].trim()} onClick={() => choose(customs[qi].trim())}
                    >
                      {t("composer.send")}
                    </button>
                  )}
                </div>
              ) : (
                <button type="button" class="dlg-custom-toggle" onClick={() => setAt(setCustomOpen, qi, true)}>
                  {t("dialog.question.custom")}
                </button>
              )}
            </div>
          ))}
          {!oneTap && (
            <div class="dlg-actions">
              <button type="button" class="dlg-btn dlg-btn--allow dlg-submit" disabled={!answers} onClick={() => choose(answers)}>
                {answers ? t("dialog.question.submit") : t("dialog.question.answerAll")}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default function DialogBar({ dialog, queue }) {
  const [sent, setSent] = useState(false);
  const timers = useRef([]);

  // A failed POST re-added the dialog with error:true and a NEW attempt
  // number — arm the card again (every time, not only after the first error).
  useEffect(() => {
    if (dialog.error) setSent(false);
  }, [dialog.error, dialog.attempt]);

  // Safety net: «Отправлено» still on screen long after the tap means the
  // card came back without an error (a lagging listing) — re-arm it.
  useEffect(() => {
    if (!sent) return undefined;
    const t = setTimeout(() => setSent(false), SENT_STUCK_MS);
    return () => clearTimeout(t);
  }, [sent]);

  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);

  const choose = (answer) => {
    if (sent || !answer || (Array.isArray(answer) && answer.length === 0)) return;
    setSent(true);
    // «Отправлено ✓» flash first; the reply then leaves the queue (or, on
    // failure, returns with error and this card re-arms).
    timers.current.push(setTimeout(() => replyDialog(dialog, answer), FLASH_MS));
  };

  return dialog.kind === "question" ? (
    <QuestionCard dialog={dialog} queue={queue} sent={sent} choose={choose} />
  ) : (
    <PermissionCard dialog={dialog} queue={queue} sent={sent} choose={choose} />
  );
}
