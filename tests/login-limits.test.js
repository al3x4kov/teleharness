// TASK-04.15 (wave2): server — /zai/api/auth/login limits: >10 failed
// attempts per address per 60 s → the 11th answers 429 without checking the
// token (even with a VALID token); a success resets the address (different
// address unaffected); oversize body → 413; broken JSON → 400; wrong token
// → 401. Addresses are simulated with x-forwarded-for (clientIp trusts the
// edge header; the direct-socket fallback would be one shared 127.0.0.1).
// The window expiry itself (60 s) is covered with fake time in
// tests/auth-sessions.test.js (loginThrottled/loginFailure unit) — a real
// 60 s sleep would bloat this suite.
// Run: node --test tests/login-limits.test.js
// @suite: server
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnPortal } from "./helpers/spawn-server.mjs";

const ADMIN = "L".repeat(20) + "-login-limits-" + "9".repeat(24);

const upstream = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(req.url === "/session" ? JSON.stringify([{ id: "ses_up", directory: "x" }]) : JSON.stringify({ ok: true }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

const srv = await spawnPortal({ upstream: `http://127.0.0.1:${upstream.address().port}`, env: { ZAI_ADMIN_TOKEN: ADMIN } });
after(async () => {
  await srv.stop();
  upstream.close();
});
const base = srv.base;

const login = (token, { ip = "127.0.0.1", raw = null, ctype = "application/json" } = {}) =>
  fetch(`${base}/zai/api/auth/login`, {
    method: "POST",
    headers: { "content-type": ctype, ...(ip === "127.0.0.1" ? {} : { "x-forwarded-for": ip }) },
    body: raw ?? JSON.stringify({ token: token ?? "wrong-token-000000000000" }),
  });

test("11th failed login from one address within a minute → 429, valid token does not bypass it", async () => {
  for (let i = 0; i < 10; i++) {
    const r = await login(null, { ip: "9.9.9.1" });
    assert.equal(r.status, 401, `failure ${i + 1} must be a real 401, got ${r.status}`);
    await r.arrayBuffer();
  }
  const blocked = await login(null, { ip: "9.9.9.1" });
  assert.equal(blocked.status, 429, "the 11th attempt is throttled");
  const err = await blocked.json();
  assert.equal(err.error, "too many attempts");
  // even a VALID token gets 429: no token check happens for a throttled address
  const bypass = await login(ADMIN, { ip: "9.9.9.1" });
  assert.equal(bypass.status, 429, "a valid token cannot bypass the throttle");
  await bypass.arrayBuffer();
  // another address is unaffected
  const other = await login(null, { ip: "9.9.9.2" });
  assert.equal(other.status, 401);
  await other.arrayBuffer();
});

test("a successful login resets the address counter; 9 failures then success then failure → 401, not 429", async () => {
  for (let i = 0; i < 9; i++) {
    const r = await login(null, { ip: "9.9.9.3" });
    assert.equal(r.status, 401);
    await r.arrayBuffer();
  }
  const ok = await login(ADMIN, { ip: "9.9.9.3" });
  assert.equal(ok.status, 200, "under the limit a valid login succeeds and resets the counter");
  await ok.arrayBuffer();
  const next = await login(null, { ip: "9.9.9.3" });
  assert.equal(next.status, 401, "the reset address starts counting from zero");
  await next.arrayBuffer();
});

test("oversize body → 413, broken JSON → 400, wrong token → 401", async () => {
  const big = await login(null, { ip: "9.9.9.4", raw: "a".repeat(17 * 1024) });
  assert.equal(big.status, 413, `oversize must be 413, got ${big.status}`);
  await big.arrayBuffer();
  const broken = await login(null, { ip: "9.9.9.5", raw: "{oops" });
  assert.equal(broken.status, 400, `broken JSON must be 400, got ${broken.status}`);
  await broken.arrayBuffer();
  const wrong = await login(null, { ip: "9.9.9.6" });
  assert.equal(wrong.status, 401);
  await wrong.arrayBuffer();
  const good = await login(ADMIN, { ip: "9.9.9.7" });
  assert.equal(good.status, 200, "normal login still works");
  await good.arrayBuffer();
});
