// Tests for the z.ai Coding Plan usage endpoint (Settings «Подписка z.ai»):
// 1) normalizeUsage — pure shaping of the live-verified envelope;
// 2) server contract — server.js spawned against a FAKE quota upstream must
//    send the RAW key first (official contract) and retry with Bearer once;
//    a missing auth.json degrades to {ok:false,error:"no-key"}, 200.
// Run: node --test tests/usage.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeUsage, unitKind } from "../lib/usage.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------- normalizeUsage ----------

// Verbatim shape captured live from api.z.ai on 2026-10-31 (Max plan).
const LIVE_SHAPE = {
  code: 200,
  msg: "Operation successful",
  success: true,
  data: {
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 28000, currentValue: 4687, remaining: 23312, percentage: 16, nextResetTime: 1793458323765 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 140000, currentValue: 25587, remaining: 114412, percentage: 18, nextResetTime: 1793989248998 },
    ],
    level: "max",
  },
};

test("normalizeUsage maps the live envelope: plan, windows sorted hours→week", () => {
  const out = normalizeUsage(LIVE_SHAPE);
  assert.equal(out.ok, true);
  assert.equal(out.plan, "max");
  assert.deepEqual(out.windows.map((w) => w.kind), ["hours", "week"]);
  assert.deepEqual(out.windows[0], {
    kind: "hours", number: 5, type: "CREDIT_LIMIT", percent: 16, used: 4687, total: 28000, remaining: 23312, resetAt: 1793458323765,
  });
  assert.equal(out.windows[1].used, 25587);
});

test("normalizeUsage: TOKENS_LIMIT without absolutes keeps percent only", () => {
  const out = normalizeUsage({
    code: 200, success: true,
    data: { level: "lite", limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1, nextResetTime: 1778753640304 }] },
  });
  assert.deepEqual(out.windows[0], {
    kind: "hours", number: 5, type: "TOKENS_LIMIT", percent: 1, used: null, total: null, remaining: null, resetAt: 1778753640304,
  });
});

test("normalizeUsage: nextResetTime is optional / tolerant of seconds and strings", () => {
  const out = normalizeUsage({
    code: 200, success: true,
    data: {
      level: "lite",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 2, nextResetTime: 1778753640 }, // epoch seconds
        { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0, nextResetTime: "2026-11-30T21:00:00.000Z" },
      ],
    },
  });
  assert.equal(out.windows[0].resetAt, null);
  assert.equal(out.windows[1].resetAt, 1778753640000);
  assert.equal(out.windows[2].resetAt, Date.parse("2026-11-30T21:00:00.000Z"));
});

test("normalizeUsage: no-plan / junk envelopes answer null; unit kinds map", () => {
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({ code: 200, success: false, msg: "no plan" }), null);
  assert.equal(normalizeUsage({ code: 401, success: true, data: {} }), null);
  assert.equal(unitKind(3), "hours");
  assert.equal(unitKind(6), "week");
  assert.equal(unitKind(5), "month");
  assert.equal(unitKind(1), "day");
  assert.equal(unitKind(99), "unit99");
});

// ---------- server contract ----------

const QUOTA_BODY = JSON.stringify(LIVE_SHAPE);

// Fake z.ai: raw key → 200; "allowRaw:false" mode emulates deployments that
// only accept the Bearer form (401 raw, 200 Bearer). Records auth headers.
function fakeQuota({ allowRaw }) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const auth = req.headers["authorization"] ?? "";
    seen.push({ url: req.url, auth });
    const rawOk = auth === "key.zai";
    const bearerOk = auth === "Bearer key.zai";
    if ((allowRaw && rawOk) || (!allowRaw && bearerOk)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(QUOTA_BODY);
    } else {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 401, success: false }));
    }
  });
  return { srv, seen };
}

const ADMIN_TOKEN = "u".repeat(20) + "-usage-admin-" + "5".repeat(24);

function withServer({ quotaBase, authFile }) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "zai-usage-data-"));
  // Isolated env (TASK-14.4): no ZAI_* inherited from the shell.
  const started = spawnPortal({
    upstream: "http://127.0.0.1:9", // hub noise only; unused by this route
    env: {
      ZAI_QUOTA_BASE: quotaBase,
      ZAI_AUTH_FILE: authFile,
      // Tenancy is live: /usage is admin-only now, so the server needs an
      // admin to exist before any of these contract calls.
      ZAI_ADMIN_TOKEN: ADMIN_TOKEN,
      ZAI_DATA_DIR: dataDir,
    },
  });
  // Kill the portal before rmSync: an EPERM in an earlier after hook makes
  // node:test skip the rest of the teardown and the runner hangs forever.
  after(async () => {
    await (await started.catch(() => null))?.stop();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return started.then((srv) => srv.base);
}

// Login as the seeded admin and fetch /usage with the session cookie —
// the same flow the Settings card performs in the real portal.
async function adminUsage(base) {
  const login = await fetch(`${base}/zai/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ADMIN_TOKEN }),
  });
  assert.equal(login.status, 200, "admin login must succeed");
  const cookie = (typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [login.headers.get("set-cookie")])
    .join(";")
    .match(/zai_t=[^;]+/)[0];
  return fetch(`${base}/zai/api/usage`, { headers: { cookie } });
}

test("GET /zai/api/usage sends the RAW key and returns the normalized payload", async () => {
  const { srv, seen } = fakeQuota({ allowRaw: true });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  after(() => srv.close());
  const dir = mkdtempSync(path.join(tmpdir(), "zai-usage-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, "auth.json");
  writeFileSync(authFile, JSON.stringify({ "zai-coding-plan": { type: "api", key: "key.zai" } }));

  const base = await withServer({ quotaBase: `http://127.0.0.1:${srv.address().port}`, authFile });
  const res = await adminUsage(base);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.plan, "max");
  assert.equal(body.windows[0].percent, 16);
  assert.equal(body.windows[1].remaining, 114412);
  assert.deepEqual(seen.map((h) => h.auth), ["key.zai"], "first attempt must carry the raw key");
  assert.ok(seen[0].url.endsWith("/api/monitor/usage/quota/limit"));
});

test("GET /zai/api/usage falls back to Bearer when raw is rejected", async () => {
  const { srv } = fakeQuota({ allowRaw: false });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  after(() => srv.close());
  const dir = mkdtempSync(path.join(tmpdir(), "zai-usage-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, "auth.json");
  writeFileSync(authFile, JSON.stringify({ "zai-coding-plan": { type: "api", key: "key.zai" } }));

  const base = await withServer({ quotaBase: `http://127.0.0.1:${srv.address().port}`, authFile });
  const res = await adminUsage(base);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true, "Bearer retry must succeed on raw-401 deployments");
});

test("missing auth.json degrades to {ok:false,error:'no-key'}, not a 5xx", async () => {
  const base = await withServer({
    quotaBase: "http://127.0.0.1:9",
    authFile: path.join(tmpdir(), `zai-no-auth-${Date.now()}.json`),
  });
  const res = await adminUsage(base);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, error: "no-key" });
});

test("quota upstream down answers 503", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zai-usage-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, "auth.json");
  writeFileSync(authFile, JSON.stringify({ "zai-coding-plan": { type: "api", key: "key.zai" } }));
  // Nothing listens here: both attempts fail fast (connection refused).
  const base = await withServer({ quotaBase: "http://127.0.0.1:9", authFile });
  const res = await adminUsage(base);
  assert.equal(res.status, 503);
});
