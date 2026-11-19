// FEAT-18.6: Настройки → «Модель и агенты» → «Продолжать автоматически при лимите».
// Выключатель и порядок запасных моделей (до 3, только доступные пользователю — список
// моделей тот же, что в выборе модели). Хранится в учётной записи на сервере
// (GET/PUT /teleharness/api/me/auto-relay): передачу делает сервер, даже при закрытом телефоне.
// По умолчанию выключено — тогда при лимите плашка с кнопкой «Продолжить в …».
import { useEffect, useState } from "preact/hooks";
import { ModelPicker, PickerSheet } from "../Pickers.jsx";
import { api, explainApiError } from "../../lib/api.js";
import { providerCfg } from "../../lib/store.js";
import { ENGINE_SHORT, engineOf, modelName } from "../../lib/engine.js";
import { t } from "../../lib/i18n.js";
import "../relay.css";

export const AUTO_RELAY_MAX = 3;
export const autoRelayTitle = () => t("autoRelay.title");
export const autoRelayHint = () => t("autoRelay.hint");

const same = (a, b) => a?.providerID === b?.providerID && a?.modelID === b?.modelID;

// Чистые операции над порядком (тестируются отдельно).
export function addModel(order, m, max = AUTO_RELAY_MAX) {
  const list = Array.isArray(order) ? order : [];
  if (!m || list.some((x) => same(x, m)) || list.length >= max) return list;
  return [...list, { providerID: m.providerID, modelID: m.modelID }];
}
export function removeAt(order, i) {
  return order.filter((_, k) => k !== i);
}
export function moveUp(order, i) {
  if (i <= 0 || i >= order.length) return order;
  const next = order.slice();
  [next[i - 1], next[i]] = [next[i], next[i - 1]];
  return next;
}

const label = (m) => `${modelName(providerCfg.value, m)} · ${ENGINE_SHORT[engineOf(m.providerID)] ?? ""}`;

export default function AutoRelayRow({ client = api }) {
  const [state, setState] = useState({ status: "loading", on: false, order: [] }); // loading | ready | error
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [picking, setPicking] = useState(false);

  const load = async () => {
    setState((s) => ({ ...s, status: "loading" }));
    try {
      const r = await client.getAutoRelay();
      setState({ status: "ready", on: r?.on === true, order: Array.isArray(r?.order) ? r.order : [] });
    } catch {
      setState((s) => ({ ...s, status: "error" }));
    }
  };
  useEffect(() => {
    load();
  }, []);

  const save = async (next) => {
    const prev = state;
    setState({ ...state, ...next }); // сразу видно; при отказе — назад
    setSaving(true);
    setError(null);
    try {
      const r = await client.setAutoRelay({ on: next.on ?? state.on, order: next.order ?? state.order });
      setState({ status: "ready", on: r?.on === true, order: Array.isArray(r?.order) ? r.order : [] });
    } catch (err) {
      setState(prev);
      setError(err?.status === 403 ? t("autoRelay.forbidden") : explainApiError(err, t("autoRelay.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  if (state.status === "error") {
    return (
      <li class="card" data-feat="FEAT-18.6">
        <div class="set-row">
          <div class="set-main">
            <div class="row-title">{autoRelayTitle()}</div>
            <div class="set-value is-error">
              {t("autoRelay.loadFailed")}{" "}
              <button type="button" class="link-btn" onClick={load}>{t("common.retry")}</button>
            </div>
          </div>
        </div>
      </li>
    );
  }

  const { on, order } = state;
  const loading = state.status === "loading";
  return (
    <li class="card" data-feat="FEAT-18.6">
      <div class="set-row is-top">
        <div class="set-main">
          <div class="row-title" id="autorelay-title">{autoRelayTitle()}</div>
          <div class="set-hint">{autoRelayHint()}</div>
          {on && (
            <div class="autorelay" aria-label={t("autoRelay.backups")}>
              <div class="set-value">{t("autoRelay.backupsOrdered")}</div>
              {order.length === 0 ? (
                <div class="set-warn" role="status">{t("autoRelay.empty")}</div>
              ) : (
                <ol class="autorelay-list">
                  {order.map((m, i) => (
                    <li class="autorelay-item" key={m.providerID + "/" + m.modelID}>
                      <span class="autorelay-n">{i + 1}.</span>
                      <span class="autorelay-name">
                        <span class={"engine-dot" + (engineOf(m.providerID) === "claude" ? " is-claude" : engineOf(m.providerID) === "codex" ? " is-codex" : "")} aria-hidden="true" /> {label(m)}
                      </span>
                      <button class="autorelay-btn" type="button" aria-label={t("autoRelay.up", { name: label(m) })} disabled={saving || i === 0} onClick={() => save({ order: moveUp(order, i) })}>↑</button>
                      <button class="autorelay-btn" type="button" aria-label={t("autoRelay.remove", { name: label(m) })} disabled={saving} onClick={() => save({ order: removeAt(order, i) })}>✕</button>
                    </li>
                  ))}
                </ol>
              )}
              {order.length < AUTO_RELAY_MAX && (
                <button class="access-btn autorelay-add" type="button" disabled={saving} onClick={() => setPicking(true)}>
                  {t("autoRelay.add")}
                </button>
              )}
            </div>
          )}
          {error && <div class="set-warn" role="alert">{error}</div>}
        </div>
        <button
          class="switch" type="button" role="switch" aria-labelledby="autorelay-title"
          aria-checked={on ? "true" : "false"} disabled={loading || saving}
          onClick={() => save({ on: !on })}
        />
      </div>
      {picking && (
        <PickerSheet title={t("autoRelay.pickTitle")} onClose={() => setPicking(false)}>
          <ModelPicker
            value={null}
            note={t("autoRelay.pickNote")}
            onPick={(m) => {
              setPicking(false);
              if (!order.some((x) => same(x, m))) save({ order: addModel(order, m) });
            }}
          />
        </PickerSheet>
      )}
    </li>
  );
}
