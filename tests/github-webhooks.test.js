// FEAT-20.3 (1.6): webhook на стороне GitHub — маппинг событий, права,
// создание/ping/проверка/удаление. GitHub подменён фейковым fetchImpl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { githubEvents, canManageHooks, createRepoWebhook, pingRepoWebhook, getRepoWebhook, updateRepoWebhookSecret, deleteRepoWebhook } from "../lib/github/webhooks.js";
import { GhError } from "../lib/github/client.js";

function jsonResponse(status, data = null, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => data, text: async () => JSON.stringify(data) };
}
// Фейковый fetch: таблица [метод, регулярка URL, ответ(совпадение, init)].
function fakeFetch(table) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", etag: init.headers?.["if-none-match"] ?? null, body: init.body ? JSON.parse(init.body) : null });
    const parsed = { ...init, body: init.body ? JSON.parse(init.body) : null };
    for (const [method, re, reply] of table) {
      if ((init.method ?? "GET") !== method) continue;
      const m = re.exec(url);
      if (m) return typeof reply === "function" ? reply(m, parsed, calls.length) : reply;
    }
    return jsonResponse(404, { message: "Not Found" });
  };
  return Object.assign(impl, { calls });
}
const API = "http://gh.local";

test("FEAT-20.3: githubEvents — виды триггера в события GitHub без повторов", () => {
  assert.deepEqual(githubEvents(["issue_labeled", "issue_opened", "comment_command"]), ["issues", "issue_comment"]);
  assert.deepEqual(githubEvents(["ci_failed", "pr_opened", "push"]), ["workflow_run", "pull_request", "push"]);
  // BUG-316: для ci_failed автоматически добавляем push, чтобы сбрасывать/отслеживать коммиты в ветке
  assert.deepEqual(githubEvents(["ci_failed"]), ["workflow_run", "push"]);
  assert.deepEqual(githubEvents([]), []);
  assert.deepEqual(githubEvents(["чепуха"]), []);
});

test("FEAT-20.3: canManageHooks — 200 даёт право, 403/401 нет, сеть — ошибка", async () => {
  const ok = fakeFetch([["GET", /\/repos\/o\/r\/hooks/, jsonResponse(200, [])]]);
  assert.equal(await canManageHooks("t", "o/r", { apiBase: API, fetchImpl: ok }), true);
  const forbidden = fakeFetch([["GET", /\/repos\/o\/r\/hooks/, jsonResponse(403, { message: "Forbidden" })]]);
  assert.equal(await canManageHooks("t", "o/r", { apiBase: API, fetchImpl: forbidden }), false);
  const invisible = fakeFetch([]); // 404 — репозиторий токену не виден
  assert.equal(await canManageHooks("t", "o/r", { apiBase: API, fetchImpl: invisible }), false);
  const dead = fakeFetch([["GET", /\/repos\/o\/r\/hooks/, async () => { throw new Error("boom"); }]]);
  await assert.rejects(() => canManageHooks("t", "o/r", { apiBase: API, fetchImpl: dead }), GhError);
});

test("FEAT-20.3: создание/ping/проверка/удаление — пути, методы и тело хука", async () => {
  const f = fakeFetch([
    ["POST", /\/repos\/o\/r\/hooks$/, (m, init) => {
      assert.equal(init.body.config.url, "http://portal.test/teleharness/hooks/github/" + "k".repeat(43));
      assert.equal(init.body.config.secret, "s3cret");
      assert.equal(init.body.config.content_type, "json");
      assert.deepEqual(init.body.events, ["issues", "issue_comment"]);
      assert.equal(init.body.name, "web");
      return jsonResponse(201, { id: 9, active: true });
    }],
    ["POST", /\/repos\/o\/r\/hooks\/9\/pings$/, jsonResponse(204)],
    ["GET", /\/repos\/o\/r\/hooks\/9$/, jsonResponse(200, { id: 9, active: true, config: { url: "u" } })],
    ["PATCH", /\/repos\/o\/r\/hooks\/9$/, (m, init) => {
      assert.equal(init.body.config.secret, "new-secret");
      return jsonResponse(200, { id: 9, active: true });
    }],
    ["DELETE", /\/repos\/o\/r\/hooks\/9$/, jsonResponse(204)],
  ]);
  const opts = { apiBase: API, fetchImpl: f };
  const hook = await createRepoWebhook("t", "o/r", { url: `http://portal.test/teleharness/hooks/github/${"k".repeat(43)}`, secret: "s3cret", events: githubEvents(["issue_labeled", "comment_command"]) }, opts);
  assert.equal(hook.id, 9);
  assert.equal(await pingRepoWebhook("t", "o/r", 9, opts), "ok");
  const got = await getRepoWebhook("t", "o/r", 9, opts);
  assert.equal(got.active, true);
  await updateRepoWebhookSecret("t", "o/r", 9, "new-secret", opts);
  assert.equal(await deleteRepoWebhook("t", "o/r", 9, opts), "ok");
  assert.deepEqual(f.calls.map((c) => c.method), ["POST", "POST", "GET", "PATCH", "DELETE"]);
  assert.ok(f.calls.every((c) => c.url.startsWith(API)), "запросы идут в apiBase");
});
