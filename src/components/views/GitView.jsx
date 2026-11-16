// FEAT-18.8: the «Git» screen (design/mockups-v2/changes-git.html, frames
// 4–6). #/git/<sid> — the chat's folder (chat menu «⋯ → Git», «Git проекта»
// in the turn sheet); #/git?directory=<dir> — a project (the project card).
// Branch, ↑/↓ to upstream, the last commit, changed files with checkboxes
// (preselect from Настройки → Git), a file → its diff against the last
// commit, the message (by hand or «✦ Предложить сообщение» — a one-off
// request to this chat's model), «Коммит · N файлов», a toast and a refresh.
// Admin: the «Отправка» card with «Отправить ↑N» only when sending is allowed
// in Настройки → Git, the branch has an upstream and is ahead. A user: the
// note that sending and branches are the admin's.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api.js";
import { me, sessions } from "../../lib/store.js";
import { navigate } from "../../lib/router.js";
import { t } from "../../lib/i18n.js";
import { dirBasename } from "../../lib/normalize.js";
import { agoLabel, gitErrorText, hashDirectory, preselected, pushErrorView, remoteOf, setGitRepo } from "../../lib/git-client.js";
import { filesLabel, splitPath } from "../../lib/diff.js";
import DiffView, { FileRow } from "../git/DiffView.jsx";
import "../git/git.css";

export const tenantNote = () => t("git.tenantNote");

const short = (s, n = 24) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);

// The chat whose model writes the message: the chat itself, or — on a
// project — its most recent chat.
export function suggestSid(sid, directory, list) {
  if (sid) return sid;
  if (!directory) return null;
  const low = directory.toLowerCase();
  const mine = (Array.isArray(list) ? list : []).filter((s) => String(s?.directory ?? "").toLowerCase() === low);
  mine.sort((a, b) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0));
  return mine[0]?.id ?? null;
}

function BackIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
function RefreshIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

export default function GitView({ id = null, directory: dirProp = null, client = api }) {
  const sid = id || null;
  const directory = sid ? null : dirProp ?? hashDirectory();
  const where = sid ? { sid } : { directory };
  const isAdmin = me.value?.role === "admin";
  const session = sid ? sessions.value.find((s) => s.id === sid) : null;

  const [st, setSt] = useState({ phase: "loading", data: null, error: null });
  const [preselect, setPreselect] = useState(null); // null until /me/git answered
  const [checked, setChecked] = useState(() => new Set());
  const [msg, setMsg] = useState("");
  const [suggest, setSuggest] = useState({ busy: false, error: null });
  const [commit, setCommit] = useState({ busy: false, error: null });
  const [push, setPush] = useState({ busy: false, error: null });
  const [toast, setToast] = useState(null);
  const [diffAt, setDiffAt] = useState(null);
  const seeded = useRef(false);
  const toastTimer = useRef(0);

  const load = async ({ reseed = false } = {}) => {
    setSt((s) => ({ ...s, phase: s.data ? "refreshing" : "loading", error: null }));
    try {
      const r = await client.gitStatus(where);
      if (sid) setGitRepo(sid, r?.repo === true, r?.root ?? null);
      if (reseed) seeded.current = false;
      setSt({ phase: "ready", data: r ?? { repo: false }, error: null });
    } catch (err) {
      setSt((s) => ({ ...s, phase: "error", error: gitErrorText(err, t("git.view.loadFailed")) }));
    }
  };

  useEffect(() => {
    seeded.current = false;
    load();
    client.getGitSettings().then(
      (r) => setPreselect(r?.preselect === "none" ? "none" : "modified"),
      () => setPreselect("modified"),
    );
    return () => clearTimeout(toastTimer.current);
  }, [sid, directory]);

  // Ticks: preselect once both answers are in; after a refresh keep what the
  // user ticked for files still there, new files follow the preselect.
  const files = st.data?.repo ? (Array.isArray(st.data.files) ? st.data.files : []) : [];
  useEffect(() => {
    if (!st.data?.repo || preselect == null) return;
    const paths = new Set(files.map((f) => f.path));
    if (!seeded.current) {
      seeded.current = true;
      setChecked(new Set(preselected(files, preselect)));
    } else {
      setChecked((prev) => new Set([...prev].filter((p) => paths.has(p))));
    }
  }, [st.data, preselect]);

  const flash = (text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  const back = () => {
    if (sid) navigate(`/chat/${encodeURIComponent(sid)}`);
    else if (directory) navigate(`/project/${encodeURIComponent(directory)}`);
    else navigate("/");
  };

  const ticked = files.filter((f) => checked.has(f.path)).map((f) => f.path);
  const toggle = (p) => {
    const next = new Set(checked);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setChecked(next);
  };

  const askSid = suggestSid(sid, directory, sessions.value);
  const doSuggest = async () => {
    if (suggest.busy || ticked.length === 0) return;
    setSuggest({ busy: true, error: null });
    try {
      const r = await client.gitSuggest({ ...where, ...(askSid ? { sid: askSid } : {}) }, ticked);
      const text = typeof r?.message === "string" ? r.message.trim() : "";
      if (text) setMsg(text);
      setSuggest({ busy: false, error: text ? null : t("git.view.noSuggestion") });
    } catch (err) {
      setSuggest({ busy: false, error: gitErrorText(err, t("git.view.suggestFailed")) });
    }
  };

  const doCommit = async () => {
    const message = msg.trim();
    if (commit.busy || !message || ticked.length === 0) return;
    setCommit({ busy: true, error: null });
    setPush({ busy: false, error: null });
    try {
      const r = await client.gitCommit(where, ticked, message);
      const subject = String(r?.subject ?? message.split("\n")[0]);
      const n = Array.isArray(r?.files) ? r.files.length : ticked.length;
      setCommit({ busy: false, error: null });
      setMsg("");
      flash(t("git.view.committed", { subject: short(subject), files: filesLabel(n) }));
      await load({ reseed: true });
    } catch (err) {
      setCommit({ busy: false, error: gitErrorText(err, t("git.view.commitFailed")) });
    }
  };

  const doPush = async () => {
    if (push.busy) return;
    setPush({ busy: true, error: null });
    try {
      const r = await client.gitPush(where);
      setPush({ busy: false, error: null });
      const n = Number(r?.pushed) || st.data?.ahead || 0;
      flash(t("git.view.pushed", { remote: remoteOf(st.data?.upstream), n }));
      await load();
    } catch (err) {
      setPush({ busy: false, error: pushErrorView(err) });
    }
  };

  const data = st.data;
  const folder = dirBasename(data?.root || directory || session?.directory || "") || "Git";
  const loading = st.phase === "loading";

  let body;
  if (loading) {
    body = (
      <div class="set" role="status" aria-label={t("git.view.loading")}>
        <div class="git-skel" />
        <div class="git-skel" style="min-height:156px" />
      </div>
    );
  } else if (!data && st.phase === "error") {
    body = (
      <div class="set">
        <div class="gcard warn" role="alert">
          <b><i aria-hidden="true">!</i>{t("git.view.notLoaded")}</b>
          <div class="muted">{st.error}</div>
          <div class="btns"><button type="button" class="gbtn" onClick={() => load()}>{t("common.retry")}</button></div>
        </div>
      </div>
    );
  } else if (!data?.repo) {
    body = (
      <div class="set">
        <div class="gcard">
          <b>{t("git.view.notRepo")}</b>
          <div class="muted">{t("git.view.notRepoNote")}</div>
        </div>
      </div>
    );
  } else {
    const ahead = Number(data.ahead) || 0;
    const behind = Number(data.behind) || 0;
    const remote = remoteOf(data.upstream);
    const canPush = isAdmin && data.pushAllowed === true && Boolean(data.upstream) && ahead > 0;
    const commitDisabled = commit.busy || !msg.trim() || ticked.length === 0;
    const rows = files.map((f) => ({ ...f, key: f.path, gitPath: f.path, ...splitPath(f.path), additions: Number(f.additions) || 0, deletions: Number(f.deletions) || 0 }));
    body = (
      <div class="set">
        {st.phase === "error" && <div class="gcard warn" role="alert"><b><i aria-hidden="true">!</i>{t("git.view.notRefreshed")}</b><div class="muted">{st.error}</div></div>}
        <div class="gcard">
          <div class="br">
            <span class="bname">⎇ {data.detached ? (data.lastCommit?.hash ?? "HEAD").slice(0, 7) : data.branch}</span>
            {data.detached && <em>{t("git.view.detached")}</em>}
            {data.upstream && ahead > 0 && <em>{t("git.view.ahead", { n: ahead, remote })}</em>}
            {data.upstream && behind > 0 && <em>{t("git.view.behind", { n: behind, remote })}</em>}
            {files.length > 0 && <em>{t("git.view.changedCount", { n: files.length })}</em>}
          </div>
          {data.lastCommit?.subject && (
            <div class="muted">{t("git.view.lastCommit", { subject: data.lastCommit.subject })}{data.lastCommit.at ? ` · ${agoLabel(data.lastCommit.at)}` : ""}</div>
          )}
        </div>
        {files.length === 0 ? (
          <div class="gcard">
            <b>{t("git.noChanges")}</b>
            <div class="muted">{t("git.view.clean")}</div>
          </div>
        ) : (
          <>
            <div class="gcard git-files">
              {rows.map((f, i) => {
                const on = checked.has(f.path);
                return (
                  <div class="git-file" key={f.path}>
                    <button type="button" class="chk-btn" role="checkbox" aria-checked={on ? "true" : "false"} aria-label={t("git.view.tick", { name: f.name })} onClick={() => toggle(f.path)}>
                      <span class={"chk" + (on ? " on" : "")} aria-hidden="true">{on ? "✓" : ""}</span>
                    </button>
                    <FileRow f={f} chevron={false} onOpen={() => setDiffAt(i)} />
                  </div>
                );
              })}
            </div>
            <textarea
              class="git-msg"
              aria-label={t("git.commitMessage")}
              placeholder={t("git.commitMessage")}
              value={msg}
              onInput={(e) => setMsg(e.currentTarget.value)}
            />
            <div class="btns">
              {askSid && (
                <button type="button" class="gbtn" disabled={suggest.busy || ticked.length === 0} aria-busy={suggest.busy ? "true" : undefined} onClick={doSuggest}>
                  {suggest.busy ? <span class="spin" aria-hidden="true" /> : <span aria-hidden="true">✦</span>} {t("git.view.suggest")}
                </button>
              )}
              <button type="button" class="gbtn pri" disabled={commitDisabled} aria-busy={commit.busy ? "true" : undefined} onClick={doCommit}>
                {t("git.view.commit")} · {filesLabel(ticked.length)}
              </button>
            </div>
            {suggest.busy && <p class="muted" role="status">{t("git.view.suggesting")}</p>}
            {suggest.error && <p class="git-err" role="alert">{suggest.error}</p>}
            {commit.error && <div class="gcard warn" role="alert"><b><i aria-hidden="true">!</i>{t("git.view.commitFailed")}</b><div class="muted">{commit.error}</div></div>}
          </>
        )}
        {canPush && (
          <div class="gcard">
            <div class="br">{t("git.view.push")}</div>
            <div class="muted">{data.upstream} · {t("git.view.pushAccess")}</div>
            <div class="btns">
              <button type="button" class="gbtn" disabled={push.busy} aria-busy={push.busy ? "true" : undefined} onClick={doPush}>{t("git.view.pushBtn", { n: ahead })}</button>
            </div>
          </div>
        )}
        {push.error && (
          <div class="gcard warn" role="alert" data-kind={push.error.kind}>
            <b><i aria-hidden="true">!</i>{push.error.title}</b>
            <div class="muted">{push.error.text}</div>
          </div>
        )}
        {!isAdmin && <p class="muted git-tenant">{tenantNote()}</p>}
        {diffAt != null && rows.length > 0 && (
          <DiffView files={rows} index={diffAt} mode="git" where={where} listTitle={`${t("git.changes.title")} · ${filesLabel(rows.length)}`} client={client} onClose={() => setDiffAt(null)} />
        )}
      </div>
    );
  }

  return (
    <div class="page git-page" data-feat="FEAT-18.8">
      <header class="page-header is-project">
        <button class="icon-btn" type="button" onClick={back} aria-label={t("common.back")}>
          <BackIcon />
        </button>
        <div class="project-heading">
          <h1>Git</h1>
          <div class="project-sub">{folder}</div>
        </div>
        <button class="icon-btn" type="button" onClick={() => load()} aria-label={t("git.view.refresh")} disabled={st.phase === "loading" || st.phase === "refreshing"}>
          <RefreshIcon />
        </button>
      </header>
      {body}
      {toast && <div class="git-toast" role="status">{toast}</div>}
    </div>
  );
}
