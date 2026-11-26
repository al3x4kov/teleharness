// Admin CRUD screen for the Temporal command catalog (<TELEHARNESS_DATA_DIR>/temporal-commands.json).
// Also exports CommandFormSheet for quick creation inside DefinitionEditor.
import { useEffect, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";
import { Banner, Empty, Sheet, Skeleton, errorText } from "./ui.jsx";

const CYR = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

export function slugifyCommandId(name) {
  const s = String(name ?? "").toLowerCase().trim()
    .replace(/[а-яё]/g, (ch) => CYR[ch] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "");
  return (s || "cmd").slice(0, 64);
}

function toFormState(item) {
  if (!item) {
    return {
      id: "",
      name: "",
      description: "",
      kind: "exec",
      execFile: "",
      execArgvText: "",
      execCwd: "",
      execEnv: [],
      tenantSafe: false,
      temporalAddress: "127.0.0.1:7233",
      temporalNamespace: "default",
      temporalMode: "schedule",
      temporalSchedule: "",
      temporalWorkflow: "",
      temporalTaskQueue: "",
      temporalUiBase: "",
      temporalCancelChild: false,
      timeoutSeconds: 300,
      roles: { admin: true, user: false },
      usersText: "",
      params: [],
    };
  }
  const roles = new Set(item.allow?.roles ?? ["admin"]);
  return {
    id: item.id ?? "",
    name: item.name ?? "",
    description: item.description ?? "",
    kind: item.kind ?? "exec",
    execFile: item.exec?.file ?? "",
    execArgvText: (item.exec?.argv ?? []).join("\n"),
    execCwd: item.exec?.cwd ?? "",
    execEnv: Object.entries(item.exec?.env ?? {}).map(([k, v]) => ({ k, v })),
    tenantSafe: Boolean(item.tenantSafe),
    temporalAddress: item.temporal?.address ?? "127.0.0.1:7233",
    temporalNamespace: item.temporal?.namespace ?? "default",
    temporalMode: item.temporal?.schedule ? "schedule" : "workflow",
    temporalSchedule: item.temporal?.schedule ?? "",
    temporalWorkflow: item.temporal?.workflow ?? "",
    temporalTaskQueue: item.temporal?.taskQueue ?? "",
    temporalUiBase: item.temporal?.uiBase ?? "",
    temporalCancelChild: Boolean(item.temporal?.cancelChild),
    timeoutSeconds: item.timeoutSeconds ?? 300,
    roles: { admin: roles.has("admin"), user: roles.has("user") },
    usersText: (item.allow?.users ?? []).join(", "),
    params: (item.params ?? []).map((p) => ({
      name: p.name ?? "",
      required: Boolean(p.required),
      pattern: p.pattern ?? "",
      description: p.description ?? "",
    })),
  };
}

function buildPayload(f, isEdit) {
  const roles = [];
  if (f.roles.admin) roles.push("admin");
  if (f.roles.user) roles.push("user");
  const users = f.usersText.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const allow = { ...(roles.length ? { roles } : {}), ...(users.length ? { users } : {}) };
  const params = f.params
    .filter((p) => p.name.trim())
    .map((p) => ({
      name: p.name.trim(),
      ...(p.required ? { required: true } : {}),
      ...(p.pattern.trim() ? { pattern: p.pattern.trim() } : {}),
      ...(p.description.trim() ? { description: p.description.trim() } : {}),
    }));
  const base = {
    id: isEdit ? f.id : (f.id.trim() || slugifyCommandId(f.name)),
    name: f.name.trim(),
    ...(f.description.trim() ? { description: f.description.trim() } : {}),
    kind: f.kind,
    timeoutSeconds: Number(f.timeoutSeconds) || 300,
    allow,
    params,
  };
  if (f.kind === "exec") {
    const argv = f.execArgvText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const env = {};
    for (const row of f.execEnv) {
      if (row.k.trim()) env[row.k.trim()] = row.v;
    }
    base.exec = {
      file: f.execFile.trim(),
      argv,
      ...(f.execCwd.trim() ? { cwd: f.execCwd.trim() } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
    if (f.tenantSafe) base.tenantSafe = true;
  } else {
    base.temporal = {
      address: f.temporalAddress.trim(),
      namespace: f.temporalNamespace.trim(),
      ...(f.temporalMode === "schedule"
        ? { schedule: f.temporalSchedule.trim() }
        : { workflow: f.temporalWorkflow.trim(), taskQueue: f.temporalTaskQueue.trim() }),
      ...(f.temporalUiBase.trim() ? { uiBase: f.temporalUiBase.trim() } : {}),
      ...(f.temporalCancelChild ? { cancelChild: true } : {}),
    };
  }
  return base;
}

export function CommandFormSheet({ initial = null, allowedRoots = [], onClose, onSaved }) {
  const isEdit = Boolean(initial);
  const [f, setF] = useState(() => toFormState(initial));
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);
  const [schedList, setSchedList] = useState(null);
  const [schedBusy, setSchedBusy] = useState(false);
  const [schedErr, setSchedErr] = useState("");

  const patch = (p) => setF((x) => ({ ...x, ...p }));

  async function loadSchedules() {
    setSchedBusy(true);
    setSchedErr("");
    try {
      const res = await api.adminTemporalSchedules({
        address: f.temporalAddress.trim() || undefined,
        namespace: f.temporalNamespace.trim() || undefined,
      });
      const list = (res.items ?? []).map((s) => ({
        id: s.scheduleId ?? s.id ?? "",
        workflowType: s.workflowType ?? "",
        paused: Boolean(s.paused),
      })).filter((s) => s.id);
      setSchedList(list);
      if (res.warning) setSchedErr(res.warning);
      if (list.length && !f.temporalSchedule.trim()) {
        patch({ temporalSchedule: list[0].id });
      }
    } catch (e) {
      setSchedErr(errorText(e));
    } finally {
      setSchedBusy(false);
    }
  }

  async function submit(e) {
    e?.preventDefault?.();
    setBusy(true);
    setErrors([]);
    try {
      const body = buildPayload(f, isEdit);
      const res = isEdit
        ? await api.adminUpdateTemporalCommand(initial.id, body)
        : await api.adminCreateTemporalCommand(body);
      onSaved?.(res.item ?? res);
    } catch (err) {
      const list = Array.isArray(err?.body?.errors) && err.body.errors.length ? err.body.errors : [errorText(err)];
      setErrors(list);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={isEdit ? t("temporal.cmd.editTitle", { name: initial.name || initial.id }) : t("temporal.cmd.newTitle")} onClose={onClose}>
      <form class="t-cmd-form" onSubmit={submit}>
        {errors.length > 0 && (
          <Banner tone="err" icon="✕" title={t("temporal.cmd.checkFields")}>
            <ul>{errors.map((m, i) => <li key={i}>{m}</li>)}</ul>
          </Banner>
        )}

        <div class="t-field">
          <span>{t("temporal.cmd.kind")}</span>
          <div class="t-seg" role="group" aria-label={t("temporal.cmd.kind")}>
            <button type="button" class={"t-seg-btn" + (f.kind === "exec" ? " on" : "")}
              onClick={() => patch({ kind: "exec" })}>{t("temporal.cmd.kindExec")}</button>
            <button type="button" class={"t-seg-btn" + (f.kind === "temporal-workflow" ? " on" : "")}
              onClick={() => patch({ kind: "temporal-workflow" })}>{t("temporal.cmd.kindWf")}</button>
          </div>
        </div>

        <div class="t-two">
          <label class="t-field">
            <span>{t("temporal.cmd.name")}</span>
            <input class="t-input" aria-label={t("temporal.cmd.nameAria")} required maxLength={120}
              placeholder={t("temporal.cmd.namePh")} value={f.name}
              onInput={(e) => patch({ name: e.currentTarget.value })} />
          </label>
          <label class="t-field">
            <span>{t("temporal.cmd.idLabel")}</span>
            <input class="t-input t-mono" aria-label={t("temporal.cmd.idAria")} maxLength={64} disabled={isEdit}
              placeholder={t("temporal.cmd.idPh")} value={f.id}
              onInput={(e) => patch({ id: e.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} />
          </label>
        </div>

        <label class="t-field">
          <span>{t("temporal.cmd.desc")} <span class="t-muted">{t("temporal.cmd.descHint")}</span></span>
          <input class="t-input" aria-label={t("temporal.cmd.descAria")} maxLength={400}
            placeholder={t("temporal.cmd.descPh")} value={f.description}
            onInput={(e) => patch({ description: e.currentTarget.value })} />
        </label>

        {f.kind === "exec" ? (
          <div key="kind-exec" class="t-cmd-form">
            <label class="t-field">
              <span>{t("temporal.cmd.execFile")}</span>
              <input class="t-input t-mono" aria-label={t("temporal.cmd.execFileAria")} required maxLength={2048}
                placeholder="/opt/scripts/report.sh" value={f.execFile}
                onInput={(e) => patch({ execFile: e.currentTarget.value })} />
              {allowedRoots.length > 0 && (
                <span class="t-help">{t("temporal.cmd.allowedRoots")} <span class="t-mono">{allowedRoots.join(", ")}</span></span>
              )}
            </label>
            <label class="t-field">
              <span>{t("temporal.cmd.args")} <span class="t-muted">{t("temporal.cmd.argsHint")}</span></span>
              <textarea class="t-input t-mono" rows="3" aria-label={t("temporal.cmd.argsAria")}
                placeholder={"--period\n{{param.period}}"} value={f.execArgvText}
                onInput={(e) => patch({ execArgvText: e.currentTarget.value })} />
              <span class="t-help">{t("temporal.cmd.argsParamHelp")} <span class="t-mono">{t("temporal.cmd.paramToken")}</span>.</span>
            </label>
            <label class="t-field">
              <span>{t("temporal.cmd.cwd")} <span class="t-muted">{t("temporal.cmd.cwdHint")}</span></span>
              <input class="t-input t-mono" aria-label={t("temporal.cmd.cwdAria")} maxLength={2048}
                value={f.execCwd} onInput={(e) => patch({ execCwd: e.currentTarget.value })} />
            </label>
            <div class="t-field">
              <span>{t("temporal.cmd.env")}</span>
              {f.execEnv.map((row, idx) => (
                <div class="t-kv-row" key={idx}>
                  <input class="t-input t-mono" aria-label={t("temporal.cmd.envKeyAria", { n: idx + 1 })} placeholder="KEY"
                    value={row.k} onInput={(e) => patch({ execEnv: f.execEnv.map((x, j) => j === idx ? { ...x, k: e.currentTarget.value } : x) })} />
                  <input class="t-input t-mono" aria-label={t("temporal.cmd.envValAria", { n: idx + 1 })} placeholder="value"
                    value={row.v} onInput={(e) => patch({ execEnv: f.execEnv.map((x, j) => j === idx ? { ...x, v: e.currentTarget.value } : x) })} />
                  <button type="button" class="t-iconbtn t-danger-text" aria-label={t("temporal.cmd.envDel")}
                    onClick={() => patch({ execEnv: f.execEnv.filter((_, j) => j !== idx) })}>✕</button>
                </div>
              ))}
              <button type="button" class="t-btn t-tight" onClick={() => patch({ execEnv: [...f.execEnv, { k: "", v: "" }] })}>{t("temporal.cmd.envAdd")}</button>
            </div>
            <label class="t-check">
              <input type="checkbox" checked={f.tenantSafe} onChange={(e) => patch({ tenantSafe: e.currentTarget.checked })} />
              <span>{t("temporal.cmd.tenantSafePre")}<span class="t-mono">tenantSafe</span>{t("temporal.cmd.tenantSafePost")}</span>
            </label>
          </div>
        ) : (
          <div key="kind-temporal" class="t-cmd-form">
            <div class="t-two">
              <label class="t-field">
                <span>{t("temporal.cmd.tAddr")}</span>
                <input class="t-input t-mono" aria-label={t("temporal.cmd.tAddr")} required maxLength={256}
                  placeholder="127.0.0.1:7233" value={f.temporalAddress}
                  onInput={(e) => patch({ temporalAddress: e.currentTarget.value })} />
              </label>
              <label class="t-field">
                <span>Namespace</span>
                <input class="t-input t-mono" aria-label={t("temporal.cmd.tNsAria")} required maxLength={256}
                  placeholder="default" value={f.temporalNamespace}
                  onInput={(e) => patch({ temporalNamespace: e.currentTarget.value })} />
              </label>
            </div>

            <div class="t-field">
              <span>{t("temporal.cmd.tMode")}</span>
              <div class="t-seg" role="group" aria-label={t("temporal.cmd.tModeAria")}>
                <button type="button" class={"t-seg-btn" + (f.temporalMode === "schedule" ? " on" : "")}
                  onClick={() => patch({ temporalMode: "schedule" })}>{t("temporal.cmd.tModeSchedule")}</button>
                <button type="button" class={"t-seg-btn" + (f.temporalMode === "workflow" ? " on" : "")}
                  onClick={() => patch({ temporalMode: "workflow" })}>{t("temporal.cmd.tModeWorkflow")}</button>
              </div>
            </div>

            {f.temporalMode === "schedule" ? (
              <div key="mode-schedule" class="t-field">
                <span>{t("temporal.cmd.schedId")}</span>
                <div class="t-row t-nowrap">
                  <input class="t-input t-mono" aria-label={t("temporal.cmd.schedId")} required maxLength={256}
                    placeholder="weekly-summary" value={f.temporalSchedule}
                    onInput={(e) => patch({ temporalSchedule: e.currentTarget.value })} />
                  <button type="button" class="t-btn t-tight" disabled={schedBusy} onClick={loadSchedules}>
                    {schedBusy ? t("temporal.cmd.schedLoading") : t("temporal.cmd.schedLoad")}
                  </button>
                </div>
                {schedErr && <span class="t-err-text">✕ {schedErr}</span>}
                {schedList && (
                  schedList.length > 0 ? (
                    <select class="t-input t-mono" aria-label={t("temporal.cmd.schedSelectAria")} value={f.temporalSchedule}
                      onChange={(e) => patch({ temporalSchedule: e.currentTarget.value })}>
                      <option value="">{t("temporal.cmd.schedPick", { count: schedList.length })}</option>
                      {schedList.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.id}{s.workflowType ? ` (${s.workflowType})` : ""}{s.paused ? t("temporal.cmd.schedPaused") : ""}
                        </option>
                      ))}
                    </select>
                  ) : <span class="t-help">{t("temporal.cmd.schedEmpty")}</span>
                )}
              </div>
            ) : (
              <div key="mode-workflow" class="t-two">
                <label class="t-field">
                  <span>{t("temporal.cmd.wfName")}</span>
                  <input class="t-input t-mono" aria-label={t("temporal.cmd.wfName")} required maxLength={256}
                    placeholder="GenerateReportWorkflow" value={f.temporalWorkflow}
                    onInput={(e) => patch({ temporalWorkflow: e.currentTarget.value })} />
                </label>
                <label class="t-field">
                  <span>Task queue</span>
                  <input class="t-input t-mono" aria-label="Task queue" required maxLength={256}
                    placeholder="reports-queue" value={f.temporalTaskQueue}
                    onInput={(e) => patch({ temporalTaskQueue: e.currentTarget.value })} />
                </label>
              </div>
            )}

            <label class="t-field">
              <span>{t("temporal.cmd.uiUrl")} <span class="t-muted">{t("temporal.cmd.uiUrlHint")}</span></span>
              <input class="t-input t-mono" aria-label={t("temporal.cmd.uiUrl")} maxLength={512}
                placeholder="http://127.0.0.1:8233" value={f.temporalUiBase}
                onInput={(e) => patch({ temporalUiBase: e.currentTarget.value })} />
            </label>
            <label class="t-check">
              <input type="checkbox" checked={f.temporalCancelChild}
                onChange={(e) => patch({ temporalCancelChild: e.currentTarget.checked })} />
              <span>{t("temporal.cmd.cancelChildPre")}<span class="t-mono">cancelChild</span>{t("temporal.cmd.cancelChildPost")}</span>
            </label>
          </div>
        )}

        <div class="t-two">
          <label class="t-field">
            <span>{t("temporal.cmd.timeout")}</span>
            <input class="t-input" type="number" min="1" max="86400" aria-label={t("temporal.cmd.timeoutAria")}
              value={f.timeoutSeconds} onInput={(e) => patch({ timeoutSeconds: Number(e.currentTarget.value) })} />
          </label>
          <div class="t-field">
            <span>{t("temporal.cmd.who")}</span>
            <div class="t-row" style="margin-top:0">
              <label class="t-check"><input type="checkbox" checked={f.roles.admin}
                onChange={(e) => patch({ roles: { ...f.roles, admin: e.currentTarget.checked } })} /> admin</label>
              <label class="t-check"><input type="checkbox" checked={f.roles.user}
                onChange={(e) => patch({ roles: { ...f.roles, user: e.currentTarget.checked } })} /> {t("temporal.cmd.roleUser")}</label>
            </div>
          </div>
        </div>

        <label class="t-field">
          <span>{t("temporal.cmd.users")} <span class="t-muted">{t("temporal.cmd.usersHint")}</span></span>
          <input class="t-input t-mono" aria-label={t("temporal.cmd.usersAria")} placeholder="alice, bob"
            value={f.usersText} onInput={(e) => patch({ usersText: e.currentTarget.value })} />
        </label>

        <div class="t-field">
          <span>{t("temporal.cmd.params")}</span>
          {f.params.map((p, idx) => (
            <div class="t-param-row" key={idx}>
              <input class="t-input t-mono" aria-label={t("temporal.cmd.paramNameAria", { n: idx + 1 })} placeholder="name"
                value={p.name} onInput={(e) => patch({ params: f.params.map((x, j) => j === idx ? { ...x, name: e.currentTarget.value.replace(/[^a-zA-Z0-9_-]/g, "") } : x) })} />
              <input class="t-input t-mono" aria-label={t("temporal.cmd.paramRegexAria", { n: idx + 1 })} placeholder={t("temporal.cmd.paramRegexPh")}
                value={p.pattern} onInput={(e) => patch({ params: f.params.map((x, j) => j === idx ? { ...x, pattern: e.currentTarget.value } : x) })} />
              <input class="t-input" aria-label={t("temporal.cmd.paramDescAria", { n: idx + 1 })} placeholder={t("temporal.cmd.paramDescPh")}
                value={p.description} onInput={(e) => patch({ params: f.params.map((x, j) => j === idx ? { ...x, description: e.currentTarget.value } : x) })} />
              <label class="t-check"><input type="checkbox" checked={p.required}
                onChange={(e) => patch({ params: f.params.map((x, j) => j === idx ? { ...x, required: e.currentTarget.checked } : x) })} /> {t("temporal.cmd.paramReq")}</label>
              <button type="button" class="t-iconbtn t-danger-text" aria-label={t("temporal.cmd.paramDel")}
                onClick={() => patch({ params: f.params.filter((_, j) => j !== idx) })}>✕</button>
            </div>
          ))}
          <button type="button" class="t-btn t-tight"
            onClick={() => patch({ params: [...f.params, { name: "", required: false, pattern: "", description: "" }] })}>
            {t("temporal.cmd.paramAdd")}
          </button>
        </div>

        <div class="t-row t-stretch">
          <button type="button" class="t-btn" onClick={onClose}>{t("temporal.cancel")}</button>
          <button type="submit" class="t-btn t-primary" data-action="save-command" disabled={busy}>
            {busy ? t("temporal.cmd.saving") : isEdit ? t("temporal.cmd.save") : t("temporal.cmd.create")}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export default function CommandsList() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  async function load() {
    try {
      const res = await api.adminTemporalCommands();
      setData(res);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function reloadDisk() {
    setBusy(true);
    try {
      const res = await api.adminReloadTemporalCommands();
      setData(res);
      setToast(res.status === "ok" ? t("temporal.cmd.reloaded", { count: res.items?.length ?? 0 }) : t("temporal.cmd.corruptedToast"));
    } catch (e) {
      setToast(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.adminDeleteTemporalCommand(deleting.id);
      setDeleting(null);
      setToast(t("temporal.cmd.deleted"));
      await load();
    } catch (e) {
      setToast(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const head = (
    <div class="t-head">
      <div>
        <h1>{t("temporal.cmd.title")}</h1>
        <p class="t-lead">{t("temporal.cmd.lead")}</p>
      </div>
      <div class="t-row" style="margin-top:0">
        <button class="t-btn" type="button" disabled={busy} onClick={reloadDisk}>{t("temporal.cmd.reload")}</button>
        <button class="t-btn t-primary" type="button" data-action="new-command"
          onClick={() => setEditing({ mode: "create" })}>{t("temporal.cmd.newBtn")}</button>
      </div>
    </div>
  );

  if (!data && error) {
    return (
      <>
        {head}
        <Empty icon="⚠" title={t("temporal.cmd.loadErr")}
          actions={<button class="t-btn t-primary" type="button" onClick={load}>{t("temporal.retry")}</button>}>
          <p>{errorText(error)}</p>
        </Empty>
      </>
    );
  }
  if (!data) return <>{head}<Skeleton rows={3} /></>;

  const items = data.items ?? [];
  const q = query.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (kindFilter !== "all" && item.kind !== kindFilter) return false;
    if (!q) return true;
    return [item.id, item.name, item.description, item.exec?.file, item.temporal?.schedule, item.temporal?.workflow]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });

  return (
    <div class="t-commands">
      {head}
      {data.status === "corrupted" && (
        <Banner tone="err" icon="⚠" title={data.error || t("temporal.cmd.corruptedTitle")}
          action={<button type="button" class="t-btn" disabled={busy} onClick={reloadDisk}>{t("temporal.cmd.reread")}</button>}>
          {Array.isArray(data.errors) && data.errors.length > 0 && (
            <ul>{data.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}
        </Banner>
      )}

      {items.length > 0 && (
        <>
          <input class="t-input t-search" type="search" aria-label={t("temporal.cmd.searchAria")}
            placeholder={t("temporal.cmd.searchPh")}
            value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
          <div class="t-filters" role="group" aria-label={t("temporal.cmd.filterAria")}>
            {[["all", t("temporal.cmd.filterAll", { count: items.length })], ["exec", t("temporal.cmd.kindExec")], ["temporal-workflow", t("temporal.cmd.kindWf")]].map(([k, label]) => (
              <button key={k} type="button" class={"t-chip" + (kindFilter === k ? " is-on" : "")}
                aria-pressed={kindFilter === k} onClick={() => setKindFilter(k)}>{label}</button>
            ))}
          </div>
        </>
      )}

      {items.length === 0 && data.status === "ok" ? (
        <Empty icon="⌘" title={t("temporal.cmd.empty")}
          actions={<button class="t-btn t-primary" type="button" onClick={() => setEditing({ mode: "create" })}>{t("temporal.cmd.addFirst")}</button>}>
          <p>{t("temporal.cmd.emptyText")}</p>
        </Empty>
      ) : filtered.length === 0 ? (
        <Empty icon="⌘" title={t("temporal.cmd.notFound")}><p>{t("temporal.cmd.notFoundText")}</p></Empty>
      ) : (
        <div class="t-list">
          {filtered.map((item) => (
            <article class="t-card t-cmd-card" key={item.id} data-cmd-id={item.id}>
              <div class="t-row t-between t-top">
                <div class="t-grow">
                  <h3>{item.name} <span class="t-mono t-muted">({item.id})</span></h3>
                  {item.description && <p class="t-meta">{item.description}</p>}
                </div>
                <div class="t-cmd-badges">
                  <span class={"t-pill " + (item.kind === "temporal-workflow" ? "t-run" : "t-off")}>
                    {item.kind === "temporal-workflow" ? t("temporal.cmd.kindWf") : "exec"}
                  </span>
                  {(item.allow?.roles ?? []).map((r) => (
                    <span key={r} class="t-pill t-off">{r}</span>
                  ))}
                  {item.kind === "exec" && item.tenantSafe && <span class="t-pill t-ok">tenantSafe</span>}
                </div>
              </div>
              <div class="t-cmd-preview t-mono">
                {item.kind === "exec"
                  ? `${item.exec?.file ?? ""}${item.exec?.argv?.length ? " " + item.exec.argv.join(" ") : ""}`
                  : `${item.temporal?.address ?? ""} · ${item.temporal?.namespace ?? "default"} · ${item.temporal?.schedule ? "schedule: " + item.temporal.schedule : `workflow: ${item.temporal?.workflow ?? ""} (${item.temporal?.taskQueue ?? ""})`}`}
              </div>
              <div class="t-row t-between">
                <span class="t-meta">
                  {t("temporal.cmd.metaLine", { params: item.params?.length ?? 0, timeout: item.timeoutSeconds ?? 300 })}
                </span>
                <div class="t-row" style="margin-top:0">
                  <button type="button" class="t-btn t-tight" onClick={() => setEditing({ mode: "edit", item })}>{t("temporal.cmd.edit")}</button>
                  <button type="button" class="t-btn t-tight t-danger" onClick={() => setDeleting(item)}>{t("temporal.cmd.deleteBtn")}</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {editing && (
        <CommandFormSheet
          initial={editing.mode === "edit" ? editing.item : null}
          allowedRoots={data.allowedRoots ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setToast(editing.mode === "edit" ? t("temporal.cmd.saved") : t("temporal.cmd.added"));
            await load();
          }}
        />
      )}

      {deleting && (
        <Sheet title={t("temporal.cmd.deleteTitle", { name: deleting.name })} onClose={() => setDeleting(null)}>
          <ul class="t-consequences">
            <li>{t("temporal.cmd.deleteC1Pre")}<span class="t-mono">{deleting.id}</span>{t("temporal.cmd.deleteC1Post")}</li>
            <li>{t("temporal.cmd.deleteC2")}</li>
          </ul>
          <div class="t-row t-stretch">
            <button type="button" class="t-btn" onClick={() => setDeleting(null)}>{t("temporal.cancel")}</button>
            <button type="button" class="t-btn t-danger-fill" data-action="confirm-delete-command"
              disabled={busy} onClick={confirmDelete}>{busy ? t("temporal.cmd.deleting") : t("temporal.cmd.deleteConfirm")}</button>
          </div>
        </Sheet>
      )}

      {toast && <div class="t-toast" role="status">{toast}</div>}
    </div>
  );
}
