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
//         getPins, setPins, cleanPins, PINS_MAX, visibleIds(user, admin, ids),
//         createPairCode, publicUrl (FEAT-18.2),
//         getAutoRelay, setAutoRelay, cleanAutoRelay, readAutoRelay,
//         AUTO_RELAY_ORDER_MAX, autoRelayModelOk(user, model) }
// BUG-264 п.3: «Активные ходы» — отчёт хаба + открытые запросы моста разрешений
// Claude/Codex (claude.dialogs()): такой ход ждёт человека, а не «работает».
export function withBridgeDialogs(report, bridgeDialogs, now = Date.now()) {
  const by = new Map();
  for (const d of bridgeDialogs ?? []) {
    if (typeof d?.sessionID !== "string") continue;
    const cur = by.get(d.sessionID) ?? { n: 0, oldest: Infinity, dir: d.directory ?? d.dir ?? null };
    cur.n++;
    if (Number.isFinite(d.askedAt)) cur.oldest = Math.min(cur.oldest, d.askedAt);
    by.set(d.sessionID, cur);
  }
  if (!by.size) return report;
  const out = report.map((r) => {
    const b = by.get(r.sessionID);
    if (!b) return r;
    by.delete(r.sessionID);
    const oldest = Number.isFinite(b.oldest) ? Math.min(b.oldest, r.oldestDialogAt ?? Infinity) : r.oldestDialogAt;
    return { ...r, state: "dialog", dialogs: (r.dialogs ?? 0) + b.n, oldestDialogAt: oldest ?? null, stalled: false };
  });
  for (const [sid, b] of by) {
    const since = Number.isFinite(b.oldest) ? b.oldest : now;
    out.push({ sessionID: sid, dir: b.dir, state: "dialog", managed: true, since, ageMs: now - since, lastEventAt: null, silentMs: null, dialogs: b.n, oldestDialogAt: Number.isFinite(b.oldest) ? b.oldest : null, pending: null, stalled: false, incompleteAt: null });
  }
  out.sort((a, b) => a.since - b.since);
  return out;
}

export function adminRoutes(deps) {
  const { sendJson, apiError } = deps;
  return [
    {
      method: "*",
      path: "/teleharness/api/admin/users",
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
      path: /^\/teleharness\/api\/admin\/users\/([^/]+)\/token$/,
      scope: "admin",
      handler: ({ req, res, match }) => {
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        let uid;
        try {
          uid = decodeURIComponent(match[1]); // SRV-28: битый %-код — 400, как у соседнего маршрута
        } catch {
          return sendJson(res, 400, { error: "bad user id" });
        }
        try {
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
      path: /^\/teleharness\/api\/admin\/users\/([^/]+)$/,
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
      path: "/teleharness/api/admin/sessions",
      scope: "admin",
      handler: ({ res }) => sendJson(res, 200, { now: Date.now(), epoch: deps.hub.epoch, sessions: withBridgeDialogs(deps.hub.sessionsReport(), deps.bridgeDialogs?.() ?? []) }),
    },
    // TASK-12.22: garbage report (dry-run only — nothing is deleted).
    {
      method: "GET",
      path: "/teleharness/api/admin/gc",
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
      path: "/teleharness/api/admin/gc",
      scope: "admin",
      handler: async ({ res }) => {
        if (deps.gcRunning()) return sendJson(res, 409, { error: "gc sweep already running" });
        const out = await deps.gcSweep();
        if (!out) return sendJson(res, 503, { error: "gc sweep failed" });
        return sendJson(res, 200, { ...out, pendingRemovals: deps.pendingRemovals.list() });
      },
    },
    // POST /teleharness/api/auth/token {confirm:true}: rotate the caller's own token
    // (admin included — ADR-009 п.5). Every session of the user is revoked; the
    // caller gets a fresh session cookie and the new token ONCE.
    {
      method: "*",
      path: "/teleharness/api/auth/token",
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
    // FEAT-18.2: POST /teleharness/api/auth/pair — a one-time phone sign-in code for
    // the CALLER's own account (any role). Naming another user (userId in the
    // body) is refused: the admin cannot sign a phone in as a tenant. Without
    // TELEHARNESS_PUBLIC_URL nothing is minted — the screen says what to configure.
    {
      method: "*",
      path: "/teleharness/api/auth/pair",
      scope: "user",
      handler: async ({ req, res, user }) => {
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const body = await deps.readJsonBody(req, 4 * 1024);
        const asked = body?.userId ?? body?.user ?? null;
        if (asked != null && asked !== user.id) return sendJson(res, 403, { error: "код входа выпускается только для своей учётной записи" });
        if (!deps.publicUrl) return sendJson(res, 200, { configured: false, setting: "TELEHARNESS_PUBLIC_URL" });
        try {
          const { code, expiresAt } = deps.createPairCode(user.id);
          res.setHeader("cache-control", "no-store");
          return sendJson(res, 201, {
            configured: true,
            code,
            url: `${deps.publicUrl}/#/pair/${code}`,
            expiresAt: new Date(expiresAt).toISOString(),
          });
        } catch (err) {
          return apiError(res, err);
        }
      },
    },
    // FEAT-03.22: GET/PUT /teleharness/api/me/system-prompt {text} — the caller's own
    // system prompt (any role; only their own record). PUT "" clears it.
    {
      method: "*",
      path: "/teleharness/api/me/system-prompt",
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
    // FEAT-18.6: GET/PUT /teleharness/api/me/auto-relay {on, order:[{providerID, modelID}]} —
    // the caller's own «Продолжать автоматически при лимите» (any role; only their
    // own record). Off by default. PUT accepts only models available to the caller
    // (engine allowed, in its catalog) — a foreign one → 403 «model not allowed».
    {
      method: "*",
      path: "/teleharness/api/me/auto-relay",
      scope: "user",
      handler: async ({ req, res, user }) => {
        if (req.method === "GET") return sendJson(res, 200, { ...deps.readAutoRelay(deps.getAutoRelay(user.id)), max: deps.AUTO_RELAY_ORDER_MAX });
        if (req.method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
        const body = await deps.readJsonBody(req, 16 * 1024);
        if (body === null || typeof body !== "object") return sendJson(res, 400, { error: "bad json body" });
        let value;
        try {
          value = deps.cleanAutoRelay(body);
        } catch (err) {
          return sendJson(res, err.status ?? 400, { error: err.message });
        }
        for (const m of value.order) {
          if (!(await deps.autoRelayModelOk(user, m))) return sendJson(res, 403, { error: "model not allowed", model: m });
        }
        try {
          return sendJson(res, 200, { ...deps.readAutoRelay(deps.setAutoRelay(user.id, value)), max: deps.AUTO_RELAY_ORDER_MAX });
        } catch (err) {
          return apiError(res, err);
        }
      },
    },
    // BUG-177: device trace of the iOS keyboard transition (lib/kb-trace.js) —
    // numbers only, admin only, capped per day.
    {
      method: "POST",
      path: "/teleharness/api/diag/kb",
      scope: "admin",
      handler: async ({ req, res }) => {
        const body = await deps.readJsonBody(req, 160 * 1024);
        const r = deps.storeKbTrace(body);
        if (r.status === 204) { res.writeHead(204); return res.end(); }
        return sendJson(res, r.status, { error: r.error });
      },
    },
    // FEAT-01.69: GET/PUT /teleharness/api/me/pins {ids} — the caller's own pinned
    // chats (any role; only their own record). The server, not the client,
    // decides what may be pinned: deps.visibleIds keeps only chats the caller
    // sees in their own list (a tenant — its scope; admin — any live chat).
    // A NEWLY added id that is foreign or unknown → 404 «chat not found»,
    // the same answer for both, so a pin never tells «exists, but not yours».
    // Ids pinned earlier that are gone now are dropped silently (clean-up).
    {
      method: "*",
      path: "/teleharness/api/me/pins",
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
    // admin CRUD for Temporal command catalog + reload + schedule discovery.
    {
      method: "*",
      path: "/teleharness/api/admin/temporal-commands",
      scope: "admin",
      handler: async ({ req, res, user }) => {
        if (!deps.commandCatalog) return sendJson(res, 503, { error: "Каталог команд недоступен" });
        if (req.method === "GET") return sendJson(res, 200, deps.commandCatalog.listAdmin());
        if (req.method === "POST") {
          const body = await deps.readJsonBody(req, deps.bodyLimit ?? 128 * 1024);
          if (body === null || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "bad json body" });
          try {
            const created = deps.commandCatalog.create(body);
            deps.auditCommand?.({ event: "temporal.command.catalog", action: "create", user: user?.id, role: user?.role, commandId: created.id, kind: created.kind });
            return sendJson(res, 201, created);
          } catch (err) {
            if (err?.status) return sendJson(res, err.status, { error: err.message, ...(err.errors ? { errors: err.errors } : {}) });
            return apiError(res, err);
          }
        }
        return sendJson(res, 405, { error: "method not allowed" });
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/admin/temporal-commands/reload",
      scope: "admin",
      handler: ({ res, user }) => {
        if (!deps.commandCatalog) return sendJson(res, 503, { error: "Каталог команд недоступен" });
        const result = deps.commandCatalog.reload();
        deps.auditCommand?.({ event: "temporal.command.catalog", action: "reload", user: user?.id, role: user?.role, ok: result.ok, count: result.items?.length ?? 0 });
        if (!result.ok) {
          return sendJson(res, 422, { error: "Каталог команд повреждён — проверьте temporal-commands.json", errors: result.errors });
        }
        return sendJson(res, 200, { ok: true, count: result.items.length, items: deps.commandCatalog.listAdmin().items });
      },
    },
    {
      method: "GET",
      path: "/teleharness/api/admin/temporal-commands/schedules",
      scope: "admin",
      handler: async ({ res, url }) => {
        if (!deps.commandCatalog) return sendJson(res, 503, { error: "Каталог команд недоступен" });
        try {
          const address = url.searchParams.get("address") || undefined;
          const namespace = url.searchParams.get("namespace") || undefined;
          return sendJson(res, 200, await deps.commandCatalog.listExternalSchedules({ address, namespace }));
        } catch (err) {
          if (err?.status) return sendJson(res, err.status, { error: err.message, ...(err.errors ? { errors: err.errors } : {}) });
          return apiError(res, err);
        }
      },
    },
    {
      method: "*",
      path: /^\/teleharness\/api\/admin\/temporal-commands\/([^/]+)$/,
      scope: "admin",
      handler: async ({ req, res, match, user }) => {
        if (!deps.commandCatalog) return sendJson(res, 503, { error: "Каталог команд недоступен" });
        let id;
        try {
          id = decodeURIComponent(match[1]);
        } catch {
          return sendJson(res, 400, { error: "bad command id" });
        }
        if (req.method === "PUT") {
          const body = await deps.readJsonBody(req, deps.bodyLimit ?? 128 * 1024);
          if (body === null || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "bad json body" });
          try {
            const updated = deps.commandCatalog.update(id, body);
            deps.auditCommand?.({ event: "temporal.command.catalog", action: "update", user: user?.id, role: user?.role, commandId: updated.id, kind: updated.kind });
            return sendJson(res, 200, updated);
          } catch (err) {
            if (err?.status) return sendJson(res, err.status, { error: err.message, ...(err.errors ? { errors: err.errors } : {}) });
            return apiError(res, err);
          }
        }
        if (req.method === "DELETE") {
          try {
            const removed = deps.commandCatalog.remove(id);
            deps.auditCommand?.({ event: "temporal.command.catalog", action: "delete", user: user?.id, role: user?.role, commandId: id });
            return sendJson(res, 200, removed);
          } catch (err) {
            if (err?.status) return sendJson(res, err.status, { error: err.message, ...(err.errors ? { errors: err.errors } : {}) });
            return apiError(res, err);
          }
        }
        return sendJson(res, 405, { error: "method not allowed" });
      },
    },
    // admin-only viewing & management of external Temporal workflows
    // (list, start, describe+history, signal, query, reset, cancel, terminate).
    {
      method: "*",
      path: "/teleharness/api/admin/temporal-workflows",
      scope: "admin",
      handler: async ({ req, res, url, user }) => {
        if (!deps.externalWorkflows) return sendJson(res, 503, { error: "Управление внешними workflow Temporal недоступно" });
        if (req.method === "GET") {
          try {
            const excludePortalRaw = url.searchParams.get("excludePortal");
            const out = await deps.externalWorkflows.listWorkflows({
              address: url.searchParams.get("address") || undefined,
              namespace: url.searchParams.get("namespace") || undefined,
              status: url.searchParams.get("status") || undefined,
              workflowType: url.searchParams.get("workflowType") || undefined,
              taskQueue: url.searchParams.get("taskQueue") || undefined,
              excludePortal: excludePortalRaw === "1" || excludePortalRaw === "true",
              query: url.searchParams.get("query") || undefined,
              limit: url.searchParams.get("limit") || undefined,
            });
            return sendJson(res, 200, out);
          } catch (err) {
            if (err?.status) return sendJson(res, err.status, { error: err.message });
            return apiError(res, err);
          }
        }
        if (req.method === "POST") {
          const body = await deps.readJsonBody(req, deps.bodyLimit ?? 128 * 1024);
          if (body === null || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "bad json body" });
          try {
            const started = await deps.externalWorkflows.startWorkflow(body);
            deps.auditCommand?.({
              event: "temporal.external",
              action: "start",
              user: user?.id,
              role: user?.role,
              workflowId: started.workflowId,
              runId: started.runId,
              workflowType: started.workflowType,
              taskQueue: started.taskQueue,
              namespace: started.namespace,
            });
            return sendJson(res, 201, started);
          } catch (err) {
            if (err?.status) return sendJson(res, err.status, { error: err.message });
            return apiError(res, err);
          }
        }
        return sendJson(res, 405, { error: "method not allowed" });
      },
    },
    {
      method: "POST",
      path: /^\/teleharness\/api\/admin\/temporal-workflows\/([^/]+)\/(signal|query|reset|cancel|terminate)$/,
      scope: "admin",
      handler: async ({ req, res, match, user }) => {
        if (!deps.externalWorkflows) return sendJson(res, 503, { error: "Управление внешними workflow Temporal недоступно" });
        let workflowId;
        try {
          workflowId = decodeURIComponent(match[1]);
        } catch {
          return sendJson(res, 400, { error: "bad workflowId" });
        }
        const action = match[2];
        const body = await deps.readJsonBody(req, deps.bodyLimit ?? 128 * 1024);
        if (body === null || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "bad json body" });
        const payload = { ...body, workflowId };
        try {
          if (action === "signal") {
            const out = await deps.externalWorkflows.signalWorkflow(payload);
            deps.auditCommand?.({
              event: "temporal.external",
              action: "signal",
              user: user?.id,
              role: user?.role,
              workflowId: out.workflowId,
              runId: out.runId,
              namespace: out.namespace,
              signalName: out.name,
            });
            return sendJson(res, 200, out);
          }
          if (action === "query") {
            const out = await deps.externalWorkflows.queryWorkflow(payload);
            deps.auditCommand?.({
              event: "temporal.external",
              action: "query",
              user: user?.id,
              role: user?.role,
              workflowId: out.workflowId,
              runId: out.runId,
              namespace: out.namespace,
              queryType: out.type,
            });
            return sendJson(res, 200, out);
          }
          if (action === "reset") {
            const out = await deps.externalWorkflows.resetWorkflow(payload);
            deps.auditCommand?.({
              event: "temporal.external",
              action: "reset",
              user: user?.id,
              role: user?.role,
              workflowId: out.workflowId,
              newRunId: out.runId,
              namespace: out.namespace,
              eventId: out.eventId,
              resetType: out.resetType,
              reason: out.reason,
            });
            return sendJson(res, 200, out);
          }
          if (action === "cancel") {
            const out = await deps.externalWorkflows.cancelWorkflow(payload);
            deps.auditCommand?.({
              event: "temporal.external",
              action: "cancel",
              user: user?.id,
              role: user?.role,
              workflowId: out.workflowId,
              runId: out.runId,
              namespace: out.namespace,
              reason: out.reason,
            });
            return sendJson(res, 200, out);
          }
          const out = await deps.externalWorkflows.terminateWorkflow(payload);
          deps.auditCommand?.({
            event: "temporal.external",
            action: "terminate",
            user: user?.id,
            role: user?.role,
            workflowId: out.workflowId,
            runId: out.runId,
            namespace: out.namespace,
            reason: out.reason,
          });
          return sendJson(res, 200, out);
        } catch (err) {
          if (err?.status) return sendJson(res, err.status, { error: err.message });
          return apiError(res, err);
        }
      },
    },
    {
      method: "GET",
      path: /^\/teleharness\/api\/admin\/temporal-workflows\/([^/]+)$/,
      scope: "admin",
      handler: async ({ res, match, url }) => {
        if (!deps.externalWorkflows) return sendJson(res, 503, { error: "Управление внешними workflow Temporal недоступно" });
        let workflowId;
        try {
          workflowId = decodeURIComponent(match[1]);
        } catch {
          return sendJson(res, 400, { error: "bad workflowId" });
        }
        try {
          const out = await deps.externalWorkflows.describeWorkflow({
            workflowId,
            runId: url.searchParams.get("runId") || undefined,
            address: url.searchParams.get("address") || undefined,
            namespace: url.searchParams.get("namespace") || undefined,
            includeHistory: url.searchParams.get("history") !== "0",
            historyLimit: url.searchParams.get("historyLimit") || undefined,
          });
          return sendJson(res, 200, out);
        } catch (err) {
          if (err?.status) return sendJson(res, err.status, { error: err.message });
          return apiError(res, err);
        }
      },
    },
  ];
}
