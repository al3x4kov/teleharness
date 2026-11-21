// FEAT-20.1: клиент ревью — API, локальные черновики, выбор строк, события.
// Чистые помощники (selectLines, quoteOf, lineRows, reviewStatusWord …)
// импортируются node-тестами без DOM.
//
// Черновики (кр. 5, N-7, N-38): текст комментария пишется в localStorage сразу
// (ключ на пользователя и пункт) и на сервер с антидребезгом ≤ 2 с; при
// открытии экрана локальная копия новее серверной — досылается.
import { signal } from "@preact/signals";
import { parseUnified } from "./diff.js";
import { prettyModelId } from "./engine.js";
import { t } from "./i18n.js";
import { reviewMarker } from "../../shared/review-message.js";

export { reviewMarker };
export const SELECT_MAX = 200;

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
export const reviewApi = {
  list: (filter = "all", cursor = 0) => call("GET", `/review?filter=${enc(filter)}&cursor=${cursor}&accepted=1`),
  chat: (sid) => call("GET", `/review/chat/${enc(sid)}`),
  get: (id) => call("GET", `/review/${enc(id)}`),
  diff: (id, { file, rev, since, full } = {}) => {
    const q = new URLSearchParams({ file });
    if (rev) q.set("rev", String(rev));
    if (since) q.set("since", String(since));
    if (full) q.set("full", "1");
    return call("GET", `/review/${enc(id)}/diff?${q}`);
  },
  patchUrl: (id, file) => `${BASE}/review/${enc(id)}/diff?file=${enc(file)}&raw=1`,
  preview: (id, general) => call("POST", `/review/${enc(id)}/preview`, { general, lang: "ru" }),
  refresh: (id) => call("POST", `/review/${enc(id)}/refresh`, {}),
  putComment: (id, cid, body) => call("PUT", `/review/${enc(id)}/comments/${enc(cid)}`, body),
  deleteComment: (id, cid, version) => call("DELETE", `/review/${enc(id)}/comments/${enc(cid)}?version=${version}`),
  viewed: (id, file, viewed = true) => call("POST", `/review/${enc(id)}/viewed`, { file, viewed }),
  send: (id, body) => call("POST", `/review/${enc(id)}/send`, { lang: "ru", ...body }),
  accept: (id, body) => call("POST", `/review/${enc(id)}/accept`, body),
  dismiss: (id, body) => call("POST", `/review/${enc(id)}/dismiss`, body),
  plan: (id, action, body) => call("POST", `/plan/${enc(id)}/${action}`, body),
  setPlanFirst: (sid, on) => call("PATCH", `/session/${enc(sid)}/binding`, { planFirst: Boolean(on) }),
};

export function newKey(prefix = "k") {
  const a = new Uint8Array(12);
  (globalThis.crypto ?? { getRandomValues: (x) => x.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(a);
  return prefix + "_" + [...a].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 20);
}
export const newCommentId = () => newKey("c");

// ---- слова ------------------------------------------------------------------------
const stObj = (k, icon) => ({ get word() { return t(`review.status.${k}`); }, icon });
export const STATUS = {
  waiting: stObj("waiting", "●"),
  decision: stObj("decision", "◆"),
  changed: stObj("changed", "↻"),
  interrupted: stObj("interrupted", "■"),
  returned: stObj("returned", "◌"),
  "chat-deleted": stObj("chatDeleted", "×"),
};
export const reviewStatusWord = (s) => STATUS[s]?.word ?? t("review.status.waiting");

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
export const filesWord = (n) => t("review.filesWord", { count: n });
export const turnsWord = (n) => t("review.turnsWord", { count: n });
export const commentsWord = (n) => t("review.commentsWord", { count: n });
export const MODE_REASON = {
  get "no-git"() { return t("review.mode.noGit"); },
  get "unsafe-repo"() { return t("review.mode.unsafeRepo"); },
  get "too-big"() { return t("review.mode.tooBig"); },
  get quota() { return t("review.mode.quota"); },
  get "snapshot-failed"() { return t("review.mode.failed"); },
};
export const STATUS_LETTER = {
  get M() { return t("review.letter.M"); },
  get A() { return t("review.letter.A"); },
  get D() { return t("review.letter.D"); },
  get R() { return t("review.letter.R"); },
};

// ---- строки диффа -----------------------------------------------------------------

// Плоский список строк файла для экрана ревью: {kind: "hunk"|"line"|"gap", …}.
// Строка: {i, t, text, o, n, side, no} — side "new" (контекст и «+»), "old" («−»).
// gap — свёрнутый участок между кусками (выделение через него не идёт, N-13).
export function lineRows(hunks) {
  const rows = [];
  let i = 0;
  let block = 0; // участки между свёрнутыми кусками: выделение не переходит границу
  (hunks ?? []).forEach((h, hi) => {
    if (hi > 0 || (h.oldStart ?? 1) > 1) {
      const prev = hi > 0 ? hunks[hi - 1] : null;
      const hidden = prev && prev.oldStart != null && h.oldStart != null ? h.oldStart - (prev.oldStart + prev.oldLines) : h.oldStart != null ? h.oldStart - 1 : null;
      if (hidden == null || hidden > 0) {
        rows.push({ kind: "gap", key: `g${hi}`, hidden });
        if (hi > 0) block += 1;
      }
    }
    rows.push({ kind: "hunk", key: `h${hi}`, header: h.header ?? null, newStart: h.newStart ?? null });
    for (const l of h.lines ?? []) {
      const side = l.t === "-" ? "old" : "new";
      rows.push({ kind: "line", key: `l${i}`, i: i++, t: l.t, text: l.text, o: l.o ?? null, n: l.n ?? null, side, no: side === "old" ? l.o ?? null : l.n ?? null, hunk: block });
    }
  });
  return rows;
}
export const linesOf = (rows) => rows.filter((r) => r.kind === "line");

// Выбор диапазона: anchor (индекс первой строки) и target. Правила кр. 3:
// одна сторона («стало» — контекст и «+», «было» — «−»); не через свёрнутый
// участок (N-13 — «Разверните, чтобы выделить»); не больше 200 строк (N-18).
// → {from, to, error?}: from/to — индексы в rows (строки lineRows).
export function selectLines(rows, anchor, target, sideOf = null) {
  const lines = linesOf(rows);
  const a = lines.find((l) => l.i === anchor);
  const b = lines.find((l) => l.i === target);
  if (!a || !b) return { from: anchor, to: anchor };
  const side = sideOf ?? a.side;
  const [lo, hi] = a.i <= b.i ? [a, b] : [b, a];
  const span = lines.filter((l) => l.i >= lo.i && l.i <= hi.i);
  if (span.some((l) => l.hunk !== a.hunk)) {
    const same = span.filter((l) => l.hunk === a.hunk);
    const edge = a.i <= b.i ? same.at(-1) : same[0];
    return { from: Math.min(a.i, edge.i), to: Math.max(a.i, edge.i), error: t("review.err.expandToSelect") };
  }
  const ofSide = span.filter((l) => (side === "old" ? l.side === "old" : l.side === "new"));
  if (ofSide.length > SELECT_MAX) {
    const keep = a.i <= b.i ? ofSide.slice(0, SELECT_MAX) : ofSide.slice(-SELECT_MAX);
    return { from: Math.min(keep[0].i, keep.at(-1).i), to: Math.max(keep[0].i, keep.at(-1).i), error: t("review.err.maxLines") };
  }
  return { from: lo.i, to: hi.i };
}

// Комментарий из выделения: сторона первой строки, номера и цитата её стороны.
export function selectionComment(rows, sel) {
  const lines = linesOf(rows).filter((l) => l.i >= sel.from && l.i <= sel.to);
  const first = lines.find((l) => l.i === sel.anchor) ?? lines[0];
  const side = first?.side ?? "new";
  const mine = lines.filter((l) => l.side === side);
  const nums = mine.map((l) => l.no).filter((x) => Number.isInteger(x));
  return {
    side,
    from: nums.length ? Math.min(...nums) : null,
    to: nums.length ? Math.max(...nums) : null,
    quote: mine.map((l) => l.text),
    count: mine.length,
    kind: side === "old" ? "удалены" : mine.every((l) => l.t === "+") ? "добавлены" : mine.some((l) => l.t === "+") ? "изменены" : "без изменений",
  };
}

export function selectionLabel(c) {
  const lines = t("review.linesWord", { count: c.count });
  if (c.from == null) return t("review.sel.snippet", { lines });
  const range = c.from === c.to ? t("review.sel.line", { n: c.from }) : t("review.sel.lines", { from: c.from, to: c.to });
  const pre = c.side === "old" ? (c.from === c.to ? t("review.sel.delLine", { n: c.from }) : t("review.sel.delLines", { from: c.from, to: c.to })) : range;
  const kMap = c.count === 1
    ? { добавлены: "review.sel.kind.addedOne", изменены: "review.sel.kind.changedOne", "без изменений": "review.sel.kind.unchangedOne" }
    : { добавлены: "review.sel.kind.added", изменены: "review.sel.kind.changed", "без изменений": "review.sel.kind.unchanged" };
  const kind = kMap[c.kind] ? t(kMap[c.kind]) : c.kind;
  return `${pre} · ${lines}${c.side === "old" ? "" : ` · ${kind}`}`;
}

export function commentLabel(c) {
  if (c.side === "general") return t("review.comment.general");
  if (c.side === "file") return t("review.comment.file");
  if (c.from == null) return t("review.comment.nearLine");
  if (c.side === "old") return c.from === c.to ? t("review.sel.delLine", { n: c.from }) : t("review.sel.delLines", { from: c.from, to: c.to });
  return c.from === c.to ? t("review.sel.line", { n: c.from }) : t("review.sel.lines", { from: c.from, to: c.to });
}

// Индекс строки, под которой рисуется карточка комментария (последняя строка диапазона).
export function anchorRow(rows, c) {
  const lines = linesOf(rows);
  if (c.side !== "new" && c.side !== "old") return null;
  if (c.from != null) {
    const hit = lines.filter((l) => l.side === c.side && Number.isInteger(l.no) && l.no >= c.from && l.no <= (c.to ?? c.from));
    return hit.length ? hit.at(-1).i : null;
  }
  // без номеров — по тексту цитаты (N-17)
  const q = c.quote ?? [];
  if (!q.length) return null;
  for (let k = 0; k + q.length <= lines.length; k++) {
    if (q.every((t, j) => lines[k + j].text === t)) return lines[k + q.length - 1].i;
  }
  return null;
}

export const hunksOfPatch = (patch) => parseUnified(patch ?? "")[0]?.hunks ?? [];

// ---- локальные черновики ----------------------------------------------------------
const LS = () => (typeof localStorage !== "undefined" ? localStorage : null);
const lsKey = (user, id) => `teleharness.review.${user ?? "me"}.${id}`;
export function localDrafts(user, id) {
  try {
    return JSON.parse(LS()?.getItem(lsKey(user, id)) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
export function saveLocalDraft(user, id, cid, draft) {
  const all = localDrafts(user, id);
  if (draft == null) delete all[cid];
  else all[cid] = { ...draft, at: Date.now() };
  try {
    LS()?.setItem(lsKey(user, id), JSON.stringify(all));
  } catch {}
}

// ---- события ------------------------------------------------------------------------
// Последнее событие ревью/плана (экран ревью и карточки в чате перечитываются).
export const reviewTick = signal(0);
export const lastReviewEvent = signal(null);
export function onReviewEvent(evt) {
  if (evt?.type !== "teleharness.review.updated" && evt?.type !== "teleharness.plan.updated") return;
  lastReviewEvent.value = { type: evt.type, ...(evt.properties ?? {}), at: Date.now() };
  reviewTick.value += 1;
}

export function hhmm(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// BUG-277: имя модели — как в остальном портале (каталог Claude, GLM-5.3-Flash),
// раньше «Claude sonnet 5.5», «GPT-6.1-sol».
export function shortModel(m) {
  return prettyModelId(m);
}
