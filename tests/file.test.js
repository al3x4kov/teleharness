// Tests for lib/file.js: containment (traversal), mime mapping, and the
// inline/attachment dispositions over a real http server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { mimeFor, resolveInside, serveWorkspaceFile, workspaceFileExists } from "../lib/file.js";

const ROOT = mkdtempSync(path.join(tmpdir(), "zai-file-"));
mkdirSync(path.join(ROOT, "sub"), { recursive: true });
writeFileSync(path.join(ROOT, "report.md"), "# отчёт\n");
writeFileSync(path.join(ROOT, "table.csv"), "a,b\n1,2\n");
writeFileSync(path.join(ROOT, "sub", "pic.bin"), "PNGDATA");

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    serveWorkspaceFile(req, res, {
      directory: ROOT,
      target: u.searchParams.get("path"),
      download: u.searchParams.get("download") === "1",
      extraRoots: [EXTRA], // mirrors the production allowlist behavior
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(ROOT, { recursive: true, force: true });
});

const get = (pathArg) => fetch(`${base}/?path=${encodeURIComponent(pathArg)}`, { redirect: "manual" });

test("resolveInside: relative, nested and dot-segment paths stay inside", () => {
  const inside = [
    "report.md",
    "sub/pic.bin",
    ".zai-uploads/x.xlsx",
    "./sub/../report.md",
    path.join(ROOT, "report.md"), // absolute inside is fine
  ];
  for (const t of inside) assert.ok(resolveInside(ROOT, t), `should be inside: ${t}`);
});

// No extra roots: the default one (home) may well contain the temp dir.
test("resolveInside: traversal outside is rejected", () => {
  const outside = [
    "../escape.txt",
    ROOT, // the directory itself is not a file
    "",
    null,
  ];
  // Windows-only shapes: on POSIX a backslash is an ordinary file-name character.
  if (process.platform === "win32") outside.push("..\\escape.txt", "D:\\Windows\\system.ini" /* absolute elsewhere */, "\\\\server\\share\\x" /* UNC */);
  else outside.push("/etc/passwd" /* absolute elsewhere */);
  for (const t of outside) assert.equal(resolveInside(ROOT, t, []), null, `should be rejected: ${t}`);
});

test("resolveInside: case-insensitive containment on win32", { skip: process.platform !== "win32" }, () => {
  assert.ok(resolveInside(ROOT, ROOT.toLowerCase() + "\\report.md"));
  assert.equal(resolveInside("c:\\users\\someone", "C:\\Users\\someone-else\\x.txt"), null);
});

// Extra roots (live fix 2026-10-31): the agent writes artifacts outside the
// session directory (vault/repos); absolute paths under an allowed root must
// preview, everything else outside must stay 403.
const EXTRA = mkdtempSync(path.join(tmpdir(), "zai-file-extra-"));
writeFileSync(path.join(EXTRA, "note.md"), "# внешняя заметка\n");
after(() => rmSync(EXTRA, { recursive: true, force: true }));

test("resolveInside: absolute path inside an extra root is allowed", () => {
  const abs = path.join(EXTRA, "note.md");
  assert.equal(resolveInside(ROOT, abs, [EXTRA]), abs);
  // case-insensitive on win32
  if (process.platform === "win32") assert.ok(resolveInside(ROOT, abs.toLowerCase(), [EXTRA]));
});

test("resolveInside: traversal out of the extra root is still rejected", () => {
  assert.equal(resolveInside(ROOT, path.join(EXTRA, "..\\escape.txt"), [EXTRA]), null);
  assert.equal(resolveInside(ROOT, path.join(EXTRA, "note.md"), []), null, "no extra roots → outside stays outside");
});

test("resolveInside: the default root (ZAI_FILE_ROOTS = home) covers files outside the chat folder", () => {
  // Defaults parsed from ZAI_FILE_ROOTS at module load; containment is
  // string-based, so no filesystem access here.
  const home = os.homedir();
  const elsewhere = path.join(path.parse(home).root, "zai-not-home-" + process.pid);
  assert.equal(resolveInside(elsewhere, path.join(home, "notes", "x.md")), path.join(home, "notes", "x.md"));
  assert.equal(resolveInside(elsewhere, path.join(path.parse(home).root, "zai-elsewhere", "secret.txt")), null);
});

test("serving a file from an extra root streams with md mime", async () => {
  const res = await fetch(`${base}/?path=${encodeURIComponent(path.join(EXTRA, "note.md"))}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/markdown/);
  assert.equal(await res.text(), "# внешняя заметка\n");
});

test("GET serves markdown inline with utf-8 and no-cache", async () => {
  const res = await get("report.md");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/markdown/);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.match(res.headers.get("content-disposition"), /^inline/);
  assert.equal(await res.text(), "# отчёт\n");
});

test("GET download=1 switches to attachment with the basename", async () => {
  const res = await fetch(`${base}/?path=${encodeURIComponent("table.csv")}&download=1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /^attachment/);
  assert.match(res.headers.get("content-disposition"), /filename="table\.csv"/);
  await res.text();
});

test("missing file and directories answer 404 JSON", async () => {
  assert.equal((await get("nope.md")).status, 404);
  assert.equal((await get("sub")).status, 404);
});

test("traversal answers 403", async () => {
  const res = await get("../server.js");
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden" });
});

test("nested file inside subfolder streams", async () => {
  const res = await get("sub/pic.bin");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(await res.text(), "PNGDATA");
});

test("HEAD answers like GET: headers only, no body", async () => {
  const res = await fetch(`${base}/?path=${encodeURIComponent("report.md")}`, { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/markdown/);
  // content-length is BYTES: the utf-8 body is 13 bytes, not 8 chars
  assert.equal(Number(res.headers.get("content-length")), Buffer.byteLength("# отчёт\n", "utf8"));
  const body = await res.text();
  assert.equal(body, "");
});

test("mimeFor covers the artifact set", () => {
  assert.equal(mimeFor("a.PDF"), "application/pdf");
  assert.equal(mimeFor("b.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(mimeFor("c.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(mimeFor("d.png"), "image/png");
  assert.equal(mimeFor("e.md"), "text/markdown; charset=utf-8");
  assert.equal(mimeFor("f.unknownext"), "application/octet-stream");
});

test("BUG-090: workspaceFileExists — existing file true; missing, directory, outside the roots false", () => {
  assert.equal(workspaceFileExists(ROOT, "report.md", [EXTRA]), true);
  assert.equal(workspaceFileExists(ROOT, path.join(ROOT, "sub", "pic.bin"), [EXTRA]), true);
  assert.equal(workspaceFileExists(ROOT, path.join(EXTRA, "note.md"), [EXTRA]), true, "extra root");
  assert.equal(workspaceFileExists(ROOT, "gone.png", [EXTRA]), false, "deleted guessed picture");
  assert.equal(workspaceFileExists(ROOT, "sub", [EXTRA]), false, "a directory is not a file");
  assert.equal(workspaceFileExists(ROOT, "../server.js", [EXTRA]), false, "outside: same answer as missing");
  assert.equal(workspaceFileExists(ROOT, "", [EXTRA]), false);
});
