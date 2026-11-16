// FEAT-18.8: «Изменения · N файлов · +a −d» under an answer that changed
// files (frame 1) → the «Изменения хода» sheet (frame 2) → the file's diff
// (DiffView). The files come from the turn's own tool parts (lib/diff.js,
// «Этот ход» — any past turn, all three engines). On a wide screen
// (≥ 1024 px, frame 8) the row opens the two-pane diff right away; the
// sheet's note and buttons sit under the file list there.
// «Git проекта» shows when the chat folder is a repo; «Отменить ход» — on
// the last turn, the same confirm sheet as «⋯ → Отменить ход» (FEAT-01.58).
import { useEffect, useState } from "preact/hooks";
import { PickerSheet } from "../Pickers.jsx";
import { t as tr } from "../../lib/i18n.js";
import { UndoSheet } from "../chat/TurnActions.jsx";
import DiffView, { FileRow, Nums } from "./DiffView.jsx";
import { canRewind } from "../../lib/store.js";
import { navigate } from "../../lib/router.js";
import { gitHash, gitRepo, gitRoot, probeGitRepo } from "../../lib/git-client.js";
import { filesLabel, relPath, totals, turnChanges, turnPartsOf } from "../../lib/diff.js";
import "./git.css";

// Changes of a turn, computed once per set of step objects (the store replaces
// a message object when it changes, so a past turn stays cached while a new
// one streams).
const cache = new WeakMap();
export function changesForTurn(feed, turn, base = "") {
  if (!turn || !Array.isArray(feed)) return [];
  const i0 = feed.findIndex((m) => m?.info?.id === turn.first);
  const i1 = feed.findIndex((m) => m?.info?.id === turn.last);
  if (i0 < 0 || i1 < i0) return [];
  const steps = feed.slice(i0, i1 + 1);
  const last = steps[steps.length - 1];
  const hit = last && typeof last === "object" ? cache.get(last) : null;
  if (hit && hit.base === base && hit.steps.length === steps.length && hit.steps.every((s, i) => s === steps[i])) return hit.files;
  const files = turnChanges(turnPartsOf(feed, turn), { base });
  if (last && typeof last === "object") cache.set(last, { base, steps, files });
  return files;
}

export const changesNote = () => tr("git.changes.note");
const wide = () => {
  try {
    return typeof matchMedia === "function" && matchMedia("(min-width: 1024px)").matches;
  } catch {
    return false;
  }
};

const isAbs = (p) => /^([a-z]:)?[\\/]/i.test(String(p ?? ""));
// A turn file → the path the git API takes (relative to the repo root). A
// relative tool path is relative to the chat folder (base) first.
export function withGitPath(files, root, base = "") {
  if (!root) return files;
  return files.map((f) => {
    const raw = f.abs ?? f.path;
    const abs = isAbs(raw) || !base ? raw : `${String(base).replace(/[\\/]+$/, "")}/${raw}`;
    const r = relPath(abs, root);
    return r && !isAbs(r) && !r.startsWith("../") ? { ...f, gitPath: r } : f;
  });
}

function SheetActions({ sid, lastTurn, onGit, onUndo }) {
  const repo = gitRepo.value[sid] === true;
  const undo = lastTurn && canRewind(sid);
  if (!repo && !undo) return null;
  return (
    <div class="btns chg-actions">
      {repo && <button type="button" class="gbtn" onClick={onGit}>{tr("git.projectGit")}</button>}
      {undo && <button type="button" class="gbtn" onClick={onUndo}>{tr("git.undoTurn")}</button>}
    </div>
  );
}

export function ChangesSheet({ files, sid, lastTurn = false, onOpenFile, onClose, onUndo }) {
  const t = totals(files);
  return (
    <PickerSheet title={tr("git.changes.turnTitle")} onClose={onClose}>
      <div class="chg-sheet" data-feat="FEAT-18.8">
        <p class="sub">
          {filesLabel(t.files)} · <Nums a={t.additions} d={t.deletions} /> · {tr("git.changes.whatChanged")}
        </p>
        <div class="chg-files">
          {files.map((f, i) => <FileRow key={f.key ?? f.path} f={f} onOpen={() => onOpenFile(i)} />)}
        </div>
        <p class="note">{changesNote()}</p>
        <SheetActions sid={sid} lastTurn={lastTurn} onGit={() => navigate(gitHash({ sid }))} onUndo={onUndo} />
      </div>
    </PickerSheet>
  );
}

export default function ChangesRow({ files, sid, base = "", lastTurn = false }) {
  const [open, setOpen] = useState(null); // null | {sheet:true} | {diff:i} | {undo:true}
  useEffect(() => {
    if (open && sid) probeGitRepo(sid, { force: true }); // the folder may have become a repo since
  }, [open != null, sid]);
  if (!Array.isArray(files) || files.length === 0) return null;
  const t = totals(files);
  const names = files.map((f) => f.name).join(", ");
  const repo = gitRepo.value[sid] === true;
  const root = gitRoot.value[sid] ?? null;
  const goGit = () => {
    setOpen(null);
    navigate(gitHash({ sid }));
  };
  const listTitle = `${tr("git.changes.turnTitle")} · ${filesLabel(files.length)}`;
  return (
    <>
      <button
        type="button"
        class="chg"
        data-feat="FEAT-18.8"
        aria-haspopup="dialog"
        onClick={() => setOpen(wide() ? { diff: 0 } : { sheet: true })}
      >
        <span class="ic" aria-hidden="true">±</span>
        <span class="ct">
          {tr("git.changes.title")} · {filesLabel(t.files)}
          <small>{names}</small>
        </span>
        <Nums a={t.additions} d={t.deletions} />
        <span class="chev" aria-hidden="true">›</span>
      </button>
      {open?.sheet && (
        <ChangesSheet
          files={files}
          sid={sid}
          lastTurn={lastTurn}
          onOpenFile={(i) => setOpen({ diff: i })}
          onClose={() => setOpen(null)}
          onUndo={() => setOpen({ undo: true })}
        />
      )}
      {open && Number.isInteger(open.diff) && (
        <DiffView
          files={withGitPath(files, root, base)}
          index={open.diff}
          mode="turn"
          where={{ sid }}
          canGit={repo}
          listTitle={listTitle}
          aside={
            <div class="dv-aside">
              <p class="note">{changesNote()}</p>
              <SheetActions sid={sid} lastTurn={lastTurn} onGit={goGit} onUndo={() => setOpen({ undo: true })} />
            </div>
          }
          onClose={() => setOpen(wide() ? null : { sheet: true })}
        />
      )}
      {open?.undo && <UndoSheet sid={sid} onClose={() => setOpen(null)} />}
    </>
  );
}
