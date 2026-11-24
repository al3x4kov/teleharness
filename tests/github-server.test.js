// @suite: server
// FEAT-20.3 (1.3): контракты /teleharness/api/github/connection — сохранение без утечки
// токена, перепроверка, удаление. GitHub подменён локальным сервером
// (TELEHARNESS_GITHUB_API), портал поднят через spawnPortal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { statSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const TOKEN = "ghs_" + "test_supersecret_token_value_0123456789"; // длина 42 — «похоже на токен»
const EXPIRES = "2027-01-01 12:00:00 UTC";

function startFakeGithub({ badToken = false } = {}) {
  const hits = { user: 0, repos: 0 };
  const srv = http.createServer((req, res) => {
    const ok = (req.headers.authorization ?? "") === `Bearer ${TOKEN}`;
    res.setHeader("x-ratelimit-limit", "5000");
    res.setHeader("x-ratelimit-remaining", "4900");
    res.setHeader("x-ratelimit-reset", "1790000000");
    if (req.url === "/user") {
      hits.user += 1;
      if (!ok || badToken) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Bad credentials" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "github-authentication-token-expiration": EXPIRES, etag: 'W/"u1"' });
      res.end(JSON.stringify({ login: "octocat" }));
      return;
    }
    if (req.url?.startsWith("/user/repos")) {
      hits.repos += 1;
      if (!ok || badToken) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Bad credentials" }));
        return;
      }
      const page = Number(new URL(req.url, "http://x").searchParams.get("page") ?? "1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(page === 1 ? [
        { full_name: "octocat/hello", private: false, permissions: { pull: true, push: true, admin: false } },
        { full_name: "octocat/dotfiles", private: true, permissions: { pull: true, push: false, admin: false } },
      ] : []));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, hits })));
}

async function githubPortal({ badToken = false } = {}) {
  const up = await startFakeOpencode();
  const gh = await startFakeGithub({ badToken });
  const token = randomUUID().repeat(2);
  let srv;
  try {
    // mock:true нельзя — он уводит /teleharness/api/* в фикстурный mockHandler мимо
    // таблицы маршрутов; поднимаем настоящий server.js над фейковым opencode.
    srv = await spawnPortal({ upstream: up.url, env: { TELEHARNESS_ENV: "stand", TELEHARNESS_ADMIN_TOKEN: token, TELEHARNESS_GITHUB_API: gh.url } });
  } catch (error) {
    await up.close();
    gh.srv.close();
    throw error;
  }
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return { gh, srv, headers, up };
}

const closePortal = async ({ gh, srv, up }) => {
  await srv.stop();
  gh.srv.close();
  await up.close();
};

test("FEAT-20.3: подключение сохраняется, токен не течёт ни в ответ, ни в логи, ни в файлы", async () => {
  const portal = await githubPortal();
  const { gh, srv, headers } = portal;
  try {
    const put = await fetch(`${srv.base}/teleharness/api/github/connection`, { method: "PUT", headers, body: JSON.stringify({ token: TOKEN }) });
    assert.equal(put.status, 200);
    const face = await put.json();
    assert.equal(face.connected, true);
    assert.equal(face.login, "octocat");
    assert.equal(face.tokenLast4, TOKEN.slice(-4));
    assert.equal(face.status, "ok");
    assert.equal(face.expiresAt, Date.parse("2027-01-01T12:00:00Z"));
    assert.deepEqual(face.repos.map((r) => r.fullName), ["octocat/hello", "octocat/dotfiles"]);
    assert.ok(!JSON.stringify(face).includes(TOKEN), "токена нет в ответе");

    // Файлы: ключ 0600, шифротокен не содержит открытый текст.
    assert.ok(existsSync(path.join(srv.tmp.data, "secrets.key")));
    if (process.platform !== "win32") assert.equal(statSync(path.join(srv.tmp.data, "secrets.key")).mode & 0o777, 0o600);
    const connRes = await fetch(`${srv.base}/teleharness/api/github/connection`, { headers });
    assert.equal(connRes.status, 200);
    const connText = await connRes.text();
    assert.ok(!connText.includes(TOKEN), "GET /connection must not expose token");
    assert.ok(connText.includes("octocat"), "GET /connection returns real connection face");
    const dbPath = path.join(srv.tmp.data, "github-triggers.sqlite");
    assert.ok(existsSync(dbPath), "github-triggers.sqlite created");
    assert.ok(!readFileSync(dbPath).includes(Buffer.from(TOKEN, "utf8")), "no plaintext token in SQLite file");
    // Логи сервера за всё время теста не содержат токен.
    assert.ok(!srv.log.includes(TOKEN), "токен не должен попадать в журнал сервера");

    // Перепроверка по требованию идёт в GitHub ещё раз.
    const before = gh.hits.user;
    const check = await fetch(`${srv.base}/teleharness/api/github/connection/check`, { method: "POST", headers });
    assert.equal(check.status, 200);
    assert.equal(gh.hits.user, before + 1);
    assert.equal((await check.json()).login, "octocat");

    const repos = await fetch(`${srv.base}/teleharness/api/github/repos`, { headers });
    assert.equal(repos.status, 200);
    assert.equal((await repos.json()).login, "octocat");
  } finally { await closePortal(portal); }
});

test("FEAT-20.3: неверный токен — 401 понятными словами, без токена в ответе и логах; удаление", async () => {
  const portal = await githubPortal({ badToken: true });
  const { gh, srv, headers } = portal;
  try {
    const put = await fetch(`${srv.base}/teleharness/api/github/connection`, { method: "PUT", headers, body: JSON.stringify({ token: TOKEN }) });
    assert.equal(put.status, 401);
    const body = await put.json();
    assert.match(body.error, /не принят|истёк|заново/);
    assert.ok(!body.error.includes(TOKEN));
    assert.ok(!srv.log.includes(TOKEN));

    const gone = await fetch(`${srv.base}/teleharness/api/github/connection`, { method: "DELETE", headers });
    assert.equal(gone.status, 200);
    assert.equal((await gone.json()).removed, false, "нечего было удалять — сохранение не прошло");
  } finally { await closePortal(portal); }
});

test("FEAT-20.3: не-токен отбраковывается без обращения к GitHub; без подключения — 404", async () => {
  const portal = await githubPortal();
  const { gh, srv, headers } = portal;
  try {
    const put = await fetch(`${srv.base}/teleharness/api/github/connection`, { method: "PUT", headers, body: JSON.stringify({ token: "короткий" }) });
    assert.equal(put.status, 422);
    assert.equal(gh.hits.user, 0, "GitHub не вызывался");

    const check = await fetch(`${srv.base}/teleharness/api/github/connection/check`, { method: "POST", headers });
    assert.equal(check.status, 404);
    const repos = await fetch(`${srv.base}/teleharness/api/github/repos`, { headers });
    assert.equal(repos.status, 404);
    const conn = await fetch(`${srv.base}/teleharness/api/github/connection`, { headers });
    assert.deepEqual(await conn.json(), { connected: false });
  } finally { await closePortal(portal); }
});
