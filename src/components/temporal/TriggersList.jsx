// Temporal -> Triggers: list with status words + icons, last fire time,
// banners (token, admin kill-switch, Claude quota, event storm, bad signatures),
// and empty state with templates.
import { useEffect, useState } from "preact/hooks";
import { api, explainApiError } from "../../lib/api.js";
import { githubConn, refreshGithubConn, refreshGithubTriggers } from "../../lib/github-conn.js";
import { hasKey, locale, t } from "../../lib/i18n.js";
import { Banner, Empty, Sheet, Skeleton, when, usePoll } from "./ui.jsx";

const TPL_ICON = { "task-to-pr": "⇡", "fix-ci": "✚", "nightly-deps": "◷" };

function kindLabel(k) {
  return hasKey("temporal.tl.kind." + k) ? t("temporal.tl.kind." + k) : k;
}

function tplName(tp) {
  const k = "temporal.ghTpl." + tp.id + ".name";
  return hasKey(k) ? t(k) : tp.name;
}

function tplDesc(tp) {
  const k = "temporal.ghTpl." + tp.id + ".desc";
  return hasKey(k) ? t(k) : tp.description;
}

function Pill({ cls, icon, children }) {
  return (
    <span class={"t-pill " + cls}>
      <i aria-hidden="true">{icon}</i>
      {children}
    </span>
  );
}

export function triggerPill(tr, conn) {
  if (conn?.connected && conn.status !== "ok") return { cls: "t-err", icon: "✕", text: t("temporal.tl.st.disconnected") };
  if (!tr.enabled) return { cls: "t-off", icon: "❚❚", text: t("temporal.tl.st.disabled") };
  if ((tr.ciAttempts ?? 0) > 0) return { cls: "t-err", icon: "!", text: t("temporal.tl.st.needsHuman", { count: tr.ciAttempts }) };
  if (tr.hookConfigured) return { cls: "t-ok", icon: "●", text: t("temporal.tl.st.webhook") };
  return { cls: "t-run", icon: "⟳", text: t("temporal.tl.st.poll", { min: Math.max(1, Math.round((tr.pollSeconds ?? 120) / 60)) }) };
}

export function triggerSub(tr) {
  const f = tr.filters ?? {};
  const bits = [tr.repo];
  if (f.label) bits.push(t("temporal.tl.subLabel", { label: f.label }));
  if (f.command) bits.push(t("temporal.tl.subCommand", { cmd: f.command }));
  if (!f.label && !f.command) bits.push((tr.kinds ?? []).map((k) => kindLabel(k)).join(", "));
  return bits.join(" · ");
}

const formatDay = (ms) => new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long" }).format(new Date(ms));
const daysLeft = (ms) => Math.ceil((ms - Date.now()) / 86400000);

export default function TriggersList({ capabilities = null } = {}) {
  const conn = githubConn.value;
  const [state, setState] = useState({ list: null, error: null, names: {} });
  const [templates, setTemplates] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [clearingStorm, setClearingStorm] = useState(false);
  const [stormNote, setStormNote] = useState("");

  const load = async () => {
    refreshGithubConn();
    try {
      const v = await refreshGithubTriggers();
      setState((s) => ({ ...s, list: v.list, error: null }));
    } catch (e) {
      setState((s) => ({ ...s, list: null, error: e }));
    }
    try {
      const defs = await api.temporalDefinitions();
      setState((s) => ({ ...s, names: Object.fromEntries((defs ?? []).map((d) => [d.id, d.name])) }));
    } catch {
      /* pipe names are decorative; list works without them */
    }
  };
  useEffect(() => {
    load();
  }, []);
  usePoll(load, 15000, true);

  useEffect(() => {
    if ((state.list?.length === 0 || showCreate) && templates == null) {
      api.temporalTemplates().then((r) => setTemplates(r.templates ?? []), () => setTemplates([]));
    }
  }, [state.list, showCreate, templates]);

  const list = state.list;
  const err = state.error && list == null;

  const banners = [];
  if (conn?.connected && conn.status !== "ok") {
    banners.push(
      <Banner tone="err" icon="✕" title={t("gh.expiredTitle")} key="conn">
        {t("temporal.tl.bannerExpired")}
        <div class="t-row"><a class="t-btn t-primary" href="#/settings/github">{t("temporal.tl.goSettingsGh")}</a></div>
      </Banner>,
    );
  } else if (conn && !conn.connected) {
    banners.push(
      <Banner tone="info" icon="ⓘ" title={t("temporal.tl.bannerNotConnTitle")} key="conn">
        {t("temporal.tl.bannerNotConnText")}
        <div class="t-row"><a class="t-btn t-primary" href="#/settings/github">{t("temporal.tl.connectGh")}</a></div>
      </Banner>,
    );
  }
  if (conn?.connected && conn.status === "ok" && conn.expiringSoon) {
    banners.push(
      <Banner tone="warn" icon="⚠" title={t("temporal.tl.bannerExpTitle", { days: daysLeft(conn.expiresAt), date: formatDay(conn.expiresAt) })} key="exp">
        {t("temporal.tl.bannerExpText")}
        <div class="t-row"><a class="t-btn" href="#/settings/github">{t("temporal.tl.refreshToken")}</a></div>
      </Banner>,
    );
  }
  if (capabilities?.triggers?.adminStopped) {
    banners.push(
      <Banner tone="err" icon="⊘" title={t("temporal.tl.bannerStoppedTitle")} key="stopped">
        {t("temporal.tl.bannerStoppedText")}
      </Banner>,
    );
  }
  const claudeLeft = capabilities?.triggers?.claudeLeftToday;
  if (claudeLeft != null && claudeLeft <= 0) {
    banners.push(
      <Banner tone="warn" icon="⧗" title={t("temporal.tl.bannerClaudeTitle")} key="claude">
        {t("temporal.tl.bannerClaudeText")}
      </Banner>,
    );
  }
  // BUG-319: every stormy trigger gets a "Clear queue" action (running pipes are kept).
  const stormy = (list ?? []).filter((tr) => tr.stormAt);
  const clearStormQueues = async () => {
    setClearingStorm(true);
    setStormNote("");
    try {
      let total = 0;
      for (const tr of stormy) {
        const res = await api.temporalTriggerClearQueue(tr.id);
        total += res?.cleared ?? 0;
      }
      setStormNote(total > 0 ? t("temporal.tl.stormClearedCount", { count: total }) : t("temporal.tr.noteQueueCleared"));
      await load();
    } catch (e) {
      setStormNote(explainApiError(e, t("temporal.tl.errClearQueue")));
    } finally {
      setClearingStorm(false);
    }
  };
  if (stormy.length > 0) {
    banners.push(
      <Banner tone="warn" icon="≋" title={t("temporal.tl.bannerStormTitle")} key="storm">
        {t("temporal.tl.bannerStormText")}
        <div class="t-row">
          <button class="t-btn" type="button" disabled={clearingStorm} onClick={clearStormQueues}>
            {clearingStorm ? t("temporal.tl.clearingQueue") : t("temporal.tr.clearQueueBtn")}
          </button>
        </div>
        {stormNote && <p class="t-small" role="status">{stormNote}</p>}
      </Banner>,
    );
  }
  const badSig = (list ?? []).reduce((n, tr) => n + (tr.badSignature ?? 0), 0);
  if (badSig > 0) {
    banners.push(
      <Banner tone="warn" icon="✕" title={t("temporal.tl.bannerSigTitle", { count: badSig })} key="sig">
        {t("temporal.tl.bannerSigText")}
      </Banner>,
    );
  }

  const head = (action = null) => (
    <div class="t-head">
      <div>
        <h1>{t("temporal.tl.title")}</h1>
        <p class="t-lead">{t("temporal.tl.lead")}</p>
      </div>
      {action}
    </div>
  );

  if (err) {
    return (
      <>
        {head()}
        <Empty
          icon="⚠"
          title={t("temporal.tl.errTitle")}
          actions={<button class="t-btn t-primary" type="button" onClick={load}>{t("common.retry")}</button>}
        >
          <p>{explainApiError(state.error, t("temporal.tl.errFallback"))}</p>
        </Empty>
      </>
    );
  }
  if (list == null) return <>{head()}<Skeleton rows={3} /></>;

  if (list.length === 0) {
    return (
      <>
        {head()}
        {banners}
        <Empty icon="⚡" title={t("temporal.tl.emptyTitle")}>
          <p>{t("temporal.tl.emptyText")}</p>
        </Empty>
        <div class="t-list">
          {(templates ?? []).map((tp) => (
            <a class="t-card t-tpl" key={tp.id} href={`#/temporal/triggers/new?tpl=${tp.id}`}>
              <span class="t-tpl-ic" aria-hidden="true">{TPL_ICON[tp.id] ?? "⚡"}</span>
              <span class="t-tpl-tx">
                <b>{tplName(tp)}</b>
                <span class="t-muted t-small">{tplDesc(tp)}</span>
              </span>
            </a>
          ))}
          {templates != null && templates.length === 0 && <p class="t-muted t-small">{t("temporal.tl.noTemplates")}</p>}
        </div>
        <div class="t-row">
          <a class="t-btn" href="#/temporal/triggers/new">{t("temporal.tl.customTrigger")}</a>
        </div>
      </>
    );
  }

  return (
    <>
      {head(
        <div class="t-row" style="margin-top:0">
          <button class="t-btn t-primary" type="button" data-action="new-trigger" onClick={() => setShowCreate(true)}>{t("temporal.tl.newBtn")}</button>
        </div>,
      )}
      {banners}
      <div class="t-list" role="list">
        {list.map((tr) => {
          const p = triggerPill(tr, conn);
          return (
            <a class="t-card t-trig" key={tr.id} role="listitem" data-trigger={tr.id} href={`#/temporal/triggers/${tr.id}`}>
              <span class="t-trig-ic" aria-hidden="true">⚡</span>
              <span class="t-trig-main">
                <b class="t-trig-name">{state.names[tr.definitionId] ?? t("temporal.defaultPipeName")}</b>
                <span class="t-trig-sub">{triggerSub(tr)}</span>
                <Pill cls={p.cls} icon={p.icon}>{p.text}</Pill>
              </span>
              <span class="t-trig-right">
                <span class="t-muted t-small">{tr.lastAt ? when(tr.lastAt) : "—"}</span>
                {(tr.errors ?? 0) > 0 && <span class="t-pill t-err"><i aria-hidden="true">✕</i>{tr.errors}</span>}
              </span>
            </a>
          );
        })}
      </div>
      <p class="t-muted t-small">{t("temporal.tl.retention")}</p>
      {showCreate && (
        <Sheet title={t("temporal.tl.newTitle")} onClose={() => setShowCreate(false)}>
          <div class="t-list">
            {(templates ?? []).map((tp) => (
              <a class="t-card t-tpl" key={tp.id} href={`#/temporal/triggers/new?tpl=${tp.id}`} onClick={() => setShowCreate(false)}>
                <span class="t-tpl-ic" aria-hidden="true">{TPL_ICON[tp.id] ?? "⚡"}</span>
                <span class="t-tpl-tx">
                  <b>{tplName(tp)}</b>
                  <span class="t-muted t-small">{tplDesc(tp)}</span>
                </span>
              </a>
            ))}
          </div>
          <div class="t-row">
            <a class="t-btn t-primary" href="#/temporal/triggers/new" onClick={() => setShowCreate(false)}>{t("temporal.tl.customTrigger")}</a>
            <button class="t-btn" type="button" onClick={() => setShowCreate(false)}>{t("common.cancel")}</button>
          </div>
        </Sheet>
      )}
    </>
  );
}
