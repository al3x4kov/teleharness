// FEAT-20.7: «Рабочие копии» проекта (#/worktrees?directory=…, кр. 15–16;
// кадры T-15, P-4, D-5): все копии репозитория — чат/запуск, ветка, изменено,
// размер, состояние, пересечения; «Ветки без чата»; настройки слияния и тестов.
import { useEffect, useState } from "preact/hooks";
import { navigate } from "../../lib/router.js";
import { hashDirectory } from "../../lib/git-client.js";
import { setNotice } from "../../lib/store.js";
import { t } from "../../lib/i18n.js";
import { aheadLine, filesWord, fmtBytes, shortBranch, wtApi, wtTick } from "../../lib/worktree-client.js";
import { BranchIcon } from "../chat/Worktree.jsx";
import "../worktree.css";

function stateWord(it) {
  if (it.gone) return { cls: "is-warn", text: t("worktree.state.gone") };
  if (it.state === "merged") return { cls: "is-ok", text: t("worktree.state.merged") };
  if (it.state === "merging") return { cls: "", text: t("worktree.state.merging") };
  if (it.state === "orphaned") return { cls: "is-warn", text: t("worktree.state.orphaned") };
  if ((it.overlaps ?? []).some((o) => o.conflict)) return { cls: "is-warn", text: t("worktree.state.conflict") };
  if ((it.overlaps ?? []).length) return { cls: "is-warn", text: t("worktree.state.overlap") };
  return { cls: "", text: t("worktree.state.active") };
}

export default function WorktreesView() {
  const dir = hashDirectory();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [settings, setSettings] = useState(null);
  const [testCmd, setTestCmd] = useState("");
  const load = async () => {
    try {
      const r = await wtApi.ofRepo(dir);
      setData(r);
      setError(null);
      const withCmd = r.items?.find((x) => x.testCmd !== undefined);
      if (withCmd && !testCmd) setTestCmd(withCmd.testCmd ?? "");
    } catch (err) {
      setError(err?.message ?? t("worktree.view.loadFailed"));
    }
  };
  useEffect(() => {
    if (dir) void load();
    wtApi.settings().then(setSettings).catch(() => {});
  }, [dir, wtTick.value]);
  const name = data?.name ?? (dir ? dir.split(/[\\/]/).filter(Boolean).pop() : "");
  const saveSettings = async (patch) => {
    try {
      setSettings(await wtApi.saveSettings(patch));
    } catch (err) {
      setNotice(err?.message ?? t("worktree.view.saveFailed"));
    }
  };
  return (
    <div class="page" data-req="FEAT-20.7">
      <header class="page-header is-project">
        <button class="icon-btn" type="button" onClick={() => history.back()} aria-label={t("common.back")}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <div class="project-heading">
          <h1 class="page-title">{t("worktree.view.title")}</h1>
          <div class="wt-muted">{name}{data?.items ? t("worktree.view.countOf", { n: data.items.length, max: data.limits?.max ?? 20 }) : ""}</div>
        </div>
      </header>
      <div class="wt-list">
        {!dir ? <p class="wt-muted wt-full">{t("worktree.view.noProject")}</p> : null}
        {error ? <p class="wt-bad wt-full" role="alert"><span aria-hidden="true">✕</span> {error}</p> : null}
        {data && data.repo === false ? <p class="wt-muted wt-full">{t("worktree.view.notGit")}</p> : null}
        {data?.items?.length === 0 ? <p class="wt-muted wt-full">{t("worktree.view.empty")}</p> : null}
        {(data?.items ?? []).map((it) => {
          const s = stateWord(it);
          return (
            <div class="wt-card" key={it.id}>
              <div class="wt-card-top">
                <span class="wt-card-title">{it.kind === "run" ? t("worktree.view.runTitle", { title: it.title ?? "" }) : it.title || t("worktree.view.chatFallback")}</span>
                <span class={"wt-state " + s.cls}>{s.text}</span>
              </div>
              <div class="wt-branch"><BranchIcon size={14} /><span class="wt-branch-name" title={it.branch}>{shortBranch(it.branch, 40)}</span></div>
              <div class="wt-muted">{t("worktree.view.fromBase", { base: it.base })} · {aheadLine(it)} · {filesWord(it.filesCount ?? 0)} · {fmtBytes(it.size)}</div>
              {(it.overlaps ?? []).length ? <div class="wt-muted">{t("worktree.view.overlaps", { list: it.overlaps.map((o) => (o.kind === "main" ? t("worktree.view.mainCopyLower") : o.kind === "base" ? it.base : `«${o.title ?? o.branch}»`) + ` (${o.files.length})`).join(", ") })}</div> : null}
              <div class="wt-card-actions">
                {it.sid ? <button type="button" class="btn" onClick={() => navigate(`/chat/${it.sid}`)}>{t("worktree.view.openChat")}</button> : null}
                {it.runId ? <button type="button" class="btn" onClick={() => navigate(`/temporal/runs/${encodeURIComponent(it.runId)}`)}>{t("worktree.view.openRun")}</button> : null}
              </div>
            </div>
          );
        })}
        {data?.branches?.length ? (
          <div class="wt-full">
            <h2 class="wt-section-title">{t("worktree.view.orphanBranches")}</h2>
            {data.branches.map((b) => (
              <div class="wt-card" key={b.name}>
                <div class="wt-branch"><BranchIcon size={14} /><span class="wt-branch-name" title={b.name}>{shortBranch(b.name, 40)}</span></div>
                <div class="wt-muted">{b.subject}</div>
                <div class="wt-card-actions">
                  <button type="button" class="btn is-danger-outline" onClick={async () => {
                    if (!confirm(t("worktree.view.confirmDeleteBranch", { name: b.name }))) return;
                    try {
                      await wtApi.deleteBranch(dir, b.name);
                      await load();
                    } catch (err) {
                      setNotice(err?.message ?? t("worktree.view.deleteBranchFailed"));
                    }
                  }}>{t("worktree.view.deleteBranch")}</button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {data?.repo !== false && dir ? (
          <div class="wt-full">
            <h2 class="wt-section-title">{t("worktree.view.settings")}</h2>
            <div class="wt-settings">
              <label class="wt-field">
                <span>{t("worktree.view.defaultMerge")}</span>
                <select value={settings?.mergeMethod ?? "squash"} onChange={(e) => saveSettings({ mergeMethod: e.currentTarget.value })}>
                  <option value="squash">{t("worktree.method.squash")}</option>
                  <option value="merge">{t("worktree.method.merge")}</option>
                  <option value="ff">{t("worktree.method.ff")}</option>
                </select>
              </label>
              <label class="wt-field">
                <span>{t("worktree.view.testTimeout")}</span>
                <input type="text" inputMode="numeric" value={String(settings?.testTimeoutMin ?? 10)} onChange={(e) => saveSettings({ testTimeoutMin: Number(e.currentTarget.value) })} />
              </label>
              <label class="wt-field">
                <span>{t("worktree.view.testCmd")}</span>
                <input type="text" value={testCmd} placeholder="npm test" onInput={(e) => setTestCmd(e.currentTarget.value)} onChange={async (e) => {
                  const v = e.currentTarget.value.trim();
                  try {
                    await wtApi.setTestCmd(dir, v || null);
                    setNotice(v ? t("worktree.view.testCmdSaved") : t("worktree.view.testCmdNone"));
                  } catch (err) {
                    setNotice(err?.message ?? t("worktree.view.saveFailed"));
                  }
                }} />
              </label>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
