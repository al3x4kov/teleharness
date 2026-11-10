// BUG-163 (BUG-04.12): a tenant has no vision subagent (Sandbox: task deny), so
// its picture on a text-only opencode model went nowhere. Now that one turn runs
// on a vision model of the same provider (ZAI_TENANT_VISION_MODEL), the picture
// stays inline, the chat binding stays. Admin keeps the BUG-140 path (look_at).
// The REAL server.js against the fake opencode.
// Run: node --test --test-concurrency=1 tests/tenant-vision-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "a".repeat(24) + "-tenant-vision-" + "3".repeat(24);
const CATALOG = {
  all: [
    { id: "zai-coding-plan", name: "Z.AI", models: {
      "glm-5.3": { id: "glm-5.3", name: "GLM 5.3", capabilities: { input: { text: true, image: false } } },
      "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM 5.3 Flash", capabilities: { input: { text: true, image: true } } },
    } },
  ],
  connected: ["zai-coding-plan"],
  default: { "zai-coding-plan": "glm-5.3" },
};
const PNG = { type: "file", mime: "image/png", filename: "vision.png", url: "data:image/png;base64,iVBORw0KGgo=" };
const GLM = (modelID) => ({ providerID: "zai-coding-plan", modelID });

let up, srv, tenant;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function api(p, { method = "GET", body, token = ADMIN } = {}) {
  return fetch(srv.base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function upstreamPrompt(sid, before) {
  for (let i = 0; i < 100; i++) {
    const hit = up.requests.slice(before).find((x) => x.method === "POST" && x.path === `/session/${sid}/prompt_async`);
    if (hit) return typeof hit.body === "string" ? JSON.parse(hit.body) : hit.body;
    await sleep(50);
  }
  throw new Error(`no prompt_async for ${sid}`);
}
async function send(token, sid, parts) {
  const before = up.requests.length;
  const r = await api(`/zai/api/session/${sid}/prompt`, { method: "POST", token, body: { model: GLM("glm-5.3"), parts } });
  assert.equal(r.status, 204, await r.text());
  return upstreamPrompt(sid, before);
}

before(async () => {
  up = await startFakeOpencode();
  let n = 0;
  up.route("GET", "/provider", () => ({ json: CATALOG }));
  up.route("GET", "/config", () => ({ json: { model: "zai-coding-plan/glm-5.3" } }));
  const deny = (permission) => ({ permission, pattern: "*", action: "deny" });
  const sandbox = [{ permission: "*", pattern: "*", action: "allow" }, deny("bash"), deny("task"), deny("external_directory")];
  up.route("GET", "/agent", () => ({ json: [{ name: "Sandbox", mode: "primary", permission: sandbox }, { name: "Sisyphus", mode: "primary", permission: [] }] }));
  up.route("POST", "/session", (req, body, url) => {
    const s = { id: `ses_vis${++n}`, directory: url.searchParams.get("directory"), title: "t", time: { created: Date.now(), updated: Date.now() } };
    up.state.sessions.push(s);
    return { json: s };
  });
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_TENANT_AGENT: "Sandbox" } });
  tenant = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "vision" } })).json();
  assert.ok(tenant.token);
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("BUG-163: tenant picture on glm-5.3 → this turn on glm-5.3-flash with the picture inline; the next text turn stays on glm-5.3", async () => {
  const s = await (await api("/zai/api/session", { method: "POST", token: tenant.token, body: { model: GLM("glm-5.3") } })).json();
  assert.ok(s.id, JSON.stringify(s));
  const pic = await send(tenant.token, s.id, [{ type: "text", text: "Опиши картинку" }, PNG]);
  assert.deepEqual(pic.model, GLM("glm-5.3-flash"), "the picture turn goes to the vision model");
  assert.equal(pic.parts.filter((x) => x.type === "file").length, 1, "the picture stays inline");
  assert.equal(pic.parts.some((x) => x.type === "text" && /look_at/.test(x.text)), false, "no look_at hint for a tenant");
  assert.equal(pic.agent, "Sandbox");
  const txt = await send(tenant.token, s.id, [{ type: "text", text: "А теперь просто привет" }]);
  assert.deepEqual(txt.model, GLM("glm-5.3"), "the chat binding is not changed");
});

test("BUG-163: tenant picture on a vision model and tenant text turns are untouched", async () => {
  const s = await (await api("/zai/api/session", { method: "POST", token: tenant.token, body: { model: GLM("glm-5.3-flash") } })).json();
  const before = up.requests.length;
  const r = await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", token: tenant.token, body: { model: GLM("glm-5.3-flash"), parts: [{ type: "text", text: "Что тут?" }, PNG] } });
  assert.equal(r.status, 204);
  const body = await upstreamPrompt(s.id, before);
  assert.deepEqual(body.model, GLM("glm-5.3-flash"));
  assert.equal(body.parts.filter((x) => x.type === "file").length, 1);
});

test("BUG-163: admin keeps BUG-140 — picture on glm-5.3 stays on glm-5.3 as a file path for look_at", async () => {
  const s = await (await api("/zai/api/session", { method: "POST", body: { model: GLM("glm-5.3") } })).json();
  const body = await send(ADMIN, s.id, [{ type: "text", text: "Опиши картинку" }, PNG]);
  assert.deepEqual(body.model, GLM("glm-5.3"));
  assert.equal(body.parts.some((x) => x.type === "file"), false);
  assert.ok(body.parts.some((x) => x.type === "text" && /look_at/.test(x.text)), JSON.stringify(body.parts));
});
