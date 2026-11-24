// FEAT-20.1: ревью изменений агента — хранилище пунктов, ревизии, комментарии,
// «Вернуть агенту», «Принять», планы «Сначала план» (openspec phone-review,
// design «Модель данных», «API», «Хуки»).
//
// Пункт ревью — НА ЧАТ: все непроверенные ходы чата с правками. Хранение —
// data/review/<user>.json (атомарная запись), пункты принадлежат владельцу
// чата (тенант — свои папки, admin — ничьи): чужой id просто не находится → 404.
//
// Режимы пункта:
//   snapshot — папка под git: ревизия = дерево рабочей папки на конец хода
//     (lib/review-snapshot.js, отдельное хранилище объектов); база — снимок
//     перед первым непроверенным ходом (снимок начала хода), иначе дерево
//     последнего «Принять», иначе HEAD;
//   turns — папки без git / снимок невозможен (no-git, unsafe-repo, too-big,
//     quota): файлы и куски — из частей хода (src/lib/diff.js turnChanges).
//
// Сервисный слой (ReviewService) делает git и зовёт внедрённые функции
// сервера (post — отправка сообщения в чат, busy, emit); чистая часть —
// summaryOf / statusOf / commentOutcome — проверяется unit-тестами.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { readJsonStore, writeJsonAtomic } from "./json-store.js";
import { GitError, openRepo, runGit } from "./git.js";
import { dirBytes, headTree, isSha, repoKey, snapshotTree, treeChanges, treeDiff } from "./review-snapshot.js";
import { REVIEW_LIMITS, buildReviewMessage, langOf } from "../shared/review-message.js";
import { parseUnified, turnChanges } from "../src/lib/diff.js";

export const REVIEW = Object.freeze({
  keepMs: 30 * 24 * 3600_000, // принятые и убранные — 30 дней
  quotaBytes: 500 * 1024 * 1024, // снимки на пользователя
  pageSize: 30,
  turnLinesMax: 5000, // строк кусков хода в режиме turns на ревизию
  sendPendingMs: 30_000,
});
const USER_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ID_RE = /^(rv|pl)_[A-Za-z0-9]{12}$/;
const CID_RE = /^c_[A-Za-z0-9_-]{6,40}$/;
const KEY_RE = /^[A-Za-z0-9_-]{6,80}$/;
export const isReviewId = (s) => typeof s === "string" && /^rv_[A-Za-z0-9]{12}$/.test(s);
export const isPlanId = (s) => typeof s === "string" && /^pl_[A-Za-z0-9]{12}$/.test(s);
export const isKey = (s) => typeof s === "string" && KEY_RE.test(s);
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function newId(prefix) {
  const b = randomBytes(12);
  let s = "";
  for (const x of b) s += B62[x % 62];
  return `${prefix}_${s}`;
}
const OPEN = new Set(["pending", "returned", "interrupted"]);
export const NEEDS_YOU = new Set(["waiting", "decision", "changed", "interrupted"]);

export class ReviewError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const notFound = () => new ReviewError(404, "not-found", "Ревью недоступно");

// ---- чистые функции -------------------------------------------------------------

// Статус элемента ревью для доски (общий контракт FEAT-20.1 кр. 18 / FEAT-20.2).
export function statusOf(item) {
  if (item.chatDeleted) return "chat-deleted";
  if (item.state === "returned") return "returned";
  if (item.state === "interrupted") return "interrupted";
  if (item.stale) return "changed";
  return "waiting";
}

export function totalsOf(files) {
  return (files ?? []).reduce((t, f) => ({ files: t.files + 1, additions: t.additions + (f.additions || 0), deletions: t.deletions + (f.deletions || 0) }), { files: 0, additions: 0, deletions: 0 });
}

// Файлы пункта «Всё»: snapshot — файлы последней ревизии (база ↔ ревизия),
// turns — объединение файлов всех ревизий (по пути).
export function filesOf(item) {
  const last = item.revisions.at(-1);
  if (!last) return [];
  if (item.mode === "snapshot") return last.files ?? [];
  const map = new Map();
  for (const r of item.revisions) {
    for (const f of r.files ?? []) {
      const cur = map.get(f.path);
      if (!cur) map.set(f.path, { ...f });
      else {
        cur.additions += f.additions || 0;
        cur.deletions += f.deletions || 0;
        if (f.status === "D") cur.status = "D";
        cur.partial = cur.partial || f.partial;
      }
    }
  }
  return [...map.values()];
}

// projectDir (BUG-273): папка проекта ЧАТА (основная копия репозитория / папка
// проекта тенанта) — у пункта dir = папка, где агент правил (рабочая копия,
// подпапка чата тенанта), и её имя проектом не является.
export function summaryOf(item, { admin = false, projectDir = null, chatTitle = null } = {}) {
  const status = statusOf(item);
  const t = totalsOf(filesOf(item));
  const turns = item.revisions.reduce((n, r) => n + (r.turns?.length ?? 0), 0);
  return {
    id: item.id, key: `review:${item.id}`, source: item.source?.kind ?? "chat", sid: item.source?.sid ?? null,
    title: chatTitle || item.title || "Чат", project: projectDir ? { name: projectName(projectDir), dir: projectDir } : { name: item.project?.name ?? "", dir: item.dir ?? null },
    engine: item.engine ?? null, model: item.model ?? null, status, needsYou: NEEDS_YOU.has(status),
    revision: item.revision, turns, files: t.files, additions: t.additions, deletions: t.deletions,
    drafts: item.comments.filter((c) => c.state === "draft").length, mode: item.mode, since: item.since ?? item.updatedAt,
    href: `#/review/${item.id}`, ...(admin ? {} : {}),
  };
}

// Исход отправленного комментария к строкам стороны «стало»: менялись ли его
// строки между ревизией отправки и текущей (unified-патч этих ревизий).
export function commentOutcome(comment, patch) {
  if (patch == null) return "unchanged";
  if (patch === "gone") return "gone";
  if (!Number.isInteger(comment.from) || comment.side !== "new") return patch ? "changed" : "unchanged";
  const files = parseUnified(patch);
  const f = files[0];
  if (!f) return "unchanged";
  if (f.status === "D") return "gone";
  const a = comment.from;
  const b = Number.isInteger(comment.to) ? comment.to : a;
  for (const h of f.hunks ?? []) {
    if (h.oldStart == null) return "changed";
    let o = h.oldStart; // номер следующей строки стороны «было»
    for (const l of h.lines) {
      if (l.t === "-" && o >= a && o <= b) return "changed";
      if (l.t === "+" && o > a && o <= b) return "changed"; // вставка внутрь диапазона
      if (l.t !== "+") o++;
    }
  }
  return "unchanged";
}

export function cleanComment(body, { revision }) {
  const b = body && typeof body === "object" ? body : {};
  const side = ["new", "old", "file", "general"].includes(b.side) ? b.side : null;
  if (!side) throw new ReviewError(400, "bad-comment", "Некорректный комментарий");
  const text = typeof b.text === "string" ? b.text : "";
  if (text.length > REVIEW_LIMITS.comment) throw new ReviewError(400, "too-long", "Комментарий длиннее 4000 символов");
  const file = side === "general" ? null : typeof b.file === "string" && b.file && b.file.length <= 4096 && !/[\0\r\n]/.test(b.file) ? b.file : null;
  if (side !== "general" && !file) throw new ReviewError(400, "bad-comment", "Не указан файл");
  let from = null;
  let to = null;
  if (side === "new" || side === "old") {
    from = Number.isInteger(b.from) && b.from > 0 ? b.from : null;
    to = Number.isInteger(b.to) && b.to > 0 ? b.to : from;
    if (from != null && to < from) [from, to] = [to, from];
    if (from != null && to - from + 1 > REVIEW_LIMITS.select) throw new ReviewError(400, "too-many-lines", "Не больше 200 строк в одном комментарии");
  }
  const quote = Array.isArray(b.quote) ? b.quote.slice(0, REVIEW_LIMITS.select).map((s) => String(s).slice(0, 2000)) : [];
  if ((side === "new" || side === "old") && from == null && quote.length === 0) throw new ReviewError(400, "bad-comment", "Нет строк комментария");
  const oldPath = typeof b.oldPath === "string" && b.oldPath.length <= 4096 ? b.oldPath : null;
  return { revision: Number.isInteger(b.revision) && b.revision > 0 && b.revision <= revision ? b.revision : revision, file, oldPath, side, from, to, quote, text };
}

// ---- хранилище -------------------------------------------------------------------

export class ReviewStore {
  #dir;
  #cache = new Map();
  #log;
  #now;
  constructor({ dir, log = console.error, now = Date.now }) {
    this.#dir = dir;
    this.#log = log;
    this.#now = now;
  }
  get dir() {
    return this.#dir;
  }
  #file(user) {
    if (!USER_RE.test(String(user))) throw new ReviewError(400, "bad-user", "bad user");
    return path.join(this.#dir, `${user}.json`);
  }
  data(user) {
    let d = this.#cache.get(user);
    if (!d) {
      d = readJsonStore(this.#file(user), {
        fallback: () => ({ version: 1, items: {}, plans: {}, starts: {} }),
        validate: (raw) => Boolean(raw && typeof raw === "object" && raw.items && typeof raw.items === "object"),
        log: this.#log,
      });
      d.plans ??= {};
      d.starts ??= {};
      this.#prune(d);
      this.#cache.set(user, d);
    }
    return d;
  }
  #prune(d) {
    const cut = this.#now() - REVIEW.keepMs;
    for (const [id, it] of Object.entries(d.items)) if (!OPEN.has(it.state) && (it.closedAt ?? it.updatedAt) < cut) delete d.items[id];
    for (const [id, p] of Object.entries(d.plans)) if ((p.decidedAt ?? p.createdAt) < cut && p.state !== "waiting") delete d.plans[id];
  }
  save(user) {
    writeJsonAtomic(this.#file(user), this.data(user), { log: this.#log });
  }
  users() {
    const out = new Set(this.#cache.keys());
    try {
      for (const f of readdirSync(this.#dir)) if (f.endsWith(".json")) out.add(f.slice(0, -5));
    } catch {}
    return [...out].filter((u) => USER_RE.test(u));
  }
  item(user, id) {
    if (!isReviewId(id)) return null;
    return this.data(user).items[id] ?? null;
  }
  openFor(user, sid) {
    // FEAT-20.7: пункт «ветка» (дифф ветки копии) живёт отдельно от пункта ходов чата
    return Object.values(this.data(user).items).find((it) => it.source?.sid === sid && it.source?.kind !== "branch" && OPEN.has(it.state)) ?? null;
  }
  dropUser(user) {
    this.#cache.delete(user);
  }
}

// ---- сервис ----------------------------------------------------------------------

// deps: objectsRoot (data/review-objects), tmpDir, post({user, sid, text}) →
//   {ok, status, error, messageId?, queued?}, busy(sid) → bool, emit(userIds, props),
//   log, now.
export class ReviewService {
  constructor({ store, objectsRoot, tmpDir, post = null, busy = () => false, emit = () => {}, log = console.error, now = Date.now, quotaBytes = REVIEW.quotaBytes, projectDirOf = () => null, titleOf = () => null }) {
    this.store = store;
    this.projectDirOf = projectDirOf; // BUG-273: пункт → папка проекта чата | null
    this.titleOf = titleOf; // BUG-277: пункт → текущее название чата | null (на конце первого хода чат ещё «Чат»)
    this.objectsRoot = objectsRoot;
    this.tmpDir = tmpDir;
    this.post = post;
    this.busy = busy;
    this.emit = emit;
    this.log = log;
    this.now = now;
    this.quotaBytes = quotaBytes;
    this.locks = new Map();
  }

  // Последовательность операций одного пользователя (две вкладки, ход + клик).
  async lock(user, fn) {
    const prev = this.locks.get(user) ?? Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    const tail = prev.then(() => next);
    this.locks.set(user, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(user) === tail) this.locks.delete(user);
    }
  }

  objDir(user, root) {
    return path.join(this.objectsRoot, user, repoKey(root));
  }

  // Репозиторий папки чата для снимка или причина режима «по ходам».
  async repoFor(user, dir, { untrusted }) {
    let repo;
    try {
      repo = await openRepo(dir, { untrusted });
    } catch (err) {
      if (err instanceof GitError && err.status === 409) return { reason: "unsafe-repo" };
      return { reason: "no-git" };
    }
    if (!repo) return { reason: "no-git" };
    if (dirBytes(path.join(this.objectsRoot, user)) > this.quotaBytes) return { reason: "quota" };
    return { repo };
  }

  async snapshot(user, repo) {
    try {
      return await snapshotTree(repo, { objDir: this.objDir(user, repo.root), tmpDir: this.tmpDir, now: this.now });
    } catch (err) {
      return { error: err, reason: err instanceof GitError && err.status === 504 ? "too-big" : "snapshot-failed" };
    }
  }

  // Начало хода: снимок базы для чата без открытого пункта (база = состояние
  // перед первым непроверенным ходом).
  async turnStart({ users, sid, dir, untrusted }) {
    for (const user of users ?? []) {
      await this.lock(user, async () => {
        if (this.store.openFor(user, sid)) return;
        const r = await this.repoFor(user, dir, { untrusted });
        if (!r.repo) return;
        const s = await this.snapshot(user, r.repo);
        if (!s.tree) return;
        this.store.data(user).starts[sid] = { tree: s.tree, head: s.head, root: r.repo.root, at: this.now() };
        this.store.save(user);
      });
    }
  }

  // Конец хода: новая ревизия пункта, если файлы изменились.
  // meta: {title, engine, model, project}; parts — части хода (режим turns);
  // ended: "done" | "interrupted".
  async turnEnd({ users, sid, dir, untrusted, turnId = null, parts = [], meta = {}, ended = "done", planTurn = false }) {
    const out = [];
    for (const user of users ?? []) {
      const it = await this.lock(user, () => this.#turnEnd(user, { sid, dir, untrusted, turnId, parts, meta, ended, planTurn }));
      if (it) out.push(it);
    }
    return out;
  }

  async #turnEnd(user, { sid, dir, untrusted, turnId, parts, meta, ended, planTurn }) {
    const data = this.store.data(user);
    let item = this.store.openFor(user, sid);
    const r = await this.repoFor(user, dir, { untrusted });
    const now = this.now();
    let change = null;
    if (r.repo && (!item || item.mode === "snapshot")) {
      const s = await this.snapshot(user, r.repo);
      if (s.tree) {
        const objDir = this.objDir(user, r.repo.root);
        const start = data.starts[sid]?.root === r.repo.root ? data.starts[sid] : null;
        const accepted = data.bases?.[sid]?.root === r.repo.root ? data.bases[sid] : null;
        const prevTree = item ? item.revisions.at(-1)?.tree : start?.tree ?? accepted?.tree ?? (await headTree(r.repo));
        if (s.tree !== prevTree) {
          const baseTree = item ? item.base.tree : prevTree;
          const files = await treeChanges(r.repo, { objDir, from: baseTree, to: s.tree });
          const fresh = item ? await treeChanges(r.repo, { objDir, from: prevTree, to: s.tree }) : files;
          change = { mode: "snapshot", tree: s.tree, head: s.head, files, fresh, big: s.big, baseTree, root: r.repo.root };
        }
      } else if (!item) change = this.#turnsChange(parts, dir, s.reason);
    } else if (!item || item.mode === "turns") {
      change = this.#turnsChange(parts, dir, item?.modeReason ?? r.reason ?? "no-git");
    }
    delete data.starts[sid];
    if (planTurn) {
      this.store.save(user);
      return change ? { user, planViolation: change.fresh ?? change.files } : null;
    }
    if (!change || (change.mode === "turns" && change.files.length === 0)) {
      // агент ответил без правок: «Агент правит» возвращается в очередь
      if (item && item.state === "returned") {
        item.state = "pending";
        item.since = now;
        item.updatedAt = now;
        item.version += 1;
        this.store.save(user);
        this.#emit(user, item);
      }
      this.store.save(user);
      return item ? { user, item, changed: false } : null;
    }
    if (change.mode === "snapshot" && change.files.length === 0 && !item) {
      this.store.save(user);
      return null; // правки вернули папку к базе
    }
    if (!item) {
      item = {
        id: newId("rv"), owner: user, source: { kind: "chat", sid }, title: meta.title ?? null, dir: dir ?? null,
        project: { name: projectName(dir) }, engine: meta.engine ?? null, model: meta.model ?? null,
        state: "pending", mode: change.mode, ...(change.reason ? { modeReason: change.reason } : {}),
        ...(change.root ? { root: change.root } : {}),
        base: change.mode === "snapshot" ? { tree: change.baseTree, at: now } : { at: now },
        revision: 0, revisions: [], reviewed: {}, comments: [], sends: [], createdAt: now, updatedAt: now, since: now, version: 0,
      };
      data.items[item.id] = item;
    }
    const n = item.revision + 1;
    const rev = { n, at: now, turns: turnId ? [turnId] : [], files: change.files };
    if (change.mode === "snapshot") {
      rev.tree = change.tree;
      rev.head = change.head;
      rev.fresh = change.fresh.map((f) => f.path);
      if (change.big?.length) rev.big = change.big.slice(0, 100);
    } else rev.changes = change.changes;
    // ход без новой ревизии после «Вернуть» — та же логика: «Ревизия N+1»
    item.revisions.push(rev);
    item.revision = n;
    item.title = meta.title ?? item.title;
    item.engine = meta.engine ?? item.engine;
    item.model = meta.model ?? item.model;
    item.state = ended === "interrupted" ? "interrupted" : "pending";
    item.stale = false;
    item.since = now;
    item.updatedAt = now;
    item.version += 1;
    this.store.save(user);
    this.#emit(user, item);
    return { user, item, changed: true };
  }

  // FEAT-20.7: пункт ревью «ветка» — дифф ветки рабочей копии против
  // merge-base с базовой веткой (незакоммиченное включено: снимок папки копии).
  // Повторное «На ревью» той же копии — новая ревизия того же пункта.
  async branchItem(user, { sid = null, wtId, dir, base, title = null, branch = null, untrusted }) {
    return this.lock(user, async () => {
      const r = await this.repoFor(user, dir, { untrusted });
      if (!r.repo) throw new ReviewError(409, r.reason ?? "no-git", "Ревью ветки недоступно: папка копии не под git");
      const g = (args) => runGit(args, { cwd: r.repo.root, untrusted, env: r.repo.env });
      const mb = (await g(["merge-base", `refs/heads/${base}`, "HEAD"])).stdout.trim();
      if (!isSha(mb)) throw new ReviewError(409, "no-base", "Ревью ветки недоступно: нет общей истории с базовой веткой");
      const baseTree = (await g(["rev-parse", `${mb}^{tree}`])).stdout.trim();
      const s = await this.snapshot(user, r.repo);
      if (!s.tree) throw new ReviewError(409, s.reason ?? "snapshot-failed", "Ревью ветки недоступно: снимок копии не удался");
      const objDir = this.objDir(user, r.repo.root);
      const files = await treeChanges(r.repo, { objDir, from: baseTree, to: s.tree });
      if (!files.length) throw new ReviewError(409, "empty", "В ветке нет изменений относительно базы");
      const data = this.store.data(user);
      const now = this.now();
      let item = Object.values(data.items).find((it) => it.source?.kind === "branch" && it.source?.wtId === wtId && OPEN.has(it.state)) ?? null;
      if (!item) {
        item = {
          id: newId("rv"), owner: user, source: { kind: "branch", sid, wtId, branch, base }, title: title ?? branch, dir,
          project: { name: projectName(dir) }, engine: null, model: null, state: "pending", mode: "snapshot", root: r.repo.root,
          base: { tree: baseTree, at: now }, revision: 0, revisions: [], reviewed: {}, comments: [], sends: [], createdAt: now, updatedAt: now, since: now, version: 0,
        };
        data.items[item.id] = item;
      }
      const prev = item.revisions.at(-1)?.tree;
      if (prev !== s.tree) {
        const fresh = prev ? await treeChanges(r.repo, { objDir, from: prev, to: s.tree }) : files;
        const n = item.revision + 1;
        item.revisions.push({ n, at: now, turns: [], files, tree: s.tree, head: s.head, fresh: fresh.map((f) => f.path) });
        item.revision = n;
        item.state = "pending";
        item.stale = false;
        item.since = now;
        item.updatedAt = now;
        item.version += 1;
      }
      this.store.save(user);
      this.#emit(user, item);
      return { id: item.id, revision: item.revision, files: files.length };
    });
  }

  #turnsChange(parts, dir, reason) {
    const files = turnChanges(parts, { base: dir ?? "" });
    let left = REVIEW.turnLinesMax;
    const changes = files.map((f) => {
      const hunks = [];
      for (const h of f.hunks) {
        if (left <= 0) break;
        const lines = h.lines.slice(0, left);
        left -= lines.length;
        hunks.push({ ...h, lines });
      }
      return { path: f.path, oldPath: f.oldPath ?? null, status: f.status, additions: f.additions, deletions: f.deletions, partial: f.partial, binary: f.binary, hunks, cut: hunks.length < f.hunks.length || hunks.some((h, i) => h.lines.length < f.hunks[i].lines.length) };
    });
    return {
      mode: "turns", reason: reason ?? "no-git",
      files: changes.map((c) => ({ path: c.path, ...(c.oldPath ? { oldPath: c.oldPath } : {}), status: c.status, additions: c.additions, deletions: c.deletions, binary: Boolean(c.binary), partial: Boolean(c.partial) })),
      changes,
    };
  }

  #emit(user, item) {
    try {
      this.emit([user], { id: item.id, sid: item.source?.sid ?? null, state: item.state, status: statusOf(item), revision: item.revision, waiting: NEEDS_YOU.has(statusOf(item)) });
    } catch (err) {
      this.log(`[teleharness-review] emit: ${err?.message ?? err}`);
    }
  }

  // ---- чтение ---------------------------------------------------------------

  // Сводка пункта с проектом чата (BUG-273); ошибка поиска папки — проект по папке пункта.
  summary(it) {
    let projectDir = null;
    let chatTitle = null;
    try {
      projectDir = this.projectDirOf(it) || null;
    } catch {}
    try {
      const t = this.titleOf(it);
      chatTitle = typeof t === "string" && t.trim() ? t.trim() : null;
    } catch {}
    return summaryOf(it, { projectDir, chatTitle });
  }

  summaries(user, { all = false } = {}) {
    const items = Object.values(this.store.data(user).items).filter((it) => all || OPEN.has(it.state));
    return items.map((it) => this.summary(it)).sort((a, b) => a.since - b.since);
  }

  // GET /review: фильтр, страница по 30, ждущие — самые старые первыми.
  list(user, { filter = "all", cursor = 0, accepted = false } = {}) {
    const all = this.summaries(user);
    const counts = { needs: 0, all: all.length, chats: 0, runs: 0, returned: 0 };
    for (const s of all) {
      if (s.needsYou) counts.needs += 1;
      if (s.source === "chat") counts.chats += 1;
      if (s.source === "run") counts.runs += 1;
      if (s.status === "returned") counts.returned += 1;
    }
    const pick = filter === "chats" ? all.filter((s) => s.source === "chat") : filter === "runs" ? all.filter((s) => s.source === "run") : filter === "returned" ? all.filter((s) => s.status === "returned") : all;
    const from = Math.max(0, Number(cursor) || 0);
    const items = pick.slice(from, from + REVIEW.pageSize);
    const out = { items, next: from + REVIEW.pageSize < pick.length ? from + REVIEW.pageSize : null, total: pick.length, counts };
    if (accepted) {
      out.accepted = Object.values(this.store.data(user).items)
        .filter((it) => it.state === "accepted")
        .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
        .slice(0, 30)
        .map((it) => ({ ...this.summary(it), acceptedAt: it.closedAt }));
    }
    return out;
  }

  #get(user, id) {
    const it = this.store.item(user, id);
    if (!it) throw notFound();
    return it;
  }

  async repoOfItem(it, { untrusted }) {
    if (it.mode !== "snapshot" || !it.dir) return null;
    try {
      const repo = await openRepo(it.dir, { untrusted });
      return repo && repo.root === it.root ? repo : null;
    } catch {
      return null;
    }
  }

  // Пункт целиком для экрана ревью (+ свежая проверка «Файлы изменились»).
  async detail(user, id, { untrusted, admin = false }) {
    const it = this.#get(user, id);
    const busy = Boolean(it.source?.sid && this.busy(it.source.sid));
    let stale = null;
    let outcomes = {};
    const repo = await this.repoOfItem(it, { untrusted });
    if (repo && OPEN.has(it.state)) {
      const s = await this.snapshot(user, repo);
      const last = it.revisions.at(-1);
      if (s.tree && last?.tree && s.tree !== last.tree) {
        const changed = await treeChanges(repo, { objDir: this.objDir(user, repo.root), from: last.tree, to: s.tree }).catch(() => []);
        stale = { revision: it.revision + 1, changedFiles: changed.map((f) => f.path).slice(0, 50), files: changed.length };
      }
      if (Boolean(stale) !== Boolean(it.stale)) {
        it.stale = Boolean(stale);
        this.store.save(user);
      }
      outcomes = await this.#outcomes(user, it, repo);
    }
    const files = filesOf(it);
    const last = it.revisions.at(-1);
    const prevSent = [...it.sends].reverse().find((s) => s.state === "sent" && s.revision < it.revision);
    return {
      ...this.summary(it),
      state: it.state, version: it.version, mode: it.mode, modeReason: it.modeReason ?? null, busy, stale,
      base: { at: it.base.at, head: it.mode === "snapshot" ? it.revisions[0]?.head?.slice(0, 7) ?? null : null },
      revisions: it.revisions.map((r) => ({ n: r.n, at: r.at, turns: r.turns?.length ?? 0, files: r.files.length, fresh: r.fresh ?? null })),
      fileList: files.map((f) => ({ ...f, reviewed: it.reviewed[f.path] === it.revision, big: (last?.big ?? []).includes(f.path) })),
      big: last?.big ?? [],
      sinceRevision: prevSent ? prevSent.revision : null,
      sinceFiles: prevSent && it.mode === "snapshot" ? this.#sinceFiles(it, prevSent.revision) : null,
      comments: it.comments.map((c) => ({ ...c, ...(outcomes[c.id] ? { outcome: outcomes[c.id] } : {}) })),
      sends: it.sends.filter((s) => s.state === "sent").map((s) => ({ revision: s.revision, at: s.at, count: s.count })),
      accept: it.accept ?? null,
      dismissed: it.dismissed ?? null,
      ...(admin ? {} : {}),
    };
  }

  #sinceFiles(it, rev) {
    const set = new Set();
    for (const r of it.revisions) if (r.n > rev) for (const p of r.fresh ?? []) set.add(p);
    return [...set];
  }

  async #outcomes(user, it, repo) {
    const out = {};
    const last = it.revisions.at(-1);
    const sent = it.comments.filter((c) => c.state === "sent" && c.sentIn && c.sentIn < it.revision && c.file);
    if (!sent.length || !last?.tree) return out;
    const objDir = this.objDir(user, repo.root);
    const cache = new Map();
    for (const c of sent) {
      const from = it.revisions.find((r) => r.n === c.sentIn)?.tree;
      if (!from) continue;
      const k = `${c.sentIn}:${c.file}`;
      if (!cache.has(k)) {
        const changed = (await treeChanges(repo, { objDir, from, to: last.tree }).catch(() => [])).find((f) => f.path === c.file || f.oldPath === c.file);
        if (!changed) cache.set(k, null);
        else if (changed.status === "D") cache.set(k, "gone");
        else cache.set(k, (await treeDiff(repo, { objDir, from, to: last.tree, file: changed.path, oldPath: changed.oldPath ?? null, full: true }).catch(() => ({ patch: "" }))).patch);
      }
      out[c.id] = commentOutcome(c, cache.get(k));
    }
    return out;
  }

  // Дифф файла: rev (по умолчанию последняя), since — ревизия «с прошлого ревью».
  async diff(user, id, { file, rev = null, since = null, full = false, raw = false, untrusted }) {
    const it = this.#get(user, id);
    if (typeof file !== "string" || !file) throw new ReviewError(400, "bad-file", "file required");
    const r = rev ? it.revisions.find((x) => x.n === Number(rev)) : it.revisions.at(-1);
    if (!r) throw new ReviewError(404, "no-revision", "Ревизия не найдена");
    const meta = filesOf(it).find((f) => f.path === file) ?? null;
    if (it.mode === "turns") {
      const hunks = [];
      let partial = false;
      let status = meta?.status ?? "M";
      for (const x of it.revisions) {
        const ch = x.changes?.find((c) => c.path === file);
        if (!ch) continue;
        hunks.push(...ch.hunks);
        partial = partial || ch.partial;
      }
      if (!meta) throw new ReviewError(404, "no-file", "Файла нет в ревью");
      return { file, mode: "turns", hunks, partial, status, binary: Boolean(meta.binary), additions: meta.additions, deletions: meta.deletions, truncated: false, huge: false };
    }
    const repo = await this.repoOfItem(it, { untrusted });
    if (!repo) throw new ReviewError(409, "no-repo", "Папка больше не под git — снимок недоступен");
    const objDir = this.objDir(user, repo.root);
    let from = it.base.tree;
    if (since != null) {
      const s = it.revisions.find((x) => x.n === Number(since));
      if (!s) throw new ReviewError(404, "no-revision", "Ревизия не найдена");
      from = s.tree;
    }
    if (!isSha(from) || !isSha(r.tree)) throw new ReviewError(409, "no-snapshot", "Снимок ревизии недоступен");
    const d = await treeDiff(repo, { objDir, from, to: r.tree, file, oldPath: meta?.oldPath ?? null, full, raw });
    return { ...d, mode: "snapshot", status: meta?.status ?? "M", revision: r.n, since: since != null ? Number(since) : null };
  }

  // «Обновить до ревизии N»: снимок, если файлы изменились (не во время хода).
  async refresh(user, id, { untrusted }) {
    return this.lock(user, async () => {
      const it = this.#get(user, id);
      if (it.source?.sid && this.busy(it.source.sid)) throw new ReviewError(409, "busy", "Агент работает — дождитесь конца хода");
      const repo = await this.repoOfItem(it, { untrusted });
      if (!repo) return { revision: it.revision, changed: false };
      const s = await this.snapshot(user, repo);
      const last = it.revisions.at(-1);
      if (!s.tree || s.tree === last.tree) {
        it.stale = false;
        this.store.save(user);
        return { revision: it.revision, changed: false };
      }
      const objDir = this.objDir(user, repo.root);
      const files = await treeChanges(repo, { objDir, from: it.base.tree, to: s.tree });
      const fresh = await treeChanges(repo, { objDir, from: last.tree, to: s.tree });
      const now = this.now();
      it.revisions.push({ n: it.revision + 1, at: now, turns: [], files, tree: s.tree, head: s.head, fresh: fresh.map((f) => f.path), refreshed: true, ...(s.big?.length ? { big: s.big } : {}) });
      it.revision += 1;
      it.stale = false;
      it.updatedAt = now;
      it.version += 1;
      this.store.save(user);
      this.#emit(user, it);
      return { revision: it.revision, changed: true };
    });
  }

  // ---- комментарии ------------------------------------------------------------

  putComment(user, id, cid, body) {
    const it = this.#get(user, id);
    if (!CID_RE.test(String(cid))) throw new ReviewError(400, "bad-id", "bad comment id");
    if (!OPEN.has(it.state)) throw new ReviewError(409, "closed", "Ревью уже закрыто", { state: it.state });
    const cur = it.comments.find((c) => c.id === cid);
    const version = Number(body?.version ?? 0);
    if (cur) {
      if (cur.state !== "draft") throw new ReviewError(409, "sent", "Комментарий уже отправлен агенту");
      if (cur.version !== version) throw new ReviewError(409, "version", "Комментарий изменён на другом устройстве", { current: cur });
    } else if (it.comments.length >= REVIEW_LIMITS.comments) throw new ReviewError(409, "too-many", "Не больше 300 комментариев в одном ревью");
    const clean = cleanComment(body, { revision: it.revision });
    const now = this.now();
    const next = { id: cid, ...(cur ? { revision: cur.revision } : {}), ...clean, ...(cur ? { revision: cur.revision } : {}), state: "draft", createdAt: cur?.createdAt ?? now, updatedAt: now, version: (cur?.version ?? 0) + 1 };
    if (cur) Object.assign(cur, next);
    else it.comments.push(next);
    it.updatedAt = now;
    this.store.save(user);
    return { comment: cur ?? next, drafts: it.comments.filter((c) => c.state === "draft").length };
  }

  deleteComment(user, id, cid, version) {
    const it = this.#get(user, id);
    const cur = it.comments.find((c) => c.id === cid);
    if (!cur) return { ok: true };
    if (cur.state !== "draft") throw new ReviewError(409, "sent", "Комментарий уже отправлен агенту");
    if (version != null && Number(version) !== cur.version) throw new ReviewError(409, "version", "Комментарий изменён на другом устройстве", { current: cur });
    it.comments = it.comments.filter((c) => c.id !== cid);
    this.store.save(user);
    return { ok: true };
  }

  setViewed(user, id, { file, viewed = true }) {
    const it = this.#get(user, id);
    if (typeof file !== "string" || !filesOf(it).some((f) => f.path === file)) throw new ReviewError(404, "no-file", "Файла нет в ревью");
    if (viewed) it.reviewed[file] = it.revision;
    else delete it.reviewed[file];
    this.store.save(user);
    return { ok: true };
  }

  // ---- «Вернуть агенту» ---------------------------------------------------------

  message(user, id, { general = "", lang = "ru" } = {}) {
    const it = this.#get(user, id);
    const drafts = it.comments.filter((c) => c.state === "draft" && (c.text ?? "").trim());
    const m = buildReviewMessage({ id: it.id, revision: it.revision, comments: drafts, general, files: filesOf(it), lang: langOf(lang) });
    return { ...m, drafts: drafts.length, busy: Boolean(it.source?.sid && this.busy(it.source.sid)), engine: it.engine };
  }

  async send(user, id, { key, revision, general = "", lang = "ru" }) {
    if (!isKey(key)) throw new ReviewError(400, "bad-key", "bad key");
    if (typeof general !== "string" || general.length > REVIEW_LIMITS.comment) throw new ReviewError(400, "too-long", "Общий комментарий длиннее 4000 символов");
    return this.lock(user, async () => {
      const it = this.#get(user, id);
      const prev = it.sends.find((s) => s.key === key);
      if (prev?.state === "sent") return { already: true, at: prev.at, revision: prev.revision, count: prev.count, queued: Boolean(prev.queued) };
      if (prev?.state === "pending" && this.now() - prev.at < REVIEW.sendPendingMs) throw new ReviewError(409, "in-progress", "Отправка уже идёт");
      if (!OPEN.has(it.state)) throw new ReviewError(409, "closed", "Ревью уже закрыто", { state: it.state, at: it.closedAt ?? null });
      if (Number(revision) !== it.revision) throw new ReviewError(409, "stale-revision", "Ревью обновилось — откройте свежую ревизию", { revision: it.revision });
      const m = this.message(user, id, { general, lang });
      if (m.count === 0) throw new ReviewError(400, "empty", "Нет комментариев для агента");
      if (m.tooLong) throw new ReviewError(413, "too-long", "Комментарии не помещаются в одно сообщение (30 000 символов) — сократите их");
      if (!this.post) throw new ReviewError(503, "no-post", "Отправка недоступна");
      const send = { key, at: this.now(), revision: it.revision, state: "pending", count: m.count };
      it.sends = [...it.sends.filter((s) => s.key !== key), send];
      this.store.save(user); // ключ записан ДО сообщения: повтор после рестарта не дублирует
      const busy = Boolean(it.source?.sid && this.busy(it.source.sid));
      let r;
      try {
        r = await this.post({ user, sid: it.source.sid, dir: it.dir, text: m.text });
      } catch (err) {
        r = { ok: false, status: 502, error: String(err?.message ?? err) };
      }
      if (!r?.ok) {
        it.sends = it.sends.filter((s) => s.key !== key);
        this.store.save(user);
        throw new ReviewError(r?.status && r.status >= 400 ? r.status : 502, "post-failed", "Не отправлено — комментарии сохранены", { detail: String(r?.error ?? "").slice(0, 300) });
      }
      const now = this.now();
      send.state = "sent";
      send.at = now;
      send.queued = busy;
      for (const c of it.comments) if (c.state === "draft" && (c.text ?? "").trim()) Object.assign(c, { state: "sent", sentIn: it.revision });
      if (general.trim()) it.comments.push({ id: `c_g${now.toString(36)}`, revision: it.revision, file: null, side: "general", from: null, to: null, quote: [], text: general.trim(), state: "sent", sentIn: it.revision, createdAt: now, updatedAt: now, version: 1 });
      it.state = "returned";
      it.since = now;
      it.updatedAt = now;
      it.version += 1;
      this.store.save(user);
      this.#emit(user, it);
      return { already: false, at: now, revision: it.revision, count: m.count, queued: busy };
    });
  }

  // ---- «Принять» / «Убрать» ------------------------------------------------------

  async accept(user, id, { key, revision, untrusted }) {
    if (!isKey(key)) throw new ReviewError(400, "bad-key", "bad key");
    return this.lock(user, async () => {
      const it = this.#get(user, id);
      if (it.state === "accepted") {
        if (it.accept?.key === key) return { ok: true, at: it.accept.at, files: it.accept.files };
        throw new ReviewError(409, "already", "Уже принято на другом устройстве", { state: "accepted", at: it.accept?.at ?? it.closedAt });
      }
      if (it.state === "dismissed") throw new ReviewError(409, "already", "Уже убрано из «Ждёт ревью»", { state: "dismissed", at: it.closedAt });
      if (it.source?.sid && this.busy(it.source.sid)) throw new ReviewError(409, "busy", "Агент работает — дождитесь конца хода");
      if (Number(revision) !== it.revision) throw new ReviewError(409, "stale-revision", "Файлы изменились — обновите ревью", { revision: it.revision });
      const repo = await this.repoOfItem(it, { untrusted });
      const last = it.revisions.at(-1);
      if (repo && last?.tree) {
        const s = await this.snapshot(user, repo);
        if (s.tree && s.tree !== last.tree) {
          it.stale = true;
          this.store.save(user);
          throw new ReviewError(409, "stale-revision", "Файлы изменились после снимка — обновите до новой ревизии", { revision: it.revision + 1 });
        }
      }
      const now = this.now();
      const files = filesOf(it).map((f) => f.path);
      it.state = "accepted";
      it.closedAt = now;
      it.accept = { at: now, key, revision: it.revision, files };
      it.updatedAt = now;
      it.version += 1;
      const data = this.store.data(user);
      if (it.mode === "snapshot" && last?.tree) {
        data.bases ??= {};
        data.bases[it.source.sid] = { tree: last.tree, root: it.root, at: now };
      }
      this.store.save(user);
      this.#emit(user, it);
      return { ok: true, at: now, files };
    });
  }

  async dismiss(user, id, { key }) {
    if (!isKey(key)) throw new ReviewError(400, "bad-key", "bad key");
    return this.lock(user, async () => {
      const it = this.#get(user, id);
      if (it.state === "dismissed") return { ok: true, at: it.closedAt };
      if (it.state === "accepted") throw new ReviewError(409, "already", "Уже принято", { state: "accepted", at: it.closedAt });
      const now = this.now();
      const drafts = it.comments.filter((c) => c.state === "draft").length;
      it.comments = it.comments.filter((c) => c.state !== "draft");
      it.state = "dismissed";
      it.closedAt = now;
      it.dismissed = { at: now, key, drafts };
      it.updatedAt = now;
      it.version += 1;
      this.store.save(user);
      this.#emit(user, it);
      return { ok: true, at: now, drafts };
    });
  }

  // Удаление чата: пункт «Чат удалён» (вне счётчиков, кнопка «Убрать»).
  // Включает и открытые ревью ветки (source.kind === "branch"), связанные с чатом.
  chatDeleted(sid) {
    for (const user of this.store.users()) {
      const data = this.store.data(user);
      const items = Object.values(data.items).filter((it) => it.source?.sid === sid && OPEN.has(it.state));
      if (!items.length && !(sid in data.starts)) continue;
      const now = this.now();
      for (const it of items) {
        it.chatDeleted = true;
        it.updatedAt = now;
        it.version += 1;
      }
      delete data.starts[sid];
      this.store.save(user);
      for (const it of items) this.#emit(user, it);
    }
  }

  // «Отменить ход» вернул файлы: пересчёт пункта по свежему снимку.
  async turnUndone({ users, sid, dir, untrusted }) {
    for (const user of users ?? []) {
      await this.lock(user, async () => {
        const it = this.store.openFor(user, sid);
        if (!it || it.mode !== "snapshot") return;
        const repo = await this.repoOfItem(it, { untrusted });
        if (!repo) return;
        const s = await this.snapshot(user, repo);
        if (!s.tree) return;
        const objDir = this.objDir(user, repo.root);
        const files = await treeChanges(repo, { objDir, from: it.base.tree, to: s.tree });
        const now = this.now();
        if (files.length === 0) {
          it.state = "dismissed";
          it.closedAt = now;
          it.dismissed = { at: now, key: "undo", reason: "undo" };
        } else {
          const last = it.revisions.at(-1);
          Object.assign(last, { tree: s.tree, head: s.head, files, at: now });
        }
        it.updatedAt = now;
        it.version += 1;
        this.store.save(user);
        this.#emit(user, it);
      });
    }
  }

  // ---- «Сначала план» --------------------------------------------------------------

  plansOf(user, sid) {
    return Object.values(this.store.data(user).plans).filter((p) => p.sid === sid).sort((a, b) => a.n - b.n);
  }

  plan(user, id) {
    if (!isPlanId(id)) throw notFound();
    const p = this.store.data(user).plans[id];
    if (!p) throw notFound();
    return p;
  }

  // Итог план-хода: карточка плана (или «План не получен»), прежний ждущий — «Заменён».
  // Поздний ExitPlanMode (Claude-ход с фоновым субагентом закончился раньше, BUG-237):
  // настоящий план заменяет текст, взятый из ответа, пока решения нет.
  planFromTool(user, sid, text) {
    const clean = String(text ?? "").trim().slice(0, 60_000);
    const last = this.plansOf(user, sid).at(-1);
    if (!clean || !last || last.source === "tool" || !["waiting", "failed"].includes(last.state)) return null;
    Object.assign(last, { text: clean, source: "tool", state: "waiting", updatedAt: this.now() });
    this.store.save(user);
    this.emit([user], { plan: true, id: last.id, sid, state: last.state });
    return last;
  }

  createPlan(user, { sid, turnId = null, engine = null, model = null, text = "", violations = [], source = "answer" }) {
    const data = this.store.data(user);
    const mine = this.plansOf(user, sid);
    const now = this.now();
    const n = (mine.at(-1)?.n ?? 0) + 1;
    const clean = String(text ?? "").trim().slice(0, 60_000);
    const p = { id: newId("pl"), sid, n, turn: turnId, engine, model, text: clean, source, state: clean ? "waiting" : "failed", violations: (violations ?? []).slice(0, 50), createdAt: now };
    for (const old of mine) if (old.state === "waiting" || old.state === "failed") Object.assign(old, { state: "superseded", supersededBy: n, decidedAt: now });
    data.plans[p.id] = p;
    this.store.save(user);
    this.emit([user], { plan: true, id: p.id, sid, state: p.state });
    return p;
  }

  // Решение по плану: идемпотентно по ключу; другой ключ после решения — 409.
  async decide(user, id, { action, key, text = null, comment = null }, run) {
    if (!isKey(key)) throw new ReviewError(400, "bad-key", "bad key");
    if (!["approve", "revise", "reject"].includes(action)) throw new ReviewError(400, "bad-action", "bad action");
    return this.lock(user, async () => {
      const p = this.plan(user, id);
      if (p.state !== "waiting") {
        if (p.decisionKey === key) return { already: true, plan: p };
        throw new ReviewError(409, "already", "Решение уже принято", { state: p.state, decidedAt: p.decidedAt ?? null });
      }
      const edited = action === "approve" && typeof text === "string" && text.trim() && text.trim() !== p.text;
      if (typeof text === "string" && text.length > 60_000) throw new ReviewError(400, "too-long", "План слишком длинный");
      if (run && action !== "reject") {
        const r = await run({ plan: p, text: edited ? text.trim() : p.text, edited, comment });
        if (!r?.ok) throw new ReviewError(r?.status && r.status >= 400 ? r.status : 502, "post-failed", "Ход не начался", { detail: String(r?.error ?? "").slice(0, 300) });
        if (r.engine) p.execEngine = r.engine;
        if (r.model) p.execModel = r.model;
      }
      const now = this.now();
      p.state = action === "approve" ? (edited ? "approved-edited" : "approved") : action === "revise" ? "revised" : "rejected";
      if (edited) p.edited = text.trim();
      if (comment) p.comment = String(comment).slice(0, 4000);
      p.decidedAt = now;
      p.decisionKey = key;
      this.store.save(user);
      this.emit([user], { plan: true, id: p.id, sid: p.sid, state: p.state });
      return { already: false, plan: p };
    });
  }
}

export function projectName(dir) {
  return String(dir ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}

export const reviewObjectsExist = (root) => existsSync(root);
