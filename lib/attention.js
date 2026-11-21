// FEAT-20.2: «Доска внимания» — что ждёт вас, что работает, что готово или упало.
//
//   AttentionStore — исходы ходов (<data>/attention/outcomes.json) и личные
//     отметки пользователя (<data>/attention/users/<userId>.json): просмотрено,
//     отложено, последняя активность, окно «Пока вас не было», «Понятно»,
//     виды push. Атомарная запись (lib/json-store.js), без базы данных.
//   buildBoard()  — чистая функция: из живого состояния (хаб, раннер), исходов,
//     запусков Temporal и ревью FEAT-20.1 собирает элементы доски и счётчики.
//   OutcomeObserver — наблюдатель событий хаба для opencode-чатов (busy → idle
//     = исход хода; session.error — ошибка; остановка пользователем — не исход;
//     teleharness.turn.stalled — «ход завис»).
//
// Ключи элементов: chat:<sessionID>, run:<workflowId>, review:<id>.
// Время — только серверное (клиент считает по смещению `now`).
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { readJsonStore, writeJsonAtomic } from "./json-store.js";
import { errText, turnErrorKind } from "../shared/turn-error.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const ATTENTION = Object.freeze({
  maxItems: 200,
  maxOutcomes: 5000,
  outcomeTtlMs: 30 * DAY,
  quietMs: 5 * MIN, // «нет вестей N мин»
  doneOlderMs: 7 * DAY, // «Готово» старше — в «Старше …», вне счётчиков
  failedOlderMs: 14 * DAY, // «Упало» старше — туда же (как хранение запусков)
  awayMs: 30 * MIN, // отсутствие на всех устройствах для сводки
  maxAwayEvents: 200,
  maxSeen: 5000,
  seenTtlMs: 30 * DAY,
  snippet: 140,
  snoozeMaxMs: 7 * DAY,
  maxKeys: 200,
});
export const FAILED_KINDS = new Set(["error", "limit", "auth", "restart", "stalled"]);
const OUTCOME_KINDS = new Set(["done", ...FAILED_KINDS]);
const KEY_RE = /^(chat|run|review):[A-Za-z0-9_.:\-]{1,200}$/;
const USER_RE = /^[A-Za-z0-9_\-]{1,80}$/;

export const isAttentionKey = (k) => typeof k === "string" && KEY_RE.test(k);

// Строка «что случилось»: первая непустая строка, пробелы схлопнуты, ≤ 140.
export function clip(text, max = ATTENTION.snippet) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// Исход хода по ошибке (shared/turn-error.js — общий с клиентом классификатор).
// null — не ошибка (остановка пользователем).
export function outcomeOfError(err, { engine = "opencode" } = {}) {
  if (err == null) return "done";
  const kind = turnErrorKind(err, { engine });
  if (kind === null) return null;
  if (kind === "limit") return "limit";
  if (kind === "auth") return "auth";
  return "error";
}

const defaultPrefs = () => ({ needs: true, failed: true, done: true, quiet: { on: false, from: "23:00", to: "08:00", tz: null } });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// PUT /me/push-prefs: только известные поля; неверное → null (400).
export function cleanPushPrefs(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const out = defaultPrefs();
  for (const k of ["needs", "failed", "done"]) {
    if (k in body) {
      if (typeof body[k] !== "boolean") return null;
      out[k] = body[k];
    }
  }
  if ("quiet" in body) {
    const q = body.quiet;
    if (!q || typeof q !== "object" || Array.isArray(q)) return null;
    if ("on" in q && typeof q.on !== "boolean") return null;
    if ("from" in q && !HHMM.test(String(q.from))) return null;
    if ("to" in q && !HHMM.test(String(q.to))) return null;
    if ("tz" in q && q.tz != null && (typeof q.tz !== "string" || q.tz.length > 64)) return null;
    out.quiet = { on: q.on === true, from: q.from ?? out.quiet.from, to: q.to ?? out.quiet.to, tz: q.tz ?? null };
  }
  return out;
}

export class AttentionStore {
  #dir;
  #now;
  #log;
  #outcomes;
  #users = new Map();
  #since;
  constructor({ dir, now = () => Date.now(), log = (m) => console.error(m) } = {}) {
    this.#dir = dir;
    this.#now = now;
    this.#log = log;
    mkdirSync(path.join(dir, "users"), { recursive: true });
    const file = this.#outFile();
    const raw = readJsonStore(file, {
      fallback: () => null,
      validate: (v) => v && typeof v === "object" && v.chats && typeof v.chats === "object",
      log,
    });
    // Миграция: первый запуск = «всё, что было до выката, просмотрено» —
    // доска не вываливает историю всех запусков как непросмотренную.
    this.#since = Number(raw?.since) || now();
    this.#outcomes = new Map(Object.entries(raw?.chats ?? {}).filter(([, o]) => o && OUTCOME_KINDS.has(o.kind) && Number.isFinite(o.at)));
    if (!raw) this.#writeOutcomes();
  }

  get since() {
    return this.#since;
  }

  #outFile() {
    return path.join(this.#dir, "outcomes.json");
  }
  #userFile(userId) {
    return path.join(this.#dir, "users", `${userId}.json`);
  }
  #writeOutcomes() {
    writeJsonAtomic(this.#outFile(), { v: 1, since: this.#since, chats: Object.fromEntries(this.#outcomes) }, { log: this.#log });
  }

  // ---- исходы ходов -------------------------------------------------------
  outcome(sid) {
    return this.#outcomes.get(sid) ?? null;
  }
  outcomes() {
    return this.#outcomes;
  }
  // {kind, at?, snippet?, errorKind?, dir?, turn?} → сохранённая запись | null.
  setOutcome(sid, rec) {
    if (typeof sid !== "string" || !sid || !rec || !OUTCOME_KINDS.has(rec.kind)) return null;
    const at = Number(rec.at) || this.#now();
    const out = { kind: rec.kind, at, snippet: clip(rec.snippet), errorKind: rec.errorKind ?? null, dir: typeof rec.dir === "string" ? rec.dir : null };
    this.#outcomes.delete(sid); // свежий — в конец (вытеснение по давности)
    this.#outcomes.set(sid, out);
    const cut = this.#now() - ATTENTION.outcomeTtlMs;
    for (const [k, o] of this.#outcomes) if (o.at < cut) this.#outcomes.delete(k);
    while (this.#outcomes.size > ATTENTION.maxOutcomes) this.#outcomes.delete(this.#outcomes.keys().next().value);
    this.#writeOutcomes();
    return out;
  }
  dropOutcome(sid) {
    if (this.#outcomes.delete(sid)) this.#writeOutcomes();
  }

  // ---- личные отметки ----------------------------------------------------
  user(userId) {
    if (!USER_RE.test(String(userId ?? ""))) return null;
    let u = this.#users.get(userId);
    if (u) return u;
    const raw = readJsonStore(this.#userFile(userId), { fallback: () => null, validate: (v) => v && typeof v === "object", log: this.#log });
    u = {
      v: 1,
      seen: raw?.seen && typeof raw.seen === "object" ? raw.seen : {},
      snooze: raw?.snooze && typeof raw.snooze === "object" ? raw.snooze : {},
      lastActiveAt: Number(raw?.lastActiveAt) || null,
      away: raw?.away && Number.isFinite(raw.away.from) ? raw.away : null,
      awayAckAt: Number(raw?.awayAckAt) || null,
      push: cleanPushPrefs(raw?.push ?? {}) ?? defaultPrefs(),
      events: Array.isArray(raw?.events) ? raw.events.filter((e) => e && Number.isFinite(e.at)) : [],
    };
    this.#users.set(userId, u);
    return u;
  }
  #save(userId) {
    const u = this.#users.get(userId);
    if (!u) return false;
    return writeJsonAtomic(this.#userFile(userId), u, { log: this.#log });
  }

  // keys → отметка «просмотрено до at». Идемпотентно: повтор не двигает назад.
  markSeen(userId, keys, at = this.#now()) {
    const u = this.user(userId);
    if (!u) return 0;
    let n = 0;
    for (const k of keys) {
      if (!isAttentionKey(k)) continue;
      if ((u.seen[k] ?? 0) < at) {
        u.seen[k] = at;
        n += 1;
      }
      delete u.snooze[k];
    }
    const cut = this.#now() - ATTENTION.seenTtlMs;
    const entries = Object.entries(u.seen).filter(([, t]) => t >= cut);
    if (entries.length !== Object.keys(u.seen).length || entries.length > ATTENTION.maxSeen) {
      entries.sort((a, b) => b[1] - a[1]);
      u.seen = Object.fromEntries(entries.slice(0, ATTENTION.maxSeen));
    }
    this.#save(userId);
    return n;
  }

  // until = null снимает отложение.
  snooze(userId, key, until) {
    const u = this.user(userId);
    if (!u || !isAttentionKey(key)) return false;
    if (until == null) delete u.snooze[key];
    else u.snooze[key] = { until: Number(until), at: this.#now() };
    this.#save(userId);
    return true;
  }

  // Видимое окно портала у пользователя (GET /attention?active=1): отсутствие
  // ≥ 30 мин открывает окно сводки «Пока вас не было» [from, to].
  touch(userId, now = this.#now()) {
    const u = this.user(userId);
    if (!u) return null;
    const last = u.lastActiveAt;
    let dirty = false;
    if (last && now - last >= ATTENTION.awayMs) {
      // непрочитанная сводка расширяется, а не теряется
      const from = u.away && !(u.awayAckAt && u.awayAckAt >= u.away.to) ? u.away.from : last;
      u.away = { from, to: now };
      dirty = true;
    }
    if (!last || now - last >= MIN || dirty) {
      u.lastActiveAt = now;
      this.#save(userId);
    } else u.lastActiveAt = now; // в памяти; на диск — не чаще раза в минуту
    return u;
  }

  ackAway(userId, at = this.#now()) {
    const u = this.user(userId);
    if (!u) return false;
    u.awayAckAt = at;
    this.#save(userId);
    return true;
  }

  setPrefs(userId, prefs) {
    const u = this.user(userId);
    if (!u) return null;
    u.push = prefs;
    this.#save(userId);
    return u.push;
  }

  // Событие сводки «Пока вас не было» (без модели — только счёт событий).
  addEvent(userIds, event) {
    const at = Number(event?.at) || this.#now();
    for (const id of new Set(userIds ?? [])) {
      const u = this.user(id);
      if (!u) continue;
      u.events.push({ at, kind: String(event.kind), key: event.key ?? null, text: clip(event.text, 200) });
      if (u.events.length > ATTENTION.maxAwayEvents) u.events.splice(0, u.events.length - ATTENTION.maxAwayEvents);
      this.#save(id);
    }
  }

  // Удалённый чат: отметки и исход уходят у всех пользователей (как закрепления).
  forgetKey(key, { sid = null } = {}) {
    if (sid) this.dropOutcome(sid);
    let files = [];
    try {
      files = readdirSync(path.join(this.#dir, "users")).filter((f) => f.endsWith(".json"));
    } catch {}
    for (const f of files) {
      const id = f.slice(0, -5);
      const u = this.user(id);
      if (!u) continue;
      let dirty = false;
      if (key in u.seen) delete u.seen[key], (dirty = true);
      if (key in u.snooze) delete u.snooze[key], (dirty = true);
      const before = u.events.length;
      u.events = u.events.filter((e) => e.key !== key);
      if (u.events.length !== before) dirty = true;
      if (dirty) this.#save(id);
    }
  }

  // Удалённый аккаунт — его файл отметок.
  dropUser(userId) {
    this.#users.delete(userId);
    try {
      if (USER_RE.test(String(userId)) && existsSync(this.#userFile(userId))) unlinkSync(this.#userFile(userId));
    } catch {}
  }
}

// ---- сборка доски ---------------------------------------------------------

const SECTION_ORDER = ["needs", "failed", "working", "done", "unknown", "snoozed", "older"];

function askOf(d) {
  const p = d.props ?? d;
  const tool = typeof p.permission === "string" ? p.permission : typeof p.tool === "string" ? p.tool : null;
  const summary = p.metadata?.command ?? (Array.isArray(p.patterns) ? p.patterns[0] : null) ?? p.title ?? null;
  return { id: d.id, kind: d.kind === "question" ? "question" : "permission", askedAt: Number(d.askedAt) || null, tool, summary: clip(summary, 200) };
}

// Корень цепочки субагентов (их запросы — у родительского чата).
function rootOf(id, byId) {
  let cur = byId.get(id);
  const seen = new Set();
  while (cur?.parentID && byId.has(cur.parentID) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parentID);
  }
  return cur ?? null;
}

const runWhen = (r) => Number(new Date(r.summary?.closeTime ?? r.summary?.startTime ?? r.startTime ?? 0)) || null;

// input:
//   now, since (миграция), chats [{id,title,dir,parentID,engine,model,step}],
//   live: {busy: {sid: {since,lastEvent,bg}}, dialogs: [{id,sessionID,kind,askedAt,props}]},
//   outcomes: Map|obj sid → outcome, runs [{workflowId,name,directory,summary,pipeDeleted}]|null,
//   reviews [ReviewSummary]|null, pins [ids], user {seen, snooze}, sources, filter {project, q},
//   projectName(dir) → строка, admin (для текста ошибки входа).
export function buildBoard(input) {
  const now = input.now;
  const since = input.since ?? 0;
  const prefs = input.user ?? { seen: {}, snooze: {} };
  const sources = { opencode: "ok", claude: "ok", temporal: "off", reviews: "off", ...(input.sources ?? {}) };
  const outcomes = input.outcomes instanceof Map ? input.outcomes : new Map(Object.entries(input.outcomes ?? {}));
  const pins = new Set(input.pins ?? []);
  const projectName = input.projectName ?? ((d) => String(d ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "");
  const chats = input.chats ?? [];
  const byId = new Map(chats.map((c) => [c.id, c]));
  const seenAt = (key) => Math.max(Number(prefs.seen?.[key]) || 0, since);
  const items = [];

  // запросы — к корневому (родительскому) чату
  const asks = new Map();
  for (const d of input.live?.dialogs ?? []) {
    const own = byId.get(d.sessionID);
    const root = own ? rootOf(d.sessionID, byId) : null;
    if (!root || root.step) continue;
    const a = askOf(d);
    if (own !== root) a.agent = own.agent || own.title || null; // «разрешение у агента Explore»
    (asks.get(root.id) ?? asks.set(root.id, []).get(root.id)).push(a);
  }
  const busy = input.live?.busy ?? {};

  for (const c of chats) {
    if (c.parentID || c.step) continue; // субагенты и шаги пайпа — внутри родителя
    const key = `chat:${c.id}`;
    const base = {
      key, kind: "chat", title: c.title || "Без названия", project: { name: projectName(c.dir), dir: c.dir ?? null },
      engine: c.engine ?? "opencode", model: c.model ?? null, pinned: pins.has(c.id), bgAgents: 0, silentMs: null,
      permission: null, snippet: null, href: `#/chat/${encodeURIComponent(c.id)}`,
    };
    const down = (c.engine ?? "opencode") === "opencode" && sources.opencode === "down";
    const mine = (asks.get(c.id) ?? []).sort((a, b) => (a.askedAt ?? now) - (b.askedAt ?? now));
    let it = null;
    if (mine.length) {
      const first = mine[0];
      const permission = mine.find((a) => a.kind === "permission" && !a.agent) ?? null;
      it = { ...base, state: "needs", reason: first.kind, since: first.askedAt ?? now, at: first.askedAt ?? now,
        snippet: first.kind === "permission" ? clip([first.tool, first.summary].filter(Boolean).join(": ")) : clip(first.summary),
        agent: first.agent ?? null, asks: mine.length,
        permission: permission ? { id: permission.id, tool: permission.tool, summary: permission.summary } : null };
    } else if (busy[c.id]) {
      const b = busy[c.id];
      const silent = b.lastEvent ? now - b.lastEvent : null;
      if (down) it = { ...base, state: "unknown", reason: "source-down", since: b.since ?? now, at: b.since ?? now };
      else {
        const quiet = silent != null && silent >= ATTENTION.quietMs;
        it = { ...base, state: "working", reason: quiet ? "quiet" : b.bg ? "bg" : "turn", since: b.since ?? now, at: b.since ?? now,
          silentMs: quiet ? silent : null, bgAgents: b.bg ? Math.max(1, Number(b.bgAgents) || 1) : 0 };
      }
    } else {
      const o = outcomes.get(c.id);
      if (o && o.at > seenAt(key)) {
        const failed = FAILED_KINDS.has(o.kind);
        it = { ...base, state: failed ? "failed" : "done", reason: failed ? o.kind : "turn", since: o.at, at: o.at, snippet: o.snippet ?? null, errorKind: o.errorKind ?? null };
        if (o.kind === "auth") it.snippet = input.admin ? "Нужен вход в движок — откройте чат" : "Движок недоступен — сообщите администратору";
      }
    }
    if (it) items.push(it);
  }

  // ревью FEAT-20.1 (общий контракт ReviewSummary): ждущие — в «Ждёт вас»
  const reviewRuns = new Set();
  const reviewTab = [];
  for (const r of input.reviews ?? []) {
    if (!r || typeof r.id !== "string") continue;
    reviewTab.push(r);
    if (!r.needsYou) continue;
    if (r.source === "run" && r.runId) reviewRuns.add(r.runId);
    items.push({
      key: r.key ?? `review:${r.id}`, kind: "review", state: "needs", reason: "review", title: r.title ?? "Ревью",
      project: r.project ?? { name: "", dir: null }, engine: r.engine ?? null, model: r.model ?? null,
      since: Number(r.since) || now, at: Number(r.since) || now, snippet: null, pinned: false, // BUG-273: «Ревью · N файлов» уже в строке состояния
      bgAgents: 0, silentMs: null, permission: null, href: r.href ?? `#/review/${encodeURIComponent(r.id)}`,
      review: { status: r.status, revision: r.revision ?? null, turns: r.turns ?? null, files: r.files ?? null, additions: r.additions ?? null, deletions: r.deletions ?? null, drafts: r.drafts ?? null },
    });
  }

  // запуски Temporal пользователя (14 дней — срок хранения)
  for (const r of input.runs ?? []) {
    const key = `run:${r.workflowId}`;
    const kind = r.summary?.kind ?? (sources.temporal === "down" ? "unavailable" : null);
    const base = {
      key, kind: "run", title: r.name || "Запуск", project: { name: projectName(r.directory), dir: r.directory ?? null }, engine: "temporal",
      model: null, pinned: false, bgAgents: 0, silentMs: null, permission: null, pipeDeleted: !!r.pipeDeleted,
      href: `#/temporal/run/${encodeURIComponent(r.workflowId)}`, snippet: r.summary?.current?.name ? clip(`Шаг «${r.summary.current.name}»`) : null,
    };
    const startedAt = Number(new Date(r.summary?.startTime ?? r.startTime ?? 0)) || now;
    let it = null;
    if (kind === "wait") {
      if (reviewRuns.has(r.workflowId)) continue; // одно ожидание — один элемент review:<id>
      it = { ...base, state: "needs", reason: "decision", since: startedAt, at: startedAt };
    } else if (kind === "run" || kind === "quota" || kind === "paused") {
      it = { ...base, state: "working", reason: kind === "run" ? "turn" : kind, since: startedAt, at: startedAt };
    } else if (kind === "unavailable") {
      it = { ...base, state: "unknown", reason: "source-down", since: startedAt, at: startedAt };
    } else if (kind === "ok" || kind === "err" || kind === "term" || kind === "rejected") {
      const at = runWhen(r) ?? startedAt;
      if (at > seenAt(key)) {
        const failed = kind !== "ok";
        it = { ...base, state: failed ? "failed" : "done", reason: failed ? (kind === "err" ? "error" : kind === "term" ? "terminated" : "rejected") : "turn", since: at, at };
      }
    } // cancel — остановлен человеком: не «упало»
    if (it) items.push(it);
  }

  // отложенные и «старше»
  for (const it of items) {
    const sn = prefs.snooze?.[it.key];
    if (sn && Number(sn.until) > now && it.at <= Number(sn.at) && it.state !== "unknown") {
      it.snoozedFrom = it.state;
      it.state = "snoozed";
      it.until = Number(sn.until);
      continue;
    }
    if (sn && it.at > Number(sn.at)) it.returned = true; // «вернулся из отложенных»
    if (it.state === "done" && now - it.at > ATTENTION.doneOlderMs) (it.olderFrom = "done"), (it.state = "older");
    else if (it.state === "failed" && now - it.at > ATTENTION.failedOlderMs) (it.olderFrom = "failed"), (it.state = "older");
  }

  // фильтр по проекту и поиск по названию
  const f = input.filter ?? {};
  const q = String(f.q ?? "").trim().toLowerCase();
  const filtered = items.filter((it) => (!f.project || it.project?.dir === f.project) && (!q || String(it.title).toLowerCase().includes(q)));

  const counts = { needs: 0, review: 0, working: 0, done: 0, failed: 0, unknown: 0, snoozed: 0, older: 0 };
  for (const it of filtered) {
    counts[it.state] += 1;
    if (it.state === "needs" && it.reason === "review") counts.review += 1;
  }
  const rank = (s) => SECTION_ORDER.indexOf(s);
  filtered.sort((a, b) => {
    if (a.state !== b.state) return rank(a.state) - rank(b.state);
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.state === "needs" ? a.since - b.since : b.at - a.at;
  });
  const shown = filtered.slice(0, ATTENTION.maxItems);
  const projects = [...new Map(items.filter((it) => it.project?.dir).map((it) => [it.project.dir, it.project.name])).entries()].map(([dir, name]) => ({ dir, name }));
  return {
    now, counts, items: shown, sources, projects,
    truncated: filtered.length > shown.length ? { shown: shown.length, total: filtered.length } : null,
    reviews: input.reviews ? reviewTab : null,
  };
}

// Сводка «Пока вас не было»: окно отсутствия + события в нём (без модели).
export function awaySummary(user, { runs = [], now } = {}) {
  if (!user?.away) return null;
  const { from, to } = user.away;
  if (user.awayAckAt && user.awayAckAt >= to) return null;
  const events = (user.events ?? []).filter((e) => e.at > from && e.at <= to);
  for (const r of runs) {
    const at = runWhen(r);
    const k = r.summary?.kind;
    if (!at || at <= from || at > to) continue;
    if (k === "ok") events.push({ at, kind: "run-done", key: `run:${r.workflowId}`, text: `Пайп «${r.name}» завершён` });
    else if (k === "err" || k === "term" || k === "rejected") events.push({ at, kind: "run-failed", key: `run:${r.workflowId}`, text: `Пайп «${r.name}» упал` });
  }
  if (!events.length) return null;
  events.sort((a, b) => a.at - b.at);
  const counts = { done: 0, failed: 0, needs: 0, runs: 0, limit: 0, relay: 0, restart: 0, crash: 0 };
  for (const e of events) {
    if (e.kind === "done") counts.done += 1;
    else if (e.kind === "failed" || e.kind === "limit") counts.failed += 1;
    else if (e.kind === "needs") counts.needs += 1;
    else if (e.kind === "run-done" || e.kind === "run-failed") counts.runs += 1;
    if (e.kind === "run-failed") counts.failed += 1;
    if (e.kind in counts && !["done", "failed", "needs"].includes(e.kind)) counts[e.kind] += 1;
  }
  const notable = events.filter((e) => ["limit", "relay", "restart", "crash", "run-done", "run-failed"].includes(e.kind));
  return { since: from, until: to, durationMs: to - from, counts, events: notable.slice(-20) };
}

// ---- исходы opencode-чатов по событиям хаба ----------------------------------

// deps: isManaged(sid) — исход приходит из onTurnEnd раннера (Claude/Codex);
//       onOutcome(sid, {kind, errorKind, snippet}, dir); onAsk(sid, dir).
export class OutcomeObserver {
  #busy = new Set();
  #err = new Map();
  #stalled = new Set();
  #userStop = new Set();
  #d;
  constructor(deps) {
    // FEAT-20.1: onTurnStart(sid, dir) / onTurnEnd(sid, {kind}, dir) — начало и любой конец хода
    // (в т. ч. «Стоп» человека, kind = "stopped") для снимков ревью.
    this.#d = { isManaged: () => false, onOutcome: () => {}, onAsk: () => {}, onTurnStart: () => {}, onTurnEnd: () => {}, ...deps };
  }
  // «Стоп» из портала: следующий конец хода — не исход.
  noteUserStop(sid) {
    if (typeof sid === "string" && sid) this.#userStop.add(sid);
  }
  observe(data, dir = null) {
    if (typeof data !== "string" || !/"(session\.status|session\.idle|session\.error|session\.deleted|permission\.asked|question\.asked|teleharness\.turn\.stalled)"/.test(data)) return;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    const p = evt?.properties ?? {};
    const sid = p.sessionID;
    if (typeof sid !== "string" || !sid) return;
    const type = evt.type;
    if (type === "permission.asked" || type === "question.asked") return void this.#d.onAsk(sid, dir);
    if (type === "session.deleted") {
      this.#busy.delete(sid);
      this.#err.delete(sid);
      this.#stalled.delete(sid);
      this.#userStop.delete(sid);
      return;
    }
    if (this.#d.isManaged(sid)) return;
    if (type === "teleharness.turn.stalled") {
      this.#stalled.add(sid);
      return;
    }
    if (type === "session.status") {
      const st = typeof p.status === "string" ? p.status : p.status?.type;
      if (st && st !== "idle") {
        const fresh = !this.#busy.has(sid);
        if (fresh) this.#userStop.delete(sid); // новый ход
        this.#busy.add(sid);
        if (fresh) this.#d.onTurnStart(sid, dir);
        return;
      }
    }
    if (type === "session.error") {
      if (this.#busy.has(sid)) this.#err.set(sid, p.error ?? null);
      // BUG-272: opencode 2.x (execution.failed → terminal) не шлёт idle после ошибки —
      // ошибка сама завершает ход; 1.x шлёт idle следом (тогда #busy уже пуст — без повтора)
      if (p.terminal !== true) return;
    }
    if (!this.#busy.delete(sid)) return;
    const err = this.#err.get(sid);
    const hadErr = this.#err.delete(sid);
    const stalled = this.#stalled.delete(sid);
    const stopped = this.#userStop.delete(sid);
    let kind;
    if (stalled) kind = "stalled";
    else if (stopped) kind = null;
    else if (hadErr) kind = outcomeOfError(err ?? { message: "error" });
    else kind = "done";
    this.#d.onTurnEnd(sid, { kind: kind ?? "stopped" }, dir);
    if (!kind) return;
    this.#d.onOutcome(sid, { kind, errorKind: hadErr ? turnErrorKind(err) : null, snippet: hadErr ? errText(err) || null : null }, dir);
  }
}
