// FEAT-01.57 / FEAT-01.58 units: the PreToolUse backup hook, TurnUndo
// (preview / revert / unrevert / seal), the CLI transcript cut and the gc
// sweep of data/turn-undo.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HOOK_PATH, TurnUndo, cutCopy, findTranscript, lastPromptOffset, projectsRoot, slugOf } from "../lib/turn-undo.js";
import { backup, targetOf } from "../lib/turn-undo-hook.mjs";
import { sweepTurnUndo } from "../lib/gc.js";

const TMP = mkdtempSync(path.join(tmpdir(), "zai-turn-undo-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const work = path.join(TMP, "work");
mkdirSync(work, { recursive: true });

test("hook: the real script keeps the first state of a file, records a new file as created, exits 0 on junk", () => {
  const undo = new TurnUndo({ root: path.join(TMP, "undo1") });
  const dir = undo.startTurn("ses_1", "msgc_u1");
  writeFileSync(path.join(work, "a.txt"), "до");
  const run = (input) => execFileSync(process.execPath, [HOOK_PATH, dir], { input, encoding: "utf8" });
  assert.equal(run(JSON.stringify({ cwd: work, tool_name: "Edit", tool_input: { file_path: "a.txt" } })), "", "nothing on stdout");
  writeFileSync(path.join(work, "a.txt"), "после 1");
  run(JSON.stringify({ cwd: work, tool_name: "Edit", tool_input: { file_path: path.join(work, "a.txt") } }));
  run(JSON.stringify({ cwd: work, tool_name: "NotebookEdit", tool_input: { notebook_path: "n.ipynb" } }));
  run("not json");
  const recs = undo.records("ses_1", "msgc_u1");
  assert.equal(recs.length, 2);
  const a = recs.find((r) => r.path.endsWith("a.txt"));
  assert.equal(a.existed, true);
  assert.equal(readFileSync(path.join(dir, `${a.key}.bak`), "utf8"), "до", "the FIRST state, not the second");
  assert.equal(recs.find((r) => r.path.endsWith("n.ipynb")).existed, false);
});

test("hook settings: PreToolUse on Write|Edit|MultiEdit|NotebookEdit, quoted forward-slash command", () => {
  const undo = new TurnUndo({ root: "C:\\data dir\\turn-undo", nodePath: "C:\\Program Files\\nodejs\\node.exe", hookPath: "D:\\Portal\\zai\\lib\\turn-undo-hook.mjs" });
  const h = undo.hookSettings("ses_1", "msgc_u1");
  assert.equal(h.PreToolUse[0].matcher, "Write|Edit|MultiEdit|NotebookEdit");
  assert.equal(h.PreToolUse[0].hooks[0].command, '"C:/Program Files/nodejs/node.exe" "D:/Portal/zai/lib/turn-undo-hook.mjs" "C:/data dir/turn-undo/ses_1/msgc_u1"');
  assert.equal(undo.hookSettings("../x", "msgc_u1"), null, "unsafe ids never become paths");
  assert.equal(targetOf({ cwd: "C:\\w", tool_input: {} }), null);
});

test("TurnUndo: preview lists only changed files; revert/unrevert round-trip; a later change is never clobbered", () => {
  const root = path.join(TMP, "undo2");
  const undo = new TurnUndo({ root });
  const dir = undo.startTurn("ses_2", "t1");
  const f = (n) => path.join(work, n);
  writeFileSync(f("edit.txt"), "было");
  writeFileSync(f("same.txt"), "тот же");
  writeFileSync(f("late.txt"), "до");
  for (const n of ["edit.txt", "same.txt", "late.txt", "new.txt"]) backup(dir, f(n));
  writeFileSync(f("edit.txt"), "стало");
  writeFileSync(f("late.txt"), "ход");
  writeFileSync(f("new.txt"), "создан");
  undo.seal("ses_2", "t1");
  writeFileSync(f("late.txt"), "человек");

  const pv = undo.preview("ses_2", "t1");
  const byName = Object.fromEntries(pv.map((x) => [path.basename(x.path), x]));
  assert.deepEqual(Object.keys(byName).sort(), ["edit.txt", "late.txt", "new.txt"], "unchanged same.txt left out");
  assert.equal(byName["edit.txt"].action, "restore");
  assert.equal(byName["new.txt"].action, "delete");
  assert.equal(byName["late.txt"].skipped, "changed-after");
  assert.deepEqual(undo.preview("ses_2", "t1", { within: (p) => p.endsWith("new.txt") }).map((x) => path.basename(x.path)), ["new.txt"]);

  const r = undo.revert("ses_2", "t1");
  assert.equal(r.files.length, 2);
  assert.equal(readFileSync(f("edit.txt"), "utf8"), "было");
  assert.equal(existsSync(f("new.txt")), false);
  assert.equal(readFileSync(f("late.txt"), "utf8"), "человек");
  undo.unrevert("ses_2", "t1");
  assert.equal(readFileSync(f("edit.txt"), "utf8"), "стало");
  assert.equal(readFileSync(f("new.txt"), "utf8"), "создан");

  // a new turn drops the older turns' backups (only the last is undoable)
  undo.startTurn("ses_2", "t2");
  assert.deepEqual(readdirSync(path.join(root, "ses_2")), ["t2"]);
  undo.forget("ses_2");
  assert.equal(existsSync(path.join(root, "ses_2")), false);
});

test("transcript: slug like the CLI, the cut copy ends before the dropped prompt, legacy cut = before the last prompt", () => {
  assert.equal(slugOf("D:\\Portal\\zai\\.claude\\w"), "D--Portal-zai--claude-w");
  assert.equal(projectsRoot({ CLAUDE_CONFIG_DIR: "C:\\cfg" }), path.join("C:\\cfg", "projects"));
  const root = path.join(TMP, "projects");
  const cwd = "D:\\chat dir";
  mkdirSync(path.join(root, slugOf(cwd)), { recursive: true });
  const L = (o) => JSON.stringify(o) + "\n";
  const turn1 = L({ type: "queue-operation", operation: "enqueue" }) + L({ type: "user", message: { content: "один" } }) + L({ type: "assistant", message: { content: [] } }) + L({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }) + L({ type: "user", isMeta: true, message: { content: "meta" } });
  const turn2 = L({ type: "queue-operation", operation: "enqueue" }) + L({ type: "user", message: { content: [{ type: "text", text: "два" }] } }) + L({ type: "assistant", message: { content: [] } });
  const src = path.join(root, slugOf(cwd), "abc-1.jsonl");
  writeFileSync(src, turn1 + turn2);
  assert.equal(findTranscript(root, cwd, "abc-1"), src);
  assert.equal(findTranscript(root, "D:\\elsewhere", "abc-1"), src, "found in any project folder");
  assert.equal(findTranscript(root, cwd, "../evil"), null);
  assert.equal(lastPromptOffset(Buffer.from(turn1 + turn2)), Buffer.byteLength(turn1));

  const exact = cutCopy({ root, dir: cwd, from: "abc-1", bytes: Buffer.byteLength(turn1) });
  assert.equal(readFileSync(exact.file, "utf8"), turn1);
  assert.match(exact.resume, /^[0-9a-f-]{36}$/);
  const legacy = cutCopy({ root, dir: cwd, from: "abc-1", bytes: null });
  assert.equal(readFileSync(legacy.file, "utf8"), turn1);
  assert.equal(cutCopy({ root, dir: cwd, from: "missing", bytes: 5 }), null);
});

test("gc: turn-undo folders of unknown chats go, stale turns go, live ones stay", () => {
  const root = path.join(TMP, "gc");
  for (const p of ["ses_gone/t1", "ses_live/t_new", "ses_live/t_old"]) mkdirSync(path.join(root, p), { recursive: true });
  const old = (Date.now() - 30 * 86_400_000) / 1000;
  utimesSync(path.join(root, "ses_live/t_old"), old, old);
  const r = sweepTurnUndo({ root, keep: new Set(["ses_live"]), maxAgeMs: 14 * 86_400_000 });
  assert.equal(r.removed.length, 2);
  assert.deepEqual(readdirSync(path.join(root, "ses_live")), ["t_new"]);
  assert.equal(existsSync(path.join(root, "ses_gone")), false);
  assert.deepEqual(sweepTurnUndo({ root: path.join(TMP, "nope") }).removed, []);
});
