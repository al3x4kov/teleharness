// FEAT-19.14: start a published version. The request id lives for the whole
// form, so a repeated tap (or a retry after a network error) opens the same
// run instead of creating a second one.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";
import { navigate } from "../../lib/router.js";
import { Banner, Empty, Skeleton, errorText, hashQuery } from "./ui.jsx";
import { unsupportedReasons } from "./readiness.js";
import { runHref } from "./RunsList.jsx";

export default function StartRun({ definitionId, capabilities, initialVersion = Number(hashQuery().get("v")) || null }) {
  const [pipes, setPipes] = useState(null), [record, setRecord] = useState(null), [error, setError] = useState(null);
  const [pick, setPick] = useState(definitionId ?? ""), [version, setVersion] = useState(initialVersion);
  const [busy, setBusy] = useState(false), [startError, setStartError] = useState(""), [done, setDone] = useState(null);
  const [values, setValues] = useState({}), [tried, setTried] = useState(false); // FEAT-19.16: run inputs
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => { api.temporalDefinitions().then(setPipes, setError); }, []);
  useEffect(() => {
    if (!pick) { setRecord(null); return; }
    setRecord(null);
    api.temporalDefinition(pick).then((r) => { setRecord(r); setVersion((v) => (r.versions.some((x) => x.version === v) ? v : r.versions.at(-1)?.version ?? null)); }, setError);
  }, [pick]);
  useEffect(() => { requestId.current = crypto.randomUUID(); setStartError(""); }, [pick, version]);

  if (error) return <Empty icon="⚠" title={t("temporal.pipes.loadError")} actions={<a class="t-btn" href="#/temporal/pipes">{t("temporal.view.toPipes")}</a>}><p>{errorText(error)}</p></Empty>;
  if (!pipes) return <Skeleton rows={2} />;
  const published = pipes.filter((p) => p.latestVersion || p.versions?.length);
  if (!published.length) {
    return <Empty icon="▶" title={t("temporal.start.nothing")} actions={<a class="t-btn t-primary" href="#/temporal/pipes">{t("temporal.view.toPipes")}</a>}>
      <p>{t("temporal.start.nothingText")}</p></Empty>;
  }
  if (done) {
    return <Empty icon="✓" title={t("temporal.start.accepted")} actions={<>
      <a class="t-btn t-primary" href={runHref(done.workflowId)}>{t("temporal.start.openRun")}</a><a class="t-btn" href="#/temporal">{t("temporal.start.toList")}</a></>}>
      <p>{t("temporal.start.acceptedText", { name: record?.draft?.name ?? record?.versions?.at(-1)?.definition?.name, version: done.version })}</p></Empty>;
  }
  const v = record?.versions.find((x) => x.version === version);
  const reasons = v ? unsupportedReasons(v.definition, capabilities?.subscriptionModels, { ledger: capabilities?.ledger }) : [];
  const declared = v?.definition.inputs ?? [];
  const missing = declared.filter((i) => i.required && i.type !== "boolean" && !String(values[i.name] ?? "").trim());
  const setValue = (name, value) => { setValues((x) => ({ ...x, [name]: value })); requestId.current = crypto.randomUUID(); };
  async function start() {
    setBusy(true); setStartError("");
    setTried(true);
    if (missing.length) { setBusy(false); return; }
    const inputs = Object.fromEntries((v.definition.inputs ?? []).filter((i) => values[i.name] !== undefined && values[i.name] !== "").map((i) => [i.name, values[i.name]]));
    try { setDone(await api.temporalStart({ definitionId: record.id, version, requestId: requestId.current, ...(Object.keys(inputs).length ? { inputs } : {}) })); }
    catch (e) { setStartError(errorText(e)); }
    finally { setBusy(false); }
  }
  return (
    <>
      <div class="t-head"><div><h1>{t("temporal.start.title")}</h1><p class="t-lead">{t("temporal.start.lead")}</p></div></div>
      <div class="t-card t-form">
        <label class="t-field"><span>{t("temporal.field.pipe")}</span>
          <select class="t-input" aria-label={t("temporal.field.pipe")} value={pick} onChange={(e) => setPick(e.currentTarget.value)}>
            <option value="" disabled>{t("temporal.field.choosePipe")}</option>
            {published.map((p) => <option key={p.id} value={p.id} selected={p.id === pick}>{p.name}</option>)}
          </select></label>
        {record && <label class="t-field"><span>{t("temporal.field.version")}</span>
          <select class="t-input" aria-label={t("temporal.field.version")} value={version ?? ""} onChange={(e) => setVersion(Number(e.currentTarget.value))}>
            {record.versions.slice().reverse().map((x, i) => <option key={x.version} value={x.version} selected={x.version === version}>{t("temporal.field.versionOpt", { n: x.version })}{i === 0 ? t("temporal.field.latest") : ""}</option>)}
          </select>
          {v && <span class="t-help">{t("temporal.start.steps", { count: v.definition.steps.length, list: v.definition.steps.map((s) => s.name).join(" → ") })}</span>}</label>}
        {declared.map((i) => (
          <label key={i.name} class="t-field"><span>{i.name}{i.required && i.type !== "boolean" ? <span class="t-muted">{t("temporal.start.required")}</span> : null}</span>
            {i.type === "boolean"
              ? <span class="t-check"><input type="checkbox" aria-label={i.name} checked={values[i.name] === true} onChange={(e) => setValue(i.name, e.currentTarget.checked)} /> {t("temporal.start.yes")}</span>
              : i.type === "array" || i.type === "string"
                ? <textarea class={"t-input" + (tried && missing.includes(i) ? " is-bad" : "")} rows={i.type === "array" ? 4 : 3} aria-label={i.name}
                    placeholder={i.type === "array" ? t("temporal.start.onePerLine") : ""} value={values[i.name] ?? ""} onInput={(e) => setValue(i.name, e.currentTarget.value)} />
                : <input class={"t-input" + (tried && missing.includes(i) ? " is-bad" : "")} inputMode="decimal" aria-label={i.name} value={values[i.name] ?? ""} onInput={(e) => setValue(i.name, e.currentTarget.value)} />}
            {tried && missing.includes(i) && <span class="t-err-text">{t("temporal.start.fill", { name: i.name })}</span>}
          </label>
        ))}
        {reasons.length > 0 && <Banner tone="warn" icon="⚠" title={t("temporal.start.cannot")}>
          <ul>{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          <a href={"#/temporal/pipe/" + encodeURIComponent(record.id)}>{t("temporal.start.openFix")}</a></Banner>}
        {startError && <Banner tone="err" icon="✕" title={t("temporal.start.notAccepted")}>{startError} {t("temporal.start.tryAgain")}</Banner>}
        <button class="t-btn t-primary t-block" type="button" data-action="start" disabled={!v || busy || reasons.length > 0 || !capabilities?.pipelineAvailable} onClick={start}>
          {busy ? t("temporal.start.sending") : startError ? t("temporal.start.retry") : version ? t("temporal.start.runVersion", { n: version }) : t("temporal.pipes.run")}</button>
        {!capabilities?.pipelineAvailable && <p class="t-help">{t("temporal.notConnected")}</p>}
        {v && !v.definition.steps.some((s) => s.type === "model") && <p class="t-help">{t("temporal.start.noModel")}</p>}
        {v && v.definition.steps.some((s) => s.type === "model") && <p class="t-help">{t("temporal.start.model")}</p>}
      </div>
      <p><button class="t-btn t-ghost" type="button" onClick={() => navigate("/temporal/pipes")}>{t("temporal.start.backToPipes")}</button></p>
    </>
  );
}
