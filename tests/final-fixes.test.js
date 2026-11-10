// Final review 2026-11-02 fixes (ISSUE-001…009): tenant-safe defaults,
// policy texts, Claude queue order, offline bar, rename/delete rollback,
// workdir errors, service agents. No network: fetch is stubbed per test.
// Run: node --test tests/final-fixes.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as store from "../src/lib/store.js";
import { explainApiError } from "../src/lib/api.js";
import { describeTurnError } from "../src/lib/turn.js";
import { collectArtifacts, makeMessage } from "../src/lib/normalize.js";
import { noteAlive, onStreamStatus } from "../src/lib/store/stream.js";

const { active, connection, handleEvent, notice, sessions, setNotice } = store;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const ok = (body, status = 200) => ({ ok: true, status, json: async () => body, headers: { get: () => null } });
const fail = (status, body = {}) => ({ ok: false, status, json: async () => body, headers: { get: () => null } });

function stubFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const c = { url: String(url), path: String(url).split("?")[0], method: opts.method ?? "GET", body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(c);
    return handler(c);
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}

const TENANT = { id: "qa", role: "user", engines: ["opencode"], defaultAgent: "Prometheus - Plan Builder", directories: ["D:\\T\\qa"] };
const AGENTS = [
  { name: "Prometheus - Plan Builder", mode: "primary" },
  { name: "multimodal-looker", mode: "subagent" },
];

// ---- ISSUE-001/002: sanitized defaults --------------------------------------

test("ISSUE-001: a tenant never gets a refused agent or engine as default", () => {
  const p = { model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" }, agent: "Sisyphus - ultraworker" };
  const out = store.sanitizePrefs(p, { user: TENANT, agents: AGENTS });
  assert.equal(out.model.providerID, "zai-coding-plan", "Claude without the grant → z.ai default model");
  assert.equal(out.agent, "Prometheus - Plan Builder", "server default agent");
  // catalog not loaded yet: the server default is trusted
  assert.equal(store.sanitizePrefs(p, { user: TENANT, agents: [] }).agent, "Prometheus - Plan Builder");
  // an allowed explicit choice stays
  assert.equal(store.sanitizePrefs({ ...p, agent: "multimodal-looker" }, { user: TENANT, agents: AGENTS }).agent, "multimodal-looker");
  // admin keeps a catalog agent and the model (no Claude agent unless picked — FEAT-13.17)
  const pa = { ...p, agent: "Prometheus - Plan Builder" };
  assert.deepEqual(store.sanitizePrefs(pa, { user: { id: "admin", role: "admin" }, agents: AGENTS }), { ...pa, claudeAgent: null });
});

test("FEAT-16.2: admin's saved agent gone from the catalog (OmO → slim) → server default, else first primary; unknown catalog → kept", () => {
  const p = { model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }, agent: "Sisyphus - ultraworker" };
  const SLIM = [{ name: "Hephaestus - deep worker", mode: "primary" }, { name: "orchestrator", mode: "primary" }, { name: "explorer", mode: "subagent" }];
  const admin = { id: "admin", role: "admin", defaultAgent: "orchestrator" };
  assert.equal(store.sanitizePrefs(p, { user: admin, agents: SLIM }).agent, "orchestrator");
  assert.equal(store.sanitizePrefs(p, { user: { id: "admin", role: "admin" }, agents: SLIM }).agent, "Hephaestus - deep worker", "no server default → first primary");
  assert.equal(store.sanitizePrefs(p, { user: admin, agents: [] }).agent, "Sisyphus - ultraworker", "catalog not loaded → kept");
  assert.equal(store.sanitizePrefs({ ...p, agent: "Hephaestus - deep worker" }, { user: admin, agents: SLIM }).agent, "Hephaestus - deep worker");
  assert.equal(store.sanitizePrefs({ model: p.model }, { user: admin, agents: SLIM }).agent, "orchestrator", "fresh profile → orchestrator");
});

test("FEAT-13.17: claudeAgent pref — admin keeps a catalog agent, unknown/missing → null, tenant never has one", () => {
  const admin = { id: "admin", role: "admin" };
  const p = { model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent: "Sisyphus - ultraworker", claudeAgent: "workflow" };
  const cat = [{ id: "workflow", name: "Workflow", description: "d" }];
  assert.equal(store.sanitizePrefs(p, { user: admin, claudeAgents: cat }).claudeAgent, "workflow");
  assert.equal(store.sanitizePrefs(p, { user: admin, claudeAgents: null }).claudeAgent, "workflow", "catalog not loaded yet: kept");
  assert.equal(store.sanitizePrefs(p, { user: admin, claudeAgents: [] }).claudeAgent, null, "gone from the catalog");
  assert.equal(store.sanitizePrefs({ ...p, claudeAgent: "Sisyphus - ultraworker" }, { user: admin }).claudeAgent, null);
  assert.equal(store.sanitizePrefs({ ...p, claudeAgent: undefined }, { user: admin }).claudeAgent, null, "default: none");
  assert.equal(store.sanitizePrefs(p, { user: TENANT, agents: AGENTS, claudeAgents: cat }).claudeAgent, null);
});

test("ISSUE-002: projects outside the tenant scope are dropped", () => {
  const list = ["D:\\T\\qa", "d:/t/qa/", "D:\\Admin\\secret"];
  assert.deepEqual(store.sanitizeProjects(list, TENANT), ["D:\\T\\qa", "d:/t/qa/"]);
  assert.deepEqual(store.sanitizeProjects(list, { id: "admin", role: "admin" }), list);
});

test("ISSUE-002: prefs/projects live under per-user keys; the admin's never leak to a tenant", () => {
  const mem = new Map();
  const real = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  try {
    mem.set("zai.prefs", JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" }, agent: "Sisyphus - ultraworker" }));
    mem.set("zai.projects", JSON.stringify(["D:\\Admin\\secret"]));
    store.bindUserStorage({ id: "admin", role: "admin" });
    assert.equal(store.prefs.value.model.providerID, "anthropic", "admin inherits the legacy device prefs");
    assert.ok(mem.has("zai.prefs.admin"), "migrated to the admin's own key");
    store.bindUserStorage(TENANT);
    assert.notEqual(store.prefs.value.model.providerID, "anthropic", "the tenant starts clean");
    assert.deepEqual(store.userProjects.value, [], "no admin projects for the tenant");
  } finally {
    globalThis.localStorage = real;
  }
});

test("ISSUE-002: policy 403s read as words, not «проверьте связь»", () => {
  const e = (status, error) => Object.assign(new Error("x"), { status, body: { error } });
  assert.match(explainApiError(e(403, "engine not allowed"), "Не удалось создать чат"), /Claude вам недоступен/);
  assert.match(explainApiError(e(403, "agent not allowed"), "Не удалось создать чат"), /агент вам недоступен/);
  assert.match(explainApiError(e(403, "outside your scope"), "Не удалось создать чат"), /папка вам недоступна/);
  assert.match(explainApiError(new Error("net"), "Не удалось создать чат"), /нет связи/);
  assert.doesNotMatch(explainApiError(e(403, "agent not allowed")), /связ/);
});

test("ISSUE-001: createAndOpen as a tenant sends the allowed default agent", async () => {
  store.me.value = TENANT;
  store.agents.value = AGENTS;
  store.setPrefs({ model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }, agent: "Sisyphus - ultraworker" });
  const f = stubFetch(async (c) => {
    if (c.method === "POST" && c.path.endsWith("/session")) return ok({ id: "ses_t1", directory: "D:\\T\\qa" });
    if (c.path.endsWith("/status")) return ok({});
    return ok([]);
  });
  try {
    await store.createAndOpen();
    const post = f.calls.find((c) => c.method === "POST" && c.path.endsWith("/session"));
    assert.equal(post.body.agent, "Prometheus - Plan Builder");
  } finally {
    f.restore();
    store.closeSession();
    store.me.value = null;
    store.agents.value = [];
  }
});

// ---- ISSUE-003: Claude queue ------------------------------------------------

test("ISSUE-003: a queued question is accepted by its own answer, answers stay under their questions", () => {
  const SID = "ses_q";
  active.value = {
    id: SID, title: "", status: "busy", lastEventAt: Date.now(), loading: false, loadError: false,
    messages: [
      makeMessage({ id: "u1", role: "user", time: { created: 1 } }, [{ id: "p1", type: "text", text: "раз" }]),
      makeMessage({ id: "a1", role: "assistant", parentID: "u1", time: { created: 2 } }, []),
      makeMessage({ id: "u2", role: "user", time: { created: 3 }, queued: true, delivery: "delivered" }, [{ id: "p2", type: "text", text: "два" }]),
    ],
  };
  // a late step of answer 1 arrives after u2 was queued
  handleEvent({ type: "message.updated", properties: { sessionID: SID, info: { id: "a1b", sessionID: SID, role: "assistant", parentID: "u1", time: { created: 4 } } } });
  // turn 2 starts
  handleEvent({ type: "message.updated", properties: { sessionID: SID, info: { id: "a2", sessionID: SID, role: "assistant", parentID: "u2", time: { created: 5 } } } });
  const ids = active.value.messages.map((m) => m.info.id);
  assert.deepEqual(ids, ["u1", "a1", "a1b", "u2", "a2"]);
  const u2 = active.value.messages.find((m) => m.info.id === "u2");
  assert.equal(u2.info.queued, false, "«В очереди» is gone");
  assert.equal(u2.info.delivery, "accepted");
  active.value = null;
});

// ---- ISSUE-004: offline bar -------------------------------------------------

test("ISSUE-004: any proof of life clears «Нет связи» (no EventSource open needed)", async () => {
  connection.value = { state: "offline", restoredAt: null };
  noteAlive();
  assert.equal(connection.value.state, "online");
  // a successful API answer is proof of life too
  connection.value = { state: "offline", restoredAt: null };
  const f = stubFetch(async () => ok([]));
  try {
    await store.refreshSessions();
    assert.equal(connection.value.state, "online");
  } finally {
    f.restore();
  }
  onStreamStatus("open");
});

test("BUG-096: пока браузер офлайн (navigator.onLine=false), «Связь восстановлена» не показывается", () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true, writable: true });
  try {
    connection.value = { state: "offline", restoredAt: null };
    noteAlive();
    onStreamStatus("open");
    assert.equal(connection.value.state, "offline", "сеть выключена — плашка «Нет связи» остаётся");
    assert.equal(connection.value.restoredAt, null);
  } finally {
    if (desc) Object.defineProperty(globalThis, "navigator", desc);
    else delete globalThis.navigator;
  }
  noteAlive();
  assert.equal(connection.value.state, "online", "сеть вернулась — снова онлайн");
});

// ---- ISSUE-005: rename/delete rollback ---------------------------------------

test("ISSUE-005: a failed rename rolls back and says why", async () => {
  sessions.value = [{ id: "s1", title: "Старое", directory: "D:\\x" }];
  setNotice(null);
  const f = stubFetch(async () => fail(500));
  try {
    const r = await store.renameSession("s1", "Новое");
    assert.equal(r, false);
    assert.equal(sessions.value[0].title, "Старое");
    assert.match(notice.value ?? "", /Не удалось переименовать чат/);
  } finally {
    f.restore();
  }
});

test("ISSUE-005: a failed delete puts the chat back with a notice; 404 counts as gone", async () => {
  sessions.value = [{ id: "s1", title: "A" }, { id: "s2", title: "B" }];
  setNotice(null);
  let f = stubFetch(async () => fail(503));
  try {
    assert.equal(await store.deleteSessionById("s1"), false);
    assert.deepEqual(sessions.value.map((s) => s.id), ["s1", "s2"]);
    assert.match(notice.value ?? "", /Не удалось удалить чат/);
  } finally {
    f.restore();
  }
  f = stubFetch(async () => fail(404));
  try {
    assert.equal(await store.deleteSessionById("s1"), true);
    assert.deepEqual(sessions.value.map((s) => s.id), ["s2"]);
  } finally {
    f.restore();
    sessions.value = [];
    setNotice(null);
  }
});

// ---- ISSUE-006: workdir errors ----------------------------------------------

test("ISSUE-006: a realPath NotFound stack becomes a human «папка недоступна», no retry", () => {
  const err = describeTurnError({ name: "UnknownError", data: { message: "PlatformError: NotFound: FileSystem.realPath (Z:\\nope\\dir)\n    at x (y.js:1:2)" } });
  assert.equal(err.kind, "workdir");
  assert.match(err.title, /Папка чата недоступна/);
  assert.deepEqual(err.actions, []);
  assert.ok(err.detail, "raw text kept for «Подробности»");
});

test("ISSUE-006: checkProjectDir explains a missing drive", async () => {
  const f = stubFetch(async () => fail(400, { error: "такого диска нет на сервере", code: "no-drive" }));
  try {
    assert.equal(await store.checkProjectDir("Z:\\nope\\dir"), "Такого диска нет на сервере.");
  } finally {
    f.restore();
  }
  const g = stubFetch(async () => ok({ ok: true }));
  try {
    assert.equal(await store.checkProjectDir("D:\\ok"), null);
  } finally {
    g.restore();
  }
  await tick();
});

// ---- ISSUE-010: a picture named without a folder ----------------------------

test("ISSUE-010: a bare image name resolves into the session folder; .. and uploads do not", () => {
  const dir = "D:\\proj";
  const out = collectArtifacts([], ["Готово: red.png и `charts/out.png`, исходник ../secret.png, вход .zai-uploads/in.png"], dir);
  assert.deepEqual(out, ["D:\\proj\\red.png", "D:\\proj\\charts\\out.png"]);
  assert.deepEqual(collectArtifacts([], ["red.png"], ""), [], "unknown folder → nothing");
});

// ---- ISSUE-015: unsent text survives a reload --------------------------------

test("ISSUE-015: a send that never reached the server parks its text as the chat draft", async () => {
  const mem = new Map();
  const real = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  active.value = { id: "ses_d", title: "", status: "idle", lastEventAt: Date.now(), messages: [], loading: false, loadError: false };
  const f = stubFetch(async () => {
    throw new Error("offline");
  });
  try {
    assert.equal(await store.send({ text: "важный текст", sessionId: "ses_d" }), false);
    assert.equal(store.loadDraft("ses_d"), "важный текст");
  } finally {
    f.restore();
    globalThis.localStorage = real;
    active.value = null;
  }
});
