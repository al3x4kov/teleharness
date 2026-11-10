// Edge (ops/portal-server.js) contract tests — TASK-14.8 (part), ADR-008,
// ADR-009, TASK-12.20. A COPY of the real edge runs on free ports with a
// temporary static root and fake upstreams (never :80/:443/:4170/:4096).
// Run: node --test tests/edge.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(path.join(tmpdir(), "zai-edge-test-"));
const STATIC = path.join(TMP, "Portal");
const LOGS = path.join(TMP, "logs");
mkdirSync(path.join(STATIC, "tv"), { recursive: true });
mkdirSync(path.join(STATIC, "secrets"), { recursive: true });
mkdirSync(path.join(STATIC, "zai", "data"), { recursive: true });
writeFileSync(path.join(STATIC, "tv", "index.html"), "<h1>tv</h1>");
writeFileSync(path.join(STATIC, "tv", "status.json"), "{}");
writeFileSync(path.join(STATIC, "secrets", "qb.json"), "SECRET-QB");
writeFileSync(path.join(STATIC, "zai", "data", "admin-token.txt"), "SECRET-TOKEN");
writeFileSync(path.join(STATIC, "index.html"), "root");
// The edge runs from a copy (other agents may be editing ops/ live).
const EDGE = path.join(TMP, "portal-server.js");
copyFileSync(path.join(ROOT, "ops", "portal-server.js"), EDGE);

// Optional TLS: a throwaway self-signed cert when openssl is around.
const OPENSSL = ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"].find((bin) => {
  try {
    return spawnSync(bin, ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
});
const CERT = path.join(TMP, "cert.pem");
const KEY = path.join(TMP, "key.pem");
if (OPENSSL) {
  spawnSync(OPENSSL, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", KEY, "-out", CERT, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
}
const TLS = existsSync(CERT) && existsSync(KEY);

// Fake upstreams echo what they received.
function echoServer(tag) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tag, url: req.url, headers: req.headers }));
  });
  return { srv, hits };
}
const zai = echoServer("zai");
const tv = echoServer("tv");
await new Promise((r) => zai.srv.listen(0, "127.0.0.1", r));
await new Promise((r) => tv.srv.listen(0, "127.0.0.1", r));

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
const PORT = await freePort();
const TLS_PORT = await freePort();

const child = spawn(process.execPath, [EDGE], {
  env: {
    ...process.env,
    PORT: String(PORT),
    TLS_PORT: String(TLS_PORT),
    ZAI_EDGE_ROOT: STATIC,
    ZAI_EDGE_UPSTREAM: `127.0.0.1:${zai.srv.address().port}`,
    ZAI_EDGE_TV_UPSTREAM: `127.0.0.1:${tv.srv.address().port}`,
    ZAI_EDGE_LOG_DIR: LOGS,
    ZAI_TLS_CERT: TLS ? CERT : path.join(TMP, "none.pem"),
    ZAI_TLS_KEY: TLS ? KEY : path.join(TMP, "none-key.pem"),
    ZAI_TLS_CA: path.join(TMP, "no-ca.pem"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let childOut = "";
child.stderr.on("data", (c) => (childOut += c));
after(async () => {
  child.kill();
  await new Promise((r) => {
    child.once("exit", r);
    setTimeout(r, 2000).unref();
  });
  zai.srv.close();
  tv.srv.close();
  rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
await new Promise((resolve, reject) => {
  let out = "";
  child.stdout.on("data", (c) => {
    out += c;
    if (out.includes("portal-node listening") && (!TLS || out.includes("portal-tls listening"))) resolve();
  });
  child.on("exit", (code) => reject(new Error(`edge exited (code ${code}): ${out}${childOut}`)));
});

// Raw request: the path goes on the wire byte-for-byte (fetch would
// normalize ../ and %2e).
function raw(rawPath, { headers = {}, secure = false, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const mod = secure ? https : http;
    const req = mod.request(
      { host: "127.0.0.1", port: secure ? TLS_PORT : PORT, path: rawPath, method, headers, rejectUnauthorized: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
// Via the listener that actually proxies /zai (https when TLS is up: plain
// http answers 308 there).
const zaiReq = (p, opts = {}) => raw(p, { ...opts, secure: TLS });

test("static allow-list: /tv/ is served, nothing else from the root", async () => {
  const ok = await raw("/tv/");
  assert.equal(ok.status, 200);
  assert.match(ok.body, /tv/);
  for (const p of ["/secrets/qb.json", "/SECRETS/qb.json", "/index.html", "/zai-stage/x", "/Caddyfile"]) {
    const r = await raw(p);
    assert.equal(r.status, 404, `${p} must be 404`);
    assert.ok(!r.body.includes("SECRET"), `${p} must not leak`);
  }
});

test("case / stream / 8.3 / trailing-dot / traversal aliases are refused", async () => {
  const bad = [
    "/TV/index.html",
    "/Tv/status.json",
    "/tv/index.html::$DATA",
    "/tv::$INDEX_ALLOCATION/index.html",
    "/tv/INDEX~1.HTM",
    "/tv/index.html.",
    "/tv/index.html%20",
    "/tv/../secrets/qb.json",
    "/tv/%2e%2e/secrets/qb.json",
    "/tv/%2e%2e%5csecrets%5cqb.json",
    "/tv/..%5c..%5csecrets/qb.json",
    "/tv/%00index.html",
  ];
  for (const p of bad) {
    const r = await raw(p);
    assert.ok(r.status === 404 || r.status === 400 || r.status === 403, `${p} → ${r.status}`);
    assert.ok(!r.body.includes("SECRET"), `${p} must not leak`);
  }
});

test("broken URLs answer 400 and the edge stays alive", async () => {
  assert.equal((await raw("/tv/%zz")).status, 400);
  assert.equal((await raw("http://%zz/")).status, 400);
  assert.equal((await raw("/tv/")).status, 200, "still serving after malformed targets");
});

test("ADR-009: the edge overwrites x-forwarded-* and passes the original /zai path", async () => {
  const r = await zaiReq("/zai/api/session/ses_AbC?x=1", {
    headers: { "x-forwarded-for": "6.6.6.6", "x-forwarded-proto": TLS ? "http" : "https", forwarded: "for=6.6.6.6", "x-forwarded-host": "evil" },
  });
  assert.equal(r.status, 200);
  const seen = JSON.parse(r.body);
  assert.equal(seen.url, "/zai/api/session/ses_AbC?x=1", "dynamic segments keep their case");
  assert.equal(seen.headers["x-forwarded-for"], "127.0.0.1", "client XFF is replaced by the socket address");
  assert.equal(seen.headers["x-forwarded-proto"], TLS ? "https" : "http", "XFP comes from the listener");
  assert.equal(seen.headers.forwarded, undefined);
  assert.notEqual(seen.headers["x-forwarded-host"], "evil");
  assert.ok(seen.headers["x-request-id"], "the edge stamps a request id");
});

test("ADR-007: /zai/api/healthz is never relayed from outside", async () => {
  const before = zai.hits.length;
  for (const p of ["/zai/api/healthz", "/ZAI/API/HEALTHZ", "/zai/api/healthz/"]) {
    const r = await zaiReq(p);
    assert.equal(r.status, 404, `${p}`);
  }
  assert.equal(zai.hits.length, before, "the portal is not dialed");
});

test("ADR-009: /tv/api never receives the portal cookie or bearer token", async () => {
  const r = await raw("/tv/api/status", { headers: { cookie: "zai_t=SID1; tvpref=1; zai_t_stage=SID2", authorization: "Bearer abc" } });
  assert.equal(r.status, 200);
  const seen = JSON.parse(r.body);
  assert.equal(seen.headers.cookie, "tvpref=1");
  assert.equal(seen.headers.authorization, undefined);
});

test("TASK-12.20: the edge writes an access log without query strings", async () => {
  await raw("/tv/status.json?secret-query=1");
  await new Promise((r) => setTimeout(r, 200));
  const files = readdirSync(LOGS).filter((f) => f.startsWith("edge-"));
  assert.ok(files.length > 0, "an edge-YYYYMMDD.log exists");
  const text = files.map((f) => readFileSync(path.join(LOGS, f), "utf8")).join("");
  assert.ok(text.includes('"path":"/tv/status.json"'));
  assert.ok(!text.includes("secret-query"), "no query strings in the log");
  assert.ok(!text.includes("SID1"), "no cookies in the log");
});
