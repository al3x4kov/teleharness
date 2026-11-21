// FEAT-20.7: клиент рабочих копий — API /teleharness/api/worktrees/*, состояние копии
// чата (сигналы), события teleharness.worktree.updated, чистые помощники для экранов
// (слова состояний, шаги слияния, полосы пересечений) — их проверяют node-тесты.
import { signal } from "@preact/signals";
import { WT_KIND_TITLE as SHARED_WT_KIND_TITLE } from "../../shared/worktree.js";
import { lang, t } from "./i18n.js";

export const WT_KIND_TITLE = Object.defineProperties(
  {},
  Object.fromEntries(Object.keys(SHARED_WT_KIND_TITLE).map((k) => [k, { enumerable: true, get: () => t(`worktree.kind.${k}`) }])),
);
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) {
    const num = (v / 1024 ** 3).toFixed(1);
    return t("worktree.bytes.gb", { n: lang.value === "ru" ? num.replace(".", ",") : num });
  }
  if (v >= 1024 ** 2) return t("worktree.bytes.mb", { n: Math.round(v / 1024 ** 2) });
  if (v >= 1024) return t("worktree.bytes.kb", { n: Math.round(v / 1024) });
  return t("worktree.bytes.b", { n: v });
}
const BASE = "/teleharness/api";
async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}
const enc = encodeURIComponent;
export const wtApi = {
  plan: ({ sid, directory }) => call("GET", `/worktrees/plan?${sid ? `sid=${enc(sid)}` : `directory=${enc(directory)}`}`),
  pending: (sid, body) => call("POST", `/worktrees/pending?sid=${enc(sid)}`, body),
  // ключ "run:<workflowId>" — копия запуска пайпа (экран запуска)
  ofChat: (sid, { overlaps = true } = {}) => call("GET", `/worktrees?${String(sid).startsWith("run:") ? `run=${enc(String(sid).slice(4))}` : `sid=${enc(sid)}`}${overlaps ? "" : "&overlaps=0"}`),
  ofRepo: (directory) => call("GET", `/worktrees?directory=${enc(directory)}`),
  get: (id) => call("GET", `/worktrees/${enc(id)}`),
  unsaved: (id) => call("GET", `/worktrees/${enc(id)}/unsaved`),
  sync: (id) => call("POST", `/worktrees/${enc(id)}/sync`, {}),
  merge: (id, body) => call("POST", `/worktrees/${enc(id)}/merge`, body),
  op: (opId) => call("GET", `/worktrees/ops/${enc(opId)}`),
  opLog: (opId) => call("GET", `/worktrees/ops/${enc(opId)}?log=1`),
  action: (id, name, body = {}) => call("POST", `/worktrees/${enc(id)}/${name}`, body),
  remove: (id, mode = "auto", confirm = false) => call("DELETE", `/worktrees/${enc(id)}?mode=${enc(mode)}${confirm ? "&confirm=1" : ""}`),
  deleteBranch: (directory, name) => call("DELETE", `/worktrees/branches?directory=${enc(directory)}&name=${enc(name)}`),
  setTestCmd: (directory, cmd) => call("PUT", `/worktrees/test-cmd?directory=${enc(directory)}`, { cmd }),
  init: ({ sid, directory }) => call("POST", `/worktrees/init?${sid ? `sid=${enc(sid)}` : `directory=${enc(directory)}`}`, {}),
  settings: () => call("GET", "/me/worktrees"),
  saveSettings: (patch) => call("PUT", "/me/worktrees", patch),
  suggest: (sid, files) => call("POST", `/git/suggest-message?sid=${enc(sid)}`, { sid, files }),
};

// ---- состояние ------------------------------------------------------------------
// sid → {item, pending, at, error}
export const wtByChat = signal({});
export const wtTick = signal(0);
// Ошибка создания копии при первом сообщении: sid → {kind, error, ...}
export const wtCreateError = signal({});

export function setChatWt(sid, patch) {
  wtByChat.value = { ...wtByChat.value, [sid]: { ...(wtByChat.value[sid] ?? {}), ...patch, at: Date.now() } };
}
export async function loadChatWt(sid, { overlaps = true } = {}) {
  if (!sid) return null;
  try {
    const r = await wtApi.ofChat(sid, { overlaps });
    setChatWt(sid, { item: r.item, pending: r.pending, error: null, offline: false });
    return r;
  } catch (err) {
    setChatWt(sid, { error: err?.message ?? String(err), offline: !err?.status });
    return null;
  }
}
// Отказ создания копии на первом сообщении (store/session.js deliver).
export function noteWorktreeError(sid, body) {
  if (!sid || !body?.worktree) return;
  wtCreateError.value = { ...wtCreateError.value, [sid]: { ...body, at: Date.now() } };
}
export function clearWorktreeError(sid) {
  if (!wtCreateError.value[sid]) return;
  const { [sid]: _x, ...rest } = wtCreateError.value;
  wtCreateError.value = rest;
}
// SSE: teleharness.worktree.updated → перечитать копию чата (и экраны списка).
export function onWorktreeEvent(evt) {
  if (evt?.type !== "teleharness.worktree.updated") return;
  wtTick.value += 1;
  const sid = evt.properties?.sid;
  if (sid && wtByChat.value[sid]) void loadChatWt(sid);
}

// ---- чистые помощники -------------------------------------------------------------

// Имя ветки для узкой строки: режется С НАЧАЛА (видны концовка и id).
export function shortBranch(name, max = 28) {
  const s = String(name ?? "");
  if (s.length <= max) return s;
  return "…" + s.slice(s.length - max + 1);
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
export const filesWord = (n) => t("worktree.files", { count: n });

// Строка «впереди на N · main ушла на M».
export function aheadLine(st) {
  if (!st) return "";
  return t("worktree.aheadLine", { ahead: st.ahead ?? 0, base: st.base, behind: st.behind ?? 0 });
}

// Шаги слияния для списка с кружками: {key, label, state: wait|run|ok|fail|skip}.
export function mergeSteps(op, { base = "main" } = {}) {
  const s = op?.steps ?? {};
  const tst = op?.test ?? {};
  const testLabel = s.test === "skip"
    ? t("worktree.step.testSkipped")
    : tst.passed
      ? (tst.summary?.pass != null ? t("worktree.step.testPassedN", { n: tst.summary.pass }) : t("worktree.step.testPassed"))
      : tst.passed === false
        ? (tst.summary?.fail != null ? t("worktree.step.testFailedN", { n: tst.summary.fail }) : t("worktree.step.testFailed"))
        : (tst.cmd ? t("worktree.step.testCmd", { cmd: tst.cmd }) : t("worktree.step.test"));
  return [
    { key: "precheck", label: t("worktree.step.precheck"), state: s.precheck ?? "wait" },
    { key: "update", label: t("worktree.step.update", { base }), state: s.update ?? "wait" },
    { key: "test", label: testLabel, state: s.test ?? "wait" },
    { key: "advance", label: t("worktree.step.advance", { base }), state: s.advance ?? "wait" },
  ];
}
export const STEP_ICON = { wait: "○", run: "…", ok: "✓", fail: "✕", skip: "–" };

export function opFinished(op) {
  return Boolean(op && ["done", "failed", "interrupted"].includes(op.phase));
}

// Итог операции для листа: {tone: ok|bad|warn, title, text}.
export function opOutcome(op, { base = "main" } = {}) {
  if (!op) return null;
  if (op.phase === "done") {
    const tst = op.test?.passed
      ? (op.test.summary?.pass != null && op.test.summary?.pass !== "" ? t("worktree.outcome.testsOk", { n: op.test.summary.pass }) : t("worktree.outcome.testsOkPlain"))
      : op.skipTests ? t("worktree.outcome.noTests") : "";
    return { tone: "ok", title: t("worktree.outcome.mergedTitle", { base }), text: `${filesWord(op.files ?? 0)}${tst}` };
  }
  if (op.phase === "interrupted") return { tone: "warn", title: t("worktree.outcome.interruptedTitle"), text: t("worktree.outcome.baseUnchanged", { base }) };
  if (op.phase !== "failed") return null;
  const title = (WT_KIND_TITLE[op.kind] ?? t("worktree.outcome.failedDefault")).replace("main", base);
  // текст ошибки, повторяющий заголовок, не дублируется (dogfood 2026-11-20)
  const err = String(op.error ?? "").replace(/main/g, base);
  const text = !err || err === title || title.startsWith(err) || err.startsWith(title) ? "" : err;
  return { tone: op.kind === "conflict" || op.kind === "tests-failed" ? "bad" : "warn", title, text, baseUnchanged: /(не изменена|unchanged)/i.test(title + text) };
}

// Полосы над композером (максимум две; остальные — «и ещё N» в листе).
export function overlapBars(overlaps = []) {
  const bars = overlaps.map((o) => {
    const n = o.files?.length ?? 0;
    const conflict = Boolean(o.conflict);
    let text;
    if (o.kind === "main") text = t("worktree.overlap.main", { files: filesWord(n) });
    else if (o.kind === "base") text = t(conflict ? "worktree.overlap.baseConflict" : "worktree.overlap.base", { base: o.title ?? "main", files: filesWord(n) });
    else text = t("worktree.overlap.chat", { name: o.title ?? o.branch ?? "…", files: filesWord(n) });
    return { ...o, text, tone: conflict ? "bad" : "warn" };
  });
  bars.sort((a, b) => Number(b.conflict) - Number(a.conflict));
  return { shown: bars.slice(0, 2), more: Math.max(0, bars.length - 2), all: bars };
}

// Что сказать про удаление (диалог удаления чата) — общий текст с сервером (BUG-273).
export function unsavedText(u, base = "main", { bare = false } = {}) {
  if (!u) return "";
  const parts = [];
  if (u.uncommitted) parts.push(t("worktree.uncommittedFiles", { count: u.uncommitted }));
  if (u.commits) parts.push(t("worktree.unsaved.commitsNotIn", { commits: t("worktree.commits", { count: u.commits }), base }));
  if (!parts.length) return "";
  const joined = parts.join(t("worktree.unsaved.join"));
  return bare ? joined : t("worktree.unsaved.inCopy", { parts: joined });
}

// Причина недоступности переключателя.
export function planBlocked(plan) {
  if (!plan) return null;
  if (plan.repo) return null;
  if (plan.reason === "no-commits") return { text: t("worktree.plan.noCommits"), init: false };
  if (plan.reason === "dirty-config") return { text: plan.error ?? t("worktree.plan.dirtyConfig"), init: false };
  return { text: t("worktree.plan.notGit"), init: true };
}

export function newIdemKey() {
  const a = new Uint8Array(10);
  (globalThis.crypto ?? { getRandomValues: (x) => x.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(a);
  return "m_" + [...a].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 16);
}
