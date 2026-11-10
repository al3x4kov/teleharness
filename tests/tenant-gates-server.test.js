// Roles dogfood 2026-11-05 (dogfood-output/2026-11-05-roles): the REAL server.js against
// the fake opencode.
//   BUG-158 (BUG-12.23)  tenant GET requests ate the per-minute rate limit (429 on reads)
//   BUG-159 (BUG-11.15)  a tenant could bind a chat to a model outside its /provider
//                        catalog (create, PATCH binding, first prompt) → silent empty turn
// Run: node --test --test-concurrency=1 tests/tenant-gates-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { modelInCatalog } from "../lib/policy.js";

const ADMIN = "a".repeat(24) + "-tenant-gates-" + "2".repeat(24);
const CATALOG = {
  all: [
    { id: "zai-coding-plan", name: "Z.AI", models: { "glm-5.3": { id: "glm-5.3", name: "GLM 5.3" }, "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM 5.3 Flash" } } },
    { id: "openai", name: "OpenAI", models: { "gpt-5": { id: "gpt-5", name: "GPT-5" } } },
  ],
  connected: ["zai-coding-plan"],
  default: { "zai-coding-plan": "glm-5.3", openai: "gpt-5" },
};

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
  up.route("GET", "/provider", () => ({ json: CATALOG }));
  up.route("GET", "/config", () => ({ json: { model: "zai-coding-plan/glm-5.3" } }));
  up.route("GET", "/agent", () => ({ json: [{ name: "Sandbox", mode: "primary", permission: [] }] }));
  up.route("POST", "/session", (req, body, url) => {
    const s = { id: `ses_gate${++n}`, directory: url.searchParams.get("directory"), title: "t", time: { created: Date.now(), updated: Date.now() } };
    up.state.sessions.push(s);
    return { json: s };
  });
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_TENANT_RATE_PER_MIN: "5", ZAI_TENANT_AGENT: "Sandbox" } });
  tenant = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "gates" } })).json();
  assert.ok(tenant.token);
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("modelInCatalog: connected providers only, claude only with the engine, unknown catalog → null", () => {
  assert.equal(modelInCatalog(CATALOG, { providerID: "zai-coding-plan", modelID: "glm-5.3" }), true);
  assert.equal(modelInCatalog(CATALOG, { providerID: "zai-coding-plan", modelID: "no-such-model" }), false);
  assert.equal(modelInCatalog(CATALOG, { providerID: "openai", modelID: "gpt-5" }), false, "not connected");
  const withClaude = { ...CATALOG, all: [...CATALOG.all, { id: "anthropic", models: { "claude-haiku-4-5": {} } }], connected: ["zai-coding-plan", "anthropic"] };
  assert.equal(modelInCatalog(withClaude, { providerID: "anthropic", modelID: "claude-haiku-4-5" }), false);
  assert.equal(modelInCatalog(withClaude, { providerID: "anthropic", modelID: "claude-haiku-4-5" }, { claudeAllowed: true }), true);
  assert.equal(modelInCatalog(null, { providerID: "x", modelID: "y" }), null);
  assert.equal(modelInCatalog({ all: [{ id: "p", models: [{ id: "m" }] }], connected: ["p"] }, { providerID: "p", modelID: "m" }), true, "array form");
});

test("BUG-158: tenant GETs do not count against the rate limit; mutations still do", async () => {
  for (let i = 0; i < 12; i++) {
    const r = await api("/zai/api/about", { token: tenant.token });
    assert.equal(r.status, 200, `GET #${i + 1}`);
  }
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await api("/zai/api/session", { method: "POST", token: tenant.token, body: {} })).status);
  assert.ok(codes.slice(0, 5).every((c) => c < 400), codes.join(","));
  assert.equal(codes.at(-1), 429, codes.join(","));
});

test("BUG-159: a tenant cannot bind a chat to a model outside its catalog; admin is not limited", async () => {
  // a fresh tenant: its own rate window (5 mutations below = the limit)
  const t2 = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "gates2" } })).json();
  let r = await api("/zai/api/session", { method: "POST", token: t2.token, body: { model: { providerID: "openai", modelID: "gpt-5" } } });
  assert.equal(r.status, 403, "create with a foreign model");
  r = await api("/zai/api/session", { method: "POST", token: t2.token, body: { model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" } } });
  assert.equal(r.status, 200, "create with a catalog model");
  const sid = (await r.json()).id;
  r = await api(`/zai/api/session/${sid}/binding`, { method: "PATCH", token: t2.token, body: { model: { providerID: "zai-coding-plan", modelID: "no-such-model" } } });
  assert.equal(r.status, 403, "PATCH binding to an unknown model");
  r = await api(`/zai/api/session/${sid}/binding`, { method: "PATCH", token: t2.token, body: { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } } });
  assert.equal(r.status, 200, "PATCH binding to a catalog model");

  // first prompt into an unbound chat carries the model
  up.state.sessions.push({ id: "ses_unbound", directory: t2.user.directories[0], title: "t" });
  const before = up.requests.filter((x) => x.path === "/session/ses_unbound/prompt_async").length;
  r = await api("/zai/api/session/ses_unbound/prompt", { method: "POST", token: t2.token, body: { model: { providerID: "openai", modelID: "gpt-5" }, parts: [{ type: "text", text: "hi" }] } });
  assert.equal(r.status, 403, "prompt binding a foreign model");
  assert.equal(up.requests.filter((x) => x.path === "/session/ses_unbound/prompt_async").length, before, "nothing reached upstream");

  r = await api("/zai/api/session", { method: "POST", body: { model: { providerID: "openai", modelID: "gpt-5" } } });
  assert.equal(r.status, 200, "admin unchanged");
});
