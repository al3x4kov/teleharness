// FEAT-20.6: отчёты по журналу расхода — сводка периода, чат, запуск, проект, пользователи, ходы.
// Права решает вызывающий (routes/costs.js): сюда приходит уже разрешённый userId (тенант — только
// свой; admin — null = все). Деньги — целые микродоллары; округляет только показ (кр. 17).
import { dayMonth } from "./ledger.js";
import { findPrice } from "./prices.js";

const isoDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1..12
const addDays = (day, k) => new Date(Date.parse(day + "T00:00:00Z") + k * 86_400_000).toISOString().slice(0, 10);

// {period: month|prev|30d|custom, from, to} → {kind, from, to, month|null}; границы — в поясе отчётов.
export function resolvePeriod(q, tz, now = Date.now()) {
  const today = dayMonth(now, tz).day;
  const [y, m] = today.split("-").map(Number);
  const kind = ["month", "prev", "30d", "custom"].includes(q?.period) ? q.period : isoDay(q?.from) && isoDay(q?.to) ? "custom" : "month";
  if (kind === "prev") {
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const mm = String(pm).padStart(2, "0");
    return { kind, from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(daysIn(py, pm)).padStart(2, "0")}`, month: `${py}-${mm}` };
  }
  if (kind === "30d") return { kind, from: addDays(today, -29), to: today, month: null };
  if (kind === "custom") {
    if (!isoDay(q.from) || !isoDay(q.to) || q.from > q.to) return null;
    if ((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > 3660) return null;
    const month = q.from.slice(0, 7) === q.to.slice(0, 7) && q.from.endsWith("-01") && q.to === `${q.to.slice(0, 7)}-${String(daysIn(+q.to.slice(0, 4), +q.to.slice(5, 7))).padStart(2, "0")}` ? q.from.slice(0, 7) : null;
    return { kind, from: q.from, to: q.to, month };
  }
  const mm = String(m).padStart(2, "0");
  return { kind: "month", from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(daysIn(y, m)).padStart(2, "0")}`, month: `${y}-${mm}`, today };
}

// Стоимость подписки за период: целые месяцы — полная сумма, части — пропорционально дням.
export function subscriptionCost(sub, from, to) {
  const start = sub.activeFrom > from ? sub.activeFrom : from;
  const end = sub.activeTo && sub.activeTo < to ? sub.activeTo : to;
  if (start > end) return { micro: 0, prorated: false };
  let micro = 0;
  let prorated = false;
  let cur = start;
  while (cur <= end) {
    const y = +cur.slice(0, 4);
    const m = +cur.slice(5, 7);
    const dim = daysIn(y, m);
    const monthEnd = `${cur.slice(0, 7)}-${String(dim).padStart(2, "0")}`;
    const last = monthEnd < end ? monthEnd : end;
    const days = +last.slice(8, 10) - +cur.slice(8, 10) + 1;
    if (days === dim) micro += sub.usdMonthMicro;
    else {
      micro += Math.round((sub.usdMonthMicro * days) / dim);
      prorated = true;
    }
    cur = addDays(last, 1);
  }
  return { micro, prorated };
}

const ENGINE_TITLE = { claude: "Claude", codex: "Codex", acp: "ACP", opencode: "opencode" };

export class CostReports {
  #l;
  #chatExists;
  #userName;
  #now;
  #cache = new Map();

  // chatExists(sid) → bool | null (неизвестно); userName(id) → имя | null (удалён).
  constructor({ ledger, chatExists = () => null, userName = () => null, now = Date.now }) {
    this.#l = ledger;
    this.#chatExists = chatExists;
    this.#userName = userName;
    this.#now = now;
  }

  get #db() {
    if (!this.#l.db) {
      const e = new Error("ledger-unavailable");
      e.status = 503;
      throw e;
    }
    return this.#l.db;
  }

  #where({ userId = null, project = null, from, to }) {
    const w = ["day BETWEEN ? AND ?"];
    const a = [from, to];
    if (userId) w.push("user_id = ?"), a.push(userId);
    if (project) w.push("project = ?"), a.push(project);
    return { sql: w.join(" AND "), args: a };
  }

  modelTitle(id) {
    return findPrice(this.#l.table(), id)?.title ?? id;
  }

  // Сводка периода (кр. 5). withSubs — admin без фильтра по пользователю: подписки и «сэкономлено».
  summary({ period, userId = null, project = null, withSubs = false }) {
    const key = JSON.stringify([period.from, period.to, userId, project, withSubs, this.#l.epoch]);
    const hit = this.#cache.get(key);
    if (hit && this.#now() - hit.at < 30_000) return hit.value;
    const db = this.#db;
    const { sql, args } = this.#where({ userId, project, from: period.from, to: period.to });
    const tot = db.prepare(`SELECT COUNT(*) AS turns,
      COALESCE(SUM(CASE WHEN billing = 'subscription' THEN cost_micro END), 0) AS sub,
      COALESCE(SUM(CASE WHEN billing = 'api' THEN cost_micro END), 0) AS api,
      SUM(CASE WHEN billing = 'subscription' AND cost_micro IS NOT NULL THEN 1 ELSE 0 END) AS subTurns,
      SUM(CASE WHEN billing = 'api' AND cost_micro IS NOT NULL THEN 1 ELSE 0 END) AS apiTurns,
      SUM(CASE WHEN billing = 'free' THEN 1 ELSE 0 END) AS freeTurns,
      SUM(CASE WHEN price_source = 'engine' THEN 1 ELSE 0 END) AS engineTurns,
      SUM(priced_late) AS lateTurns, SUM(long_ctx) AS longTurns, SUM(partial) AS partialTurns
      FROM usage_turns WHERE ${sql}`).get(...args);
    const noData = { count: 0, byReason: {} };
    for (const r of db.prepare(`SELECT no_data_reason AS r, COUNT(*) AS c FROM usage_turns WHERE ${sql} AND cost_micro IS NULL GROUP BY no_data_reason`).all(...args)) {
      noData.byReason[r.r ?? "no-price"] = r.c;
      noData.count += r.c;
    }
    const byEngine = db.prepare(`SELECT engine, COALESCE(SUM(cost_micro), 0) AS micro, COUNT(*) AS turns, SUM(cost_micro IS NULL) AS noData FROM usage_turns WHERE ${sql} GROUP BY engine ORDER BY micro DESC`).all(...args)
      .map((r) => ({ ...r, title: ENGINE_TITLE[r.engine] ?? r.engine }));
    const byModel = db.prepare(`SELECT model_id AS model, provider_id AS provider, billing, COALESCE(SUM(cost_micro), 0) AS micro, COUNT(*) AS turns, SUM(cost_micro IS NULL) AS noData, MAX(no_data_reason = 'no-price') AS noPrice FROM usage_turns WHERE ${sql} GROUP BY model_id, billing ORDER BY micro DESC LIMIT 50`).all(...args)
      .map((r) => ({ ...r, title: this.modelTitle(r.model), noPrice: Boolean(r.noPrice) }));
    const byProject = db.prepare(`SELECT project, COALESCE(SUM(cost_micro), 0) AS micro, COUNT(*) AS turns, COUNT(DISTINCT run_id) AS runs FROM usage_turns WHERE ${sql} GROUP BY project ORDER BY micro DESC LIMIT 20`).all(...args);
    // Топ чатов: субагенты и служебные — внутри родителя
    const topChats = db.prepare(`SELECT COALESCE(parent_sid, sid) AS sid, MAX(title) AS title, COALESCE(SUM(cost_micro), 0) AS micro, COUNT(*) AS turns, SUM(cost_micro IS NULL) AS noData, MAX(kind = 'step') AS step FROM usage_turns WHERE ${sql} AND sid IS NOT NULL GROUP BY COALESCE(parent_sid, sid) ORDER BY micro DESC LIMIT 10`).all(...args)
      .map((r) => ({ ...r, step: Boolean(r.step), deleted: this.#chatExists(r.sid) === false }));
    const runs = db.prepare(`SELECT run_id AS runId, COALESCE(SUM(cost_micro), 0) AS micro, COUNT(*) AS turns, MAX(attempt) AS maxAttempt FROM usage_turns WHERE ${sql} AND run_id IS NOT NULL GROUP BY run_id ORDER BY micro DESC LIMIT 20`).all(...args);
    const byDay = db.prepare(`SELECT day, COALESCE(SUM(cost_micro), 0) AS micro, SUM(cost_micro IS NULL) AS noData, COUNT(*) AS turns FROM usage_turns WHERE ${sql} GROUP BY day ORDER BY day`).all(...args);
    let subscriptions = null;
    if (withSubs) {
      const list = this.#l.subscriptions().items;
      const items = list.map((s) => {
        const c = subscriptionCost(s, period.from, period.to);
        const ph = s.providers.map(() => "?").join(",");
        const api = db.prepare(`SELECT COALESCE(SUM(cost_micro), 0) AS m FROM usage_turns WHERE ${sql} AND billing = 'subscription' AND provider_id IN (${ph})`).get(...args, ...s.providers).m;
        return { id: s.id, title: s.title, providers: s.providers, usdMonthMicro: s.usdMonthMicro, activeFrom: s.activeFrom, costMicro: c.micro, prorated: c.prorated, apiMicro: api, savedMicro: api - c.micro, payback: c.micro > 0 ? Math.round((api / c.micro) * 10) / 10 : null };
      });
      const cost = items.reduce((a, b) => a + b.costMicro, 0);
      subscriptions = {
        configured: list.length > 0,
        costMicro: cost,
        prorated: items.some((i) => i.prorated),
        items,
        savedMicro: list.length ? tot.sub - cost : null,
        payback: cost > 0 ? Math.round((tot.sub / cost) * 10) / 10 : null,
      };
    }
    const budget = userId ? this.budget(userId) : null;
    const value = {
      period,
      tz: this.#l.tz(),
      priceVersion: this.#l.priceVersion(),
      totals: { turns: tot.turns, subscriptionMicro: tot.sub, apiPaidMicro: tot.api, subscriptionTurns: tot.subTurns ?? 0, apiTurns: tot.apiTurns ?? 0, freeTurns: tot.freeTurns ?? 0, engineEstimateTurns: tot.engineTurns ?? 0, pricedLateTurns: tot.lateTurns ?? 0, longCtxTurns: tot.longTurns ?? 0, partialTurns: tot.partialTurns ?? 0 },
      noData,
      subscriptions,
      byEngine,
      byModel,
      byProject,
      topChats,
      runs,
      byDay,
      budget,
    };
    this.#cache.set(key, { at: this.#now(), value });
    if (this.#cache.size > 200) this.#cache.delete(this.#cache.keys().next().value);
    return value;
  }

  budget(userId) {
    const budget = this.#l.budgetOf(userId);
    if (!budget) return null;
    const month = dayMonth(this.#now(), this.#l.tz()).month;
    const spent = this.#l.monthSpent(userId, month);
    return { usdMonthMicro: budget, spentMicro: spent, pct: Math.floor((spent * 100) / budget), month };
  }

  // Строки ходов чата (сам чат + субагенты + служебные; parent_sid = чат).
  owners(where, args) {
    return this.#db.prepare(`SELECT DISTINCT user_id AS u FROM usage_turns WHERE ${where}`).all(...args).map((r) => r.u);
  }

  // Лист «Расход чата» (кр. 6).
  chat(sid) {
    const db = this.#db;
    const rows = db.prepare("SELECT * FROM usage_turns WHERE sid = ? OR parent_sid = ? ORDER BY completed_at").all(sid, sid);
    const out = { sid, turns: 0, totalMicro: 0, priced: 0, byModel: [], subagents: { count: 0, micro: 0, noData: 0 }, service: { count: 0, micro: 0, noData: 0 }, tokens: { in: 0, out: 0, reason: 0, cacheRead: 0, w5m: 0, w1h: 0 }, noData: { count: 0, byReason: {}, last: null }, partialTurns: 0, longCtxTurns: 0, pricedLateTurns: 0, engineEstimateTurns: 0, billing: null, cacheSavingPct: null, priceVersion: this.#l.priceVersion() };
    const models = new Map();
    let full = 0;
    let actual = 0;
    const table = this.#l.table();
    for (const r of rows) {
      out.turns += 1;
      const isSub = r.kind === "subagent" || (r.parent_sid === sid && r.kind !== "service");
      const bucket = r.kind === "service" ? out.service : isSub ? out.subagents : null;
      if (bucket) bucket.count += 1;
      if (r.cost_micro == null) {
        out.noData.count += 1;
        const why = r.no_data_reason ?? "no-price";
        out.noData.byReason[why] = (out.noData.byReason[why] ?? 0) + 1;
        out.noData.last = { reason: why, at: r.completed_at, model: r.model_id, engine: r.engine };
        if (bucket) bucket.noData += 1;
      } else {
        out.totalMicro += r.cost_micro;
        out.priced += 1;
        if (bucket) bucket.micro += r.cost_micro;
      }
      out.billing = out.billing ?? r.billing;
      out.partialTurns += r.partial;
      out.longCtxTurns += r.long_ctx;
      out.pricedLateTurns += r.priced_late;
      if (r.price_source === "engine") out.engineEstimateTurns += 1;
      for (const k of ["in", "out", "reason"]) out.tokens[k] += r["t_" + k];
      out.tokens.cacheRead += r.t_cache_read;
      out.tokens.w5m += r.t_cache_w5m;
      out.tokens.w1h += r.t_cache_w1h;
      const byModel = JSON.parse(r.by_model || "[]");
      // по моделям: сумма хода делится по моделям пропорционально их цене по прайсу (у хода одна сумма)
      const parts = byModel.map((e) => {
        const p = findPrice(table, e.model);
        if (p && !p.free) {
          const u = p.usdPerMTok;
          full += (e.in + e.cacheRead + e.w5m + e.w1h) * (u.input ?? 0);
          actual += e.in * (u.input ?? 0) + e.cacheRead * (u.cacheRead ?? 0) + e.w5m * (u.cacheWrite5m ?? 0) + e.w1h * (u.cacheWrite1h ?? 0);
        }
        return { e, w: p && !p.free ? e.in * (p.usdPerMTok.input ?? 0) + e.out * (p.usdPerMTok.output ?? 0) + e.cacheRead * (p.usdPerMTok.cacheRead ?? 0) + e.w5m * (p.usdPerMTok.cacheWrite5m ?? 0) + e.w1h * (p.usdPerMTok.cacheWrite1h ?? 0) : 0 };
      });
      const wsum = parts.reduce((a, b) => a + b.w, 0);
      if (!parts.length) parts.push({ e: { model: r.model_id }, w: 0 });
      parts.forEach(({ e, w }, i) => {
        // Claude: модели хода сверх основной — субагенты на других моделях (modelUsage, P-3)
        if (i > 0 && !bucket && (r.engine === "claude" || r.engine === "codex") && e.model !== r.model_id) {
          out.subagents.count += 1;
          if (r.cost_micro != null && wsum > 0) out.subagents.micro += Math.round((r.cost_micro * w) / wsum);
        }
        const id = e.model || r.model_id || "?";
        const m = models.get(id) ?? { model: id, title: this.modelTitle(id), engine: r.engine, provider: r.provider_id, micro: 0, turns: 0, noData: 0, tokens: 0 };
        m.turns += 1;
        if (r.cost_micro == null) m.noData += 1;
        else m.micro += wsum > 0 ? Math.round((r.cost_micro * w) / wsum) : parts.length === 1 ? r.cost_micro : 0;
        m.tokens += (e.in ?? 0) + (e.out ?? 0) + (e.cacheRead ?? 0) + (e.w5m ?? 0) + (e.w1h ?? 0);
        models.set(id, m);
      });
    }
    out.byModel = [...models.values()].sort((a, b) => b.micro - a.micro);
    out.cacheSavingPct = full > 0 ? Math.round((1 - actual / full) * 100) : null;
    return out;
  }

  // Карточка «Расход запуска» (кр. 7): шаги и попытки отдельными строками.
  run(runId) {
    const rows = this.#db.prepare("SELECT step_id, attempt, sid, status, model_id, engine, cost_micro, no_data_reason, completed_at FROM usage_turns WHERE run_id = ? ORDER BY completed_at").all(runId);
    const steps = new Map();
    let total = 0;
    let noData = 0;
    for (const r of rows) {
      const k = `${r.step_id}#${r.attempt ?? 1}`;
      const s = steps.get(k) ?? { stepId: r.step_id, attempt: r.attempt ?? 1, sid: r.sid, model: r.model_id, title: this.modelTitle(r.model_id), engine: r.engine, status: r.status, micro: 0, turns: 0, noData: 0 };
      s.turns += 1;
      s.status = r.status;
      if (r.cost_micro == null) s.noData += 1, noData += 1;
      else s.micro += r.cost_micro, total += r.cost_micro;
      steps.set(k, s);
    }
    const list = [...steps.values()];
    const attempts = {};
    for (const s of list) attempts[s.stepId] = Math.max(attempts[s.stepId] ?? 0, s.attempt);
    return { runId, totalMicro: total, turns: rows.length, noData, retries: list.filter((s) => s.attempt > 1).length, steps: list.map((s) => ({ ...s, retried: attempts[s.stepId] > 1 })) };
  }

  // Строка на странице проекта (кр. 7; P-17).
  project({ project, userId = null }) {
    const p = resolvePeriod({ period: "month" }, this.#l.tz(), this.#now());
    const { sql, args } = this.#where({ userId, project, from: p.from, to: p.to });
    const r = this.#db.prepare(`SELECT COALESCE(SUM(cost_micro), 0) AS micro, COUNT(*) AS turns, COUNT(DISTINCT run_id) AS runs, SUM(cost_micro IS NULL) AS noData FROM usage_turns WHERE ${sql}`).get(...args);
    return { project, month: p.month, tz: this.#l.tz(), ...r, noData: r.noData ?? 0 };
  }

  // «По пользователям» (admin; P-8, N-16).
  users(period) {
    const rows = this.#db.prepare("SELECT user_id AS userId, MAX(user_name) AS userName, COALESCE(SUM(cost_micro), 0) AS micro, COUNT(*) AS turns, SUM(cost_micro IS NULL) AS noData FROM usage_turns WHERE day BETWEEN ? AND ? GROUP BY user_id ORDER BY micro DESC").all(period.from, period.to);
    const total = rows.reduce((a, b) => a + b.micro, 0);
    return rows.map((r) => {
      const name = r.userId ? this.#userName(r.userId) : null;
      return { ...r, name: name ?? r.userName ?? r.userId ?? "—", deleted: Boolean(r.userId) && name == null, share: total > 0 ? Math.round((r.micro * 1000) / total) / 10 : 0, budget: r.userId ? this.budget(r.userId) : null };
    });
  }

  // Ходы постранично (cursor = completed_at:engine:answer_id).
  turns({ period, userId = null, project = null, cursor = null, limit = 100 }) {
    const { sql, args } = this.#where({ userId, project, from: period.from, to: period.to });
    let extra = "";
    if (cursor) {
      const [at, ...rest] = String(cursor).split(":");
      extra = " AND (completed_at < ? OR (completed_at = ? AND engine || ':' || answer_id < ?))";
      args.push(Number(at), Number(at), rest.join(":"));
    }
    const rows = this.#db.prepare(`SELECT * FROM usage_turns WHERE ${sql}${extra} ORDER BY completed_at DESC, engine || ':' || answer_id DESC LIMIT ?`).all(...args, limit + 1);
    const more = rows.length > limit;
    const list = rows.slice(0, limit);
    return { items: list.map(publicTurn), cursor: more ? `${list.at(-1).completed_at}:${list.at(-1).engine}:${list.at(-1).answer_id}` : null };
  }

  // Итератор строк для CSV — по возрастанию времени.
  // Страницы по 1 000 строк по ключу (completed_at, engine, answer_id): между страницами поток ждёт
  // клиента, а открытого курсора SQLite на время выгрузки нет (записи ходов идут как обычно).
  *iterate({ period, userId = null, project = null, page = 1000 }) {
    const { sql, args } = this.#where({ userId, project, from: period.from, to: period.to });
    const first = this.#db.prepare(`SELECT * FROM usage_turns WHERE ${sql} ORDER BY completed_at, engine, answer_id LIMIT ?`);
    const next = this.#db.prepare(`SELECT * FROM usage_turns WHERE ${sql} AND (completed_at > ? OR (completed_at = ? AND (engine > ? OR (engine = ? AND answer_id > ?)))) ORDER BY completed_at, engine, answer_id LIMIT ?`);
    let rows = first.all(...args, page);
    while (rows.length) {
      yield* rows;
      if (rows.length < page) return;
      const l = rows.at(-1);
      rows = next.all(...args, l.completed_at, l.completed_at, l.engine, l.engine, l.answer_id, page);
    }
  }
}

export function publicTurn(r) {
  return {
    engine: r.engine, answerId: r.answer_id, userId: r.user_id, sid: r.sid, parentSid: r.parent_sid, title: r.title, project: r.project, kind: r.kind,
    runId: r.run_id, stepId: r.step_id, attempt: r.attempt, provider: r.provider_id, model: r.model_id, billing: r.billing,
    startedAt: r.started_at, completedAt: r.completed_at, day: r.day, status: r.status,
    tokens: { in: r.t_in, out: r.t_out, reason: r.t_reason, cacheRead: r.t_cache_read, w5m: r.t_cache_w5m, w1h: r.t_cache_w1h, context: r.t_context },
    costMicro: r.cost_micro, engineCostMicro: r.engine_cost_micro, priceSource: r.price_source, noDataReason: r.no_data_reason, priceVersion: r.price_version,
    pricedLate: Boolean(r.priced_late), longCtx: Boolean(r.long_ctx), partial: Boolean(r.partial), source: r.source,
  };
}
