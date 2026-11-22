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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  async function load() {
    setError("");
    try {
      const res = await api.adminBackground();
      setData(res);
      setLimitInput(String(res?.claudePerDay ?? 10));
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
      setLimitInput(String(res.claudePerDay));
      setNote(t("bgAdmin.noteLimitSaved", { limit: res.claudePerDay }));
    } catch (e) {
      setError(e?.message || t("bgAdmin.errSaveLimit"));
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
            class="t-in"
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
