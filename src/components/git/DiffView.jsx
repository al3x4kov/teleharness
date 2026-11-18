// FEAT-18.8: the diff of one file (design/mockups-v2/changes-git.html, frames
// 3, 7, 8). Phone: a full-screen layer — one column, wrapped lines, «+»/«−»
// in their own column (colour is not the only carrier), unchanged runs
// collapsed («▾ N строк без изменений», tap unfolds when the lines are
// known). «Этот ход» / «Сейчас vs коммит» (the latter — GET /git/diff, only
// when the folder is a repo), «1 из N ›» to the next file, ⧉ copies the patch.
// A big diff shows its first 400 lines + «Показать всё» / «Скачать патч».
// ≥ 1024 px (CSS): the file list on the left, the diff on the right.
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { useModalFocus } from "../Pickers.jsx";
import { api } from "../../lib/api.js";
import { copyText } from "../../lib/clipboard.js";
import { gitErrorText } from "../../lib/git-client.js";
import { t } from "../../lib/i18n.js";
import {
  BIG_LINES, bigCount, fileSub, filesLabel, fmtNum, hunkTitle, limitHunks, lineCount, lineNo, parseUnified, toUnified, unchangedLabel,
} from "../../lib/diff.js";
import "./git.css";

const MINUS = "−";

export function StatusBox({ status }) {
  const s = status === "?" ? "?" : status || "M";
  return <span class={"st st-" + (s === "?" ? "U" : s)} aria-hidden="true">{s}</span>;
}

export function Nums({ a = 0, d = 0, showZero = false, binary = false }) {
  // TASK-18.13 D12: a binary file has no line counts — not «+0»
  if (binary) return <span class="dnum"><span class="bin">{t("git.diff.binaryShort")}</span></span>;
  return (
    <span class="dnum">
      {(a > 0 || showZero || d === 0) && <span class="p">+{fmtNum(a)}</span>}
      {a > 0 && d > 0 ? " " : ""}
      {d > 0 && <span class="m">{MINUS}{fmtNum(d)}</span>}
    </span>
  );
}

// A file row of the sheet / the side list: status box, name (always visible),
// folder cut from the start + status word, +/− and ›.
export function FileRow({ f, onOpen, active = false, short = false, chevron = true }) {
  return (
    <button type="button" class={"frow" + (active ? " on" : "")} aria-current={active ? "true" : undefined} onClick={onOpen}>
      <StatusBox status={f.status} />
      <span class="fn">
        <b>{f.name}</b>
        <span class={"fn-sub" + (f.dir ? "" : " is-label")}><bdi>{fileSub(f, { short })}</bdi></span>
      </span>
      <Nums a={f.additions} d={f.deletions} binary={f.binary === true} />
      {chevron && <span class="chev" aria-hidden="true">›</span>}
    </button>
  );
}

function Line({ l }) {
  const cls = l.t === "+" ? " add" : l.t === "-" ? " del" : "";
  const no = lineNo(l);
  return (
    <div class={"ln" + cls}>
      <span class="n" aria-hidden={no == null ? "true" : undefined}>{no ?? ""}</span>
      <span class="s">{l.t === "+" ? "+" : l.t === "-" ? MINUS : " "}</span>
      <span class="c">{l.text}</span>
    </div>
  );
}

// The hunks of one file. gap → «▾ N строк без изменений» (a button when the
// lines are known — tap unfolds them).
export function DiffBody({ hunks }) {
  const [open, setOpen] = useState(() => new Set());
  return (
    <div class="diff" role="group" aria-label={t("git.diff.fileAria")}>
      {hunks.map((h, i) => (
        <div class="hk" key={i}>
          {h.gap > 0 && i > 0 && (
            Array.isArray(h.gapLines) && h.gapLines.length === h.gap ? (
              open.has(i) ? (
                h.gapLines.map((l, k) => <Line l={l} key={"g" + k} />)
              ) : (
                <button type="button" class="gap" aria-expanded="false" onClick={() => setOpen(new Set([...open, i]))}>▾ {unchangedLabel(h.gap)}</button>
              )
            ) : (
              <div class="gap is-static">{unchangedLabel(h.gap)}</div>
            )
          )}
          <div class="hunk">{hunkTitle(h)}</div>
          {h.lines.map((l, k) => <Line l={l} key={k} />)}
        </div>
      ))}
    </div>
  );
}

function download(name, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "text/x-diff" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.patch`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {}
}

// The git side of a file: GET /git/diff → {phase, hunks, additions, deletions, truncated, binary, patch}.
function useGitDiff(where, file, on, client) {
  const [st, setSt] = useState({ phase: "idle" });
  const [full, setFull] = useState(false);
  const key = `${where?.sid ?? ""}|${where?.directory ?? ""}|${file ?? ""}|${full}`;
  useEffect(() => {
    setFull(false);
  }, [file]);
  useEffect(() => {
    if (!on || !file) return undefined;
    let live = true;
    setSt({ phase: "loading" });
    client.gitDiff(where, file, { full }).then(
      (r) => {
        if (!live) return;
        const pf = parseUnified(r?.patch ?? "")[0] ?? null;
        setSt({
          phase: "ready",
          hunks: pf?.hunks ?? [],
          additions: Number(r?.additions ?? pf?.additions ?? 0) || 0,
          deletions: Number(r?.deletions ?? pf?.deletions ?? 0) || 0,
          truncated: r?.truncated === true,
          binary: r?.binary === true || pf?.binary === true,
          patch: r?.patch ?? "",
          oldPath: typeof r?.oldPath === "string" && r.oldPath ? r.oldPath : null,
        });
      },
      (err) => live && setSt({ phase: "error", text: gitErrorText(err, t("git.diff.loadFailed")) }),
    );
    return () => {
      live = false;
    };
  }, [key, on]);
  return [st, () => setFull(true), full];
}

// files: [{path, name, dir, status, additions, deletions, hunks?, partial, rewritten, binary, gitPath?}]
// mode: "turn" (hunks from the turn; switch to git when canGit) | "git".
export default function DiffView({ files, index = 0, mode: mode0 = "turn", where = null, canGit = false, listTitle = null, aside = null, onClose, client = api }) {
  const [idx, setIdx] = useState(Math.min(Math.max(0, index), Math.max(0, files.length - 1)));
  const [mode, setMode] = useState(mode0);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(null);
  const ref = useRef(null);
  useModalFocus(ref, { inertShell: true });
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    addEventListener("keydown", onKey);
    ref.current?.focus?.({ preventScroll: true });
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, []);
  useEffect(() => {
    setShowAll(false);
    setCopied(null);
    const sc = ref.current?.querySelector?.(".dv-scroll");
    if (sc) sc.scrollTop = 0;
  }, [idx, mode]);

  const f = files[idx] ?? files[0];
  const gitOn = mode === "git";
  const [g, loadFull, isFull] = useGitDiff(where, f?.gitPath ?? f?.path, gitOn, client);
  if (!f) return null;

  const hunks = gitOn ? (g.phase === "ready" ? g.hunks : []) : f.hunks ?? [];
  const adds = gitOn && g.phase === "ready" ? g.additions : f.additions;
  const dels = gitOn && g.phase === "ready" ? g.deletions : f.deletions;
  const total = lineCount(hunks);
  const big = gitOn ? g.truncated || (!showAll && total > BIG_LINES) : !showAll && total > BIG_LINES;
  const shown = big && !(gitOn && g.truncated) ? limitHunks(hunks, BIG_LINES) : hunks;
  const changedLines = adds + dels;
  const isBinary = gitOn ? g.phase === "ready" && g.binary : f.binary === true;
  const oldPath = gitOn && g.phase === "ready" ? g.oldPath : f.status === "R" ? f.oldPath ?? null : null;
  const patchText = () => (gitOn ? g.patch ?? "" : toUnified(f));

  const copy = async () => {
    const ok = await copyText(patchText());
    setCopied(ok ? "ok" : "fail");
    setTimeout(() => setCopied(null), 1600);
  };
  // TASK-18.13 D2: one tap — the full diff is fetched AND shown (showAll set
  // too, or the fetched 900 lines were cut back to 400 until a second tap)
  const showAllNow = () => {
    if (gitOn && g.truncated) loadFull();
    setShowAll(true);
  };
  const downloadNow = async () => {
    if (gitOn && g.truncated && !isFull) {
      try {
        const r = await client.gitDiff(where, f.gitPath ?? f.path, { full: true });
        download(f.name, r?.patch ?? "");
      } catch {}
      return;
    }
    download(f.name, patchText());
  };

  const next = () => setIdx((i) => (i + 1) % files.length);
  const n = files.length;
  const bigCountText = changedLines >= 1000 ? t("git.diff.bigLinesK", { n: bigCount(changedLines) }) : t("git.diff.lines", { count: changedLines });

  let content;
  if (gitOn && (g.phase === "loading" || g.phase === "idle")) {
    content = <div class="diff is-loading" role="status" aria-label={t("git.diff.loading")} />;
  } else if (gitOn && g.phase === "error") {
    content = <div class="gcard warn" role="alert"><b><i aria-hidden="true">!</i>{t("git.diff.notLoaded")}</b><div class="muted">{g.text}</div></div>;
  } else if ((gitOn ? g.binary : f.binary)) {
    content = <div class="gcard"><b>{t("git.diff.binary")}</b><div class="muted">{t("git.diff.binaryNote")}</div></div>;
  } else if (hunks.length === 0 && oldPath) {
    content = <div class="gcard"><b>{t("git.diff.renameOnly")}</b><div class="muted">{t("git.diff.renameOnlyNote", { path: oldPath })}</div></div>;
  } else if (hunks.length === 0) {
    content = gitOn ? (
      <div class="gcard"><b>{t("git.noChanges")}</b><div class="muted">{t("git.diff.sameAsCommit")}</div></div>
    ) : (
      <div class="gcard"><b>{t("git.diff.unknownLines")}</b><div class="muted">{t("git.diff.unknownLinesNote")}</div></div>
    );
  } else {
    content = (
      <>
        {big && (
          <div class="gcard big-note">
            <div class="muted">{t("git.diff.big", { lines: bigCountText, n: BIG_LINES })}</div>
            <div class="btns">
              <button type="button" class="gbtn" onClick={showAllNow}>{t("git.diff.showAll")}</button>
              <button type="button" class="gbtn" onClick={downloadNow}>{t("git.diff.download")}</button>
            </div>
          </div>
        )}
        {!gitOn && f.partial && <p class="muted dv-partial">{t("git.diff.partial")}</p>}
        <DiffBody hunks={shown} key={`${idx}|${mode}|${showAll}|${isFull}`} />
      </>
    );
  }

  const title = listTitle ?? `${t("git.changes.title")} · ${filesLabel(n)}`;
  return createPortal(
    <div class="dv" role="dialog" aria-modal="true" aria-label={t("git.diff.aria", { name: f.name })} tabIndex={-1} ref={ref} data-feat="FEAT-18.8">
      <aside class="dv-side" aria-label={title}>
        <h2 class="dv-side-title">{title}</h2>
        <div class="dv-side-list">
          {files.map((x, i) => <FileRow key={x.key ?? x.path} f={x} short chevron={false} active={i === idx} onOpen={() => setIdx(i)} />)}
        </div>
        {aside}
      </aside>
      <div class="dv-main">
        <header class="dv-top">
          <button class="icon-btn float-btn" type="button" aria-label={t("common.back")} onClick={onClose}>‹</button>
          <div class="tt">
            <b>{f.name}</b>
            <span><bdi>{f.dir || t("git.projectRoot")}</bdi> · <Nums a={adds} d={dels} binary={isBinary} /></span>
            {oldPath && <span class="dv-renamed">{t("git.diff.renamedFrom")} <bdi>{oldPath}</bdi></span>}
          </div>
          <button class="icon-btn float-btn" type="button" aria-label={t("git.diff.copy")} title={t("git.diff.copy")} onClick={copy}>⧉</button>
        </header>
        <span class="sr-only" role="status" aria-live="polite">{copied === "ok" ? t("common.copied") : copied === "fail" ? t("git.diff.copyFailed") : ""}</span>
        <div class="dhead">
          {canGit && mode0 === "turn" ? (
            <div class="dseg" role="group" aria-label={t("git.diff.compare")}>
              <button type="button" class={mode === "turn" ? "on" : ""} aria-pressed={mode === "turn" ? "true" : "false"} onClick={() => setMode("turn")}>{t("git.diff.thisTurn")}</button>
              <button type="button" class={mode === "git" ? "on" : ""} aria-pressed={mode === "git" ? "true" : "false"} onClick={() => setMode("git")}>{t("git.diff.nowVsCommit")}</button>
            </div>
          ) : null}
          {n > 1 && (
            <button type="button" class="dv-next" aria-label={t("git.diff.nextAria", { i: idx + 1, n })} onClick={next}>
              {t("git.diff.ofN", { i: idx + 1, n })} ›
            </button>
          )}
          {copied && <span class="dv-copied" aria-hidden="true">{copied === "ok" ? t("common.copied") : t("git.diff.notCopied")}</span>}
        </div>
        <div class="dv-scroll">{content}</div>
      </div>
    </div>,
    document.body,
  );
}
