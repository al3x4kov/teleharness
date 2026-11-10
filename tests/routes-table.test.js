// TASK-12.18 / ADR-001: the declarative route table — every record declares
// a scope, the gate runs before the handler, a refused request never reaches
// it; role × route → status for the migrated groups (files, catalog).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCOPES, dispatchRoute, matchRoute, validateTable } from "../routes/router.js";
import { fileRoutes } from "../routes/files.js";
import { catalogRoutes } from "../routes/catalog.js";

const HOME = "C:\\Users\\USER";
const OWN = "C:\\t\\alice";
const calls = [];
const sendJson = (res, status, body) => {
  res.status = status;
  res.body = body;
};
const dirAllowed = (user, dir) => user.role === "admin" || String(dir).toLowerCase().startsWith(OWN.toLowerCase());
const spy = (name, ret = undefined) => (...a) => {
  calls.push([name, ...a]);
  return ret;
};
const deps = {
  sendJson, homeDir: HOME, dirAllowed,
  fileRoots: (u) => (u.role === "admin" ? undefined : []),
  serveWorkspaceFile: (req, res) => sendJson(res, 200, { served: true }),
  workspaceFileExists: () => true,
  turnFiles: () => [],
  parseWindows: () => [],
  errLog: () => {},
  dirProblem: () => null,
  driveProblem: () => null,
  dirProblemText: (c) => c,
  usageStats: spy("usage", { ok: 1 }),
  hostStats: spy("host", { cpu: 1 }),
  proxyRequest: spy("proxy"),
  withQuery: (p, s) => p + s,
  defaultOpts: {},
  claudeAgents: { publicList: spy("agents", []) },
  opencodeVersion: async () => "1.19.5",
  version: "test",
};
const TABLE = validateTable([...fileRoutes(deps), ...catalogRoutes(deps)]);
const ADMIN = { id: "a", role: "admin" };
const ALICE = { id: "alice", role: "user" };

async function call(user, method, pathAndQuery) {
  const url = new URL(pathAndQuery, "http://x");
  const res = {};
  const handled = await dispatchRoute(TABLE, { req: { method }, res, url, user, admin: user.role === "admin" }, { sendJson, dirAllowed });
  return { handled, status: res.status, body: res.body };
}

test("every route of the table declares a known scope and a handler", () => {
  assert.ok(TABLE.length >= 5);
  for (const r of TABLE) assert.ok(SCOPES.has(r.scope), `${r.method} ${r.path}`);
  assert.throws(() => validateTable([{ method: "GET", path: "/x", handler: () => {} }]), /unknown scope/);
  assert.throws(() => validateTable([{ method: "GET", path: "/x", scope: "user" }]), /no handler/);
});

test("role × route → status (same answers as the former if-chain)", async () => {
  const q = (d) => encodeURIComponent(d);
  const cases = [
    [ADMIN, "GET", "/zai/api/usage", 200],
    [ALICE, "GET", "/zai/api/usage", 403],
    [ADMIN, "GET", "/zai/api/file?path=a.png", 200], // default HOME for admin
    [ALICE, "GET", "/zai/api/file?path=a.png", 403], // default HOME is outside a tenant's scope
    [ALICE, "HEAD", `/zai/api/file?directory=${q(OWN)}&path=a.png`, 200],
    [ALICE, "GET", `/zai/api/file/exists?directory=${q(OWN)}&path=a.png`, 200],
    [ALICE, "GET", `/zai/api/file/exists?directory=${q(OWN)}`, 400],
    [ALICE, "GET", `/zai/api/file/exists?directory=${q("C:\\other")}&path=a.png`, 403],
    [ALICE, "GET", `/zai/api/turn-files?directory=${q(OWN)}&w=1-2`, 200],
    [ALICE, "GET", "/zai/api/turn-files?w=1-2", 400],
    [ALICE, "GET", `/zai/api/turn-files?directory=${q("C:\\other")}&w=1-2`, 403],
    [ALICE, "GET", `/zai/api/dircheck?directory=${q(OWN)}`, 200],
    [ALICE, "GET", `/zai/api/dircheck?directory=${q("C:\\other")}`, 403],
  ];
  for (const [user, method, p, status] of cases) {
    const r = await call(user, method, p);
    assert.equal(r.handled, true, p);
    assert.equal(r.status, status, `${user.id} ${method} ${p}`);
  }
});

test("the gate runs before the handler: a refused request never reaches it", async () => {
  calls.length = 0;
  // /zai/api/mcp left this list with FEAT-03.21: scope "user", filtered in the handler.
  for (const [m, p] of [["GET", "/zai/api/usage"], ["GET", "/zai/api/host"], ["GET", "/zai/api/claude/agents"], ["POST", "/zai/api/claude/agents"]]) {
    const r = await call(ALICE, m, p);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.deepEqual(r.body, { error: "admin only" });
  }
  assert.deepEqual(calls, [], "no handler ran");
  assert.equal((await call(ADMIN, "POST", "/zai/api/claude/agents")).status, 405, "admin: path first, then 405 (legacy order)");
  assert.equal((await call(ADMIN, "GET", "/zai/api/host")).status, 200);
  assert.equal((await call(ALICE, "GET", "/zai/api/about")).status, 200, "about for every role");
});

test("admin group: tenants get 403 on every method, before any handler; /auth/token is per-user", async () => {
  const { adminRoutes } = await import("../routes/admin.js");
  const seen = [];
  const s = (n, r) => (...a) => (seen.push(n), r);
  const t = validateTable(adminRoutes({
    sendJson, apiError: (res) => sendJson(res, 500, {}), readJsonBody: async () => ({ confirm: true }), bodyLimit: 1,
    listUsers: s("list", []), createUser: s("create", {}), regenerateToken: s("regen", "t"), updateUser: s("update", {}),
    deleteAccount: s("delete", {}), closeUserStreams: s("close"), hub: { epoch: 1, sessionsReport: s("report", []) },
    fetchSessionIndex: s("index"), sessionIndex: () => ({ at: 0 }), gcRunning: () => false, gcSweep: s("sweep", null),
    pendingRemovals: { list: () => [] }, rotateOwnToken: s("rotate", "new"), setAuthCookie: s("cookie"), createSession: s("sess"), isHttps: () => false,
  }));
  const go = async (user, method, p) => {
    const res = {};
    await dispatchRoute(t, { req: { method }, res, url: new URL(p, "http://x"), user, admin: user.role === "admin" }, { sendJson, dirAllowed });
    return res.status;
  };
  for (const [m, p] of [["GET", "/zai/api/admin/users"], ["POST", "/zai/api/admin/users"], ["PUT", "/zai/api/admin/users"], ["POST", "/zai/api/admin/users/bob/token"],
    ["PATCH", "/zai/api/admin/users/bob"], ["DELETE", "/zai/api/admin/users/bob"], ["GET", "/zai/api/admin/sessions"], ["GET", "/zai/api/admin/gc"], ["POST", "/zai/api/admin/gc"]]) {
    assert.equal(await go(ALICE, m, p), 403, `${m} ${p}`);
  }
  assert.deepEqual(seen, [], "no admin handler ran for a tenant");
  assert.equal(await go(ADMIN, "PUT", "/zai/api/admin/users"), 405);
  assert.equal(await go(ADMIN, "GET", "/zai/api/admin/gc"), 503, "index unavailable");
  assert.equal(await go(ALICE, "POST", "/zai/api/auth/token"), 201, "own token rotation for any user");
  assert.equal(await go(ALICE, "GET", "/zai/api/auth/token"), 405);
});

test("session group: every path reaches its own handler with the regex match; unknown method on /session/:id falls through (404 at the end)", async () => {
  const { sessionRoutes } = await import("../routes/session.js");
  const hit = [];
  const h = Object.fromEntries(["binding", "action", "revert", "patchDelete", "list", "create", "reply", "event"].map((k) => [k, (c) => hit.push([k, c.match ? [...c.match].slice(1) : null])]));
  const t = validateTable(sessionRoutes(h));
  const go = (method, p) => dispatchRoute(t, { req: { method }, res: {}, url: new URL(p, "http://x"), user: ALICE, admin: false }, { sendJson, dirAllowed });
  assert.equal(await go("GET", "/zai/api/session/ses_a/binding"), true, "binding: any method (405 inside)");
  assert.equal(await go("PUT", "/zai/api/session/ses_a/prompt"), true, "action: any method (405 inside)");
  // FEAT-01.57/01.58: GET/POST revert, POST unrevert; PUT is not a route.
  assert.equal(await go("GET", "/zai/api/session/ses_a/revert"), true);
  assert.equal(await go("POST", "/zai/api/session/ses_a/unrevert"), true);
  assert.equal(await go("PUT", "/zai/api/session/ses_a/revert"), false);
  assert.equal(await go("DELETE", "/zai/api/session/ses_a"), true);
  assert.equal(await go("GET", "/zai/api/session/ses_a"), false, "GET /session/:id was never a route");
  assert.equal(await go("GET", "/zai/api/session"), true);
  assert.equal(await go("POST", "/zai/api/session"), true);
  assert.equal(await go("POST", "/zai/api/question/q1/reply"), true);
  assert.equal(await go("GET", "/zai/api/permission/p1/reply"), false);
  assert.equal(await go("GET", "/zai/api/event"), true);
  assert.deepEqual(hit.map((x) => x[0]), ["binding", "action", "revert", "revert", "patchDelete", "list", "create", "reply", "event"]);
  assert.deepEqual(hit[1][1], ["ses_a", "prompt"]);
  assert.deepEqual(hit[3][1], ["ses_a", "unrevert"]);
  assert.deepEqual(hit[7][1], ["question", "q1"]);
});

test("unmatched method or path falls through to the legacy chain", async () => {
  assert.equal(matchRoute(TABLE, "POST", "/zai/api/file"), null);
  assert.equal((await call(ADMIN, "DELETE", "/zai/api/usage")).handled, false);
  assert.equal((await call(ADMIN, "GET", "/zai/api/session")).handled, false);
});
