// Tests for routes/files.js (BUG-301 / BUG-302):
// - Tenant GET /teleharness/api/file and /teleharness/api/file/exists without ?directory= use tenant's defaultDir (not admin homeDir -> 403)
// - Concurrent tenant uploads account for in-flight bytes so TELEHARNESS_TENANT_UPLOAD_QUOTA cannot be exceeded in parallel
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileRoutes } from "../routes/files.js";
import { dispatchRoute } from "../routes/router.js";

function makeRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.body = "";
  res.writeHead = (s, h = {}) => {
    res.statusCode = s;
    res.headers = h;
  };
  res.end = (chunk = "") => {
    res.body += String(chunk);
    res.emit("finish");
  };
  return res;
}

function makeReq(method, rawUrl, headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = rawUrl;
  req.headers = headers;
  req.resume = () => {};
  return req;
}

test("BUG-301: tenant GET /file and /file/exists with empty ?directory= use defaultDir(user), not admin homeDir", async () => {
  const TENANT_DIR = "/srv/tenants/alice";
  const ADMIN_HOME = "/srv/admin-home";
  const served = [];
  const checked = [];
  const tenant = { id: "alice", role: "tenant", directories: [TENANT_DIR] };
  const sendJson = (res, status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const dirAllowed = (u, d) => (u.role === "admin" ? true : d === TENANT_DIR);

  const routes = fileRoutes({
    sendJson,
    homeDir: ADMIN_HOME,
    chatDir: ADMIN_HOME,
    defaultDir: (u) => (u.role === "tenant" ? TENANT_DIR : ADMIN_HOME),
    fileRoots: (u) => (u.role === "tenant" ? [] : undefined),
    serveWorkspaceFile: (req, res, opts) => {
      served.push(opts);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    },
    workspaceFileExists: (dir, p) => {
      checked.push({ dir, p });
      return true;
    },
    turnFiles: () => [],
    parseWindows: () => [],
    errLog: () => {},
    dirProblem: () => null,
    driveProblem: () => null,
    dirProblemText: () => "",
    dirAllowed,
    handleUpload: () => {},
    tenantUploadBytes: () => 0,
    uploadLimit: 1024,
    uploadDir: ".teleharness-uploads",
    unlinkSync: () => {},
    sanitizeFilename: (x) => x,
    path,
    config: {},
  });

  const r1 = makeRes();
  const u1 = new URL("/teleharness/api/file?path=deck.pptx", "http://127.0.0.1");
  await dispatchRoute(routes, { req: makeReq("GET", u1.pathname + u1.search), res: r1, url: u1, user: tenant, admin: false }, { sendJson, dirAllowed });
  assert.equal(r1.statusCode, 200, `expected 200, got ${r1.statusCode}: ${r1.body}`);
  assert.equal(served[0]?.directory, TENANT_DIR);

  const r2 = makeRes();
  const u2 = new URL("/teleharness/api/file/exists?path=pic.png", "http://127.0.0.1");
  await dispatchRoute(routes, { req: makeReq("GET", u2.pathname + u2.search), res: r2, url: u2, user: tenant, admin: false }, { sendJson, dirAllowed });
  assert.equal(r2.statusCode, 200, `expected 200, got ${r2.statusCode}: ${r2.body}`);
  assert.equal(checked[0]?.dir, TENANT_DIR);
});

test("BUG-302: concurrent tenant uploads cannot exceed TELEHARNESS_TENANT_UPLOAD_QUOTA via in-flight race", async () => {
  const TENANT_DIR = "/srv/tenants/bob";
  const tenant = { id: "bob", role: "tenant", directories: [TENANT_DIR] };
  let finishFirst;
  const started = [];

  const routes = fileRoutes({
    sendJson: (res, status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    },
    homeDir: "/srv/admin",
    chatDir: "/srv/admin",
    defaultDir: () => TENANT_DIR,
    fileRoots: () => [],
    serveWorkspaceFile: () => {},
    workspaceFileExists: () => false,
    turnFiles: () => [],
    parseWindows: () => [],
    errLog: () => {},
    dirProblem: () => null,
    driveProblem: () => null,
    dirProblemText: () => "",
    dirAllowed: () => true,
    handleUpload: (req, res, _url, _dir, maxBytes) => {
      started.push(maxBytes);
      return new Promise((resolve) => {
        finishFirst = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          resolve();
        };
      });
    },
    tenantUploadBytes: () => 0,
    uploadLimit: 1000,
    uploadDir: ".teleharness-uploads",
    unlinkSync: () => {},
    sanitizeFilename: (x) => x,
    path,
    config: { TELEHARNESS_TENANT_UPLOAD_QUOTA: 100, TELEHARNESS_TENANT_UPLOAD_LIMIT: 100 },
  });

  const uploadRoute = routes.find((r) => r.method === "POST" && r.path === "/teleharness/api/upload");
  const url = new URL("/teleharness/api/upload?name=a.bin", "http://127.0.0.1");

  const res1 = makeRes();
  const p1 = uploadRoute.handler({
    req: makeReq("POST", url.pathname + url.search, { "content-length": "80" }),
    res: res1,
    url,
    user: tenant,
    admin: false,
  });

  // Second concurrent upload of 50 bytes would push total to 130 > 100 quota while first is still in flight
  const res2 = makeRes();
  await uploadRoute.handler({
    req: makeReq("POST", url.pathname + url.search, { "content-length": "50" }),
    res: res2,
    url,
    user: tenant,
    admin: false,
  });

  assert.equal(res2.statusCode, 413, "second concurrent upload must be rejected with 413 while first is in-flight");
  assert.equal(started.length, 1);

  finishFirst();
  await p1;
  assert.equal(res1.statusCode, 200);

  // After first finishes (still assuming disk=0 in mock), a new 50-byte upload is allowed again
  const res3 = makeRes();
  const p3 = uploadRoute.handler({
    req: makeReq("POST", url.pathname + url.search, { "content-length": "50" }),
    res: res3,
    url,
    user: tenant,
    admin: false,
  });
  finishFirst();
  await p3;
  assert.equal(res3.statusCode, 200, "in-flight counter released after completion");
});
