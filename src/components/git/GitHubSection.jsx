// Settings -> GitHub: fine-grained PAT connection.
// Token is sent once (PUT), stored encrypted on the server, and never returned
// — UI only shows the last 4 characters. Expiring <= 7d warns; expired shows a
// banner to replace it; disconnect opens a confirmation sheet with impact.
import { useEffect, useState } from "preact/hooks";
import { api, explainApiError } from "../../lib/api.js";
import { githubConn, refreshGithubConn } from "../../lib/github-conn.js";
import { locale, t } from "../../lib/i18n.js";
import { Sheet, when } from "../temporal/ui.jsx";
import "./git.css";

const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

function formatDay(ts) {
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", year: "numeric" }).format(new Date(ts));
}

export function repoState(repo) {
  const p = repo.permissions ?? {};
  const fine = p.pull_requests !== undefined || p.webhooks !== undefined;
  const pr = fine ? p.pull_requests === "write" : Boolean(p.push || p.write || p.admin);
  const hooks = fine ? p.webhooks === "write" : Boolean(p.admin);
  if (!pr) return { kind: "bad", icon: "✕", text: t("gh.repo.lowPerms"), note: t("gh.repo.lowPermsNote") };
  if (!hooks) return { kind: "poll", icon: "⟳", text: t("gh.repo.poll"), note: t("gh.repo.pollNote") };
  return { kind: "ok", icon: "✓", text: t("gh.repo.ready"), note: t("gh.repo.readyNote") };
}

const PERM_KEYS = [
  ["Contents", "gh.perm.contentsWhat", "gh.perm.contentsWhy", true],
  ["Pull requests", "gh.perm.prWhat", null, true],
  ["Issues", "gh.perm.issuesWhat", "gh.perm.issuesWhy", true],
  ["Actions", "gh.perm.actionsWhat", "gh.perm.actionsWhy", true],
  ["Webhooks", "gh.perm.webhooksWhat", "gh.perm.webhooksWhy", false],
];

function Pill({ s }) {
  return (
    <span class={"gh-pill " + s.kind}>
      <i aria-hidden="true">{s.icon}</i>
      {s.text}
    </span>
  );
}

export default function GitHubSection({ client = api }) {
  const conn = githubConn.value;
  const [mode, setMode] = useState(null);
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sheet, setSheet] = useState(false);
  const [trigCount, setTrigCount] = useState(null);
  useEffect(() => {
    refreshGithubConn();
  }, []);
  const view = mode ?? (conn ? (conn.connected ? "view" : "form") : null);

  const connect = async () => {
    setBusy(true);
    setErr("");
    try {
      await client.githubSaveConnection(token.trim());
      setToken("");
      setShow(false);
      setMode("view");
      await refreshGithubConn();
    } catch (e) {
      setErr(e?.body?.error || explainApiError(e, t("gh.err.connect")));
    } finally {
      setBusy(false);
    }
  };
  const recheck = async () => {
    setBusy(true);
    setErr("");
    try {
      await client.githubCheckConnection();
      await refreshGithubConn();
    } catch (e) {
      await refreshGithubConn();
      setErr(e?.body?.error || explainApiError(e, t("gh.err.check")));
    } finally {
      setBusy(false);
    }
  };
  const openSheet = async () => {
    setSheet(true);
    setTrigCount(null);
    try {
      setTrigCount(((await client.temporalTriggers()) ?? []).length);
    } catch {
      setTrigCount(null);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await client.githubDeleteConnection();
      setSheet(false);
      setMode("form");
      await refreshGithubConn();
    } catch (e) {
      setErr(e?.body?.error || explainApiError(e, t("gh.err.disconnect")));
      setSheet(false);
    } finally {
      setBusy(false);
    }
  };

  if (!conn) return <div class="gh-loading" role="status">{t("gh.loading")}</div>;

  if (view === "form") {
    return (
      <div class="gh-section">
        <p class="gh-lead">{t("gh.lead")}</p>
        <label class="gh-field">
          <span class="gh-label">{t("gh.tokenLabel")}</span>
          <span class="gh-token">
            <input
              type={show ? "text" : "password"}
              value={token}
              onInput={(e) => setToken(e.currentTarget.value)}
              placeholder="github_pat_…"
              autocomplete="off"
              spellcheck={false}
              aria-label={t("gh.tokenLabel")}
            />
            <button type="button" class="gh-eye" aria-label={show ? t("gh.hideToken") : t("gh.showToken")} onClick={() => setShow((x) => !x)}>
              {show ? "🙈" : "👁"}
            </button>
          </span>
          <span class="gh-help">
            {t("gh.tokenHelp")}{" "}
            <a href={TOKEN_URL} target="_blank" rel="noreferrer">{t("gh.createTokenLink")}</a>
          </span>
        </label>
        <div class="gh-card">
          <h4>{t("gh.permsTitle")}</h4>
          <ul class="gh-perms">
            {PERM_KEYS.map(([name, whatKey, whyKey, must]) => (
              <li key={name}>
                <span class={"gh-mark " + (must ? "y" : "q")} aria-hidden="true">{must ? "✓" : "?"}</span>
                <span class="gh-perm">
                  <b>{name}</b> — {t(whatKey)}
                  {whyKey && <span class="gh-help"> {t(whyKey)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
        {err && <p class="gh-error" role="alert">{err}</p>}
        <div class="gh-actions">
          <button type="button" class="btn btn-primary gh-main" disabled={busy || token.trim().length < 20} onClick={connect}>
            {busy ? t("gh.checking") : t("gh.connect")}
          </button>
        </div>
      </div>
    );
  }

  const expired = conn.status !== "ok";
  const days = conn.expiresAt ? Math.ceil((conn.expiresAt - Date.now()) / 86400000) : null;
  const repos = conn.repos ?? [];
  return (
    <div class="gh-section">
      {expired && (
        <div class="t-banner t-banner-err" role="alert">
          <span class="t-banner-icon" aria-hidden="true">✕</span>
          <div class="t-banner-body">
            <b>{t("gh.expiredTitle")}</b>
            <div class="t-banner-text">{t("gh.expiredText")}</div>
            <button type="button" class="gh-banner-btn" onClick={() => setMode("form")}>{t("gh.pasteNewToken")}</button>
          </div>
        </div>
      )}
      {!expired && conn.expiringSoon && (
        <div class="t-banner t-banner-warn" role="status">
          <span class="t-banner-icon" aria-hidden="true">⚠</span>
          <div class="t-banner-body">
            <b>{t("gh.expiringTitle", { days, date: formatDay(conn.expiresAt) })}</b>
            <div class="t-banner-text">{t("gh.expiringText")}</div>
            <button type="button" class="gh-banner-btn" onClick={() => setMode("form")}>{t("gh.replaceToken")}</button>
          </div>
        </div>
      )}
      <div class="gh-card gh-owner">
        <span class="gh-avatar" aria-hidden="true">{(conn.login ?? "?")[0].toUpperCase()}</span>
        <span class="gh-owner-main">
          <b>{conn.login}</b>
          <span class="gh-help">{t("gh.tokenChecked", { last4: conn.tokenLast4, time: when(conn.checkedAt) })}</span>
        </span>
        <span class={"gh-pill " + (expired ? "bad" : "ok")}>
          <i aria-hidden="true">{expired ? "✕" : "✓"}</i>
          {expired ? t("gh.disconnected") : t("gh.connected")}
        </span>
        <button type="button" class="gh-check" disabled={busy} onClick={recheck}>{busy ? "…" : t("gh.recheck")}</button>
      </div>
      {repos.length > 0 && (
        <>
          <h5 class="gh-sub">{t("gh.reposHeading", { count: repos.length })}</h5>
          <div class="gh-card">
            <ul class="gh-repos">
              {repos.map((r) => {
                const s = repoState(r);
                return (
                  <li key={r.fullName} class="gh-repo">
                    <span class="gh-repo-main">
                      <b class="gh-repo-name">{r.fullName}</b>
                      <span class="gh-help">{s.note}</span>
                    </span>
                    <Pill s={s} />
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
      {err && <p class="gh-error" role="alert">{err}</p>}
      <div class="gh-actions">
        <button type="button" class="btn btn-danger gh-main" onClick={openSheet}>{t("gh.disconnectBtn")}</button>
      </div>
      {sheet && (
        <Sheet title={t("gh.disconnectTitle")} onClose={() => setSheet(false)}>
          <ul class="gh-sheet-list">
            <li>{trigCount == null ? t("gh.sheet.pauseNoCount") : t("gh.sheet.pauseCount", { count: trigCount })}</li>
            <li>{t("gh.sheet.webhooks")}</li>
            <li>{t("gh.sheet.running")}</li>
          </ul>
          <div class="gh-actions gh-sheet-actions">
            <button type="button" class="btn btn-danger" disabled={busy} onClick={disconnect}>{t("gh.disconnectConfirm")}</button>
            <button type="button" class="btn" onClick={() => setSheet(false)}>{t("common.cancel")}</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
