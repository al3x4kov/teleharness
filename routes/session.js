// TASK-12.18 / ADR-001: session routes in the table. The handler bodies are
// still functions of server.js (they share its session index, bindings,
// titler, hub and claude runner); this module declares paths, methods and
// scopes. Scope "user" everywhere: each handler keeps its own, route-specific
// session/directory resolution (admin vs tenant, claude-only chats) — a
// common «session» scope would change answers, see ADR-001 «Ход миграции».
//
// h: { binding, action, revert, patchDelete, list, create, reply, event }
export function sessionRoutes(h) {
  return [
    // PATCH {model?, agent?} — path first, 405 inside (legacy order).
    { method: "*", path: /^\/zai\/api\/session\/([^/]+)\/binding$/, scope: "user", handler: h.binding },
    // GET message / POST prompt / POST abort — path first, 405 inside.
    { method: "*", path: /^\/zai\/api\/session\/([^/]+)\/(message|prompt|abort)$/, scope: "user", handler: h.action },
    // FEAT-01.57/01.58: GET revert?messageID= (what rolls back), POST revert
    // {messageID}, POST unrevert — the prompt's scope and engine rules inside.
    { method: ["GET", "POST"], path: /^\/zai\/api\/session\/([^/]+)\/(revert|unrevert)$/, scope: "user", handler: h.revert },
    { method: ["PATCH", "DELETE"], path: /^\/zai\/api\/session\/([^/]+)$/, scope: "user", handler: h.patchDelete },
    { method: "GET", path: "/zai/api/session", scope: "user", handler: h.list },
    { method: "POST", path: "/zai/api/session", scope: "user", handler: h.create },
    { method: "POST", path: /^\/zai\/api\/(permission|question)\/([^/]+)\/reply$/, scope: "user", handler: h.reply },
    { method: "GET", path: "/zai/api/event", scope: "user", handler: h.event },
  ];
}
