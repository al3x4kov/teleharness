// TASK-12.18 / ADR-001 step 2: the declarative API route table.
//
// A route: { method: "GET" | ["GET","HEAD"], path: "/zai/api/x" | RegExp,
//            scope, dirDefault?, handler(ctx) }.
// The common gate runs BEFORE the handler and hands it an already allowed
// context { req, res, url, user, admin, match, dir }; a handler never reads
// the directory from the query itself.
//
// scope:
//   - "user"     — any signed-in user (the handler may refine);
//   - "admin"    — admin only → 403 {error:"admin only"};
//   - "dirQuery" — ?directory= (or dirDefault(ctx) when empty; no default →
//                  must be absolute, else 400 {error:"directory required"}),
//                  then dirAllowed → 403 {error:"outside your scope"}.
// ("none" and "session" from ADR-001 come with the auth / session groups.)
//
// A request whose method+path matches no record falls through to the legacy
// if-chain of handleApi (migration one group at a time, ADR-001 §«Переход»).
import path from "node:path";

export const SCOPES = new Set(["user", "admin", "dirQuery"]);

// method "*" = any method (the handler answers 405 itself, like the legacy
// branches that matched a path first and the method second).
function methodOk(route, method) {
  if (route.method === "*") return true;
  return Array.isArray(route.method) ? route.method.includes(method) : route.method === method;
}

export function matchRoute(table, method, pathname) {
  for (const route of table) {
    if (!methodOk(route, method)) continue;
    if (typeof route.path === "string") {
      if (route.path === pathname) return { route, match: null };
    } else {
      const m = pathname.match(route.path);
      if (m) return { route, match: m };
    }
  }
  return null;
}

// Throws on a malformed table (startup, and the «every route has a gate» test).
export function validateTable(table) {
  for (const r of table) {
    const id = `${r?.method} ${r?.path}`;
    if (!r || typeof r.handler !== "function") throw new Error(`route ${id}: no handler`);
    if (!SCOPES.has(r.scope)) throw new Error(`route ${id}: unknown scope ${r.scope}`);
    if (typeof r.path !== "string" && !(r.path instanceof RegExp)) throw new Error(`route ${id}: bad path`);
  }
  return table;
}

// → true when the table answered the request (gate refusal included).
// deps: { sendJson(res, status, obj), dirAllowed(user, dir) }.
export async function dispatchRoute(table, { req, res, url, user, admin }, deps) {
  const hit = matchRoute(table, req.method, url.pathname);
  if (!hit) return false;
  const { route, match } = hit;
  const ctx = { req, res, url, user, admin, match, dir: null };
  if (route.scope === "admin" && !admin) {
    deps.sendJson(res, 403, { error: "admin only" });
    return true;
  }
  if (route.scope === "dirQuery") {
    const fallback = typeof route.dirDefault === "function" ? route.dirDefault(ctx) : null;
    const dir = url.searchParams.get("directory") || fallback || "";
    if (!fallback && !path.isAbsolute(dir)) {
      deps.sendJson(res, 400, { error: "directory required" });
      return true;
    }
    if (!deps.dirAllowed(user, dir)) {
      deps.sendJson(res, 403, { error: "outside your scope" });
      return true;
    }
    ctx.dir = dir;
  }
  await route.handler(ctx);
  return true;
}
