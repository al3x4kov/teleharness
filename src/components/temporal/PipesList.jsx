// FEAT-19.14: pipes — version state, last run, one-tap start; templates when empty.
import { useEffect, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";
import { navigate } from "../../lib/router.js";
import { projectDisplayName } from "../../lib/normalize.js";
import { Empty, Skeleton, StatusPill, errorText } from "./ui.jsx";

// Templates use only steps the executor runs today (no inputs, no conditions).
export const TEMPLATES = [
// Names and texts are getters — they follow the UI language at the moment of use.
  { id: "review", icon: "◆", get name() { return t("temporal.tpl.review.name"); }, get text() { return t("temporal.tpl.review.text"); },
    get steps() { return [{ id: "prepare", type: "timer", name: t("temporal.tpl.review.prepare"), seconds: 60 }, { id: "approve", type: "approval", name: t("temporal.tpl.review.approve") }, { id: "finish", type: "timer", name: t("temporal.tpl.review.finish"), seconds: 10 }]; } },
  { id: "remind", icon: "⏱", get name() { return t("temporal.tpl.remind.name"); }, get text() { return t("temporal.tpl.remind.text"); },
    get steps() { return [{ id: "wait", type: "timer", name: t("temporal.tpl.remind.wait"), seconds: 300 }, { id: "ask", type: "approval", name: t("temporal.tpl.remind.ask") }]; } },
  { id: "blank", icon: "＋", get name() { return t("temporal.tpl.blank.name"); }, get text() { return t("temporal.tpl.blank.text"); }, steps: [] },
];

export default function PipesList() {
  const [pipes, setPipes] = useState(null), [runs, setRuns] = useState([]), [error, setError] = useState(null);
  async function load() {
    try {
      setPipes(await api.temporalDefinitions()); setError(null);
      api.temporalRuns().then(setRuns, () => {});
    } catch (e) { setError(e); }
  }
  useEffect(() => { load(); }, []);
  const head = (
    <div class="t-head">
      <div><h1>{t("temporal.pipes.title")}</h1><p class="t-lead">{t("temporal.pipes.lead")}</p></div>
      <button class="t-btn t-primary" type="button" onClick={() => navigate("/temporal/new")}>{t("temporal.pipes.new")}</button>
    </div>
  );
  if (!pipes && error) return <>{head}<Empty icon="⚠" title={t("temporal.pipes.loadError")} actions={<button class="t-btn t-primary" type="button" onClick={load}>{t("temporal.retry")}</button>}><p>{errorText(error)}</p></Empty></>;
  if (!pipes) return <>{head}<Skeleton rows={3} /></>;
  if (!pipes.length) {
    return (
      <>{head}
        <Empty title={t("temporal.pipes.empty")}><p>{t("temporal.pipes.emptyText")}</p></Empty>
        <div class="t-tiles">{TEMPLATES.map((tpl) => (
          <button key={tpl.id} class="t-tile" type="button" onClick={() => navigate("/temporal/new?template=" + tpl.id)}>
            <span class="t-typeic" aria-hidden="true">{tpl.icon}</span><span><b>{tpl.name}</b><small>{tpl.text}</small></span>
          </button>))}</div>
      </>
    );
  }
  return (
    <>{head}
      <div class="t-pipes">{pipes.map((p) => {
        const last = runs.find((r) => r.definitionId === p.id);
        const latest = p.latestVersion ?? p.versions?.at(-1)?.version ?? null;
        return (
          <article class="t-card t-pipe" key={p.id}>
            <div class="t-row t-between">
              <h3><a href={"#/temporal/pipe/" + encodeURIComponent(p.id)}>{p.name || t("temporal.untitled")}</a></h3>
              <span class={"t-pill " + (latest ? "t-ok" : "t-off")}>{latest ? t("temporal.pipes.version", { n: latest }) : t("temporal.pipes.draft")}</span>
            </div>
            <p class="t-meta">{t("temporal.pipes.project", { name: projectDisplayName(p.directory) })}</p>
            <p class="t-meta">{last?.summary ? <>{t("temporal.pipes.lastRun")} <StatusPill kind={last.summary.kind} /></> : latest ? t("temporal.pipes.neverRun") : t("temporal.pipes.publishToRun")}</p>
            <div class="t-row">
              <button class="t-btn t-primary" type="button" disabled={!latest} title={latest ? undefined : t("temporal.pipes.publishFirst")}
                onClick={() => navigate("/temporal/start/" + encodeURIComponent(p.id))}>{t("temporal.pipes.run")}</button>
              <a class="t-btn" href={"#/temporal/pipe/" + encodeURIComponent(p.id)}>{t("temporal.pipes.open")}</a>
            </div>
          </article>
        );
      })}</div>
    </>
  );
}
