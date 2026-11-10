// zai 1.7.2 cold start: right after a server restart /mcp (and other
// catalogs) can hang ~30 s. The home list must show as soon as /session
// answers — a slow /mcp, /provider or /agent never holds the skeleton.
// Catalogs keep their own loading/error state (agent picker «Повторить»).
// Run: node --test tests/components/cold-start-172.test.js
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    HomeView: "src/components/views/HomeView.jsx",
    AgentPicker: "src/components/Pickers.jsx#AgentPicker",
  });
  t$ = createHarness(ui);
});
afterEach(async () => {
  t$.cleanup();
  const s = ui.store;
  s.sessions.value = [];
  s.agents.value = [];
  s.agentsError.value = false;
  s.mcp.value = null;
  s.mcpError.value = false;
  s.providerCfg.value = null;
  s.me.value = null;
  installFetch();
});

const NOW = Date.now();
const ses = (id, title) => ({ id, title, directory: "C:\\Users\\USER", time: { created: NOW, updated: NOW } });

// A route that answers only when released (the hung catalog of a cold start).
function gate(body) {
  let release;
  const p = new Promise((r) => (release = () => r(body)));
  return { reply: () => p, release };
}

test("cold start: a hanging /mcp (+/provider, /agent) does not hold the empty home on the skeleton", async () => {
  ui.store.me.value = { id: "admin", role: "admin" };
  const mcp = gate({});
  const prov = gate({});
  const ag = gate([]);
  installFetch([
    { method: "GET", path: "/zai/api/mcp", reply: mcp.reply },
    { method: "GET", path: "/zai/api/provider", reply: prov.reply },
    { method: "GET", path: "/zai/api/agent", reply: ag.reply },
  ]);
  const { root } = t$.mount(ui.HomeView);
  const hero = await t$.waitFor(() => byText(root, "h2", "Чем займёмся?"));
  assert.ok(hero, "the empty state shows while /mcp is still pending");
  assert.equal($(root, ".sk-list"), null, "no skeleton");
  assert.ok(fetchCalls.some((c) => c.path === "/zai/api/mcp"), "/mcp was asked (in the background)");
  assert.equal(ui.store.mcp.value, null, "/mcp still loading");
  assert.equal(ui.store.mcpError.value, false);
  mcp.release();
  prov.release();
  ag.release();
  await ui.store.loadCatalogs();
});

test("cold start: the chat list renders on /session while /mcp is still pending", async () => {
  ui.store.me.value = { id: "admin", role: "admin" };
  const mcp = gate([{ name: "fs", status: "connected" }]);
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => [ses("ses_a", "Отчёт"), ses("ses_b", "Задача")] },
    { method: "GET", path: "/zai/api/mcp", reply: mcp.reply },
  ]);
  const { root } = t$.mount(ui.HomeView);
  await t$.waitFor(() => $$(root, ".swipe").length === 2);
  assert.equal($(root, ".sk-list"), null);
  assert.equal(ui.store.mcp.value, null);
  mcp.release();
  await ui.store.loadCatalogs();
  await t$.waitFor(() => ui.store.mcp.value != null);
});

test("agents: a failed /agent shows «Повторить» in the picker (not an endless skeleton); retry loads", async () => {
  let fail = true;
  installFetch([
    {
      method: "GET",
      path: "/zai/api/agent",
      reply: () => (fail ? { status: 502, body: { error: "upstream" } } : [{ name: "build", mode: "primary" }]),
    },
  ]);
  await ui.store.refreshAgents();
  assert.equal(ui.store.agentsError.value, true);
  const { root } = t$.mount(ui.AgentPicker, { value: "build", onPick() {} });
  const btn = await t$.waitFor(() => byText(root, "button", "Повторить"));
  fail = false;
  t$.click(btn);
  await t$.waitFor(() => $$(root, ".picker-row").length === 1);
  assert.equal(ui.store.agentsError.value, false);
});
