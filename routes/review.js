// FEAT-20.1: /teleharness/api/review/* и /teleharness/api/plan/* — экран ревью, комментарии,
// «Вернуть агенту», «Принять», решения по плану (openspec phone-review, design «API»).
//   GET    /teleharness/api/review?filter=all|chats|runs|returned&cursor=&accepted=1
//   GET    /teleharness/api/review/chat/:sid            → {review: summary|null, plans:[…]} (плашка и карточки плана в чате)
//   GET    /teleharness/api/review/:id                  → пункт целиком (+ stale, busy)
//   GET    /teleharness/api/review/:id/diff?file=&rev=&since=&full=1&raw=1
//   POST   /teleharness/api/review/:id/preview  {general, lang}  → текст сообщения агенту
//   POST   /teleharness/api/review/:id/refresh
//   PUT    /teleharness/api/review/:id/comments/:cid {…, version} | DELETE …?version=
//   POST   /teleharness/api/review/:id/viewed   {file, viewed}
//   POST   /teleharness/api/review/:id/send     {key, revision, general, lang}
//   POST   /teleharness/api/review/:id/accept   {key, revision}
//   POST   /teleharness/api/review/:id/dismiss  {key}
//   POST   /teleharness/api/plan/:id/(approve|revise|reject) {key, text?, comment?}
// Пункты лежат в хранилище владельца: чужой и несуществующий id — один и тот же
// 404 «Ревью недоступно» (без названия чата); admin пунктов тенантов не видит.
import { ReviewError, isPlanId, isReviewId } from "../lib/review.js";
import { GitError } from "../lib/git.js";

const NOT_FOUND = { error: "Ревью недоступно", code: "not-found" };
const SID_RE = /^[A-Za-z0-9_.-]{1,200}$/;

// deps: sendJson, readJsonBody, reviews (ReviewService), untrusted(admin, dir) → bool,
//   planRun({user, admin, plan, action, text, edited, comment}) → {ok, status, error, engine, model}.
export function reviewRoutes(deps) {
  const { sendJson, reviews } = deps;
  const fail = (res, err) => {
    if (err instanceof ReviewError) return sendJson(res, err.status, { error: err.message, code: err.code, ...err.extra });
    if (err instanceof GitError) return sendJson(res, err.status, { error: err.message });
    deps.errLog?.("review", err);
    return sendJson(res, 500, { error: "Ошибка сервера ревью" });
  };
  const body = async (req) => {
    const b = await deps.readJsonBody(req, 256 * 1024);
    return b && typeof b === "object" && !Array.isArray(b) ? b : null;
  };
  const untrustedOf = (user, admin, id) => deps.untrusted(admin, reviews.store.item(user.id, id)?.dir ?? null);
  const idRoute = (suffix, method, fn) => ({
    method,
    path: new RegExp(`^/teleharness/api/review/(rv_[A-Za-z0-9]{12})${suffix}$`),
    scope: "user",
    handler: async (ctx) => {
      const id = ctx.match[1];
      if (!isReviewId(id) || !reviews.store.item(ctx.user.id, id)) return sendJson(ctx.res, 404, NOT_FOUND);
      try {
        return await fn(ctx, id);
      } catch (err) {
        return fail(ctx.res, err);
      }
    },
  });

  return [
    {
      method: "GET",
      path: "/teleharness/api/review",
      scope: "user",
      handler: ({ res, url, user }) => {
        const filter = ["all", "chats", "runs", "returned"].includes(url.searchParams.get("filter")) ? url.searchParams.get("filter") : "all";
        return sendJson(res, 200, reviews.list(user.id, { filter, cursor: url.searchParams.get("cursor"), accepted: url.searchParams.get("accepted") === "1" }));
      },
    },
    {
      method: "GET",
      path: /^\/teleharness\/api\/review\/chat\/([^/]+)$/,
      scope: "user",
      handler: ({ res, user, match }) => {
        let sid;
        try {
          sid = decodeURIComponent(match[1]);
        } catch {
          return sendJson(res, 400, { error: "bad sid" });
        }
        if (!SID_RE.test(sid)) return sendJson(res, 400, { error: "bad sid" });
        const all = reviews.summaries(user.id, { all: true }).filter((s) => s.sid === sid);
        const open = reviews.store.openFor(user.id, sid);
        return sendJson(res, 200, {
          review: open ? all.find((s) => s.id === open.id) ?? null : null,
          sends: open ? open.sends.filter((s) => s.state === "sent").map((s) => ({ revision: s.revision, at: s.at, count: s.count })) : [],
          plans: reviews.plansOf(user.id, sid),
        });
      },
    },
    idRoute("", "GET", async ({ res, user, admin }, id) => sendJson(res, 200, await reviews.detail(user.id, id, { untrusted: untrustedOf(user, admin, id), admin }))),
    idRoute("/diff", "GET", async ({ res, url, user, admin }, id) => {
      const q = url.searchParams;
      const raw = q.get("raw") === "1";
      const d = await reviews.diff(user.id, id, { file: q.get("file"), rev: q.get("rev"), since: q.get("since"), full: q.get("full") === "1", raw, untrusted: untrustedOf(user, admin, id) });
      if (raw) {
        res.writeHead(200, { "content-type": "text/x-diff; charset=utf-8", "content-disposition": `attachment; filename="${String(d.file ?? "patch").split("/").pop().replace(/[^A-Za-z0-9._-]/g, "_")}.patch"`, "cache-control": "no-store" });
        return res.end(d.patch ?? "");
      }
      return sendJson(res, 200, d);
    }),
    idRoute("/preview", "POST", async ({ req, res, user }, id) => {
      const b = (await body(req)) ?? {};
      const m = reviews.message(user.id, id, { general: typeof b.general === "string" ? b.general.slice(0, 4000) : "", lang: b.lang });
      return sendJson(res, 200, m);
    }),
    idRoute("/refresh", "POST", async ({ res, user, admin }, id) => sendJson(res, 200, await reviews.refresh(user.id, id, { untrusted: untrustedOf(user, admin, id) }))),
    {
      method: ["PUT", "DELETE"],
      path: /^\/teleharness\/api\/review\/(rv_[A-Za-z0-9]{12})\/comments\/([A-Za-z0-9_-]{1,60})$/,
      scope: "user",
      handler: async ({ req, res, url, user, match }) => {
        const [id, cid] = [match[1], match[2]];
        if (!reviews.store.item(user.id, id)) return sendJson(res, 404, NOT_FOUND);
        try {
          if (req.method === "DELETE") return sendJson(res, 200, reviews.deleteComment(user.id, id, cid, url.searchParams.get("version")));
          const b = await body(req);
          if (!b) return sendJson(res, 400, { error: "bad json body" });
          return sendJson(res, 200, reviews.putComment(user.id, id, cid, b));
        } catch (err) {
          return fail(res, err);
        }
      },
    },
    idRoute("/viewed", "POST", async ({ req, res, user }, id) => {
      const b = await body(req);
      if (!b) return sendJson(res, 400, { error: "bad json body" });
      return sendJson(res, 200, reviews.setViewed(user.id, id, { file: b.file, viewed: b.viewed !== false }));
    }),
    idRoute("/send", "POST", async ({ req, res, user }, id) => {
      const b = await body(req);
      if (!b) return sendJson(res, 400, { error: "bad json body" });
      return sendJson(res, 200, await reviews.send(user.id, id, { key: b.key, revision: b.revision, general: typeof b.general === "string" ? b.general : "", lang: b.lang }));
    }),
    idRoute("/accept", "POST", async ({ req, res, user, admin }, id) => {
      const b = await body(req);
      if (!b) return sendJson(res, 400, { error: "bad json body" });
      return sendJson(res, 200, await reviews.accept(user.id, id, { key: b.key, revision: b.revision, untrusted: untrustedOf(user, admin, id) }));
    }),
    idRoute("/dismiss", "POST", async ({ req, res, user }, id) => {
      const b = await body(req);
      if (!b) return sendJson(res, 400, { error: "bad json body" });
      return sendJson(res, 200, await reviews.dismiss(user.id, id, { key: b.key }));
    }),
    {
      method: "POST",
      path: /^\/teleharness\/api\/plan\/(pl_[A-Za-z0-9]{12})\/(approve|revise|reject)$/,
      scope: "user",
      handler: async ({ req, res, user, admin, match }) => {
        const [id, action] = [match[1], match[2]];
        if (!isPlanId(id)) return sendJson(res, 404, NOT_FOUND);
        const b = await body(req);
        if (!b) return sendJson(res, 400, { error: "bad json body" });
        try {
          const out = await reviews.decide(user.id, id, { action, key: b.key, text: typeof b.text === "string" ? b.text : null, comment: typeof b.comment === "string" ? b.comment : null }, (x) => deps.planRun({ user, admin, action, ...x }));
          return sendJson(res, 200, { already: out.already, plan: out.plan });
        } catch (err) {
          if (err instanceof ReviewError && err.status === 404) return sendJson(res, 404, NOT_FOUND);
          return fail(res, err);
        }
      },
    },
  ];
}
