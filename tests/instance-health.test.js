// BUG-183 (BUG-12.25) root cause: opencode 1.19.5 builds per-folder services (Provider, MCP, …) as
// InstanceState = an Effect ScopedCache whose lookup runs in the FIRST caller's fiber and whose Exit —
// an interruption too — is cached for good. A request aborted during a lazy init (portal timeout 30 s
// == opencode MCP connect timeout 30 s; a «Стоп» in the first turn of a new folder) poisons that
// service for the folder: /mcp → 499, /provider → 503, every turn → «Aborted». lib/instance-health.js:
// warm(dir) initializes them with a request that is never aborted early; heal(dir) finds a poisoned
// folder before a prompt and disposes its instance (only when nothing runs there).
// Run: node --test tests/instance-health.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInstanceHealth } from "../lib/instance-health.js";

function fakeUpstream(script = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method ?? "GET", path: u.pathname, dir: u.searchParams.get("directory"), timeoutGiven: !!opts.signal });
    const key = `${opts.method ?? "GET"} ${u.pathname}`;
    const h = script[key];
    const r = typeof h === "function" ? await h(u, calls) : h ?? { status: 200, body: "{}" };
    return new Response(r.body ?? "", { status: r.status ?? 200 });
  };
  return { calls, fetchImpl };
}
const DIR = "C:\\Users\\USER\\.zai-tenants\\alice";

test("warm: providers then MCP of the folder, once per folder; concurrent callers share it", async () => {
  const up = fakeUpstream();
  const h = createInstanceHealth({ upstream: "http://oc", fetchImpl: up.fetchImpl, log: () => {} });
  await Promise.all([h.warm(DIR), h.warm(DIR)]);
  await h.warm(DIR);
  const paths = up.calls.map((c) => `${c.path}@${c.dir}`);
  assert.deepEqual(paths, [`/config/providers@${DIR}`, `/mcp@${DIR}`]);
  assert.ok(up.calls.every((c) => c.timeoutGiven), "bounded, but by the long warm timeout");
});

test("warm never uses a timeout at or below opencode's MCP connect timeout (30 s)", () => {
  const h = createInstanceHealth({ upstream: "http://oc", fetchImpl: async () => new Response("{}"), log: () => {} });
  assert.ok(h.warmTimeoutMs > 30_000 + 15_000, String(h.warmTimeoutMs));
});

test("heal: a healthy folder is left alone", async () => {
  const up = fakeUpstream();
  const h = createInstanceHealth({ upstream: "http://oc", fetchImpl: up.fetchImpl, log: () => {} });
  assert.equal(await h.heal(DIR), false);
  assert.equal(up.calls.filter((c) => c.method === "POST").length, 0);
});

test("heal: poisoned providers (503) or MCP (499) → dispose that folder's instance, warm again next time", async () => {
  for (const poisoned of ["GET /config/providers", "GET /mcp"]) {
    let disposed = false;
    const up = fakeUpstream({
      [poisoned]: () => (disposed ? { status: 200, body: "{}" } : { status: poisoned.endsWith("mcp") ? 499 : 503, body: "" }),
      "POST /instance/dispose": () => ((disposed = true), { status: 200, body: "true" }),
      "GET /session/status": { status: 200, body: "{}" },
    });
    const logs = [];
    const h = createInstanceHealth({ upstream: "http://oc", fetchImpl: up.fetchImpl, log: (m) => logs.push(m) });
    await h.warm(DIR);
    assert.equal(await h.heal(DIR), true, poisoned);
    const d = up.calls.find((c) => c.method === "POST" && c.path === "/instance/dispose");
    assert.equal(d?.dir, DIR);
    assert.ok(logs.some((l) => /poisoned/.test(l) && l.includes(DIR)), logs.join("\n"));
    up.calls.length = 0;
    await h.warm(DIR);
    assert.ok(up.calls.some((c) => c.path === "/config/providers"), "warm runs again after a dispose");
  }
});

test("negative: never disposes a folder where a turn is running", async () => {
  const up = fakeUpstream({
    "GET /config/providers": { status: 503, body: "" },
    "GET /session/status": { status: 200, body: JSON.stringify({ ses_1: { type: "busy" } }) },
  });
  const logs = [];
  const h = createInstanceHealth({ upstream: "http://oc", fetchImpl: up.fetchImpl, log: (m) => logs.push(m) });
  assert.equal(await h.heal(DIR), false);
  assert.equal(up.calls.filter((c) => c.method === "POST").length, 0);
  assert.ok(logs.some((l) => /busy/.test(l)));
});

test("negative: an unreachable upstream (network error) is not «poisoned» — no dispose", async () => {
  const h = createInstanceHealth({ upstream: "http://oc", fetchImpl: async () => { throw new TypeError("fetch failed"); }, log: () => {} });
  assert.equal(await h.heal(DIR), false);
  await h.warm(DIR); // swallowed
});

test("ready(dir): waits for an in-flight warm-up, but not longer than the cap", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const up = fakeUpstream({ "GET /mcp": async () => (await gate, { status: 200, body: "{}" }) });
  const h = createInstanceHealth({ upstream: "http://oc", fetchImpl: up.fetchImpl, log: () => {}, readyCapMs: 200 });
  h.warm(DIR);
  const t0 = Date.now();
  await h.ready(DIR);
  assert.ok(Date.now() - t0 < 1000, "capped");
  release();
  await h.warm(DIR);
});

// ---- BUG-218 (SRV-14, design §3): dispose-гонки ------------------------------
// Занятость, появившаяся во время dispose, видна в логе как конфликт; повторная
// проверка занятости непосредственно перед dispose не даёт убить начавшийся ход.

test("BUG-218 heal: занятость, появившаяся во время dispose, фиксируется («dispose raced a starting turn»)", async () => {
  let disposed = false;
  const up = fakeUpstream({
    "GET /config/providers": { status: 503, body: "" },
    "POST /instance/dispose": () => ((disposed = true), { status: 200, body: "true" }),
    // busy=false до dispose (ход ещё не начался), busy=true после — ход стартовал в окне
    "GET /session/status": () => ({ status: 200, body: disposed ? JSON.stringify({ ses_race: { type: "busy" } }) : "{}" }),
  });
  const logs = [];
  const h = createInstanceHealth({ upstream: "http://oc", fetchImpl: up.fetchImpl, log: (m) => logs.push(m) });
  assert.equal(await h.heal(DIR), true, "dispose выполнен (отменить начатый нельзя)");
  assert.ok(logs.some((l) => l.includes("dispose raced a starting turn") && l.includes(DIR)), logs.join("\n"));
});

test("BUG-218 heal: тихий dispose без гонки — записи о гонке нет", async () => {
  const up = fakeUpstream({
    "GET /config/providers": { status: 503, body: "" },
    "GET /session/status": { status: 200, body: "{}" },
  });
  const logs = [];
  const h = createInstanceHealth({ upstream: "http://oc", fetchImpl: up.fetchImpl, log: (m) => logs.push(m) });
  assert.equal(await h.heal(DIR), true);
  assert.equal(logs.some((l) => l.includes("dispose raced a starting turn")), false, logs.join("\n"));
});

// Тот же контракт SRV-14 для реапера (lib/instance-reaper.js): busy, возникший
// между проверкой и dispose, отменяет dispose; busy после dispose — лог гонки.
import { createInstanceReaper } from "../lib/instance-reaper.js";

test("BUG-218 reaper: занятость перед dispose — dispose отменён (даже если первая проверка была пустой)", async () => {
  let checked = 0;
  const disposed = [];
  const logs = [];
  const r = createInstanceReaper({
    idleMs: 60_000,
    isBusy: async () => (checked++ === 0 ? false : true), // 1-я проверка пусто, 2-я (перед dispose) — ход
    dispose: async (d) => disposed.push(d),
    log: (m) => logs.push(m),
  });
  r.touch("C:\\x", 0);
  const out = await r.sweep(61_000);
  assert.deepEqual(disposed, [], "dispose не вызван");
  assert.equal(out.busy, 1);
  assert.equal(out.disposed, 0);
});

test("BUG-218 reaper: занятость, появившаяся во время dispose, фиксируется в логе", async () => {
  let disposed = false;
  const logs = [];
  const r = createInstanceReaper({
    idleMs: 60_000,
    isBusy: async () => disposed, // до dispose пусто, после dispose — ход уже идёт
    dispose: async () => {
      disposed = true;
    },
    log: (m) => logs.push(m),
  });
  r.touch("C:\\y", 0);
  const out = await r.sweep(61_000);
  assert.equal(out.disposed, 1, "dispose выполнен");
  assert.ok(logs.some((l) => l.includes("dispose raced a starting turn") && l.includes("C:\\y")), logs.join("\n"));
});
