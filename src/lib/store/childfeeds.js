// FEAT-01.77: ленты дочерних сессий субагентов открытого чата. Дочерняя
// сессия opencode — обычная сессия с parentID; её события маршрутятся сюда
// (events.js), лента грузится страницей и живёт рядом с открытым чатом.
// На лентах строятся вычисляемые запуски (chatRuns) для карточек агентов.
import { computed, effect, signal } from "@preact/signals";
import { api } from "../api.js";
import { makeMessage } from "../normalize.js";
import { activeRuns, runsOfMessages } from "../subagents.js";
import { active, busyMap, engineOfSession, sessionDir, sessions } from "./state.js";

// История грузится одной страницей (как открытый чат); hasMore → лента
// считается неполной и перечитывается при следующем ensure/refresh.
export const CHILD_PAGE = 100;
// Одновременно грузится не больше трёх лент — у агентного хода детей может
// быть много, а каждая страница — полный ответ сервера.
const MAX_PARALLEL = 3;
// Ленты переживают закрытие агентов ради истории; потолок 50, вытесняются
// самые старые завершённые.
const MAX_FEEDS = 50;

// childId → { messages, loadedAt, complete, loading, error }
export const childFeeds = signal(new Map());

let seq = 0; // монотонный порядок заведённых лент (для вытеснения)
const inflight = new Map(); // childId → Promise текущей загрузки
const failedIds = new Set(); // загрузка не удалась: не ретраим без force
let running = 0;
const waiters = [];

function patchEntry(id, fn) {
  const next = new Map(childFeeds.value);
  if (!next.has(id) && next.size >= MAX_FEEDS) evictOldest(next);
  const cur = next.get(id) ?? null;
  const entry = fn(cur);
  if (entry) next.set(id, entry);
  childFeeds.value = next;
}

function evictOldest(map) {
  const ids = [...map.entries()]
    .filter(([, e]) => e.complete && !e.loading)
    .sort((a, b) => a[1].loadedAt - b[1].loadedAt)
    .map(([id]) => id);
  while (ids.length > 0 && map.size >= MAX_FEEDS) map.delete(ids.shift());
}

// Сообщения ленты ребёнка (или null, если лента не заведена).
export function childFeedOf(id) {
  return childFeeds.value.get(id)?.messages ?? null;
}

// Патч сообщений ленты (events.js): fn(messages) → messages. Заводит ленту.
export function patchChildFeed(id, fn) {
  if (!id || typeof fn !== "function") return;
  patchEntry(id, (cur) => {
    const messages = fn(cur?.messages ?? []);
    return {
      messages: Array.isArray(messages) ? messages : [],
      loadedAt: cur?.loadedAt ?? ++seq,
      complete: cur?.complete ?? true,
      loading: false,
      error: cur?.error ?? false,
    };
  });
}

// Грузит ленту ребёнка один раз; повторные вызовы — из кэша; одновременные —
// один запрос; ошибка не ретраится сама (только force или новая сессия).
export async function ensureChildFeed(id, { force = false } = {}) {
  if (!id || typeof id !== "string") return;
  const cur = childFeeds.value.get(id);
  if (!force && (cur?.complete || cur?.error || failedIds.has(id))) return;
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    if (running >= MAX_PARALLEL) await new Promise((res) => waiters.push(res));
    running += 1;
    try {
      const page = await api.getMessagesPage(id, { limit: CHILD_PAGE, directory: sessionDir(id) });
      // Реальный контракт GET /message: новые раньше старых → разворот в
      // хронологию; хвостовое живое сообщение, которого в истории ещё нет,
      // остаётся (слияние по id).
      const shaped = (page?.list ?? []).map((m) => makeMessage(m?.info ?? m, m?.parts ?? []));
      failedIds.delete(id);
      patchEntry(id, (cur0) => {
        const have = new Set(shaped.map((m) => m.info?.id).filter(Boolean));
        const liveOnly = (cur0?.messages ?? []).filter((m) => m.info?.id && !have.has(m.info.id));
        const messages = [...shaped.slice().reverse(), ...liveOnly].sort(
          (a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0),
        );
        return { messages, loadedAt: cur0?.loadedAt ?? ++seq, complete: page?.hasMore ? false : true, loading: false, error: false };
      });
    } catch {
      // Молча: лента — вспомогательные данные, карточка агента живёт и без неё.
      // Пустую ленту ошибкой не заводим (childFeedOf остаётся null).
      failedIds.add(id);
      if (childFeeds.value.get(id)) patchEntry(id, (cur0) => ({ ...cur0, loading: false, error: true, complete: false }));
    } finally {
      running -= 1;
      const next = waiters.shift();
      if (next) next();
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
}

export function resetChildFeeds() {
  inflight.clear();
  failedIds.clear();
  childFeeds.value = new Map();
}

// Дети активного чата: из metadata частей (sessionID/sessionId, включая
// вложенных — через их ленты, глубина ≤ 5) + записи списка сессий с parentID,
// транзитивно ведущим в открытый чат.
export function childIdsOfActive() {
  const act = active.value;
  if (!act) return [];
  const out = [];
  const seen = new Set();
  const walk = (messages, depth) => {
    if (!Array.isArray(messages) || depth > 5) return;
    for (const m of messages) {
      for (const p of m?.parts ?? []) {
        if (p?.type !== "tool") continue;
        const meta = p?.state?.metadata;
        const cid = meta?.sessionID ?? meta?.sessionId ?? null;
        if (cid && !seen.has(cid)) {
          seen.add(cid);
          out.push(cid);
          walk(childFeedOf(cid), depth + 1);
        }
      }
    }
  };
  walk(act.messages, 0);
  const byId = new Map(sessions.value.map((s) => [s.id, s]));
  for (const s of sessions.value) {
    if (!s?.parentID || seen.has(s.id)) continue;
    let cur = s.parentID;
    for (let i = 0; i < 10 && cur; i += 1) {
      if (cur === act.id) {
        seen.add(s.id);
        out.push(s.id);
        walk(childFeedOf(s.id), 1);
        break;
      }
      cur = byId.get(cur)?.parentID ?? null;
    }
  }
  return out;
}

// Событийный шлюз (events.js): сессия — ребёнок открытого чата?
export function isChildOfActive(sid) {
  const act = active.value?.id;
  if (!sid || !act || sid === act) return false;
  return childIdsOfActive().includes(sid);
}

// Перечитать ленты активного чата (resync): force — и завершённые тоже.
export function refreshChildFeeds({ force = true } = {}) {
  for (const id of childIdsOfActive()) ensureChildFeed(id, { force });
}

// «Стоп» открытого чата обрывает и его занятых детей (бэкграунд-агенты
// молча работали бы дальше и заняли бы лимит хоста).
export async function abortBusyChildren(sid) {
  for (const id of childIdsOfActive()) {
    if (!busyMap.value[id]) continue;
    try {
      await api.abort(id, { directory: sessionDir(id) ?? sessionDir(sid) });
    } catch {}
  }
}

// Токены запуска — сумма info.tokens.total ассистентских сообщений ленты.
function tokensOfFeed(feed) {
  let sum = 0;
  let any = false;
  for (const m of feed ?? []) {
    const t = Number(m?.info?.tokens?.total);
    if (Number.isFinite(t) && t > 0) {
      sum += t;
      any = true;
    }
  }
  return any ? sum : null;
}

function tokensOfRecord(id) {
  const t = sessions.value.find((x) => x.id === id)?.tokens;
  const sum = (Number(t?.input) || 0) + (Number(t?.output) || 0);
  return sum > 0 ? sum : null;
}

// BUG-229: живой хвост хода — ассистентские сообщения после последнего
// пользовательского, пока чат занят и они ещё не завершены (у стримингового
// сообщения нет time.completed). У части такого хода статус задачи ещё может
// доехать (окно «запуск принят, task_started в пути»); завершённый ход и
// старые сообщения в занятом чате — не живой хвост: запуску без статуса там
// место среди готовых/остановленных.
function liveTailOf(act, busyNow) {
  const out = new Set();
  if (!busyNow || !act) return out;
  const msgs = Array.isArray(act.messages) ? act.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    const role = m?.info?.role;
    if (role === "user") break;
    if (role === "assistant" && m?.info?.id && m?.info?.time?.completed == null) out.add(m.info.id);
  }
  return out;
}

// Все запуски агентов открытого чата (карточки): части родителя + ленты детей.
export const chatRuns = computed(() => {
  const act = active.value;
  if (!act) return [];
  const liveTail = liveTailOf(act, busyMap.value[act.id] != null);
  return runsOfMessages(act.messages, {
    childFeed: (id) => childFeedOf(id),
    busy: (id) => busyMap.value[id] != null,
    // токены и последняя активность — из записи дочерней сессии (как в карточке до FEAT-01.77), иначе из её ленты
    tokensOf: (id) => tokensOfRecord(id) ?? tokensOfFeed(childFeedOf(id)),
    updatedOf: (id) => { const t = sessions.value.find((x) => x.id === id)?.time?.updated; const n = typeof t === "number" ? t : Date.parse(t); return Number.isFinite(n) && n > 0 ? n : null; },
    now: Date.now(),
    engine: engineOfSession(act.id),
    liveMessage: (mid) => liveTail.has(mid),
  });
});

// Запуски в работе (running/queued) — подпись прелоадера, полоска «сейчас».
export const activeAgentRuns = computed(() => activeRuns(chatRuns.value));
export const agentsBusy = computed(() => activeAgentRuns.value.length > 0);

// Автозагрузка: у работающего/ожидющего запуска с ребёнком лента нужна сразу.
effect(() => {
  if (!active.value) return;
  for (const r of chatRuns.value) {
    if (r.childId && (r.state === "running" || r.state === "queued")) ensureChildFeed(r.childId);
  }
});
