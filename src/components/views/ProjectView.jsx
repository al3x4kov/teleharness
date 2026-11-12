// Project screen (Claude-style container): header with the folder, a
// "Новый чат" scoped to this directory (POST /session?directory=X), and the
// folder's chats — the same date-grouped swipe/hover rows as «Чаты» (rename /
// delete, BUG-02.6). `id` is the decoded directory from the router. Folders
// added via «Добавить проект» can be removed from the list here (their chats
// stay in history); auto-projects (folders with chats) have no trash can.
// Chats opened here remember the project as their «Назад» target.
import { useState } from "preact/hooks";
import "../views.css";
import {
  busyMap, createAndOpen, deleteChat, explainApiError, removeUserProject, renameSession, agents, sessions, setNotice, userProjects,
} from "../../lib/store.js";
import { dirBasename, groupSessionsByDate, isSubagentSession, projectDisplayName } from "../../lib/normalize.js";
import { navigate } from "../../lib/router.js";
import { Glyph } from "../Pickers.jsx";
import {
  DeleteModal, LoadError, Modal, RenameModal, SessionRow, useSessionList,
} from "./HomeView.jsx";
import { t } from "../../lib/i18n.js";

export default function ProjectView({ id }) {
  const [loadState, retry] = useSessionList();
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const dir = typeof id === "string" ? id : "";
  const origin = "/project/" + encodeURIComponent(dir);
  const items = sessions.value.filter((s) => s.directory === dir && !isSubagentSession(s, agents.value));
  const groups = groupSessionsByDate(items);
  const isUserAdded = userProjects.value.some((x) => x.toLowerCase() === dir.toLowerCase());
  const name = projectDisplayName(dir) || t("project.fallbackName");

  async function newChat() {
    if (creating) return;
    setCreating(true);
    try {
      await createAndOpen({ directory: dir }); // navigates into the chat
    } catch (err) {
      // Same honesty as Home (BUG-01.40): a silent reset reads as a dead
      // button; policy refusals are named (ISSUE-002).
      setCreating(false);
      setNotice(explainApiError(err, t("project.createFailed", { name })), 10_000);
    }
  }

  return (
    <div class="page">
      <header class="page-header is-project">
        <button class="icon-btn" type="button" onClick={() => navigate("/projects")} aria-label={t("project.back")}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div class="project-heading">
          <h1>{name}</h1>
          <div class="project-sub">{dir}</div>
        </div>
        {isUserAdded && (
          <button class="icon-btn" type="button" onClick={() => setRemoving(true)} aria-label={t("project.remove")}>
            <Glyph name="trash" size={22} />
          </button>
        )}
      </header>
      <button class="btn-primary project-new" type="button" onClick={newChat} disabled={creating || !dir} aria-busy={creating ? "true" : undefined}>
        {creating ? <span class="btn-spin" aria-hidden="true" /> : <Glyph name="plus" />}
        {creating ? t("home.creating") : t("project.newChat", { name })}
      </button>
      {loadState === "loading" ? (
        <div class="sk-list" role="status" aria-label={t("project.loading")}>
          {[0, 1, 2].map((i) => (
            <div class="sk-row" key={i}>
              <div class="sk sk-title" />
              <div class="sk sk-meta" />
            </div>
          ))}
        </div>
      ) : loadState === "error" ? (
        <LoadError what={t("project.what")} onRetry={retry} />
      ) : items.length === 0 ? (
        <p class="hint">{t("project.empty")}</p>
      ) : (
        groups.map((g) => (
          <section class="group" key={g.key}>
            <h2 class="group-label">{g.label}</h2>
            {g.items.map((s) => (
              <SessionRow
                key={s.id} session={s} origin={origin} open={openId === s.id}
                onOpen={(sid) => setOpenId(sid)}
                onRename={setRenaming} onDelete={setDeleting}
              />
            ))}
          </section>
        ))
      )}
      {renaming && (
        <RenameModal
          session={renaming} onClose={() => setRenaming(null)}
          onSave={async (title) => {
            let error = null;
            const ok = await renameSession(renaming.id, title, { onError: (m) => (error = m) });
            if (!ok) return error ?? t("home.renameFailed");
            setRenaming(null);
            setOpenId(null);
            return null;
          }}
        />
      )}
      {deleting && (
        <DeleteModal
          session={deleting}
          // BUG-216: как в «Чатах» — предупреждение и стоп хода перед удалением.
          busy={!!busyMap.value[deleting.id]}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            deleteChat(deleting.id, { stopFirst: !!busyMap.value[deleting.id] });
            setDeleting(null);
            setOpenId(null);
          }}
        />
      )}
      {removing && (
        <Modal title={t("project.removeQ")} onClose={() => setRemoving(false)}>
          <p class="modal-text">
            {t("project.removeText", { name: dirBasename(dir) || dir })}
          </p>
          <div class="modal-actions">
            <button class="btn" type="button" onClick={() => setRemoving(false)}>{t("common.cancel")}</button>
            <button
              class="btn-danger" type="button"
              onClick={() => {
                removeUserProject(dir);
                setRemoving(false);
                navigate("/projects");
              }}
            >
              {t("project.removeBtn")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
