// FEAT-01.69 (П31.У2, Н2, Н3, Н11): pinned chats in the account — the REAL
// server.js against the fake opencode. Per-user isolation (admin and
// tenants), a foreign or unknown id is refused with the same 404, a deleted
// chat leaves every user's pins, a deleted account takes its pins along.
// Run: node --test --test-concurrency=1 tests/pins-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import os from "node:os";
import path from "node:path";

const ADMIN = "p".repeat(24) + "-pins-server-" + "7".repeat(24);
let up, srv, alice, bob;

function api(p, { method = "GET", body, token = ADMIN } = {}) {
  return fetch(srv.base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const pins = async (token) => (await (await api("/zai/api/me/pins", { token })).json()).ids;
const put = (ids, token) => api("/zai/api/me/pins", { method: "PUT", token, body: { ids } });

before(async () => {
  up = await startFakeOpencode();
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN } });
  alice = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "pin-alice" } })).json();
  bob = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "pin-bob" } })).json();
  up.state.sessions.push(
    { id: "ses_a1", directory: alice.user.directories[0], title: "a1" },
    { id: "ses_a2", directory: alice.user.directories[0], title: "a2" },
    { id: "ses_b1", directory: bob.user.directories[0], title: "b1" },
    { id: "ses_adm", directory: path.join(os.tmpdir(), "zai-test-admin"), title: "adm" },
  );
  // DELETE upstream: the record goes away like in opencode
  up.fallback((req, _body, url) => {
    const m = /^\/session\/([^/]+)$/.exec(url.pathname);
    if (!m || req.method !== "DELETE") return null;
    const i = up.state.sessions.findIndex((s) => s.id === decodeURIComponent(m[1]));
    if (i < 0) return { status: 404, json: { error: "not found" } };
    up.state.sessions.splice(i, 1);
    return { json: true };
  });
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("GET: empty by default for every role; anonymous → 401; other methods → 405", async () => {
  assert.deepEqual(await pins(alice.token), []);
  assert.deepEqual(await pins(ADMIN), []);
  const r = await api("/zai/api/me/pins", { token: alice.token });
  assert.equal((await r.json()).max, 200);
  assert.equal((await fetch(srv.base + "/zai/api/me/pins")).status, 401);
  assert.equal((await api("/zai/api/me/pins", { method: "DELETE", token: alice.token })).status, 405);
  assert.equal((await api("/zai/api/me/pins", { method: "PUT", token: alice.token, body: { ids: "ses_a1" } })).status, 400);
});

test("PUT: own chats pinned in order, duplicates and junk collapsed; isolated per user (admin included)", async () => {
  let r = await put(["ses_a2", "ses_a1", "ses_a2", 5, "../x", ""], alice.token);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).ids, ["ses_a2", "ses_a1"]);
  r = await put(["ses_adm", "ses_a1"], ADMIN); // admin sees every chat
  assert.equal(r.status, 200);
  assert.deepEqual(await pins(alice.token), ["ses_a2", "ses_a1"], "another device of alice sees the same list");
  assert.deepEqual(await pins(bob.token), [], "bob never sees alice's pins");
  assert.deepEqual(await pins(ADMIN), ["ses_adm", "ses_a1"]);
  const users = await (await api("/zai/api/admin/users")).json();
  assert.equal(JSON.stringify(users).includes("ses_a2"), false, "the admin's user list never carries pins");
});

test("Н11: a tenant cannot pin a foreign or an unknown chat — the same 404, nothing stored, no detail", async () => {
  const foreign = await put(["ses_b1"], alice.token);
  const unknown = await put(["ses_nope"], alice.token);
  assert.equal(foreign.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await foreign.json(), await unknown.json(), "foreign = unknown: existence is not leaked");
  assert.deepEqual(await pins(alice.token), ["ses_a2", "ses_a1"], "the stored list is untouched");
  const mixed = await put(["ses_a1", "ses_adm"], alice.token);
  assert.equal(mixed.status, 404, "the admin's chat is foreign for a tenant");
  assert.deepEqual(await pins(alice.token), ["ses_a2", "ses_a1"]);
});

test("Н3: deleting a chat removes it from every user's pins (owner and admin)", async () => {
  let r = await api("/zai/api/session/ses_a1", { method: "DELETE", token: alice.token });
  assert.ok(r.status < 300, `delete ${r.status}`);
  assert.deepEqual(await pins(alice.token), ["ses_a2"]);
  assert.deepEqual(await pins(ADMIN), ["ses_adm"], "the admin's pin of alice's chat went too");
  // a chat gone upstream behind the portal's back is not returned either
  up.state.sessions.splice(up.state.sessions.findIndex((s) => s.id === "ses_a2"), 1);
  r = await put([], alice.token); // the cache refresh path: PUT with nothing new is fine
  assert.equal(r.status, 200);
  assert.deepEqual(await pins(alice.token), []);
});

test("Н2: pinning a chat deleted elsewhere → 404 (the client says «Чат уже удалён»)", async () => {
  const r = await put(["ses_a1"], alice.token);
  assert.equal(r.status, 404);
});

test("Н3: deleting the account deletes its pins; others keep theirs", async () => {
  assert.equal((await put(["ses_b1"], bob.token)).status, 200);
  assert.equal((await put(["ses_b1", "ses_adm"], ADMIN)).status, 200);
  const r = await api(`/zai/api/admin/users/${encodeURIComponent(bob.user.id)}`, { method: "DELETE" });
  assert.ok(r.status < 300, `delete account ${r.status}`);
  assert.equal((await api("/zai/api/me/pins", { token: bob.token })).status, 401, "bob's token is gone");
  const left = await pins(ADMIN);
  assert.equal(left.includes("ses_b1"), false, "bob's chat (deleted with the account) left the admin's pins");
  assert.ok(left.includes("ses_adm"));
});

// BUG-177: device keyboard trace — admin only.
test("BUG-177: POST /zai/api/diag/kb — admin 204, bad body 400, user 403", async () => {
  const ok = await api("/zai/api/diag/kb", { method: "POST", body: { kind: "focus", frames: [{ t: 0, vvH: 956 }] } });
  assert.equal(ok.status, 204);
  const bad = await api("/zai/api/diag/kb", { method: "POST", body: { frames: "x" } });
  assert.equal(bad.status, 400);
  const u = await api("/zai/api/diag/kb", { method: "POST", token: alice.token, body: { frames: [] } });
  assert.equal(u.status, 403);
});
