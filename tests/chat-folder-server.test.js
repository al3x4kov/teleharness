// FEAT-04.12 stage B through the REAL server.js against the fake opencode:
// a NEW tenant chat gets <tenant folder>\chats\<id> (+ .zai-uploads junction);
// the session directory stays the tenant folder; admin chats get nothing.
// Run: node --test --test-concurrency=1 tests/chat-folder-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "a".repeat(24) + "-chat-folder-" + "4".repeat(24);
let up, srv, tenant;
function api(p, { method = "GET", body, token = ADMIN } = {}) {
  return fetch(srv.base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  up = await startFakeOpencode();
  let n = 0;
  up.route("GET", "/agent", () => ({ json: [{ name: "Sandbox", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "allow" }, { permission: "task", pattern: "*", action: "deny" }, { permission: "external_directory", pattern: "*", action: "deny" }] }] }));
  up.route("POST", "/session", (req, body, url) => {
    const s = { id: `ses_cf${++n}X`, directory: url.searchParams.get("directory"), title: "t", time: { created: Date.now(), updated: Date.now() } };
    up.state.sessions.push(s);
    return { json: s };
  });
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_TENANT_AGENT: "Sandbox" } });
  tenant = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "folders" } })).json();
  assert.ok(tenant.token);
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("новый чат тенанта: папка сессии — корень тенанта, рабочая подпапка chats\\<id> с .zai-uploads", async () => {
  const r = await api("/zai/api/session", { method: "POST", token: tenant.token, body: {} });
  assert.equal(r.status, 200, await r.clone().text());
  const s = await r.json();
  const root = tenant.user.directories[0];
  assert.equal(path.resolve(s.directory).toLowerCase(), path.resolve(root).toLowerCase(), "session.directory не меняется");
  const dir = path.join(root, "chats", s.id.replace(/^ses_/, ""));
  assert.ok(existsSync(dir) && lstatSync(dir).isDirectory(), dir);
  assert.ok(lstatSync(path.join(dir, ".zai-uploads")).isSymbolicLink());
  const r2 = await api("/zai/api/session", { method: "POST", token: tenant.token, body: {} });
  const s2 = await r2.json();
  assert.notEqual(s2.id, s.id);
  assert.ok(existsSync(path.join(root, "chats", s2.id.replace(/^ses_/, ""))), "у второго чата — своя папка");
});

test("админ-чат: подпапок не создаётся", async () => {
  const r = await api("/zai/api/session", { method: "POST", body: {} });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(existsSync(path.join(s.directory, "chats", s.id.replace(/^ses_/, ""))), false);
});
