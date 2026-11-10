// Tests for lib/static.js. public/index.html may not exist yet (the UI agent
// owns public/), so the test creates a minimal one only when missing and
// removes it in teardown only if it created it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "../lib/static.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INDEX = path.join(ROOT, "public", "index.html");

const createdIndex = !existsSync(INDEX);
let server;
let base;

before(async () => {
  if (createdIndex) writeFileSync(INDEX, "<html>zai</html>\n");
  server = http.createServer((req, res) => serveStatic(req, res, req.url));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  if (createdIndex) rmSync(INDEX, { force: true });
});

test("GET /zai/ serves index.html as no-cache html", async () => {
  const res = await fetch(`${base}/zai/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.ok((await res.text()).includes("zai"));
});

test("GET /zai redirects 308 to /zai/", async () => {
  const res = await fetch(`${base}/zai`, { redirect: "manual" });
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), "/zai/");
});

test("unknown file under /zai/ answers 404 JSON", async () => {
  const res = await fetch(`${base}/zai/definitely-not-here.js`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not found" });
});

test("plain ../ traversal is blocked", async () => {
  // fetch() normalizes dot segments, so send the raw path with node:http.
  const res = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path: "/zai/../server.js" }, resolve).on("error", reject);
  });
  assert.equal(res.statusCode, 403);
  res.resume();
  const body = await new Promise((resolve) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
  assert.deepEqual(JSON.parse(body), { error: "forbidden" });
});

test("encoded %2e%2e traversal is blocked", async () => {
  const res = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path: "/zai/%2e%2e/server.js" }, resolve).on("error", reject);
  });
  assert.equal(res.statusCode, 403);
  res.resume();
});
