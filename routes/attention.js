// FEAT-20.2: /teleharness/api/attention — доска внимания.
//   GET  /teleharness/api/attention?project=<dir>&q=<строка>&active=1
//   POST /teleharness/api/attention/seen     {keys:[…≤200], upTo?} | {section:"done"|"failed", upTo}
//   POST /teleharness/api/attention/snooze   {key, until: ms|null}
//   POST /teleharness/api/attention/away-ack {until?}
//   GET|PUT /teleharness/api/me/push-prefs   {needs, failed, done, quiet}
// Видимость — до сборки ответа (правило трекера 12: «не видеть» = «сервер не
// отдаёт»): тенант — чаты своих папок и свои запуски; admin — чаты папок, не
// принадлежащих ни одному тенанту (правило pushRecipients), и свои запуски.
// Чужой и несуществующий ключ — один и тот же ответ 404 «не найдено».
import { ATTENTION, awaySummary, buildBoard, cleanPushPrefs, isAttentionKey } from "../lib/attention.js";

const NOT_FOUND = { error: "не найдено" };

// deps: sendJson, readJsonBody, store (AttentionStore), chatsFor(user) → [chat],
//   live() → {busy, dialogs}, sources() → {opencode}, boardRuns(user) → runs|null,
//   reviews(user) → [ReviewSummary]|null, pinsOf(userId) → [ids], epoch() → string,
//   ping(userId, reason), projectName(dir), now().
export function attentionRoutes(deps) {
  const now = deps.now ?? (() => Date.now());

  async function runsOf(user) {
    try {
      const runs = (await deps.boardRuns?.(user)) ?? null;
      return { runs, state: runs ? "ok" : "off" }; // null — исполнение Temporal не подключено
    } catch {
      return { runs: null, state: "down" };
    }
  }

  async function snapshot(user, admin, { filter = {}, active = false } = {}) {
    const t = now();
    const prefs = active ? deps.store.touch(user.id, t) : deps.store.user(user.id);
    const [chats, { runs, state: temporal }] = await Promise.all([deps.chatsFor(user, admin), runsOf(user)]);
    let reviews = null;
    try {
      reviews = (await deps.reviews?.(user)) ?? null;
    } catch {
      reviews = null;
    }
    const sources = { ...deps.sources(), temporal: runs ? (runs.some((r) => r.summary?.kind === "unavailable") ? "down" : "ok") : temporal, reviews: reviews ? "ok" : "off" };
    const board = buildBoard({
      now: t, since: deps.store.since, chats, live: deps.live(), outcomes: deps.store.outcomes(), runs: runs ?? [], reviews,
      pins: deps.pinsOf(user.id), user: prefs, sources, filter, admin, projectName: deps.projectName,
    });
    return { board, chats, runs: runs ?? [], prefs };
  }

  // Ключ, который пользователь вправе отмечать: свой чат или свой запуск.
  async function ownKeys(user, admin, keys) {
    const chats = new Set((await deps.chatsFor(user, admin)).map((c) => `chat:${c.id}`));
    const runs = keys.some((k) => k.startsWith("run:")) ? new Set(((await runsOf(user)).runs ?? []).map((r) => `run:${r.workflowId}`)) : new Set();
    return keys.every((k) => chats.has(k) || runs.has(k));
  }

  async function body(req) {
    const b = await deps.readJsonBody(req, 64 * 1024);
    return b && typeof b === "object" && !Array.isArray(b) ? b : null;
  }

  return [
    {
      method: "GET",
      path: "/teleharness/api/attention",
      scope: "user",
      handler: async ({ res, url, user, admin }) => {
        const filter = { project: url.searchParams.get("project") || null, q: url.searchParams.get("q") || null };
        const { board, runs, prefs } = await snapshot(user, admin, { filter, active: url.searchParams.get("active") === "1" });
        const away = awaySummary(prefs, { runs, now: board.now });
        return deps.sendJson(res, 200, { ...board, epoch: deps.epoch?.() ?? null, away, admin: !!admin });
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/attention/seen",
      scope: "user",
      handler: async ({ req, res, user, admin }) => {
        const b = await body(req);
        if (!b) return deps.sendJson(res, 400, { error: "bad json body" });
        const upTo = b.upTo == null ? now() : Number(b.upTo);
        if (!Number.isFinite(upTo) || upTo <= 0 || upTo > now() + 60_000) return deps.sendJson(res, 400, { error: "bad upTo" });
        let keys;
        if (b.section != null) {
          if (b.section !== "done" && b.section !== "failed") return deps.sendJson(res, 400, { error: "bad section" });
          // «Отметить все»: только элементы, известные на версии upTo (новые остаются)
          const filter = { project: typeof b.project === "string" ? b.project : null, q: typeof b.q === "string" ? b.q : null };
          const { board } = await snapshot(user, admin, { filter });
          keys = board.items.filter((it) => it.state === b.section && it.at <= upTo).map((it) => it.key);
        } else {
          if (!Array.isArray(b.keys) || b.keys.length === 0 || b.keys.length > ATTENTION.maxKeys || !b.keys.every(isAttentionKey)) return deps.sendJson(res, 400, { error: "bad keys" });
          keys = [...new Set(b.keys)];
          if (!(await ownKeys(user, admin, keys))) return deps.sendJson(res, 404, NOT_FOUND);
        }
        const changed = deps.store.markSeen(user.id, keys, upTo);
        if (changed) deps.ping(user.id, "seen");
        return deps.sendJson(res, 200, { ok: true, marked: keys.length, version: upTo });
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/attention/snooze",
      scope: "user",
      handler: async ({ req, res, user, admin }) => {
        const b = await body(req);
        if (!b || !isAttentionKey(b.key)) return deps.sendJson(res, 400, { error: "bad key" });
        const until = b.until == null ? null : Number(b.until);
        if (until != null && (!Number.isFinite(until) || until <= now() || until > now() + ATTENTION.snoozeMaxMs)) return deps.sendJson(res, 400, { error: "bad until" });
        if (!(await ownKeys(user, admin, [b.key]))) return deps.sendJson(res, 404, NOT_FOUND);
        deps.store.snooze(user.id, b.key, until);
        deps.ping(user.id, "snooze");
        return deps.sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/attention/away-ack",
      scope: "user",
      handler: async ({ req, res, user }) => {
        const b = (await body(req)) ?? {};
        const at = b.until == null ? now() : Number(b.until);
        if (!Number.isFinite(at) || at <= 0) return deps.sendJson(res, 400, { error: "bad until" });
        deps.store.ackAway(user.id, Math.min(at, now()));
        deps.ping(user.id, "away-ack");
        return deps.sendJson(res, 200, { ok: true });
      },
    },
    {
      method: ["GET", "PUT"],
      path: "/teleharness/api/me/push-prefs",
      scope: "user",
      handler: async ({ req, res, user }) => {
        if (req.method === "GET") return deps.sendJson(res, 200, deps.store.user(user.id)?.push ?? cleanPushPrefs({}));
        const prefs = cleanPushPrefs(await body(req));
        if (!prefs) return deps.sendJson(res, 400, { error: "bad prefs" });
        const out = deps.store.setPrefs(user.id, prefs);
        deps.ping(user.id, "prefs");
        return deps.sendJson(res, 200, out);
      },
    },
  ];
}
