// FEAT-18.2: server — POST /teleharness/api/auth/pair (one-time phone sign-in code for
// the caller's own account) and POST /teleharness/api/auth/pair/claim {code} (code →
// ordinary session cookie, burnt on use). Covers: link on TELEHARNESS_PUBLIC_URL, the
// claimed cookie signs in as the issuer (admin and tenant), repeat → 410,
// unknown → 401, admin cannot mint for another user (403), anonymous → 401,
// ≤5 live codes (429), claim throttle per address (429 even for a valid
// code), cross-site claim refused, no TELEHARNESS_PUBLIC_URL → nothing minted.
// Expiry (10 min) is covered with an injected clock in tests/pair-auth.test.js.
// Run: node --test --test-concurrency=1 tests/pair-server.test.js
// @suite: server
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnPortal } from "./helpers/spawn-server.mjs";

const ADMIN = "Q".repeat(20) + "-pair-server-" + "3".repeat(24);
const PUBLIC = "https://portal.example.test/teleharness";

const upstream = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(req.url.startsWith("/session") ? "[]" : req.url.startsWith("/agent") ? "[]" : "{}");
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upUrl = `http://127.0.0.1:${upstream.address().port}`;

const srv = await spawnPortal({ upstream: upUrl, env: { TELEHARNESS_ADMIN_TOKEN: ADMIN, TELEHARNESS_PUBLIC_URL: PUBLIC + "/" } });
let bare = null; // a second portal without TELEHARNESS_PUBLIC_URL (started on demand)
after(async () => {
  await srv.stop();
  await bare?.stop();
  upstream.close();
});
const base = srv.base;

const bearer = (t) => ({ authorization: `Bearer ${t}` });
async function call(method, p, { headers = {}, body, b = base } = {}) {
  const r = await fetch(`${b}${p}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, json, cookie: r.headers.getSetCookie?.() ?? [] };
}
const pair = (token, body) => call("POST", "/teleharness/api/auth/pair", { headers: bearer(token), body });
const claim = (code, { ip, headers = {} } = {}) =>
  call("POST", "/teleharness/api/auth/pair/claim", { body: { code }, headers: { ...(ip ? { "x-forwarded-for": ip } : {}), ...headers } });
const sidCookie = (setCookie) => {
  const main = setCookie.find((c) => /Path=\/teleharness/.test(c) && !/Max-Age=0/.test(c));
  return main ? main.split(";")[0] : null;
};
const meWith = async (cookie) => (await call("GET", "/teleharness/api/auth/me", { headers: { cookie } })).json?.user?.id ?? null;

const created = await call("POST", "/teleharness/api/admin/users", { headers: bearer(ADMIN), body: { name: "pairalice" } });
assert.equal(created.status, 201, JSON.stringify(created.json));
const ALICE = created.json.token;

test("admin: код → ссылка на TELEHARNESS_PUBLIC_URL, claim даёт обычную сессию admin; повтор → 410", async () => {
  const t0 = Date.now();
  const r = await pair(ADMIN);
  assert.equal(r.status, 201);
  assert.equal(r.json.configured, true);
  assert.match(r.json.code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.url, `${PUBLIC}/#/pair/${r.json.code}`);
  const ttl = Date.parse(r.json.expiresAt) - t0;
  assert.ok(ttl > 9.5 * 60_000 && ttl <= 10 * 60_000 + 2000, `ttl ${ttl}`);

  const c = await claim(r.json.code, { ip: "7.7.7.1" });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.user.id, "admin");
  const cookie = sidCookie(c.cookie);
  assert.ok(cookie, "a session cookie is set");
  assert.ok(c.cookie.some((x) => /HttpOnly/.test(x) && /SameSite=Lax/.test(x)), "same cookie flags as a token login");
  assert.ok(!cookie.includes(ADMIN) && !cookie.includes(r.json.code), "the cookie carries neither token nor code");
  assert.equal(await meWith(cookie), "admin");

  const again = await claim(r.json.code, { ip: "7.7.7.1" });
  assert.equal(again.status, 410);
  assert.match(again.json.error, /истекла или уже использована/);
  assert.equal(again.cookie.length, 0, "no cookie on a refused claim");
});

test("тенант: свой код входит под тенантом", async () => {
  const r = await pair(ALICE);
  assert.equal(r.status, 201);
  const c = await claim(r.json.code, { ip: "7.7.7.2" });
  assert.equal(c.status, 200);
  assert.equal(c.json.user.id, "pairalice");
  assert.equal(await meWith(sidCookie(c.cookie)), "pairalice");
});

test("admin не выпускает код за другого пользователя (403), аноним — 401, GET — 405", async () => {
  const r = await pair(ADMIN, { userId: "pairalice" });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /своей учётной записи/);
  const own = await pair(ADMIN, { userId: "admin" });
  assert.equal(own.status, 201, "naming oneself is fine");
  assert.equal((await call("POST", "/teleharness/api/auth/pair", { body: {} })).status, 401);
  assert.equal((await call("GET", "/teleharness/api/auth/pair", { headers: bearer(ADMIN) })).status, 405);
});

test("неизвестный код → 401, без JSON → 415, межсайтовый claim → 403", async () => {
  const u = await claim("B".repeat(43), { ip: "7.7.7.3" });
  assert.equal(u.status, 401);
  assert.match(u.json.error, /недействительна/);
  const nj = await call("POST", "/teleharness/api/auth/pair/claim", { body: "code=x", headers: { "content-type": "text/plain", "x-forwarded-for": "7.7.7.3" } });
  assert.equal(nj.status, 415);
  const r = await pair(ALICE);
  const xs = await claim(r.json.code, { ip: "7.7.7.3", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
  assert.equal(xs.status, 403);
  assert.equal((await claim(r.json.code, { ip: "7.7.7.4" })).status, 200, "the refused cross-site attempt did not burn the code");
});

test("не больше 5 активных кодов на пользователя → 429", async () => {
  const name = "pairbob";
  const u = await call("POST", "/teleharness/api/admin/users", { headers: bearer(ADMIN), body: { name } });
  const tok = u.json.token;
  for (let i = 0; i < 5; i++) assert.equal((await pair(tok)).status, 201, `code ${i + 1}`);
  const sixth = await pair(tok);
  assert.equal(sixth.status, 429);
  assert.match(sixth.json.error, /активных кодов/);
});

test("10 неудачных claim с адреса за минуту → 429 даже для верного кода; другой адрес свободен", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await claim("C".repeat(43), { ip: "7.7.8.1" })).status, 401);
  const r = await pair(ADMIN);
  assert.equal((await claim(r.json.code, { ip: "7.7.8.1" })).status, 429);
  assert.equal((await claim(r.json.code, { ip: "7.7.8.2" })).status, 200, "the throttled attempt did not burn the code");
});

test("без TELEHARNESS_PUBLIC_URL: код не выпускается, ответ называет настройку", async () => {
  bare = await spawnPortal({ upstream: upUrl, env: { TELEHARNESS_ADMIN_TOKEN: ADMIN } });
  const r = await call("POST", "/teleharness/api/auth/pair", { headers: bearer(ADMIN), body: {}, b: bare.base });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { configured: false, setting: "TELEHARNESS_PUBLIC_URL" });
});
