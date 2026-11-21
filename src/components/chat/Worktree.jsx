// FEAT-20.7: рабочая копия чата в интерфейсе — чип «Отдельная копия» в пустом
// чате и лист настроек (T-1, T-2, T-5), пилюля ветки в шапке (T-3), полоса над
// композером (создание, ошибки, пересечения — T-6, T-8, T-12, T-16), лист
// «Рабочая копия» (T-4), слияние и его шаги/итоги (T-9…T-11, T-13), лист
// пересечения (T-7), удаление чата с копией (T-14).
// Макет: design/mockups-v2/epic20-worktrees.html; бриф BRIEF-20.7-worktrees.md.
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { PickerSheet } from "../Pickers.jsx";
import { Modal } from "../views/HomeView.jsx";
import { navigate } from "../../lib/router.js";
import { gitHash } from "../../lib/git-client.js";
import { busyMap, connection, resendLast, send, setNotice } from "../../lib/store.js";
import {
  STEP_ICON, WT_KIND_TITLE, aheadLine, clearWorktreeError, filesWord, fmtBytes, loadChatWt, mergeSteps, newIdemKey, opFinished, opOutcome, overlapBars,
  planBlocked, plural, setChatWt, shortBranch, unsavedText, wtApi, wtByChat, wtCreateError, wtTick,
} from "../../lib/worktree-client.js";
import { avoidFilesText, fixTestsText, resolveConflictText } from "../../../shared/worktree.js";
import { lang, t } from "../../lib/i18n.js";
import "../worktree.css";

export const BranchIcon = ({ size = 16 }) => (
  <svg class="wt-branch-ico" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="8" r="2.2" />
    <path d="M6 7.2v9.6M18 10.2c0 4-6 3.2-11 6.6" />
  </svg>
);
const offline = () => connection.value === "offline" || connection.value === "down";

// ---- пустой чат: чип и лист настроек --------------------------------------------------

export function WorktreeChip({ sessionId }) {
  const [plan, setPlan] = useState(null);
  const [sheet, setSheet] = useState(false);
  const [initAsk, setInitAsk] = useState(false);
  const st = wtByChat.value[sessionId];
  const pending = st?.pending ?? null;
  useEffect(() => {
    let live = true;
    (async () => {
      const [p] = await Promise.all([wtApi.plan({ sid: sessionId }).catch(() => null), loadChatWt(sessionId, { overlaps: false })]);
      if (!live) return;
      setPlan(p);
      // запомненный выбор проекта (кр. 1): включить сразу
      if (p?.repo && p.remember === true && !wtByChat.value[sessionId]?.pending && !wtByChat.value[sessionId]?.item && !p.detached) {
        try {
          const r = await wtApi.pending(sessionId, { on: true });
          if (live) setChatWt(sessionId, { pending: r.pending });
        } catch {}
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId]);
  if (!plan || st?.item) return null;
  const blocked = planBlocked(plan);
  const toggle = async () => {
    if (blocked) return;
    if (pending) return setSheet(true);
    if (plan.detached) return setSheet(true);
    try {
      const r = await wtApi.pending(sessionId, { on: true, remember: true });
      setChatWt(sessionId, { pending: r.pending });
    } catch (err) {
      setNotice(err?.message ?? t("worktree.chip.enableFailed"));
    }
  };
  return (
    <div class="wt-chip-row">
      <button type="button" class={"wt-chip" + (pending ? " is-on" : "") + (blocked ? " is-off" : "")} aria-pressed={pending ? "true" : "false"} disabled={Boolean(blocked)} onClick={toggle}
        title={blocked ? blocked.text : t("worktree.chip.title")} data-req="FEAT-20.7">
        <BranchIcon /> <span>{t("worktree.chip.label")}</span>
        {pending ? <span class="wt-chip-state">{t("worktree.chip.on")}</span> : null}
      </button>
      {pending ? <span class="wt-chip-note">{t("worktree.chip.pendingNote", { base: pending.base ?? plan.base ?? "main" })}</span> : null}
      {blocked ? (
        <span class="wt-chip-note is-muted">
          {blocked.text}
          {blocked.init ? (
            <button type="button" class="wt-link" onClick={() => setInitAsk(true)}>{t("worktree.chip.initRepo")}</button>
          ) : null}
        </span>
      ) : null}
      {sheet && <SetupSheet sessionId={sessionId} plan={plan} pending={pending} onClose={() => setSheet(false)} />}
      {initAsk &&
        createPortal(
          <ConfirmModal title={t("worktree.chip.initConfirmTitle")} text={t("worktree.chip.initConfirmText")} okText={t("worktree.chip.initConfirmOk")} onClose={() => setInitAsk(false)}
            onOk={async () => {
              try {
                await wtApi.init({ sid: sessionId });
              } catch (err) {
                setNotice(err?.message ?? t("worktree.chip.initFailed"));
              }
              setInitAsk(false);
              setPlan(await wtApi.plan({ sid: sessionId }).catch(() => null));
            }} />,
          document.body,
        )}
    </div>
  );
}

function SetupSheet({ sessionId, plan, pending, onClose }) {
  const [base, setBase] = useState(pending?.base ?? (plan.detached ? "" : plan.base ?? "")); // N-32: detached — выбор обязателен
  const [branch, setBranch] = useState(pending?.branch ?? "");
  const [carry, setCarry] = useState(Boolean(pending?.carryDirty));
  const [deps, setDeps] = useState(pending?.deps ?? plan.settings?.deps ?? "link");
  const [env, setEnv] = useState(pending?.copyEnv ?? plan.settings?.copyEnv ?? true);
  const [busy, setBusy] = useState(false);
  const needBase = plan.detached && !base;
  const save = async (on) => {
    setBusy(true);
    try {
      const r = await wtApi.pending(sessionId, on ? { on: true, remember: true, base: base || null, branch: branch.trim() || null, carryDirty: carry, deps, copyEnv: env } : { on: false, remember: true });
      setChatWt(sessionId, { pending: r.pending });
      onClose();
    } catch (err) {
      setNotice(err?.message ?? t("worktree.view.saveFailed"));
    } finally {
      setBusy(false);
    }
  };
  const need = (plan.estimateBytes ?? 0) + (plan.reserveBytes ?? 0);
  return (
    <PickerSheet title={t("worktree.setup.title")} onClose={onClose}>
      <div class="wt-form">
        <p class="wt-muted">{t("worktree.setup.desc")}</p>
        <label class="wt-field">
          <span>{t("worktree.setup.baseBranch")}{plan.detached ? t("worktree.setup.detachedNote") : ""}</span>
          <select value={base} onChange={(e) => setBase(e.currentTarget.value)}>
            {plan.detached ? <option value="">{t("worktree.setup.chooseBranch")}</option> : null}
            {(plan.branches ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label class="wt-field">
          <span>{t("worktree.setup.branchName")}</span>
          <input type="text" value={branch} placeholder={t("worktree.setup.branchPlaceholder")} maxLength={60} onInput={(e) => setBranch(e.currentTarget.value)} />
          <small class="wt-muted">teleharness/{branch.trim() ? branch.trim().toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-|-$/g, "") : t("worktree.setup.branchAutoHint")}</small>
        </label>
        {plan.dirtyCount > 0 ? (
          <fieldset class="wt-field wt-warnbox">
            <legend><span aria-hidden="true">!</span> {t("worktree.setup.dirtyLegend", { count: plan.dirtyCount, files: filesWord(plan.dirtyCount) })}</legend>
            <label class="wt-radio"><input type="radio" name="wt-carry" checked={!carry} onChange={() => setCarry(false)} /> {t("worktree.setup.withoutDirty")} <small class="wt-muted">{t("worktree.setup.withoutDirtyHint")}</small></label>
            <label class="wt-radio"><input type="radio" name="wt-carry" checked={carry} onChange={() => setCarry(true)} /> {t("worktree.setup.carryDirty")} <small class="wt-muted">{t("worktree.setup.carryDirtyHint")}</small></label>
            <button type="button" class="wt-link" onClick={() => navigate(gitHash({ sid: sessionId }))}>{t("worktree.setup.openGit")}</button>
          </fieldset>
        ) : null}
        <label class="wt-field">
          <span>{t("worktree.setup.deps")}</span>
          <select value={deps} onChange={(e) => setDeps(e.currentTarget.value)}>
            <option value="link">{t("worktree.setup.depsLink")}</option>
            {plan.admin ? <option value="install">{t("worktree.setup.depsInstall")}</option> : null}
            <option value="none">{t("worktree.setup.depsNone")}</option>
          </select>
        </label>
        <label class="wt-check"><input type="checkbox" checked={env} onChange={(e) => setEnv(e.currentTarget.checked)} /> {t("worktree.setup.copyEnv")}{plan.envFiles?.length ? ` (${plan.envFiles.join(", ")})` : ""}</label>
        <p class="wt-muted">{t("worktree.setup.estimate", { size: fmtBytes(plan.estimateBytes) })}{plan.freeBytes != null ? t("worktree.setup.free", { size: fmtBytes(plan.freeBytes) }) : ""}{plan.limits ? t("worktree.setup.limits", { used: plan.limits.used, max: plan.limits.max }) : ""}</p>
        {plan.freeBytes != null && plan.freeBytes < need ? <p class="wt-bad" role="alert"><span aria-hidden="true">✕</span> {t("worktree.setup.lowSpace", { need: fmtBytes(need), reserve: fmtBytes(plan.reserveBytes), free: fmtBytes(plan.freeBytes) })}</p> : null}
        {plan.submodules ? <p class="wt-warn"><span aria-hidden="true">!</span> {t("worktree.setup.submodules", { n: plan.submodules })}{plan.admin ? "" : t("worktree.setup.submodulesAdmin")}</p> : null}
        {plan.lfs ? <p class="wt-warn"><span aria-hidden="true">!</span> {t(plan.admin ? "worktree.setup.lfsAdmin" : "worktree.setup.lfsUser", { count: plan.lfs })}</p> : null}
        <p class="wt-muted">{t("worktree.setup.testsLabel")}{plan.testCmd ? <code>{plan.testCmd}</code> : t("worktree.setup.testCmdMissing")}{plan.admin === false ? (plan.testsAvailable ? t("worktree.setup.testsSandbox") : t("worktree.setup.testsUnavailable")) : ""}</p>
      </div>
      <div class="wt-actions">
        {pending ? <button type="button" class="btn" disabled={busy} onClick={() => save(false)}>{t("worktree.setup.turnOff")}</button> : null}
        <button type="button" class="btn-primary" disabled={busy || needBase} onClick={() => save(true)}>{needBase ? t("worktree.setup.chooseBaseBtn") : t("worktree.setup.done")}</button>
      </div>
    </PickerSheet>
  );
}

// ---- шапка: пилюля ветки ----------------------------------------------------------------
export function WorktreeHeaderPill({ sessionId, onOpen }) {
  const st = wtByChat.value[sessionId];
  useEffect(() => {
    if (!wtByChat.value[sessionId]) void loadChatWt(sessionId, { overlaps: false });
  }, [sessionId]);
  const it = st?.item;
  if (!it) return null;
  const warn = (it.overlaps ?? []).length > 0 || it.gone || it.branchOk === false;
  return (
    <button type="button" class={"wt-pill" + (warn ? " is-warn" : "")} onClick={onOpen} aria-label={t("worktree.pill.aria", { branch: it.branch, base: it.base })} data-req="FEAT-20.7">
      <BranchIcon size={14} />
      <span class="wt-pill-name">{shortBranch(it.branch, 18)}</span>
      <span class="wt-pill-base">{t("worktree.pill.fromBase", { base: it.base })}</span>
      {warn ? <span class="wt-pill-mark" aria-hidden="true">!</span> : null}
    </button>
  );
}

// ---- полоса над композером -------------------------------------------------------------
export function WorktreeBand({ sessionId, busy, sending = false, directory = null }) {
  const st = wtByChat.value[sessionId];
  const err = wtCreateError.value[sessionId];
  const it = st?.item ?? null;
  const [ovSheet, setOvSheet] = useState(null);
  void wtTick.value;
  // опрос пересечений: при открытом чате не реже раза в 10 с (кр. 7)
  useEffect(() => {
    if (!st?.item && !st?.pending) return undefined;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void loadChatWt(sessionId);
    }, 10_000);
    return () => clearInterval(t);
  }, [sessionId, Boolean(st?.item), Boolean(st?.pending)]);
  // первый ход ждёт создания копии (кр. 2): перечитать после конца хода
  useEffect(() => {
    if (st?.pending && !busy) void loadChatWt(sessionId);
  }, [busy]);
  if (err) {
    const title = WT_KIND_TITLE[err.kind] ?? t("worktree.kind.create-failed");
    return (
      <div class="wt-band is-bad" role="alert" data-req="FEAT-20.7">
        <span class="wt-band-ico" aria-hidden="true">✕</span>
        <div class="wt-band-text"><b>{title}</b><span>{err.error}</span>{err.kind === "space" && err.freeBytes != null ? <span>{t("worktree.band.spaceNeed", { need: fmtBytes((err.estimateBytes ?? 0) + (err.reserveBytes ?? 0)), free: fmtBytes(err.freeBytes) })}</span> : null}<span class="wt-muted">{t("worktree.band.keptInComposer")}</span></div>
        <div class="wt-band-actions">
          <button type="button" class="stall-btn" onClick={() => (clearWorktreeError(sessionId), resendLast(sessionId))}>{t("worktree.band.retry")}</button>
          {err.kind === "limit" || err.kind === "quota" ? <button type="button" class="stall-btn" onClick={() => navigate(`/worktrees?directory=${encodeURIComponent(directory ?? "")}`)}>{t("worktree.band.openList")}</button> : null}
          <button type="button" class="stall-btn" onClick={async () => {
            await wtApi.pending(sessionId, { on: false }).catch(() => {});
            setChatWt(sessionId, { pending: null });
            clearWorktreeError(sessionId);
            resendLast(sessionId);
          }}>{t("worktree.band.useMain")}</button>
        </div>
      </div>
    );
  }
  if (!it && st?.pending && (busy || sending)) {
    return (
      <div class="wt-band" role="status" data-req="FEAT-20.7">
        <span class="spin" aria-hidden="true" />
        <div class="wt-band-text"><b>{t("worktree.band.creating")}</b><span>{t("worktree.band.creatingDesc", { base: st.pending.base ?? "main" })}</span></div>
      </div>
    );
  }
  if (!it) return null;
  if (it.gone) {
    return (
      <div class="wt-band is-bad" role="alert">
        <span class="wt-band-ico" aria-hidden="true">✕</span>
        <div class="wt-band-text"><b>{t("worktree.band.goneTitle")}</b><span>{t("worktree.band.goneDesc")}</span></div>
        <div class="wt-band-actions">
          <button type="button" class="stall-btn" onClick={() => act(it, "restore", sessionId)}>{t("worktree.band.restore")}</button>
          <button type="button" class="stall-btn" onClick={() => act(it, "detach", sessionId)}>{t("worktree.band.detach")}</button>
        </div>
      </div>
    );
  }
  if (it.branchOk === false) {
    return (
      <div class="wt-band is-warn" role="status">
        <span class="wt-band-ico" aria-hidden="true">!</span>
        <div class="wt-band-text"><b>{t("worktree.band.otherBranch", { branch: it.onBranch ?? "detached" })}</b><span>{t("worktree.band.mergeUnavailable")}</span></div>
        <div class="wt-band-actions"><button type="button" class="stall-btn" onClick={() => act(it, "checkout-branch", sessionId)}>{t("worktree.band.returnBranch", { branch: shortBranch(it.branch, 20) })}</button></div>
      </div>
    );
  }
  const bars = overlapBars(it.overlaps ?? []);
  if (!bars.shown.length) return ovSheet ? <OverlapSheet item={it} overlap={ovSheet} sessionId={sessionId} onClose={() => setOvSheet(null)} /> : null;
  return (
    <>
      {bars.shown.map((b) => (
        <button key={b.kind + b.otherId} type="button" class={"wt-band wt-overlap is-" + b.tone} onClick={() => setOvSheet(b)} data-req="FEAT-20.7">
          <span class="wt-band-ico" aria-hidden="true">{b.conflict ? "✕" : "!"}</span>
          <span class="wt-band-text"><b>{b.text}</b><span>{b.conflict ? t("worktree.band.dryConflict") : b.kind === "main" ? t("worktree.band.mainDirty") : t("worktree.band.dryClean")}{bars.more ? t("worktree.band.andMore", { n: bars.more }) : ""}</span></span>
          <span class="wt-band-go" aria-hidden="true">›</span>
        </button>
      ))}
      {ovSheet && <OverlapSheet item={it} overlap={ovSheet} sessionId={sessionId} onClose={() => setOvSheet(null)} />}
    </>
  );
}

async function act(it, name, sid, body = {}) {
  try {
    await wtApi.action(it.id, name, body);
    await loadChatWt(sid);
    return true;
  } catch (err) {
    setNotice(err?.message ?? t("worktree.actionFailed"));
    return false;
  }
}

const isRunKey = (k) => String(k ?? "").startsWith("run:");
function OverlapSheet({ item, overlap, sessionId, onClose }) {
  const files = overlap.files ?? [];
  const conflictFiles = files.filter((f) => f.conflict).map((f) => f.path);
  const other = overlap.kind === "chat" ? t("worktree.overlapSheet.otherChat", { name: overlap.title ?? overlap.branch ?? "…" }) : overlap.kind === "main" ? t("worktree.overlapSheet.otherMain") : t("worktree.overlapSheet.otherBase", { name: overlap.title ?? item.base });
  return (
    <PickerSheet title={overlap.kind === "chat" ? t("worktree.overlapSheet.titleChat") : overlap.kind === "main" ? t("worktree.overlapSheet.titleMain") : t("worktree.overlapSheet.titleBase", { base: item.base })} onClose={onClose}>
      <p class="wt-muted">{t("worktree.overlapSheet.subtitle", { other })}</p>
      <ul class="wt-files">
        {files.map((f) => (
          <li key={f.path}>
            <span class="wt-file-path">{f.path}</span>
            <span class={"wt-tag " + (f.conflict ? "is-bad" : f.conflict === false ? "is-ok" : "")}>{f.conflict ? t("worktree.overlapSheet.fileConflict") : f.conflict === false ? t("worktree.overlapSheet.fileClean") : t("worktree.overlapSheet.fileUnchecked")}</span>
          </li>
        ))}
      </ul>
      <div class="wt-actions is-col">
        {overlap.kind === "base" ? <button type="button" class="btn-primary" onClick={async () => { onClose(); await syncBase(item, sessionId); }}>{t("worktree.overlapSheet.pullBase", { base: item.base })}</button> : null}
        {conflictFiles.length && !isRunKey(sessionId) ? (
          <button type="button" class="btn-primary" onClick={() => { onClose(); send({ text: resolveConflictText({ base: item.base, branch: item.branch, files: conflictFiles, lang: lang.value }), sessionId }); }}>{t("worktree.overlapSheet.askResolve")}</button>
        ) : null}
        {overlap.kind === "chat" && overlap.sid ? <button type="button" class="btn" onClick={() => { onClose(); navigate(`/chat/${overlap.sid}`); }}>{t("worktree.overlapSheet.openOtherChat", { name: overlap.title ?? "…" })}</button> : null}
        <button type="button" class="btn" hidden={isRunKey(sessionId)} onClick={() => { onClose(); send({ text: avoidFilesText({ other: overlap.title, files: files.map((f) => f.path), lang: lang.value }), sessionId }); }}>{t("worktree.overlapSheet.avoidFiles")}</button>
        <button type="button" class="btn" onClick={async () => { await act(item, "dismiss", sessionId, { otherId: overlap.otherId, files: files.map((f) => f.path) }); onClose(); }}>{t("worktree.overlapSheet.dismiss")}</button>
      </div>
    </PickerSheet>
  );
}

async function syncBase(item, sid) {
  try {
    const r = await wtApi.sync(item.id);
    setNotice(r.upToDate ? t("worktree.sync.upToDate", { base: item.base }) : t("worktree.sync.done", { base: item.base }));
  } catch (err) {
    if (err?.body?.kind === "conflict") setNotice(t("worktree.sync.conflict", { base: item.base, files: (err.body.files ?? []).join(", ") }), 12_000);
    else setNotice(err?.message ?? t("worktree.sync.failed"));
  }
  await loadChatWt(sid);
}

// ---- лист «Рабочая копия» --------------------------------------------------------------
export function WorktreeSheet({ sessionId, onClose, initial = "main" }) {
  const st = wtByChat.value[sessionId];
  const it = st?.item;
  const [mode, setMode] = useState(initial);
  const [opId, setOpId] = useState(null);
  const busy = Boolean(busyMap.value[sessionId]);
  useEffect(() => {
    void loadChatWt(sessionId);
  }, [sessionId]);
  useEffect(() => {
    // незавершённая операция (повторное открытие, обрыв сети) — показать её шаги
    if (it?.op && !opFinished(it.op) && mode === "main") {
      setOpId(it.op.opId);
      setMode("progress");
    }
  }, [it?.op?.opId]);
  if (!it) {
    return (
      <PickerSheet title={t("worktree.sheet.title")} onClose={onClose}>
        <p class="wt-muted">{st?.error ? t("worktree.sheet.offlineErr", { error: st.error }) : t("worktree.sheet.loading")}</p>
      </PickerSheet>
    );
  }
  if (mode === "merge") return <MergeSheet item={it} sessionId={sessionId} onClose={onClose} onStarted={(op) => (setOpId(op.opId), setMode("progress"))} onBack={() => setMode("main")} />;
  if (mode === "progress" && opId) return <ProgressSheet item={it} opId={opId} sessionId={sessionId} onClose={onClose} onBack={() => setMode("main")} />;
  if (mode === "delete") return <DeleteCopySheet item={it} sessionId={sessionId} onClose={onClose} onBack={() => setMode("main")} />;
  const off = offline();
  const lastOp = it.op && opFinished(it.op) ? it.op : null;
  const outcome = lastOp ? opOutcome(lastOp, { base: it.base }) : null;
  return (
    <PickerSheet title={t("worktree.sheet.title")} onClose={onClose}>
      <div class="wt-head">
        <div class="wt-branch"><BranchIcon /> <span class="wt-branch-name" title={it.branch}>{it.branch}</span></div>
        <div class="wt-muted">{t("worktree.view.fromBase", { base: it.base })} · {aheadLine(it)}{it.state === "merged" ? t("worktree.sheet.mergedSuffix") : ""}</div>
      </div>
      {outcome ? (
        <div class={"wt-outcome is-" + outcome.tone} role="status">
          <b><span aria-hidden="true">{outcome.tone === "ok" ? "✓" : outcome.tone === "bad" ? "✕" : "!"}</span> {outcome.title}</b>
          <span>{outcome.text}</span>
          <button type="button" class="wt-link" onClick={() => (setOpId(lastOp.opId), setMode("progress"))}>{t("worktree.sheet.details")}</button>
        </div>
      ) : null}
      {it.queue && it.queue.wtId !== it.id ? <p class="wt-warn" role="status"><span aria-hidden="true">…</span> {t("worktree.sheet.queue")}{it.queue.kind === "merge" ? t("worktree.sheet.queueMerging", { title: it.queue.title ?? "…" }) : t("worktree.sheet.queueBusy")}</p> : null}
      {it.lock?.stale ? (
        <p class="wt-warn">
          <span aria-hidden="true">!</span> {t("worktree.sheet.staleLock", { min: Math.round(it.lock.ageMs / 60000) })}
          <button type="button" class="wt-link is-danger" onClick={() => confirm(t("worktree.sheet.unlockConfirm")) && act(it, "unlock", sessionId)}>{t("worktree.sheet.unlockBtn")}</button>
        </p>
      ) : null}
      {it.depsChanged ? <p class="wt-warn"><span aria-hidden="true">!</span> {t("worktree.sheet.depsChanged")}{it.tenant ? t("worktree.sheet.depsTenant") : t("worktree.sheet.depsAdmin")}</p> : null}
      {it.submodules ? <p class="wt-warn"><span aria-hidden="true">!</span> {t("worktree.setup.submodules", { n: it.submodules })}</p> : null}
      {it.lfs ? <p class="wt-warn"><span aria-hidden="true">!</span> {t("worktree.sheet.lfsNotLoaded", { n: it.lfs })}{it.tenant ? t("worktree.sheet.lfsPointers") : ""}</p> : null}
      <h3 class="wt-h3">{t("worktree.sheet.changed")}{filesWord(it.filesCount ?? 0)} <span class="wt-add">+{it.additions ?? 0}</span> <span class="wt-del">−{it.deletions ?? 0}</span>{it.uncommitted ? <span class="wt-muted">{t("worktree.sheet.uncommitted", { count: it.uncommitted })}</span> : null}</h3>
      {(it.files ?? []).length ? (
        <ul class="wt-files">
          {it.files.slice(0, 30).map((f) => (
            <li key={f.path}>
              <span class="wt-file-path">{f.path}</span>
              <span class="wt-file-num"><span class="wt-add">+{f.additions ?? 0}</span> <span class="wt-del">−{f.deletions ?? 0}</span>{f.uncommitted ? <span class="wt-tag" title={t("worktree.sheet.uncommittedTag")} role="img" aria-label={t("worktree.sheet.uncommittedTag")}>●</span> : null}</span>
            </li>
          ))}
          {it.files.length > 30 ? <li class="wt-muted">{t("worktree.sheet.andMoreFiles", { n: it.files.length - 30 })}</li> : null}
        </ul>
      ) : <p class="wt-muted">{t("worktree.sheet.noChanges")}</p>}
      <p class="wt-muted">{t("worktree.setup.testsLabel")}{it.testCmd ? <code>{it.testCmd}</code> : it.testSource === "none" ? t("worktree.sheet.testsNoneSelected") : t("worktree.setup.testCmdMissing")}{it.testSource && it.testSource !== "user" && it.testCmd ? t("worktree.sheet.testsFrom", { source: it.testSource }) : ""}</p>
      {it.port ? <p class="wt-muted">{t("worktree.sheet.devPorts", { from: it.port, to: it.port + 9 })}</p> : null}
      {it.carried ? <p class="wt-muted">{t("worktree.sheet.carried", { n: it.carried })}</p> : null}
      <div class="wt-actions is-grid">
        <button type="button" class="btn-primary" disabled={busy || off || it.branchOk === false} title={busy ? t("worktree.sheet.waitTurn") : off ? t("worktree.sheet.offline") : ""} onClick={() => setMode("merge")}>
          {busy ? t("worktree.sheet.waitTurn") : off ? t("worktree.sheet.offline") : t("worktree.sheet.mergeInto", { base: it.base })}
        </button>
        <button type="button" class="btn" disabled={busy || off} onClick={() => syncBase(it, sessionId)}>{t("worktree.overlapSheet.pullBase", { base: it.base })}</button>
        {isRunKey(sessionId) ? null : <button type="button" class="btn" onClick={() => (onClose(), navigate(gitHash({ sid: sessionId })))}>Git</button>}
        <button type="button" class="btn" disabled={off || !(it.filesCount > 0 || it.ahead > 0)} onClick={async () => {
          try {
            const r = await wtApi.action(it.id, "review");
            onClose();
            navigate(`/review/${r.id}`);
          } catch (err) {
            setNotice(err?.message ?? t("worktree.sheet.reviewUnavailable"));
          }
        }}>{t("worktree.sheet.review")}</button>
        {it.canUndoMerge ? <button type="button" class="btn" onClick={() => act(it, "undo-merge", sessionId)}>{t("worktree.sheet.undoMerge")}</button> : null}
        {it.state === "merged" && !it.canUndoMerge && it.mergedSha ? (
          <button type="button" class="btn is-danger-outline" onClick={() => confirm(t("worktree.sheet.revertConfirm", { base: it.base })) && act(it, "revert-merge", sessionId)}>{t("worktree.sheet.revertBtn")}</button>
        ) : null}
        <button type="button" class="btn is-danger-outline" disabled={busy || off} onClick={() => setMode("delete")}>{t("worktree.sheet.deleteCopy")}</button>
      </div>
      {it.tenant ? <p class="wt-muted">{t("worktree.sheet.tenantPushNote")}</p> : null}
    </PickerSheet>
  );
}

function MergeSheet({ item, sessionId, onClose, onStarted, onBack }) {
  const [method, setMethod] = useState("squash");
  const [message, setMessage] = useState("");
  const [tests, setTests] = useState(true);
  const [testCmd, setTestCmd] = useState(item.testCmd ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState(null);
  const key = useRef(newIdemKey());
  useEffect(() => {
    wtApi.settings().then((s) => setMethod(s.mergeMethod ?? "squash")).catch(() => {});
  }, []);
  const noCmd = !testCmd.trim();
  const skip = !tests || noCmd;
  const start = async () => {
    if (skip && !reason.trim()) return setError(t("worktree.merge.needReason"));
    setBusy(true);
    setError(null);
    try {
      const op = await wtApi.merge(item.id, { method, message: message.trim() || undefined, commitDirty: item.uncommitted > 0, skipTests: skip, reason: skip ? reason.trim() : undefined, testCmd: !skip ? testCmd.trim() : undefined, idemKey: key.current });
      onStarted(op);
    } catch (err) {
      setError(err?.message ?? t("worktree.merge.startFailed"));
    } finally {
      setBusy(false);
    }
  };
  const suggest = async () => {
    setSuggesting(true);
    try {
      const files = (item.files ?? []).map((f) => f.path).slice(0, 200);
      const r = await wtApi.suggest(sessionId, files);
      setMessage(r.message ?? "");
    } catch (err) {
      setError(err?.message ?? t("worktree.merge.suggestFailed"));
    } finally {
      setSuggesting(false);
    }
  };
  return (
    <PickerSheet title={t("worktree.sheet.mergeInto", { base: item.base })} onClose={onClose}>
      <div class="wt-form">
        <fieldset class="wt-field">
          <legend>{t("worktree.merge.method")}</legend>
          <label class="wt-radio"><input type="radio" name="wt-m" checked={method === "squash"} onChange={() => setMethod("squash")} /> {t("worktree.method.squash")}</label>
          <label class="wt-radio"><input type="radio" name="wt-m" checked={method === "merge"} onChange={() => setMethod("merge")} /> {t("worktree.method.merge")}</label>
          <label class="wt-radio"><input type="radio" name="wt-m" checked={method === "ff"} onChange={() => setMethod("ff")} /> {t("worktree.method.ff")}</label>
        </fieldset>
        <label class="wt-field">
          <span>{t("worktree.merge.commitMsg")}</span>
          <textarea rows={3} value={message} placeholder={item.title ?? item.branch} onInput={(e) => setMessage(e.currentTarget.value)} />
          <button type="button" class="wt-link" disabled={suggesting} onClick={suggest}>{suggesting ? t("worktree.merge.thinking") : t("worktree.merge.suggest")}</button>
        </label>
        {item.uncommitted ? <p class="wt-warn"><span aria-hidden="true">!</span> {t("worktree.merge.uncommittedWarn", { count: item.uncommitted, files: filesWord(item.uncommitted) })}</p> : null}
        <label class="wt-check"><input type="checkbox" checked={tests && !noCmd} disabled={noCmd} onChange={(e) => setTests(e.currentTarget.checked)} /> {t("worktree.merge.runTests")} <small class="wt-muted">{t("worktree.merge.runTestsHint", { base: item.base })}</small></label>
        <label class="wt-field">
          <span>{t("worktree.merge.testCmd")}</span>
          <input type="text" value={testCmd} placeholder="npm test" onInput={(e) => setTestCmd(e.currentTarget.value)} />
          {noCmd ? <small class="wt-warn"><span aria-hidden="true">!</span> {t("worktree.merge.noCmdWarn")}</small> : null}
        </label>
        {skip ? (
          <label class="wt-field wt-danger-box">
            <span>{t("worktree.merge.skipReason")}</span>
            <input type="text" value={reason} maxLength={300} onInput={(e) => setReason(e.currentTarget.value)} />
          </label>
        ) : null}
        {error ? <p class="wt-bad" role="alert"><span aria-hidden="true">✕</span> {error}</p> : null}
      </div>
      <div class="wt-actions">
        <button type="button" class="btn" onClick={onBack}>{t("worktree.merge.back")}</button>
        <button type="button" class={skip ? "btn is-danger-outline" : "btn-primary"} disabled={busy} onClick={start}>
          {busy ? t("worktree.merge.starting") : skip ? t("worktree.merge.mergeWithoutTests") : item.uncommitted ? t("worktree.merge.commitAndMerge") : t("worktree.sheet.mergeInto", { base: item.base })}
        </button>
      </div>
    </PickerSheet>
  );
}

function ProgressSheet({ item, opId, sessionId, onClose, onBack }) {
  const [op, setOp] = useState(item.op?.opId === opId ? item.op : null);
  const [log, setLog] = useState(null);
  useEffect(() => {
    let live = true;
    let t = null;
    const tick = async () => {
      try {
        const o = await wtApi.op(opId);
        if (!live) return;
        setOp(o);
        if (opFinished(o)) {
          void loadChatWt(sessionId);
          return;
        }
      } catch {}
      if (live) t = setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [opId]);
  const steps = mergeSteps(op, { base: item.base });
  const outcome = opOutcome(op, { base: item.base });
  const done = opFinished(op);
  return (
    <PickerSheet title={done ? (outcome?.title ?? t("worktree.progress.titleDefault")) : t("worktree.progress.titleRunning", { base: item.base })} onClose={onClose}>
      <ol class="wt-steps">
        {steps.map((s) => (
          <li key={s.key} class={"is-" + s.state}>
            <span class="wt-step-ico" aria-hidden="true">{s.state === "run" ? <span class="spin" /> : STEP_ICON[s.state]}</span>
            <span>{s.label}</span>
            <span class="sr-only">{t(`worktree.progress.state.${s.state}`)}</span>
          </li>
        ))}
      </ol>
      {op?.note && !done ? <p class="wt-warn" role="status"><span aria-hidden="true">!</span> {op.note}</p> : null}
      {!done ? <p class="wt-muted">{t("worktree.progress.bgNote")}</p> : null}
      {op?.phase === "queued" && item.queue ? <p class="wt-muted" role="status"><span aria-hidden="true">…</span> {t("worktree.sheet.queue")}{item.queue.title ? t("worktree.progress.queueMerging", { title: item.queue.title }) : t("worktree.progress.queueOther")}</p> : null}
      {done && outcome ? (
        <div class={"wt-outcome is-" + outcome.tone} role="status">
          <b><span aria-hidden="true">{outcome.tone === "ok" ? "✓" : outcome.tone === "bad" ? "✕" : "!"}</span> {outcome.title}</b>
          {outcome.text ? <span>{outcome.text}</span> : null}
          {op.phase === "failed" && op.kind !== "main-moved" && !outcome.baseUnchanged ? <span>{t("worktree.progress.baseUnchanged", { base: item.base })}</span> : null}
        </div>
      ) : null}
      {done && op.kind === "conflict" ? (
        <>
          <ul class="wt-files">{(op.files ?? []).map((f) => <li key={f}><span class="wt-file-path">{f}</span><span class="wt-tag is-bad">{t("worktree.progress.conflictTag")}</span></li>)}</ul>
          <div class="wt-actions is-col">
            {isRunKey(sessionId) ? <p class="wt-muted">{t("worktree.progress.runConflictHint")}</p> : <button type="button" class="btn-primary" onClick={() => { onClose(); send({ text: resolveConflictText({ base: item.base, branch: item.branch, files: op.files ?? [], lang: lang.value }), sessionId }); }}>{t("worktree.overlapSheet.askResolve")}</button>}
          </div>
        </>
      ) : null}
      {done && op.kind === "main-dirty" ? (
        <>
          <ul class="wt-files">{(op.files ?? []).map((f) => <li key={f}><span class="wt-file-path">{f}</span></li>)}</ul>
          <div class="wt-actions">
            <button type="button" class="btn" onClick={() => (onClose(), navigate(gitHash({ directory: item.repoRoot ?? "" })))}>{t("worktree.progress.openMainGit")}</button>
            <button type="button" class="btn-primary" onClick={onBack}>{t("worktree.band.retry")}</button>
          </div>
        </>
      ) : null}
      {done && (op.kind === "tests-failed" || op.kind === "tests-timeout") ? (
        <>
          <pre class="wt-log">{op.test?.tail ?? ""}</pre>
          <button type="button" class="wt-link" onClick={async () => setLog((await wtApi.opLog(opId).catch(() => ({ log: "" }))).log)}>{t("worktree.progress.fullLog")}</button>
          {log != null ? <pre class="wt-log is-full">{log}</pre> : null}
          <div class="wt-actions is-col">
            <button type="button" class="btn-primary" hidden={isRunKey(sessionId)} onClick={() => { onClose(); send({ text: fixTestsText({ base: item.base, cmd: op.test?.cmd ?? "", tail: op.test?.tail ?? "", lang: lang.value }), sessionId }); }}>{t("worktree.progress.askFix")}</button>
            <button type="button" class="btn" onClick={() => act(item, "reset-branch", sessionId, { opId })}>{t("worktree.progress.resetBranch")}</button>
            <button type="button" class="btn is-danger-outline" onClick={onBack}>{t("worktree.merge.mergeWithoutTests")}</button>
          </div>
        </>
      ) : null}
      {done && op.phase === "done" ? (
        <div class="wt-actions is-col">
          {item.canUndoMerge || item.state === "merged" ? <button type="button" class="btn" onClick={() => act(item, "undo-merge", sessionId)}>{t("worktree.sheet.undoMerge")}</button> : null}
          <button type="button" class="btn-primary" onClick={onClose}>{t("worktree.progress.continueHere")}</button>
          <button type="button" class="btn is-danger-outline" onClick={async () => {
            try {
              await wtApi.remove(item.id, "auto");
              await loadChatWt(sessionId);
              onClose();
            } catch (err) {
              setNotice(err?.message ?? t("worktree.delete.failed"));
            }
          }}>{t("worktree.progress.deleteCopyAndBranch")}</button>
        </div>
      ) : null}
      {done && (op.phase === "interrupted" || ["main-moved", "turn-running", "branch-switched", "dirty", "git", "gone", "tests-unavailable"].includes(op.kind)) ? (
        <div class="wt-actions"><button type="button" class="btn-primary" onClick={onBack}>{t("worktree.band.retry")}</button></div>
      ) : null}
    </PickerSheet>
  );
}

function DeleteCopySheet({ item, sessionId, onClose, onBack }) {
  const [u, setU] = useState(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    wtApi.unsaved(item.id).then(setU).catch(() => setU({ uncommitted: 0, commits: 0 }));
  }, [item.id]);
  const run = async (mode) => {
    setBusy(true);
    try {
      const r = await wtApi.remove(item.id, mode, mode === "all");
      setNotice(r.branchKept ? t("worktree.delete.removedKept", { branch: r.branch }) : t("worktree.delete.removedAll"));
      await loadChatWt(sessionId);
      onClose();
    } catch (err) {
      setNotice(err?.message ?? t("worktree.delete.failed"));
    } finally {
      setBusy(false);
    }
  };
  const dirty = u && (u.uncommitted || u.commits);
  return (
    <PickerSheet title={t("worktree.delete.title")} onClose={onClose}>
      {!u ? <p class="wt-muted">{t("worktree.delete.checking")}</p> : dirty ? <p class="wt-warn"><span aria-hidden="true">!</span> {unsavedText(u, item.base)}.</p> : <p class="wt-muted">{t("worktree.delete.clean")}</p>}
      {dirty ? <label class="wt-check"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.currentTarget.checked)} /> {t("worktree.delete.confirmLoss", { what: u.commits ? t("worktree.commits", { count: u.commits }) : t("worktree.delete.uncommittedWhat") })}</label> : null}
      <div class="wt-actions is-col">
        {dirty ? <button type="button" class="btn-primary" disabled={busy} onClick={() => run("keep-branch")}>{t("worktree.delete.keepBranch")}</button> : null}
        <button type="button" class="btn is-danger-outline" disabled={busy || !u || (dirty && !sure)} onClick={() => run(dirty ? "all" : "auto")}>{dirty ? t("worktree.delete.deleteAll") : t("worktree.progress.deleteCopyAndBranch")}</button>
        <button type="button" class="btn" onClick={onBack}>{t("worktree.merge.back")}</button>
      </div>
    </PickerSheet>
  );
}

// Диалог удаления чата с копией (кр. 14, T-14). → onDone(true) — чат можно удалять.
export function WorktreeDeleteModal({ sessionId, item, title, onClose, onDelete }) {
  const [u, setU] = useState(null);
  const [mode, setMode] = useState("keep-branch");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    wtApi.unsaved(item.id).then(setU).catch(() => setU({ uncommitted: 0, commits: 0 }));
  }, [item.id]);
  const dirty = u && (u.uncommitted || u.commits);
  const go = async () => {
    setBusy(t("worktree.chatDelete.deleting"));
    try {
      if (mode === "merge") {
        setBusy(t("worktree.chatDelete.merging"));
        const op = await wtApi.merge(item.id, { commitDirty: true, skipTests: !item.testCmd, reason: item.testCmd ? undefined : t("worktree.chatDelete.noTestsReason"), idemKey: newIdemKey() });
        let o = op;
        for (let i = 0; i < 1200 && !opFinished(o); i++) {
          await new Promise((r) => setTimeout(r, 1500));
          o = await wtApi.op(op.opId);
        }
        if (o.phase !== "done") throw new Error(t("worktree.chatDelete.mergeFailedNotDeleted", { title: opOutcome(o, { base: item.base })?.title ?? t("worktree.outcome.failedDefault") }));
        await wtApi.remove(item.id, "auto");
      } else await wtApi.remove(item.id, dirty ? mode : "auto", mode === "all");
      await onDelete();
    } catch (err) {
      setNotice(err?.message ?? t("worktree.chatDelete.failed"));
      setBusy(null);
    }
  };
  return (
    <Modal title={t("worktree.chatDelete.title", { title })} onClose={() => !busy && onClose()}>
        {!u ? <p class="modal-text">{t("worktree.chatDelete.checking")}</p> : dirty ? (
          <>
            <p class="modal-warn" role="status"><span aria-hidden="true">!</span> {t("worktree.chatDelete.unsavedWarn", { details: unsavedText(u, item.base, { bare: true }) })}</p>
            <label class="wt-radio"><input type="radio" name="wt-del" checked={mode === "merge"} onChange={() => setMode("merge")} /> {t("worktree.chatDelete.mergeAndDelete")}</label>
            <label class="wt-radio"><input type="radio" name="wt-del" checked={mode === "keep-branch"} onChange={() => setMode("keep-branch")} /> {t("worktree.chatDelete.keepBranch")} <small class="wt-muted">{t("worktree.chatDelete.keepBranchHint", { branch: shortBranch(item.branch, 24) })}</small></label>
            <label class="wt-radio"><input type="radio" name="wt-del" checked={mode === "all"} onChange={() => setMode("all")} /> {t("worktree.delete.deleteAll")}</label>
            {mode === "all" ? <label class="wt-check"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.currentTarget.checked)} /> {t("worktree.delete.confirmLoss", { what: u.commits ? t("worktree.commits", { count: u.commits }) : t("worktree.delete.uncommittedWhat") })}</label> : null}
          </>
        ) : <p class="modal-text">{t("worktree.chatDelete.cleanText")}</p>}
        <div class="modal-actions">
          <button class="btn" type="button" onClick={onClose} disabled={Boolean(busy)}>{t("common.cancel")}</button>
          <button class="btn-danger" type="button" disabled={!u || Boolean(busy) || (mode === "all" && dirty && !sure)} onClick={go}>{busy ?? t("worktree.chatDelete.deleteBtn")}</button>
        </div>
    </Modal>
  );
}

function ConfirmModal({ title, text, okText, onOk, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={() => !busy && onClose()}>
      <p class="modal-text">{text}</p>
      <div class="modal-actions">
        <button class="btn" type="button" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
        <button class="btn-primary" type="button" disabled={busy} onClick={async () => (setBusy(true), await onOk(), setBusy(false))}>{okText}</button>
      </div>
    </Modal>
  );
}

// Экран запуска пайпа (кр. 22, T-19, D-6): ветка копии запуска и «Слить в main».
export function RunWorktree({ workflowId }) {
  const key = "run:" + workflowId;
  const [open, setOpen] = useState(false);
  const st = wtByChat.value[key];
  useEffect(() => {
    void loadChatWt(key, { overlaps: false });
  }, [workflowId, wtTick.value]);
  const it = st?.item;
  if (!it) return null;
  return (
    <section class="t-card" data-req="FEAT-20.7">
      <h2>{t("worktree.run.title")}</h2>
      <div class="wt-branch"><BranchIcon size={14} /><span class="wt-branch-name" title={it.branch}>{it.branch}</span></div>
      <p class="wt-muted">{t("worktree.view.fromBase", { base: it.base })} · {it.state === "orphaned" ? t("worktree.run.orphaned") : `${aheadLine(it)} · ${filesWord(it.filesCount ?? 0)}`}</p>
      <p class="wt-muted">{t("worktree.run.artifactsNote")}</p>
      {it.state !== "orphaned" ? <button type="button" class="btn-primary" style="min-height:44px" onClick={() => setOpen(true)}>{it.state === "merged" ? t("worktree.sheet.title") : t("worktree.sheet.mergeInto", { base: it.base })}</button> : null}
      {open && <WorktreeSheet sessionId={key} onClose={() => setOpen(false)} initial={it.state === "merged" ? "main" : "merge"} />}
    </section>
  );
}
