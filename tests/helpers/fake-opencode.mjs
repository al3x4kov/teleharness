// Фейковый upstream opencode для server-e2e тестов (TASK-14.5, tests.md A1/A3).
//
// Принцип: по умолчанию 404 и сразу конец ответа — НИКАКИХ висящих соединений
// (устаревший фейк в hub.test отвечал SSE на любой путь, и каждый REST-запрос
// хаба висел до 8-секундного таймаута). SSE отдаётся только на GET /event.
//
//   const up = await startFakeOpencode({ sessions: [{ id: "ses_a", directory: "C:\\Home" }] });
//   after(() => up.close());
//   up.emit({ type: "session.idle", properties: { sessionID: "ses_a" } });       // во все /event
//   up.emit(evt, "D:\\Proj");                                                   // только в /event?directory=D:\Proj
//   up.route("GET", "/config", () => ({ json: { model: "x" } }));               // свой маршрут
//   await up.waitForSubscription("D:\\Proj");                                    // ждёт именно SSE /event
//   up.requests — журнал { method, path, directory, body }
import http from "node:http";

export async function startFakeOpencode({ sessions = [], status = {}, permissions = [], questions = [], messages = {}, commands = [] } = {}) {
  const requests = [];
  const sseClients = new Set(); // { res, directory }
  const routes = new Map(); // "METHOD path" -> handler(req, body, url) => {status?, json?, text?}
  const waiters = [];
  const fallbacks = []; // (req, body, url) => out | undefined — pattern routes

  const state = { sessions, status, permissions, questions, messages, commands };

  function route(method, p, handler) {
    routes.set(`${method.toUpperCase()} ${p}`, handler);
  }

  // Базовая карта маршрутов, которые трогают hub/proxy при старте и sync.
  route("GET", "/session", () => ({ json: state.sessions }));
  route("GET", "/session/status", () => ({ json: state.status }));
  route("GET", "/permission", () => ({ json: state.permissions }));
  route("GET", "/question", () => ({ json: state.questions }));
  route("GET", "/config", () => ({ json: {} }));
  route("GET", "/agent", () => ({ json: [] }));
  route("GET", "/mcp", () => ({ json: {} }));
  route("GET", "/config/providers", () => ({ json: { providers: [], default: {} } }));
  // BUG-188: список слэш-команд папки и синхронный ход команды. Конкретный
  // тест может переопределить POST /session/:id/command через up.route(...)
  // (медленный ход, ошибка upstream и т.п.) — статические маршруты проверяются первыми.
  route("GET", "/command", () => ({ json: state.commands }));

  function notifySubscription() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if ([...sseClients].some((c) => w.directory === undefined || c.directory === w.directory)) {
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
    const directory = url.searchParams.get("directory") ?? req.headers["x-opencode-directory"] ?? null;
    requests.push({ method: req.method, path: url.pathname, directory, body, headers: req.headers });

    if (req.method === "GET" && url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      const client = { res, directory };
      sseClients.add(client);
      req.on("close", () => sseClients.delete(client));
      notifySubscription();
      return;
    }

    // /session/:id/message — из state.messages, иначе пустой список
    const mMsg = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    const key = `${req.method} ${url.pathname}`;
    let out;
    if (routes.has(key)) out = await routes.get(key)(req, body, url);
    for (const fb of fallbacks) {
      if (out) break;
      out = await fb(req, body, url);
    }
    if (out) {
      /* handled */
    } else if (mMsg && req.method === "GET") out = { json: state.messages[decodeURIComponent(mMsg[1])] ?? [] };
    else if (/^\/session\/[^/]+\/(abort|prompt_async)$/.test(url.pathname) && req.method === "POST") out = { status: 204 };
    else if (/^\/session\/[^/]+\/command$/.test(url.pathname) && req.method === "POST") {
      // Настоящий /command синхронный: 200 {info, parts} уже ПОСЛЕ хода.
      out = { json: { info: { id: `msg_cmd_${requests.length}`, sessionID: decodeURIComponent(url.pathname.split("/")[2]), role: "assistant", time: { created: Date.now() } }, parts: [{ type: "text", text: "готово" }] } };
    }
    else out = { status: 404, json: { error: `fake-opencode: нет маршрута ${key}` } };

    const st = out.status ?? 200;
    if (out.json !== undefined) {
      res.writeHead(st, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    } else {
      res.writeHead(st, { "content-type": "text/plain" });
      res.end(out.text ?? "");
    }
  });
  server.keepAliveTimeout = 1; // не держим idle-сокеты после теста

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    state,
    requests,
    route,
    fallback(fn) {
      fallbacks.push(fn);
    },
    get subscriptions() { return [...sseClients].map((c) => c.directory); },
    emit(evt, directory) {
      const frame = `data: ${typeof evt === "string" ? evt : JSON.stringify(evt)}\n\n`;
      for (const c of sseClients) if (directory === undefined || c.directory === directory) c.res.write(frame);
    },
    dropSubscriptions() {
      for (const c of sseClients) c.res.destroy();
      sseClients.clear();
    },
    waitForSubscription(directory, timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        const w = { directory, resolve: () => { clearTimeout(t); resolve(); } };
        const t = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`нет SSE-подписки /event${directory !== undefined ? ` для ${directory}` : ""} за ${timeoutMs} мс`));
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
