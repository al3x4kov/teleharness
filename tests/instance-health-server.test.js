// BUG-183 (BUG-12.25), end to end with the REAL server.js and the fake opencode:
// - a new opencode chat warms its folder (providers, then MCP) right away;
// - a prompt into a poisoned folder (providers 503) disposes the instance first, then the turn goes;
// - a busy folder is never disposed.
// Run: node --test --test-concurrency=1 tests/instance-health-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "a".repeat(24) + "-inst-health-" + "6".repeat(24);
const M = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
let up, srv;
let poisoned = new Set();
let busyDirs = new Set();
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, { method = "GET", body } = {}) =>
  fetch(srv.base + p, { method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

before(async () => {
  up = await startFakeOpencode();
  let n = 0;
  const dirOf = (url) => url.searchParams.get("directory");
  up.route("GET", "/config/providers", (req, body, url) => {
    log.push(`providers ${dirOf(url)}`);
    return poisoned.has(dirOf(url)) ? { status: 503, text: "" } : { json: { providers: [], default: {} } };
  });
  up.route("GET", "/mcp", (req, body, url) => (log.push(`mcp ${dirOf(url)}`), { json: {} }));
  up.route("GET", "/session/status", (req, body, url) => ({ json: busyDirs.has(dirOf(url)) ? { ses_busy: { type: "busy" } } : {} }));
  up.route("POST", "/instance/dispose", (req, body, url) => (log.push(`dispose ${dirOf(url)}`), poisoned.delete(dirOf(url)), { json: true }));
  up.route("POST", "/session", (req, body, url) => {
    const s = { id: `ses_ih${++n}`, directory: dirOf(url), title: "t", time: { created: Date.now(), updated: Date.now() } };
    up.state.sessions.push(s);
    return { json: s };
  });
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN } });
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

async function newChat() {
  const s = await (await api("/zai/api/session", { method: "POST", body: { model: M } })).json();
  assert.ok(s.id, JSON.stringify(s));
  return s;
}
async function waitFor(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(30); }
  return false;
}

test("a new opencode chat warms its folder: providers, then MCP — before any prompt", async () => {
  log.length = 0;
  const s = await newChat();
  assert.ok(await waitFor(() => log.includes(`mcp ${s.directory}`)), log.join("\n"));
  assert.ok(log.indexOf(`providers ${s.directory}`) < log.indexOf(`mcp ${s.directory}`));
});

test("a poisoned folder (providers 503) is disposed before the prompt goes upstream", async () => {
  const s = await newChat();
  await waitFor(() => log.includes(`mcp ${s.directory}`));
  poisoned.add(s.directory);
  log.length = 0;
  const before = up.requests.length;
  const r = await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", body: { model: M, parts: [{ type: "text", text: "привет" }] } });
  assert.equal(r.status, 204, await r.text());
  assert.ok(await waitFor(() => up.requests.slice(before).some((x) => x.path === `/session/${s.id}/prompt_async`)));
  const iDispose = log.indexOf(`dispose ${s.directory}`);
  assert.ok(iDispose >= 0, log.join("\n"));
  const promptAt = up.requests.slice(before).findIndex((x) => x.path === `/session/${s.id}/prompt_async`);
  const disposeAt = up.requests.slice(before).findIndex((x) => x.path === "/instance/dispose");
  assert.ok(disposeAt >= 0 && disposeAt < promptAt, "dispose before prompt_async");
});

test("negative: a healthy folder is never disposed; a busy poisoned folder is left alone", async () => {
  const s = await newChat();
  await waitFor(() => log.includes(`mcp ${s.directory}`));
  log.length = 0;
  await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", body: { model: M, parts: [{ type: "text", text: "раз" }] } });
  await sleep(300);
  assert.equal(log.filter((l) => l.startsWith("dispose")).length, 0, log.join("\n"));
  poisoned.add(s.directory);
  busyDirs.add(s.directory);
  log.length = 0;
  await api(`/zai/api/session/${s.id}/prompt`, { method: "POST", body: { model: M, parts: [{ type: "text", text: "два" }] } });
  await sleep(300);
  assert.equal(log.filter((l) => l.startsWith("dispose")).length, 0, log.join("\n"));
  busyDirs.delete(s.directory);
  poisoned.delete(s.directory);
});
