// FEAT-19.14 (was FEAT-19.1): Temporal section v2. Routes:
//   #/temporal                 — runs          #/temporal/run/<workflowId> — one run
//   #/temporal/pipes           — pipes         #/temporal/pipe/<id>, #/temporal/new[?template=]
//   #/temporal/start[/<id>][?v=N] — start      #/temporal/schedules[/new?def=&v=]
import { useEffect, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";
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
import { Empty, Skeleton, errorText } from "../temporal/ui.jsx";
import { githubTriggers } from "../../lib/github-conn.js";

const TABS = [["runs", "#/temporal"], ["pipes", "#/temporal/pipes"], ["schedules", "#/temporal/schedules"], ["triggers", "#/temporal/triggers"]];
const TAB_OF = { runs: "runs", run: "runs", pipes: "pipes", pipe: "pipes", new: "pipes", start: "pipes", schedules: "schedules", triggers: "triggers", trigger: "triggers" };
const TITLES = new Set(["run", "pipe", "new", "start", "trigger"]);

function PipeEditor({ id, capabilities }) {
  const [record, setRecord] = useState(null), [error, setError] = useState(null);
  useEffect(() => { api.temporalDefinition(id).then(setRecord, setError); }, [id]);
  if (error) {
    return [403, 404].includes(error.status)
      ? <Empty icon="🔒" title={t("temporal.view.pipeGone")} actions={<a class="t-btn t-primary" href="#/temporal/pipes">{t("temporal.view.toPipes")}</a>}><p>{t("temporal.view.pipeGoneText")}</p></Empty>
      : <Empty icon="⚠" title={t("temporal.view.pipeError")} actions={<button class="t-btn t-primary" type="button" onClick={() => { setError(null); api.temporalDefinition(id).then(setRecord, setError); }}>{t("temporal.retry")}</button>}><p>{errorText(error)}</p></Empty>;
  }
  if (!record) return <Skeleton rows={3} />;
  return <DefinitionEditor key={id} record={record} engines={capabilities.engines} pipelineAvailable={capabilities.pipelineAvailable}
    schedulesAvailable={capabilities.schedulesAvailable} subscriptionModels={capabilities.subscriptionModels ?? {}} modelLabels={capabilities.modelLabels ?? {}} codexTextOnly={!!capabilities.codexTextOnly} />;
}

export default function TemporalView({ section = "runs", id }) {
  const [capabilities, setCapabilities] = useState(null), [error, setError] = useState(null);
  const load = () => { setError(null); api.temporalCapabilities().then(setCapabilities, setError); };
  useEffect(load, []);
  const tab = TAB_OF[section];
  const sub = TITLES.has(section) ? t("temporal.title." + section) : section === "schedules" && id === "new" ? t("temporal.title.newSchedule") : section === "triggers" && id ? (id === "new" ? t("temporal.title.newTrigger") : t("temporal.title.trigger")) : null;
  const waiting = temporalAttention.value;
  let body;
  if (error) body = <Empty icon="⚠" title={t("temporal.view.down")} actions={<button class="t-btn t-primary" type="button" onClick={load}>{t("temporal.retry")}</button>}><p>{errorText(error)}</p></Empty>;
  else if (!capabilities) body = <Skeleton rows={4} />;
  else if (!tab) body = <Empty icon="?" title={t("temporal.view.notFound")} actions={<a class="t-btn t-primary" href="#/temporal">{t("temporal.view.toRuns")}</a>} />;
  else if (section === "runs") body = capabilities.runListAvailable ? <RunsList />
    : <Empty icon="⇄" title={t("temporal.view.runsOff")} actions={<a class="t-btn" href="#/temporal/pipes">{t("temporal.view.toPipes")}</a>}><p>{capabilities.execution?.reason} {t("temporal.view.runsOffText")}</p></Empty>;
  else if (section === "run") body = <RunDetail key={id} workflowId={id} modelLabels={capabilities.modelLabels ?? {}} />;
  else if (section === "pipes") body = <PipesList />;
  else if (section === "new") body = <DefinitionEditor engines={capabilities.engines} pipelineAvailable={capabilities.pipelineAvailable}
    schedulesAvailable={capabilities.schedulesAvailable} subscriptionModels={capabilities.subscriptionModels ?? {}} modelLabels={capabilities.modelLabels ?? {}} codexTextOnly={!!capabilities.codexTextOnly} />;
  else if (section === "pipe") body = <PipeEditor id={id} capabilities={capabilities} />;
  else if (section === "start") body = <StartRun definitionId={id} capabilities={capabilities} />;
  else if (section === "schedules") body = id === "new" ? <ScheduleForm capabilities={capabilities} /> : <SchedulesList capabilities={capabilities} />;
  else if (section === "triggers") body = id === "new" ? <TriggerForm key={id} capabilities={capabilities} /> : id ? <TriggerCard key={id} id={id} capabilities={capabilities} /> : <TriggersList capabilities={capabilities} />;
  else if (section === "trigger") body = <TriggerCard key={id} id={id} capabilities={capabilities} />;
  const back = sub ? (section === "run" || (section === "start" && !id) ? "#/temporal" : section === "schedules" ? "#/temporal/schedules" : section === "triggers" || section === "trigger" ? "#/temporal/triggers" : "#/temporal/pipes") : null;
  return (
    <div class="temporal-view"> {/* BUG-255: no nested .view — its overscroll-behavior:contain swallowed the scroll of main.view */}
      <header class="page-header t-top">
        {back ? <a class="t-iconbtn t-back" href={back} aria-label={t("temporal.back")}>←</a> : <MenuButton />}
        <h1 class="t-crumbs">{sub ? <><span class="t-hide-phone">Temporal · </span>{sub}</> : "Temporal"}</h1>
      </header>
      {!sub && (
        <nav class="t-tabs" aria-label="Temporal">
          {TABS.map(([key, href]) => (
            <a key={key} href={href} aria-current={tab === key ? "page" : undefined}>
              {t("temporal.tab." + key)}{key === "runs" && waiting > 0 && <span class="t-count" aria-label={t("temporal.view.waitingAria", { count: waiting })}>{waiting}</span>}
              {key === "triggers" && githubTriggers.value.errors > 0 && <span class="t-count" aria-label={t("temporal.view.triggerErrorsAria", { count: githubTriggers.value.errors })}>{githubTriggers.value.errors}</span>}
            </a>
          ))}
        </nav>
      )}
      <div class="t-wrap">{body}</div>
    </div>
  );
}
