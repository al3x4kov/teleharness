// TASK-261 (TASK-12.35) п.1: текстовая статика сжимается по Accept-Encoding
// (br, иначе gzip), Vary: Accept-Encoding, ETag/Last-Modified — как без сжатия
// (проверка обновления бандла BUG-179 сравнивает ETag app.js), 304 и HEAD как раньше.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const DIR = mkdtempSync(path.join(tmpdir(), "teleharness-static-"));
const JS = "const x = 1;\n".repeat(5000);
writeFileSync(path.join(DIR, "app.js"), JS);
writeFileSync(path.join(DIR, "tiny.css"), "a{}");
writeFileSync(path.join(DIR, "icon.png"), Buffer.alloc(4096, 7));
process.env.TELEHARNESS_PUBLIC_DIR = DIR;
const { serveStatic } = await import("../lib/static.js?compress-test");

let server;
let port;
before(async () => {
  server = http.createServer((req, res) => serveStatic(req, res, req.url));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(DIR, { recursive: true, force: true });
});

// сырой запрос без автоматической распаковки fetch
function get(p, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("TASK-261: br по Accept-Encoding, Vary, тот же ETag, тело распаковывается в исходник", async () => {
  const plain = await get("/teleharness/app.js");
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.body.toString(), JS);
  const br = await get("/teleharness/app.js", { "accept-encoding": "gzip, deflate, br" });
  assert.equal(br.status, 200);
  assert.equal(br.headers["content-encoding"], "br");
  assert.match(br.headers.vary ?? "", /accept-encoding/i);
  assert.equal(br.headers.etag, plain.headers.etag);
  assert.equal(br.headers["last-modified"], plain.headers["last-modified"]);
  assert.equal(br.headers["cache-control"], "no-cache");
  assert.equal(Number(br.headers["content-length"]), br.body.length);
  assert.ok(br.body.length * 3 < JS.length, `сжато ${br.body.length} из ${JS.length}`);
  assert.equal(brotliDecompressSync(br.body).toString(), JS);
});

test("TASK-261: без br — gzip; повторный запрос из кэша тот же", async () => {
  const a = await get("/teleharness/app.js", { "accept-encoding": "gzip" });
  const b = await get("/teleharness/app.js", { "accept-encoding": "gzip" });
  assert.equal(a.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(a.body).toString(), JS);
  assert.deepEqual(a.body, b.body);
});

test("TASK-261: If-None-Match со сжатием — 304; HEAD без тела", async () => {
  const { headers } = await get("/teleharness/app.js");
  const nm = await get("/teleharness/app.js", { "accept-encoding": "br", "if-none-match": headers.etag });
  assert.equal(nm.status, 304);
  const head = await get("/teleharness/app.js", { "accept-encoding": "br" }, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-encoding"], "br");
  assert.equal(head.body.length, 0);
});

test("TASK-261: картинки и крошечные файлы — как раньше, без сжатия", async () => {
  const png = await get("/teleharness/icon.png", { "accept-encoding": "br, gzip" });
  assert.equal(png.headers["content-encoding"], undefined);
  assert.equal(png.body.length, 4096);
  const css = await get("/teleharness/tiny.css", { "accept-encoding": "br, gzip" });
  assert.equal(css.headers["content-encoding"], undefined);
  assert.equal(css.body.toString(), "a{}");
});

test("TASK-261: br;q=0 не выбирается", async () => {
  const r = await get("/teleharness/app.js", { "accept-encoding": "br;q=0, gzip" });
  assert.equal(r.headers["content-encoding"], "gzip");
});
