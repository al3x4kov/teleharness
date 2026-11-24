// FEAT-20.3 (1.5): приёмник POST /teleharness/hooks/github/:key — публичная точка входа.
// Порядок (design §3): тело ≤ 1 МБ (413) → ключ триггера (404) → лимит 120/мин
// на ключ (429) → HMAC-подпись постоянным временем (401 + журнал без тела,
// ≤ 30 промахов/ч на IP) → UNIQUE delivery_id → 202 → обработка после ответа.
// ping GitHub подтверждает хук (200). Ответ ≤ 1 с (кр. 6).
import { createHash, randomUUID } from "node:crypto";
import { verifySignature } from "./events.js";

export const BODY_LIMIT = 1024 * 1024;
const PER_KEY_PER_MIN = 120;
const BAD_PER_IP_PER_HOUR = 30;

export function createGithubHookHandler({ store, dispatcher, sendJson, log = () => {}, now = () => Date.now() } = {}) {
  const perKey = new Map(); // keyHash → [timestamps]
  const badIp = new Map(); // ip → [timestamps]

  function within(map, k, windowMs, max, nowMs) {
    const arr = (map.get(k) ?? []).filter((t) => nowMs - t < windowMs);
    map.set(k, arr);
    return arr.length >= max;
  }
  function hit(map, k, windowMs, nowMs) {
    const arr = (map.get(k) ?? []).filter((t) => nowMs - t < windowMs);
    arr.push(nowMs);
    map.set(k, arr);
  }
  function prune(map, windowMs, nowMs) {
    for (const [k, arr] of map) {
      const fresh = arr.filter((ts) => nowMs - ts < windowMs);
      if (fresh.length) map.set(k, fresh);
      else map.delete(k);
    }
  }
  // BUG-323 п.1: скользящая уборка устаревших записей вместо обнуления всех счётчиков целиком.
  setInterval(() => { const n = now(); prune(perKey, 60_000, n); prune(badIp, 3600_000, n); }, 600_000).unref?.();

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) {
          req.resume();
          reject(Object.assign(new Error("too large"), { code: "too_large" }));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  return async function handleGithubHook(req, res, url) {
    let key;
    try {
      key = decodeURIComponent(url.pathname.slice("/teleharness/hooks/github/".length));
    } catch {
      req.resume?.();
      return sendJson(res, 404, { error: "not found" });
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) {
      req.resume?.();
      return sendJson(res, 404, { error: "not found" });
    }
    const keyHash = createHash("sha256").update(key).digest("hex");
    const trigger = store.byKeyHash(keyHash);
    if (!trigger) {
      req.resume?.();
      return sendJson(res, 404, { error: "not found" });
    }
    let body;
    try {
      body = await readBody(req, BODY_LIMIT);
    } catch {
      store.record({ triggerId: trigger.id, eventKey: null, kind: "unknown", repo: "", decision: "too_large", reason: "Тело больше 1 МБ", via: "webhook" });
      return sendJson(res, 413, { error: "Тело больше 1 МБ" });
    }

    const t = now();
    const secret = store.secretFor(trigger);
    const sig = req.headers["x-hub-signature-256"];
    const eventType = String(req.headers["x-github-event"] ?? "");
    const deliveryId = String(req.headers["x-github-delivery"] ?? "") || randomUUID();
    // BUG-323 п.1: сначала проверяем HMAC-подпись (плохие запросы жгут badIp, а не квоту легитимного perKey).
    if (!secret || !verifySignature(secret, body, sig)) {
      const ip = String(req.socket?.remoteAddress ?? "unknown");
      if (within(badIp, ip, 3600_000, BAD_PER_IP_PER_HOUR, t)) return sendJson(res, 429, { error: "Слишком много неверных подписей" });
      hit(badIp, ip, 3600_000, t);
      store.record({ triggerId: trigger.id, eventKey: null, kind: eventType || "unknown", repo: "", actor: null, decision: "bad_signature", reason: "Подпись неверна", via: "webhook" });
      log(`github-hook: неверная подпись для триггера ${trigger.id} с ${ip}`);
      return sendJson(res, 401, { error: "Подпись неверна" });
    }

    if (within(perKey, keyHash, 60_000, PER_KEY_PER_MIN, t)) return sendJson(res, 429, { error: "Слишком часто — повторите позже" });
    hit(perKey, keyHash, 60_000, t);

    if (eventType === "ping") return sendJson(res, 200, { ok: true, pong: true, trigger: trigger.id });

    // UNIQUE delivery_id: повтор доставки не обрабатывается второй раз (кр. 7).
    const fresh = store.insertDelivery(deliveryId, trigger.id, eventType, body);
    if (!fresh) return sendJson(res, 202, { ok: true, duplicate: true });
    // Ответ уходит до обработки (кр. 6); обработка асинхронная.
    sendJson(res, 202, { ok: true, queued: true });
    setImmediate(() => {
      dispatcher.processDelivery({ deliveryId, triggerId: trigger.id, event: eventType, body })
        .catch((error) => log(`github-hook: обработка ${deliveryId}: ${error?.message ?? error}`));
    });
  };
}
