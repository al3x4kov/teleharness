// FEAT-20.6: журнал расхода — data/usage-ledger.sqlite (node:sqlite, WAL; zero-dep, как Temporal).
//
// Одна запись на ответ модели, ключ (engine, answer_id): повторные события, Relay и учёт истории
// обновляют запись, а не добавляют (кр. 1). Сумма — целые микродоллары по версии прайса на момент
// окончания хода (кр. 3, 17); «нет данных» — cost_micro = NULL с причиной (кр. 4). Сбой БД не
// бросает наружу: record() ловит, запоминает ошибку (кр. 16) — ход идёт как обычно.
//
// Таблицы: usage_turns, price_versions (неизменяемые), subscriptions, budgets, budget_alerts,
// step_sessions (sid → запуск/шаг/попытка — step_chats Temporal хранит только последнюю попытку),
// backfill_state, settings. Отчёты — lib/cost/report.js.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { builtinTable, cleanModel, diffTables, findPrice, isSubscriptionProvider, priceTurn, validateTable } from "./prices.js";

export class CostError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const DEFAULT_TZ = "Europe/Moscow";
export const BUDGET_THRESHOLDS = Object.freeze([80, 100]);
export const NO_DATA_REASONS = Object.freeze(["legacy", "no-price", "engine-silent", "interrupted"]);

export function validTz(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map();
// Ход относится к дню ОКОНЧАНИЯ в поясе отчётов (кр. 14): {day:"2026-12-01", month:"2026-12"}.
export function dayMonth(ms, tz = DEFAULT_TZ) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    fmtCache.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return { day, month: day.slice(0, 7) };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_turns(
  engine TEXT NOT NULL, answer_id TEXT NOT NULL,
  user_id TEXT, user_name TEXT, sid TEXT, parent_sid TEXT, title TEXT,
  project TEXT, directory TEXT,
  kind TEXT NOT NULL DEFAULT 'chat',
  run_id TEXT, step_id TEXT, attempt INTEGER,
  provider_id TEXT, model_id TEXT, billing TEXT,
  started_at INTEGER, completed_at INTEGER NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL,
  status TEXT NOT NULL,
  t_in INTEGER NOT NULL DEFAULT 0, t_out INTEGER NOT NULL DEFAULT 0, t_reason INTEGER NOT NULL DEFAULT 0,
  t_cache_read INTEGER NOT NULL DEFAULT 0, t_cache_w5m INTEGER NOT NULL DEFAULT 0, t_cache_w1h INTEGER NOT NULL DEFAULT 0,
  t_context INTEGER NOT NULL DEFAULT 0,
  by_model TEXT,
  engine_cost_micro INTEGER, engine_cost_basis TEXT,
  cost_micro INTEGER, price_source TEXT, no_data_reason TEXT,
  price_version INTEGER, priced_late INTEGER NOT NULL DEFAULT 0, long_ctx INTEGER NOT NULL DEFAULT 0, partial INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'live', updated_at INTEGER,
  PRIMARY KEY(engine, answer_id)
);
CREATE INDEX IF NOT EXISTS ut_user_day ON usage_turns(user_id, day);
CREATE INDEX IF NOT EXISTS ut_day ON usage_turns(day);
CREATE INDEX IF NOT EXISTS ut_sid ON usage_turns(sid);
CREATE INDEX IF NOT EXISTS ut_parent ON usage_turns(parent_sid);
CREATE INDEX IF NOT EXISTS ut_run ON usage_turns(run_id);
CREATE INDEX IF NOT EXISTS ut_project ON usage_turns(project, month);
CREATE INDEX IF NOT EXISTS ut_nodata ON usage_turns(no_data_reason, model_id);
CREATE TABLE IF NOT EXISTS price_versions(version INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, created_by TEXT, note TEXT, table_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, title TEXT NOT NULL, providers TEXT NOT NULL, usd_month_micro INTEGER NOT NULL, active_from TEXT NOT NULL, active_to TEXT);
CREATE TABLE IF NOT EXISTS budgets(user_id TEXT PRIMARY KEY, usd_month_micro INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS budget_alerts(user_id TEXT NOT NULL, month TEXT NOT NULL, threshold INTEGER NOT NULL, at INTEGER NOT NULL, pct INTEGER, chat_seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, month, threshold));
CREATE TABLE IF NOT EXISTS step_sessions(sid TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, attempt INTEGER NOT NULL, user_id TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS backfill_state(source TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, error TEXT, retry_at INTEGER, progress INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`;

const COLS = ["engine", "answer_id", "user_id", "user_name", "sid", "parent_sid", "title", "project", "directory", "kind", "run_id", "step_id", "attempt", "provider_id", "model_id", "billing", "started_at", "completed_at", "day", "month", "status", "t_in", "t_out", "t_reason", "t_cache_read", "t_cache_w5m", "t_cache_w1h", "t_context", "by_model", "engine_cost_micro", "engine_cost_basis", "cost_micro", "price_source", "no_data_reason", "price_version", "priced_late", "long_ctx", "partial", "source", "updated_at"];

const isoDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export class CostLedger {
  #file;
  #log;
  #now;
  #builtin;
  #tables = new Map(); // version → table
  #cur = null; // {version, created_at, created_by}
  db = null;
  error = null; // последняя ошибка журнала (кр. 16) — {message, at}
  missed = 0; // ходов не записано из-за сбоя
  epoch = 0; // растёт при каждой записи (кеш отчётов, ETag)

  constructor({ file, log = (m) => console.error(m), now = Date.now, builtin = null } = {}) {
    this.#file = file;
    this.#log = log;
    this.#now = now;
    this.#builtin = builtin;
    this.open();
  }

  get available() {
    return Boolean(this.db) && !this.error;
  }

  open() {
    try {
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      if (this.#file !== ":memory:") mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(this.#file);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;");
      db.exec(SCHEMA);
      this.db = db;
      this.error = null;
      if (!this.db.prepare("SELECT 1 FROM price_versions LIMIT 1").get()) {
        const t = this.#builtin ?? builtinTable();
        this.db.prepare("INSERT INTO price_versions VALUES(1, ?, 'builtin', ?, ?)").run(this.#now(), "встроенный прайс", JSON.stringify({ currency: "USD", models: t.models }));
      }
      this.#loadCur();
      return true;
    } catch (err) {
      this.#fail("open", err);
      return false;
    }
  }

  close() {
    try {
      this.db?.close();
    } catch {}
    this.db = null;
  }

  #fail(what, err) {
    this.error = { message: `${what}: ${String(err?.message ?? err).slice(0, 300)}`, at: this.#now() };
    this.#log(`[teleharness-cost] ledger ${what} failed: ${err?.message ?? err}`);
  }

  #need() {
    if (!this.db) throw new CostError(503, "ledger-unavailable", "Журнал расхода недоступен");
  }

  // --- настройки ---------------------------------------------------------------
  setting(key, def = null) {
    if (!this.db) return def;
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return r ? r.value : def;
  }
  #setSetting(key, value) {
    this.db.prepare("INSERT INTO settings VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
  }
  tz() {
    const t = this.setting("tz", DEFAULT_TZ);
    return validTz(t) ? t : DEFAULT_TZ;
  }
  settings() {
    return {
      tz: this.tz(),
      staleDays: Number(this.setting("stale_days", "90")) || 90,
      mismatchPct: Number(this.setting("mismatch_pct", "15")) || 15,
      version: Number(this.setting("settings_version", "1")) || 1,
    };
  }
  // Пояс отчётов: смена перестраивает day/month всех записей одной транзакцией (кр. 14; N-19).
  saveSettings(patch, { ifMatch } = {}) {
    this.#need();
    const cur = this.settings();
    if (ifMatch != null && Number(ifMatch) !== cur.version) throw new CostError(409, "conflict", "Настройки изменены в другом окне. Обновите и повторите", { version: cur.version });
    const next = { ...cur };
    if (patch.tz !== undefined) {
      if (!validTz(patch.tz)) throw new CostError(422, "invalid", "Неизвестный часовой пояс", { field: "tz" });
      next.tz = patch.tz;
    }
    for (const [k, lo, hi] of [["staleDays", 1, 3650], ["mismatchPct", 1, 1000]]) {
      if (patch[k] === undefined) continue;
      if (!Number.isInteger(patch[k]) || patch[k] < lo || patch[k] > hi) throw new CostError(422, "invalid", `Число от ${lo} до ${hi}`, { field: k });
      next[k] = patch[k];
    }
    this.db.exec("BEGIN");
    try {
      this.#setSetting("tz", next.tz);
      this.#setSetting("stale_days", next.staleDays);
      this.#setSetting("mismatch_pct", next.mismatchPct);
      this.#setSetting("settings_version", cur.version + 1);
      if (next.tz !== cur.tz) {
        const upd = this.db.prepare("UPDATE usage_turns SET day = ?, month = ? WHERE engine = ? AND answer_id = ?");
        for (const r of this.db.prepare("SELECT engine, answer_id, completed_at FROM usage_turns").iterate()) {
          const dm = dayMonth(r.completed_at, next.tz);
          upd.run(dm.day, dm.month, r.engine, r.answer_id);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.epoch += 1;
    return this.settings();
  }

  // --- прайс -------------------------------------------------------------------
  #loadCur() {
    this.#cur = this.db.prepare("SELECT version, created_at, created_by, note FROM price_versions ORDER BY version DESC LIMIT 1").get();
  }
  priceVersion() {
    return this.#cur ? { version: this.#cur.version, createdAt: this.#cur.created_at, createdBy: this.#cur.created_by } : null;
  }
  table(version = this.#cur?.version) {
    if (version == null || !this.db) return this.#builtin ?? builtinTable();
    let t = this.#tables.get(version);
    if (!t) {
      const r = this.db.prepare("SELECT table_json FROM price_versions WHERE version = ?").get(version);
      t = r ? JSON.parse(r.table_json) : { currency: "USD", models: [] };
      this.#tables.set(version, t);
    }
    return t;
  }
  versions(limit = 20) {
    this.#need();
    return this.db.prepare("SELECT version, created_at AS createdAt, created_by AS createdBy, note FROM price_versions ORDER BY version DESC LIMIT ?").all(limit);
  }

  // Новая версия прайса (правка или импорт): If-Match обязателен (кр. 8; N-10).
  savePrices(models, { ifMatch, by = null, note = null, confirmHigh = false } = {}) {
    this.#need();
    const cur = this.#cur.version;
    if (ifMatch == null || Number(ifMatch) !== cur) {
      const at = this.#cur.created_at;
      throw new CostError(409, "conflict", "Прайс изменён в другом окне. Обновите и повторите", { version: cur, at, by: this.#cur.created_by });
    }
    const table = { currency: "USD", models: Array.isArray(models) ? models : null };
    const errs = validateTable(table, { confirmHigh });
    if (errs.length) throw new CostError(422, errs.some((e) => e.code === "confirm-high") && errs.every((e) => e.code === "confirm-high") ? "confirm-high" : "invalid", errs[0].message, { errors: errs.slice(0, 50) });
    const clean = { currency: "USD", models: table.models.map(cleanModel) };
    const diff = diffTables(this.table(cur), clean);
    const version = cur + 1;
    this.db.prepare("INSERT INTO price_versions VALUES(?, ?, ?, ?, ?)").run(version, this.#now(), by, note, JSON.stringify(clean));
    this.#loadCur();
    const late = this.priceLate();
    this.epoch += 1;
    return { version, diff: { changed: diff.changed, added: diff.added, same: diff.same }, pricedLate: late };
  }

  // «Цена добавлена позже» (кр. 3; P-13): ходы no-price моделей, получивших цену, — по текущей версии.
  priceLate() {
    if (!this.db) return 0;
    const table = this.table();
    const rows = this.db.prepare("SELECT engine, answer_id, by_model, t_context FROM usage_turns WHERE no_data_reason = 'no-price'").all();
    const upd = this.db.prepare("UPDATE usage_turns SET cost_micro = ?, price_source = 'table', no_data_reason = NULL, price_version = ?, priced_late = 1, long_ctx = ?, billing = CASE WHEN ? THEN 'free' ELSE billing END, updated_at = ? WHERE engine = ? AND answer_id = ?");
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        const byModel = JSON.parse(r.by_model || "[]");
        if (!byModel.length) continue;
        const p = priceTurn(table, byModel, { context: r.t_context });
        if (p.costMicro == null) continue;
        upd.run(p.costMicro, this.#cur.version, p.longCtx ? 1 : 0, p.free ? 1 : 0, this.#now(), r.engine, r.answer_id);
        n += 1;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return n;
  }

  // Пересчёт периода по текущему прайсу (кр. 3; N-13): одна транзакция, повтор даёт тот же итог.
  recalc({ from, to, dryRun = false }) {
    this.#need();
    if (!isoDay(from) || !isoDay(to) || from > to) throw new CostError(422, "invalid", "Неверный период", { field: "period" });
    const table = this.table();
    const version = this.#cur.version;
    const rows = this.db.prepare("SELECT engine, answer_id, provider_id, by_model, t_context, cost_micro, price_source, engine_cost_micro, billing FROM usage_turns WHERE day BETWEEN ? AND ?").all(from, to);
    let before = 0;
    let after = 0;
    let turns = 0;
    const plan = [];
    for (const r of rows) {
      before += r.cost_micro ?? 0;
      const byModel = JSON.parse(r.by_model || "[]");
      // реальные траты провайдера (billing api с ценой провайдера) и ходы без токенов не пересчитываются
      if (r.price_source === "provider" || !byModel.length) {
        after += r.cost_micro ?? 0;
        continue;
      }
      const p = priceTurn(table, byModel, { context: r.t_context });
      const cost = p.costMicro ?? (isSubscriptionProvider(r.provider_id) && r.engine_cost_micro != null ? r.engine_cost_micro : null);
      const src = p.costMicro != null ? "table" : cost != null ? "engine" : null;
      after += cost ?? 0;
      turns += 1;
      plan.push([cost, src, cost == null ? "no-price" : null, version, p.longCtx ? 1 : 0, r.engine, r.answer_id]);
    }
    if (!dryRun && plan.length) {
      const upd = this.db.prepare("UPDATE usage_turns SET cost_micro = ?, price_source = ?, no_data_reason = ?, price_version = ?, long_ctx = ?, priced_late = 0, updated_at = " + this.#now() + " WHERE engine = ? AND answer_id = ?");
      this.db.exec("BEGIN");
      try {
        for (const args of plan) upd.run(...args);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      this.epoch += 1;
    }
    return { from, to, version, turns, beforeMicro: before, afterMicro: after, applied: !dryRun };
  }

  // --- запись хода -------------------------------------------------------------
  // t: {engine, answerId, userId, userName, sid, parentSid, title, project, directory, kind, runId, stepId,
  //     attempt, providerId, modelId, startedAt, completedAt, norm (normalizeAnswer), source}
  // → {row, alerts:[{threshold, pct, month, budgetMicro, spentMicro}]} | null (журнал недоступен).
  record(t) {
    if (!this.db || this.error?.fatal) {
      this.missed += 1;
      return null;
    }
    try {
      return this.#record(t);
    } catch (err) {
      this.missed += 1;
      this.#fail("record", err);
      return null;
    }
  }

  // Свежая запись после сбоя: ошибка снимается при первой удачной записи.
  #record(t) {
    const now = this.#now();
    const key = [String(t.engine), String(t.answerId)];
    const prev = this.db.prepare("SELECT source, cost_micro, price_version, user_id, run_id, step_id, attempt FROM usage_turns WHERE engine = ? AND answer_id = ?").get(...key);
    // живая запись не перетирается учётом истории
    if (prev && t.source === "backfill" && prev.source === "live") return { row: prev, alerts: [], skipped: true };
    const step = t.sid ? this.db.prepare("SELECT run_id, step_id, attempt, user_id FROM step_sessions WHERE sid = ?").get(t.sid) : null;
    const norm = t.norm;
    const completedAt = Number.isFinite(t.completedAt) ? t.completedAt : now;
    const dm = dayMonth(completedAt, this.tz());
    const table = this.table();
    const hasTokens = norm.byModel.length > 0;
    const sub = isSubscriptionProvider(t.providerId);
    let billing = sub ? "subscription" : "api";
    let cost = null;
    let src = null;
    let reason = null;
    let longCtx = 0;
    let version = null;
    if (!hasTokens) {
      if (norm.status === "error") {
        cost = 0; // ошибка без единого токена — $0, не «нет данных» (N-5)
        src = "none";
      } else if (norm.status === "interrupted" || norm.status === "crash") reason = "interrupted";
      else reason = t.source === "backfill" ? "legacy" : "engine-silent";
    } else if (!sub && norm.engineCostMicro > 0) {
      cost = norm.engineCostMicro; // реальные траты платного провайдера (P-14)
      src = "provider";
    } else {
      const p = priceTurn(table, norm.byModel, { context: norm.tokens.context, speed: norm.speed });
      if (p.costMicro != null) {
        cost = p.costMicro;
        src = "table";
        version = this.#cur?.version ?? null;
        longCtx = p.longCtx ? 1 : 0;
        if (p.free) billing = "free";
      } else if (sub && norm.engineCostMicro != null) {
        cost = norm.engineCostMicro; // запасная цена: оценка Claude Code (подпись в отчёте)
        src = "engine";
      } else reason = "no-price";
    }
    // повтор того же ответа: сумма, посчитанная раньше по своей версии, не меняется (кр. 3)
    if (prev && prev.price_version != null && src === "table") {
      cost = this.#samePrice(prev, norm, cost);
      version = prev.price_version;
    }
    const row = {
      engine: key[0],
      answer_id: key[1],
      user_id: step?.user_id ?? t.userId ?? prev?.user_id ?? null,
      user_name: t.userName ?? null,
      sid: t.sid ?? null,
      parent_sid: t.parentSid ?? null,
      title: typeof t.title === "string" ? t.title.slice(0, 200) : null,
      project: t.project ?? null,
      directory: t.directory ?? null,
      kind: step ? "step" : t.kind ?? "chat",
      run_id: step?.run_id ?? t.runId ?? null,
      step_id: step?.step_id ?? t.stepId ?? null,
      attempt: step?.attempt ?? t.attempt ?? null,
      provider_id: t.providerId ?? null,
      model_id: t.modelId ?? null,
      billing,
      started_at: Number.isFinite(t.startedAt) ? t.startedAt : null,
      completed_at: completedAt,
      day: dm.day,
      month: dm.month,
      status: norm.status,
      t_in: norm.tokens.in,
      t_out: norm.tokens.out,
      t_reason: norm.tokens.reason,
      t_cache_read: norm.tokens.cacheRead,
      t_cache_w5m: norm.tokens.w5m,
      t_cache_w1h: norm.tokens.w1h,
      t_context: norm.tokens.context,
      by_model: JSON.stringify(norm.byModel),
      engine_cost_micro: norm.engineCostMicro,
      engine_cost_basis: norm.engineCostBasis,
      cost_micro: cost,
      price_source: src,
      no_data_reason: reason,
      price_version: version,
      priced_late: 0,
      long_ctx: longCtx,
      partial: norm.partial || (norm.status !== "ok" && norm.status !== "error" && hasTokens) ? 1 : 0,
      source: t.source === "backfill" ? "backfill" : "live",
      updated_at: now,
    };
    const ph = COLS.map(() => "?").join(",");
    const upd = COLS.filter((c) => c !== "engine" && c !== "answer_id").map((c) => `${c} = excluded.${c}`).join(", ");
    this.db.prepare(`INSERT INTO usage_turns(${COLS.join(",")}) VALUES(${ph}) ON CONFLICT(engine, answer_id) DO UPDATE SET ${upd}`).run(...COLS.map((c) => row[c]));
    if (this.error && !this.error.fatal) this.error = null;
    this.epoch += 1;
    const alerts = row.user_id && cost ? this.#checkBudget(row.user_id, dm.month) : [];
    return { row, alerts };
  }

  #samePrice(prev, norm, cost) {
    const p = priceTurn(this.table(prev.price_version), norm.byModel, { context: norm.tokens.context, speed: norm.speed });
    return p.costMicro ?? cost;
  }

  // Temporal: sid шага → запуск/шаг/попытка до хода (кр. 7; N-7).
  registerStep({ sid, runId, stepId, userId = null }) {
    if (!this.db || !sid || !runId || !stepId) return null;
    try {
      const have = this.db.prepare("SELECT attempt FROM step_sessions WHERE sid = ?").get(sid);
      if (have) return have.attempt;
      const n = this.db.prepare("SELECT COUNT(*) AS c FROM step_sessions WHERE run_id = ? AND step_id = ?").get(runId, stepId).c;
      this.db.prepare("INSERT INTO step_sessions VALUES(?, ?, ?, ?, ?, ?)").run(sid, runId, stepId, n + 1, userId, this.#now());
      return n + 1;
    } catch (err) {
      this.#fail("step", err);
      return null;
    }
  }

  // --- подписки ----------------------------------------------------------------
  subscriptions() {
    this.#need();
    const list = this.db.prepare("SELECT * FROM subscriptions ORDER BY active_from, title").all().map((r) => ({ id: r.id, title: r.title, providers: JSON.parse(r.providers), usdMonthMicro: r.usd_month_micro, activeFrom: r.active_from, activeTo: r.active_to }));
    return { version: Number(this.setting("subscriptions_version", "1")) || 1, items: list };
  }
  saveSubscriptions(items, { ifMatch } = {}) {
    this.#need();
    const cur = this.subscriptions().version;
    if (ifMatch == null || Number(ifMatch) !== cur) throw new CostError(409, "conflict", "Подписки изменены в другом окне. Обновите и повторите", { version: cur });
    if (!Array.isArray(items) || items.length > 50) throw new CostError(422, "invalid", "Список подписок", { field: "items" });
    const clean = items.map((s, index) => {
      const err = (field, message) => new CostError(422, "invalid", message, { index, field });
      const title = typeof s?.title === "string" ? s.title.trim().slice(0, 80) : "";
      if (!title) throw err("title", "Заполните поле");
      // BUG-278: запись из GET приходит с usdMonthMicro — принимаем ту же форму, что отдаём.
      const usd = s.usdMonth ?? (Number.isInteger(s.usdMonthMicro) ? s.usdMonthMicro / 1e6 : undefined);
      if (typeof usd === "string" && /[^\d.,\s]/.test(usd)) throw err("usdMonth", "Укажите сумму в долларах США — прайс API в долларах");
      const v = typeof usd === "number" ? usd : Number(String(usd ?? "").replace(",", "."));
      if (usd === "" || usd == null || !Number.isFinite(v)) throw err("usdMonth", "Заполните поле");
      if (v < 0 || v > 100_000) throw err("usdMonth", "От 0 до 100 000");
      const providers = Array.isArray(s.providers) ? s.providers.filter((p) => typeof p === "string" && /^[a-z0-9._-]{1,40}$/.test(p)).slice(0, 10) : [];
      if (!providers.length) throw err("providers", "Выберите провайдера");
      if (!isoDay(s.activeFrom)) throw err("activeFrom", "Дата — ГГГГ-ММ-ДД");
      if (s.activeTo != null && s.activeTo !== "" && (!isoDay(s.activeTo) || s.activeTo < s.activeFrom)) throw err("activeTo", "Дата окончания не раньше начала");
      const id = typeof s.id === "string" && /^[a-z0-9_-]{1,40}$/i.test(s.id) ? s.id : `sub_${index}_${this.#now().toString(36)}`;
      return [id, title, JSON.stringify(providers), Math.round(v * 1e6), s.activeFrom, s.activeTo || null];
    });
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM subscriptions");
      const ins = this.db.prepare("INSERT INTO subscriptions VALUES(?, ?, ?, ?, ?, ?)");
      for (const c of clean) ins.run(...c);
      this.#setSetting("subscriptions_version", cur + 1);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.epoch += 1;
    return this.subscriptions();
  }

  // --- бюджеты -----------------------------------------------------------------
  budgets() {
    this.#need();
    const items = this.db.prepare("SELECT user_id AS userId, usd_month_micro AS usdMonthMicro FROM budgets").all();
    return { version: Number(this.setting("budgets_version", "1")) || 1, items };
  }
  budgetOf(userId) {
    if (!this.db) return null;
    return this.db.prepare("SELECT usd_month_micro AS usdMonthMicro FROM budgets WHERE user_id = ?").get(userId)?.usdMonthMicro ?? null;
  }
  saveBudget(userId, usdMonth, { ifMatch } = {}) {
    this.#need();
    const cur = this.budgets().version;
    if (ifMatch == null || Number(ifMatch) !== cur) throw new CostError(409, "conflict", "Бюджеты изменены в другом окне. Обновите и повторите", { version: cur });
    if (usdMonth === null) this.db.prepare("DELETE FROM budgets WHERE user_id = ?").run(userId);
    else {
      if (typeof usdMonth === "string" && /[^\d.,\s]/.test(usdMonth)) throw new CostError(422, "invalid", "Укажите сумму в долларах США — прайс API в долларах", { field: "usdMonth" });
      const v = typeof usdMonth === "number" ? usdMonth : Number(String(usdMonth).replace(",", "."));
      if (!Number.isFinite(v) || v <= 0 || v > 1_000_000) throw new CostError(422, "invalid", "Сумма больше 0", { field: "usdMonth" });
      this.db.prepare("INSERT INTO budgets VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET usd_month_micro = excluded.usd_month_micro").run(userId, Math.round(v * 1e6));
    }
    this.#setSetting("budgets_version", cur + 1);
    this.epoch += 1;
    return this.budgets();
  }
  monthSpent(userId, month) {
    return this.db.prepare("SELECT COALESCE(SUM(cost_micro), 0) AS s FROM usage_turns WHERE user_id = ? AND month = ? AND cost_micro IS NOT NULL").get(userId, month).s;
  }
  // Пороги 80/100 %: одно предупреждение на порог за месяц (кр. 12; N-24). → новые пересечения.
  #checkBudget(userId, month) {
    const budget = this.budgetOf(userId);
    if (!budget) return [];
    const spent = this.monthSpent(userId, month);
    const pct = Math.floor((spent * 100) / budget);
    const out = [];
    for (const th of BUDGET_THRESHOLDS) {
      if (pct < th) continue;
      const r = this.db.prepare("INSERT OR IGNORE INTO budget_alerts(user_id, month, threshold, at, pct) VALUES(?, ?, ?, ?, ?)").run(userId, month, th, this.#now(), pct);
      if (r.changes) out.push({ threshold: th, pct, month, budgetMicro: budget, spentMicro: spent });
    }
    return out;
  }
  // Предупреждение для баннера в чате: самый высокий порог месяца, ещё не показанный в чате.
  pendingBanner(userId, month) {
    if (!this.db) return null;
    const r = this.db.prepare("SELECT threshold, pct FROM budget_alerts WHERE user_id = ? AND month = ? AND chat_seen = 0 ORDER BY threshold DESC LIMIT 1").get(userId, month);
    if (!r) return null;
    const budget = this.budgetOf(userId);
    return { threshold: r.threshold, pct: budget ? Math.floor((this.monthSpent(userId, month) * 100) / budget) : r.pct, month, budgetMicro: budget };
  }
  markBannerSeen(userId, month) {
    this.#need();
    return this.db.prepare("UPDATE budget_alerts SET chat_seen = 1 WHERE user_id = ? AND month = ?").run(userId, month).changes;
  }

  // --- учёт истории ------------------------------------------------------------
  backfillState(source) {
    if (!this.db) return null;
    return this.db.prepare("SELECT * FROM backfill_state WHERE source = ?").get(source) ?? null;
  }
  setBackfill(source, patch) {
    const cur = this.backfillState(source) ?? { source, cursor: 0, total: 0, done: 0, updated_at: null, error: null, retry_at: null, progress: 0 };
    const n = { ...cur, ...patch, updated_at: this.#now() };
    this.db.prepare("INSERT INTO backfill_state VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, total = excluded.total, done = excluded.done, updated_at = excluded.updated_at, error = excluded.error, retry_at = excluded.retry_at, progress = excluded.progress")
      .run(source, n.cursor, n.total, n.done ? 1 : 0, n.updated_at, n.error ?? null, n.retry_at ?? null, n.progress ?? 0);
    return n;
  }
  allBackfill() {
    if (!this.db) return [];
    return this.db.prepare("SELECT * FROM backfill_state ORDER BY source").all();
  }
  has(engine, answerId) {
    return Boolean(this.db?.prepare("SELECT 1 FROM usage_turns WHERE engine = ? AND answer_id = ?").get(engine, answerId));
  }

  // Модели без цены (баннер admin; кр. 9): [{model, turns}].
  noPriceModels() {
    if (!this.db) return [];
    return this.db.prepare("SELECT model_id AS model, COUNT(*) AS turns FROM usage_turns WHERE no_data_reason = 'no-price' GROUP BY model_id ORDER BY turns DESC").all();
  }
  // Сверка с оценкой Claude Code за 7 дней (кр. 9; N-22): [{model, pct, engineMicro, tableMicro, turns}].
  mismatches({ days = 7, pct = this.settings().mismatchPct } = {}) {
    if (!this.db) return [];
    const since = this.#now() - days * 86_400_000;
    const table = this.table();
    const acc = new Map();
    for (const r of this.db.prepare("SELECT by_model, t_context FROM usage_turns WHERE completed_at >= ? AND engine = 'claude' AND engine_cost_micro IS NOT NULL").iterate(since)) {
      for (const e of JSON.parse(r.by_model || "[]")) {
        if (typeof e.engineCostMicro !== "number") continue;
        const p = findPrice(table, e.model);
        if (!p) continue;
        const one = priceTurn(table, [e]);
        const a = acc.get(p.id) ?? { model: p.id, title: p.title, engineMicro: 0, tableMicro: 0, turns: 0 };
        a.engineMicro += e.engineCostMicro;
        a.tableMicro += one.costMicro ?? 0;
        a.turns += 1;
        acc.set(p.id, a);
      }
    }
    return [...acc.values()].filter((a) => a.tableMicro > 0 && Math.abs(a.engineMicro - a.tableMicro) * 100 > pct * a.tableMicro).map((a) => ({ ...a, pct: Math.round(((a.engineMicro - a.tableMicro) * 100) / a.tableMicro) }));
  }
}
