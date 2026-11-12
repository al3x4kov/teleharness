// TASK-12.29 (wave2): unit — access log line + requestId, errLog throttle,
// clientIp (x-forwarded-for / socket), upstream error counter over a sliding
// 5-minute window with fake time. Run: node --test tests/accesslog.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accessLogger, clientIp, errLog, requestId, upstreamErrors5m } from "../lib/accesslog.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("requestId: 12 hex chars, unique", () => {
  const a = requestId();
  const b = requestId();
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});

test("accessLogger: one JSON line per request in access-YYYYMMDD.log, fields preserved", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zai-accesslog-"));
  try {
    const log = accessLogger({ dir, enabled: true });
    log({ ts: "2026-11-11T08:00:00.000Z", rid: "abcd1234ef01", method: "GET", path: "/zai/", status: 200, ms: 3, user: "admin", ip: "127.0.0.1" });
    await sleep(300); // appendFile is async
    const files = readdirSync(dir).filter((f) => f.startsWith("access-"));
    assert.equal(files.length, 1, `expected one access file, got ${files}`);
    const line = JSON.parse(readFileSync(path.join(dir, files[0]), "utf8").trim());
    assert.equal(line.rid, "abcd1234ef01");
    assert.equal(line.method, "GET");
    assert.equal(line.path, "/zai/");
    assert.equal(line.status, 200);
    assert.equal(line.user, "admin");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("errLog: repeated errors of one place are throttled to one line per minute", () => {
  const seen = [];
  const orig = console.error;
  console.error = (...a) => seen.push(a.join(" "));
  try {
    errLog("thr-unit-A", new Error("one"));
    errLog("thr-unit-A", new Error("two"));
    errLog("thr-unit-B", new Error("three"));
  } finally {
    console.error = orig;
  }
  assert.equal(seen.length, 2, `expected 2 lines (throttle), got ${seen.length}: ${seen}`);
  assert.match(seen[0], /^\[zai-err\] thr-unit-A: one$/);
  assert.match(seen[1], /^\[zai-err\] thr-unit-B: three$/);
});

test("clientIp: x-forwarded-for first value wins, otherwise the socket address", () => {
  const withXff = { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } };
  const noXff = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(clientIp(withXff), "203.0.113.7");
  assert.equal(clientIp(noXff), "127.0.0.1");
});

test("upstreamErrors5m: counts engine-call places only, window slides with fake time", () => {
  const T0 = 1_700_000_000_000;
  // engine places (proxy face + metadata readers) count, internal ones don't
  errLog("prompt", new Error("upstream 500"), { now: T0 });
  errLog("message", new Error("upstream down"), { now: T0 + 60_000 });
  errLog("gcSweep", new Error("internal"), { now: T0 + 120_000 });
  errLog("fetchSessionIndex", new Error("econnrefused"), { now: T0 + 180_000 });
  assert.equal(upstreamErrors5m(T0 + 200_000), 3, `expected 3 engine errors in window, got ${upstreamErrors5m(T0 + 200_000)}`);
  assert.equal(upstreamErrors5m(T0 + 500_000), 0, "older than 5 minutes: window is empty");
});

test("upstreamErrors5m: a second failure inside the window keeps the count rising", () => {
  const T1 = 1_700_100_000_000;
  errLog("session.patch", new Error("x"), { now: T1 });
  assert.equal(upstreamErrors5m(T1 + 1_000), 1);
  errLog("captureResponse", new Error("y"), { now: T1 + 2_000 });
  assert.equal(upstreamErrors5m(T1 + 3_000), 2);
  assert.equal(upstreamErrors5m(T1 + 300_000 + 3_000), 0, "both aged out past the 5-minute window");
});
