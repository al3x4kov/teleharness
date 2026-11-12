// Фейковый upstream opencode v2 (2.2.6) — для тестов адаптера lib/oc-client.js
// (FEAT-16.3, tasks 2.1). Отдельный файл рядом с fake-opencode.mjs (v1 1.19.5).
// Контракт — docs/opencode-v2/api-map.md §0:
//   - всё под /api/*, HTTP Basic `opencode:<password>`, неверный/нет → 401 {_tag};
//   - конверт: списки/объекты {location:{directory}, data}, постраничные {data, cursor};
//   - instance-маршруты (mcp, provider, model, config, form, permission/request,
//     agent…) адресуют папку deepObject-параметром `location[directory]=`;
//     простой `?directory=` там игнорируется (как на живом v2, api-map §0.3);
//   - GET /api/session фильтрует обычным `?directory=` (api-map §1 №1);
//   - POST /api/session несёт папку в теле `location:{directory}` (№2);
//   - ошибки не-2xx — {_tag, message}; мутации (PATCH/DELETE/reply) — 204 без тела.
// Запись запросов: up.requests — {method, path, query, queryEntries, body,
// directory, authorization}. Свои маршруты/ошибки: up.route("GET","/api/mcp",
// () => ({status:500, json:{_tag:"InternalError", message:"boom"}})), как в v1.
// SSE: GET /api/event отдаёт `server.connected` первым и держит поток; up.emit(evt).
import http from "node:http";

export async function startFakeOpencodeV2({
  password = "oc2-secret",
  defaultDirectory = "C:\\Windows\\System32", // куда v2 смотрит без location (как живой :4099)
  sessions = [],
  active = {}, // {ses_x: {type:"running"}}
  permissions = [],
  forms = [],
  mcp = [],
  agents = [],
  providers = [],
  models = [],
  modelDefault = null,
  projects = [],
  configDocs = [],
  messages = {}, // sid → плоские сообщения v2 (api-map §4)
  diffs = {}, // sid → [FileDiff.Info] для GET /api/session/:id/diff
  commands = [], // [{name, description?}] — выдача GET /api/command (api-map №27)
  credentials = [], // [{id, integrationID, value}] — состояние /api/credential (api-map §10)
  plugins = [], // [{id, enabled?, ...}] — выдача GET /api/plugin (plugin.list); [] = маршрута нет (старый serve)
  version = "2.2.6",
} = {}) {
  const requests = [];
  const sseClients = new Set();
  const routes = new Map(); // "METHOD path" -> handler(req, body, url) => {status?, json?, text?}
  const waiters = [];
  const instances = new Set(); // «прогретые» локации для /api/debug/location
  let seq = 0;
  let sseConnects = 0; // сколько раз клиент подключался к /api/event (тест реконнекта)

  const state = { sessions, active, permissions, forms, mcp, agents, providers, models, modelDefault, projects, configDocs, messages, diffs, commands, credentials, plugins };

  function route(method, p, handler) {
    routes.set(`${method.toUpperCase()} ${p}`, handler);
  }

  // Конверт instance-ответа: эхо location из deepObject-параметра, иначе — дефолт
  // (живой v2 отвечает default-каталогом, игнорируя ?directory=).
  const locOf = (url) => url.searchParams.get("location[directory]") ?? defaultDirectory;
  const env = (dir, data) => ({ location: { directory: dir ?? defaultDirectory }, data });
  const page = (data) => ({ data, cursor: { next: null, previous: null } });

  // ---- базовые маршруты, которые трогают методы oc-client (design §1.3) ----
  route("GET", "/api/session", (req, body, url) => {
    const dir = url.searchParams.get("directory"); // обычный query-фильтр
    const data = dir ? state.sessions.filter((s) => s?.location?.directory === dir) : state.sessions;
    // BUG-189: как живой 2.2.6 — страница ?limit= (по умолчанию 50), непрозрачный
    // ?cursor=; next есть у любой непустой страницы, конец — пустая страница.
    const lim = Number(url.searchParams.get("limit")) || 50;
    const raw = url.searchParams.get("cursor");
    const off = raw ? Number(String(raw).replace(/^s/, "")) : 0;
    const slice = data.slice(off, off + lim);
    return { json: { data: slice, cursor: { previous: null, next: slice.length ? `s${off + lim}` : null } } };
  });
  route("GET", "/api/session/active", () => ({ json: env(null, state.active) }));
  route("GET", "/api/agent", (req, body, url) => ({ json: env(locOf(url), state.agents) }));
  route("GET", "/api/project", () => ({ json: state.projects }));
  route("GET", "/api/permission/request", (req, body, url) => ({ json: env(locOf(url), state.permissions) }));
  route("GET", "/api/form", (req, body, url) => ({ json: env(locOf(url), state.forms) }));
  route("GET", "/api/mcp", (req, body, url) => {
    instances.add(locOf(url));
    return { json: env(locOf(url), state.mcp) };
  });
  route("GET", "/api/provider", (req, body, url) => {
    instances.add(locOf(url)); // прогрев провайдеров тоже держит instance (design §6)
    return { json: env(locOf(url), state.providers) };
  });
  route("GET", "/api/model", (req, body, url) => {
    instances.add(locOf(url)); // пара провайдера (api-map №24) — тоже init instance
    return { json: env(locOf(url), state.models) };
  });
  route("GET", "/api/model/default", (req, body, url) => ({ json: env(locOf(url), state.modelDefault) }));
  route("GET", "/api/config", (req, body, url) => ({ json: state.configDocs }));
  // №27: список команд — instance-маршрут с конвертом {location, data}
  route("GET", "/api/command", (req, body, url) => ({ json: env(locOf(url), state.commands) }));
  // plugin.list (OpenAPI 2.2.6: «Retrieve enabled server plugins and their
  // current status») — только когда список задан; иначе 404 fallback (старый serve)
  if (state.plugins.length > 0) route("GET", "/api/plugin", (req, body, url) => ({ json: env(locOf(url), state.plugins) }));
  route("GET", "/api/info", () => ({ json: { version, pid: 4242, hostname: "fake-oc2", urls: [], paths: { tmp: "C:\\tmp" }, capabilities: {} } }));
  route("GET", "/api/debug/location", () => ({ json: [...instances].map((directory) => ({ directory })) }));
  route("DELETE", "/api/debug/location", (req, body, url) => {
    instances.delete(locOf(url));
    return { status: 204 };
  });
  // №28 (api-map §10): credential — POST не идемпотентен (повтор id → 409, Э2),
  // ответ ЭХОМ возвращает ключ открытым текстом (как живой v2 — на этом строится
  // тест «ключ не в логах» скрипта выката). DELETE /api/credential/{id} —
  // динамический путь, обрабатывается в fallback-цепочке ниже.
  route("POST", "/api/credential", (req, body) => {
    const id = body?.id;
    if (typeof id !== "string" || !id) return { status: 400, json: { _tag: "InvalidRequestError", message: "id required" } };
    if (state.credentials.some((c) => c?.id === id)) {
      return { status: 409, json: { _tag: "ConflictError", message: `credential already exists: ${id}` } };
    }
    state.credentials.push(body);
    return { json: { data: body } }; // эхо тела (включая value.key) — как на живом сервере
  });

  function notifySubscription() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (sseClients.size > 0) {
        waiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = raw;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { /* текст */ }

    // Basic-авторизация на всём /api/* (api-map §0.1) — до маршрутов и журнала
    // ответа, но запрос журналируем всегда (тест «пароль не в логах» читает его).
    const auth = req.headers.authorization ?? null;
    const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const unauthorized = auth !== expected;

    const queryEntries = [...url.searchParams.entries()];
    const dir = queryEntries.find(([k]) => k === "location[directory]")?.[1]
      ?? (url.pathname === "/api/session" && req.method === "GET" ? url.searchParams.get("directory") : null)
      ?? (url.pathname === "/api/session" && req.method === "POST" ? body?.location?.directory : null)
      ?? null;
    requests.push({ method: req.method, path: url.pathname, query: url.search ?? "", queryEntries, body, directory: dir, authorization: auth });

    if (unauthorized) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ _tag: "UnauthorizedError", message: "invalid credentials", kind: "Auth" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/event") {
      sseConnects++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ id: `evt_conn_${++seq}`, type: "server.connected", data: {} })}\n\n`);
      const client = { res };
      sseClients.add(client);
      req.on("close", () => sseClients.delete(client));
      notifySubscription();
      return;
    }

    const sidFrom = (p) => decodeURIComponent(p.split("/")[3] ?? "");
    const key = `${req.method} ${url.pathname}`;
    let out;
    if (routes.has(key)) out = await routes.get(key)(req, body, url);
    if (!out) {
      const mSid = /^\/api\/session\/([^/]+)$/.exec(url.pathname);
      const mMsg = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname);
      const mDiff = /^\/api\/session\/([^/]+)\/diff$/.exec(url.pathname);
      const mPermReply = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(url.pathname);
      const mFormReply = /^\/api\/session\/([^/]+)\/form\/([^/]+)\/reply$/.exec(url.pathname);
      const mFormDel = /^\/api\/session\/([^/]+)\/form\/([^/]+)$/.exec(url.pathname);
      if (req.method === "POST" && url.pathname === "/api/session") {
        const created = {
          id: `ses_f${++seq}`,
          title: body?.title ?? "",
          ...(body?.agent ? { agent: body.agent } : {}),
          ...(body?.model ? { model: body.model } : {}),
          time: { created: Date.now(), updated: Date.now() },
          location: { directory: body?.location?.directory ?? defaultDirectory },
        };
        state.sessions.push(created);
        out = { json: env(created.location.directory, created) };
      } else if (mSid && req.method === "GET") {
        const s = state.sessions.find((x) => x.id === sidFrom(url.pathname));
        out = s ? { json: env(s.location?.directory, s) } : { status: 404, json: { _tag: "NotFoundError", message: "session not found" } };
      } else if (mSid && req.method === "PATCH") {
        const s = state.sessions.find((x) => x.id === sidFrom(url.pathname));
        if (!s) out = { status: 404, json: { _tag: "NotFoundError", message: "session not found" } };
        else {
          if (typeof body?.title === "string") s.title = body.title;
          if (body?.metadata && typeof body.metadata === "object") s.metadata = { ...s.metadata, ...body.metadata };
          out = { status: 204 };
        }
      } else if (mSid && req.method === "DELETE") {
        const i = state.sessions.findIndex((x) => x.id === sidFrom(url.pathname));
        if (i < 0) out = { status: 404, json: { _tag: "NotFoundError", message: "session not found" } };
        else {
          state.sessions.splice(i, 1);
          out = { status: 204 };
        }
      } else if (mMsg && req.method === "GET") {
        // Курсорная пагинация как на живом v2 (api-map §4): список плоских
        // сообщений новыми раньше; ?limit=N — страница, ?cursor=c<N> —
        // непрозрачный курсор («смещение»); конец — cursor.next:null.
        const all = state.messages[sidFrom(url.pathname)] ?? [];
        const rawLimit = url.searchParams.get("limit");
        const rawCursor = url.searchParams.get("cursor");
        if (rawCursor !== null && !/^c\d+$/.test(rawCursor)) {
          out = { status: 400, json: { _tag: "InvalidCursor", message: "bad cursor" } };
        } else if (rawLimit !== null && Number(rawLimit) > 200) {
          // BUG-191: живой 2.2.6 — «Expected a value less than or equal to 200 at ["limit"]»
          out = { status: 400, json: { _tag: "InvalidRequestError", message: 'Expected a value less than or equal to 200\n  at ["limit"]', kind: "Query" } };
        } else {
          const off = rawCursor ? Number(rawCursor.slice(1)) : 0;
          const lim = rawLimit !== null ? Math.max(0, Number(rawLimit) || 0) : all.length;
          const next = off + lim < all.length ? `c${off + lim}` : null;
          out = { json: { data: all.slice(off, off + lim), cursor: { next, previous: null } } };
        }
      } else if (mDiff && req.method === "GET") {
        out = { json: env(null, state.diffs[sidFrom(url.pathname)] ?? []) };
      } else if (mPermReply && req.method === "POST") {
        out = { status: 204 };
      } else if (mFormReply && req.method === "POST") {
        out = { status: 204 };
      } else if (mFormDel && req.method === "DELETE") {
        out = { status: 204 };
      } else if (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname) && req.method === "POST") {
        out = { json: { data: { id: `msg_u${++seq}`, sessionID: sidFrom(url.pathname), time: { created: Date.now() }, type: "user", payload: { text: body?.text ?? "" }, delivery: "steer" } } };
      } else if (/^\/api\/session\/[^/]+\/interrupt$/.test(url.pathname) && req.method === "POST") {
        out = { json: { interrupted: true } };
      } else if (/^\/api\/session\/[^/]+\/revert\/stage$/.test(url.pathname) && req.method === "POST") {
        // snapshots:false (Э1): files всегда [] — граница ставится, файлы нет
        out = { json: { data: { messageID: body?.messageID ?? null, files: [] } } };
      } else if (/^\/api\/session\/[^/]+\/revert\/commit$/.test(url.pathname) && req.method === "POST") {
        out = { status: 204 };
      } else if (/^\/api\/session\/[^/]+\/revert$/.test(url.pathname) && req.method === "DELETE") {
        out = { status: 204 };
      } else if (/^\/api\/session\/[^/]+\/command$/.test(url.pathname) && req.method === "POST") {
        // №27 (живьём :4100): 204 СРАЗУ (execution в фоне); неизвестная
        // команда — 404 {_tag: CommandNotFoundError, command, message}
        const name = body?.name;
        if (typeof name !== "string" || !name) {
          out = { status: 400, json: { _tag: "InvalidRequestError", message: "name required", kind: "Payload" } };
        } else if (!state.commands.some((c) => c?.name === name)) {
          out = { status: 404, json: { _tag: "CommandNotFoundError", command: name, message: `Command not found: ${name}` } };
        } else {
          out = { status: 204 };
        }
      } else if (/^\/api\/credential\/[^/]+$/.test(url.pathname) && req.method === "DELETE") {
        const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const i = state.credentials.findIndex((c) => c?.id === id);
        if (i < 0) out = { status: 404, json: { _tag: "NotFoundError", message: `no credential ${id}` } };
        else {
          state.credentials.splice(i, 1);
          out = { status: 204 };
        }
      } else if (/^\/api\/session\/[^/]+\/model$/.test(url.pathname) && req.method === "POST") {
        const s = state.sessions.find((x) => x.id === sidFrom(url.pathname));
        if (!s) out = { status: 404, json: { _tag: "NotFoundError", message: "session not found" } };
        else {
          s.model = { id: body?.model?.id, providerID: body?.model?.providerID, ...(body?.model?.variant ? { variant: body.model.variant } : {}) };
          out = { status: 204 };
        }
      } else if (/^\/api\/session\/[^/]+\/agent$/.test(url.pathname) && req.method === "POST") {
        const s = state.sessions.find((x) => x.id === sidFrom(url.pathname));
        if (!s) out = { status: 404, json: { _tag: "NotFoundError", message: "session not found" } };
        else {
          s.agent = body?.agent;
          out = { status: 204 };
        }
      } else {
        out = { status: 404, json: { _tag: "NotFoundError", message: `fake-opencode-v2: нет маршрута ${key}` } };
      }
    }

    const st = out.status ?? 200;
    if (out.json !== undefined) {
      res.writeHead(st, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    } else {
      res.writeHead(st, { "content-type": "text/plain" });
      res.end(out.text ?? "");
    }
  });
  server.keepAliveTimeout = 1; // не держим idle-сокеты после теста, как в v1-фейке

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    state,
    requests,
    route,
    get subscriptions() { return sseClients.size; },
    get sseConnects() { return sseConnects; },
    emit(evt) {
      const frame = `data: ${typeof evt === "string" ? evt : JSON.stringify(evt)}\n\n`;
      for (const c of sseClients) c.res.write(frame);
    },
    dropSubscriptions() {
      for (const c of sseClients) c.res.destroy();
      sseClients.clear();
    },
    waitForSubscription(timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        const w = { resolve: () => { clearTimeout(t); resolve(); } };
        const t = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`нет SSE-подписки /api/event за ${timeoutMs} мс`));
        }, timeoutMs);
        waiters.push(w);
        notifySubscription();
      });
    },
    async close() {
      for (const c of sseClients) c.res.destroy();
      sseClients.clear();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}
