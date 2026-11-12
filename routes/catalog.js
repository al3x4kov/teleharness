// TASK-12.18 / ADR-001 step 3: catalog routes — moved out of server.js
// handleApi without behaviour change (bodies verbatim; ADR-001 step 4, the
// narrowing of /agent etc., is a separate behaviour change).
//
// deps: { sendJson, errLog, usageStats, hub, claude, claudeAgents, upstream,
//         statusTtlMs, fetchSessionIndex, dirAllowed, captureResponse,
//         providerForUser, engineAllowed, proxyRequest, withQuery,
//         defaultOpts, tenantAgents, agentList, publicAgent, upstreamError,
//         hostStats, opencodeVersion, version }
import { tenantMcpView } from "../lib/policy.js";

// BUG-183: MCP statuses of ONE opencode instance (`dir`). The timeout is the
// warm-up one (120 s), never opencode's own MCP connect timeout (30 s): aborting
// during the MCP init would poison the folder (lib/instance-health.js). A 499/503
// = poisoned → heal (dispose the instance when idle) and ask again.
// null = upstream still failing.
// TASK-12.31 (SRV-29): общий бюджет на оба захода (по умолчанию 130 с вместо ~240):
// попытка получает min(warm, остаток); на вторую идём, только если остатка хватает
// на полноценную попытку (не короче MCP connect timeout + запас) — иначе null.
export async function fetchMcpStatus(deps, dir) {
  const health = deps.instanceHealth;
  const oc = deps.oc;
  const warm = health?.warmTimeoutMs ?? 120_000;
  const budget = deps.mcpBudgetMs ?? 130_000;
  const minAttempt = deps.mcpMinAttemptMs ?? 45_000;
  const started = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, deps.mcpRetryDelayMs ?? 500));
    const left = budget - (Date.now() - started);
    if (attempt && left < minAttempt) break;
    const timeoutMs = Math.max(1, Math.min(warm, left));
    try {
      let data = null;
      let status = 0;
      if (oc) {
        try {
          data = await oc.mcpStatus({ directory: dir, timeoutMs });
        } catch (err) {
          status = err?.status ?? 0;
        }
      } else {
        const r = await fetch(`${deps.upstream}/mcp?directory=${encodeURIComponent(dir)}`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = r.status;
        const text = r.ok ? await r.text() : "";
        if (text.trim()) {
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
        }
      }
      if ((status === 499 || status === 503) && health && attempt === 0) {
        await health.heal(dir);
        continue;
      }
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
      deps.errLog?.("mcp", new Error(`upstream /mcp ${status || "пустой ответ"} for ${dir}`));
    } catch (err) {
      deps.errLog?.("mcp", err);
    }
  }
  return null;
}

export function catalogRoutes(deps) {
  const { sendJson } = deps;
  const fetchMcp = (dir) => fetchMcpStatus(deps, dir);
  // RAW merged run status, cached STATUS_TTL_MS (was module state in server.js).
  let statusCache = { at: 0, data: {} };
  let statusPending = null; // SRV-30: один пересчёт на всех, кто пришёл с истёкшим кэшем
  return [
    // Authoritative per-session run status (busy/idle/retry), fanned out per
    // hub-subscribed directory and merged; RAW merge cached, tenant filtering
    // on the way out.
    {
      method: "GET",
      path: "/zai/api/status",
      scope: "user",
      handler: async ({ res, user, admin }) => {
        const { hub, claude } = deps;
        // ADR-005 п.5: the client compares this epoch with the SSE one and
        // resyncs on a portal restart even when no event has arrived yet.
        res.setHeader("x-zai-epoch", hub.epoch);
        const now = Date.now();
        if (now - statusCache.at >= deps.statusTtlMs) {
         statusPending ??= (async () => {
          const dirs = hub.directories();
          const oc = deps.oc;
          // FEAT-16.3: с клиентом — busyMap адаптера; v2 карта глобальна —
          // один вызов вместо веера по папкам (tasks 3.2).
          const maps = oc
            ? await (async () => {
                try {
                  return [await oc.busyMap({ timeoutMs: 8000 })];
                } catch (err) {
                  deps.errLog("status.fanout", err);
                  return [null];
                }
              })()
            : await Promise.all(
                dirs.map(async (d) => {
                  try {
                    const u = new URL("/session/status", deps.upstream);
                    u.searchParams.set("directory", d);
                    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
                    if (!r.ok) return null;
                    return await r.json();
                  } catch (err) {
                    deps.errLog("status.fanout", err);
                    return null;
                  }
                }),
              );
          const data = {};
          for (const mm of maps) if (mm && typeof mm === "object") Object.assign(data, mm);
          for (const [sid, pending] of Object.entries(hub.stalledSnapshot())) {
            data[sid] = { ...(data[sid] ?? { type: "idle" }), pending };
          }
          for (const [sid, since] of Object.entries(hub.busySnapshot())) {
            if (!(sid in data)) data[sid] = { type: "busy", since };
            else if (data[sid]?.type === "busy" && data[sid].since == null) data[sid] = { ...data[sid], since }; // FEAT-07.16: age of opencode turns
          }
          // BUG-13.3: claude turn liveness (started / last output / last action).
          for (const [sid, live] of Object.entries(claude.liveness())) {
            data[sid] = { ...(data[sid] ?? { type: "busy" }), since: data[sid]?.since ?? live.startedAt, live };
          }
          statusCache = { at: now, data };
         })().finally(() => {
           statusPending = null;
         });
         await statusPending;
        }
        if (admin) return sendJson(res, 200, statusCache.data);
        const index = await deps.fetchSessionIndex();
        const out = {};
        for (const [sid, st] of Object.entries(statusCache.data)) {
          if (deps.dirAllowed(user, index.get(sid) ?? null)) out[sid] = st;
        }
        return sendJson(res, 200, out);
      },
    },
    // Open permission/question requests across every subscribed directory.
    // Tenants see only asks from their own directories.
    {
      method: "GET",
      path: "/zai/api/dialogs",
      scope: "user",
      handler: async ({ res, user, admin }) => {
        const all = await deps.hub.collectDialogs();
        if (admin) return sendJson(res, 200, all);
        return sendJson(res, 200, all.filter((e) => deps.dirAllowed(user, e.directory ?? e.dir)));
      },
    },
    // /provider: upstream catalog merged with the claude models (ClaudeRunner).
    // Tenants get it filtered (BUG-12.10 / ADR-004): connected providers only,
    // the claude group only when the engine is enabled for them.
    {
      method: "GET",
      path: "/zai/api/provider",
      scope: "user",
      handler: async ({ req, res, user, admin }) => {
        const { claude, upstream } = deps;
        // v2fix2: в v2-режиме источником тела каталога служит готовая функция
        // из server.js (deps.providerCatalog — клиент адаптера + модели);
        // без неё handleProvider читает ${upstream}/provider как в v1.
        const catalogSource = deps.oc ? deps.providerCatalog ?? null : null;
        if (admin) return claude.handleProvider(req, res, upstream, { catalog: catalogSource });
        const captured = await deps.captureResponse((shim) => claude.handleProvider({ headers: {} }, shim, upstream, { catalog: catalogSource }));
        if (captured.status !== 200) return sendJson(res, captured.status === 304 ? 502 : captured.status, { error: "provider unavailable" });
        let catalog;
        try {
          catalog = JSON.parse(captured.body);
        } catch {
          return sendJson(res, 502, { error: "provider unavailable" });
        }
        return sendJson(res, 200, deps.providerForUser(catalog, { claudeAllowed: deps.engineAllowed(user, "claude") }));
      },
    },
    // FEAT-13.17: the Claude agents catalog — id/name/description only (no
    // prompt, no paths); admin only, like the claude engine itself (FEAT-13.9).
    {
      method: "*",
      path: "/zai/api/claude/agents",
      scope: "admin",
      handler: ({ req, res }) => {
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, { agents: deps.claudeAgents.publicList() });
      },
    },
    {
      method: "GET",
      path: "/zai/api/agent",
      scope: "user",
      handler: async ({ req, res, url, admin }) => {
        if (admin) {
          if (deps.oc) {
            // FEAT-16.3: v2 /api/agent (№21) — тело как у v1 /agent; ETag-кэш
            // proxyRequest в v2 не строится (см. отчёт шага).
            try {
              return sendJson(res, 200, await deps.oc.listAgents({ timeoutMs: deps.defaultOpts.timeoutMs }));
            } catch (err) {
              return deps.ocUpstreamError(res, err, "agent");
            }
          }
          return deps.proxyRequest(req, res, deps.withQuery("/agent", url.search), {
            ...deps.defaultOpts,
            cacheKey: "agent", // 60s in-memory cache + ETag
          });
        }
        // Tenants: only agents without delegation/outside files (shell is jailed, FEAT-04.9), without prompts/permission rules.
        return sendJson(res, 200, deps.tenantAgents(await deps.agentList()).map(deps.publicAgent));
      },
    },
    {
      method: "GET",
      path: "/zai/api/project",
      scope: "user",
      handler: async ({ req, res, url, user, admin }) => {
        const q = url.search;
        if (admin) {
          if (deps.oc) {
            try {
              return sendJson(res, 200, await deps.oc.listProjects({ timeoutMs: deps.defaultOpts.timeoutMs })); // №25: голый массив
            } catch (err) {
              return deps.ocUpstreamError(res, err, "project");
            }
          }
          return deps.proxyRequest(req, res, deps.withQuery("/project", q), deps.defaultOpts);
        }
        try {
          let list;
          if (deps.oc) {
            list = await deps.oc.listProjects({ timeoutMs: deps.defaultOpts.timeoutMs });
          } else {
            const r = await fetch(`${deps.upstream}/project${q}`, {
              headers: { accept: "application/json" },
              signal: AbortSignal.timeout(deps.defaultOpts.timeoutMs),
            });
            if (!r.ok) return sendJson(res, 502, { error: `upstream: ${r.status}` });
            list = await r.json();
          }
          if (!Array.isArray(list)) return sendJson(res, 200, []);
          return sendJson(res, 200, list.filter((pr) => deps.dirAllowed(user, pr?.worktree ?? pr?.directory ?? pr?.path)));
        } catch (err) {
          return deps.upstreamError(res, err, "project");
        }
      },
    },
    // MCP server statuses: admin — the whole upstream answer; a tenant —
    // only the servers its agent may use, status only (FEAT-03.21, BUG-12.10).
    {
      method: "GET",
      path: "/zai/api/mcp",
      scope: "user",
      // BUG-183: never the DEFAULT instance (no `directory` = the serve's cwd,
      // C:\Windows\System32 on prod — it got stuck after serve restarts and
      // answered 499 with an empty body): the folder the user's chats run in
      // (admin — ZAI_CHAT_DIR or an explicit ?directory=, tenant — its own
      // folder). One retry; a still-failing upstream is a readable 503.
      handler: async ({ res, url, admin, user }) => {
        const dir = (admin && url.searchParams.get("directory")) || deps.defaultDir(user, deps.chatDir);
        const data = await fetchMcp(dir);
        if (!data) return sendJson(res, 503, { error: "MCP-серверы временно недоступны: opencode не ответил. Повторите через минуту.", code: "mcp_unavailable" });
        return sendJson(res, 200, admin ? data : tenantMcpView(data));
      },
    },
    // Host stats describe the OWNER's machine: admin only (BUG-12.10).
    {
      method: "GET",
      path: "/zai/api/host",
      scope: "admin",
      handler: async ({ res }) => {
        const data = await deps.hostStats();
        if (!data) return sendJson(res, 503, { error: "host stats unavailable" });
        return sendJson(res, 200, data);
      },
    },
    // «О приложении» for every role (ISSUE-008): versions only, nothing about
    // the owner's machine.
    {
      method: "GET",
      path: "/zai/api/about",
      scope: "user",
      handler: async ({ res }) => {
        let oc = null;
        let harness = {};
        try {
          oc = await deps.opencodeVersion();
        } catch {}
        // BUG-143: harness versions (OmO, Claude Code) for «О приложении»
        try {
          harness = (await deps.harnessVersions?.()) ?? {};
        } catch {}
        return sendJson(res, 200, { version: deps.version, opencodeVersion: oc, omoVersion: harness.omoVersion ?? null, harness: harness.harness ?? null, claudeVersion: harness.claudeVersion ?? null });
      },
    },
    // FEAT-11.18 (шаг А): расход подписок по подключённым провайдерам — всем пользователям
    // (расход подписок не секретен). Тенант видит
    // карточки только тех провайдеров, чьи модели ему доступны. Ключей в ответе нет.
    {
      method: "GET",
      path: "/zai/api/subscriptions",
      scope: "user",
      handler: async ({ res, user, admin }) => {
        try {
          const captured = await deps.captureResponse((shim) => deps.claude.handleProvider({ headers: {} }, shim, deps.upstream, { catalog: deps.oc ? deps.providerCatalog ?? null : null }));
          let catalog = null;
          try {
            catalog = captured.status === 200 ? JSON.parse(captured.body) : null;
          } catch {}
          if (!catalog) return sendJson(res, 503, { error: "subscriptions unavailable" });
          const visible = admin ? catalog : deps.providerForUser(catalog, { claudeAllowed: deps.engineAllowed(user, "claude") });
          const connected = Array.isArray(visible?.connected) ? visible.connected : [];
          return sendJson(res, 200, { providers: await deps.subscriptionCards({ connected, zai: deps.usageStats }) });
        } catch (err) {
          deps.errLog("subscriptions", err);
          return sendJson(res, 503, { error: "subscriptions unavailable" });
        }
      },
    },
    // z.ai Coding Plan usage: the OWNER's subscription — admin only.
    {
      method: "GET",
      path: "/zai/api/usage",
      scope: "admin",
      handler: async ({ res }) => {
        try {
          return sendJson(res, 200, await deps.usageStats());
        } catch (err) {
          deps.errLog("usage", err);
          return sendJson(res, 503, { error: "usage unavailable" });
        }
      },
    },
  ];
}
