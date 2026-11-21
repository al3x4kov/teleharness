// FEAT-20.4 / BUG-279 / BUG-285. Вход в Google Antigravity по подписке Google:
// агент печатает ссылку Google, после согласия браузер попадает на loopback-адрес
// (выглядит как ошибка соединения) — пользователь копирует адрес из строки и вставляет
// сюда, портал ретранслирует его серверу.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { providerCfg } from "../../lib/store/state.js";
import { refreshProvider } from "../../lib/store/catalog.js";
import { t } from "../../lib/i18n.js";
import "../acp.css";

const LABEL_KEYS = {
  idle: "acp.login.idle",
  starting: "acp.login.startingAgent",
  verifying: "acp.login.verifying",
  ready: "acp.login.ready",
  rejected: "acp.login.rejectedGoogle",
  unavailable: "acp.login.unavailableAgent",
  failed: "acp.login.failed",
  expired: "acp.login.expired",
  "verification-timeout": "acp.login.timeoutAddr",
};

function pillMeta(status) {
  if (status === "ready") return { cls: "is-ok", ico: "✓" };
  if (status === "starting" || status === "verifying" || status === "awaiting-code") return { cls: "is-neutral", ico: "…" };
  if (status === "rejected" || status === "failed" || status === "unavailable" || status === "verification-timeout") return { cls: "is-err", ico: "✕" };
  return { cls: "is-warn", ico: "!" };
}

export default function AntigravityLogin({ agent = "antigravity", version = null }) {
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const address = useRef(null);
  const revision = useRef(0);

  useEffect(() => {
    let live = true;
    let timer;
    async function refresh() {
      const versionNum = revision.current;
      try {
        const next = await api.acpLogin(agent);
        if (live && versionNum === revision.current) setAttempt(next);
      } catch {
        if (live) setError(t("acp.login.statusErr"));
      }
      if (live) timer = setTimeout(refresh, 2000);
    }
    refresh();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  async function act(body) {
    revision.current++;
    setBusy(true);
    setError("");
    try {
      setAttempt(await api.acpLogin(agent, body));
    } catch {
      setError(t("acp.login.actionErr"));
    } finally {
      revision.current++;
      setBusy(false);
    }
  }

  const status = attempt?.status;
  useEffect(() => {
    if (status === "ready") void refreshProvider();
  }, [status]);

  const modelCount = (providerCfg.value?.models ?? []).filter((m) => m.providerID === "acp-antigravity").length;
  const pill = pillMeta(status);
  const statusText = LABEL_KEYS[status] ? t(LABEL_KEYS[status]) : (attempt ? t("acp.login.waiting") : t("acp.login.loading"));

  return (
    <section class="card acp-card" data-req="FEAT-20.4">
      <div class="acp-card-head">
        <div>
          <h3 class="acp-card-title">Google Antigravity</h3>
          {(version || modelCount > 0) && (
            <p class="acp-card-meta">
              {[version ? `v${version}` : null, modelCount > 0 ? t("acp.modelsCount", { count: modelCount }) : null].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        <span class={"acp-pill " + pill.cls} aria-live="polite">
          <span aria-hidden="true">{pill.ico}</span>
          <span>{statusText}</span>
        </span>
      </div>

      {error && <p class="acp-alert" role="alert">{error}</p>}

      {status === "awaiting-code" && (
        <form
          class="acp-form"
          onSubmit={(event) => {
            event.preventDefault();
            const value = address.current.value.trim();
            address.current.value = "";
            act({ action: "submit", id: attempt.id, url: value });
          }}
        >
          <div class="acp-actions">
            <a class="btn" href={attempt.url} target="_blank" rel="noopener">{t("acp.login.openGoogle")}</a>
          </div>
          <p class="acp-card-meta">{t("acp.login.antigravityHint")}</p>
          <label class="acp-field">
            <span>{t("acp.login.addrLabel")}</span>
            <input class="acp-input" ref={address} type="text" autoComplete="off" required maxLength={4096} />
          </label>
          <div class="acp-actions">
            <button type="submit" class="btn btn-primary" disabled={busy}>{t("acp.login.finishBtn")}</button>
          </div>
        </form>
      )}

      {["verification-timeout", "idle", "expired", "rejected", "failed", "unavailable"].includes(status) && (
        <div class="acp-form">
          <p class="acp-warn">
            <span class="acp-warn-ico" aria-hidden="true">⚠</span>
            <span>{t("acp.login.googleRiskWarn")}</span>
          </p>
          <div class="acp-actions">
            <button type="button" class="btn btn-primary" disabled={busy} onClick={() => act({ action: "start", confirmed: true })}>
              {t("acp.login.signInGoogle")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
