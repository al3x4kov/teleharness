// Settings -> Background agents (admin only).
// Global trigger kill-switch, daily background Claude quota, and GitHub connections (no tokens).
import { useEffect, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { locale, t } from "../../lib/i18n.js";

function statusText(s) {
  if (s === "ok") return t("bgAdmin.status.ok");
  if (s === "invalid") return t("bgAdmin.status.invalid");
  if (s === "expired") return t("bgAdmin.status.expired");
  return s || t("bgAdmin.status.unknown");
}

function expiryText(ts) {
  if (!ts) return t("bgAdmin.noExpiry");
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? t("bgAdmin.until", { date: d.toLocaleDateString(locale()) }) : t("bgAdmin.noExpiry");
}

export default function BackgroundAgentsSection() {
  const [data, setData] = useState(null);
  const [limitInput, setLimitInput] = useState("10");
  const [userPerDayInput, setUserPerDayInput] = useState("30");
  const [perHourInput, setPerHourInput] = useState("6");
  const [queueInput, setQueueInput] = useState("20");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  // BUG-319: one server response feeds every input of the admin card.
  function syncInputs(res) {
    setLimitInput(String(res?.claudePerDay ?? 10));
    setUserPerDayInput(String(res?.userPerDay ?? 30));
    setPerHourInput(String(res?.defaultPerHour ?? 6));
    setQueueInput(String(res?.defaultQueue ?? 20));
  }

  async function load() {
    setError("");
    try {
      const res = await api.adminBackground();
      setData(res);
      syncInputs(res);
    } catch (e) {
      setError(e?.message || t("bgAdmin.errLoad"));
    }
  }

  useEffect(() => { load(); }, []);

  async function toggleStop() {
    if (!data) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const next = !data.adminStopped;
      const res = await api.adminUpdateBackground({ adminStopped: next });
      setData(res);
      syncInputs(res);
      setNote(next ? t("bgAdmin.noteStopped") : t("bgAdmin.noteResumed"));
    } catch (e) {
      setError(e?.message || t("bgAdmin.errToggle"));
    } finally {
      setBusy(false);
    }
  }

  async function saveLimit(ev) {
    ev.preventDefault();
    const n = Number(limitInput);
    if (!Number.isInteger(n) || n < 0 || n > 500) {
      setError(t("bgAdmin.errLimitRange"));
      return;
    }
    setBusy(true);
    setError("");
    setNote("");
    try {
      const res = await api.adminUpdateBackground({ claudePerDay: n });
      setData(res);
      syncInputs(res);
      setNote(t("bgAdmin.noteLimitSaved", { limit: res.claudePerDay }));
    } catch (e) {
      setError(e?.message || t("bgAdmin.errSaveLimit"));
    } finally {
      setBusy(false);
    }
  }

  // BUG-319: per-user daily limit + rate/queue defaults for new triggers.
  async function saveGeneralLimits(ev) {
    ev.preventDefault();
    const userPerDay = Number(userPerDayInput);
    const defaultPerHour = Number(perHourInput);
    const defaultQueue = Number(queueInput);
    if (!Number.isInteger(userPerDay) || userPerDay < 1 || userPerDay > 500) {
      setError(t("bgAdmin.errUserPerDayRange"));
      return;
    }
    if (!Number.isInteger(defaultPerHour) || defaultPerHour < 1 || defaultPerHour > 60) {
      setError(t("bgAdmin.errPerHourRange"));
      return;
    }
    if (!Number.isInteger(defaultQueue) || defaultQueue < 1 || defaultQueue > 100) {
      setError(t("bgAdmin.errQueueRange"));
      return;
    }
    setBusy(true);
    setError("");
    setNote("");
    try {
      const res = await api.adminUpdateBackground({ userPerDay, defaultPerHour, defaultQueue });
      setData(res);
      syncInputs(res);
      setNote(t("bgAdmin.noteLimitsSaved"));
    } catch (e) {
      setError(e?.message || t("bgAdmin.errSaveLimits"));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <div class="t-card" data-bg-admin>
        <p class="t-lead" role="alert">{error}</p>
        <button class="t-btn" type="button" onClick={load}>{t("common.retry")}</button>
      </div>
    );
  }
  if (!data) {
    return <p class="t-muted" data-bg-admin>{t("bgAdmin.loading")}</p>;
  }

  return (
    <div class="t-list" data-bg-admin>
      <div class="t-card">
        <div class="t-row t-nowrap">
          <b>{t("bgAdmin.switchTitle")}</b>
          <span class={"t-pill " + (data.adminStopped ? "t-err" : "t-ok")}>
            {data.adminStopped ? t("bgAdmin.stoppedPill") : t("bgAdmin.runningPill")}
          </span>
        </div>
        <p class="t-muted t-small">{t("bgAdmin.switchDesc")}</p>
        <div class="t-row">
          <button
            type="button"
            class={"t-btn " + (data.adminStopped ? "t-primary" : "t-danger")}
            disabled={busy}
            onClick={toggleStop}
          >
            {data.adminStopped ? t("bgAdmin.resumeBtn") : t("bgAdmin.stopBtn")}
          </button>
        </div>
      </div>

      <form class="t-card" onSubmit={saveLimit}>
        <b>{t("bgAdmin.limitTitle")}</b>
        <p class="t-muted t-small">
          {t("bgAdmin.limitUsage", { used: data.claudeUsedToday, total: data.claudePerDay, left: data.claudeLeftToday })}
        </p>
        <div class="t-row">
          <label class="t-small" for="bg-claude-limit">{t("bgAdmin.limitLabel")}</label>
          <input
            id="bg-claude-limit"
            class="t-input t-num"
            type="number"
            min="0"
            max="500"
            step="1"
            value={limitInput}
            onInput={(e) => setLimitInput(e.currentTarget.value)}
            style="width:110px"
          />
          <button class="t-btn t-primary" type="submit" disabled={busy}>{t("common.save")}</button>
        </div>
      </form>

      <form class="t-card" onSubmit={saveGeneralLimits}>
        <b>{t("bgAdmin.generalTitle")}</b>
        <p class="t-muted t-small">{t("bgAdmin.generalDesc")}</p>
        <div class="t-row">
          <label class="t-small" for="bg-user-per-day">{t("bgAdmin.userPerDayLabel")}</label>
          <input
            id="bg-user-per-day"
            class="t-input t-num"
            type="number"
            min="1"
            max="500"
            step="1"
            value={userPerDayInput}
            onInput={(e) => setUserPerDayInput(e.currentTarget.value)}
            style="width:96px"
          />
        </div>
        <div class="t-row" style="margin-top:8px">
          <label class="t-small" for="bg-default-per-hour">{t("bgAdmin.perHourLabel")}</label>
          <input
            id="bg-default-per-hour"
            class="t-input t-num"
            type="number"
            min="1"
            max="60"
            step="1"
            value={perHourInput}
            onInput={(e) => setPerHourInput(e.currentTarget.value)}
            style="width:96px"
          />
        </div>
        <div class="t-row" style="margin-top:8px">
          <label class="t-small" for="bg-default-queue">{t("bgAdmin.queueLabel")}</label>
          <input
            id="bg-default-queue"
            class="t-input t-num"
            type="number"
            min="1"
            max="100"
            step="1"
            value={queueInput}
            onInput={(e) => setQueueInput(e.currentTarget.value)}
            style="width:96px"
          />
          <button class="t-btn t-primary" type="submit" disabled={busy}>{t("bgAdmin.saveLimitsBtn")}</button>
        </div>
      </form>

      <div class="t-card">
        <b>{t("bgAdmin.summaryTitle")}</b>
        <p class="t-small">
          {t("bgAdmin.summaryLine", { total: data.triggersTotal, enabled: data.triggersEnabled, active: data.activeRuns })}
        </p>
      </div>

      <div class="t-card">
        <b>{t("bgAdmin.connectionsTitle")}</b>
        {(!data.connections || data.connections.length === 0) ? (
          <p class="t-muted t-small">{t("bgAdmin.noConnections")}</p>
        ) : (
          <ul class="card-list" style="margin-top:8px">
            {data.connections.map((c) => (
              <li key={c.owner} class="card-row">
                <span>
                  <b>{c.owner}</b> · @{c.login} · •••• {c.tokenLast4}
                </span>
                <span class="t-muted t-small">{statusText(c.status)} · {expiryText(c.expiresAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {note && <p class="t-lead" role="status">{note}</p>}
      {error && <p class="t-lead" role="alert">{error}</p>}
    </div>
  );
}
