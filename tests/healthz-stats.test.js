// TASK-12.29 (wave2): server — healthz observability fields: mem (rss/heap
// in whole MB), errors.upstream5m, degraded (rss above ZAI_MEM_WARN_MB; the
// response code still depends only on engine availability), lastCrashAt
// (only after an unclean previous run — run-state.json is planted into the
// data dir before the start), store.authSessionsStale90d; the MOCK branch
// gains mem as well.
// Run: node --test tests/healthz-stats.test.js
// @suite: server
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { makeTmpRoot } from "./helpers/env.mjs";

const ADMIN = "H".repeat(20) + "-healthz-stats-" + "3".repeat(24);

const upstream = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(req.url === "/session" ? JSON.stringify([{ id: "ses_up", directory: "x" }]) : JSON.stringify({ ok: true }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

function tmpWithRunState(state) {
  const tmp = makeTmpRoot();
  writeFileSync(path.join(tmp.data, "run-state.json"), JSON.stringify(state), "utf8");
  return tmp;
}

const crashTmp = tmpWithRunState({ pid: 123456, startedAt: "2026-11-10T01:02:03.000Z", clean: false });
const srv = await spawnPortal({
  upstream: `http://127.0.0.1:${upstream.address().port}`,
  tmp: crashTmp,
  env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_MEM_WARN_MB: "1" },
});
after(async () => {
  await srv.stop();
  upstream.close();
});

const healthz = () => fetch(`${srv.base}/zai/api/healthz`); // direct loopback, Host 127.0.0.1, no x-forwarded-for

test("healthz: mem/errors/degraded/lastCrashAt/stale90d after an unclean previous run; code stays 200", async () => {
  const r = await healthz();
  assert.equal(r.status, 200, `engine is up, degraded must not change the code (got ${r.status})`);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.degraded, true, "rss of any node process is above the 1 MB threshold");
  assert.ok(Number.isInteger(j.mem?.rssMb) && j.mem.rssMb >= 1, `mem.rssMb = ${j.mem?.rssMb}`);
  assert.ok(Number.isInteger(j.mem?.heapUsedMb) && j.mem.heapUsedMb >= 1, `mem.heapUsedMb = ${j.mem?.heapUsedMb}`);
  assert.ok(Number.isInteger(j.errors?.upstream5m), `errors.upstream5m = ${j.errors?.upstream5m}`);
  assert.equal(j.lastCrashAt, "2026-11-10T01:02:03.000Z");
  assert.ok(Number.isInteger(j.store?.authSessionsStale90d), `store.authSessionsStale90d = ${j.store?.authSessionsStale90d}`);
  assert.ok(srv.log.includes("[zai-fatal] previous run ended uncleanly (pid 123456, started 2026-11-10T01:02:03.000Z)"), "crash is logged at start");
});

test("healthz: clean previous run → no lastCrashAt, no crash log, default threshold → degraded false", async () => {
  const cleanTmp = tmpWithRunState({ pid: 42, startedAt: "2026-11-10T09:00:00.000Z", clean: true });
  const srv2 = await spawnPortal({
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    tmp: cleanTmp,
    env: { ZAI_ADMIN_TOKEN: ADMIN },
  });
  try {
    const r = await fetch(`${srv2.base}/zai/api/healthz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal("lastCrashAt" in j, false, "no crash after a clean stop");
    assert.equal(j.degraded, false, "default ZAI_MEM_WARN_MB=1500 is above the rss");
    assert.ok(Number.isInteger(j.store?.authSessionsStale90d));
    assert.ok(!srv2.log.includes("[zai-fatal] previous run ended uncleanly"), "no crash log");
  } finally {
    await srv2.stop();
  }
});

test("healthz MOCK: answers with mem as well", async () => {
  const mockSrv = await spawnPortal({ mock: true, env: { ZAI_ADMIN_TOKEN: ADMIN } });
  try {
    const r = await fetch(`${mockSrv.base}/zai/api/healthz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.mock, true);
    assert.ok(Number.isInteger(j.mem?.rssMb) && Number.isInteger(j.mem?.heapUsedMb), `mock mem = ${JSON.stringify(j.mem)}`);
  } finally {
    await mockSrv.stop();
  }
});
