// FEAT-19.14: shared Temporal UI pieces — status (icon + text, never colour
// alone), banners that say what happened / what is lost / what to do,
// a confirmation sheet with consequences, polling that pauses in the background.
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { t, locale } from "../../lib/i18n.js";
import { CI_ATTEMPTS_MAX } from "../../../shared/temporal-templates.js";

export const KINDS = {
  wait: { cls: "t-wait", icon: "◆", get text() { return t("temporal.kind.wait"); } },
  run: { cls: "t-run", icon: "↻", get text() { return t("temporal.kind.run"); } },
  quota: { cls: "t-quota", icon: "⧗", get text() { return t("temporal.kind.quota"); } },
  slot: { cls: "t-quota", icon: "⧗", get text() { return t("temporal.kind.slot"); } },
  paused: { cls: "t-off", icon: "❚❚", get text() { return t("temporal.kind.paused"); } },
  github: { cls: "t-wait", icon: "⧗", get text() { return t("temporal.kind.github"); } },
  ok: { cls: "t-ok", icon: "✓", get text() { return t("temporal.kind.ok"); } },
  err: { cls: "t-err", icon: "✕", get text() { return t("temporal.kind.err"); } },
  rejected: { cls: "t-err", icon: "✕", get text() { return t("temporal.kind.rejected"); } },
  cancel: { cls: "t-off", icon: "⊘", get text() { return t("temporal.kind.cancel"); } },
  term: { cls: "t-off", icon: "■", get text() { return t("temporal.kind.term"); } },
  queued: { cls: "t-off", icon: "…", get text() { return t("temporal.kind.queued"); } },
  unavailable: { cls: "t-err", icon: "?", get text() { return t("temporal.kind.unavailable"); } },
};

export function StatusPill({ kind }) {
  const k = KINDS[kind] ?? KINDS.unavailable;
  return (
    <span class={"t-pill " + k.cls} data-kind={kind}>
      <i aria-hidden="true">{k.icon}</i>
      {k.text}
    </span>
  );
}

export function Banner({ tone = "info", icon, title, children, action, role }) {
  return (
    <div class={"t-banner t-banner-" + tone} role={role ?? (tone === "err" ? "alert" : "status")}>
      {icon && <span class="t-banner-icon" aria-hidden="true">{icon}</span>}
      <div class="t-banner-body">
        <b>{title}</b>
        {children && <div class="t-banner-text">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Empty({ icon, title, children, actions }) {
  return (
    <div class="t-card t-empty">
      {icon && <div class="t-empty-icon" aria-hidden="true">{icon}</div>}
      <h2>{title}</h2>
      {children && <div class="t-lead">{children}</div>}
      {actions && <div class="t-row t-center">{actions}</div>}
    </div>
  );
}

export function Skeleton({ rows = 4 }) {
  return (
    <div class="t-list" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => <div key={i} class="t-skel" />)}
      <p class="t-muted t-small" role="status">{t("temporal.loading")}</p>
    </div>
  );
}

// Confirmation sheet (phone: bottom sheet, desktop: dialog). Escape and the
// scrim close it; focus moves into the sheet and returns on close.
export function Sheet({ title, onClose, children }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const back = document.activeElement;
    ref.current?.querySelector("textarea,input,button")?.focus();
    const key = (e) => { if (e.key === "Escape") closeRef.current?.(); };
    addEventListener("keydown", key);
    return () => { removeEventListener("keydown", key); back?.focus?.(); };
  }, []);
  const node = (
    <div class="t-scrim" onClick={(e) => { if (e.target === e.currentTarget) closeRef.current?.(); }}>
      <div class="t-sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div class="t-grab" aria-hidden="true" />
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(node, document.body) : node;
}

// Re-run fn every ms while active and the tab is visible.
export function usePoll(fn, ms, active) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") saved.current();
    }, ms);
    return () => clearInterval(id);
  }, [active, ms]);
}

export function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

const timeFmt = () => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" });
const dayFmt = () => new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short" });
export function when(iso, now = Date.now()) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = (now - d.getTime()) / 1000;
  if (diff >= 0 && diff < 60) return t("temporal.when.justNow");
  if (diff >= 0 && diff < 3600) return t("temporal.when.minAgo", { n: Math.floor(diff / 60) });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return t("temporal.when.today", { time: timeFmt().format(d) });
  const y = new Date(now - 86400000);
  if (d.toDateString() === y.toDateString()) return t("temporal.when.yesterday", { time: timeFmt().format(d) });
  return dayFmt().format(d) + ", " + timeFmt().format(d);
}

export function formatDurationStr(raw) {
  if (raw == null || raw === "") return "";
  const text = String(raw).trim();
  const m = /^(\d+(?:\.\d+)?)s$/i.exec(text);
  if (!m) return text;
  const totalSec = Number(m[1]);
  if (!Number.isFinite(totalSec) || totalSec < 0) return text;
  if (totalSec < 1) return t("temporal.dur.lt1s");
  const s = Math.round(totalSec);
  if (s < 60) return t("temporal.dur.s", { n: s });
  const mins = Math.floor(s / 60);
  const remS = s % 60;
  if (mins < 60) return remS ? t("temporal.dur.ms", { m: mins, s: remS }) : t("temporal.dur.m", { n: mins });
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  return remM ? t("temporal.dur.hm", { h: hrs, m: remM }) : t("temporal.dur.h", { h: hrs });
}

export function duration(fromIso, toIso, now = Date.now()) {
  const a = Date.parse(fromIso), b = toIso ? Date.parse(toIso) : now;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return "";
  const s = Math.round((b - a) / 1000);
  if (s < 60) return t("temporal.dur.s", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("temporal.dur.m", { n: m });
  return t("temporal.dur.hm", { h: Math.floor(m / 60), m: m % 60 });
}

export function hashQuery() {
  if (typeof location === "undefined") return new URLSearchParams();
  const i = location.hash.indexOf("?");
  return new URLSearchParams(i < 0 ? "" : location.hash.slice(i + 1));
}

export const STEP_TYPES_UI = {
  timer: { icon: "⏱", get label() { return t("temporal.type.timer"); } },
  approval: { icon: "◆", get label() { return t("temporal.type.approval"); } },
  model: { icon: "✦", get label() { return t("temporal.type.model"); } },
  command: { icon: "⌘", get label() { return t("temporal.type.command"); } },
  parallel: { icon: "⑂", get label() { return t("temporal.type.parallel"); } },
  condition: { icon: "⋔", get label() { return t("temporal.type.condition"); } },
  artifact: { icon: "▤", get label() { return t("temporal.type.artifact"); } },
  pull_request: { icon: "⇡", get label() { return t("temporal.type.pull_request"); } },
};

export function errorText(e) {
  if (!e?.status) return t("temporal.err.offline");
  return e?.body?.error || t("temporal.err.generic");
}

export function sourceText(run) {
  if (run.source === "github") {
    const attempt = Number.isSafeInteger(run.attempt) && run.attempt > 0
      ? t("temporal.gh.attempt", { n: run.attempt, max: CI_ATTEMPTS_MAX })
      : "";
    return `GitHub · ${run.eventRef ?? t("temporal.gh.event")}${attempt}`;
  }
  if (run.source === "schedule") return t("temporal.source.schedule");
  return t("temporal.source.manual");
}

export function ghWait(reason = "") {
  const kind = String(reason).replace(/^(?:github|push)_/, "");
  if (kind === "auth") return { title: t("temporal.gh.wait.authTitle"), needToken: true, text: t("temporal.gh.wait.authText") };
  if (kind === "network") return { title: t("temporal.gh.wait.netTitle"), text: t("temporal.gh.wait.netText") };
  if (kind === "rate_limited") return { title: t("temporal.gh.wait.rateTitle"), text: t("temporal.gh.wait.rateText") };
  if (kind === "server") return { title: t("temporal.gh.wait.srvTitle"), text: t("temporal.gh.wait.srvText") };
  return { title: t("temporal.gh.wait.defTitle"), text: t("temporal.gh.wait.defText") };
}

export const prNumber = (url) => (/\/pull\/(\d+)/.exec(String(url ?? ""))?.[1] ?? null);
const commit = (sha) => (sha ? ` ${sha}` : "");

export function prOutcome(pr, mode = "new") {
  if (!pr) return null;
  if (pr.state === "no_changes") return { tone: "off", title: t("temporal.pr.noChangesTitle"), text: t("temporal.pr.noChangesText") };
  if (pr.state !== "done") return null;
  const number = prNumber(pr.url);
  const link = pr.url ? (number ? t("temporal.pr.openNum", { n: number }) : t("temporal.pr.open")) : null;
  if (pr.outcome === "pushed" || (!pr.outcome && mode === "same-branch"))
    return { tone: "ok", title: t("temporal.pr.pushedTitle", { sha: commit(pr.sha), branch: pr.branch ?? t("temporal.pr.prBranch") }), text: [number ? `PR #${number}` : null, t("temporal.pr.ciRestart")].filter(Boolean).join(" · "), url: pr.url ?? null, link };
  if (pr.outcome === "updated")
    return { tone: "ok", title: number ? t("temporal.pr.updatedNum", { n: number }) : t("temporal.pr.updated"), text: t("temporal.pr.updatedText", { branch: pr.branch ?? "PR", sha: commit(pr.sha) }), url: pr.url ?? null, link };
  if (pr.outcome === "created")
    return { tone: "ok", title: number ? t("temporal.pr.createdNum", { n: number }) : t("temporal.pr.created"), text: [pr.branch, pr.base ? `→ ${pr.base}` : null].filter(Boolean).join(" "), url: pr.url ?? null, link };
  if (pr.url) return { tone: "ok", title: number ? t("temporal.pr.readyNum", { n: number }) : t("temporal.pr.ready"), text: pr.branch ?? "", url: pr.url, link };
  return null;
}

const STEP_ERROR_CODES = new Set(["branch_moved", "push_rejected", "github_rejected", "no_token", "worktree", "forbidden", "no_repo", "command_failed"]);
export const stepErrorTitle = (code) => t(STEP_ERROR_CODES.has(code) ? "temporal.pr.err." + code : "temporal.pr.err.default");

export function RunStatus({ kind, stepError = null }) {
  if (stepError && kind === "err")
    return <span class="t-pill t-err" data-kind="err"><i aria-hidden="true">✕</i>{stepErrorTitle(stepError.code)}</span>;
  return <StatusPill kind={kind} />;
}

export function eventTarget(entry) {
  const ev = entry?.eventJson ?? {};
  const href = typeof ev.url === "string" && ev.url ? ev.url : null;
  if (ev.kind === "ci_failed" && ev.prNumber != null && entry?.repo) {
    try { return { href: `${new URL(ev.url).origin}/${entry.repo}/pull/${ev.prNumber}`, toPr: true }; } catch {}
  }
  return { href, toPr: false };
}
