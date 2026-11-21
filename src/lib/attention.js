// FEAT-20.2: «Доска внимания» на клиенте — один источник для доски, счётчика
// меню, заголовка вкладки, значка приложения и полосы на «Чатах».
//  - GET /teleharness/api/attention (сервер собирает доску и фильтрует по пользователю);
//  - перечитывание по событиям SSE (антидребезг 1 с) и личному teleharness.attention;
//  - раз в 30 с — только в видимой вкладке (это же — «пользователь смотрит
//    портал» для сводки «Пока вас не было» и push «Готово»/«Упало»);
//  - сбой сети не обнуляет данные: показываем последние с «данные на ЧЧ:ММ»;
//  - время — по часам сервера (смещение от `now` ответа), не по часам телефона.
import { computed, signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { api } from "./api.js";
import { prettyModelId } from "./engine.js";
import { t } from "./i18n.js";

export const board = signal(null); // последний удачный ответ сервера
export const boardStatus = signal({ loading: false, error: null, at: null }); // at — время удачного ответа (сервер)
export const boardOffset = signal(0); // serverNow − clientNow

export const serverNow = () => Date.now() + boardOffset.value;

// Счётчик пункта «Доска»: «Ждёт вас» (с ревью FEAT-20.1); при нуле и упавших — «!».
export function boardCounter(counts) {
  const needs = Number(counts?.needs) || 0;
  const failed = Number(counts?.failed) || 0;
  if (needs > 0) return { kind: "needs", text: String(needs), label: t("board.counter.needs", { count: needs }) };
  if (failed > 0) return { kind: "failed", text: `! ${failed}`, label: t("board.counter.failed", { count: failed }) };
  return null;
}
export const boardCount = computed(() => boardCounter(board.value?.counts));

// Формы числа (RU): 1 чат / 2 чата / 5 чатов.
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 10;
  const b = Math.abs(n) % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

let inflight = null;
let again = false;
export async function refreshBoard() {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = (async () => {
    do {
      again = false;
      boardStatus.value = { ...boardStatus.value, loading: true };
      try {
        const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
        const b = await api.attention({ active: visible });
        boardOffset.value = Number(b?.now) ? b.now - Date.now() : 0;
        board.value = b;
        boardStatus.value = { loading: false, error: null, at: b?.now ?? Date.now() };
      } catch (err) {
        // данные остаются прежними — счётчик не падает в 0 из-за обрыва
        boardStatus.value = { ...boardStatus.value, loading: false, error: err?.status ? "server" : "network" };
      }
    } while (again);
  })().finally(() => {
    inflight = null;
    syncTitleBadge();
  });
  return inflight;
}

let debounce = null;
export function scheduleBoardRefresh(ms = 1000) {
  if (debounce) return;
  debounce = setTimeout(() => {
    debounce = null;
    refreshBoard();
  }, ms);
  debounce.unref?.();
}

// События, меняющие состояние элементов доски.
const BOARD_EVENTS = new Set([
  "session.status", "session.idle", "session.error", "session.deleted",
  "permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected",
  "teleharness.attention", "teleharness.turn.stalled", "teleharness.resync",
]);
export function onBoardEvent(evt) {
  if (!started || !BOARD_EVENTS.has(evt?.type)) return;
  scheduleBoardRefresh(evt.type === "teleharness.attention" ? 200 : 1000);
}

let started = false;
let poll = null;
function onVisible() {
  if (document.visibilityState === "visible") refreshBoard(); // возврат из фона — перечитать
}
export function startBoard(ms = 30_000) {
  if (started) return;
  started = true;
  refreshBoard();
  if (typeof setInterval === "undefined") return;
  poll = setInterval(() => {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") refreshBoard();
  }, ms);
  poll.unref?.();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
}
export function stopBoard() {
  started = false;
  clearInterval(poll);
  poll = null;
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
}

// Заголовок вкладки «(N) …» и значок приложения (Badging API, где есть).
export function titleWithCount(title, n) {
  const base = String(title ?? "").replace(/^\(\d+\)\s+/, "");
  return n > 0 ? `(${n}) ${base}` : base;
}
export function syncTitleBadge() {
  const n = Number(board.value?.counts?.needs) || 0;
  if (typeof document !== "undefined") {
    const next = titleWithCount(document.title, n);
    if (next !== document.title) document.title = next;
  }
  const nav = globalThis.navigator;
  try {
    if (n > 0) nav?.setAppBadge?.(n)?.catch?.(() => {});
    else nav?.clearAppBadge?.()?.catch?.(() => {});
  } catch {}
}

// ---- действия ---------------------------------------------------------------
// Локально убираем элемент сразу (сервер подтвердит перечитыванием).
function dropLocal(keys) {
  const b = board.value;
  if (!b) return;
  const set = new Set(keys);
  const gone = b.items.filter((it) => set.has(it.key));
  if (!gone.length) return;
  const counts = { ...b.counts };
  for (const it of gone) {
    counts[it.state] = Math.max(0, (counts[it.state] ?? 0) - 1);
    if (it.state === "needs" && it.reason === "review") counts.review = Math.max(0, (counts.review ?? 0) - 1);
  }
  board.value = { ...b, counts, items: b.items.filter((it) => !set.has(it.key)) };
  syncTitleBadge();
}

export async function markSeen(keys) {
  await api.attentionSeen({ keys });
  dropLocal(keys);
  scheduleBoardRefresh(300);
}
// «Отметить все» — только известные на версии upTo (момент открытия подтверждения).
export async function markSectionSeen(section, upTo, filter = {}) {
  const r = await api.attentionSeen({ section, upTo, ...(filter.project ? { project: filter.project } : {}), ...(filter.q ? { q: filter.q } : {}) });
  const b = board.value;
  if (b) dropLocal(b.items.filter((it) => it.state === section && it.at <= upTo && matches(it, filter)).map((it) => it.key));
  scheduleBoardRefresh(300);
  return r;
}
export async function snooze(key, until) {
  await api.attentionSnooze(key, until);
  scheduleBoardRefresh(200);
}
export async function ackAway(until) {
  await api.attentionAwayAck(until);
  if (board.value) board.value = { ...board.value, away: null };
}

// Фильтр по проекту и поиск по названию (на клиенте — мгновенно).
export function matches(it, { project = null, q = "" } = {}) {
  if (project && it.project?.dir !== project) return false;
  const s = String(q ?? "").trim().toLowerCase();
  return !s || String(it.title ?? "").toLowerCase().includes(s);
}

// Отметка просмотра открытием: элемент «Готово»/«Упало» этого ключа, видимое
// окно не меньше 2 с. Возвращает функцию отмены таймера.
export function seenAfterVisible(key, { delayMs = 2000 } = {}) {
  const it = board.value?.items?.find((x) => x.key === key);
  if (!it || !["done", "failed", "older"].includes(it.state)) return () => {};
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return () => {};
  const t = setTimeout(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    markSeen([key]).catch(() => {});
  }, delayMs);
  return () => clearTimeout(t);
}

// Хук экранов чата и запуска: открытый в видимом окне ≥ 2 с — просмотрен (кр. 5).
// Перезапускается, когда элемент снова «Готово» (агент закончил ещё один ход) и
// при возврате вкладки из фона.
export function useSeenOnOpen(key) {
  const it = key ? board.value?.items?.find((x) => x.key === key) : null;
  const sig = it && ["done", "failed", "older"].includes(it.state) ? `${it.state}:${it.at}` : "";
  const [vis, setVis] = useState(0);
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const on = () => setVis((n) => n + 1);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  useEffect(() => (sig ? seenAfterVisible(key) : undefined), [key, sig, vis]);
}

// ---- тексты --------------------------------------------------------------------
const secObj = (k) => ({
  get title() { return t(`board.sec.${k}.title`); },
  get short() { return t(`board.sec.${k}.short`); },
  get word() { return t(`board.sec.${k}.word`); },
});
export const SECTION = {
  needs: secObj("needs"),
  working: secObj("working"),
  done: secObj("done"),
  failed: secObj("failed"),
  unknown: secObj("unknown"),
  snoozed: secObj("snoozed"),
  older: secObj("older"),
};

export function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return t("board.ago.ltMin");
  if (m < 60) return t("board.ago.min", { m });
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? t("board.ago.hm", { h, m: r }) : t("board.ago.h", { h });
  const d = Math.floor(h / 24);
  return t("board.ago.days", { count: d });
}
export function hhmm(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// «ждёт 12 мин» / «идёт 41 мин» / «готово в 03:40» (сегодня) / «готово 18.11».
export function timeText(it, now) {
  const at = it.state === "needs" || it.state === "working" || it.state === "unknown" ? it.since : it.at;
  if (it.state === "needs") return t("board.time.waiting", { ago: ago(now - at) });
  if (it.state === "working") return t("board.time.running", { ago: ago(now - at) });
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  return today ? t("board.time.at", { hhmm: hhmm(at) }) : `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// BUG-277: на карточке — короткое время без глагола и без переноса («12 мин»,
// «10 ч 16», «в 21:03»); полное «ждёт 12 мин» остаётся в подписи для чтения с экрана.
export function shortAgo(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return t("board.shortAgo.ltMin");
  if (m < 60) return t("board.shortAgo.min", { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("board.shortAgo.hm", { h, m: String(m % 60).padStart(2, "0") });
  const d = Math.floor(h / 24);
  return t("board.shortAgo.d", { d });
}
export function timeShort(it, now) {
  if (it.state === "needs" || it.state === "working" || it.state === "unknown") return shortAgo(now - it.since);
  return timeText(it, now);
}

const ENGINE = { claude: "Claude", opencode: "opencode", codex: "Codex", acp: "ACP", temporal: "Temporal" };
export const engineLabel = (e) => ENGINE[e] ?? e ?? "";

// BUG-277: модель — человеческим именем, как в остальном портале («Claude Opus 5.5»,
// «GLM-5.3-Flash»), а не сырым id «claude-opus-5-5».
export const modelLabel = (id) => (id ? prettyModelId(id) : "");

// BUG-277: проект на карточке. Домашняя папка — не проект (в ней — имя
// пользователя ОС, «USER»): не показываем. Папка рабочей копии
// «…/.teleharness-worktrees/<репо>/<копия>» — имя репозитория, а не транслит-слаг копии.
export function projectLabel(project) {
  const dir = String(project?.dir ?? "");
  if (dir && /[\\/](?:users|home)[\\/]+[^\\/]+[\\/]*$/i.test(dir)) return "";
  const wt = dir.match(/[\\/]\.teleharness-worktrees[\\/]+([^\\/]+)[\\/]+[^\\/]+[\\/]*$/);
  if (wt) return wt[1];
  return project?.name || (dir ? shortPath(dir) : "");
}
export function itemMeta(it) {
  return [projectLabel(it.project), it.model ? modelLabel(it.model) : engineLabel(it.engine)].filter(Boolean).join(" · ");
}

// Строка состояния элемента: слово + что именно (значок рисует компонент).
export function reasonText(it, now = Date.now()) {
  switch (it.state) {
    case "needs":
      if (it.reason === "permission") return it.agent ? t("board.reason.permAgent", { agent: it.agent }) : (it.permission?.tool ? t("board.reason.permTool", { tool: it.permission.tool }) : t("board.reason.perm"));
      if (it.reason === "question") return it.agent ? t("board.reason.questionAgent", { agent: it.agent }) : t("board.reason.question");
      if (it.reason === "decision") return t("board.reason.decision");
      if (it.reason === "review") return t("board.reason.review", { count: it.review?.files ?? 0 });
      return t("board.reason.needsOther");
    case "working":
      if (it.reason === "quiet") return t("board.reason.quiet", { ago: ago(it.silentMs ?? 0) });
      if (it.reason === "bg") return t("board.reason.bg", { count: it.bgAgents });
      if (it.reason === "quota") return t("board.reason.quota");
      if (it.reason === "paused") return t("board.reason.paused");
      return it.kind === "run" ? t("board.reason.runWorking") : t("board.reason.turnWorking");
    case "done":
      return it.kind === "run" ? t("board.reason.runDone") : t("board.reason.done");
    case "failed":
      if (it.reason === "restart") return t("board.reason.restart", { hhmm: hhmm(it.at) });
      if (it.reason === "stalled") return t("board.reason.stalled");
      if (it.reason === "limit") return t("board.reason.limit", { engine: engineLabel(it.engine) });
      if (it.reason === "auth") return it.snippet?.includes("администратор") ? t("board.reason.authUnavailable", { engine: engineLabel(it.engine) }) : t("board.reason.authNeeded", { engine: engineLabel(it.engine) });
      if (it.reason === "rejected") return t("board.reason.rejected");
      if (it.reason === "terminated") return t("board.reason.terminated");
      return it.kind === "run" ? t("board.reason.runFailed") : t("board.reason.turnError");
    case "unknown":
      return t("board.reason.unknown", { target: it.kind === "run" ? "Temporal" : engineLabel(it.engine) });
    case "snoozed":
      return t("board.reason.snoozedUntil", { hhmm: hhmm(it.until) });
    case "older":
      return it.olderFrom === "failed" ? t("board.reason.olderFailed") : t("board.reason.done");
    default:
      return "";
  }
}

// Путь проекта режется с начала: «…/epic20/attention-board».
export function shortPath(dir, max = 32) {
  const s = String(dir ?? "");
  if (s.length <= max) return s;
  const parts = s.split(/[\\/]/).filter(Boolean);
  let out = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = parts[i] + (out ? "/" + out : "");
    if (next.length + 2 > max) break;
    out = next;
  }
  return "…/" + (out || parts.at(-1)?.slice(-(max - 2)) || "");
}
