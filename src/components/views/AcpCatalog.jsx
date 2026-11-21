// FEAT-20.4 / BUG-285
import { useEffect, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { locale, t } from "../../lib/i18n.js";
import AgentLogin from "./GeminiLogin.jsx";
import AntigravityLogin from "./AntigravityLogin.jsx";
import "../acp.css";

// FEAT-20.4. Мастер входа выбирается по агенту; карточка Gemini CLI из UI
// убрана — Google отклонил OAuth-клиент, вместо него Google Antigravity.
const LOGIN_VIEWS = { antigravity: AntigravityLogin, "github-copilot-cli": AgentLogin };

function agentRank(agent) {
  if (agent.status === "installed") return 0;
  if (agent.installable) return 1;
  return 2;
}

export default function AcpCatalog() {
  const [catalog, setCatalog] = useState(null);
  const [selection, setSelection] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [installing, setInstalling] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  async function load(refresh = false) {
    try {
      const result = await api.acpCatalog(refresh);
      setCatalog(result);
      setError(result.error ?? "");
    } catch {
      setError(t("acp.catalog.unavailable"));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function install(agent) {
    setInstalling(agent.id);
    setSelection(null);
    try {
      await api.installAcpAgent(agent);
      await load();
    } catch {
      setError(t("acp.catalog.installErr", { name: agent.name }));
    } finally {
      setInstalling(null);
    }
  }

  const installed = catalog?.agents.filter((agent) => agent.status === "installed" && LOGIN_VIEWS[agent.id]) ?? [];
  const q = query.trim().toLowerCase();
  const visibleAgents = (catalog?.agents ?? [])
    .filter((agent) => agent.id !== "gemini")
    .filter((agent) => !q || (agent.name + " " + (agent.description ?? "") + " " + agent.id).toLowerCase().includes(q))
    .sort((a, b) => agentRank(a) - agentRank(b) || (a.name ?? "").localeCompare(b.name ?? "", locale()));

  return (
    <section class="acp-page" data-req="FEAT-20.4">
      {error && <p class="acp-alert" role="alert">{error}</p>}
      {!catalog && !error && <p class="acp-card-meta">{t("acp.catalog.loading")}</p>}
      {catalog && !installed.length && (
        <div class="card acp-card">
          <p class="acp-card-meta">{t("acp.catalog.noneInstalled")}</p>
        </div>
      )}
      {installed.map((agent) => {
        const View = LOGIN_VIEWS[agent.id];
        return <View key={agent.id} agent={agent.id} version={agent.version} />;
      })}

      <div class="acp-catalog-head">
        <button type="button" class="btn" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {t("acp.catalog.toggle")}
        </button>
      </div>

      {expanded && (
        <div class="card acp-catalog-card">
          <div class="acp-catalog-toolbar">
            <input
              type="search"
              class="acp-catalog-search"
              placeholder={t("acp.catalog.search")}
              aria-label={t("acp.catalog.search")}
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <button type="button" class="btn" onClick={() => load(true)}>{t("acp.catalog.refresh")}</button>
          </div>
          {(catalog?.fetchedAt || catalog?.skipped > 0) && (
            <p class="acp-card-meta">
              {catalog?.fetchedAt ? t("acp.catalog.updatedOn", { date: new Date(catalog.fetchedAt).toLocaleDateString(locale()) }) : ""}
              {catalog?.fetchedAt && catalog?.skipped > 0 ? " · " : ""}
              {catalog?.skipped > 0 ? t("acp.catalog.skipped", { count: catalog.skipped }) : ""}
            </p>
          )}
          {selection && (
            <div class="acp-confirm" role="group" aria-label={t("acp.catalog.confirmGroup")}>
              <p>{t("acp.catalog.confirmText", { name: selection.name, version: selection.version })}</p>
              <div class="acp-actions">
                <button type="button" class="btn btn-primary" onClick={() => install(selection)}>{t("acp.catalog.confirmBtn")}</button>
                <button type="button" class="btn" onClick={() => setSelection(null)}>{t("acp.catalog.cancel")}</button>
              </div>
            </div>
          )}
          <div class="acp-catalog-list">
            {visibleAgents.length === 0 ? (
              <p class="acp-card-meta">{t("acp.catalog.empty")}</p>
            ) : (
              visibleAgents.map((agent) => (
                <div key={agent.id} class="acp-catalog-row">
                  <div class="acp-agent-info">
                    <span class="acp-agent-name">{agent.name}</span>
                    {agent.version && <span class="acp-agent-ver">· {agent.version}</span>}
                    <p class="acp-agent-desc">{[agent.description, agent.license].filter(Boolean).join(" · ")}</p>
                  </div>
                  {agent.status === "installed" ? (
                    <span class="acp-pill is-ok"><span aria-hidden="true">✓</span><span>{t("acp.catalog.installed")}</span></span>
                  ) : agent.installable ? (
                    <button type="button" class="btn" disabled={Boolean(installing)} onClick={() => setSelection(agent)}>
                      {installing === agent.id ? t("acp.catalog.installing") : t("acp.catalog.install")}
                    </button>
                  ) : (
                    <span class="acp-pill is-neutral">{t("acp.catalog.installUnavailable")}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}
