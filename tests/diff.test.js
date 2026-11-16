// FEAT-18.8: src/lib/diff.js — «Этот ход» from turn parts of all three engines,
// parseUnified, lineDiff (Myers, context 3, collapsed runs).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bigCount, filesLabel, hunkTitle, limitHunks, lineDiff, parseApplyPatch, parseUnified, plural, relPath, toUnified, totals, turnChanges, unchangedLabel,
} from "../src/lib/diff.js";

const tool = (tool, input, extra = {}) => ({ type: "tool", tool, callID: "c" + Math.random(), state: { status: "completed", input, ...extra } });

test("lineDiff: Myers by lines, context 3, unchanged run between hunks collapsed with its lines", () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  const b = a.slice();
  b[1] = "L2";
  b.splice(15, 0, "new16");
  const d = lineDiff(a.join("\n"), b.join("\n"));
  assert.equal(d.additions, 2);
  assert.equal(d.deletions, 1);
  assert.equal(d.hunks.length, 2);
  const [h1, h2] = d.hunks;
  assert.deepEqual(h1.lines.map((l) => l.t + l.text), [" l1", "-l2", "+L2", " l3", " l4", " l5"]);
  assert.equal(h2.gap, 15 - 3 - 5, "lines 6..12 collapsed");
  assert.equal(h2.gapLines.length, h2.gap);
  assert.equal(h2.gapLines[0].text, "l6");
  assert.deepEqual(h2.lines.find((l) => l.t === "+"), { t: "+", text: "new16", o: null, n: 16 });
  assert.equal(h2.lines[0].o, 13);
  assert.equal(hunkTitle(h1), "@@ строки 1–5");
});

test("lineDiff: identical → no hunks; empty → all added; CRLF ignored", () => {
  assert.deepEqual(lineDiff("a\nb", "a\r\nb\r\n").hunks, []);
  const d = lineDiff("", "x\ny\n");
  assert.equal(d.additions, 2);
  assert.equal(d.deletions, 0);
});

test("parseUnified: git diff with new/deleted/renamed/binary files and hunk gaps", () => {
  const text = [
    "diff --git a/src/a.js b/src/a.js",
    "index 1..2 100644",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@ -20,2 +20,3 @@ fn",
    " x",
    "+y",
    " z",
    "\\ No newline at end of file",
    "diff --git a/new.md b/new.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.md",
    "@@ -0,0 +1,2 @@",
    "+# hi",
    "+-- not a header",
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
    "diff --git a/r1.txt b/r2.txt",
    "similarity index 100%",
    "rename from r1.txt",
    "rename to r2.txt",
  ].join("\n");
  const files = parseUnified(text);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions]), [
    ["src/a.js", "M", 2, 1],
    ["new.md", "A", 2, 0],
    ["old.txt", "D", 0, 1],
    ["img.png", "M", 0, 0],
    ["r2.txt", "R", 0, 0],
  ]);
  assert.equal(files[0].hunks[1].gap, 16, "lines 4..19 unchanged");
  assert.equal(files[0].hunks[1].lines[1].n, 21);
  assert.equal(files[1].hunks[0].lines[1].text, "-- not a header", "a «--» line inside a hunk stays content");
  assert.equal(files[3].binary, true);
  assert.equal(files[4].oldPath, "r1.txt");
});

test("parseUnified: headerless hunks (Codex) and opencode «Index:» style", () => {
  const [h] = parseUnified("@@ -5,2 +5,2 @@\n a\n-b\n+c\n");
  assert.equal(h.path, null);
  assert.equal(h.hunks[0].lines[2].n, 6);
  const oc = parseUnified("Index: D:\\w\\f.md\n===================================================================\n--- D:\\w\\f.md\n+++ D:\\w\\f.md\n@@ -1,1 +1,1 @@\n-a\n+b\n");
  assert.equal(oc.length, 1);
  assert.equal(oc[0].path, "D:\\w\\f.md");
});

test("Claude Edit (transcript name «edit», old_string/new_string): a fragment, partial, no line numbers", () => {
  const files = turnChanges([tool("edit", { file_path: "C:\\work\\src\\a.ts", old_string: "x = 1\ny = 2", new_string: "x = 1\ny = 3\nz = 4" })], { base: "C:\\work" });
  assert.equal(files.length, 1);
  const f = files[0];
  assert.equal(f.path, "src/a.ts");
  assert.equal(f.name, "a.ts");
  assert.equal(f.dir, "src");
  assert.equal(f.status, "M");
  assert.equal(f.partial, true);
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 1);
  assert.ok(f.hunks[0].lines.every((l) => l.o == null && l.n == null));
  assert.equal(hunkTitle(f.hunks[0]), "@@ фрагмент правки");
});

test("Claude MultiEdit ({edits[]}, also as a clipped JSON string) → one file", () => {
  const edits = [
    { old_string: "a", new_string: "A" },
    { old_string: "b", new_string: "B\nB2" },
  ];
  const [f] = turnChanges([tool("edit", { file_path: "/w/m.py", edits })], { base: "/w" });
  assert.equal(f.path, "m.py");
  assert.equal(f.additions, 3);
  assert.equal(f.deletions, 2);
  assert.equal(f.hunks.length, 2);
  const [g] = turnChanges([tool("edit", { file_path: "/w/m.py", edits: JSON.stringify(edits) })], { base: "/w" });
  assert.equal(g.additions, 3);
  const [clipped] = turnChanges([tool("edit", { file_path: "/w/m.py", edits: '[{"old_string":"a' + "\n… [обрезано: ещё 9 симв.]" })], { base: "/w" });
  assert.equal(clipped.partial, true);
  assert.equal(clipped.hunks.length, 0);
});

test("Claude Write: «File created» → A, «has been updated» → M (перезаписан); clipped content → partial", () => {
  const created = tool("write", { file_path: "/w/new.md", content: "# a\nb\n" }, { output: "File created successfully at: /w/new.md" });
  const updated = tool("write", { file_path: "/w/old.md", content: "x\n… [обрезано: ещё 10 симв.]" }, { output: "The file /w/old.md has been updated successfully." });
  const files = turnChanges([created, updated], { base: "/w" });
  assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.rewritten, f.partial]), [
    ["new.md", "A", 2, false, false],
    ["old.md", "M", 1, true, true],
  ]);
  assert.deepEqual(files[0].hunks[0].lines.map((l) => l.n), [1, 2]);
});

test("opencode edit with state.metadata.diff (recorded shape) → real line numbers", () => {
  // the shape opencode records for an edit: an «Index:» header with Windows paths, then a unified diff
  const file = "D:\\Vault\\agents\\tasks\\2026-10-30-web.md";
  const diff = [
    `Index: ${file}`,
    "===================================================================",
    `--- ${file}`,
    `+++ ${file}`,
    "@@ -26,4 +26,5 @@",
    " - the server listens on 127.0.0.1 only",
    " ",
    " ## State",
    "-- Done: the classic API is confirmed by live tests.",
    "+- Done: the API contract is fully checked.",
    "+- Waves: W0 scaffold, W1 proxy and static files.",
    "",
  ].join("\n");
  const edit = tool("edit", { filePath: file, oldString: "- Done: the classic API is confirmed by live tests.", newString: "- Done: the API contract is fully checked.\n- Waves: W0 scaffold, W1 proxy and static files." }, { metadata: { diff } });
  const created = tool("write", { filePath: "D:\\Vault\\agents\\tasks\\new.md", content: "# New\n" }, { metadata: { exists: false } });
  const parts = [edit, created];
  assert.ok(edit.state.metadata.diff.includes("@@ -26,4 +26,5 @@"), "fixture shape");
  const files = turnChanges([edit], { base: "D:\\Vault\\agents" });
  assert.equal(files.length, 1);
  const f = files[0];
  assert.equal(f.path, "tasks/2026-10-30-web.md");
  assert.equal(f.status, "M");
  assert.equal(f.partial, false);
  assert.ok(f.additions > 0 && f.deletions > 0);
  assert.equal(f.hunks[0].newStart, 26);
  assert.equal(f.hunks[0].lines[0].n, 26);
  // opencode write with metadata.exists:false → A
  const write = parts.find((p) => p.type === "tool" && p.tool === "write");
  const [w] = turnChanges([write]);
  assert.equal(w.status, "A");
});

test("opencode edit without metadata.diff: filediff before/after, then oldString/newString", () => {
  const [a] = turnChanges([tool("edit", { filePath: "/w/f.txt" }, { metadata: { filediff: { file: "/w/f.txt", before: "1\n2\n3\n", after: "1\n2b\n3\n" } } })], { base: "/w" });
  assert.equal(a.partial, false);
  assert.equal(a.hunks[0].lines[1].o, 2);
  const [b] = turnChanges([tool("edit", { filePath: "/w/f.txt", oldString: "2", newString: "2c" })], { base: "/w" });
  assert.equal(b.partial, true);
  assert.equal(b.additions, 1);
});

test("opencode patch: metadata.diff with several files / input.patchText", () => {
  const diff = "--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/y.js\n@@ -0,0 +1 @@\n+n\n";
  const files = turnChanges([tool("patch", { patchText: "" }, { metadata: { diff } })]);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [["x.js", "M"], ["y.js", "A"]]);
  const text = "*** Begin Patch\n*** Update File: src/z.ts\n@@ fn()\n keep\n-old\n+new\n*** Add File: docs/n.md\n+hello\n*** Delete File: gone.txt\n*** End Patch";
  const p = parseApplyPatch(text);
  assert.deepEqual(p.map((f) => [f.path, f.status, f.additions, f.deletions]), [["src/z.ts", "M", 1, 1], ["docs/n.md", "A", 1, 0], ["gone.txt", "D", 0, 0]]);
  const viaTool = turnChanges([tool("apply_patch", { patchText: text })]);
  assert.equal(viaTool.length, 3);
  assert.ok(viaTool.every((f) => f.partial));
});

test("Codex (shim): Edit {file_path, diff} → hunks with numbers; Write {content} → A; several files → names only", () => {
  const edit = tool("edit", { file_path: "D:\\work\\app.py", diff: "@@ -3,3 +3,3 @@\n a\n-b\n+c\n d\n" }, { output: "Изменено: D:\\work\\app.py" });
  const write = tool("write", { file_path: "D:\\work\\new.txt", content: "hello\n" }, { output: "Изменено: D:\\work\\new.txt" });
  const many = tool("edit", { file_path: "D:\\work\\a.txt", files: ["update D:\\work\\a.txt", "add D:\\work\\b.txt"] });
  const files = turnChanges([edit, write, many], { base: "D:\\work" });
  assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions]), [
    ["app.py", "M", 1, 1],
    ["new.txt", "A", 1, 0],
    ["a.txt", "M", 0, 0],
    ["b.txt", "A", 0, 0],
  ]);
  assert.equal(files[0].hunks[0].lines[1].o, 4);
  assert.equal(files[2].partial, true);
});

test("two edits of one file in a turn merge in order; A stays A; paths match across slashes and case", () => {
  const files = turnChanges([
    tool("write", { file_path: "C:\\W\\Notes.md", content: "a\n" }, { output: "File created successfully" }),
    tool("edit", { file_path: "c:/w/notes.md", old_string: "a", new_string: "b" }),
    tool("edit", { file_path: "C:\\W\\other.md", old_string: "1", new_string: "2" }),
    tool("edit", { file_path: "C:\\W\\other.md", old_string: "3", new_string: "4" }),
  ], { base: "C:\\W" });
  assert.equal(files.length, 2);
  assert.equal(files[0].status, "A");
  assert.equal(files[0].edits, 2);
  assert.equal(files[0].hunks.length, 2);
  assert.equal(files[1].additions, 2);
  assert.equal(files[1].deletions, 2);
  assert.deepEqual(totals(files), { files: 2, additions: 4, deletions: 3 });
});

test("only completed tools count: error, running, denied and non-file tools are ignored", () => {
  const files = turnChanges([
    { type: "tool", tool: "edit", state: { status: "error", input: { file_path: "/a", old_string: "x", new_string: "y" }, error: "denied" } },
    { type: "tool", tool: "write", state: { status: "running", input: { file_path: "/b", content: "z" } } },
    { type: "tool", tool: "read", state: { status: "completed", input: { file_path: "/c" } } },
    { type: "tool", tool: "bash", state: { status: "completed", input: { command: "echo > /d" } } },
    { type: "text", text: "готово" },
  ]);
  assert.deepEqual(files, []);
});

test("helpers: plural, labels, relPath, limitHunks, bigCount, toUnified", () => {
  assert.equal(filesLabel(1), "1 файл");
  assert.equal(filesLabel(3), "3 файла");
  assert.equal(filesLabel(11), "11 файлов");
  assert.equal(unchangedLabel(31), "31 строка без изменений");
  assert.equal(plural(22, "a", "b", "c"), "b");
  assert.equal(relPath("D:\\Work\\src\\x.js", "d:\\work\\"), "src/x.js");
  assert.equal(relPath("/elsewhere/x.js", "/w"), "/elsewhere/x.js");
  const d = lineDiff("", Array.from({ length: 900 }, (_, i) => "x" + i).join("\n"));
  assert.equal(limitHunks(d.hunks, 400).reduce((n, h) => n + h.lines.length, 0), 400);
  assert.equal(bigCount(9602), "9,6 тыс.");
  assert.equal(bigCount(812), "812");
  const [f] = turnChanges([tool("edit", { file_path: "/w/a", diff: "@@ -1 +1 @@\n-a\n+b\n" })], { base: "/w" });
  assert.equal(toUnified(f), "--- a/a\n+++ b/a\n@@ -1,1 +1,1 @@\n-a\n+b\n");
});

test("Codex: real lib/codex-shim.mjs toolOf(fileChange) → Edit/Write parts → turnChanges (one update, one add, several adds)", async () => {
  const { toolOf } = await import("../lib/codex-shim.mjs");
  const asPart = (item) => {
    const t = toolOf(item);
    return { type: "tool", tool: t.name, callID: item.id, state: { status: "completed", input: t.input, output: "" } };
  };
  const upd = asPart({ id: "f1", type: "fileChange", status: "completed", changes: [{ path: "D:\\w\\app.py", kind: { type: "update" }, diff: "@@ -1,2 +1,2 @@\n-a\n+A\n b\n" }] });
  const add = asPart({ id: "f2", type: "fileChange", status: "completed", changes: [{ path: "D:\\w\\new.md", kind: { type: "add" }, diff: "# hi\nthere\n" }] });
  const adds = asPart({ id: "f3", type: "fileChange", status: "completed", changes: [{ path: "D:\\w\\x.txt", kind: { type: "add" }, diff: "x" }, { path: "D:\\w\\y.txt", kind: { type: "add" }, diff: "y" }] });
  assert.equal(upd.tool, "Edit");
  assert.equal(add.tool, "Write");
  const files = turnChanges([upd, add, adds], { base: "D:\\w" });
  assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions]), [
    ["app.py", "M", 1, 1],
    ["new.md", "A", 2, 0],
    ["x.txt", "A", 0, 0],
    ["y.txt", "A", 0, 0],
  ]);
});
