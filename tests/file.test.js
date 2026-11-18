// Tests for lib/file.js: containment (traversal), mime mapping, and the
// inline/attachment dispositions over a real http server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { mimeFor, realInside, resolveInside, serveWorkspaceFile, translateLegacyFilePath, workspaceFileExists } from "../lib/file.js";
import { config, platformDefaults } from "../lib/config.js";

const ROOT = mkdtempSync(path.join(tmpdir(), "teleharness-file-"));
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
    ".teleharness-uploads/x.xlsx",
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
  for (const t of outside) assert.equal(resolveInside(ROOT, t, []), null, `should be rejected: ${t}`);
  // TASK-17.18: Windows-формы. На win32 — абсолютный путь вне папки и UNC; на POSIX «\\» — обычный
  // символ имени, поэтому те же строки отвергаются только через TELEHARNESS_LEGACY_PATH_ROOT (перевод C:/D:,
  // отказ на UNC), а без него остаются буквальными именами ВНУТРИ папки (не выход наружу).
  const winShapes = ["D:\\Windows\\system.ini" /* absolute elsewhere */, "\\\\server\\share\\x" /* UNC */];
  if (process.platform === "win32") {
    for (const t of winShapes) assert.equal(resolveInside(ROOT, t, []), null, `should be rejected: ${t}`);
  } else {
    const legacy = path.join(path.dirname(ROOT), "teleharness-legacy-not-a-root");
    for (const t of winShapes) assert.equal(resolveInside(ROOT, t, [], legacy), null, `should be rejected (legacy root): ${t}`);
    for (const t of winShapes) assert.equal(resolveInside(ROOT, t, [], ""), path.join(ROOT, t), `literal name inside: ${t}`);
    for (const t of ["/etc/passwd", path.join(path.dirname(ROOT), "escape.txt")]) assert.equal(resolveInside(ROOT, t, []), null, `should be rejected: ${t}`);
  }
});

test("resolveInside: case-insensitive containment on win32", { skip: process.platform !== "win32" }, () => {
  assert.ok(resolveInside(ROOT, ROOT.toLowerCase() + "\\report.md"));
  assert.equal(resolveInside("c:\\users\\someone", "C:\\Users\\someone-else\\x.txt"), null);
});

// Extra roots (live fix 2026-10-31): the agent writes artifacts outside the
// session directory (vault/repos); absolute paths under an allowed root must
// preview, everything else outside must stay 403.
const EXTRA = mkdtempSync(path.join(tmpdir(), "teleharness-file-extra-"));
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

test("resolveInside: the default root (TELEHARNESS_FILE_ROOTS = home) covers files outside the chat folder", () => {
  // Defaults parsed from TELEHARNESS_FILE_ROOTS at module load; containment is
  // string-based, so no filesystem access here.
  const home = os.homedir();
  const elsewhere = path.join(path.parse(home).root, "teleharness-not-home-" + process.pid);
  assert.equal(resolveInside(elsewhere, path.join(home, "notes", "x.md")), path.join(home, "notes", "x.md"));
  assert.equal(resolveInside(elsewhere, path.join(path.parse(home).root, "teleharness-elsewhere", "secret.txt")), null);
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

// ---- TASK-17.18: TELEHARNESS_LEGACY_PATH_ROOT — старые Windows-ссылки вложений после переноса на Linux ----
test("translateLegacyFilePath: C:/D: → <корень>/<буква>/…; file:///D:/…; родные пути не трогает", () => {
  const L = path.join(path.parse(ROOT).root, "srv", "legacy");
  assert.equal(translateLegacyFilePath("C:\\Users\\dev\\a.md", L), path.join(L, "C", "Users", "dev", "a.md"));
  assert.equal(translateLegacyFilePath("d:/Apps/teleharness/x.md", L), path.join(L, "D", "Apps", "teleharness", "x.md"));
  assert.equal(translateLegacyFilePath("file:///D:/Obsidian/%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0%20x.md", L), path.join(L, "D", "Obsidian", "заметка x.md"));
  for (const t of ["sub/x.md", ".teleharness-uploads/a.xlsx", path.join(ROOT, "report.md")]) assert.equal(translateLegacyFilePath(t, L), t, t);
  // без корня (по умолчанию в тестовом окружении) — выключено
  assert.equal(translateLegacyFilePath("D:\\Apps\\x.md", ""), "D:\\Apps\\x.md");
  assert.equal(translateLegacyFilePath(null, L), null);
});

test("translateLegacyFilePath: отказ — «..», UNC, file://host, не-дисковые file:, \\0, другие диски, относительный корень", () => {
  const L = path.join(path.parse(ROOT).root, "srv", "legacy");
  for (const t of [
    "D:\\a\\..\\..\\etc\\passwd",
    "C:/a/../b",
    "D:\\..",
    "file:///D:/a/../b",
    "file:///D:/a/%2e%2e/b",
    "\\\\nas\\share\\x",
    "//nas/share/x",
    "\\\\?\\D:\\x",
    "file://nas/share/x.md",
    "file:////nas/share/x.md",
    "file:///etc/passwd",
    "file:///D:/bad%E0%A4%A",
    "D:\\a\0b",
    "file:///D:/a%00b",
    "E:\\x.md",
    "D:x.md",
  ]) assert.equal(translateLegacyFilePath(t, L), null, JSON.stringify(t));
  assert.equal(translateLegacyFilePath("D:\\x.md", "relative/root"), null, "корень должен быть абсолютным");
});

test("resolveInside + legacy root: переведённый путь всё равно проходит проверку области (лексически и realpath)", () => {
  const L = mkdtempSync(path.join(tmpdir(), "teleharness-legacy-"));
  try {
    const vault = path.join(L, "D", "Obsidian");
    mkdirSync(vault, { recursive: true });
    writeFileSync(path.join(vault, "n.md"), "n");
    const outside = path.join(L, "D", "Secret");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "s.txt"), "S");
    // внутри разрешённого корня — путь найден
    assert.equal(resolveInside(ROOT, "D:\\Obsidian\\n.md", [vault], L), path.join(vault, "n.md"));
    assert.equal(resolveInside(ROOT, "file:///D:/Obsidian/n.md", [vault], L), path.join(vault, "n.md"));
    // перевод не расширяет список корней: соседняя папка под тем же legacy-корнем — отказ
    assert.equal(resolveInside(ROOT, "D:\\Secret\\s.txt", [vault], L), null);
    assert.equal(resolveInside(ROOT, "C:\\Windows\\win.ini", [vault], L), null);
    assert.equal(resolveInside(ROOT, "D:\\Obsidian\\..\\Secret\\s.txt", [vault], L), null);
    // symlink внутри корня наружу: лексически внутри, realpath — отказ
    if (process.platform !== "win32") {
      symlinkSync(outside, path.join(vault, "jx"));
      const full = resolveInside(ROOT, "D:\\Obsidian\\jx\\s.txt", [vault], L);
      assert.equal(full, path.join(vault, "jx", "s.txt"));
      assert.equal(realInside(full, [ROOT, vault]), null);
    }
  } finally {
    rmSync(L, { recursive: true, force: true });
  }
});
