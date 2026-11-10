// BUG-180 (BUG-11.16): the REAL server.js against the fake opencode — the
// prompt_async body of a GLM-5.3 turn carries an explicit variant.
// Run: node --test --test-concurrency=1 tests/glm-variant-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "a".repeat(24) + "-glm-variant-" + "4".repeat(24);
const CATALOG = {
  all: [
    { id: "zai-coding-plan", name: "Z.AI", models: {
      "glm-5.3": { id: "glm-5.3", name: "GLM 5.3", capabilities: { input: { text: true, image: false } } },
      "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM 5.3 Flash", capabilities: { input: { text: true, image: true } } },
    } },
    { id: "zai", name: "Z.AI paid", models: { "glm-4.5": { id: "glm-4.5", name: "GLM 4.5", capabilities: { input: { text: true } } } } },
  ],
  connected: ["zai-coding-plan", "zai"],
  default: { "zai-coding-plan": "glm-5.3-flash" },
};
const GLM = (modelID, providerID = "zai-coding-plan") => ({ providerID, modelID });

let up, srv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, { method = "GET", body } = {}) =>
  fetch(srv.base + p, { method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

async function turn(model, extra = {}) {
  const s = await (await api("/zai/api/session", { method: "POST", body: { model } })).json();
  assert.ok(s.id, JSON.stringify(s));
  const before = up.requests.length;
  const r = await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", body: { model, parts: [{ type: "text", text: "Привет" }], ...extra } });
  assert.equal(r.status, 204, await r.text());
  for (let i = 0; i < 100; i++) {
    const hit = up.requests.slice(before).find((x) => x.method === "POST" && x.path === `/session/${s.id}/prompt_async`);
    if (hit) return typeof hit.body === "string" ? JSON.parse(hit.body) : hit.body;
    await sleep(50);
  }
  throw new Error("no prompt_async");
}

before(async () => {
  up = await startFakeOpencode();
  let n = 0;
  up.route("GET", "/provider", () => ({ json: CATALOG }));
  up.route("GET", "/config", () => ({ json: { model: "zai-coding-plan/glm-5.3-flash" } }));
  up.route("GET", "/agent", () => ({ json: [{ name: "Sisyphus - ultraworker", mode: "primary", permission: [] }] }));
  up.route("POST", "/session", (req, body, url) => {
    const s = { id: `ses_var${++n}`, directory: url.searchParams.get("directory"), title: "t", time: { created: Date.now(), updated: Date.now() } };
    up.state.sessions.push(s);
    return { json: s };
  });
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN } });
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("glm-5.3-flash turn without variant → upstream gets variant max", async () => {
  const b = await turn(GLM("glm-5.3-flash"));
  assert.equal(b.variant, "max");
  assert.deepEqual(b.model, GLM("glm-5.3-flash"));
});

test("an explicit variant from the client is kept", async () => {
  const b = await turn(GLM("glm-5.3-flash"), { variant: "low" });
  assert.equal(b.variant, "low");
});

test("glm-5.3 gets max too; another provider gets nothing", async () => {
  assert.equal((await turn(GLM("glm-5.3"))).variant, "max");
  assert.equal("variant" in (await turn(GLM("glm-4.5", "zai"))), false);
});
