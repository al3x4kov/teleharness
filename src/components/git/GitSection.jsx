// FEAT-18.8: Настройки → «Git» (design/mockups-v2/changes-git.html, кадр 9).
// Значения по умолчанию для коммитов из портала — свои у каждого пользователя:
// автор (имя, почта), язык предлагаемого
// сообщения, отметка файлов по умолчанию; у admin — «Разрешить «Отправить» с
// этого сервера». GET/PUT /teleharness/api/me/git (design.md «API»). Переключатели
// сохраняются сразу; имя и почта — при уходе из поля (blur) или Enter (onChange в preact/compat = input).
import { useEffect, useState } from "preact/hooks";
import { api, explainApiError } from "../../lib/api.js";
import { me } from "../../lib/store.js";
import { t } from "../../lib/i18n.js";
import "./git.css";

export const authorNote = () => t("git.set.authorNote");
export const langNote = () => t("git.set.langNote");

const pick = (r) => ({
  authorName: typeof r?.authorName === "string" ? r.authorName : "",
  authorEmail: typeof r?.authorEmail === "string" ? r.authorEmail : "",
  messageLang: r?.messageLang === "en" ? "en" : "ui",
  preselect: r?.preselect === "none" ? "none" : "modified",
  pushAllowed: r?.pushAllowed === true,
});

function Opt({ on, radio = false, title, sub = null, onClick, disabled = false }) {
  return (
    <button type="button" class="gopt" role={radio ? "radio" : "checkbox"} aria-checked={on ? "true" : "false"} disabled={disabled} onClick={onClick}>
      <span class={"chk" + (radio ? " radio" : "") + (on ? " on" : "")} aria-hidden="true">{on ? "✓" : ""}</span>
      <span class="fn">
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </span>
    </button>
  );
}

export default function GitSection({ client = api }) {
  const isAdmin = me.value?.role === "admin";
  const [st, setSt] = useState({ phase: "loading", v: null });
  const [draft, setDraft] = useState({ authorName: "", authorEmail: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null); // {error?:string, ok?:string}

  const load = async () => {
    setSt({ phase: "loading", v: null });
    try {
      const v = pick(await client.getGitSettings());
      setSt({ phase: "ready", v });
      setDraft({ authorName: v.authorName, authorEmail: v.authorEmail });
    } catch {
      setSt({ phase: "error", v: null });
    }
  };
  useEffect(() => {
    load();
  }, []);

  const save = async (patch) => {
    const prev = st.v;
    const next = { ...prev, ...patch };
    setSt({ phase: "ready", v: next });
    setSaving(true);
    setMsg(null);
    try {
      const body = { authorName: next.authorName, authorEmail: next.authorEmail, messageLang: next.messageLang, preselect: next.preselect };
      if (isAdmin) body.pushAllowed = next.pushAllowed;
      const v = pick(await client.setGitSettings(body));
      setSt({ phase: "ready", v });
      setDraft({ authorName: v.authorName, authorEmail: v.authorEmail });
      setMsg({ ok: t("git.set.saved") });
    } catch (err) {
      setSt({ phase: "ready", v: prev });
      setDraft({ authorName: prev.authorName, authorEmail: prev.authorEmail });
      setMsg({ error: explainApiError(err, t("git.set.saveFailed")) });
    } finally {
      setSaving(false);
    }
  };

  if (st.phase === "loading") {
    return <div class="gset" role="status" aria-label={t("git.set.loading")}><div class="git-skel" /><div class="git-skel" /></div>;
  }
  if (st.phase === "error") {
    return (
      <div class="gset" data-feat="FEAT-18.8">
        <div class="gcard warn" role="alert">
          <b><i aria-hidden="true">!</i>{t("git.set.loadFailed")}</b>
          <div class="btns"><button type="button" class="gbtn" onClick={load}>{t("common.retry")}</button></div>
        </div>
      </div>
    );
  }
  const v = st.v;
  const commitField = (key) => () => {
    const val = draft[key].trim();
    if (val === v[key]) return;
    save({ [key]: val });
  };
  const onEnter = (key) => (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitField(key)();
    }
  };
  return (
    <div class="gset" data-feat="FEAT-18.8">
      <div class="gcard">
        <div class="br">{t("git.set.author")}</div>
        <label class="gfield">
          <span class="muted">{t("git.set.name")}</span>
          <input type="text" autocomplete="name" value={draft.authorName}
            onInput={(e) => setDraft({ ...draft, authorName: e.currentTarget.value })}
            onBlur={commitField("authorName")} onKeyDown={onEnter("authorName")} />
        </label>
        <label class="gfield">
          <span class="muted">{t("git.set.email")}</span>
          <input type="email" autocomplete="email" inputMode="email" value={draft.authorEmail}
            onInput={(e) => setDraft({ ...draft, authorEmail: e.currentTarget.value })}
            onBlur={commitField("authorEmail")} onKeyDown={onEnter("authorEmail")} />
        </label>
        <div class="muted">{authorNote()}</div>
      </div>
      <div class="gcard">
        <div class="br" id="git-lang-title">{t("git.commitMessage")}</div>
        <div role="radiogroup" aria-labelledby="git-lang-title">
          <Opt radio on={v.messageLang === "ui"} title={t("git.set.langUi")} disabled={saving} onClick={() => v.messageLang !== "ui" && save({ messageLang: "ui" })} />
          <Opt radio on={v.messageLang === "en"} title={t("git.set.langEn")} disabled={saving} onClick={() => v.messageLang !== "en" && save({ messageLang: "en" })} />
        </div>
        <div class="muted">{langNote()}</div>
      </div>
      <div class="gcard">
        <div class="br">{t("git.set.defaultFiles")}</div>
        <Opt on={v.preselect === "modified"} title={t("git.set.preselect")} sub={t("git.set.preselectSub")} disabled={saving}
          onClick={() => save({ preselect: v.preselect === "modified" ? "none" : "modified" })} />
      </div>
      {isAdmin && (
        <div class="gcard">
          <div class="br">{t("git.set.pushAdmin")}</div>
          <Opt on={v.pushAllowed} title={t("git.set.pushAllow")} sub={t("git.set.pushAllowSub")} disabled={saving}
            onClick={() => save({ pushAllowed: !v.pushAllowed })} />
        </div>
      )}
      <p class={"muted git-saved" + (msg?.error ? " is-error" : "")} role={msg?.error ? "alert" : "status"} aria-live="polite">
        {msg?.error ?? msg?.ok ?? ""}
      </p>
    </div>
  );
}
