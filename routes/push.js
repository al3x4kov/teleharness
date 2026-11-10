// FEAT-07.20: Web Push routes. Scope "user" — any signed-in account, and
// every handler touches only the caller's own subscriptions.
//
//   GET    /zai/api/push/key        → {enabled, publicKey, subscribed?}
//   POST   /zai/api/push/subscribe  {endpoint, keys:{p256dh, auth}} → {ok}
//   DELETE /zai/api/push/subscribe  {endpoint} → {ok, removed}
//   POST   /zai/api/push/presence   {endpoint, chat|null} → {ok} (this device shows chat X)
//   POST   /zai/api/push/test       {} → {ok, sent, results}
//
// deps: { sendJson, readJsonBody, push: {store, notifier, vapid, extraOrigins} | null }
import { endpointProblem, fromB64u, payloadFor } from "../lib/push.js";

const BODY_LIMIT = 8 * 1024;

function keysProblem(keys) {
  const p = fromB64u(keys?.p256dh);
  const a = fromB64u(keys?.auth);
  if (!p || p.length !== 65 || p[0] !== 4) return "bad p256dh";
  if (!a || a.length !== 16) return "bad auth";
  return null;
}

export function pushRoutes(deps) {
  const { sendJson, readJsonBody } = deps;
  const off = (res) => sendJson(res, 503, { error: "уведомления выключены на сервере" });

  return [
    {
      method: "GET",
      path: "/zai/api/push/key",
      scope: "user",
      handler: ({ res, url, user }) => {
        const push = deps.push();
        if (!push) return sendJson(res, 200, { enabled: false, publicKey: null });
        const endpoint = url.searchParams.get("endpoint");
        const out = { enabled: true, publicKey: push.vapid.publicKey, count: push.store.forUser(user.id).length };
        if (endpoint) out.subscribed = push.store.has(user.id, endpoint);
        return sendJson(res, 200, out);
      },
    },
    {
      method: ["POST", "DELETE"],
      path: "/zai/api/push/subscribe",
      scope: "user",
      handler: async ({ req, res, user }) => {
        const push = deps.push();
        if (!push) {
          req.resume();
          return off(res);
        }
        const body = await readJsonBody(req, BODY_LIMIT);
        if (!body || typeof body !== "object") return sendJson(res, 400, { error: "bad json" });
        if (req.method === "DELETE") {
          if (typeof body.endpoint !== "string") return sendJson(res, 400, { error: "endpoint required" });
          return sendJson(res, 200, { ok: true, removed: push.store.remove(user.id, body.endpoint) });
        }
        const bad = endpointProblem(body.endpoint, push.extraOrigins) || keysProblem(body.keys);
        if (bad) return sendJson(res, 400, { error: bad });
        push.store.add(user.id, { endpoint: body.endpoint, keys: body.keys }, { ua: req.headers["user-agent"] });
        return sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: "/zai/api/push/presence",
      scope: "user",
      handler: async ({ req, res, user }) => {
        const push = deps.push();
        if (!push) {
          req.resume();
          return off(res);
        }
        const body = await readJsonBody(req, BODY_LIMIT);
        if (!body || typeof body.endpoint !== "string") return sendJson(res, 400, { error: "endpoint required" });
        const chat = typeof body.chat === "string" && body.chat.length <= 200 ? body.chat : null;
        return sendJson(res, 200, { ok: push.store.setPresence(user.id, body.endpoint, chat) });
      },
    },
    {
      method: "POST",
      path: "/zai/api/push/test",
      scope: "user",
      handler: async ({ req, res, user }) => {
        const push = deps.push();
        if (!push) {
          req.resume();
          return off(res);
        }
        await readJsonBody(req, BODY_LIMIT); // body optional
        if (push.store.forUser(user.id).length === 0) return sendJson(res, 409, { error: "нет подписки — включите уведомления" });
        const payload = { ...payloadFor("done", { sid: "", title: "проверка" }), title: "zai: проверка уведомлений", body: "Уведомления работают", url: "/zai/#/settings", tag: "zai-test", kind: "test", chat: null };
        const { ok, results } = await push.notifier.sendToUser(user.id, payload, { ttl: 300, urgency: "high" });
        return sendJson(res, ok > 0 ? 200 : 502, { ok: ok > 0, sent: ok, results: results.map((r) => ({ status: r.status })) });
      },
    },
  ];
}
