// FEAT-20.6: /teleharness/api/costs/* — расход по ценам API (openspec api-equivalent-cost, design «API»).
// /teleharness/api/usage занят квотой z.ai — здесь отдельное пространство адресов.
//   GET  /teleharness/api/costs/summary?period=month|prev|30d|custom&from&to&user&project
//   GET  /teleharness/api/costs/chat/:sid           POST /teleharness/api/costs/chat/:sid/banner-seen
//   GET  /teleharness/api/costs/run/:id             GET  /teleharness/api/costs/project?project=
//   GET  /teleharness/api/costs/turns?…&cursor      GET  /teleharness/api/costs/export.csv?…&lang&nodata=0
//   GET  /teleharness/api/costs/users (admin)       POST /teleharness/api/costs/backfill (admin)
//   GET|PUT /teleharness/api/costs/prices           POST /teleharness/api/costs/prices/import?dryRun=1   POST /teleharness/api/costs/recalc
//   GET|PUT /teleharness/api/costs/subscriptions    GET /teleharness/api/costs/budgets   PUT /teleharness/api/costs/budgets/:userId
//   GET|PUT /teleharness/api/costs/settings
// Права — на сервере: тенант видит только свои ходы; чужое (другой user, чужой чат/запуск, выгрузка) —
// 403 «Нет доступа к этим данным» без сумм в теле (кр. 11). Прайс/подписки/бюджеты других — admin.
// Журнал недоступен — 503 {error:"ledger-unavailable"} (кр. 16).
import { CostError } from "../lib/cost/ledger.js";
import { resolvePeriod } from "../lib/cost/report.js";
import { streamCsv } from "../lib/cost/csv.js";
import { diffTables, parseImport } from "../lib/cost/prices.js";

const DENY = { error: "Нет доступа к этим данным", code: "forbidden" };
const SID_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const RUN_RE = /^[A-Za-z0-9_.:@-]{1,200}$/;
const USER_RE = /^[A-Za-z0-9_.-]{1,80}$/;

// deps: sendJson, readJsonBody, readBody, ledger, reports, backfill, dirAllowed(user, dir), userName(id),
//   errLog, now
export function costRoutes(deps) {
  const { sendJson, ledger, reports } = deps;
  const now = () => (deps.now ? deps.now() : Date.now());
  const fail = (res, err) => {
    if (err instanceof CostError) return sendJson(res, err.status, { error: err.message, code: err.code, ...err.extra });
    if (err?.status === 503 || !ledger.db) return sendJson(res, 503, { error: "ledger-unavailable", message: "Журнал расхода недоступен" });
    deps.errLog?.("costs", err);
    return sendJson(res, 500, { error: "Ошибка учёта расхода" });
  };
  const wrap = (fn) => async (ctx) => {
    try {
      if (!ledger.db) return sendJson(ctx.res, 503, { error: "ledger-unavailable", message: ctx.admin ? "Журнал расхода недоступен" : "Расходы временно недоступны" });
      return await fn(ctx);
    } catch (err) {
      return fail(ctx.res, err);
    }
  };
  // Кого смотрим: тенант — только себя (?user= чужой → 403); admin — ?user= или всех (null).
  const scopeUser = (ctx) => {
    const asked = ctx.url.searchParams.get("user");
    if (asked && !USER_RE.test(asked)) return { deny: true };
    if (!ctx.admin) return asked && asked !== ctx.user.id ? { deny: true } : { userId: ctx.user.id };
    return { userId: asked || null };
  };
  const periodOf = (url) => {
    const q = Object.fromEntries(["period", "from", "to"].map((k) => [k, url.searchParams.get(k)]));
    return resolvePeriod(q, ledger.tz(), now());
  };
  const projectOf = (ctx) => {
    const p = ctx.url.searchParams.get("project");
    if (!p) return { project: null };
    if (p.length > 1000) return { bad: true };
    if (!ctx.admin && !deps.dirAllowed(ctx.user, p)) return { deny: true };
    return { project: p };
  };
  const ledgerState = (admin) => ({
    ok: !ledger.error,
    error: ledger.error ? (admin ? ledger.error.message : "unavailable") : null,
    missed: admin ? ledger.missed : undefined,
  });
  const body = async (req, limit = 256 * 1024) => {
    const b = await deps.readJsonBody(req, limit);
    return b && typeof b === "object" && !Array.isArray(b) ? b : null;
  };
  const ifMatch = (req, b) => {
    const h = req.headers["if-match"];
    if (h != null) return String(h).replace(/^W\//, "").replace(/"/g, "");
    return b?.version ?? null;
  };
  // Ходы чата/запуска принадлежат одному пользователю; тенант с чужой строкой → 403.
  const ownsAll = (ctx, where, args) => ctx.admin || reports.owners(where, args).every((u) => u === ctx.user.id);
  const decodeParam = (raw) => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  };

  const pricesFace = (admin) => {
    const v = ledger.priceVersion();
    if (!admin) return { version: v?.version ?? null, createdAt: v?.createdAt ?? null };
    const t = ledger.table();
    const st = ledger.settings();
    const stale = [];
    for (const m of t.models) {
      if (!m.checkedAt) continue;
      const days = Math.floor((now() - Date.parse(m.checkedAt + "T00:00:00Z")) / 86_400_000);
      if (days > st.staleDays) stale.push({ id: m.id, title: m.title, checkedAt: m.checkedAt, days });
    }
    return { ...v, models: t.models, versions: ledger.versions(), warnings: { noPrice: ledger.noPriceModels(), stale, mismatch: ledger.mismatches({ pct: st.mismatchPct }) }, staleDays: st.staleDays, mismatchPct: st.mismatchPct };
  };

  return [
    {
      method: "GET",
      path: "/teleharness/api/costs/summary",
      scope: "user",
      handler: wrap(async (ctx) => {
        const who = scopeUser(ctx);
        const proj = projectOf(ctx);
        if (who.deny || proj.deny) return sendJson(ctx.res, 403, DENY);
        if (proj.bad) return sendJson(ctx.res, 400, { error: "bad project" });
        const period = periodOf(ctx.url);
        if (!period) return sendJson(ctx.res, 422, { error: "Неверный период", field: "period" });
        const withSubs = ctx.admin && !who.userId;
        const s = reports.summary({ period, userId: who.userId, project: proj.project, withSubs });
        // тенант: без подписок, «сэкономлено», чужих и прайса (кр. 11; P-9)
        const out = { ...s, admin: ctx.admin, ledger: ledgerState(ctx.admin), backfill: ctx.admin ? (deps.backfill?.state() ?? []) : [] };
        if (!ctx.admin) {
          delete out.subscriptions;
          out.budget = reports.budget(ctx.user.id);
        } else if (!who.userId) out.budget = reports.budget(ctx.user.id);
        if (ctx.admin) out.noPriceModels = ledger.noPriceModels().length;
        return sendJson(ctx.res, 200, out);
      }),
    },
    {
      method: "GET",
      path: /^\/teleharness\/api\/costs\/chat\/([^/]+)$/,
      scope: "user",
      handler: wrap(async (ctx) => {
        const sid = decodeParam(ctx.match[1]);
        if (sid === null) return sendJson(ctx.res, 400, { error: "bad_id" });
        if (!SID_RE.test(sid)) return sendJson(ctx.res, 400, { error: "bad sid" });
        if (!ownsAll(ctx, "sid = ? OR parent_sid = ?", [sid, sid])) return sendJson(ctx.res, 403, DENY);
        const access = !ctx.admin && deps.chatAllowed ? await deps.chatAllowed(ctx.user, sid) : true;
        if (!access) return sendJson(ctx.res, 403, DENY);
        const out = reports.chat(sid);
        if (access === "missing" && !(out?.turns > 0)) return sendJson(ctx.res, 404, { error: "not found" });
        const month = resolvePeriod({ period: "month" }, ledger.tz(), now()).month;
        out.banner = ledger.pendingBanner(ctx.user.id, month);
        out.tz = ledger.tz();
        out.ledger = ledgerState(ctx.admin);
        return sendJson(ctx.res, 200, out);
      }),
    },
    {
      method: "POST",
      path: /^\/teleharness\/api\/costs\/chat\/([^/]+)\/banner-seen$/,
      scope: "user",
      handler: wrap(async (ctx) => {
        const month = resolvePeriod({ period: "month" }, ledger.tz(), now()).month;
        return sendJson(ctx.res, 200, { ok: true, marked: ledger.markBannerSeen(ctx.user.id, month) });
      }),
    },
    {
      method: "GET",
      path: /^\/teleharness\/api\/costs\/run\/([^/]+)$/,
      scope: "user",
      handler: wrap(async (ctx) => {
        const id = decodeParam(ctx.match[1]);
        if (id === null) return sendJson(ctx.res, 400, { error: "bad_id" });
        if (!RUN_RE.test(id)) return sendJson(ctx.res, 400, { error: "bad run" });
        if (!ownsAll(ctx, "run_id = ?", [id])) return sendJson(ctx.res, 403, DENY);
        return sendJson(ctx.res, 200, reports.run(id));
      }),
    },
    {
      method: "GET",
      path: "/teleharness/api/costs/project",
      scope: "user",
      handler: wrap(async (ctx) => {
        const proj = projectOf(ctx);
        if (proj.deny) return sendJson(ctx.res, 403, DENY);
        if (!proj.project || proj.bad) return sendJson(ctx.res, 400, { error: "project required" });
        return sendJson(ctx.res, 200, reports.project({ project: proj.project, userId: ctx.admin ? null : ctx.user.id }));
      }),
    },
    {
      method: "GET",
      path: "/teleharness/api/costs/turns",
      scope: "user",
      handler: wrap(async (ctx) => {
        const who = scopeUser(ctx);
        const proj = projectOf(ctx);
        if (who.deny || proj.deny) return sendJson(ctx.res, 403, DENY);
        const period = periodOf(ctx.url);
        if (!period) return sendJson(ctx.res, 422, { error: "Неверный период", field: "period" });
        return sendJson(ctx.res, 200, reports.turns({ period, userId: who.userId, project: proj.project, cursor: ctx.url.searchParams.get("cursor") }));
      }),
    },
    {
      method: "GET",
      path: "/teleharness/api/costs/export.csv",
      scope: "user",
      handler: wrap(async (ctx) => {
        const who = scopeUser(ctx);
        const proj = projectOf(ctx);
        if (who.deny || proj.deny) return sendJson(ctx.res, 403, DENY);
        const period = periodOf(ctx.url);
        if (!period) return sendJson(ctx.res, 422, { error: "Неверный период", field: "period" });
        const lang = ctx.url.searchParams.get("lang") === "en" ? "en" : "ru";
        const tag = period.month ?? `${period.from}_${period.to}`;
        await streamCsv(ctx.res, reports.iterate({ period, userId: who.userId, project: proj.project }), {
          lang,
          tz: ledger.tz(),
          userName: (id) => (id ? deps.userName?.(id) ?? null : null),
          includeNoData: ctx.url.searchParams.get("nodata") !== "0",
          filename: `teleharness-usage-${tag}.csv`,
        });
      }),
    },
    {
      method: "GET",
      path: "/teleharness/api/costs/users",
      scope: "admin",
      handler: wrap(async (ctx) => {
        const period = periodOf(ctx.url);
        if (!period) return sendJson(ctx.res, 422, { error: "Неверный период", field: "period" });
        return sendJson(ctx.res, 200, { period, tz: ledger.tz(), users: reports.users(period) });
      }),
    },
    {
      method: "POST",
      path: "/teleharness/api/costs/backfill",
      scope: "admin",
      handler: wrap(async (ctx) => {
        void deps.backfill?.start({ force: true });
        return sendJson(ctx.res, 202, { ok: true, backfill: deps.backfill?.state() ?? [] });
      }),
    },
    {
      method: ["GET", "PUT"],
      path: "/teleharness/api/costs/prices",
      scope: "user",
      handler: wrap(async (ctx) => {
        if (ctx.req.method === "GET") return sendJson(ctx.res, 200, pricesFace(ctx.admin));
        if (!ctx.admin) return sendJson(ctx.res, 403, DENY);
        const b = await body(ctx.req, 1024 * 1024);
        if (!b) return sendJson(ctx.res, 400, { error: "bad body" });
        const r = ledger.savePrices(b.models, { ifMatch: ifMatch(ctx.req, b), by: ctx.user.name ?? ctx.user.id, note: typeof b.note === "string" ? b.note.slice(0, 200) : "правка", confirmHigh: b.confirmHigh === true });
        return sendJson(ctx.res, 200, { ...r, prices: pricesFace(true) });
      }),
    },
    {
      method: "POST",
      path: "/teleharness/api/costs/prices/import",
      scope: "admin",
      handler: wrap(async (ctx) => {
        const b = await body(ctx.req, 2 * 1024 * 1024);
        if (!b || typeof b.text !== "string") return sendJson(ctx.res, 400, { error: "bad body" });
        const parsed = parseImport(b.text, { confirmHigh: b.confirmHigh === true });
        if (parsed.error) return sendJson(ctx.res, 422, { error: "Файл не принят", code: "import", detail: parsed.error });
        const diff = diffTables(ledger.table(), parsed.table);
        if (ctx.url.searchParams.get("dryRun") === "1") return sendJson(ctx.res, 200, { dryRun: true, version: ledger.priceVersion()?.version, models: parsed.table.models.length, ...diff });
        // импорт дополняет прайс: новые и изменённые модели из файла, остальные остаются
        const merged = [...ledger.table().models.filter((m) => !parsed.table.models.some((n) => n.id.toLowerCase() === m.id.toLowerCase())), ...parsed.table.models];
        const r = ledger.savePrices(merged, { ifMatch: ifMatch(ctx.req, b), by: ctx.user.name ?? ctx.user.id, note: `импорт: ${String(b.filename ?? "JSON").slice(0, 80)}`, confirmHigh: b.confirmHigh === true });
        return sendJson(ctx.res, 200, { ...r, changed: diff.changed, added: diff.added, same: diff.same, prices: pricesFace(true) });
      }),
    },
    {
      method: "POST",
      path: "/teleharness/api/costs/recalc",
      scope: "admin",
      handler: wrap(async (ctx) => {
        const b = await body(ctx.req);
        if (!b) return sendJson(ctx.res, 400, { error: "bad body" });
        return sendJson(ctx.res, 200, ledger.recalc({ from: b.from, to: b.to, dryRun: b.dryRun === true }));
      }),
    },
    {
      method: ["GET", "PUT"],
      path: "/teleharness/api/costs/subscriptions",
      scope: "admin",
      handler: wrap(async (ctx) => {
        if (ctx.req.method === "GET") return sendJson(ctx.res, 200, ledger.subscriptions());
        const b = await body(ctx.req);
        if (!b) return sendJson(ctx.res, 400, { error: "bad body" });
        return sendJson(ctx.res, 200, ledger.saveSubscriptions(b.items, { ifMatch: ifMatch(ctx.req, b) }));
      }),
    },
    {
      method: "GET",
      path: "/teleharness/api/costs/budgets",
      scope: "user",
      handler: wrap(async (ctx) => {
        if (!ctx.admin) return sendJson(ctx.res, 200, { version: null, items: [], mine: deps.reports.budget(ctx.user.id) });
        const b = ledger.budgets();
        return sendJson(ctx.res, 200, { ...b, items: b.items.map((x) => ({ ...x, name: deps.userName?.(x.userId) ?? null, state: reports.budget(x.userId) })), mine: reports.budget(ctx.user.id) });
      }),
    },
    {
      method: "PUT",
      path: /^\/teleharness\/api\/costs\/budgets\/([^/]+)$/,
      scope: "admin",
      handler: wrap(async (ctx) => {
        const uid = decodeParam(ctx.match[1]);
        if (uid === null) return sendJson(ctx.res, 400, { error: "bad_id" });
        if (!USER_RE.test(uid)) return sendJson(ctx.res, 400, { error: "bad user" });
        const b = await body(ctx.req);
        if (!b || !("usdMonth" in b)) return sendJson(ctx.res, 400, { error: "bad body" });
        return sendJson(ctx.res, 200, ledger.saveBudget(uid, b.usdMonth, { ifMatch: ifMatch(ctx.req, b) }));
      }),
    },
    {
      method: ["GET", "PUT"],
      path: "/teleharness/api/costs/settings",
      scope: "user",
      handler: wrap(async (ctx) => {
        if (ctx.req.method === "GET") return sendJson(ctx.res, 200, ctx.admin ? ledger.settings() : { tz: ledger.tz() });
        if (!ctx.admin) return sendJson(ctx.res, 403, DENY);
        const b = await body(ctx.req);
        if (!b) return sendJson(ctx.res, 400, { error: "bad body" });
        return sendJson(ctx.res, 200, ledger.saveSettings(b, { ifMatch: ifMatch(ctx.req, b) }));
      }),
    },
  ];
}
