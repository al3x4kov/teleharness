// FEAT-20.1: экран ревью `#/review/<id>` — файлы пункта, «просмотрено», дифф
// снимка ревизии с выбором строк (тап / второй тап / ▲▼ на телефоне, клик и
// Shift-клик на десктопе), комментарии к строкам, к файлу и общий, черновики
// (локально сразу, на сервере ≤ 2 с), «Вернуть агенту», «Принять»,
// «Принять и закоммитить», «Убрать». Макет: design/mockups-v2/epic20-phone-review.html
// (T-2…T-18, T-24, T-26; P-2, D-2, D-3, D-5), бриф BRIEF-20.1.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import "../../app.css";
import "../views.css";
import "../board.css";
import "../review.css";
import {
  MODE_REASON, STATUS, STATUS_LETTER, anchorRow, commentLabel, commentsWord, filesWord, hhmm, hunksOfPatch, lineRows,
  localDrafts, newCommentId, newKey, plural, reviewApi, reviewTick, saveLocalDraft, selectLines, selectionComment,
  selectionLabel, shortModel, turnsWord,
} from "../../lib/review-client.js";
import { giveReviewSelection } from "../../lib/git-client.js";
import { me, setNotice } from "../../lib/store.js";
import { navigate } from "../../lib/router.js";
import { t } from "../../lib/i18n.js";
import { MenuButton } from "../Menu.jsx";
import { useModalFocus } from "../Pickers.jsx";

const SAVE_MS = 1200; // черновик на сервере ≤ 2 с после ввода (кр. 5)

function splitPath(p) {
  const i = String(p ?? "").lastIndexOf("/");
  return i < 0 ? { name: p, dir: "" } : { name: p.slice(i + 1), dir: p.slice(0, i) };
}

export function Sheet({ title, children, onClose, labelId = "rv-sheet-title", wide = false }) {
  const ref = useRef(null);
  useModalFocus(ref);
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);
  return (
    <div class="rv-scrim" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div class={"rv-sheet" + (wide ? " is-wide" : "")} role="dialog" aria-modal="true" aria-labelledby={labelId} ref={ref}>
        <h2 id={labelId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function StatusChip({ status }) {
  const s = STATUS[status] ?? STATUS.waiting;
  return <span class={"rv-chip is-" + status}><span aria-hidden="true">{s.icon}</span> {s.word}</span>;
}

function FileLetter({ status }) {
  const l = status === "?" ? "A" : status || "M";
  return <span class={"rv-letter is-" + l} aria-hidden="true">{l}</span>;
}

// Карточка комментария под строками (черновик — сплошная рамка, отправленный — пунктир + исход).
function CommentCard({ c, onEdit, onDelete }) {
  const sent = c.state === "sent";
  return (
    <div class={"rv-comment" + (sent ? " is-sent" : "")} data-cid={c.id}>
      <div class="rv-comment-head">
        <b>{commentLabel(c)}</b>
        {sent ? (
          <span class="rv-tag">{t("review.comment.sent")}{c.outcome === "changed" ? t("review.comment.outcomeChanged") : c.outcome === "unchanged" ? t("review.comment.outcomeUnchanged") : c.outcome === "gone" ? t("review.comment.outcomeGone") : ""}</span>
        ) : (
          <span class="rv-tag is-draft">{t("review.comment.draft")}</span>
        )}
      </div>
      <p class="rv-comment-text">{c.text || <i>{t("review.comment.empty")}</i>}</p>
      {!sent && (
        <div class="rv-comment-actions">
          <button type="button" class="rv-link" onClick={() => onEdit(c)}>{t("review.comment.edit")}</button>
          <button type="button" class="rv-link is-danger" onClick={() => onDelete(c)}>{t("review.comment.delete")}</button>
        </div>
      )}
    </div>
  );
}

// Дифф файла с выбором строк.
function FileDiff({ d, item, file, comments, onComment, onEdit, onDelete, onFileComment, showAll }) {
  const rows = useMemo(() => lineRows(d?.mode === "turns" ? d.hunks : hunksOfPatch(d?.patch)), [d]);
  // BUG-271: выбор и подсказка привязаны к диффу, на котором сделаны: новый дифф —
  // пустой выбор сразу (раньше сброс шёл отложенным useEffect и под нагрузкой
  // срабатывал после первого тапа, стирая выбор)
  const [selBox, setSelBox] = useState({ of: null, sel: null, hint: null });
  const sel = selBox.of === d ? selBox.sel : null;
  const hint = selBox.of === d ? selBox.hint : null;
  const setSel = (v) => setSelBox((b) => ({ of: d, sel: v, hint: b.of === d ? b.hint : null }));
  const setHint = (v) => setSelBox((b) => ({ of: d, sel: b.of === d ? b.sel : null, hint: v }));
  const byRow = useMemo(() => {
    const m = new Map();
    for (const c of comments) {
      const r = anchorRow(rows, c);
      if (r == null) continue;
      if (!m.has(r)) m.set(r, []);
      m.get(r).push(c);
    }
    return m;
  }, [rows, comments]);
  const orphan = comments.filter((c) => (c.side === "new" || c.side === "old") && anchorRow(rows, c) == null);
  const fileComments = comments.filter((c) => c.side === "file");
  const choose = (i, extend) => {
    if (sel && (extend || sel.from === sel.to)) {
      if (i === sel.anchor && sel.from === sel.to) return setSel(null), setHint(null);
      const r = selectLines(rows, sel.anchor, i);
      setSel({ anchor: sel.anchor, from: r.from, to: r.to });
      setHint(r.error ?? null);
      return;
    }
    setSel({ anchor: i, from: i, to: i });
    setHint(null);
  };
  const grow = (dir) => {
    if (!sel) return;
    const side = rows.find((r) => r.kind === "line" && r.i === sel.anchor)?.side ?? "new";
    const same = rows.filter((r) => r.kind === "line" && r.side === side);
    const next = dir > 0 ? same.find((l) => l.i > sel.to) : [...same].reverse().find((l) => l.i < sel.from);
    if (!next) return;
    const r = dir > 0 ? selectLines(rows, sel.from, Math.max(sel.to, next.i), side) : selectLines(rows, sel.to, Math.min(sel.from, next.i), side);
    setSel({ anchor: sel.anchor, from: r.from, to: r.to });
    setHint(r.error ?? null);
  };
  useEffect(() => {
    const k = (e) => {
      if (e.target?.closest?.("textarea, input")) return;
      if (e.key === "c" && sel) { e.preventDefault(); onComment(selectionComment(rows, sel)); }
      if (e.key === "Escape" && sel) setSel(null);
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [sel, rows]);
  const selC = sel ? selectionComment(rows, sel) : null;
  const canSelect = !d?.binary && !d?.huge;
  return (
    <div class="rv-diff-wrap">
      {d?.binary && <div class="rv-note" role="status"><b>{t("review.diff.binary")}</b> — {t("review.diff.binaryHint")}</div>}
      {d?.huge && (
        <div class="rv-note" role="status">
          <b>{t("review.diff.huge")}</b> — {t("review.diff.hugeHint", { count: d.additions + d.deletions })}
          <a class="bd-btn" href={reviewApi.patchUrl(item.id, file.path)} download>{t("review.diff.downloadPatch")}</a>
        </div>
      )}
      {file.big && <div class="rv-note" role="status">{t("review.diff.bigFile")}</div>}
      {d?.partial && <div class="rv-hint">{t("review.diff.partial")}</div>}
      {canSelect && rows.length > 0 && <p class="rv-hint rv-tap-hint">{t("review.diff.tapHint")}</p>}
      {canSelect && rows.length === 0 && !d?.binary && <p class="rv-hint">{t("review.diff.noContentChange")}</p>}
      <div class="rv-diff" role="list" aria-label={t("review.diff.aria", { path: file.path })}>
        {rows.map((r) => {
          if (r.kind === "gap") return <div key={r.key} class="rv-gap" role="listitem">▾ {r.hidden != null ? t("review.diff.unchangedLines", { lines: t("review.linesWord", { count: r.hidden }) }) : t("review.diff.unchangedGeneric")} <span class="rv-gap-note">{t("review.diff.expandNote")}</span></div>;
          if (r.kind === "hunk") return <div key={r.key} class="rv-hunk" role="listitem" aria-hidden="true">{r.newStart != null ? t("review.diff.hunkLine", { n: r.newStart }) : t("review.diff.hunkFragment")}</div>;
          const on = sel && r.i >= sel.from && r.i <= sel.to && (selC?.side === r.side);
          const edge = on && (r.i === sel.from || r.i === sel.to);
          const label = t("review.diff.lineAria", { no: r.no ?? t("review.diff.noNum"), kind: r.t === "+" ? t("review.diff.kindAdd") : r.t === "-" ? t("review.diff.kindDel") : t("review.diff.kindCtx") });
          return (
            <div key={r.key} role="listitem">
              <button type="button" class={"rv-line is-" + (r.t === "+" ? "add" : r.t === "-" ? "del" : "ctx") + (on ? " is-on" : "") + (edge ? " is-edge" : "")}
                aria-label={label} aria-pressed={on ? "true" : "false"} disabled={!canSelect}
                onClick={(e) => canSelect && choose(r.i, e.shiftKey)}>
                <span class="rv-no" aria-hidden="true">{r.no ?? ""}</span>
                <span class="rv-sign" aria-hidden="true">{r.t === " " ? "" : r.t === "-" ? "−" : "+"}</span>
                <span class="rv-code">{r.text === "" ? " " : r.text}</span>
              </button>
              {(byRow.get(r.i) ?? []).map((c) => <CommentCard key={c.id} c={c} onEdit={onEdit} onDelete={onDelete} />)}
            </div>
          );
        })}
      </div>
      {d?.truncated && !d?.huge && <button type="button" class="bd-btn rv-more" onClick={showAll}>{t("review.diff.showAll")}</button>}
      {orphan.length > 0 && (
        <div class="rv-orphans">
          <h3>{t("review.prevComments")}</h3>
          {orphan.map((c) => <CommentCard key={c.id} c={c} onEdit={onEdit} onDelete={onDelete} />)}
        </div>
      )}
      <div class="rv-file-comments">
        {fileComments.map((c) => <CommentCard key={c.id} c={c} onEdit={onEdit} onDelete={onDelete} />)}
        <button type="button" class="bd-btn" onClick={onFileComment}>{t("review.addFileComment")}</button>
      </div>
      {sel && (
        <div class="rv-pill" role="toolbar" aria-label={t("review.selBar.aria")}>
          <button type="button" class="rv-pill-btn" aria-label={t("review.selBar.up")} onClick={() => grow(-1)}>▲</button>
          <span class="rv-pill-label" aria-live="polite">{hint ?? selectionLabel(selC)}</span>
          <button type="button" class="rv-pill-btn" aria-label={t("review.selBar.down")} onClick={() => grow(1)}>▼</button>
          <button type="button" class="rv-pill-go" onClick={() => onComment(selC)}>{t("review.selBar.comment")}</button>
          <button type="button" class="rv-pill-btn" aria-label={t("review.selBar.clear")} onClick={() => setSel(null)}>×</button>
        </div>
      )}
    </div>
  );
}

export default function ReviewView({ id }) {
  const user = me.value?.id ?? "me";
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState(null); // путь открытого файла
  const [diff, setDiff] = useState(null);
  const [full, setFull] = useState(false);
  const [since, setSince] = useState(false); // «С прошлого ревью»
  const [edit, setEdit] = useState(null); // {c, isNew}
  const [conflict, setConflict] = useState(null);
  const [sheet, setSheet] = useState(null); // "send" | "accept" | "dismiss"
  const [busyAct, setBusyAct] = useState(false);
  const [toast, setToast] = useState(null);
  const [wide, setWide] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(min-width: 768px)").matches);
  const saveTimer = useRef(0);
  const tick = reviewTick.value;

  async function load({ quiet = false } = {}) {
    try {
      const r = await reviewApi.get(id);
      // локальные черновики новее серверных — дослать (N-7)
      const local = localDrafts(user, id);
      for (const [cid, ld] of Object.entries(local)) {
        const srv = r.comments.find((c) => c.id === cid);
        if (srv && srv.state !== "draft") { saveLocalDraft(user, id, cid, null); continue; }
        if (!srv || (ld.at > (srv.updatedAt ?? 0) && ld.text !== srv.text)) {
          try {
            const out = await reviewApi.putComment(id, cid, { ...ld, version: srv?.version ?? 0 });
            const i = r.comments.findIndex((c) => c.id === cid);
            if (i >= 0) r.comments[i] = out.comment;
            else r.comments.push(out.comment);
          } catch {}
        }
        saveLocalDraft(user, id, cid, null);
      }
      setD(r);
      setErr(null);
      setOffline(false);
    } catch (e) {
      if (e.status === 404) setErr("gone");
      else if (!e.status) setOffline(true);
      else if (!quiet) setErr(e.message);
    }
  }
  useEffect(() => { load(); }, [id]);
  useEffect(() => { if (tick) load({ quiet: true }); }, [tick]);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const m = matchMedia("(min-width: 768px)");
    const f = () => setWide(m.matches);
    m.addEventListener?.("change", f);
    return () => m.removeEventListener?.("change", f);
  }, []);

  const files = d?.fileList ?? [];
  const shown = since && d?.sinceFiles ? files.filter((f) => d.sinceFiles.includes(f.path)) : files;
  const cur = files.find((f) => f.path === open) ?? null;
  const drafts = (d?.comments ?? []).filter((c) => c.state === "draft" && (c.text ?? "").trim());
  const general = (d?.comments ?? []).find((c) => c.side === "general" && c.state === "draft") ?? null;
  const closed = d && !["pending", "returned", "interrupted"].includes(d.state);

  useEffect(() => {
    if (!d || !open) return setDiff(null);
    let alive = true;
    setDiff(null);
    reviewApi.diff(id, { file: open, since: since && d.sinceRevision ? d.sinceRevision : null, full }).then(
      (r) => alive && setDiff(r),
      (e) => alive && setDiff({ error: e.message }),
    );
    if (!closed && !files.find((f) => f.path === open)?.reviewed) reviewApi.viewed(id, open).then(() => load({ quiet: true }), () => {});
    return () => { alive = false; };
  }, [open, since, full, d?.revision]);

  useEffect(() => {
    if (!d) return;
    const k = (e) => {
      if (e.target?.closest?.("textarea, input") || sheet || edit) return;
      const list = shown.map((f) => f.path);
      const i = list.indexOf(open);
      if (e.key === "j" && list.length) setOpen(list[Math.min(list.length - 1, i + 1)]);
      if (e.key === "k" && list.length) setOpen(list[Math.max(0, i - 1)]);
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [d, open, sheet, edit, since]);

  function flash(text) {
    setToast(text);
    setTimeout(() => setToast(null), 5000);
  }

  // ---- черновики ---------------------------------------------------------------
  // Сохранения одного комментария идут по очереди и с последней известной версией:
  // отложенное сохранение при вводе и «Добавить» не спорят друг с другом (409 был ложным).
  const versions = useRef({});
  const queue = useRef({});
  const editRef = useRef(null);
  editRef.current = edit;
  function saveComment(c, opts = {}) {
    const run = () => doSave(c, opts);
    const p = (queue.current[c.id] ?? Promise.resolve()).then(run, run);
    queue.current[c.id] = p;
    return p;
  }
  async function doSave(c, { close = false } = {}) {
    saveLocalDraft(user, id, c.id, c);
    const body = { ...c, version: versions.current[c.id] ?? c.version ?? 0 };
    try {
      const out = await reviewApi.putComment(id, c.id, body);
      versions.current[c.id] = out.comment.version;
      saveLocalDraft(user, id, c.id, null);
      setD((x) => x && { ...x, comments: x.comments.some((y) => y.id === c.id) ? x.comments.map((y) => (y.id === c.id ? out.comment : y)) : [...x.comments, out.comment] });
      setEdit((e) => (e && e.c.id === c.id ? { ...e, c: { ...e.c, version: out.comment.version }, savedAt: Date.now(), offline: false } : e));
      if (close) setEdit(null);
      return out.comment;
    } catch (e) {
      const cur = e.body?.current;
      if (e.status === 409 && e.body?.code === "version" && cur && cur.text === c.text) {
        versions.current[c.id] = cur.version; // тот же текст — не конфликт
        saveLocalDraft(user, id, c.id, null);
        if (close) setEdit(null);
        return cur;
      }
      if (e.status === 409 && e.body?.code === "version") setConflict({ mine: c, theirs: cur });
      else if (!e.status) setEdit((x) => x && { ...x, offline: true });
      else setNotice(e.message, 8000);
      return null;
    }
  }
  function typed(text) {
    const cur = editRef.current;
    if (!cur) return;
    const next = { ...cur, c: { ...cur.c, text }, dirty: true };
    setEdit(next);
    saveLocalDraft(user, id, next.c.id, next.c);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { if (editRef.current?.c.id === next.c.id) saveComment(editRef.current.c); }, SAVE_MS);
  }
  function newComment(base) {
    const c = { id: newCommentId(), version: 0, revision: d.revision, text: "", ...base };
    setEdit({ c, isNew: true });
  }
  async function closeEdit({ cancel = false } = {}) {
    clearTimeout(saveTimer.current);
    const e = edit;
    if (!e) return;
    if (cancel && e.isNew) {
      saveLocalDraft(user, id, e.c.id, null);
      await queue.current[e.c.id]?.catch(() => {});
      const v = versions.current[e.c.id] ?? e.c.version ?? 0;
      if (v > 0) await reviewApi.deleteComment(id, e.c.id, v).catch(() => {});
      setD((x) => x && { ...x, comments: x.comments.filter((y) => y.id !== e.c.id) });
      setEdit(null);
      return;
    }
    if (!e.c.text.trim()) return setEdit(null);
    await saveComment(e.c, { close: true });
  }
  async function del(c) {
    try {
      await queue.current[c.id]?.catch(() => {});
      await reviewApi.deleteComment(id, c.id, versions.current[c.id] ?? c.version);
      saveLocalDraft(user, id, c.id, null);
      setD((x) => x && { ...x, comments: x.comments.filter((y) => y.id !== c.id) });
    } catch (e) {
      setNotice(e.message, 8000);
    }
  }

  // ---- действия ------------------------------------------------------------------
  async function refresh() {
    setBusyAct(true);
    try {
      await reviewApi.refresh(id);
      await load();
    } catch (e) {
      setNotice(e.message, 8000);
    } finally {
      setBusyAct(false);
    }
  }
  async function accept(commit) {
    setBusyAct(true);
    const key = sessionStorage.getItem(`teleharness.rv.acc.${id}`) ?? newKey("acc");
    sessionStorage.setItem(`teleharness.rv.acc.${id}`, key);
    try {
      const r = await reviewApi.accept(id, { key, revision: d.revision });
      sessionStorage.removeItem(`teleharness.rv.acc.${id}`);
      setSheet(null);
      if (commit && d.sid) {
        giveReviewSelection(d.sid, r.files);
        navigate(`/git/${encodeURIComponent(d.sid)}`);
        return;
      }
      flash(t("review.flash.accepted", { files: filesWord(r.files.length) }));
      await load();
    } catch (e) {
      sessionStorage.removeItem(`teleharness.rv.acc.${id}`);
      setSheet({ kind: "accept", error: e.body ?? { error: e.status ? e.message : t("plan.err.offline") } });
      if (e.status === 409) load({ quiet: true });
    } finally {
      setBusyAct(false);
    }
  }
  async function dismiss() {
    setBusyAct(true);
    try {
      await reviewApi.dismiss(id, { key: newKey("dis") });
      navigate("/board/review");
    } catch (e) {
      setNotice(e.message, 8000);
    } finally {
      setBusyAct(false);
    }
  }

  // ---- экраны ----------------------------------------------------------------------
  const head = (sub) => (
    <>
      {/* BUG-277: заголовок и подзаголовок — по центру, как у «Доски» и чата (макет T-2);
          «‹ Ждёт ревью» — своей строкой под шапкой, а не над заголовком */}
      <header class="page-header rv-header">
        <MenuButton />
        <div class="rv-title">
          <h1>{open && !wide ? splitPath(open).name : t("review.title")}</h1>
          {sub && <p class="rv-sub">{sub}</p>}
        </div>
        <span aria-hidden="true" />
      </header>
      <a class="rv-back" href={open && !wide ? undefined : "#/board/review"} role={open && !wide ? "button" : undefined} tabIndex={0} onClick={(e) => { if (open && !wide) { e.preventDefault(); setOpen(null); } }}>‹ {open && !wide ? t("review.back.files") : t("review.back.queue")}</a>
    </>
  );

  if (err === "gone") {
    return (
      <div class="page review-view">{head(null)}
        <div class="bd-gone" role="alert" data-req="FEAT-20.1 кр. 16">
          <h2>{t("review.gone.title")}</h2>
          <p>{t("review.gone.text")}</p>
          <a class="bd-btn bd-primary" href="#/board/review">{t("review.gone.back")}</a>
        </div>
      </div>
    );
  }
  if (!d) {
    return (
      <div class="page review-view">{head(null)}
        {offline || err ? (
          <div class="bd-gone" role="alert">
            <h2>{t("review.offline")}</h2>
            <p>{err && err !== "gone" ? err : t("review.loadErr.text")}</p>
            <button type="button" class="bd-btn bd-primary" onClick={() => load()}>{t("review.retry")}</button>
          </div>
        ) : (
          <div class="bd-skeleton" role="status" aria-label={t("review.loadingAria")}><div class="sk bd-sk-h" /><div class="sk bd-sk-row" /><div class="sk bd-sk-row" /><div class="sk bd-sk-row" /></div>
        )}
      </div>
    );
  }

  const viewed = files.filter((f) => f.reviewed).length;
  const cannotAccept = closed ? t("review.cannotAccept.closed") : d.busy ? t("review.cannotAccept.busy") : d.stale ? t("review.cannotAccept.stale", { n: d.stale.revision }) : null;
  // BUG-277: подзаголовок — название чата (макет T-2); ревизия, ходы, файлы и модель — в сводке
  const sub = d.title;
  const facts = `${t("review.rev", { n: d.revision })} · ${turnsWord(d.turns)} · ${filesWord(d.files)}${d.model ? " · " + shortModel(d.model) : ""}`;
  const fileComments = (path) => (d.comments ?? []).filter((c) => c.file === path && c.side !== "general" && c.revision <= d.revision);

  const list = (
    <section class="rv-files" aria-label={t("review.filesAria")}>
      <div class="rv-summary">
        <StatusChip status={d.status} />
        <span class="rv-facts">{facts}</span>
        <span>{t("review.viewed", { viewed, total: files.length })}</span>
        <span>{commentsWord(drafts.length)}</span>
      </div>
      {d.sinceRevision != null && d.mode === "snapshot" && (
        <div class="rv-seg" role="group" aria-label={t("review.showGroupAria")}>
          <button type="button" aria-pressed={since ? "true" : "false"} onClick={() => setSince(true)}>{t("review.sinceLast", { count: d.sinceFiles?.length ?? 0 })}</button>
          <button type="button" aria-pressed={since ? "false" : "true"} onClick={() => setSince(false)}>{t("review.allFiles", { count: files.length })}</button>
        </div>
      )}
      <ul class="rv-file-list">
        {shown.map((f) => {
          const { name, dir } = splitPath(f.path);
          const n = fileComments(f.path).filter((c) => c.state === "draft").length;
          return (
            <li key={f.path}>
              <button type="button" class={"rv-file" + (f.path === open ? " is-open" : "")} aria-current={f.path === open ? "true" : undefined} onClick={() => setOpen(f.path)}>
                <FileLetter status={f.status} />
                <span class="rv-file-main">
                  <span class="rv-file-name">{name}</span>
                  <span class="rv-file-dir"><span class="rv-path"><bdi>{dir || t("review.projectRoot")}</bdi></span><span class="rv-file-what">&nbsp;· {f.status === "R" && f.oldPath ? t("review.renamedFrom", { name: splitPath(f.oldPath).name }) : STATUS_LETTER[f.status] ?? STATUS_LETTER.M}{f.binary ? t("review.binaryTag") : ""}{f.big ? t("review.bigTag") : ""}</span></span>
                </span>
                <span class="rv-file-stat"><span class="rv-plus">+{f.additions}</span> <span class="rv-minus">−{f.deletions}</span>{n > 0 && <span class="rv-cnt" aria-label={commentsWord(n)}>💬{n}</span>}</span>
                <span class={"rv-check" + (f.reviewed ? " is-on" : "")} role="img" aria-label={f.reviewed ? t("review.reviewed") : t("review.notReviewed")}>{f.reviewed ? "✓" : ""}</span>
              </button>
            </li>
          );
        })}
        {shown.length === 0 && <li class="rv-hint">{t("review.noChangesSince")}</li>}
      </ul>
      <div class="rv-general">
        {general ? <CommentCard c={general} onEdit={(c) => setEdit({ c })} onDelete={del} /> : !closed && <button type="button" class="bd-btn" onClick={() => newComment({ side: "general", file: null })}>{t("review.addGeneralComment")}</button>}
      </div>
      {!closed && <button type="button" class="rv-link is-danger rv-dismiss" onClick={() => setSheet({ kind: "dismiss" })}>{t("review.dismissLink")}</button>}
    </section>
  );

  const fileView = cur && (
    <section class="rv-file-view" aria-label={t("review.fileAria", { path: cur.path })}>
      <div class="rv-file-head">
        <FileLetter status={cur.status} />
        <div class="rv-file-main"><b class="rv-file-name">{splitPath(cur.path).name}</b><span class="rv-file-dir"><span class="rv-path"><bdi>{cur.path}</bdi></span>{cur.oldPath ? <span class="rv-file-what">&nbsp;← {cur.oldPath}</span> : null}</span></div>
        <span class="rv-file-stat"><span class="rv-plus">+{cur.additions}</span> <span class="rv-minus">−{cur.deletions}</span></span>
      </div>
      {!diff ? <div class="bd-skeleton" role="status" aria-label={t("review.loadingDiffAria")}><div class="sk bd-sk-row" /><div class="sk bd-sk-row" /></div>
        : diff.error ? <div class="rv-note" role="alert">{diff.error}</div>
        : <FileDiff d={diff} item={d} file={cur} comments={fileComments(cur.path)} showAll={() => setFull(true)}
            onComment={(sc) => newComment({ side: sc.side, file: cur.path, oldPath: cur.oldPath ?? null, from: sc.from, to: sc.to, quote: sc.quote })}
            onFileComment={() => newComment({ side: "file", file: cur.path, oldPath: cur.oldPath ?? null })}
            onEdit={(c) => setEdit({ c })} onDelete={del} />}
      {(() => {
        const listP = shown.map((f) => f.path);
        const i = listP.indexOf(cur.path);
        return i >= 0 && i < listP.length - 1 ? <button type="button" class="bd-btn rv-next" onClick={() => { setOpen(listP[i + 1]); setFull(false); }}>{t("review.nextFile")}</button> : null;
      })()}
    </section>
  );

  return (
    <div class={"page review-view" + (wide ? " is-wide" : "")} data-req="FEAT-20.1">
      {head(sub)}
      {offline && <div class="bd-banner is-offline" role="status"><b>{t("review.offline")}</b> · {t("review.offlineDraftsHint", { hhmm: hhmm(Date.now()) })} <button type="button" class="bd-btn" onClick={() => load()}>{t("review.retry")}</button></div>}
      {d.state === "accepted" && <div class="bd-banner" role="status">{t("review.banner.accepted", { hhmm: hhmm(d.accept?.at), files: filesWord(d.accept?.files?.length ?? 0) })}</div>}
      {d.state === "dismissed" && <div class="bd-banner" role="status">{t("review.banner.dismissed", { hhmm: hhmm(d.dismissed?.at) })}</div>}
      {d.status === "chat-deleted" && <div class="bd-banner" role="status"><b>{t("review.chatDeletedTitle")}</b>{t("review.chatDeletedDesc")}<button type="button" class="bd-btn" onClick={() => setSheet({ kind: "dismiss" })}>{t("review.chatDeletedDismiss")}</button></div>}
      {!closed && d.busy && <div class="bd-banner" role="status"><b>{t("review.banner.busyTitle")}</b> — {t("review.banner.busyHint")}</div>}
      {!closed && d.status === "returned" && !d.busy && <div class="bd-banner" role="status">{t("review.banner.returned")}</div>}
      {!closed && d.stale && (
        <div class="bd-banner" role="status" data-req="FEAT-20.1 кр. 9">
          <b>{t("review.banner.staleTitle")}</b> {t("review.banner.staleHint", { files: filesWord(d.stale.files), rev: d.revision })}
          <button type="button" class="bd-btn bd-primary" disabled={busyAct || d.busy} onClick={refresh}>{t("review.banner.updateTo", { rev: d.stale.revision })}</button>
        </div>
      )}
      {d.mode === "turns" && <p class="rv-hint" role="note">{MODE_REASON[d.modeReason] ?? t("review.mode.fallback")}</p>}
      <div class="rv-body">
        {(!open || wide) && list}
        {open ? fileView : wide && <section class="rv-file-view rv-empty-file"><p class="rv-hint">{t("review.emptyFileHint")}</p></section>}
      </div>
      {!closed && (
        <footer class="rv-bar">
          <div class="rv-bar-btns">
            <button type="button" class="bd-btn" disabled={drafts.length === 0 || d.status === "chat-deleted"} onClick={() => setSheet({ kind: "send" })}>{t("review.btn.return", { count: drafts.length })}</button>
            <button type="button" class="bd-btn bd-primary" aria-disabled={cannotAccept ? "true" : "false"} onClick={() => !cannotAccept && setSheet({ kind: "accept" })}>{t("review.btn.accept")}</button>
          </div>
          {cannotAccept && <p class="rv-bar-why">{cannotAccept}</p>}
        </footer>
      )}
      {toast && <div class="rv-toast" role="status">{toast}</div>}
      {edit && (
        <Sheet title={edit.c.side === "general" ? t("review.comment.general") : edit.c.side === "file" ? t("review.sheet.fileComment", { name: splitPath(edit.c.file).name }) : t("review.sheet.lineComment", { where: commentLabel(edit.c).toLowerCase() })} onClose={() => closeEdit()}>
          {edit.c.quote?.length > 0 && <pre class="rv-quote">{edit.c.quote.slice(0, 8).join("\n")}{edit.c.quote.length > 8 ? `\n${t("review.quoteMore", { count: edit.c.quote.length - 8 })}` : ""}</pre>}
          <textarea class="rv-textarea" rows={4} maxLength={4000} autoFocus aria-label={t("review.commentTextAria")} value={edit.c.text}
            onInput={(e) => typed(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeEdit(); } }} />
          <p class="rv-hint" aria-live="polite">{edit.offline ? t("review.draft.offline") : edit.savedAt ? t("review.draft.savedAt", { hhmm: hhmm(edit.savedAt) }) : t("review.draft.auto")}</p>
          <div class="bd-dialog-actions">
            <button type="button" class="bd-btn" onClick={() => closeEdit({ cancel: true })}>{t("plan.cancel")}</button>
            <button type="button" class="bd-btn bd-primary" disabled={!edit.c.text.trim()} onClick={() => closeEdit()}>{edit.isNew ? t("review.btn.add") : t("review.btn.save")}</button>
          </div>
        </Sheet>
      )}
      {conflict && (
        <Sheet title={t("review.conflict.title")} onClose={() => setConflict(null)}>
          <p class="rv-hint">{t("review.conflict.theirs", { text: conflict.theirs?.text })}</p>
          <p class="rv-hint">{t("review.conflict.mine", { text: conflict.mine?.text })}</p>
          <div class="bd-dialog-actions">
            <button type="button" class="bd-btn" onClick={() => { setD((x) => ({ ...x, comments: x.comments.map((c) => (c.id === conflict.theirs.id ? conflict.theirs : c)) })); setEdit(null); saveLocalDraft(user, id, conflict.theirs.id, null); setConflict(null); }}>{t("review.conflict.takeTheirs")}</button>
            <button type="button" class="bd-btn bd-primary" onClick={() => { versions.current[conflict.mine.id] = conflict.theirs.version; const m = conflict.mine; setConflict(null); saveComment(m, { close: true }); }}>{t("review.conflict.keepMine")}</button>
          </div>
        </Sheet>
      )}
      {sheet?.kind === "send" && <SendSheet item={d} general={general} onClose={() => setSheet(null)} onSent={(r) => { setSheet(null); flash(r.already ? t("review.flash.alreadySent", { hhmm: hhmm(r.at) }) : t("review.flash.sent", { comments: commentsWord(r.count) })); load(); }} />}
      {sheet?.kind === "accept" && (
        <Sheet title={t("review.accept.title")} onClose={() => setSheet(null)}>
          <p>{t("review.accept.summary", { files: filesWord(files.length), rev: d.revision })}</p>
          {files.length - viewed > 0 && <p class="rv-warn">⚠ {t("review.accept.unviewed", { files: filesWord(files.length - viewed) })}</p>}
          {drafts.length > 0 && <p class="rv-warn">⚠ {t("review.accept.unsent", { comments: commentsWord(drafts.length) })}</p>}
          {sheet.error && <p class="rv-error" role="alert">{sheet.error.code === "already" ? t("review.accept.already", { hhmm: hhmm(sheet.error.at) }) : sheet.error.error}</p>}
          <div class="bd-dialog-actions rv-col">
            {d.mode === "snapshot" && <button type="button" class="bd-btn" disabled={busyAct} onClick={() => accept(true)}>{t("review.accept.commitBtn")}</button>}
            <button type="button" class="bd-btn bd-primary" disabled={busyAct} onClick={() => accept(false)}>{t("review.btn.accept")}</button>
            <button type="button" class="bd-btn" onClick={() => setSheet(null)}>{t("plan.cancel")}</button>
          </div>
        </Sheet>
      )}
      {sheet?.kind === "dismiss" && (
        <Sheet title={t("review.dismiss.title")} onClose={() => setSheet(null)}>
          <p>{drafts.length > 0 ? t("review.dismiss.withDrafts", { count: drafts.length }) : t("review.dismiss.noDrafts")} {t("review.dismiss.filesUnchanged")}</p>
          <div class="bd-dialog-actions">
            <button type="button" class="bd-btn" onClick={() => setSheet(null)}>{t("plan.cancel")}</button>
            <button type="button" class="bd-btn bd-primary is-danger" disabled={busyAct} onClick={dismiss}>{drafts.length > 0 ? t("review.dismiss.btnWithDrafts") : t("review.dismiss.btn")}</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

// Лист «Вернуть агенту»: превью одного сообщения, очередь по движку, повтор с тем же ключом.
function SendSheet({ item, general, onClose, onSent }) {
  const [pv, setPv] = useState(null);
  const [state, setState] = useState({ busy: false, error: null });
  const keyName = `teleharness.rv.send.${item.id}.${item.revision}`;
  useEffect(() => {
    reviewApi.preview(item.id, "").then(setPv, (e) => setState({ busy: false, error: e.message }));
  }, []);
  async function send() {
    setState({ busy: true, error: null });
    const key = sessionStorage.getItem(keyName) ?? newKey("snd");
    sessionStorage.setItem(keyName, key); // повтор после обрыва — тот же ключ (N-5, N-6)
    try {
      const r = await reviewApi.send(item.id, { key, revision: item.revision });
      sessionStorage.removeItem(keyName);
      onSent(r);
    } catch (e) {
      if (e.status && e.status !== 502 && e.body?.code !== "in-progress") sessionStorage.removeItem(keyName);
      setState({ busy: false, error: !e.status ? t("review.send.offline") : e.status === 429 || /limit|лимит/i.test(e.body?.detail ?? "") ? t("review.send.limit", { detail: e.body?.detail ?? "" }) : e.message });
    }
  }
  const engineNote = item.engine === "opencode" ? t("review.send.busyOpencode") : t("review.send.busyOther");
  return (
    <Sheet title={t("review.send.title", { count: pv?.count ?? "…" })} onClose={onClose} wide>
      <p class="rv-hint">{t("review.send.sub", { model: item.model ? ` · ${shortModel(item.model)}` : "" })}</p>
      {pv?.busy && <p class="rv-warn" role="status">{engineNote}</p>}
      {pv?.shortened && !pv.tooLong && <p class="rv-warn" role="status">{t("review.send.shortened", { lines: pv.quoteLines })}</p>}
      {pv?.tooLong && <p class="rv-error" role="alert">{t("review.send.tooLong")}</p>}
      {pv ? <pre class="rv-preview" tabIndex={0} aria-label={t("review.send.previewAria")}>{pv.text.replace(/\n<!-- teleharness-review:[^>]+-->\s*$/, "")}</pre> : <div class="bd-skeleton" role="status" aria-label={t("review.send.preparingAria")}><div class="sk bd-sk-row" /></div>}
      {state.error && <p class="rv-error" role="alert">{state.error}</p>}
      <div class="bd-dialog-actions">
        <button type="button" class="bd-btn" onClick={onClose}>{t("plan.cancel")}</button>
        <button type="button" class="bd-btn bd-primary" disabled={!pv || pv.tooLong || pv.count === 0 || state.busy} onClick={send}>{state.busy ? t("review.send.sending") : state.error ? t("review.send.retryBtn") : t("review.send.sendBtn")}</button>
      </div>
    </Sheet>
  );
}
