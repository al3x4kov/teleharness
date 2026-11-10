// Projects, Claude-style: a project is a folder with its chats. The list is
// derived in render from the cross-directory sessions signal (never copied
// into a second signal — that goes stale on SSE updates) merged with folders
// the user added manually. Tapping a card opens the project screen;
// system/temp folders are hidden by default.
import { useEffect, useRef, useState } from "preact/hooks";
import "../views.css";
import { MenuButton } from "../Menu.jsx";
import { addUserProject, agents, checkProjectDir, sessions, userProjects } from "../../lib/store.js";
import { buildProjects, isSubagentSession, projectDisplayName, validateProjectDir } from "../../lib/normalize.js";
import { navigate } from "../../lib/router.js";
import { Glyph } from "../Pickers.jsx";
import { fmtWhen, LoadError, Modal, useSessionList } from "./HomeView.jsx";
import { t } from "../../lib/i18n.js";

export function projectHref(dir) {
  return "#/project/" + encodeURIComponent(dir);
}

// P-8: a path that is already a project (an auto-project with chats or one
// added earlier) must not vanish silently — and an auto-project must not leak
// into the manual list (it would grow a «Убрать проект» trash can).
// Returns the existing directory (original spelling) or null.
export function findExistingProject(dir, projects) {
  const norm = (p) => String(p ?? "").trim().replace(/[\\/]+$/, "").toLowerCase();
  const want = norm(dir);
  if (!want) return null;
  return (projects ?? []).find((p) => norm(p.directory) === want)?.directory ?? null;
}

export function pluralChats(n) {
  return t("projects.chatCount", { count: n });
}

// localStorage "zai.hiddenDirs": exact directory strings to hide in addition
// to the built-in system/temp rules. Reading is defensive, like prefs.
function loadHiddenDirs() {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem?.("zai.hiddenDirs") ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function AddProjectModal({ projects, onCreate, onClose }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState(null);
  const [existing, setExisting] = useState(null); // directory of the duplicate
  const [checking, setChecking] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const save = async () => {
    const p = path.trim();
    if (!p || checking) return;
    const err = validateProjectDir(p); // BUG-013: no relative/system paths
    if (err) {
      setError(err);
      inputRef.current?.focus();
      return;
    }
    const dup = findExistingProject(p, projects);
    if (dup) {
      setExisting(dup);
      setError(t("projects.duplicate"));
      inputRef.current?.focus();
      return;
    }
    // ISSUE-006: the server's verdict (missing drive Z:\, outside the
    // tenant's scope) — before the folder lands in the list.
    setChecking(true);
    const problem = await checkProjectDir(p);
    setChecking(false);
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    onCreate(p);
  };
  return (
    <Modal title={t("projects.newProject")} onClose={onClose}>
      <p class="modal-text">{t("projects.newProjectText")}</p>
      <input
        ref={inputRef} class="modal-input" value={path}
        placeholder="D:\Projects\my-app" spellcheck="false"
        aria-label={t("projects.folder")}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? "project-dir-error" : "project-dir-hint"}
        onInput={(e) => {
          setPath(e.currentTarget.value);
          setError(null);
          setExisting(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
      {error ? (
        <p class="modal-error" id="project-dir-error" role="alert">
          {error}
          {existing && (
            <>
              {" "}
              <button
                class="link-btn" type="button"
                onClick={() => {
                  onClose?.();
                  navigate("/project/" + encodeURIComponent(existing));
                }}
              >
                {t("projects.openExisting")}
              </button>
            </>
          )}
        </p>
      ) : (
        <p class="modal-hint" id="project-dir-hint">{t("projects.folderHint")}</p>
      )}
      <div class="modal-actions">
        <button class="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
        <button class="btn-primary" type="button" onClick={save} disabled={!path.trim() || checking} aria-busy={checking ? "true" : undefined}>
          {checking ? t("projects.checking") : t("projects.create")}
        </button>
      </div>
    </Modal>
  );
}

export default function ProjectsView() {
  const [loadState, retry] = useSessionList();
  const [adding, setAdding] = useState(false);

  const list = buildProjects(
    sessions.value.filter((s) => !isSubagentSession(s, agents.value)),
    { hidden: loadHiddenDirs(), extraDirs: userProjects.value },
  );
  const manual = new Set(userProjects.value.map((d) => d.toLowerCase()));
  // A failed load with no chats leaves only the manual folders — that is not
  // the real list, so the error wins (P-2).
  const failed = loadState === "error";

  return (
    <div class="page">
      <header class="page-header">
        <MenuButton />
        <h1>{t("common.projects")}</h1>
        <button class="icon-btn page-action" type="button" onClick={() => setAdding(true)} aria-label={t("projects.add")}>
          <Glyph name="plus" size={22} />
        </button>
      </header>
      {loadState === "loading" ? (
        <div class="sk-list" role="status" aria-label={t("projects.loading")}>
          {[0, 1, 2].map((i) => (
            <div class="sk-row sk-card" key={i}>
              <div class="sk sk-title" />
              <div class="sk sk-meta" />
            </div>
          ))}
        </div>
      ) : failed ? (
        <LoadError what={t("projects.what")} onRetry={retry} />
      ) : list.length === 0 ? (
        <div class="empty">
          <p class="hint">{t("projects.empty")}</p>
          <button class="btn-primary empty-cta" type="button" onClick={() => setAdding(true)}>
            <Glyph name="plus" /> {t("projects.add")}
          </button>
        </div>
      ) : (
        <ul class="card-list">
          {list.map((p) => (
            <li key={p.directory} class="card project-card">
              <a class="project-head" href={projectHref(p.directory)}>
                <div class="set-main">
                  <div class="project-name">
                    {projectDisplayName(p.directory)}
                    {manual.has(p.directory.toLowerCase()) && <span class="project-tag">{t("projects.manualTag")}</span>}
                  </div>
                  <div class="project-path">{p.path}</div>
                  <div class="set-value">
                    {p.count > 0 ? pluralChats(p.count) : t("projects.noChats")}
                    {p.lastUpdated > 0 && <> · {fmtWhen(p.lastUpdated)}</>}
                  </div>
                </div>
                <span class="project-chevron">
                  <Glyph name="chevron" size={18} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <p class="footnote">{t("projects.footnote")}</p>
      {adding && (
        <AddProjectModal
          projects={list}
          onClose={() => setAdding(false)}
          onCreate={(dir) => {
            addUserProject(dir);
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}
