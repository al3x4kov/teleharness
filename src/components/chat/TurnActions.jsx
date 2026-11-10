// FEAT-01.57 / FEAT-01.58: actions on the LAST turn of a chat.
//   - EditButton — «Изменить» under the last question (pencil): the text
//     goes into the composer (edit mode, Composer shows «Правка сообщения»);
//   - RegenerateButton — «Сгенерировать заново» (↻) next to «Копировать
//     ответ»: the same question, a new answer;
//   - TurnMenu — «⋯» → «Отменить ход» → a confirm sheet listing the files
//     that roll back (Claude: shell changes are not undone);
//   - RevertedRow — «Ход отменён · Вернуть» in place of the hidden turn.
// Every button is disabled while a turn runs (canRewind) — the server
// refuses then too (409). Tap targets ≥ 44 px (chat.css .turn-act).
import { useEffect, useState } from "preact/hooks";
import { PickerSheet } from "../Pickers.jsx";
import { canRewind, editing, redoTurn, regenerate, rewindBusy, startEdit, undoPreview, undoTurn } from "../../lib/store.js";
import "../turn-actions.css";
import { t } from "../../lib/i18n.js";

const Icon = ({ children, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{children}</svg>
);
export const PencilIcon = ({ size }) => (
  <Icon size={size}><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /><path d="M14.5 5.5l3 3" /></Icon>
);
const RegenIcon = () => (
  <Icon><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></Icon>
);
const MoreIcon = () => (
  <Icon><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" /></Icon>
);
const UndoIcon = () => (
  <Icon><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Icon>
);

export function EditButton({ sid }) {
  const ok = canRewind(sid);
  return (
    <button class="turn-act" type="button" aria-label={t("turnActions.edit.aria")} title={t("turnActions.edit.title")} disabled={!ok} onClick={() => startEdit(sid)}>
      <PencilIcon />
    </button>
  );
}

export function RegenerateButton({ sid }) {
  const ok = canRewind(sid);
  const running = rewindBusy.value?.sid === sid && rewindBusy.value.kind === "regenerate";
  return (
    <button class="turn-act" type="button" aria-label={t("turnActions.regenerate")} title={t("turnActions.regenerate")} disabled={!ok || running} onClick={() => regenerate(sid)}>
      {running ? <span class="spin" aria-hidden="true" /> : <RegenIcon />}
    </button>
  );
}

const ACTION_KEYS = { restore: "turnActions.file.restore", delete: "turnActions.file.delete" };
const SKIP_KEYS = {
  "changed-after": "turnActions.skip.changedAfter",
  "too-big": "turnActions.skip.tooBig",
  "not-a-file": "turnActions.skip.notAFile",
  error: "turnActions.skip.error",
  "no-snapshot": "turnActions.skip.noSnapshot",
};
const actionText = (a) => (ACTION_KEYS[a] ? t(ACTION_KEYS[a]) : "");
const skipText = (k) => t(SKIP_KEYS[k] ?? "turnActions.skip.generic");

// The confirm sheet: what rolls back, then «Отменить ход».
export function UndoSheet({ sid, onClose }) {
  const [state, setState] = useState({ phase: "loading", files: [], shell: false });
  useEffect(() => {
    let live = true;
    undoPreview(sid).then(
      (r) => live && setState({ phase: r?.blocked ? "blocked" : "ready", files: Array.isArray(r?.files) ? r.files : [], shell: r?.shell === true }),
      () => live && setState({ phase: "error", files: [], shell: false }),
    );
    return () => {
      live = false;
    };
  }, [sid]);
  const busy = rewindBusy.value?.sid === sid;
  const confirm = async () => {
    const r = await undoTurn(sid);
    if (r) onClose();
  };
  const undoable = state.files.filter((f) => !f.skipped);
  return (
    <PickerSheet title={t("turnActions.undo.sheetTitle")} onClose={onClose}>
      <div class="undo-sheet">
        <p class="undo-lead">{t("turnActions.undo.lead")}</p>
        {state.phase === "loading" ? (
          <p class="undo-note" role="status"><span class="spin" aria-hidden="true" /> {t("turnActions.undo.checking")}</p>
        ) : state.phase === "blocked" ? (
          <p class="undo-note is-error" role="alert">{t("turnActions.undo.blocked")}</p>
        ) : state.phase === "error" ? (
          <p class="undo-note is-error" role="alert">{t("turnActions.undo.listError")}</p>
        ) : state.files.length === 0 ? (
          <p class="undo-note">{t("turnActions.undo.noFiles")}</p>
        ) : (
          <>
            <h3 class="sheet-section-title">{undoable.length > 0 ? t("turnActions.undo.filesCount", { count: undoable.length }) : t("turnActions.undo.filesNone")}</h3>
            <ul class="undo-files">
              {state.files.map((f) => (
                <li class={"undo-file" + (f.skipped ? " is-skipped" : "")} key={f.path}>
                  <span class="undo-path">{f.path}</span>
                  <span class="undo-what">{f.skipped ? skipText(f.skipped) : actionText(f.action)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {state.shell && (
          <p class="undo-warn" role="note">
            <span aria-hidden="true">⚠</span> {t("turnActions.undo.shellWarn")}
          </p>
        )}
      </div>
      <div class="sheet-footer">
        <button class="btn" type="button" onClick={onClose}>{t("turnActions.undo.keep")}</button>
        <button class="btn-danger" type="button" disabled={busy || state.phase === "loading" || state.phase === "blocked"} onClick={confirm}>
          {busy ? t("turnActions.undo.busy") : t("turnActions.undo.confirm")}
        </button>
      </div>
    </PickerSheet>
  );
}

// «⋯» of the last turn: the menu sheet, then the confirm sheet.
export function TurnMenu({ sid }) {
  const [open, setOpen] = useState(null); // null | "menu" | "undo"
  const ok = canRewind(sid);
  return (
    <>
      <button class="turn-act" type="button" aria-label={t("turnActions.menu.aria")} title={t("turnActions.menu.title")} aria-haspopup="dialog" disabled={!ok} onClick={() => setOpen("menu")}>
        <MoreIcon />
      </button>
      {open === "menu" && (
        <PickerSheet title={t("turnActions.menu.sheetTitle")} onClose={() => setOpen(null)}>
          <div class="turn-menu">
            <button class="turn-menu-row" type="button" onClick={() => setOpen("undo")}>
              <UndoIcon />
              <span class="turn-menu-text">
                <span class="turn-menu-title">{t("turnActions.undo.confirm")}</span>
                <span class="turn-menu-sub">{t("turnActions.menu.undoSub")}</span>
              </span>
            </button>
          </div>
        </PickerSheet>
      )}
      {open === "undo" && <UndoSheet sid={sid} onClose={() => setOpen(null)} />}
    </>
  );
}

// In place of the hidden turn: «Ход отменён · Вернуть».
export function RevertedRow({ sid }) {
  const busy = rewindBusy.value?.sid === sid;
  return (
    <div class="turn-reverted" role="status">
      <UndoIcon />
      <span>{t("turnActions.reverted")}</span>
      <span aria-hidden="true">·</span>
      <button class="turn-reverted-btn" type="button" disabled={busy} onClick={() => redoTurn(sid)}>
        {busy ? t("turnActions.redo.busy") : t("turnActions.redo")}
      </button>
    </div>
  );
}

// Composer banner of the edit mode: «Правка сообщения · Отмена».
export function isEditing(sid) {
  return editing.value?.sid === sid;
}
