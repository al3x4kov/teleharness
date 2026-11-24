// TASK-12.18 / ADR-001: the declarative route table — every record declares
// a scope, the gate runs before the handler, a refused request never reaches
// it; role × route → status for the migrated groups (files, catalog).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCOPES, dispatchRoute, matchRoute, validateTable } from "../routes/router.js";
import { fileRoutes } from "../routes/files.js";
import { catalogRoutes } from "../routes/catalog.js";
import { isUnderAny } from "../lib/paths.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Absolute on this OS (the dirQuery scope wants an absolute folder):
// C:\... on Windows, /... on POSIX.
const FS_ROOT = path.parse(process.cwd()).root;
const HOME = path.join(FS_ROOT, "Users", "USER");
const OWN = path.join(FS_ROOT, "t", "alice");
const OTHER = path.join(FS_ROOT, "other");
const calls = [];
const sendJson = (res, status, body) => {
  res.status = status;
  res.body = body;
};
const dirAllowed = (user, dir) => user.role === "admin" || isUnderAny(String(dir ?? ""), [OWN]);
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
    [ADMIN, "GET", "/teleharness/api/usage", 200],
    [ALICE, "GET", "/teleharness/api/usage", 403],
    [ADMIN, "GET", "/teleharness/api/file?path=a.png", 200], // default HOME for admin
    [ALICE, "GET", "/teleharness/api/file?path=a.png", 403], // default HOME is outside a tenant's scope
    [ALICE, "HEAD", `/teleharness/api/file?directory=${q(OWN)}&path=a.png`, 200],
    [ALICE, "GET", `/teleharness/api/file/exists?directory=${q(OWN)}&path=a.png`, 200],
    [ALICE, "GET", `/teleharness/api/file/exists?directory=${q(OWN)}`, 400],
    [ALICE, "GET", `/teleharness/api/file/exists?directory=${q(OTHER)}&path=a.png`, 403],
    [ALICE, "GET", `/teleharness/api/turn-files?directory=${q(OWN)}&w=1-2`, 200],
    [ALICE, "GET", "/teleharness/api/turn-files?w=1-2", 400],
    [ALICE, "GET", `/teleharness/api/turn-files?directory=${q(OTHER)}&w=1-2`, 403],
    [ALICE, "GET", `/teleharness/api/dircheck?directory=${q(OWN)}`, 200],
    [ALICE, "GET", `/teleharness/api/dircheck?directory=${q(OTHER)}`, 403],
  ];
  for (const [user, method, p, status] of cases) {
    const r = await call(user, method, p);
    assert.equal(r.handled, true, p);
    assert.equal(r.status, status, `${user.id} ${method} ${p}`);
  }
});

test("the gate runs before the handler: a refused request never reaches it", async () => {
  calls.length = 0;
  // /teleharness/api/mcp left this list with FEAT-03.21: scope "user", filtered in the handler.
  for (const [m, p] of [["GET", "/teleharness/api/usage"], ["GET", "/teleharness/api/host"], ["GET", "/teleharness/api/claude/agents"], ["POST", "/teleharness/api/claude/agents"]]) {
    const r = await call(ALICE, m, p);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.deepEqual(r.body, { error: "admin only" });
  }
  assert.deepEqual(calls, [], "no handler ran");
  assert.equal((await call(ADMIN, "POST", "/teleharness/api/claude/agents")).status, 405, "admin: path first, then 405 (legacy order)");
  assert.equal((await call(ADMIN, "GET", "/teleharness/api/host")).status, 200);
  assert.equal((await call(ALICE, "GET", "/teleharness/api/about")).status, 200, "about for every role");
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
  for (const [m, p] of [["GET", "/teleharness/api/admin/users"], ["POST", "/teleharness/api/admin/users"], ["PUT", "/teleharness/api/admin/users"], ["POST", "/teleharness/api/admin/users/bob/token"],
    ["PATCH", "/teleharness/api/admin/users/bob"], ["DELETE", "/teleharness/api/admin/users/bob"], ["GET", "/teleharness/api/admin/sessions"], ["GET", "/teleharness/api/admin/gc"], ["POST", "/teleharness/api/admin/gc"]]) {
    assert.equal(await go(ALICE, m, p), 403, `${m} ${p}`);
  }
  assert.deepEqual(seen, [], "no admin handler ran for a tenant");
  assert.equal(await go(ADMIN, "PUT", "/teleharness/api/admin/users"), 405);
  assert.equal(await go(ADMIN, "GET", "/teleharness/api/admin/gc"), 503, "index unavailable");
  assert.equal(await go(ALICE, "POST", "/teleharness/api/auth/token"), 201, "own token rotation for any user");
  assert.equal(await go(ALICE, "GET", "/teleharness/api/auth/token"), 405);
});

test("session group: every path reaches its own handler with the regex match; unknown method on /session/:id falls through (404 at the end)", async () => {
  const { sessionRoutes } = await import("../routes/session.js");
  const hit = [];
  const h = Object.fromEntries(["search", "binding", "action", "plan", "revert", "patchDelete", "list", "create", "reply", "event"].map((k) => [k, (c) => hit.push([k, c.match ? [...c.match].slice(1) : null])]));
  const t = validateTable(sessionRoutes(h));
  const go = (method, p) => dispatchRoute(t, { req: { method }, res: {}, url: new URL(p, "http://x"), user: ALICE, admin: false }, { sendJson, dirAllowed });
  assert.equal(await go("GET", "/teleharness/api/session/ses_a/binding"), true, "binding: any method (405 inside)");
  assert.equal(await go("PUT", "/teleharness/api/session/ses_a/prompt"), true, "action: any method (405 inside)");
  // FEAT-01.57/01.58: GET/POST revert, POST unrevert; PUT is not a route.
  assert.equal(await go("GET", "/teleharness/api/session/ses_a/revert"), true);
  assert.equal(await go("POST", "/teleharness/api/session/ses_a/unrevert"), true);
  assert.equal(await go("PUT", "/teleharness/api/session/ses_a/revert"), false);
  assert.equal(await go("DELETE", "/teleharness/api/session/ses_a"), true);
  assert.equal(await go("GET", "/teleharness/api/session/ses_a"), false, "GET /session/:id was never a route");
  assert.equal(await go("GET", "/teleharness/api/session/search?q=test"), true);
  assert.equal(await go("GET", "/teleharness/api/session"), true);
  assert.equal(await go("POST", "/teleharness/api/session"), true);
  assert.equal(await go("POST", "/teleharness/api/question/q1/reply"), true);
  assert.equal(await go("GET", "/teleharness/api/permission/p1/reply"), false);
  assert.equal(await go("GET", "/teleharness/api/event"), true);
  assert.equal(await go("GET", "/teleharness/api/session/ses_a/plan"), true);
  assert.equal(await go("POST", "/teleharness/api/session/ses_a/plan"), false, "GET only");
  assert.deepEqual(hit.map((x) => x[0]), ["binding", "action", "revert", "revert", "patchDelete", "search", "list", "create", "reply", "event", "plan"]);
  assert.deepEqual(hit[1][1], ["ses_a", "prompt"]);
  assert.deepEqual(hit[3][1], ["ses_a", "unrevert"]);
  assert.deepEqual(hit[8][1], ["question", "q1"]);
  assert.deepEqual(hit.at(-1)[1], ["ses_a"]);
});

test("unmatched method or path falls through to the legacy chain", async () => {
  assert.equal(matchRoute(TABLE, "POST", "/teleharness/api/file"), null);
  assert.equal((await call(ADMIN, "DELETE", "/teleharness/api/usage")).handled, false);
  assert.equal((await call(ADMIN, "GET", "/teleharness/api/session")).handled, false);
});

test("TASK-14.21 dirAllowed: граница сегмента и регистрочувствительность на Linux", async () => {
  const q = (d) => encodeURIComponent(d);
  // /t/alice2 — не внутри /t/alice (граница сегмента)
  assert.equal((await call(ALICE, "GET", `/teleharness/api/dircheck?directory=${q(OWN + "2")}`)).status, 403);
  assert.equal((await call(ALICE, "GET", `/teleharness/api/dircheck?directory=${q(path.join(OWN, "sub"))}`)).status, 200);
  // На POSIX регистр значим (/t/Alice ≠ /t/alice)
  if (process.platform !== "win32") {
    const upper = OWN.replace("alice", "Alice");
    assert.equal((await call(ALICE, "GET", `/teleharness/api/dircheck?directory=${q(upper)}`)).status, 403, "POSIX: другой регистр — 403");
  }
});

test("TASK-14.21: валидность полной реальной таблицы API_ROUTES из server.js (все группы маршрутов)", async () => {
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const serverSrc = readFileSync(path.join(repoRoot, "server.js"), "utf8");
  const m = serverSrc.match(/const API_ROUTES = validateTable\(\[([\s\S]*?)\n\]\);/);
  assert.ok(m, "const API_ROUTES = validateTable([...]) найден в server.js");

  // Извлекаем все верхнеуровневые фабрики маршрутов, подключённые в API_ROUTES server.js
  const wired = new Set();
  for (const hit of m[1].matchAll(/^  (?:\.\.\.)?(\w+(?:Routes|Route))\s*\(/gm)) {
    wired.add(hit[1]);
  }
  assert.ok(wired.size >= 15, `ожидались все группы API_ROUTES, найдено ${wired.size}: ${[...wired].join(", ")}`);

  const stubDeps = new Proxy(
    {
      ...deps,
      readJsonBody: async () => ({}),
      readBody: async () => Buffer.alloc(0),
      apiError: () => {},
      ledger: {},
      reports: {},
      backfill: { state: () => [] },
      store: {},
      connections: {},
      reviews: {},
      wt: {},
      registry: {},
      installer: {},
      login: {},
      hub: { epoch: 1, sessionsReport: () => [] },
      pendingRemovals: { list: () => [] },
      claude: {},
      path,
    },
    { get: (t, k) => (k in t ? t[k] : () => {}) },
  );

  const factories = {
    attentionRoutes: (await import("../routes/attention.js")).attentionRoutes,
    costRoutes: (await import("../routes/costs.js")).costRoutes,
    reviewRoutes: (await import("../routes/review.js")).reviewRoutes,
    githubRoutes: (await import("../routes/github.js")).githubRoutes,
    temporalRoutes: (await import("../routes/temporal.js")).temporalRoutes,
    scheduleRoutes: (await import("../routes/temporal-schedules.js")).scheduleRoutes,
    triggerRoutes: (await import("../routes/temporal-triggers.js")).triggerRoutes,
    fileRoutes,
    catalogRoutes,
    acpCatalogRoutes: (await import("../routes/acp-catalog.js")).acpCatalogRoutes,
    acpLoginRoute: (await import("../routes/acp-login.js")).acpLoginRoute,
    adminRoutes: (await import("../routes/admin.js")).adminRoutes,
    gitRoutes: (await import("../routes/git.js")).gitRoutes,
    worktreeRoutes: (await import("../routes/worktrees.js")).worktreeRoutes,
    pushRoutes: (await import("../routes/push.js")).pushRoutes,
    voiceRoutes: (await import("../routes/voice.js")).voiceRoutes,
    sessionRoutes: (await import("../routes/session.js")).sessionRoutes,
  };

  for (const name of wired) {
    assert.ok(name in factories, `фабрика ${name} из server.js API_ROUTES должна проверяться в тесте`);
  }

  const allRoutes = [];
  for (const name of wired) {
    if (name === "acpLoginRoute") {
      allRoutes.push(factories.acpLoginRoute({ sendJson, readJsonBody: stubDeps.readJsonBody, agent: "github-copilot-cli", login: {} }));
      allRoutes.push(factories.acpLoginRoute({ sendJson, readJsonBody: stubDeps.readJsonBody, agent: "antigravity", login: {} }));
    } else {
      const built = factories[name](stubDeps);
      assert.ok(Array.isArray(built) && built.length > 0, `${name} должна вернуть непустой массив маршрутов`);
      allRoutes.push(...built);
    }
  }

  const validated = validateTable(allRoutes);
  assert.ok(validated.length >= 60, `ожидалось ≥60 маршрутов в полной таблице, получено ${validated.length}`);
  for (const r of validated) {
    assert.ok(SCOPES.has(r.scope), `неизвестный scope ${r.scope} у ${r.method} ${r.path}`);
    assert.equal(typeof r.handler, "function", `нет handler у ${r.method} ${r.path}`);
    if (typeof r.path === "string") assert.ok(r.path.startsWith("/teleharness/api/"), `неожиданный префикс пути ${r.path}`);
  }
});
