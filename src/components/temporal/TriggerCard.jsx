// Trigger detail card: summary, filtered event journal, event sheet with replay
// confirmation, CI log tail for exhausted attempts, and enable/disable sheet.
import { useEffect, useState } from "preact/hooks";
import { api, explainApiError } from "../../lib/api.js";
import { refreshGithubTriggers } from "../../lib/github-conn.js";
import { hasKey, t } from "../../lib/i18n.js";
import { Banner, Sheet, Skeleton, eventTarget, when, usePoll, errorText } from "./ui.jsx";
import { CI_ATTEMPTS_MAX } from "../../../shared/temporal-templates.js";

const DECISION_META = {
  started: { cls: "t-ok", icon: "▶" },
  duplicate: { cls: "t-off", icon: "=" },
  already_running: { cls: "t-off", icon: "↻" },
  queued: { cls: "t-wait", icon: "…" },
  queue_full: { cls: "t-quota", icon: "⏱" },
  queue_cleared: { cls: "t-off", icon: "⌫" },
  rate_limited: { cls: "t-quota", icon: "⏱" },
  claude_limit: { cls: "t-quota", icon: "⧗" },
  untrusted_author: { cls: "t-err", icon: "⛔" },
  untrusted_text: { cls: "t-err", icon: "⛔" },
  fork_pr: { cls: "t-off", icon: "⑂" },
  filtered_repo: { cls: "t-off", icon: "×" },
  filtered_label: { cls: "t-off", icon: "×" },
  filtered_branch: { cls: "t-off", icon: "×" },
  filtered_command: { cls: "t-off", icon: "×" },
  filtered_kind: { cls: "t-off", icon: "×" },
  ci_not_failed: { cls: "t-off", icon: "×" },
  ci_logs_unavailable: { cls: "t-err", icon: "✕" },
  ci_attempts_exhausted: { cls: "t-err", icon: "!" },
  agent_loop: { cls: "t-off", icon: "↺" },
  trigger_disabled: { cls: "t-off", icon: "❚❚" },
  admin_stopped: { cls: "t-err", icon: "⊘" },
  no_connection: { cls: "t-err", icon: "✕" },
  bad_signature: { cls: "t-err", icon: "✕" },
  too_large: { cls: "t-err", icon: "✕" },
  push_reset: { cls: "t-off", icon: "↺" },
  error: { cls: "t-err", icon: "✕" },
};
export const REPLAYABLE = new Set(["rate_limited", "queue_full", "trigger_disabled", "admin_stopped", "queued"]);

export function decisionPill(decision, reason = null) {
  const m = DECISION_META[decision];
  const key = "temporal.tr.dec." + decision;
  const d = m ? { ...m, text: hasKey(key) ? t(key) : decision } : { cls: "t-off", icon: "?", text: decision };
  const special = decision === "started" && reason ? { cls: "t-ok", icon: "▶", text: reason } : null;
  return special ?? d;
}

function kindShort(k) {
  const key = "temporal.tr.kind." + k;
  return hasKey(key) ? t(key) : k;
}

const FILTER_IDS = ["", "started", "skipped", "errors"];

const entryTitle = (e) => {
  const ev = e.eventJson;
  if (e.number != null && ev?.title) return `#${e.number} ${ev.title}`;
  if (e.number != null) return `#${e.number}`;
  if (ev?.kind === "ci_failed")
    return [ev.prNumber != null ? `PR #${ev.prNumber}` : null, ev.branch ? t("temporal.tr.branch", { branch: ev.branch }) : null].filter(Boolean).join(" · ") || "—";
  if (ev?.branch) return t("temporal.tr.branch", { branch: ev.branch });
  return "—";
};
const shortId = (s) => (typeof s === "string" && s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s ?? "");

function Pill({ cls, icon, children }) {
  return (
    <span class={"t-pill " + cls}>
      <i aria-hidden="true">{icon}</i>
      {children}
    </span>
  );
}

export default function TriggerCard({ id, capabilities = null } = {}) {
  const [trig, setTrig] = useState(null);
  const [pipe, setPipe] = useState(null);
  const [error, setError] = useState(null);
  const [entries, setEntries] = useState(null);
  const [filter, setFilter] = useState("");
  const [entry, setEntry] = useState(null);
  const [confirmReplay, setConfirmReplay] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [disableSheet, setDisableSheet] = useState(false);

  const load = async () => {
    try {
      const tr = await api.temporalTrigger(id);
      setTrig(tr);
      api.temporalDefinition(tr.definitionId).then(setPipe, () => setPipe(null));
    } catch (e) {
      setError(e);
    }
  };
  const loadJournal = async (nextFilter = filter, cursor = null) => {
    try {
      const rows = await api.temporalTriggerJournal(id, { filter: nextFilter || undefined, cursor });
      setEntries((prev) => (cursor && prev ? { ...prev, list: [...prev.list, ...rows], cursor: rows.at(-1)?.id ?? null } : { list: rows, cursor: rows.at(-1)?.id ?? null }));
    } catch (e) {
      setEntries({ list: [], cursor: null, error: e });
    }
  };
  useEffect(() => {
    load();
    loadJournal();
  }, [id]);
  usePoll(() => { loadJournal(); }, 15000, true);

  if (error) {
    const status = error?.status;
    return (
      <div class="t-card">
        <h2>{status === 404 ? t("temporal.tr.notFound") : t("temporal.tr.unavailable")}</h2>
        <p class="t-lead">{explainApiError(error, t("temporal.tr.errOpen"))}</p>
        <div class="t-row"><a class="t-btn t-primary" href="#/temporal/triggers">{t("temporal.tf.toTriggers")}</a></div>
      </div>
    );
  }
  if (!trig) return <Skeleton rows={3} />;

  const pipeName = pipe?.name ?? t("temporal.defaultPipeName");
  const lastVersion = pipe?.versions?.at(-1)?.version ?? null;
  const versionText = trig.version
    ? t("temporal.tr.versionNum", { v: trig.version })
    : lastVersion
      ? t("temporal.tr.latestVersionNum", { v: lastVersion })
      : t("temporal.tr.latestVersion");
  const delivery = trig.hookConfigured
    ? t("temporal.tl.st.webhook")
    : trig.delivery === "poll"
      ? t("temporal.tl.st.poll", { min: Math.max(1, Math.round(trig.pollSeconds / 60)) })
      : t("temporal.tr.deliveryAuto");

  const chooseFilter = (f) => {
    setFilter(f);
    setEntries(null);
    loadJournal(f);
  };

  return (
    <>
      <div class="t-card" data-trigger-card={id}>
        <div class="t-row t-nowrap">
          <b class="t-trig-name">{pipeName}</b>
          <Pill cls={trig.enabled ? "t-ok" : "t-off"} icon={trig.enabled ? "●" : "❚❚"}>
            {trig.enabled ? delivery : t("temporal.tl.st.disabled")}
          </Pill>
        </div>
        <dl class="t-kv">
          <dt>{t("temporal.tf.repoLabel")}</dt><dd>{trig.repo}</dd>
          <dt>{t("temporal.tf.pipeLabel")}</dt><dd>{pipeName} · {versionText} · <a href={`#/temporal/pipe/${trig.definitionId}`}>{t("temporal.tr.openPipe")}</a></dd>
          <dt>{t("temporal.tr.delivery")}</dt><dd>{delivery}</dd>
          <dt>{t("temporal.tr.limits")}</dt><dd>{t("temporal.tr.limitsVal", { perHour: trig.limits?.perHour ?? 6, queue: trig.limits?.queue ?? 20 })}</dd>
          <dt>{t("temporal.tf.kindsLabel")}</dt><dd>{(trig.kinds ?? []).map((k) => kindShort(k)).join(", ") || "—"}</dd>
        </dl>
        <div class="t-row" style="margin-top:10px">
          {trig.enabled ? (
            <button class="t-btn" type="button" disabled={busy} onClick={() => setDisableSheet(true)}>{t("temporal.tr.disableBtn")}</button>
          ) : (
            <button class="t-btn t-primary" type="button" disabled={busy} onClick={async () => {
              setBusy(true); setNote("");
              try {
                const updated = await api.temporalTriggerEnable(id);
                setTrig(updated);
                setNote(t("temporal.tr.noteEnabled"));
                refreshGithubTriggers().catch(() => {});
              } catch (e) { setNote(errorText(e)); }
              finally { setBusy(false); }
            }}>{t("temporal.tr.enableBtn")}</button>
          )}
          {((trig.queuedCount ?? 0) > 0 || trig.stormAt) && (
            <button class="t-btn" type="button" disabled={busy} onClick={async () => {
              setBusy(true); setNote("");
              try {
                const res = await api.temporalTriggerClearQueue(id);
                setNote(res?.cleared ? t("temporal.tr.noteQueueClearedCount", { count: res.cleared }) : t("temporal.tr.noteQueueCleared"));
                await load();
                await loadJournal();
                refreshGithubTriggers().catch(() => {});
              } catch (e) { setNote(errorText(e)); }
              finally { setBusy(false); }
            }}>{(trig.queuedCount ?? 0) > 0 ? t("temporal.tr.clearQueueBtnCount", { count: trig.queuedCount }) : t("temporal.tr.clearQueueBtn")}</button>
          )}
        </div>
        {note && <p class="t-lead" role="status">{note}</p>}
      </div>

      <div class="t-chips" role="tablist" aria-label={t("temporal.tr.filterAria")}>
        {FILTER_IDS.map((v) => (
          <button key={v} type="button" role="tab" aria-selected={filter === v ? "true" : "false"} class={"t-chip" + (filter === v ? " on" : "")} onClick={() => chooseFilter(v)}>
            {t("temporal.tr.filter." + (v || "all"))}
          </button>
        ))}
      </div>

      {entries == null ? <Skeleton rows={4} /> : (
        <div class="t-list" role="list">
          {entries.list.length === 0 && <p class="t-muted t-small">{t("temporal.tr.emptyJournal")}</p>}
          {entries.list.map((e) => {
            const p = decisionPill(e.decision, e.reason);
            return (
              <div class="t-card t-jr" role="button" tabIndex={0} key={e.id}
                onClick={() => { setEntry(e); setConfirmReplay(false); }}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setEntry(e); setConfirmReplay(false); } }}>
                <span class="t-jr-tm">{when(e.at)}</span>
                <span class="t-jr-tx">
                  <span class="t-jr-tt">{entryTitle(e)}</span>
                  <span class="t-muted t-small">{[kindShort(e.kind), e.actor, e.via].filter(Boolean).join(" · ")}{e.reason && e.decision !== "started" ? ` · ${e.reason}` : ""}</span>
                  <span class="t-jr-pills">
                    <Pill cls={p.cls} icon={p.icon}>{p.text}</Pill>
                    {e.workflowId && <a href={`#/temporal/run/${e.workflowId}`} onClick={(ev) => ev.stopPropagation()}>{t("temporal.tr.runLink", { id: shortId(e.workflowId) })}</a>}
                  </span>
                </span>
              </div>
            );
          })}
          {entries.cursor != null && entries.list.length >= 20 && (
            <div class="t-row t-center">
              <button class="t-btn" type="button" onClick={() => loadJournal(filter, entries.cursor)}>{t("temporal.tr.showMore")}</button>
            </div>
          )}
        </div>
      )}

      {entry && (
        <Sheet title={t("temporal.tr.eventSheetTitle")} onClose={() => { setEntry(null); setConfirmReplay(false); }}>
          {(() => {
            const p = decisionPill(entry.decision, entry.reason);
            const ev = entry.eventJson;
            const replayable = REPLAYABLE.has(entry.decision) && !!ev;
            const { href, toPr } = eventTarget(entry);
            const exhausted = entry.decision === "ci_attempts_exhausted";
            const ciLog = typeof ev?.ciLog === "string" ? ev.ciLog.trim() : "";
            return (
              <>
                <div class="t-row t-nowrap">
                  <Pill cls={p.cls} icon={p.icon}>{p.text}</Pill>
                  <span class="t-muted t-small">{when(entry.at)} · {entry.via}</span>
                </div>
                <h3 class="t-jr-sheet-title">{entryTitle(entry)}</h3>
                <dl class="t-kv">
                  <dt>{t("temporal.tf.repoLabel")}</dt><dd>{entry.repo}</dd>
                  {ev?.author && <><dt>{t("temporal.tr.evAuthor")}</dt><dd>{ev.author}</dd></>}
                  {entry.actor && <><dt>{t("temporal.tr.evActor")}</dt><dd>{entry.actor}</dd></>}
                  {ev?.label && <><dt>{t("temporal.tf.labelField")}</dt><dd>{ev.label}</dd></>}
                  {ev?.command && <><dt>{t("temporal.tf.cmdField")}</dt><dd>/{ev.command}</dd></>}
                  {ev?.workflow && <><dt>Workflow</dt><dd>{ev.workflow}</dd></>}
                  {entry.reason && <><dt>{t("temporal.tr.evDecision")}</dt><dd>{entry.reason}</dd></>}
                </dl>
                {entry.decision === "untrusted_author" && <p class="t-muted t-small">{t("temporal.tr.untrustedHint")}</p>}
                {!replayable && REPLAYABLE.has(entry.decision) && <p class="t-muted t-small">{t("temporal.tr.noBodyReplay")}</p>}
                {exhausted && (
                  <Banner tone="warn" icon="✋" title={t("temporal.tr.exhaustedTitle", { max: CI_ATTEMPTS_MAX })}>
                    {t("temporal.tr.exhaustedText")}
                  </Banner>
                )}
                {ciLog ? (
                  <div class="t-cilog">
                    <h4 class="t-cilog-h">{t("temporal.rd.ciLogTitle")}</h4>
                    <pre class="t-code">{ciLog}</pre>
                    <p class="t-help">{t("temporal.rd.ciLogHelp")}</p>
                  </div>
                ) : exhausted ? <p class="t-muted t-small">{t("temporal.tr.noCiLog")}</p> : null}
                {entry.workflowId && (
                  <p class="t-muted t-small">
                    {t("temporal.tr.runPrefix")}{" "}
                    <a href={`#/temporal/run/${entry.workflowId}`}>{shortId(entry.workflowId)}</a>
                  </p>
                )}
                {note && <p class="t-lead" role="status">{note}</p>}
                <div class="t-row">
                  {href && (
                    <a class={"t-btn" + (exhausted && toPr ? " t-primary" : "")} href={href} target="_blank" rel="noreferrer">
                      {toPr ? t("temporal.pr.openNum", { n: ev.prNumber }) : t("temporal.gh.openGithub")}
                    </a>
                  )}
                  {replayable && !confirmReplay && (
                    <button class="t-btn t-primary" type="button" onClick={() => setConfirmReplay(true)}>{t("temporal.tr.replayBtn")}</button>
                  )}
                  {replayable && confirmReplay && (
                    <>
                      <button class="t-btn t-primary" type="button" disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          setNote("");
                          try {
                            await api.temporalTriggerReplay(id, entry.id);
                            setNote(t("temporal.tr.noteReplayed"));
                            setEntry(null);
                            setConfirmReplay(false);
                            loadJournal();
                            refreshGithubTriggers().catch(() => {});
                          } catch (e) {
                            setNote(errorText(e));
                          } finally {
                            setBusy(false);
                            setConfirmReplay(false);
                          }
                        }}>
                        {t("temporal.tr.replayConfirm")}
                      </button>
                      <button class="t-btn" type="button" onClick={() => setConfirmReplay(false)}>{t("common.no")}</button>
                    </>
                  )}
                </div>
                {!capabilities?.triggers?.available && <p class="t-muted t-small">{t("temporal.tr.noTemporalReplay")}</p>}
              </>
            );
          })()}
        </Sheet>
      )}

      {disableSheet && (
        <Sheet title={t("temporal.tr.disableBtn")} onClose={() => !busy && setDisableSheet(false)}>
          {(trig.activeCount ?? 0) > 0 ? (
            <>
              <p class="t-lead">{t("temporal.tr.disableActive", { count: trig.activeCount })}</p>
              <div class="t-row">
                <button class="t-btn t-primary" type="button" disabled={busy} onClick={async () => {
                  setBusy(true); setNote("");
                  try {
                    const updated = await api.temporalTriggerDisable(id, "keep");
                    setTrig(updated);
                    setDisableSheet(false);
                    setNote(t("temporal.tr.noteDisabledKeep"));
                    refreshGithubTriggers().catch(() => {});
                  } catch (e) { setNote(errorText(e)); }
                  finally { setBusy(false); }
                }}>{t("temporal.tr.disableKeepBtn")}</button>
                <button class="t-btn t-danger" type="button" disabled={busy} onClick={async () => {
                  setBusy(true); setNote("");
                  try {
                    const updated = await api.temporalTriggerDisable(id, "cancel");
                    setTrig(updated);
                    setDisableSheet(false);
                    setNote(t("temporal.tr.noteDisabledCancel"));
                    refreshGithubTriggers().catch(() => {});
                  } catch (e) { setNote(errorText(e)); }
                  finally { setBusy(false); }
                }}>{t("temporal.tr.disableCancelBtn")}</button>
                <button class="t-btn" type="button" disabled={busy} onClick={() => setDisableSheet(false)}>{t("common.back")}</button>
              </div>
            </>
          ) : (
            <>
              <p class="t-lead">{t("temporal.tr.disableIdle")}</p>
              <div class="t-row">
                <button class="t-btn t-primary" type="button" disabled={busy} onClick={async () => {
                  setBusy(true); setNote("");
                  try {
                    const updated = await api.temporalTriggerDisable(id, "keep");
                    setTrig(updated);
                    setDisableSheet(false);
                    setNote(t("temporal.tr.noteDisabled"));
                    refreshGithubTriggers().catch(() => {});
                  } catch (e) { setNote(errorText(e)); }
                  finally { setBusy(false); }
                }}>{t("temporal.tr.disableConfirmBtn")}</button>
                <button class="t-btn" type="button" disabled={busy} onClick={() => setDisableSheet(false)}>{t("common.back")}</button>
              </div>
            </>
          )}
        </Sheet>
      )}
    </>
  );
}
