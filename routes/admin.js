// TASK-12.18 / ADR-001 step 3: admin routes (tenant management, monitoring,
// gc) and the caller's own token rotation — moved out of server.js handleApi
// without behaviour change (bodies verbatim). Mutable server state (session
// index, gc flags) is read through getters so handlers see live values.
//
// deps: { sendJson, apiError, readJsonBody, bodyLimit, listUsers, createUser,
//         regenerateToken, updateUser, deleteAccount, closeUserStreams, hub,
//         fetchSessionIndex, sessionIndex(), planGc, dataDir, path,
//         runEmptyChatGc, emptyChatGcInput, gcEmptyMin, pendingRemovals,
//         ownerlessTenantDirs, lastGc(), gcRunning(), gcSweep,
//         rotateOwnToken, setAuthCookie, createSession, isHttps,
//         getSystemPrompt, setSystemPrompt, cleanSystemPrompt, SYSTEM_PROMPT_MAX,
//         getPins, setPins, cleanPins, PINS_MAX, visibleIds(user, admin, ids) }
export function adminRoutes(deps) {
  const { sendJson, apiError } = deps;
  return [
    {
      method: "*",
      path: "/zai/api/admin/users",
      scope: "admin",
      handler: async ({ req, res }) => {
        if (req.method === "GET") return sendJson(res, 200, deps.listUsers());
        if (req.method === "POST") {
          const body = await deps.readJsonBody(req, deps.bodyLimit);
          if (body === null) return sendJson(res, 400, { error: "bad json body" });
          try {
            return sendJson(res, 201, deps.createUser(body));
          } catch (err) {
            return apiError(res, err);
          }
        }
        return sendJson(res, 405, { error: "method not allowed" });
      },
    },
    {
      method: "*",
      path: /^\/zai\/api\/admin\/users\/([^/]+)\/token$/,
      scope: "admin",
      handler: ({ req, res, match }) => {
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        try {
          const uid = decodeURIComponent(match[1]);
          const token = deps.regenerateToken(uid);
          deps.closeUserStreams(uid);
          return sendJson(res, 201, { token });
        } catch (err) {
          return apiError(res, err);
        }
      },
    },
    {
      method: "*",
      path: /^\/zai\/api\/admin\/users\/([^/]+)$/,
      scope: "admin",
      handler: async ({ req, res, match }) => {
        let uid;
        try {
          uid = decodeURIComponent(match[1]);
        } catch {
          return sendJson(res, 400, { error: "bad user id" });
        }
        if (req.method === "PATCH") {
          const body = await deps.readJsonBody(req, deps.bodyLimit);
          if (body === null) return sendJson(res, 400, { error: "bad json body" });
          try {
            const out = deps.updateUser(uid, body);
            // Disabled or re-scoped: live streams must not outlive the change.
            if (body.disabled === true || body.directories !== undefined) deps.closeUserStreams(uid);
            return sendJson(res, 200, out);
          } catch (err) {
            return apiError(res, err);
          }
        }
        if (req.method === "DELETE") {
          try {
            return sendJson(res, 200, await deps.deleteAccount(uid));
          } catch (err) {
            return apiError(res, err);
          }
        }
        return sendJson(res, 405, { error: "method not allowed" });
      },
    },
    // FEAT-07.16: live turns / dialogs / unanswered prompts with ages (admin
    // monitoring card; «Остановить» reuses POST /session/:id/abort).
    {
      method: "GET",
      path: "/zai/api/admin/sessions",
      scope: "admin",
      handler: ({ res }) => sendJson(res, 200, { now: Date.now(), epoch: deps.hub.epoch, sessions: deps.hub.sessionsReport() }),
    },
    // TASK-12.22: garbage report (dry-run only — nothing is deleted).
    {
      method: "GET",
      path: "/zai/api/admin/gc",
      scope: "admin",
      handler: async ({ res, url }) => {
        await deps.fetchSessionIndex(true);
        const sessionIndex = deps.sessionIndex();
        if (sessionIndex.at === 0) return sendJson(res, 503, { error: "session index unavailable" });
        const sessions = [...sessionIndex.recById.values()];
        const report = deps.planGc({
          sessions,
          bindingsFile: deps.path.join(deps.dataDir, "session-bindings.json"),
          claudeFile: deps.path.join(deps.dataDir, "claude-sessions.json"),
          uploadMaxAgeDays: Number(url.searchParams.get("uploadDays") ?? 30) || 30,
        });
        // Empty chats: the SAME rule + threshold as the POST sweep (one source:
        // emptyChatGcInput + runEmptyChatGc), only without the delete.
        const empty = await deps.runEmptyChatGc({ ...deps.emptyChatGcInput(sessions), dryRun: true });
        return sendJson(res, 200, {
          dryRun: true,
          ...report,
          emptyChats: empty.wouldDelete,
          emptyChatsKept: empty.kept,
          emptyChatMinutes: deps.gcEmptyMin,
          pendingRemovals: deps.pendingRemovals.list(),
          ownerlessTenantDirs: deps.ownerlessTenantDirs(sessions),
          lastSweep: deps.lastGc(),
        });
      },
    },
    // Run the APPLY sweep now (empty chats + leftover tenant folders).
    {
      method: "POST",
      path: "/zai/api/admin/gc",
      scope: "admin",
      handler: async ({ res }) => {
        if (deps.gcRunning()) return sendJson(res, 409, { error: "gc sweep already running" });
        const out = await deps.gcSweep();
        if (!out) return sendJson(res, 503, { error: "gc sweep failed" });
        return sendJson(res, 200, { ...out, pendingRemovals: deps.pendingRemovals.list() });
      },
    },
    // POST /zai/api/auth/token {confirm:true}: rotate the caller's own token
    // (admin included — ADR-009 п.5). Every session of the user is revoked; the
    // caller gets a fresh session cookie and the new token ONCE.
    {
      method: "*",
      path: "/zai/api/auth/token",
      scope: "user",
      handler: async ({ req, res, user }) => {
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const body = await deps.readJsonBody(req, 16 * 1024);
        if (body?.confirm !== true) return sendJson(res, 400, { error: "нужно подтверждение: {confirm:true}" });
        try {
          const token = deps.rotateOwnToken(user.id);
          deps.closeUserStreams(user.id);
          deps.setAuthCookie(res, deps.createSession(user), deps.isHttps(req));
          return sendJson(res, 201, { token });
        } catch (err) {
          return apiError(res, err);
        }
      },
    },
    // FEAT-03.22: GET/PUT /zai/api/me/system-prompt {text} — the caller's own
    // system prompt (any role; only their own record). PUT "" clears it.
    {
      method: "*",
      path: "/zai/api/me/system-prompt",
      scope: "user",
      handler: async ({ req, res, user }) => {
        if (req.method === "GET") return sendJson(res, 200, { text: deps.getSystemPrompt(user.id), max: deps.SYSTEM_PROMPT_MAX });
        if (req.method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
        const body = await deps.readJsonBody(req, 64 * 1024);
        if (body === null || typeof body !== "object") return sendJson(res, 400, { error: "bad json body" });
        let text;
        try {
          text = deps.cleanSystemPrompt(body.text);
        } catch (err) {
          return sendJson(res, err.status ?? 400, { error: err.message });
        }
        try {
          return sendJson(res, 200, { text: deps.setSystemPrompt(user.id, text), max: deps.SYSTEM_PROMPT_MAX });
        } catch (err) {
          return apiError(res, err);
        }
      },
    },
    // BUG-177: device trace of the iOS keyboard transition (lib/kb-trace.js) —
    // numbers only, admin only, capped per day.
    {
      method: "POST",
      path: "/zai/api/diag/kb",
      scope: "admin",
      handler: async ({ req, res }) => {
        const body = await deps.readJsonBody(req, 160 * 1024);
        const r = deps.storeKbTrace(body);
        if (r.status === 204) { res.writeHead(204); return res.end(); }
        return sendJson(res, r.status, { error: r.error });
      },
    },
    // FEAT-01.69: GET/PUT /zai/api/me/pins {ids} — the caller's own pinned
    // chats (any role; only their own record). The server, not the client,
    // decides what may be pinned: deps.visibleIds keeps only chats the caller
    // sees in their own list (a tenant — its scope; admin — any live chat).
    // A NEWLY added id that is foreign or unknown → 404 «chat not found»,
    // the same answer for both, so a pin never tells «exists, but not yours».
    // Ids pinned earlier that are gone now are dropped silently (clean-up).
    {
      method: "*",
      path: "/zai/api/me/pins",
      scope: "user",
      handler: async ({ req, res, user, admin }) => {
        if (req.method === "GET") {
          const stored = deps.getPins(user.id);
          // index never loaded (upstream down since boot): the stored list
          // as is — every id in it passed this check when it was pinned.
          const ids = (await deps.visibleIds(user, admin, stored)) ?? stored;
          return sendJson(res, 200, { ids, max: deps.PINS_MAX });
        }
        if (req.method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
        const body = await deps.readJsonBody(req, 64 * 1024);
        if (body === null || typeof body !== "object") return sendJson(res, 400, { error: "bad json body" });
        let wanted;
        try {
          wanted = deps.cleanPins(body.ids);
        } catch (err) {
          return apiError(res, err);
        }
        const before = new Set(deps.getPins(user.id));
        const vis = await deps.visibleIds(user, admin, wanted);
        if (vis === null) return sendJson(res, 503, { error: "chat list unavailable" });
        const visible = new Set(vis);
        if (wanted.some((id) => !before.has(id) && !visible.has(id))) return sendJson(res, 404, { error: "chat not found" });
        try {
          return sendJson(res, 200, { ids: deps.setPins(user.id, wanted.filter((id) => visible.has(id))), max: deps.PINS_MAX });
        } catch (err) {
          return apiError(res, err);
        }
      },
    },
  ];
}
