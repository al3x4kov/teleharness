// Desktop right panel (>= 1024px) for an open chat:
// search filter, MCP server statuses, clickable Skills (opens SkillModal),
// and the live current-turn Plan section when active.
import { useEffect, useState } from "preact/hooks";
import { t } from "../../lib/i18n.js";
import { mcpView } from "../../lib/mcp-status.js";
import {
  active,
  hydratePlanFromHistory,
  loadPlan,
  me,
  panelDirOf,
  panelMcp,
  panelMcpError,
  panelSkills,
  panelSkillsError,
  planOf,
  refreshPanelEnvironment,
  retryPanelMcp,
  retryPanelSkills,
  stopPanelEnvironment,
} from "../../lib/store.js";
import SkillModal from "./SkillModal.jsx";
import "../right-panel.css";

const VISIBLE = 5;

function stepLabel(status) {
  if (status === "completed") return t("rightPanel.stepCompleted");
  if (status === "in_progress") return t("rightPanel.stepInProgress");
  return t("rightPanel.stepPending");
}

export function filterPanelItems(query, mcpList, skillsList) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return { filtering: false, mcp: mcpList, skills: skillsList };
  const mcp = Array.isArray(mcpList)
    ? mcpList.filter((s) => {
        const name = String(s?.name ?? "").toLowerCase();
        const statusText = String(mcpView(s).text ?? "").toLowerCase();
        return name.includes(q) || statusText.includes(q);
      })
    : mcpList;
  const skills = Array.isArray(skillsList)
    ? skillsList.filter((s) => {
        const name = String(s?.name ?? "").toLowerCase();
        const id = String(s?.id ?? "").toLowerCase();
        const desc = String(s?.description ?? "").toLowerCase();
        return name.includes(q) || id.includes(q) || desc.includes(q);
      })
    : skillsList;
  return { filtering: true, mcp, skills };
}

function Section({ label, title, count, children }) {
  return (
    <section class="rp-section" aria-label={label}>
      <header class="rp-head">
        <h3 class="rp-h">{title}</h3>
        {count != null && <span class="rp-count">{count}</span>}
      </header>
      {children}
    </section>
  );
}

function SkeletonBody({ label }) {
  return (
    <div class="rp-skeleton" role="status">
      <span class="rp-sr">{label}</span>
      <span class="rp-sk-line" />
      <span class="rp-sk-line" />
      <span class="rp-sk-line" />
    </div>
  );
}

function ErrorBody({ onRetry }) {
  return (
    <div class="rp-error" role="status">
      <span class="rp-error-text">
        <span class="rp-error-x" aria-hidden="true">✕</span> {t("rightPanel.loadError")}
      </span>
      <button class="rp-retry" type="button" onClick={onRetry}>
        {t("rightPanel.retry")}
      </button>
    </div>
  );
}

function McpBody({ list, total, filtering, error, open, onToggle }) {
  if (error && (total === 0 || list == null)) return <ErrorBody onRetry={retryPanelMcp} />;
  if (list == null) return <SkeletonBody label={t("rightPanel.mcpLoading")} />;
  if (total === 0) return <div class="rp-empty">{t("rightPanel.mcpEmpty")}</div>;
  if (filtering && list.length === 0) return <div class="rp-empty">{t("rightPanel.noMatches")}</div>;
  const rows = filtering || open ? list : list.slice(0, VISIBLE);
  return (
    <>
      <div class="rp-rows">
        {rows.map((s) => {
          const v = mcpView(s);
          const pending = s.status === "pending";
          return (
            <div class="rp-row rp-mcp" key={s.name} title={v.why ?? undefined}>
              <span class={"rp-dot dot-" + (pending ? "pending" : v.tone)} aria-hidden="true" />
              <span class="rp-name">{s.name}</span>
              <span class={"rp-word" + (v.tone === "bad" ? " w-bad" : v.tone === "warn" ? " w-warn" : "")}>{v.text}</span>
            </div>
          );
        })}
      </div>
      {!filtering && list.length > VISIBLE && (
        <button class="rp-more" type="button" aria-expanded={open} onClick={onToggle}>
          {open ? t("rightPanel.collapse") : t("rightPanel.showAll", { n: list.length })}
        </button>
      )}
    </>
  );
}

function SkillsBody({ list, total, filtering, error, open, onToggle, onSelect }) {
  if (error && (total === 0 || list == null)) return <ErrorBody onRetry={retryPanelSkills} />;
  if (list == null) return <SkeletonBody label={t("rightPanel.skillsLoading")} />;
  if (total === 0) return <div class="rp-empty">{t("rightPanel.skillsEmpty")}</div>;
  if (filtering && list.length === 0) return <div class="rp-empty">{t("rightPanel.noMatches")}</div>;
  const rows = filtering || open ? list : list.slice(0, VISIBLE);
  return (
    <>
      <div class="rp-rows rp-skill-rows">
        {rows.map((s) => (
          <button
            class="rp-skill"
            type="button"
            key={s.id || s.name}
            title={s.description || s.name || s.id}
            onClick={() => onSelect(s)}
          >
            <span class="rp-name">{s.name || s.id}</span>
            {s.description && <span class="rp-desc">{s.description}</span>}
          </button>
        ))}
      </div>
      {!filtering && list.length > VISIBLE && (
        <button class="rp-more" type="button" aria-expanded={open} onClick={onToggle}>
          {open ? t("rightPanel.collapse") : t("rightPanel.showAll", { n: list.length })}
        </button>
      )}
    </>
  );
}

export default function RightPanel({ id }) {
  const [mcpOpen, setMcpOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedSkill, setSelectedSkill] = useState(null);

  const dir = panelDirOf(id);
  const isAdmin = me.value?.role === "admin";
  const msgCount = active.value?.id === id && Array.isArray(active.value.messages) ? active.value.messages.length : 0;

  useEffect(() => {
    setQuery("");
    setSelectedSkill(null);
  }, [id]);

  useEffect(() => {
    refreshPanelEnvironment(dir);
    return () => stopPanelEnvironment();
  }, [id, dir]);

  useEffect(() => {
    loadPlan(id);
  }, [id]);

  useEffect(() => {
    if (isAdmin && msgCount > 0) hydratePlanFromHistory(id);
  }, [id, isAdmin, msgCount]);

  const rawMcp = panelMcp.value;
  const rawSkills = panelSkills.value;
  const { filtering, mcp: filteredMcp, skills: filteredSkills } = filterPanelItems(query, rawMcp, rawSkills);
  const mcpTotal = Array.isArray(rawMcp) ? rawMcp.length : 0;
  const skillsTotal = Array.isArray(rawSkills) ? rawSkills.length : 0;

  const plan = planOf(id);
  const planShown = Array.isArray(plan) && plan.length > 0;
  const done = planShown ? plan.filter((item) => item.status === "completed").length : 0;

  return (
    <>
      <aside class="right-panel" aria-label={planShown ? t("rightPanel.ariaWithPlan") : t("rightPanel.ariaBase")}>
        <div class="rp-search">
          <input
            class="rp-search-input"
            type="search"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder={t("rightPanel.searchPlaceholder")}
            aria-label={t("rightPanel.searchAria")}
          />
          {query && (
            <button
              class="rp-search-clear"
              type="button"
              aria-label={t("rightPanel.searchClear")}
              onClick={() => setQuery("")}
            >
              ×
            </button>
          )}
        </div>
        <Section
          label={t("rightPanel.mcpLabel")}
          title={t("rightPanel.mcpTitle")}
          count={filtering && mcpTotal > 0 ? `${filteredMcp.length}/${mcpTotal}` : null}
        >
          <McpBody
            list={filteredMcp}
            total={mcpTotal}
            filtering={filtering}
            error={panelMcpError.value}
            open={mcpOpen}
            onToggle={() => setMcpOpen(!mcpOpen)}
          />
        </Section>
        <Section
          label={t("rightPanel.skillsLabel")}
          title={t("rightPanel.skillsTitle")}
          count={filtering && skillsTotal > 0 ? `${filteredSkills.length}/${skillsTotal}` : null}
        >
          <SkillsBody
            list={filteredSkills}
            total={skillsTotal}
            filtering={filtering}
            error={panelSkillsError.value}
            open={skillsOpen}
            onToggle={() => setSkillsOpen(!skillsOpen)}
            onSelect={(s) => setSelectedSkill(s)}
          />
        </Section>
        {planShown && (
          <Section label={t("rightPanel.planLabel")} title={t("rightPanel.planTitle")} count={`${done}/${plan.length}`}>
            <ol class="rp-plan">
              {plan.map((item, i) => (
                <li key={item.id ?? `${i}:${item.content}`} class={"rp-step st-" + item.status} aria-label={stepLabel(item.status)}>
                  <span class="rp-step-dot" aria-hidden="true">
                    {item.status === "completed" ? "✓" : null}
                  </span>
                  <span class="rp-step-text">{item.content}</span>
                </li>
              ))}
            </ol>
            <p class="rp-plan-hint">{t("rightPanel.planHint")}</p>
          </Section>
        )}
      </aside>
      {selectedSkill && (
        <SkillModal skill={selectedSkill} directory={dir} onClose={() => setSelectedSkill(null)} />
      )}
    </>
  );
}
