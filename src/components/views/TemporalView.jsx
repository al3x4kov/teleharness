// Temporal section. Routes:
//   #/temporal                       — runs          #/temporal/run/<workflowId> — one run
//   #/temporal/pipes                 — pipes         #/temporal/pipe/<id>, #/temporal/new[?template=]
//   #/temporal/start[/<id>][?v=N]    — start         #/temporal/schedules[/new?def=&v=]
//   #/temporal/triggers[/new|<id>]   — GitHub triggers
//   #/temporal/commands              — command catalog (admin)
//   #/temporal/external[/<id>]       — external Temporal workflows (admin)
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";
import { me } from "../../lib/store.js";
import { MenuButton } from "../Menu.jsx";
import "../../temporal.css";
import { temporalAttention } from "../../lib/temporal-attention.js";
import RunsList from "../temporal/RunsList.jsx";
import RunDetail from "../temporal/RunDetail.jsx";
import PipesList from "../temporal/PipesList.jsx";
import StartRun from "../temporal/StartRun.jsx";
import DefinitionEditor from "../temporal/DefinitionEditor.jsx";
import SchedulesList, { ScheduleForm } from "../temporal/Schedules.jsx";
import TriggersList from "../temporal/TriggersList.jsx";
import TriggerForm from "../temporal/TriggerForm.jsx";
import TriggerCard from "../temporal/TriggerCard.jsx";
import CommandsList from "../temporal/CommandsList.jsx";
import ExternalWorkflowsList from "../temporal/ExternalWorkflowsList.jsx";
import ExternalWorkflowDetail from "../temporal/ExternalWorkflowDetail.jsx";
import { Banner, Empty, Skeleton, errorText } from "../temporal/ui.jsx";
import { githubTriggers } from "../../lib/github-conn.js";

const BASE_TABS = [["runs", "#/temporal"], ["pipes", "#/temporal/pipes"], ["schedules", "#/temporal/schedules"], ["triggers", "#/temporal/triggers"]];
const TAB_OF = { runs: "runs", run: "runs", pipes: "pipes", pipe: "pipes", new: "pipes", start: "pipes", schedules: "schedules", triggers: "triggers", trigger: "triggers", commands: "commands", external: "external" };
const TITLES = new Set(["run", "pipe", "new", "start", "trigger"]);

function PipeEditor({ id, capabilities }) {
  const [record, setRecord] = useState(null), [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    setRecord(null);
    setError(null);
    api.temporalDefinition(id).then(
      (r) => { if (alive) setRecord(r); },
      (e) => { if (alive) setError(e); },
    );
    return () => { alive = false; };
  }, [id]);
  if (error) {
    return [403, 404].includes(error.status)
      ? <Empty icon="🔒" title={t("temporal.view.pipeGone")} actions={<a class="t-btn t-primary" href="#/temporal/pipes">{t("temporal.view.toPipes")}</a>}><p>{t("temporal.view.pipeGoneText")}</p></Empty>
      : <Empty icon="⚠" title={t("temporal.view.pipeError")} actions={<button class="t-btn t-primary" type="button" onClick={() => { setError(null); api.temporalDefinition(id).then(setRecord, setError); }}>{t("temporal.retry")}</button>}><p>{errorText(error)}</p></Empty>;
  }
  if (!record) return <Skeleton rows={3} />;
  return <DefinitionEditor key={id} record={record} engines={capabilities.engines} pipelineAvailable={capabilities.pipelineAvailable}
    schedulesAvailable={capabilities.schedulesAvailable} subscriptionModels={capabilities.subscriptionModels ?? {}} modelLabels={capabilities.modelLabels ?? {}}
    codexTextOnly={!!capabilities.codexTextOnly} ledger={capabilities.ledger ?? "postgres"} />;
}

export default function TemporalView({ section = "runs", id }) {
  const [capabilities, setCapabilities] = useState(null), [error, setError] = useState(null);
  const navRef = useRef(null);
  const load = () => { setError(null); api.temporalCapabilities().then(setCapabilities, setError); };
  useEffect(load, []);
  const isAdmin = me.value?.role === "admin";
  const tabs = isAdmin
    ? [...BASE_TABS, ["commands", "#/temporal/commands"], ["external", "#/temporal/external"]]
    : BASE_TABS;
  const tab = TAB_OF[section];
  const sub = TITLES.has(section)
    ? t("temporal.title." + section)
    : section === "schedules" && id === "new" ? t("temporal.title.newSchedule")
    : section === "triggers" && id ? (id === "new" ? t("temporal.title.newTrigger") : t("temporal.title.trigger"))
    : section === "external" && id ? t("temporal.title.external")
    : null;
  useEffect(() => {
    if (sub) return;
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [tab, sub]);
  const waiting = temporalAttention.value;
  let body;
  if (error) body = <Empty icon="⚠" title={t("temporal.view.down")} actions={<button class="t-btn t-primary" type="button" onClick={load}>{t("temporal.retry")}</button>}><p>{errorText(error)}</p></Empty>;
  else if (!capabilities) body = <Skeleton rows={4} />;
  else if (!tab) body = <Empty icon="?" title={t("temporal.view.notFound")} actions={<a class="t-btn t-primary" href="#/temporal">{t("temporal.view.toRuns")}</a>} />;
  else if (section === "runs") body = capabilities.runListAvailable ? <RunsList />
    : <Empty icon="⇄" title={t("temporal.view.runsOff")} actions={<a class="t-btn" href="#/temporal/pipes">{t("temporal.view.toPipes")}</a>}><p>{capabilities.execution?.reason ? `${String(capabilities.execution.reason).replace(/\.+$/, "")}. ` : ""}{t("temporal.view.runsOffText")}</p></Empty>;
  else if (section === "run") body = <RunDetail key={id} workflowId={id} modelLabels={capabilities.modelLabels ?? {}} />;
  else if (section === "pipes") body = <PipesList />;
  else if (section === "new") body = <DefinitionEditor engines={capabilities.engines} pipelineAvailable={capabilities.pipelineAvailable}
    schedulesAvailable={capabilities.schedulesAvailable} subscriptionModels={capabilities.subscriptionModels ?? {}} modelLabels={capabilities.modelLabels ?? {}}
    codexTextOnly={!!capabilities.codexTextOnly} ledger={capabilities.ledger ?? "postgres"} />;
  else if (section === "pipe") body = <PipeEditor id={id} capabilities={capabilities} />;
  else if (section === "start") body = <StartRun definitionId={id} capabilities={capabilities} />;
  else if (section === "schedules") body = id === "new" ? <ScheduleForm capabilities={capabilities} /> : <SchedulesList capabilities={capabilities} />;
  else if (section === "triggers") body = id === "new" ? <TriggerForm key={id} capabilities={capabilities} /> : id ? <TriggerCard key={id} id={id} capabilities={capabilities} /> : <TriggersList capabilities={capabilities} />;
  else if (section === "trigger") body = <TriggerCard key={id} id={id} capabilities={capabilities} />;
  else if (section === "commands") body = isAdmin ? <CommandsList />
    : <Empty icon="🔒" title={t("temporal.view.adminOnly")} actions={<a class="t-btn t-primary" href="#/temporal">{t("temporal.view.toRuns")}</a>}><p>{t("temporal.view.commandsAdminText")}</p></Empty>;
  else if (section === "external") body = isAdmin
    ? (id ? <ExternalWorkflowDetail key={id} workflowId={id} /> : <ExternalWorkflowsList />)
    : <Empty icon="🔒" title={t("temporal.view.adminOnly")} actions={<a class="t-btn t-primary" href="#/temporal">{t("temporal.view.toRuns")}</a>}><p>{t("temporal.view.externalAdminText")}</p></Empty>;
  const back = sub ? (section === "run" || (section === "start" && !id) ? "#/temporal" : section === "schedules" ? "#/temporal/schedules" : section === "triggers" || section === "trigger" ? "#/temporal/triggers" : section === "external" ? "#/temporal/external" : "#/temporal/pipes") : null;
  const bodyHasH1 = Boolean(
    !error && capabilities && tab
    && !(section === "runs" && !capabilities.runListAvailable)
    && !((section === "commands" || section === "external") && !isAdmin)
    && !(section === "triggers" && id)
    && section !== "trigger",
  );
  const crumbsContent = sub ? <><span class="t-hide-phone">Temporal · </span>{sub}</> : "Temporal";
  return (
    <div class="temporal-view">
      <header class="page-header t-top">
        {back ? <a class="t-iconbtn t-back" href={back} aria-label={t("temporal.back")}>←</a> : <MenuButton />}
        {bodyHasH1 ? <div class="t-crumbs">{crumbsContent}</div> : <h1 class="t-crumbs">{crumbsContent}</h1>}
      </header>
      {!sub && (
        <nav class="t-tabs" aria-label="Temporal" ref={navRef}>
          {tabs.map(([key, href]) => (
            <a key={key} href={href} aria-current={tab === key ? "page" : undefined}>
              {t("temporal.tab." + key)}{key === "runs" && waiting > 0 && <span class="t-count" aria-label={t("temporal.view.waitingAria", { count: waiting })}>{waiting}</span>}
              {key === "triggers" && githubTriggers.value.errors > 0 && <span class="t-count" aria-label={t("temporal.view.triggerErrorsAria", { count: githubTriggers.value.errors })}>{githubTriggers.value.errors}</span>}
            </a>
          ))}
        </nav>
      )}
      <div class="t-wrap">
        {capabilities?.socketPathError && (
          <Banner tone="warn" icon="⚠" title={t("temporal.view.socketErrTitle")}>
            {capabilities.socketPathError}
          </Banner>
        )}
        {body}
      </div>
    </div>
  );
}
