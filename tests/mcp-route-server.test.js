// BUG-183 (BUG-12.25): GET /zai/api/mcp asked opencode for the DEFAULT instance
// (no `directory` → the serve's cwd, C:\Windows\System32 on prod) — after the
// serve restarts of 2026-11-07 that instance answered 499 with an empty body and
// the portal passed it to the browser (MCP screen + console). Now the portal asks
// the instance the user's chats really run in (defaultDir: admin — ZAI_CHAT_DIR,
// tenant — its own folder), retries a failed upstream once and answers a readable
// 503 instead of a raw 499.
// The REAL server.js against the fake opencode.
// Run: node --test --test-concurrency=1 tests/mcp-route-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import os from "node:os";
import path from "node:path";

const ADMIN = "a".repeat(24) + "-mcp-route-" + "5".repeat(24);
const ALL = {
  websearch: { status: "connected" },
  context7: { status: "connected" },
  playwright: { status: "connected" },
  marketplace: { status: "connected" },
};
let up, srv, tenant;
let mode = "default-broken"; // default-broken | all-broken | flaky
let flakyCalls = 0;
const seen = [];
const api = (p, token = ADMIN) => fetch(srv.base + p, { headers: { authorization: `Bearer ${token}` } });

before(async () => {
  up = await startFakeOpencode();
  up.route("GET", "/mcp", (req, body, url) => {
    const dir = url.searchParams.get("directory");
    seen.push(dir);
    if (mode === "all-broken") return { status: 499, text: "" };
    if (mode === "flaky") return ++flakyCalls === 1 ? { status: 499, text: "" } : { json: ALL };
    return dir ? { json: ALL } : { status: 499, text: "" }; // the stuck default instance of prod
  });
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN } });
  const r = await fetch(srv.base + "/zai/api/admin/users", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "mcpt" }) });
  tenant = await r.json();
  assert.ok(tenant.token);
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("admin: the stuck default instance (499 without directory) no longer breaks the MCP screen — the chats' folder is asked", async () => {
  mode = "default-broken";
  seen.length = 0;
  const r = await api("/zai/api/mcp");
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(Object.keys(await r.json()).sort(), Object.keys(ALL).sort());
  assert.ok(seen.length > 0 && seen.every((d) => d), `every upstream /mcp call names a directory: ${JSON.stringify(seen)}`);
});

test("admin: an explicit ?directory= is kept", async () => {
  mode = "default-broken";
  seen.length = 0;
  const dir = path.join(os.tmpdir(), "zai-mcp-project");
  const r = await api(`/zai/api/mcp?directory=${encodeURIComponent(dir)}`);
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1), dir);
});

test("tenant: asks its own folder, still gets only its servers", async () => {
  mode = "default-broken";
  seen.length = 0;
  const r = await api("/zai/api/mcp", tenant.token);
  assert.equal(r.status, 200, await r.clone().text());
  const names = Object.keys(await r.json());
  assert.ok(!names.includes("playwright"), names.join(","));
  assert.ok(seen.at(-1) && /mcpt/i.test(seen.at(-1)), `tenant folder: ${seen.at(-1)}`);
});

test("a single failed upstream answer is retried once", async () => {
  mode = "flaky";
  flakyCalls = 0;
  const r = await api("/zai/api/mcp");
  assert.equal(r.status, 200);
  assert.ok(flakyCalls >= 2, String(flakyCalls)); // the 499 is healed (MCP asked once more by heal) and retried
});

test("negative: upstream keeps failing → a readable 503, never a raw 499 or an empty body", async () => {
  mode = "all-broken";
  for (const token of [ADMIN, tenant.token]) {
    const r = await api("/zai/api/mcp", token);
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.code, "mcp_unavailable");
    assert.match(j.error, /MCP/);
  }
});
