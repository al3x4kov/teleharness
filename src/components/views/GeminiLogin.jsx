// FEAT-20.4 / BUG-285
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { providerCfg } from "../../lib/store/state.js";
import { t } from "../../lib/i18n.js";
import "../acp.css";

const LABEL_KEYS = {
  unsupported: "acp.login.unsupportedGemini",
  "verification-timeout": "acp.login.timeoutGemini",
  idle: "acp.login.idle",
  starting: "acp.login.startingCli",
  submitted: "acp.login.submitted",
  ready: "acp.login.ready",
  rejected: "acp.login.rejected",
  unavailable: "acp.login.unavailableCli",
  failed: "acp.login.failed",
  expired: "acp.login.expired",
};

function pillMeta(status) {
  if (status === "ready") return { cls: "is-ok", ico: "✓" };
  if (status === "starting" || status === "submitted" || status === "awaiting-device" || status === "awaiting-code") return { cls: "is-neutral", ico: "…" };
  if (status === "rejected" || status === "failed" || status === "unavailable" || status === "unsupported" || status === "verification-timeout") return { cls: "is-err", ico: "✕" };
  return { cls: "is-warn", ico: "!" };
}

export default function AgentLogin({ agent = "gemini", version = null }) {
  const gemini = agent === "gemini";
  const [attempt, setAttempt] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const code = useRef(null);
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
  const providerId = "acp-" + agent;
  const modelCount = (providerCfg.value?.models ?? []).filter((m) => m.providerID === providerId).length;
  const pill = pillMeta(status);
  const statusText = LABEL_KEYS[status] ? t(LABEL_KEYS[status]) : (attempt ? t("acp.login.waiting") : t("acp.login.loading"));

  return (
    <section class="card acp-card" data-req="FEAT-20.4">
      <div class="acp-card-head">
        <div>
          <h3 class="acp-card-title">{gemini ? "Gemini CLI" : "GitHub Copilot CLI"}</h3>
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

      {status === "awaiting-device" && (
        <div class="acp-form">
          <div class="acp-actions">
            <a class="btn btn-primary" href={attempt.url} target="_blank" rel="noreferrer">{t("acp.login.openGitHub")}</a>
          </div>
          <p class="acp-device-code">{t("acp.login.githubCode")} <strong>{attempt.code}</strong></p>
        </div>
      )}

      {status === "awaiting-code" && (
        <form
          class="acp-form"
          onSubmit={(event) => {
            event.preventDefault();
            const value = code.current.value;
            code.current.value = "";
            act({ action: "submit", id: attempt.id, code: value });
          }}
        >
          <div class="acp-actions">
            <a class="btn" href={attempt.url} target="_blank" rel="noreferrer">{t("acp.login.openGoogle")}</a>
          </div>
          <label class="acp-field">
            <span>{t("acp.login.googleCodeLabel")}</span>
            <input class="acp-input" ref={code} type="password" autoComplete="off" required maxLength={4096} />
          </label>
          <div class="acp-actions">
            <button type="submit" class="btn btn-primary" disabled={busy}>{t("acp.login.confirmBtn")}</button>
          </div>
        </form>
      )}

      {["verification-timeout", "idle", "expired", "rejected", "failed", "unavailable"].includes(status) && (
        <div class="acp-form">
          {gemini && (
            <label class="acp-check">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.currentTarget.checked)} />
              <span>{t("acp.login.googleRiskCheck")}</span>
            </label>
          )}
          <div class="acp-actions">
            <button
              type="button"
              class="btn btn-primary"
              disabled={(gemini && !confirmed) || busy}
              onClick={() => act({ action: "start", confirmed: gemini ? confirmed : true })}
            >
              {gemini ? t("acp.login.signInGoogle") : t("acp.login.signInGitHub")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
