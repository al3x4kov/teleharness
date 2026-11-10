// FEAT-16.2 (EPIC-16): the REAL server.js against the fake opencode after OmO → slim.
// An admin chat bound to «Sisyphus - ultraworker» (gone from /agent) runs its turn on
// the opencode default agent (/config default_agent) and the binding follows; a chat on
// a known agent keeps it; creating a chat with a gone agent binds the default;
// /auth/me gives the admin the default agent for new chats.
// Run: node --test --test-concurrency=1 tests/stale-agent-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "a".repeat(24) + "-stale-agent-" + "6".repeat(24);
const FLASH = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const CATALOG = {
  all: [{ id: "zai-coding-plan", name: "Z.AI", models: { "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM 5.3 Flash", capabilities: { input: { text: true, image: true } } } } }],
  connected: ["zai-coding-plan"],
  default: { "zai-coding-plan": "glm-5.3-flash" },
};
const AGENTS = [
  { name: "orchestrator", mode: "primary", permission: [] },
  { name: "Hephaestus - deep worker", mode: "primary", permission: [] },
  { name: "explorer", mode: "subagent", permission: [] },
];

let up, srv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, { method = "GET", body } = {}) =>
  fetch(srv.base + p, { method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

async function create(agent) {
  const s = await (await api("/zai/api/session", { method: "POST", body: { model: FLASH, agent } })).json();
  assert.ok(s.id, JSON.stringify(s));
  return s.id;
}
async function turnAgent(id, agent) {
  const before = up.requests.length;
  const r = await api(`/zai/api/session/${id}/prompt`, { method: "POST", body: { model: FLASH, agent, parts: [{ type: "text", text: "Привет" }] } });
  assert.equal(r.status, 204, await r.text());
  for (let i = 0; i < 100; i++) {
    const hit = up.requests.slice(before).find((x) => x.method === "POST" && x.path === `/session/${id}/prompt_async`);
    if (hit) return (typeof hit.body === "string" ? JSON.parse(hit.body) : hit.body).agent;
    await sleep(50);
  }
  throw new Error("no prompt_async");
}
const boundAgent = async (id) => (await (await api("/zai/api/session")).json()).find((x) => x.id === id)?.zai?.agent;

before(async () => {
  up = await startFakeOpencode();
  let n = 0;
  up.route("GET", "/provider", () => ({ json: CATALOG }));
  up.route("GET", "/config", () => ({ json: { model: "zai-coding-plan/glm-5.3-flash", default_agent: "orchestrator" } }));
  up.route("GET", "/agent", () => ({ json: AGENTS }));
  up.route("POST", "/session", (req, body, url) => {
    const s = { id: `ses_stale${++n}`, directory: url.searchParams.get("directory"), title: "t", time: { created: Date.now(), updated: Date.now() } };
    up.state.sessions.push(s);
    return { json: s };
  });
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN } });
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("an OmO-era chat (bound to Sisyphus) gets its turn on orchestrator, and the binding follows", async () => {
  const id = await create("Sisyphus - ultraworker");
  assert.equal(await turnAgent(id, "Sisyphus - ultraworker"), "orchestrator");
  assert.equal(await boundAgent(id), "orchestrator");
  assert.equal(await turnAgent(id, undefined), "orchestrator", "second turn too");
});

test("a chat on an agent still in the catalog keeps it", async () => {
  const id = await create("Hephaestus - deep worker");
  assert.equal(await turnAgent(id, "Hephaestus - deep worker"), "Hephaestus - deep worker");
  assert.equal(await boundAgent(id), "Hephaestus - deep worker");
});

test("creating a chat with a gone agent binds the default agent right away", async () => {
  const id = await create("Prometheus - Plan Builder");
  assert.equal(await boundAgent(id), "orchestrator");
});

test("/auth/me tells the admin the default agent for new chats", async () => {
  const me = (await (await api("/zai/api/auth/me")).json()).user;
  assert.equal(me.role, "admin");
  assert.equal(me.defaultAgent, "orchestrator");
});
