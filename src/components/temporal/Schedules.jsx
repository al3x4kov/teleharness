// FEAT-19.14 (was FEAT-19.7): schedules in words — presets instead of raw
// cron, a time zone by city, next runs shown BEFORE creating, blocked ones
// explained. The chosen publication stays fixed throughout creation.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { t, locale } from "../../lib/i18n.js";
import { navigate } from "../../lib/router.js";
import { Banner, Empty, Sheet, Skeleton, StatusPill, errorText, hashQuery } from "./ui.jsx";
import { unsupportedReasons } from "./readiness.js";

// Labels are resolved at render time so they follow the UI language.
const OVERLAP = { skip: "temporal.sch.overlap.skip", "buffer-one": "temporal.sch.overlap.buffer" };
const CATCHUP = [[3600, "temporal.sch.catchup.hour"], [86400, "temporal.sch.catchup.day"], [60, "temporal.sch.catchup.skip"]];
const PRESETS = ["hourly", "daily", "weekdays", "cron"];
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const zones = () => { try { return Intl.supportedValuesOf("timeZone"); } catch { return ["UTC", "Europe/Moscow"]; } };
export function validZone(z) { try { new Intl.DateTimeFormat("en", { timeZone: z }); return /^[A-Za-z]/.test(z); } catch { return false; } }

export function toCron(preset, time, minute, cron) {
  const [h, m] = String(time).split(":").map(Number);
  if (preset === "hourly") return `${Number(minute) || 0} * * * *`;
  if (preset === "daily") return `${m} ${h} * * *`;
  if (preset === "weekdays") return `${m} ${h} * * 1-5`;
  return cron.trim();
}
export function describeCron(cron) {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [m, h, dom, mon, dow] = p;
  const hhmm = /^\d+$/.test(h) && /^\d+$/.test(m) ? `${h.padStart(2, "0")}:${m.padStart(2, "0")}` : null;
  if (h === "*" && dom === "*" && mon === "*" && dow === "*" && /^\d+$/.test(m)) return t("temporal.sch.desc.hourly", { m: m.padStart(2, "0") });
  if (hhmm && dom === "*" && mon === "*" && dow === "*") return t("temporal.sch.desc.daily", { time: hhmm });
  if (hhmm && dom === "*" && mon === "*" && dow === "1-5") return t("temporal.sch.desc.weekdays", { time: hhmm });
  return "cron " + cron;
}
// Next n local times for the presets (custom cron: the server tells after creation).
function zonedParts(date, zone) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  return Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
}
export function previewTimes(preset, time, minute, zone, n = 3, from = Date.now()) {
  if (preset === "cron" || !validZone(zone)) return null;
  const [h, m] = String(time).split(":").map(Number);
  const out = [];
  let t = Math.ceil(from / 60000) * 60000;
  for (let i = 0; i < 60 * 24 * 9 && out.length < n; i++, t += 60000) {
    const p = zonedParts(new Date(t), zone);
    const hh = Number(p.hour), mm = Number(p.minute);
    const ok = preset === "hourly" ? mm === (Number(minute) || 0)
      : hh === h && mm === m && (preset === "daily" || !["Sat", "Sun"].includes(p.weekday));
    if (ok) out.push(new Date(t));
  }
  return out;
}

export function ScheduleForm({ capabilities }) {
  const q = hashQuery();
  const [pipes, setPipes] = useState(null), [record, setRecord] = useState(null), [error, setError] = useState(null);
  const [commands, setCommands] = useState(null);
  const [pick, setPick] = useState(q.get("def") ?? ""), [version, setVersion] = useState(Number(q.get("v")) || null);
  const [preset, setPreset] = useState("daily"), [time, setTime] = useState("09:00"), [minute, setMinute] = useState("0"), [cron, setCron] = useState("0 9 * * *");
  const [zone, setZone] = useState(localZone()), [overlap, setOverlap] = useState("skip"), [catchup, setCatchup] = useState(3600);
  const [busy, setBusy] = useState(false), [serverError, setServerError] = useState(""), [tried, setTried] = useState(false);
  const requestId = useRef("");
  useEffect(() => {
    api.temporalDefinitions().then(setPipes, setError);
    api.temporalCommands?.().then((r) => setCommands(r?.items ?? []), () => setCommands(null));
  }, []);
  useEffect(() => {
    if (!pick) { setRecord(null); return undefined; }
    let alive = true;
    setRecord(null);
    api.temporalDefinition(pick).then(
      (r) => {
        if (!alive) return;
        setRecord(r);
        setVersion((v) => (r.versions.some((x) => x.version === v) ? v : r.versions.at(-1)?.version ?? null));
      },
      (e) => { if (alive) setError(e); },
    );
    return () => { alive = false; };
  }, [pick]);
  useEffect(() => { requestId.current = ""; setServerError(""); }, [pick, version, preset, time, minute, cron, zone, overlap, catchup]);
  const head = <div class="t-head"><div><h1>{t("temporal.sch.newTitle")}</h1><p class="t-lead">{t("temporal.sch.newLead")}</p></div></div>;
  if (error) return <>{head}<Empty icon="⚠" title={t("temporal.pipes.loadError")} actions={<a class="t-btn" href="#/temporal/schedules">{t("temporal.sch.toSchedules")}</a>}><p>{errorText(error)}</p></Empty></>;
  if (!pipes) return <>{head}<Skeleton rows={2} /></>;
  const published = pipes.filter((p) => p.latestVersion);
  if (!published.length) return <>{head}<Empty icon="⏱" title={t("temporal.sch.publishFirst")} actions={<a class="t-btn t-primary" href="#/temporal/pipes">{t("temporal.view.toPipes")}</a>}><p>{t("temporal.sch.publishFirstText")}</p></Empty></>;
  const timeOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const minuteOk = /^([0-5]?\d)$/.test(minute);
  const cronOk = preset !== "cron" || /^\S+(\s+\S+){4}$/.test(cron.trim());
  const zoneOk = validZone(zone);
  const v = record?.versions.find((x) => x.version === version);
  const reasons = v ? unsupportedReasons(v.definition, capabilities?.subscriptionModels, { ledger: capabilities?.ledger, ...(commands != null ? { commands } : {}) }) : [];
  // BUG-258: say exactly why — required inputs block a schedule before any click; «fix the
  // marked fields» only when a field is really marked.
  const required = (v?.definition.inputs ?? []).filter((i) => i.required);
  const fieldsOk = zoneOk && cronOk && (preset === "hourly" ? minuteOk : preset === "cron" || timeOk);
  const valid = v && reasons.length === 0 && required.length === 0 && fieldsOk;
  const preview = valid ? previewTimes(preset, time, minute, zone) : null;
  const fmt = new Intl.DateTimeFormat(locale(), { timeZone: zoneOk ? zone : "UTC", weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  async function create() {
    setTried(true);
    if (!valid) return;
    setBusy(true); requestId.current ||= crypto.randomUUID();
    try {
      await api.temporalCreateSchedule({ definitionId: record.id, version, cron: toCron(preset, time, minute, cron), timezone: zone, overlap, catchupSeconds: catchup, requestId: requestId.current });
      navigate("/temporal/schedules");
    } catch (e) { setServerError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <>
      {head}
      <div class="t-card t-form">
        <label class="t-field"><span>{t("temporal.field.pipe")}</span>
          <select class="t-input" aria-label={t("temporal.field.pipe")} value={pick} onChange={(e) => setPick(e.currentTarget.value)}>
            <option value="" disabled>{t("temporal.field.choosePipe")}</option>{published.map((p) => <option key={p.id} value={p.id} selected={p.id === pick}>{p.name}</option>)}</select></label>
        {record && <label class="t-field"><span>{t("temporal.field.version")}</span>
          <select class="t-input" aria-label={t("temporal.field.version")} value={version ?? ""} onChange={(e) => setVersion(Number(e.currentTarget.value))}>
            {record.versions.slice().reverse().map((x, i) => <option key={x.version} value={x.version} selected={x.version === version}>{t("temporal.field.versionOpt", { n: x.version })}{i === 0 ? t("temporal.field.latest") : ""}</option>)}</select>
          <span class="t-help">{t("temporal.sch.pinned")}</span></label>}
        {required.length > 0 && <Banner tone="warn" icon="⚠" title={t("temporal.sch.cannotSchedule")}>
          {t("temporal.sch.requiredText", { list: required.map((i) => t("temporal.quote", { text: i.name })).join(", ") })}</Banner>}
        {reasons.length > 0 && <Banner tone="warn" icon="⚠" title={t("temporal.sch.cannotRun")}><ul>{reasons.map((r) => <li key={r}>{r}</li>)}</ul></Banner>}
        <div class="t-field"><span id="t-freq">{t("temporal.sch.howOften")}</span>
          <div class="t-seg" role="radiogroup" aria-labelledby="t-freq">{PRESETS.map((id) =>
            <button key={id} type="button" role="radio" aria-checked={preset === id} class={preset === id ? "is-on" : ""} onClick={() => setPreset(id)}>{t("temporal.sch.preset." + id)}</button>)}</div></div>
        <div class="t-row t-top">
          {preset === "hourly" && <label class="t-field t-grow"><span>{t("temporal.sch.minute")}</span>
            <input class={"t-input" + (tried && !minuteOk ? " is-bad" : "")} inputMode="numeric" aria-label={t("temporal.sch.minute")} value={minute} onInput={(e) => setMinute(e.currentTarget.value)} />
            {tried && !minuteOk && <span class="t-err-text">{t("temporal.sch.minuteErr")}</span>}</label>}
          {(preset === "daily" || preset === "weekdays") && <label class="t-field t-grow"><span>{t("temporal.sch.time")}</span>
            <input class={"t-input" + (tried && !timeOk ? " is-bad" : "")} type="time" aria-label={t("temporal.sch.time")} value={time} onInput={(e) => setTime(e.currentTarget.value)} />
            {tried && !timeOk && <span class="t-err-text">{t("temporal.sch.timeErr")}</span>}</label>}
          {preset === "cron" && <label class="t-field t-grow"><span>{t("temporal.sch.cronLabel")}</span>
            <input class={"t-input t-mono" + (tried && !cronOk ? " is-bad" : "")} aria-label="Cron" value={cron} onInput={(e) => setCron(e.currentTarget.value)} />
            {tried && !cronOk && <span class="t-err-text">{t("temporal.sch.cronErr")}</span>}</label>}
          <label class="t-field t-grow2"><span>{t("temporal.sch.zone")}</span>
            <input class={"t-input" + (tried && !zoneOk ? " is-bad" : "")} list="t-zones" aria-label={t("temporal.sch.zone")} value={zone} onInput={(e) => setZone(e.currentTarget.value.trim())} />
            <datalist id="t-zones">{zones().map((z) => <option key={z} value={z} />)}</datalist>
            {tried && !zoneOk ? <span class="t-err-text">{t("temporal.sch.zoneErr")}</span> : <span class="t-help">{t("temporal.sch.yourZone", { zone: localZone() })}</span>}</label>
        </div>
        <label class="t-field"><span>{t("temporal.sch.overlapLabel")}</span>
          <select class="t-input" aria-label={t("temporal.sch.overlapLabel")} value={overlap} onChange={(e) => setOverlap(e.currentTarget.value)}>
            {Object.entries(OVERLAP).map(([k, key]) => <option key={k} value={k}>{t(key)}</option>)}</select></label>
        <label class="t-field"><span>{t("temporal.sch.catchupLabel")}</span>
          <select class="t-input" aria-label={t("temporal.sch.catchupAria")} value={catchup} onChange={(e) => setCatchup(Number(e.currentTarget.value))}>
            {CATCHUP.map(([s, key]) => <option key={s} value={s}>{t(key)}</option>)}</select></label>
        {preview?.length ? <Banner icon="⏱" title={t("temporal.sch.next")}>{preview.map((d) => fmt.format(d)).join(" · ")}</Banner>
          : preset === "cron" && valid ? <Banner icon="⏱" title={t("temporal.sch.nextLater")}>{t("temporal.sch.nextLaterText")}</Banner> : null}
        {tried && v && !fieldsOk && <Banner tone="err" icon="✕" title={t("temporal.sch.notSaved")}>{t("temporal.sch.fixFields")}</Banner>}
        {serverError && <Banner tone="err" icon="✕" title={t("temporal.sch.serverRejected")}>{serverError}</Banner>}
        <div class="t-row t-stretch"><a class="t-btn" href="#/temporal/schedules">{t("temporal.cancel")}</a>
          <button class="t-btn t-primary" type="button" data-action="create-schedule" disabled={busy || !v || required.length > 0 || reasons.length > 0} onClick={create}>{busy ? t("temporal.sch.creating") : t("temporal.sch.create")}</button></div>
      </div>
    </>
  );
}

function ScheduleCard({ item, runs, onDeleted }) {
  const [s, setS] = useState(item), [busy, setBusy] = useState(false), [error, setError] = useState(""), [confirmDelete, setConfirmDelete] = useState(false);
  async function toggle() {
    setBusy(true); setError("");
    try { setS({ ...s, ...(await api.temporalScheduleAction(s.id, s.paused ? "resume" : "pause")) }); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError("");
    try {
      await api.temporalDeleteSchedule(s.id);
      setConfirmDelete(false);
      onDeleted?.(s.id);
    } catch (e) {
      setError(errorText(e));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }
  const fmt = new Intl.DateTimeFormat(locale(), { timeZone: validZone(s.timezone) ? s.timezone : "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const last = runs.find((r) => r.source === "schedule" && r.definitionId === s.definitionId);
  return (
    <article class="t-card" data-schedule-id={s.id}>
      <div class="t-row t-between">
        <h3>{s.pipeDeleted ? s.name : <a href={"#/temporal/pipe/" + encodeURIComponent(s.definitionId)}>{s.name}</a>}</h3>
        {!s.blocked && <button type="button" role="switch" aria-checked={!s.paused} class={"t-switch" + (s.paused ? "" : " is-on")}
          data-action={s.paused ? "resume-schedule" : "pause-schedule"} disabled={busy} onClick={toggle}>
          <span aria-hidden="true" />{s.paused ? t("temporal.sch.paused") : t("temporal.sch.on")}</button>}
      </div>
      <p><b>{describeCron(s.cron)}</b><span class="t-meta">{s.timezone} · {t("temporal.sch.versionMeta", { n: s.version })}</span></p>
      {s.blocked && (s.pipeDeleted ? <Banner tone="info" icon="🗑" title={t("temporal.sch.pipeDeleted")}>{t("temporal.sch.pipeDeletedText")}</Banner>
        : <Banner tone="err" icon="🔒" title={t("temporal.sch.skipped")}>{s.blocked}. {t("temporal.sch.skippedText")}</Banner>)}
      {!s.blocked && <p class="t-meta">{s.paused ? t("temporal.sch.notWhilePaused") : s.nextTimes?.length ? t("temporal.sch.nextOne", { list: s.nextTimes.slice(0, 3).map((x) => fmt.format(new Date(x))).join(" · ") }) : ""}
        {last?.summary && <> · {t("temporal.sch.prev")} <StatusPill kind={last.summary.kind} /></>}</p>}
      <p class="t-meta">{OVERLAP[s.overlap] ? t(OVERLAP[s.overlap]) : s.overlap}</p>
      <div class="t-row">
        {!s.pipeDeleted && !s.blocked && <a class="t-btn" href={"#/temporal/start/" + encodeURIComponent(s.definitionId) + "?v=" + s.version}>{t("temporal.sch.runNow")}</a>}
        <button class="t-btn t-danger" type="button" data-action="delete-schedule" disabled={busy} onClick={() => setConfirmDelete(true)}>{t("temporal.sch.deleteBtn")}</button>
      </div>
      {error && <p class="t-err-text" role="alert">{error}</p>}
      {confirmDelete && (
        <Sheet title={t("temporal.sch.deleteTitle")} onClose={() => !busy && setConfirmDelete(false)}>
          <p class="t-lead">{t("temporal.sch.deleteLead", { name: s.name, cron: describeCron(s.cron) })}</p>
          <div class="t-row t-stretch">
            <button class="t-btn" type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>{t("common.cancel")}</button>
            <button class="t-btn t-danger-fill" type="button" data-action="confirm-delete-schedule" disabled={busy} onClick={remove}>{busy ? t("temporal.sch.deleting") : t("temporal.sch.deleteConfirm")}</button>
          </div>
        </Sheet>
      )}
    </article>
  );
}

export default function SchedulesList({ capabilities }) {
  const [items, setItems] = useState(null), [runs, setRuns] = useState([]), [error, setError] = useState(null);
  async function load() {
    try { setItems(await api.temporalSchedules()); setError(null); api.temporalRuns().then(setRuns, () => {}); }
    catch (e) { setError(e); }
  }
  useEffect(() => { if (capabilities?.schedulesAvailable) load(); }, []);
  const head = <div class="t-head"><div><h1>{t("temporal.sch.title")}</h1><p class="t-lead">{t("temporal.sch.lead")}</p></div>
    {capabilities?.schedulesAvailable && <a class="t-btn t-primary" href="#/temporal/schedules/new">{t("temporal.sch.add")}</a>}</div>;
  if (!capabilities?.schedulesAvailable) return <>{head}<Empty icon="⏱" title={t("temporal.sch.off")}><p>{capabilities?.execution?.reason ?? t("temporal.notConnected")} {t("temporal.sch.offText")}</p></Empty></>;
  if (!items && error) return <>{head}<Empty icon="⚠" title={t("temporal.sch.loadError")} actions={<button class="t-btn t-primary" type="button" onClick={load}>{t("temporal.retry")}</button>}><p>{errorText(error)}</p></Empty></>;
  if (!items) return <>{head}<Skeleton rows={2} /></>;
  if (!items.length) return <>{head}<Empty icon="⏱" title={t("temporal.sch.empty")} actions={<a class="t-btn t-primary" href="#/temporal/schedules/new">{t("temporal.sch.createSchedule")}</a>}>
    <p>{t("temporal.sch.emptyText")}</p></Empty></>;
  return <>{head}<div class="t-list">{items.map((i) => <ScheduleCard key={i.id} item={i} runs={runs} onDeleted={(id) => setItems((prev) => (prev ?? []).filter((x) => x.id !== id))} />)}</div></>;
}
