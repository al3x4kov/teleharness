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
  const dir = mkdtempSync(path.join(tmpdir(), "teleharness-accesslog-"));
  try {
    const log = accessLogger({ dir, enabled: true });
    log({ ts: "2026-11-11T08:00:00.000Z", rid: "abcd1234ef01", method: "GET", path: "/teleharness/", status: 200, ms: 3, user: "admin", ip: "127.0.0.1" });
    await sleep(300); // appendFile is async
    const files = readdirSync(dir).filter((f) => f.startsWith("access-"));
    assert.equal(files.length, 1, `expected one access file, got ${files}`);
    const line = JSON.parse(readFileSync(path.join(dir, files[0]), "utf8").trim());
    assert.equal(line.rid, "abcd1234ef01");
    assert.equal(line.method, "GET");
    assert.equal(line.path, "/teleharness/");
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
  assert.match(seen[0], /^\[teleharness-err\] thr-unit-A: one$/);
  assert.match(seen[1], /^\[teleharness-err\] thr-unit-B: three$/);
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

test("BUG-302 clientIp: XFF игнорируется для внешнего remoteAddress (защита от спуфинга), работает для loopback", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "198.51.100.5" } }), "198.51.100.5");
  assert.equal(clientIp({ headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "::1" } }), "1.2.3.4");
  assert.equal(clientIp({ headers: { "x-forwarded-for": "1.2.3.5" }, socket: { remoteAddress: "::ffff:127.0.0.1" } }), "1.2.3.5");
  assert.equal(clientIp({ headers: { "x-forwarded-for": "1.2.3.4" }, socket: {} }), "");
});

test("BUG-302 accessLogger: prune использует инжектированный now(), а не Date.now()", async () => {
  const { writeFileSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(path.join(tmpdir(), "teleharness-accesslog-prune-"));
  try {
    const oldFile = path.join(dir, "access-20260101.log");
    writeFileSync(oldFile, '{"ok":1}\n', "utf8"); // mtime == сейчас (Date.now())
    // Инжектируем now на 20 дней вперёд: с Date.now() файл не удалится, с now() — удалится
    const future = new Date(Date.now() + 20 * 86_400_000);
    const log = accessLogger({ dir, enabled: true, now: () => future });
    log({ rid: "prune1" });
    await sleep(200);
    assert.equal(existsSync(oldFile), false, "файл старше 14 дней относительно now() должен быть удалён");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("BUG-302 accessLogger: ротация через >2 переполненные части (while вместо if)", async () => {
  const { writeFileSync, truncateSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(path.join(tmpdir(), "teleharness-accesslog-rot-"));
  try {
    const fixed = new Date("2026-11-20T12:00:00.000Z");
    const base = path.join(dir, "access-20261120.log");
    const part1 = path.join(dir, "access-20261120.1.log");
    const part2 = path.join(dir, "access-20261120.2.log");
    writeFileSync(base, "");
    truncateSync(base, 10 * 1024 * 1024 + 10);
    writeFileSync(part1, "");
    truncateSync(part1, 10 * 1024 * 1024 + 10);

    const log = accessLogger({ dir, enabled: true, now: () => fixed });
    log({ rid: "rot-part-2" });
    await sleep(250);
    assert.equal(existsSync(part2), true, "переполненные .log и .1.log должны переключиться на .2.log");
    assert.match(readFileSync(part2, "utf8"), /rot-part-2/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
