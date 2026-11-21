// FEAT-11.18 (шаг В): Relay — чат продолжается на другом движке или модели.
// Макет design/mockups-v2/relay.html: кнопки на плашке лимита (кадр 1), отметка в ленте
// (кадр 2), лист выбора из меню чата (кадр 3), полоска «остаток на исходе» (кадр 6).
import { useEffect, useState } from "preact/hooks";
import { effectivePrefs, providerCfg, refreshSubscriptions, relayChat, sessions, subscriptions } from "../../lib/store.js";
import { bindingOf, engineShortOf, modelName } from "../../lib/engine.js";
import { lowQuota, relayTime, suggestRelay, windowWords } from "../../lib/relay.js";
import { fmtClock } from "../../lib/normalize.js";
import { t } from "../../lib/i18n.js";
import { ModelPicker, PickerSheet, modelGroups } from "../Pickers.jsx";
import { RELAY_REASON_AUTO } from "../../../shared/relay.js";
import "../relay.css";

const sessionOf = (id) => sessions.value.find((s) => s.id === id) ?? null;
const nameOf = (m) => modelName(providerCfg.value, { providerID: m?.providerID, modelID: m?.modelID });
const ENGINE_WORD = { opencode: "opencode", claude: "Claude Code", codex: "Codex" };
const engineWordOf = (target) => (target?.engine === "acp" ? engineShortOf(target.providerID) || "ACP" : ENGINE_WORD[target?.engine] ?? target?.engine ?? "");

// Куда предложить передать этот чат (или null — некуда).
export function relayTarget(id) {
  const binding = bindingOf(sessionOf(id));
  if (!binding) return null;
  return suggestRelay(modelGroups(providerCfg.value), binding, effectivePrefs()?.model ?? null);
}

// Лист «Продолжить в другом движке» (кадр 3): выбор модели → передача.
export function RelaySheet({ sessionId, reason = null, resume = false, onClose }) {
  const binding = bindingOf(sessionOf(sessionId));
  const [busy, setBusy] = useState(false);
  const pick = async (model) => {
    if (busy) return;
    if (binding?.model?.providerID === model.providerID && binding?.model?.modelID === model.modelID) return onClose?.();
    setBusy(true);
    const ok = await relayChat(sessionId, model, { reason, resume });
    setBusy(false);
    if (ok) onClose?.();
  };
  return (
    <PickerSheet title={t("relay.title")} onClose={onClose}>
      <p class="relay-sub">{t("relay.sub")}</p>
      <ModelPicker value={binding?.model ?? null} onPick={pick} />
    </PickerSheet>
  );
}

// Действия передачи на плашке лимита (кадр 1): главное — в предложенную модель, рядом — выбор.
export function RelayActions({ sessionId, onPickOther }) {
  const [busy, setBusy] = useState(false);
  const target = relayTarget(sessionId);
  if (!target) return null;
  const go = async () => {
    if (busy) return;
    setBusy(true);
    await relayChat(sessionId, { providerID: target.providerID, modelID: target.modelID }, { reason: "limit", resume: true });
    setBusy(false);
  };
  return (
    <>
      <button class="stall-btn relay-primary" type="button" disabled={busy} onClick={go}>
        {busy ? t("relay.busy") : t("relay.continueIn", { model: nameOf(target), engine: engineWordOf(target) })}
      </button>
      <button class="stall-btn" type="button" disabled={busy} onClick={onPickOther}>{t("relay.otherModel")}</button>
    </>
  );
}

// Отметка передачи в ленте (кадр 2). FEAT-18.6: авто-передача по лимиту — строкой под пилюлей.
export function RelayMark({ mark }) {
  const from = nameOf(mark.from);
  const to = nameOf(mark.to);
  if (mark.reason === RELAY_REASON_AUTO) {
    return (
      <div class="relay-mark-auto" role="note" aria-label={t("relay.markAutoAria", { from, to, time: relayTime(mark.at), why: t("relay.autoWords") })}>
        <RelayPillRow mark={mark} from={from} to={to} />
        <div class="relay-why" aria-hidden="true">{t("relay.autoWords")}</div>
      </div>
    );
  }
  return (
    <div class="relay-mark" role="note" aria-label={t("relay.markAria", { from, to, time: relayTime(mark.at) })}>
      <RelayPill mark={mark} from={from} to={to} />
    </div>
  );
}

function RelayPillRow({ mark, from, to }) {
  return (
    <div class="relay-mark">
      <RelayPill mark={mark} from={from} to={to} />
    </div>
  );
}

function RelayPill({ mark, from, to }) {
  return (
    <span class="relay-pill">
      <i class={"engine-dot" + (mark.from?.engine === "claude" ? " is-claude" : mark.from?.engine === "codex" ? " is-codex" : mark.from?.engine === "acp" ? " is-acp" : "")} aria-hidden="true" />
      {from}
      <b aria-hidden="true">→</b>
      <i class={"engine-dot" + (mark.to?.engine === "claude" ? " is-claude" : mark.to?.engine === "codex" ? " is-codex" : mark.to?.engine === "acp" ? " is-acp" : "")} aria-hidden="true" />
      <b>{to}</b>
      <span class="relay-at">· {relayTime(mark.at)}</span>
    </span>
  );
}

// Полоска «остаток на исходе» (кадр 6): только там, где остаток известен (z.ai), меньше 15 %.
// BUG-238: show DD.MM date for weekly/monthly windows or any reset not on today (MSK).
export function formatQuotaReset(resetAt, { now = Date.now(), kind = null } = {}) {
  if (!resetAt) return null;
  const d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return null;
  const tz = "Europe/Moscow";
  const time = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
  const dayKey = (v) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(v);
  const needDate = kind === "week" || kind === "month" || dayKey(d) !== dayKey(new Date(now));
  if (!needDate) return t("relay.quota.resetMsk", { time });
  const date = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(d);
  return t("relay.quota.resetDateMsk", { date, time });
}

export function QuotaStrip({ sessionId, hidden = false, onPickOther }) {
  const binding = bindingOf(sessionOf(sessionId));
  const onGlmPlan = binding?.engine === "opencode" && /^zai/.test(String(binding?.model?.providerID ?? ""));
  const [dismissed, setDismissed] = useState(null); // ключ окна, для которого полоска скрыта
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!onGlmPlan) return undefined;
    refreshSubscriptions();
    const timer = setInterval(() => { if (!document.hidden) refreshSubscriptions(); }, 120_000);
    return () => clearInterval(timer);
  }, [onGlmPlan, sessionId]);
  if (hidden || !onGlmPlan) return null;
  const low = lowQuota(subscriptions.value, binding);
  if (!low) return null;
  const key = `${low.kind}:${low.resetAt ?? ""}`;
  if (dismissed === key) return null;
  const target = relayTarget(sessionId);
  const other = target && target.engine !== binding.engine ? target : null;
  const resetLine = formatQuotaReset(low.resetAt, { kind: low.kind });
  const go = async () => {
    if (busy || !other) return;
    setBusy(true);
    await relayChat(sessionId, { providerID: other.providerID, modelID: other.modelID }, { reason: "low-quota" });
    setBusy(false);
  };
  return (
    <div class="stall-bar quota-strip" role="status">
      <span class="stall-text">
        <b class="turn-error-title">{t("relay.quota.left", { left: low.left, window: windowWords(low.kind, low.number) })}</b>{" "}
        {resetLine ? `${resetLine} ` : ""}{t("relay.quota.hint")}
      </span>
      <span class="turn-error-actions">
        {other ? (
          <button class="stall-btn" type="button" disabled={busy} onClick={go}>{busy ? t("relay.busy") : t("relay.continueInModel", { model: nameOf(other) })}</button>
        ) : (
          <button class="stall-btn" type="button" onClick={onPickOther}>{t("relay.otherModel")}</button>
        )}
        <button class="stall-btn" type="button" onClick={() => setDismissed(key)}>{t("chat.dismiss")}</button>
      </span>
    </div>
  );
}
