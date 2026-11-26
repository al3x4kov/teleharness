// Background agent template wizard and custom pipe trigger form.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { me } from "../../lib/store.js";
import { githubConn, refreshGithubConn, refreshGithubTriggers } from "../../lib/github-conn.js";
import { hasKey, t } from "../../lib/i18n.js";
import { projectDisplayName } from "../../lib/normalize.js";
import { TEMPLATES, templateDraft } from "../../../shared/temporal-templates.js";
import { Sheet, errorText, hashQuery } from "./ui.jsx";

const KINDS = ["issue_labeled", "issue_opened", "comment_command", "ci_failed", "pr_opened"];
const ENGINE_LABEL = { claude: "Claude", opencode: "OpenCode", codex: "Codex", acp: "Gemini (ACP)" };
const POLL_VALUES = [60, 120, 300, 900];

const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `r-${Date.now()}-${Math.random()}`);

function tplName(tp) {
  const k = "temporal.ghTpl." + tp.id + ".name";
  return hasKey(k) ? t(k) : tp.name;
}

function tplDesc(tp) {
  const k = "temporal.ghTpl." + tp.id + ".desc";
  return hasKey(k) ? t(k) : tp.description;
}

function useProjects(onDefault) {
  const [state, setState] = useState({ list: null });
  useEffect(() => {
    api.temporalProjects().then((r) => {
      setState({ list: r.projects ?? [] });
      if (r.default) onDefault(r.default);
    }, () => setState({ list: [] }));
  }, []);
  return { list: state.list ?? [], loading: state.list == null };
}

function Field({ label, children, note, as = "label" }) {
  const Tag = as;
  return (
    <Tag class="t-field">
      <span>{label}</span>
      {children}
      {note && <span class="t-muted t-small">{note}</span>}
    </Tag>
  );
}

export function problemLine(p) {
  return p?.message ?? String(p);
}

export default function TriggerForm({ capabilities = null } = {}) {
  const tplId = hashQuery().get("tpl");
  const tpl = TEMPLATES.find((x) => x.id === tplId) ?? null;
  const scheduled = !!tpl?.schedule;
  const repos = (githubConn.value?.repos ?? []).map((r) => r.fullName);
  const isTenant = Boolean(me.value?.role && me.value.role !== "admin");
  const allSub = capabilities?.subscriptionModels ?? {};
  const allowedEngines = (isTenant ? ["opencode", "acp"] : ["claude", "opencode", "codex", "acp"])
    .filter((e) => Array.isArray(allSub[e]) && allSub[e].length > 0);
  const defaultEngine = allowedEngines[0] ?? (isTenant ? "opencode" : "claude");
  const defaultModelFor = (eng) => {
    const list = allSub[eng] ?? [];
    const tplModel = tpl?.pipe.steps.find((s) => s.type === "model")?.model ?? null;
    if (tplModel && list.includes(tplModel)) return tplModel;
    return list[0] ?? (eng === "claude" ? tplModel : null);
  };

  const [defs, setDefs] = useState(null);
  const [pick, setPick] = useState("");
  const projects = useProjects((d) => setDraft((x) => (x.directory ? x : { ...x, directory: d })));
  const [draft, setDraft] = useState({
    repo: "", directory: "", engine: defaultEngine, model: defaultModelFor(defaultEngine),
    kinds: tpl?.trigger ? [...tpl.trigger.kinds] : ["issue_labeled"],
    label: tpl?.trigger?.filters?.label ?? "",
    command: tpl?.trigger?.filters?.command ?? "",
    delivery: tpl?.trigger?.delivery ?? "auto",
    pollSeconds: tpl?.trigger?.pollSeconds ?? 120,
    perHour: String(tpl?.trigger?.limits?.perHour ?? 6),
    queue: String(tpl?.trigger?.limits?.queue ?? 20),
    trusted: "",
  });
  const [readiness, setReadiness] = useState(null);
  const [busy, setBusy] = useState(false);
  const [createErr, setCreateErr] = useState("");
  const [created, setCreated] = useState(null);
  const [hookNote, setHookNote] = useState("");
  const [rules, setRules] = useState(false);
  const timer = useRef(null);

  const models = allSub[draft.engine] ?? [];
  useEffect(() => {
    if (!tpl) api.temporalDefinitions().then((r) => setDefs(r ?? []), () => setDefs([]));
    refreshGithubConn();
    setDraft((x) => ({
      ...x,
      engine: x.engine || defaultEngine,
      model: x.model ?? defaultModelFor(x.engine || defaultEngine),
    }));
  }, []);

  useEffect(() => {
    if (!tpl) return undefined;
    clearTimeout(timer.current);
    if (!draft.repo.trim() || !draft.directory || !draft.model) {
      setReadiness(null);
      return undefined;
    }
    let alive = true;
    timer.current = setTimeout(() => {
      api.templateReadiness(tpl.id, { repo: draft.repo.trim(), directory: draft.directory, engine: draft.engine, model: draft.model })
        .then((r) => { if (alive) setReadiness(r); }, () => { if (alive) setReadiness(null); });
    }, 500);
    return () => { alive = false; clearTimeout(timer.current); };
  }, [tpl, draft.repo, draft.directory, draft.engine, draft.model]);

  const update = (patch) => setDraft((x) => ({ ...x, ...patch }));
  const trustedList = () => draft.trusted.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const webhookBlocked = draft.delivery === "webhook" && !capabilities?.triggers?.publicUrl;
  const parseLimit = (raw, fallback, min, max) => {
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };

  async function create() {
    setBusy(true);
    setCreateErr("");
    let createdPipeId = null;
    try {
      const filters = {};
      if (draft.label.trim()) filters.label = draft.label.trim();
      if (draft.command.trim()) filters.command = draft.command.trim().replace(/^\//, "");
      const trusted = trustedList();
      if (trusted.length) filters.trustedAuthors = trusted;
      let definitionId = pick;
      if (tpl) {
        const rec = await api.temporalCreate(templateDraft(tpl, draft.directory, {
          engine: draft.engine,
          model: draft.model,
          repo: draft.repo.trim(),
        }));
        createdPipeId = rec.id;
        const pub = await api.temporalPublish(rec.id, rec.revision);
        definitionId = pub.id;
        if (scheduled) {
          await api.temporalCreateSchedule({
            definitionId: pub.id, version: pub.versions.at(-1).version, cron: tpl.schedule.cron,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            overlap: "skip", catchupSeconds: 3600, requestId: uid(),
          });
          setCreated({ schedule: true });
          return;
        }
      }
      const trig = await api.temporalTriggerCreate({
        definitionId, repo: draft.repo.trim(),
        kinds: tpl ? tpl.trigger.kinds : draft.kinds,
        filters, delivery: webhookBlocked ? "poll" : draft.delivery,
        pollSeconds: draft.pollSeconds,
        limits: {
          perHour: parseLimit(draft.perHour, 6, 1, 60),
          queue: parseLimit(draft.queue, 20, 1, 100),
        },
      });
      setCreated(trig);
      refreshGithubTriggers().catch(() => {});
    } catch (e) {
      if (createdPipeId) await api.temporalDelete(createdPipeId).catch(() => {});
      setCreateErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function setupHook() {
    setBusy(true);
    setHookNote("");
    try {
      const r = await api.temporalTriggerWebhook(created.id, created.key);
      setHookNote(r.pinged ? t("temporal.tf.hookPinged") : t("temporal.tf.hookNoPing"));
    } catch (e) {
      setHookNote(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div class="t-card t-form">
        <h2>{created.schedule ? t("temporal.tf.scheduleCreated") : t("temporal.tf.triggerCreated")}</h2>
        {created.schedule ? (
          <p class="t-lead">{t("temporal.tf.scheduleNote", { name: tplName(tpl) })}</p>
        ) : (
          <>
            <p class="t-lead">{t("temporal.tf.onceHint")}</p>
            <Field label={t("temporal.tf.hookUrl")}><input class="t-input" readonly value={created.hookUrl ?? t("temporal.tf.noPublicUrl")} /></Field>
            <Field label={t("temporal.tf.key")}><input class="t-input" readonly value={created.key} /></Field>
            <Field label={t("temporal.tf.secret")}><input class="t-input" readonly value={created.secret} /></Field>
            {!capabilities?.triggers?.publicUrl && (
              <p class="t-muted t-small">{t("temporal.tf.pollFallback", { min: Math.max(1, Math.round(draft.pollSeconds / 60)) })}</p>
            )}
            {capabilities?.triggers?.publicUrl && (
              <div class="t-row">
                <button class="t-btn t-primary" type="button" disabled={busy} onClick={setupHook}>{t("temporal.tf.createHookBtn")}</button>
              </div>
            )}
            {hookNote && <p class="t-lead" role="status">{hookNote}</p>}
          </>
        )}
        <div class="t-row">
          <a class="t-btn t-primary" href={created.schedule ? "#/temporal/schedules" : "#/temporal/triggers"}>{created.schedule ? t("temporal.tf.toSchedules") : t("temporal.tf.toTriggers")}</a>
        </div>
      </div>
    );
  }

  return (
    <>
      <div class="t-card t-form">
        <h2>{tpl ? tplName(tpl) : t("temporal.tl.customTrigger")}</h2>
        {tpl && <p class="t-lead">{tplDesc(tpl)}</p>}
        {scheduled && <p class="t-muted t-small">{t("temporal.tf.scheduleCron", { cron: tpl.schedule.cron })}</p>}
        {tpl && (
          <div class="t-row">
            <button class="t-btn" type="button" onClick={() => setRules(true)}>{t("temporal.tf.rulesBtn")}</button>
          </div>
        )}

        {tpl && (
          <Field label={t("temporal.tf.dirLabel")} note={t("temporal.tf.dirNote")}>
            <select class="t-input" value={draft.directory} disabled={projects.loading}
              onChange={(e) => update({ directory: e.currentTarget.value })}>
              <option value="">{projects.loading ? t("temporal.tf.loading") : t("temporal.tf.pickDir")}</option>
              {projects.list.map((p) => <option key={p.directory} value={p.directory} selected={p.directory === draft.directory}>{projectDisplayName(p.directory)}</option>)}
            </select>
          </Field>
        )}
        {!tpl && (
          <Field label={t("temporal.tf.pipeLabel")} note={t("temporal.tf.pipeNote")}>
            <select class="t-input" value={pick} onChange={(e) => setPick(e.currentTarget.value)}>
              <option value="">{defs == null ? t("temporal.tf.loading") : t("temporal.tf.pickPipe")}</option>
              {(defs ?? []).filter((d) => d.latestVersion || d.versions?.length).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t("temporal.tf.repoLabel")} note={t("temporal.tf.repoNote")}>
          <input class="t-input" value={draft.repo} placeholder="owner/repo" spellcheck={false} list="gh-repo-list"
            onInput={(e) => update({ repo: e.currentTarget.value })} />
          {repos.length > 0 && (
            <datalist id="gh-repo-list">
              {repos.map((r) => <option key={r} value={r} />)}
            </datalist>
          )}
        </Field>

        {!tpl && (
          <Field label={t("temporal.tf.kindsLabel")}>
            <div class="t-kinds" role="group" aria-label={t("temporal.tf.kindsLabel")}>
              {KINDS.map((k) => (
                <label class="t-kind" key={k}>
                  <input type="checkbox" checked={draft.kinds.includes(k)}
                    onChange={(e) => update({ kinds: e.currentTarget.checked ? [...draft.kinds, k] : draft.kinds.filter((x) => x !== k) })} />
                  {t("temporal.tf.kind." + k)}
                </label>
              ))}
            </div>
          </Field>
        )}
        {(draft.kinds.includes("issue_labeled")) && (
          <Field label={t("temporal.tf.labelField")} note={t("temporal.tf.labelNote")}>
            <input class="t-input" value={draft.label} placeholder="agent" spellcheck={false} onInput={(e) => update({ label: e.currentTarget.value })} />
          </Field>
        )}
        {draft.kinds.includes("comment_command") && (
          <Field label={t("temporal.tf.cmdField")} note={t("temporal.tf.cmdNote")}>
            <input class="t-input" value={draft.command} placeholder="agent" spellcheck={false} onInput={(e) => update({ command: e.currentTarget.value })} />
          </Field>
        )}

        {tpl && allowedEngines.length > 1 && (
          <Field label={t("temporal.tf.engineField")}>
            <select class="t-input" aria-label={t("temporal.tf.engineField")} value={draft.engine} onChange={(e) => {
              const eng = e.currentTarget.value;
              update({ engine: eng, model: defaultModelFor(eng) });
            }}>
              {allowedEngines.map((eng) => <option key={eng} value={eng} selected={eng === draft.engine}>{ENGINE_LABEL[eng] ?? eng}</option>)}
            </select>
          </Field>
        )}
        {tpl && (
          <Field label={t("temporal.tf.modelField")} note={!isTenant ? t("temporal.tf.modelNote") : t("temporal.tf.modelNoteTenant")}>
            <select class="t-input" value={draft.model ?? ""} onChange={(e) => update({ model: e.currentTarget.value })}>
              {(models.length ? models : [draft.model]).filter(Boolean).map((m) => <option key={m} value={m} selected={m === draft.model}>{m}</option>)}
            </select>
          </Field>
        )}

        {!scheduled && (
          <>
            <Field label={t("temporal.tf.deliveryLabel")} as="div">
              <div class="t-seg" role="radiogroup" aria-label={t("temporal.tf.deliveryAria")}>
                {[["auto", t("temporal.tf.del.auto")], ["webhook", "Webhook"], ["poll", t("temporal.tf.del.poll")]].map(([v, name]) => {
                  const off = v === "webhook" && !capabilities?.triggers?.publicUrl;
                  return (
                    <button key={v} type="button" class={"t-seg-btn" + (draft.delivery === v ? " on" : "")} role="radio"
                      aria-checked={draft.delivery === v ? "true" : "false"}
                      title={off ? t("temporal.tf.webhookNoPublicUrl") : undefined}
                      onClick={() => update({ delivery: off ? "poll" : v })}>
                      {off ? t("temporal.tf.delUnavailable", { name }) : name}
                    </button>
                  );
                })}
              </div>
            </Field>
            {draft.delivery === "poll" && (
              <Field label={t("temporal.tf.pollEvery")}>
                <select class="t-input" value={draft.pollSeconds} onChange={(e) => update({ pollSeconds: Number(e.currentTarget.value) })}>
                  {POLL_VALUES.map((v) => <option key={v} value={v}>{t("temporal.tf.pollMin", { min: Math.round(v / 60) })}</option>)}
                </select>
              </Field>
            )}
          </>
        )}

        <Field label={t("temporal.tf.trustedLabel")} note={t("temporal.tf.trustedNote")}>
          <input class="t-input" value={draft.trusted} placeholder="octo, m-ivanova" spellcheck={false} onInput={(e) => update({ trusted: e.currentTarget.value })} />
        </Field>

        {!scheduled && (
          <div class="t-row t-nowrap t-limits">
            <Field label={t("temporal.tf.perHourLabel")}><input class="t-input" type="number" min="1" max="60" value={draft.perHour} onInput={(e) => update({ perHour: e.currentTarget.value })} /></Field>
            <Field label={t("temporal.tf.queueLabel")}><input class="t-input" type="number" min="1" max="100" value={draft.queue} onInput={(e) => update({ queue: e.currentTarget.value })} /></Field>
          </div>
        )}

        {tpl && readiness && (
          <div class={"t-ready " + (readiness.ready ? "ok" : "bad")} role="status">
            <b>{readiness.ready ? t("temporal.tf.readyOk") : t("temporal.tf.readyBad")}</b>
            {!readiness.ready && (
              <ul>
                {readiness.problems.map((p, i) => <li key={i} class={p.blocking ? "blocking" : undefined}>{p.message}</li>)}
              </ul>
            )}
          </div>
        )}
        {createErr && <p class="t-err-text" role="alert">{createErr}</p>}

        <div class="t-row">
          <button class="t-btn t-primary" type="button" disabled={busy || (tpl ? readiness != null && !readiness.ready : !pick || !draft.repo.trim())}
            onClick={create}>
            {busy ? t("temporal.tf.creating") : tpl ? t("temporal.tf.create") : t("temporal.tf.createTrigger")}
          </button>
          <a class="t-btn" href="#/temporal/triggers">{t("common.cancel")}</a>
        </div>
        {!scheduled && <p class="t-muted t-small">{t("temporal.tf.onceFooter")}</p>}
      </div>
      {rules && (
        <Sheet title={t("temporal.tf.rulesTitle")} onClose={() => setRules(false)}>
          <ul class="t-sheet-list">
            <li>{t("temporal.tf.rule1")}</li>
            <li>{t("temporal.tf.rule2")}</li>
            <li>{t("temporal.tf.rule3")}</li>
            <li>{t("temporal.tf.rule4")}</li>
            <li>{t("temporal.tf.rule5")}</li>
          </ul>
          <div class="t-row"><button class="t-btn t-primary" type="button" onClick={() => setRules(false)}>{t("temporal.tf.gotIt")}</button></div>
        </Sheet>
      )}
    </>
  );
}
