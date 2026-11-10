// FEAT-03.22 (user system prompt) + FEAT-03.21 (tenant MCP) — the REAL
// server.js against the fake opencode.
// Run: node --test --test-concurrency=1 tests/system-prompt-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import os from "node:os";
import path from "node:path";

// an admin chat folder outside the tenants (absolute on every OS)
const ADMIN_DIR = path.join(os.tmpdir(), "zai-test-admin");

const ADMIN = "a".repeat(24) + "-system-prompt-" + "3".repeat(24);
const CATALOG = {
  all: [{ id: "zai-coding-plan", name: "Z.AI", models: { "glm-5.3": { id: "glm-5.3", name: "GLM 5.3" } } }],
  connected: ["zai-coding-plan"],
  default: { "zai-coding-plan": "glm-5.3" },
};
const MCP = {
  websearch: { status: "connected" },
  context7: { status: "connected" },
  grep_app: { status: "connected" },
  lsp: { status: "connected" },
  playwright: { status: "failed", error: "spawn C:\\Users\\OWNER\\npx ENOENT" },
  marketplace: { status: "failed", error: "MCP error -32000: C:\\Users\\OWNER\\AppData crashed" },
};

let up, srv, alice, bob;
function api(p, { method = "GET", body, token = ADMIN } = {}) {
  return fetch(srv.base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const lastPrompt = (sid) => up.requests.filter((x) => x.method === "POST" && x.path === `/session/${sid}/prompt_async`).at(-1);

before(async () => {
  up = await startFakeOpencode();
  up.route("GET", "/provider", () => ({ json: CATALOG }));
  up.route("GET", "/config", () => ({ json: { model: "zai-coding-plan/glm-5.3" } }));
  // a tenant-safe agent (BUG-12.5 policy): no shell, no delegation, no outside files
  const deny = (permission) => ({ permission, pattern: "*", action: "deny" });
  up.route("GET", "/agent", () => ({ json: [{ name: "Sandbox", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "allow" }, deny("bash"), deny("task"), deny("external_directory")] }] }));
  up.route("GET", "/mcp", () => ({ json: MCP }));
  up.route("POST", "/session/ses_a/prompt_async", () => ({ status: 204 }));
  up.route("POST", "/session/ses_b/prompt_async", () => ({ status: 204 }));
  up.route("POST", "/session/ses_adm/prompt_async", () => ({ status: 204 }));
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_TENANT_AGENT: "Sandbox" } });
  alice = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "sp-alice" } })).json();
  bob = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "sp-bob" } })).json();
  const model = { providerID: "zai-coding-plan", modelID: "glm-5.3" };
  up.state.sessions.push(
    { id: "ses_a", directory: alice.user.directories[0], title: "a", model },
    { id: "ses_b", directory: bob.user.directories[0], title: "b", model },
  );
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("FEAT-03.22: GET/PUT own prompt — per user, admin included; never in the admin's user list", async () => {
  let r = await api("/zai/api/me/system-prompt", { token: alice.token });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { text: "", max: 4000 });

  r = await api("/zai/api/me/system-prompt", { method: "PUT", token: alice.token, body: { text: "  Начинай ответ со слова ПРОБА\r\n" } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).text, "Начинай ответ со слова ПРОБА");
  r = await api("/zai/api/me/system-prompt", { method: "PUT", body: { text: "ADMIN PROMPT" } });
  assert.equal(r.status, 200);

  assert.equal((await (await api("/zai/api/me/system-prompt", { token: alice.token })).json()).text, "Начинай ответ со слова ПРОБА");
  assert.equal((await (await api("/zai/api/me/system-prompt", { token: bob.token })).json()).text, "", "bob sees only his own (empty)");
  assert.equal((await (await api("/zai/api/me/system-prompt")).json()).text, "ADMIN PROMPT");

  const users = await (await api("/zai/api/admin/users")).json();
  assert.equal(JSON.stringify(users).includes("ПРОБА"), false, "the admin's list never carries a user's prompt");
});

test("FEAT-03.22: too long → 400 in Russian, the stored prompt is unchanged; bad body → 400; other methods → 405", async () => {
  let r = await api("/zai/api/me/system-prompt", { method: "PUT", token: alice.token, body: { text: "я".repeat(4001) } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /4000 символов/);
  assert.equal((await (await api("/zai/api/me/system-prompt", { token: alice.token })).json()).text, "Начинай ответ со слова ПРОБА");
  r = await api("/zai/api/me/system-prompt", { method: "PUT", token: alice.token, body: { text: 5 } });
  assert.equal(r.status, 400);
  r = await api("/zai/api/me/system-prompt", { method: "DELETE", token: alice.token });
  assert.equal(r.status, 405);
  r = await fetch(srv.base + "/zai/api/me/system-prompt");
  assert.equal(r.status, 401, "no anonymous access");
});

test("FEAT-03.22: opencode turns carry the user's prompt in `system`; a tenant cannot inject its own; others unaffected", async () => {
  let r = await api("/zai/api/session/ses_a/prompt", { method: "POST", token: alice.token, body: { parts: [{ type: "text", text: "hi" }], system: "SNEAKY" } });
  assert.ok(r.status < 300, `alice prompt ${r.status}`);
  assert.equal(lastPrompt("ses_a").body.system, "Начинай ответ со слова ПРОБА");
  // the same text rides the turn as a hidden synthetic part (agents with long prompts follow it in existing chats)
  const rem = lastPrompt("ses_a").body.parts.filter((p) => p.synthetic && /<system-reminder>/.test(p.text));
  assert.equal(rem.length, 1);
  assert.match(rem[0].text, /Начинай ответ со слова ПРОБА/);

  r = await api("/zai/api/session/ses_b/prompt", { method: "POST", token: bob.token, body: { parts: [{ type: "text", text: "hi" }], system: "SNEAKY" } });
  assert.ok(r.status < 300, `bob prompt ${r.status}`);
  assert.equal("system" in lastPrompt("ses_b").body, false, "bob: no prompt of his own, alice's never leaks, his injected one is dropped");
  assert.equal(JSON.stringify(lastPrompt("ses_b").body).includes("ПРОБА"), false, "no reminder of alice's prompt in bob's turn");

  // cleared → the next turn goes with the built-in prompt only
  r = await api("/zai/api/me/system-prompt", { method: "PUT", token: alice.token, body: { text: "" } });
  assert.equal((await r.json()).text, "");
  await api("/zai/api/session/ses_a/prompt", { method: "POST", token: alice.token, body: { parts: [{ type: "text", text: "hi" }] } });
  assert.equal("system" in lastPrompt("ses_a").body, false);
});

test("FEAT-03.22: admin turns carry the admin's prompt", async () => {
  up.state.sessions.push({ id: "ses_adm", directory: ADMIN_DIR, title: "adm", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } });
  const r = await api("/zai/api/session/ses_adm/prompt?directory=" + encodeURIComponent(ADMIN_DIR), {
    method: "POST",
    body: { parts: [{ type: "text", text: "hi" }], model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } },
  });
  assert.ok(r.status < 300, `admin prompt ${r.status}`);
  assert.equal(lastPrompt("ses_adm").body.system, "ADMIN PROMPT");
});

test("FEAT-03.21: /mcp — tenant gets its whitelisted servers with status only; admin gets everything", async () => {
  let r = await api("/zai/api/mcp", { token: alice.token });
  assert.equal(r.status, 200);
  const t = await r.json();
  assert.deepEqual(Object.keys(t).sort(), ["context7", "grep_app", "marketplace", "websearch"]);
  assert.deepEqual(t.marketplace, { status: "failed" });
  assert.equal(JSON.stringify(t).includes("OWNER"), false, "no owner paths in a tenant's answer");

  r = await api("/zai/api/mcp");
  assert.equal(r.status, 200);
  const a = await r.json();
  assert.ok(a.playwright && a.lsp, "admin: full list");
  assert.match(a.playwright.error, /ENOENT/, "admin: the cause stays");

  assert.equal((await api("/zai/api/host", { token: alice.token })).status, 403, "host stays admin-only");
});
