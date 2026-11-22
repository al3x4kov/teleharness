// FEAT-20.3 (1.4/1.5/1.8/1.10): триггеры GitHub — хранилище и решение по событию.
// База data/github-triggers.sqlite (таблицы design.md: triggers, inbox, journal,
// subjects, queue, poll_cursors, settings). Токены подключений — рядом
// (lib/github/connections.js). Решение каждого события пишется в журнал (кр. 17).
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { CI_ATTEMPTS_MAX } from "../../shared/temporal-templates.js";

const require = createRequire(import.meta.url);

export class TriggerError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.name = "TriggerError";
    this.status = status;
    if (extra) Object.assign(this, extra);
  }
}

// Решения журнала — каталог design.md.
export const SKIPPED = new Set(["duplicate", "already_running", "queued", "queue_full", "rate_limited", "claude_limit", "untrusted_author", "untrusted_text", "fork_pr", "filtered_repo", "filtered_label", "filtered_branch", "filtered_command", "filtered_kind", "ci_not_failed", "ci_logs_unavailable", "trigger_disabled", "admin_stopped", "no_connection"]);
export const ERRORED = new Set(["bad_signature", "too_large", "error", "ci_attempts_exhausted"]);
// queued — replayable: событие хранится целиком, выпуск из очереди запускает его позже (1.11).
export const REPLAYABLE = new Set(["rate_limited", "queue_full", "trigger_disabled", "admin_stopped", "queued"]);

export const DEFAULT_LIMITS = { maxActive: 1, perHour: 6, queue: 20, userPerDay: 30 };
// «Починить CI»: коммит агента = попытка; после двух запусков по одному красному
// subject — нужен человек (design §4, задача 1.14); человеческий push сбрасывает.
// Число живёт в shared — его же показывает экран запуска («попытка N из 2»).
export { CI_ATTEMPTS_MAX };

// Решение по событию (design §4/§6). Чистая функция — тесты гоняют её без БД.
// state: {ev, trigger, duplicate, activeWorkflowId, queuedEventKey, queueable,
//         perHour, userPerDay, adminStopped, connectionOk, trusted, limits}
export function decideEvent(state) {
  const { ev, trigger } = state;
  const limits = state.limits ?? trigger?.limits ?? DEFAULT_LIMITS;
  if (state.adminStopped) return { decision: "admin_stopped", reason: "Остановлено администратором" };
  if (!trigger.enabled) return { decision: "trigger_disabled", reason: "Триггер выключен" };
  if (state.duplicate) return { decision: "duplicate", reason: "Дубликат события" };
  if (!state.connectionOk) return { decision: "no_connection", reason: "Нет подключения GitHub" };
  if (!state.trusted) return { decision: "untrusted_author", reason: "Пропущено: автор не доверен" };
  if (state.perHour >= (limits.perHour ?? DEFAULT_LIMITS.perHour)) return { decision: "rate_limited", reason: "Лимит частоты триггера" };
  if (state.userPerDay >= (limits.userPerDay ?? DEFAULT_LIMITS.userPerDay)) return { decision: "rate_limited", reason: "Лимит запусков в сутки" };
  // Серверный лимит Claude в фоне (design §6): общий на всех владельцев, admin настраивает.
  if ((state.claudePerDay ?? 0) >= (state.serverLimits?.claudePerDay ?? 10)) return { decision: "claude_limit", reason: "Лимит Claude в фоне исчерпан на сегодня" };
  if (state.activeWorkflowId) {
    if (state.queueable && !state.queuedEventKey) {
      if ((state.queueLen ?? 0) >= (limits.queue ?? DEFAULT_LIMITS.queue)) return { decision: "queue_full", reason: "Очередь полна" };
      return { decision: "queued", reason: "В очередь за идущим запуском" };
    }
    return { decision: "already_running", reason: "Уже идёт запуск" };
  }
  // «Починить CI»: исчерпанные попытки — к человеку (сброс коммитом человека).
  if (ev.kind === "ci_failed" && (state.ciAttempts ?? 0) >= CI_ATTEMPTS_MAX)
    return { decision: "ci_attempts_exhausted", reason: `Нужен человек: ${CI_ATTEMPTS_MAX} из ${CI_ATTEMPTS_MAX} попыток` };
  return { decision: "started" };
}

export function triggerService(databasePath, { secrets, now = () => Date.now() } = {}) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS triggers(
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, definition_id TEXT NOT NULL,
      version INTEGER, repo TEXT NOT NULL, kinds_json TEXT NOT NULL DEFAULT '[]', filters_json TEXT NOT NULL DEFAULT '{}',
      delivery TEXT NOT NULL DEFAULT 'auto', poll_seconds INTEGER NOT NULL DEFAULT 120,
      secret_enc TEXT NOT NULL, hook_id INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
      limits_json TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox(
      delivery_id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, received_at INTEGER NOT NULL,
      event TEXT NOT NULL, body_gz BLOB, processed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS journal(
      id INTEGER PRIMARY KEY AUTOINCREMENT, trigger_id TEXT NOT NULL, event_key TEXT UNIQUE, at INTEGER NOT NULL,
      kind TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER, actor TEXT, decision TEXT NOT NULL, reason TEXT,
      workflow_id TEXT, via TEXT NOT NULL DEFAULT 'webhook', event_json TEXT);
    CREATE INDEX IF NOT EXISTS journal_by_trigger ON journal(trigger_id, id);
    CREATE TABLE IF NOT EXISTS subjects(
      trigger_id TEXT NOT NULL, subject_key TEXT NOT NULL, active_workflow_id TEXT, queued_event_key TEXT,
      ci_attempts INTEGER NOT NULL DEFAULT 0, last_human_sha TEXT, PRIMARY KEY(trigger_id, subject_key));
    CREATE TABLE IF NOT EXISTS poll_cursors(
      trigger_id TEXT NOT NULL, resource TEXT NOT NULL, etag TEXT, since TEXT, PRIMARY KEY(trigger_id, resource));
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  const parse = (row) => row && {
    id: row.id, owner: row.owner, definitionId: row.definition_id, version: row.version,
    repo: row.repo, kinds: safeList(row.kinds_json), filters: safeObj(row.filters_json),
    delivery: row.delivery, pollSeconds: row.poll_seconds, hookId: row.hook_id,
    enabled: !!row.enabled, limits: { ...DEFAULT_LIMITS, ...safeObj(row.limits_json) },
    revision: row.revision, createdAt: row.created_at,
  };
  const safeList = (s) => { try { return JSON.parse(s) ?? []; } catch { return []; } };
  const safeObj = (s) => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };
  const touch = () => db.prepare("UPDATE triggers SET revision=revision+1 WHERE id=?");

  // Ключ webhook-адреса (128 бит, cr.21) храним только хэшем; секрет — шифрованым.
  function create(owner, spec) {
    const key = require("node:crypto").randomBytes(32).toString("base64url");
    const keyHash = createHash("sha256").update(key).digest("hex");
    const secret = require("node:crypto").randomBytes(32).toString("base64url");
    const id = randomUUID();
    db.prepare(`INSERT INTO triggers(id, owner, key_hash, definition_id, version, repo, kinds_json, filters_json,
        delivery, poll_seconds, secret_enc, enabled, limits_json, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, owner, keyHash, spec.definitionId, spec.version ?? null, spec.repo, JSON.stringify(spec.kinds ?? []),
        JSON.stringify(spec.filters ?? {}), spec.delivery ?? "auto", spec.pollSeconds ?? 120,
        secrets.encrypt(secret), 1, JSON.stringify(spec.limits ?? {}), now());
    const row = get(owner, id);
    return { ...row, key, secret }; // ключ и секрет показываются один раз, при создании
  }
  function get(owner, id) {
    const row = db.prepare(`SELECT id, owner, key_hash, definition_id, version, repo, kinds_json, filters_json,
      delivery, poll_seconds, hook_id, enabled, limits_json, revision, created_at
      FROM triggers WHERE owner=? AND id=?`).get(owner, id);
    return parse(row);
  }
  function byKeyHash(keyHash) {
    const row = db.prepare("SELECT id, owner, key_hash, definition_id, version, repo, kinds_json, filters_json, delivery, poll_seconds, hook_id, enabled, limits_json, revision, created_at FROM triggers WHERE key_hash=?").get(keyHash);
    return parse(row);
  }
  function getById(id) {
    const row = db.prepare("SELECT id, owner, key_hash, definition_id, version, repo, kinds_json, filters_json, delivery, poll_seconds, hook_id, enabled, limits_json, revision, created_at FROM triggers WHERE id=?").get(id);
    return parse(row);
  }
  function firstByEventKey(eventKey) {
    return db.prepare("SELECT id, workflow_id AS workflowId, at, via, event_json AS eventJson FROM journal WHERE event_key=? ORDER BY id LIMIT 1").get(eventKey) ?? null;
  }
  function secretFor(row) {
    const enc = db.prepare("SELECT secret_enc FROM triggers WHERE id=?").get(row.id)?.secret_enc;
    return enc ? secrets.decrypt(enc) : null;
  }
  // Ключ хранится только хэшем (кр. 21) — совпадение проверяем на входе.
  function verifyKey(owner, id, key) {
    const row = db.prepare("SELECT key_hash FROM triggers WHERE owner=? AND id=?").get(owner, id);
    return !!row && row.key_hash === createHash("sha256").update(String(key ?? "")).digest("hex");
  }
  function list(owner) {
    return db.prepare(`SELECT id, owner, key_hash, definition_id, version, repo, kinds_json, filters_json,
      delivery, poll_seconds, hook_id, enabled, limits_json, revision, created_at
      FROM triggers WHERE owner=? ORDER BY created_at DESC, id`).all(owner).map(parse);
  }
  function listAll() {
    return db.prepare("SELECT id, owner FROM triggers ORDER BY owner").all();
  }
  // PATCH: только свои поля; repo/definitionId неизменяемы (пересоздать).
  const MUTABLE = {
    kinds: "kinds_json", filters: "filters_json", delivery: "delivery",
    pollSeconds: "poll_seconds", limits: "limits_json", enabled: "enabled",
  };
  function update(owner, id, fields, revision) {
    const row = get(owner, id);
    if (!row) throw new TriggerError(404, "Триггер не найден");
    if (Number.isInteger(revision) && revision !== row.revision) throw new TriggerError(409, "Триггер изменён другим окном — обновите страницу");
    const sets = [];
    const args = [];
    for (const [k, v] of Object.entries(fields ?? {})) {
      const col = MUTABLE[k];
      if (!col) continue;
      sets.push(`${col}=?`);
      args.push(typeof v === "object" ? JSON.stringify(v) : (k === "enabled" ? (v ? 1 : 0) : v));
    }
    if (sets.length) {
      args.push(id);
      db.prepare(`UPDATE triggers SET ${sets.join(", ")}, revision=revision+1 WHERE id=?`).run(...args);
    }
    return get(owner, id);
  }
  function remove(owner, id, revision) {
    const row = get(owner, id);
    if (!row) throw new TriggerError(404, "Триггер не найден");
    if (Number.isInteger(revision) && revision !== row.revision) throw new TriggerError(409, "Триггер изменён другим окном — обновите страницу");
    db.prepare("DELETE FROM triggers WHERE id=?").run(id);
    db.prepare("DELETE FROM subjects WHERE trigger_id=?").run(id);
    db.prepare("DELETE FROM poll_cursors WHERE trigger_id=?").run(id);
    return true;
  }
  function setHookId(owner, id, hookId) {
    db.prepare("UPDATE triggers SET hook_id=?, revision=revision+1 WHERE owner=? AND id=?").run(hookId, owner, id);
    return get(owner, id);
  }
  function rotateSecret(owner, id) {
    const row = get(owner, id);
    if (!row) throw new TriggerError(404, "Триггер не найден");
    const secret = require("node:crypto").randomBytes(32).toString("base64url");
    db.prepare("UPDATE triggers SET secret_enc=?, revision=revision+1 WHERE id=?").run(secrets.encrypt(secret), id);
    return { row: get(owner, id), secret };
  }

  // --- inbox (доставки) ---
  function insertDelivery(deliveryId, triggerId, event, body) {
    return db.prepare("INSERT OR IGNORE INTO inbox(delivery_id, trigger_id, received_at, event, body_gz) VALUES(?,?,?,?,?)")
      .run(deliveryId, triggerId, now(), event, body).changes > 0;
  }
  function pendingDeliveries(limit = 50) {
    return db.prepare("SELECT delivery_id AS deliveryId, trigger_id AS triggerId, received_at AS receivedAt, event, body_gz AS body FROM inbox WHERE processed=0 ORDER BY received_at LIMIT ?").all(limit);
  }
  function markProcessed(deliveryId) {
    db.prepare("UPDATE inbox SET processed=1 WHERE delivery_id=?").run(deliveryId);
  }
  // GC: доставки 24 ч (design), журнал 14 дней и ≤ 1000 строк на триггер (кр. 17).
  function gc() {
    const t = now();
    db.prepare("DELETE FROM inbox WHERE received_at < ? OR processed=1").run(t - 24 * 3600_000).changes;
    db.prepare("DELETE FROM journal WHERE at < ?").run(t - 14 * 24 * 3600_000).changes;
    for (const row of db.prepare("SELECT trigger_id AS id, COUNT(*) AS n FROM journal GROUP BY trigger_id HAVING n > 1000").all()) {
      db.prepare("DELETE FROM journal WHERE trigger_id=? AND id NOT IN (SELECT id FROM journal WHERE trigger_id=? ORDER BY id DESC LIMIT 1000)").run(row.id, row.id);
    }
  }

  // --- журнал решений ---
  // INSERT OR IGNORE: тот же event_key из другой доставки не напишется второй раз;
  // changes=0 → «duplicate» и не надо решать дважды.
  function record(entry) {
    return db.prepare(`INSERT OR IGNORE INTO journal(trigger_id, event_key, at, kind, repo, number, actor, decision, reason, workflow_id, via, event_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(entry.triggerId, entry.eventKey ?? null, entry.at ?? now(), entry.kind, entry.repo, entry.number ?? null,
        entry.actor ?? null, entry.decision, entry.reason ?? null, entry.workflowId ?? null, entry.via ?? "webhook",
        entry.eventJson ?? null).changes > 0;
  }
  function startedPerHour(triggerId) {
    return db.prepare("SELECT COUNT(*) AS n FROM journal WHERE trigger_id=? AND decision='started' AND at>=?").get(triggerId, now() - 3600_000).n;
  }
  function startedPerDayForOwner(owner) {
    return db.prepare("SELECT COUNT(*) AS n FROM journal j JOIN triggers t ON t.id=j.trigger_id WHERE t.owner=? AND j.decision='started' AND j.at>=?").get(owner, now() - 24 * 3600_000).n;
  }
  // Серверный лимит Claude в фоне (design §6, вопрос 1): все запуски за сутки.
  function startedPerDayAll() {
    return db.prepare("SELECT COUNT(*) AS n FROM journal WHERE decision='started' AND at>=?").get(now() - 24 * 3600_000).n;
  }
  function eventsPerWindow(triggerId, windowMs) {
    return db.prepare("SELECT COUNT(*) AS n FROM journal WHERE trigger_id=? AND at>=?").get(triggerId, now() - windowMs).n;
  }
  function journal(owner, triggerId, { filter = null, cursor = null, limit = 50 } = {}) {
    if (!get(owner, triggerId)) throw new TriggerError(404, "Триггер не найден");
    const where = ["j.trigger_id=?"];
    const args = [triggerId];
    if (filter === "started") { where.push("j.decision='started'"); }
    if (filter === "skipped") { where.push(`j.decision IN (${[...SKIPPED].map(() => "?").join(",")})`); args.push(...SKIPPED); }
    if (filter === "errors") { where.push(`j.decision IN (${[...ERRORED].map(() => "?").join(",")})`); args.push(...ERRORED); }
    if (cursor != null) { where.push("j.id<?"); args.push(cursor); }
    args.push(limit);
    const rows = db.prepare(`SELECT j.id, j.at, j.kind, j.repo, j.number, j.actor, j.decision, j.reason, j.workflow_id AS workflowId, j.via, j.event_json AS eventJson
      FROM journal j WHERE ${where.join(" AND ")} ORDER BY j.id DESC LIMIT ?`).all(...args);
    // Тело события (только у повторяемых решений) — для листа события и «Запустить снова».
    return rows.map((r) => ({ ...r, eventJson: r.eventJson ? safeObj(r.eventJson) : null }));
  }

  // Сводка по триггерам владельца для списка UI (2.2, T-1/T-13/T-21): последнее
  // срабатывание, ошибки, неверные подписи, «Нужен человек» (попытки CI) и флаг
  // шторма (storm:<id>, ставит dispatch). Один запрос на таблицу, не на триггер.
  function summaries(owner) {
    const rows = list(owner);
    const out = new Map(rows.map((r) => [r.id, { lastAt: null, errors: 0, badSignature: 0, ciAttempts: 0, stormAt: null }]));
    if (!rows.length) return out;
    const marks = rows.map(() => "?").join(",");
    const ids = rows.map((r) => r.id);
    for (const j of db.prepare(`SELECT trigger_id AS id, MAX(at) AS lastAt,
        SUM(CASE WHEN decision IN (${[...ERRORED].map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN decision = 'bad_signature' THEN 1 ELSE 0 END) AS badSignature
      FROM journal WHERE trigger_id IN (${marks}) GROUP BY trigger_id`).all(...[...ERRORED, ...ids])) {
      const s = out.get(j.id);
      if (s) Object.assign(s, { lastAt: j.lastAt, errors: j.errors || 0, badSignature: j.badSignature || 0 });
    }
    for (const s of db.prepare(`SELECT trigger_id AS id, MAX(ci_attempts) AS ciAttempts FROM subjects WHERE trigger_id IN (${marks}) GROUP BY trigger_id`).all(...ids)) {
      const cur = out.get(s.id);
      if (cur) cur.ciAttempts = s.ciAttempts || 0;
    }
    for (const row of db.prepare(`SELECT key, value FROM settings WHERE key IN (${marks})`).all(...ids.map((id) => `storm:${id}`))) {
      const id = String(row.key).slice("storm:".length);
      const cur = out.get(id);
      const at = safeObj(row.value)?.at;
      if (cur && Number.isFinite(at)) cur.stormAt = at;
    }
    return out;
  }
  function journalEntry(owner, entryId) {
    const row = db.prepare(`SELECT j.* FROM journal j JOIN triggers t ON t.id=j.trigger_id WHERE t.owner=? AND j.id=?`).get(owner, entryId);
    if (!row) throw new TriggerError(404, "Запись журнала не найдена");
    return { id: row.id, triggerId: row.trigger_id, eventKey: row.event_key, at: row.at, kind: row.kind, repo: row.repo, number: row.number, actor: row.actor, decision: row.decision, reason: row.reason, workflowId: row.workflow_id, via: row.via, eventJson: row.event_json ? safeObj(row.event_json) : null };
  }

  // --- subjects (что уже идёт / в очереди / попытки CI) ---
  const subjectCols = "trigger_id, subject_key AS subjectKey, active_workflow_id AS activeWorkflowId, queued_event_key AS queuedEventKey, ci_attempts AS ciAttempts, last_human_sha AS lastHumanSha";
  function subjectOf(triggerId, key) {
    return db.prepare(`SELECT ${subjectCols} FROM subjects WHERE trigger_id=? AND subject_key=?`).get(triggerId, key) ?? null;
  }
  function setActive(triggerId, key, workflowId) {
    db.prepare(`INSERT INTO subjects(trigger_id, subject_key, active_workflow_id) VALUES(?,?,?)
      ON CONFLICT(trigger_id, subject_key) DO UPDATE SET active_workflow_id=excluded.active_workflow_id`).run(triggerId, key, workflowId);
  }
  function setQueued(triggerId, key, eventKey) {
    db.prepare(`INSERT INTO subjects(trigger_id, subject_key, queued_event_key) VALUES(?,?,?)
      ON CONFLICT(trigger_id, subject_key) DO UPDATE SET queued_event_key=excluded.queued_event_key`).run(triggerId, key, eventKey);
  }
  // Запуск из очереди: subject освобождается, queued-ключ берёт обработчик.
  function releaseQueued(triggerId, key) {
    db.prepare("UPDATE subjects SET queued_event_key=NULL WHERE trigger_id=? AND subject_key=?").run(triggerId, key);
  }
  function clearActive(triggerId, key) {
    db.prepare("UPDATE subjects SET active_workflow_id=NULL WHERE trigger_id=? AND subject_key=?").run(triggerId, key);
  }
  function humanCommit(triggerId, key, sha) {
    db.prepare(`INSERT INTO subjects(trigger_id, subject_key, ci_attempts, last_human_sha) VALUES(?,?,0,?)
      ON CONFLICT(trigger_id, subject_key) DO UPDATE SET ci_attempts=0, last_human_sha=excluded.last_human_sha`).run(triggerId, key, sha);
  }
  function bumpCi(triggerId, key) {
    db.prepare(`INSERT INTO subjects(trigger_id, subject_key, ci_attempts) VALUES(?,?,1)
      ON CONFLICT(trigger_id, subject_key) DO UPDATE SET ci_attempts=ci_attempts+1`).run(triggerId, key);
    return db.prepare("SELECT ci_attempts FROM subjects WHERE trigger_id=? AND subject_key=?").get(triggerId, key)?.ci_attempts ?? 1;
  }

  // --- settings (общий выключатель admin) ---
  function setting(key, fallback = null) {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? safeObj(row.value) ?? row.value : fallback;
  }
  function setSetting(key, value) {
    db.prepare(`INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));
  }

  function queuedCount(triggerId) {
    return db.prepare("SELECT COUNT(*) AS n FROM subjects WHERE trigger_id=? AND queued_event_key IS NOT NULL").get(triggerId).n;
  }
  // --- poll_cursors (1.7): etag/since по ресурсу; сдвиг после записи в inbox ---
  function cursorGet(triggerId, resource) {
    return db.prepare("SELECT etag, since FROM poll_cursors WHERE trigger_id=? AND resource=?").get(triggerId, resource) ?? null;
  }
  function cursorSet(triggerId, resource, { etag = null, since = null } = {}) {
    db.prepare(`INSERT INTO poll_cursors(trigger_id, resource, etag, since) VALUES(?,?,?,?)
      ON CONFLICT(trigger_id, resource) DO UPDATE SET etag=excluded.etag, since=excluded.since`)
      .run(triggerId, resource, etag, since);
  }

  // Для выключения с отменой: все subject триггера с идущим запуском.
  function listWithSubjects(triggerId) {
    return db.prepare(`SELECT subject_key AS subjectKey, active_workflow_id AS activeWorkflowId, queued_event_key AS queuedEventKey,
      ci_attempts AS ciAttempts, last_human_sha AS lastHumanSha FROM subjects WHERE trigger_id=?`).all(triggerId);
  }

  // Обходчик очереди (1.11): все subject всех триггеров, где есть идущий запуск
  // или отложенное событие — sweeper выпуска из очереди читает это после каждого завершения.
  function activeSubjects() {
    return db.prepare(`SELECT trigger_id AS triggerId, subject_key AS subjectKey, active_workflow_id AS activeWorkflowId,
      queued_event_key AS queuedEventKey FROM subjects WHERE active_workflow_id IS NOT NULL OR queued_event_key IS NOT NULL`).all();
  }

  return {
    create, get, getById, byKeyHash, firstByEventKey, secretFor, verifyKey, list, listAll, update, remove, setHookId, rotateSecret,
    insertDelivery, pendingDeliveries, markProcessed, gc,
    record, startedPerHour, startedPerDayForOwner, startedPerDayAll, eventsPerWindow, journal, journalEntry, summaries,
    subjectOf, setActive, setQueued, releaseQueued, clearActive, humanCommit, bumpCi, queuedCount, listWithSubjects, activeSubjects,
    cursorGet, cursorSet,
    setting, setSetting,
    close: () => { try { db.close(); } catch {} },
  };
}
