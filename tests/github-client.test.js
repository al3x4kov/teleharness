// FEAT-20.3 (1.2): клиент GitHub — классификатор, ETag, срок токена, страницы.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ghFetch, checkConnection, repoPermissions, classify, parseExpiry, GhError, GITHUB_API } from "../lib/github/client.js";

const TOKEN = "ghs_" + "supersecret_token_value_0123456789";

// fetchImpl-заглушка: ответ по таблице {url-префикс: {status, body, headers}}.
function fakeFetch(routes, log = []) {
  return async (url, opts = {}) => {
    log.push({ url, opts });
    const hit = routes.find((r) => url.startsWith(r.match));
    if (!hit) return jsonResponse(404, { message: "Not Found" });
    if (typeof hit.beforeReject === "function") hit.beforeReject();
    if (hit.throw) throw hit.throw;
    const headers = hit.headers ?? {};
    if (opts.headers?.["if-none-match"] && hit.notModified) return jsonResponse(304, null, headers);
    return jsonResponse(hit.status ?? 200, hit.body ?? {}, headers);
  };
}
function jsonResponse(status, body, headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (k) => map.get(k.toLowerCase()) ?? null },
    json: async () => body,
  };
}

test("FEAT-20.3: классификатор исходов", () => {
  assert.equal(classify(200), "ok");
  assert.equal(classify(304), "not_modified");
  assert.equal(classify(401), "auth");
  assert.equal(classify(403), "forbidden");
  assert.equal(classify(403, { rateRemaining: 0 }), "rate_limited");
  assert.equal(classify(404), "not_found");
  assert.equal(classify(422), "validation");
  assert.equal(classify(502), "server");
});

test("FEAT-20.3: срок fine-grained токена парсится из шапки GitHub", () => {
  assert.equal(parseExpiry("2027-01-01 12:00:00 UTC"), Date.parse("2027-01-01T12:00:00Z"));
  assert.equal(parseExpiry(""), null);
  assert.equal(parseExpiry(null), null);
  assert.equal(parseExpiry("мусор"), null);
});

test("FEAT-20.3: ghFetch отдаёт данные, etag, rate и срок; токен не течёт в ошибки", async () => {
  const calls = [];
  const fetchImpl = fakeFetch([
    { match: `${GITHUB_API}/user`, status: 200, body: { login: "octocat" }, headers: { etag: 'W/"u1"', "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4990", "x-ratelimit-reset": "1790000000", "github-authentication-token-expiration": "2027-01-01 12:00:00 UTC" } },
  ], calls);
  const r = await ghFetch(TOKEN, "/user", { fetchImpl });
  assert.equal(r.kind, "ok");
  assert.equal(r.data.login, "octocat");
  assert.equal(r.etag, 'W/"u1"');
  assert.deepEqual(r.rate, { limit: 5000, remaining: 4990, reset: 1790000000 });
  assert.equal(r.expiresAt, Date.parse("2027-01-01T12:00:00Z"));
  assert.equal(calls[0].opts.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].opts.headers["x-github-api-version"], "2022-11-28");

  const errFetch = fakeFetch([{ match: `${GITHUB_API}/user`, status: 401, body: { message: "Bad credentials" } }]);
  await assert.rejects(() => ghFetch(TOKEN, "/user", { fetchImpl: errFetch }), (e) => {
    assert.ok(e instanceof GhError);
    assert.equal(e.kind, "auth");
    assert.equal(e.status, 401);
    assert.ok(!String(e).includes(TOKEN), "токен не попадает в сообщение об ошибке");
    return true;
  });
});

test("FEAT-20.3: 403 при исчерпании лимита отличим от правила; сеть и таймаут — network", async () => {
  const limited = fakeFetch([{ match: GITHUB_API, status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } }]);
  await assert.rejects(() => ghFetch(TOKEN, "/x", { fetchImpl: limited }), (e) => e.kind === "rate_limited" && e.status === 403);
  const forbidden = fakeFetch([{ match: GITHUB_API, status: 403, body: { message: "Resource not accessible" }, headers: { "x-ratelimit-remaining": "4000" } }]);
  await assert.rejects(() => ghFetch(TOKEN, "/x", { fetchImpl: forbidden }), (e) => e.kind === "forbidden");
  const down = fakeFetch([{ match: GITHUB_API, throw: new Error("ECONNREFUSED") }]);
  await assert.rejects(() => ghFetch(TOKEN, "/x", { fetchImpl: down }), (e) => e.kind === "network");
  const slow = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))));
  await assert.rejects(() => ghFetch(TOKEN, "/x", { fetchImpl: slow, timeoutMs: 20 }), (e) => e.kind === "network" && /не ответил/.test(e.message));
});

test("FEAT-20.3: ETag уходит в If-None-Match, 304 — not_modified без данных", async () => {
  const calls = [];
  const fetchImpl = fakeFetch([{ match: GITHUB_API, status: 200, body: { x: 1 }, notModified: true }], calls);
  const r = await ghFetch(TOKEN, "/x", { fetchImpl, etag: 'W/"e1"' });
  assert.equal(r.kind, "not_modified");
  assert.equal(r.data, null);
  assert.equal(calls[0].opts.headers["if-none-match"], 'W/"e1"');
});

test("FEAT-20.3: checkConnection — логин, срок и страницы репозиториев", async () => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/user") return jsonResponse(200, { login: "octocat" }, { "github-authentication-token-expiration": "2027-06-01 00:00:00 UTC" });
    if (u.pathname === "/user/repos") {
      const n = Number(u.searchParams.get("page"));
      return jsonResponse(200, n === 1 ? [repo("a"), repo("b"), ...Array.from({ length: 98 }, (_, i) => repo(`fill${i}`))] : [repo("c")]);
    }
    return jsonResponse(404, {});
  };
  const face = await checkConnection(TOKEN, { fetchImpl });
  assert.equal(face.login, "octocat");
  assert.equal(face.expiresAt, Date.parse("2027-06-01T00:00:00Z"));
  assert.equal(face.repos.length, 101); // 100 на первой странице → вторая запрошена, там 1
  assert.equal(face.repos[0].fullName, "octocat/a");

  const truncated = fakeFetch([
    { match: `${GITHUB_API}/user/repos`, status: 200, body: [repo("only")] },
    { match: `${GITHUB_API}/user`, status: 200, body: { login: "octocat" } },
  ]);
  const small = await checkConnection(TOKEN, { fetchImpl: truncated });
  assert.equal(small.repos.length, 1, "меньше 100 репозиториев — вторая страница не запрашивается");
});

function repo(name) {
  return { full_name: `octocat/${name}`, private: false, permissions: { pull: true, push: name === "a", admin: false } };
}

test("FEAT-20.3: repoPermissions — права по репозиторию, 404 без ошибки", async () => {
  const ok = fakeFetch([{ match: `${GITHUB_API}/repos/`, status: 200, body: { full_name: "o/r", private: false, permissions: { pull: true, push: true, admin: false } } }]);
  const face = await repoPermissions(TOKEN, "o/r", { fetchImpl: ok });
  assert.deepEqual(face.permissions, { pull: true, push: true, admin: false });
  const hidden = fakeFetch([{ match: `${GITHUB_API}/repos/`, status: 404, body: { message: "Not Found" } }]);
  const none = await repoPermissions(TOKEN, "o/hidden", { fetchImpl: hidden });
  assert.equal(none.kind, "not_found");
  assert.equal(none.permissions, null);
});
