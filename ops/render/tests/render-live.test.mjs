// FEAT-04.12: zai-render on the host (LibreOffice / Edge / pdfium) — live test
// (Windows, real binaries). The renderer runs OUTSIDE the tenant AppContainer,
// so the content boundary is tested here: a document or a page must not pull
// a file outside the user's folder into the picture, nor reach loopback.
// Run: node --test ops/render/tests/render-live.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY = "D:/zai-sandbox/python/Scripts/python.exe";
const RENDER = path.join(HERE, "..", "zai_render.py");
const MARK = "ZAI-SECRET-MARKER-7731";
const live = process.platform === "win32" && existsSync(PY) && existsSync("D:/zai-sandbox/libreoffice/program/soffice.com");

let base, root, secretDir, secret, canary, hits;

before(() => {
  if (!live) return;
  base = mkdtempSync(path.join(tmpdir(), "zai-render-"));
  root = path.join(base, "tenant");
  secretDir = path.join(base, "owner");
  mkdirSync(root);
  mkdirSync(secretDir);
  secret = path.join(secretDir, "secret.txt");
  writeFileSync(secret, `${MARK}\n`);
  hits = [];
  canary = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.end("x");
  });
  return new Promise((ok) => canary.listen(0, "127.0.0.1", ok)).then(() => {
    const url = `http://127.0.0.1:${canary.address().port}`;
    const r = spawnSync(PY, ["-I", path.join(HERE, "make_evil.py"), root, secret, url], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
});

after(() => {
  canary?.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

// async: the canary server lives in THIS process — a sync spawn would freeze it
// and a fetch of the renderer would hang instead of being counted.
const render = (args, cwd = root) =>
  new Promise((ok) => {
    const p = spawn(PY, ["-I", RENDER, "--root", root, "--cwd", cwd, "--b64", Buffer.from(args, "utf8").toString("base64url")], { env: { ...process.env, ZAI_RENDER_TIMEOUT: "180" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (status) => ok({ status, stdout: out, stderr: "" }));
  });

function pdfText(pdf) {
  const r = spawnSync(PY, ["-I", "-c", "import sys,pypdfium2 as p;d=p.PdfDocument(sys.argv[1]);print('\\n'.join(d[i].get_textpage().get_text_range() for i in range(len(d))))", pdf], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("docx с полем INCLUDETEXT на чужой файл: картинки есть, секрета в PDF нет", { skip: !live }, async () => {
  const r = await render("evil.docx");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = path.join(root, "_preview", "evil");
  assert.ok(readdirSync(dir).some((f) => /^page-01\.png$/.test(f)));
  const text = pdfText(path.join(dir, "evil.pdf"));
  assert.match(text, /NORMAL-DOCX-TEXT/);
  assert.doesNotMatch(text, new RegExp(MARK));
});

test("pptx со связанными (внешними) картинками: ни запроса на loopback, ни чтения файла", { skip: !live }, async () => {
  const before = hits.length;
  const r = await render("evil.pptx");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(pdfText(path.join(root, "_preview", "evil", "evil.pdf")), /NORMAL-PPTX-TEXT/);
  assert.deepEqual(hits.slice(before), [], "LibreOffice не ходит по внешним ссылкам");
});

test("html: iframe/object/XHR на file:// и запросы на 127.0.0.1 не проходят, страница печатается", { skip: !live }, async () => {
  const before = hits.length;
  const r = await render("evil.html");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = pdfText(path.join(root, "_preview", "evil", "evil.pdf"));
  assert.match(text, /NORMAL-HTML-TEXT/);
  assert.doesNotMatch(text, new RegExp(MARK));
  assert.deepEqual(hits.slice(before), [], "браузер не достучался до loopback");
});

test("границы: файл вне папки, ../, неизвестный формат, старый .doc — отказ (код 2)", { skip: !live }, async () => {
  for (const a of [secret, "..\\owner\\secret.txt", "nofile.pptx", "evil.exe", "x.doc"]) {
    if (a === "evil.exe") writeFileSync(path.join(root, "evil.exe"), "x");
    if (a === "x.doc") writeFileSync(path.join(root, "x.doc"), "x");
    const r = await render(`"${a}"`);
    assert.equal(r.status, 2, `${a}: ${r.stdout}`);
  }
  assert.equal((await render("evil.docx", secretDir)).status, 2, "рабочая папка вне корня");
});

test("--pages выбирает страницы; без файла — подсказка формата", { skip: !live }, async () => {
  const r = await render("evil.html --pages 1");
  assert.equal(r.status, 0, r.stdout);
  assert.equal((await render("")).status, 2);
  assert.match((await render("--bogus x")).stdout, /неизвестный ключ/);
});
