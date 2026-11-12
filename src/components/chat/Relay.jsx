// FEAT-11.18 (шаг В): Relay — чат продолжается на другом движке или модели.
// Макет design/mockups-v2/relay.html: кнопки на плашке лимита (кадр 1), отметка в ленте
// (кадр 2), лист выбора из меню чата (кадр 3), полоска «остаток на исходе» (кадр 6).
import { useEffect, useState } from "preact/hooks";
import { effectivePrefs, providerCfg, refreshSubscriptions, relayChat, sessions, subscriptions } from "../../lib/store.js";
import { bindingOf, modelName } from "../../lib/engine.js";
import { lowQuota, relayTime, suggestRelay, windowWords } from "../../lib/relay.js";
import { fmtClock } from "../../lib/normalize.js";
import { t } from "../../lib/i18n.js";
import { ModelPicker, PickerSheet, modelGroups } from "../Pickers.jsx";
import "../relay.css";

const sessionOf = (id) => sessions.value.find((s) => s.id === id) ?? null;
const nameOf = (m) => modelName(providerCfg.value, { providerID: m?.providerID, modelID: m?.modelID });
const ENGINE_WORD = { opencode: "opencode", claude: "Claude Code" };

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
        {busy ? t("relay.busy") : t("relay.continueIn", { model: nameOf(target), engine: ENGINE_WORD[target.engine] ?? target.engine })}
      </button>
      <button class="stall-btn" type="button" disabled={busy} onClick={onPickOther}>{t("relay.otherModel")}</button>
    </>
  );
}

// Отметка передачи в ленте (кадр 2).
export function RelayMark({ mark }) {
  const from = nameOf(mark.from);
  const to = nameOf(mark.to);
  return (
    <div class="relay-mark" role="note" aria-label={t("relay.markAria", { from, to, time: relayTime(mark.at) })}>
      <span class="relay-pill">
        <i class={"engine-dot" + (mark.from?.engine === "claude" ? " is-claude" : "")} aria-hidden="true" />
        {from}
        <b aria-hidden="true">→</b>
        <i class={"engine-dot" + (mark.to?.engine === "claude" ? " is-claude" : "")} aria-hidden="true" />
        <b>{to}</b>
        <span class="relay-at">· {relayTime(mark.at)}</span>
      </span>
    </div>
  );
}

// Полоска «остаток на исходе» (кадр 6): только там, где остаток известен (z.ai), меньше 15 %.
export function QuotaStrip({ sessionId, hidden = false, onPickOther }) {
  const binding = bindingOf(sessionOf(sessionId));
  const zai = binding?.engine === "opencode" && /^zai/.test(String(binding?.model?.providerID ?? ""));
  const [dismissed, setDismissed] = useState(null); // ключ окна, для которого полоска скрыта
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!zai) return undefined;
    refreshSubscriptions();
    const timer = setInterval(() => { if (!document.hidden) refreshSubscriptions(); }, 120_000);
    return () => clearInterval(timer);
  }, [zai, sessionId]);
  if (hidden || !zai) return null;
  const low = lowQuota(subscriptions.value, binding);
  if (!low) return null;
  const key = `${low.kind}:${low.resetAt ?? ""}`;
  if (dismissed === key) return null;
  const target = relayTarget(sessionId);
  const other = target && target.engine !== binding.engine ? target : null;
  // время сброса — в местном часовом поясе браузера и локали языка интерфейса
  const reset = low.resetAt ? fmtClock(low.resetAt) || null : null;
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
        {reset ? `${t("relay.quota.reset", { time: reset })} ` : ""}{t("relay.quota.hint")}
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
