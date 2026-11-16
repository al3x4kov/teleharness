// FEAT-18.8: lib/git.js on a real temporary repository — status (branch,
// upstream, ahead, untracked with line counts, numstat), the diff of one file
// (untracked whole, binary, truncation, full), a commit of exactly the
// selected files with the author from the arguments, path escapes → 400, the
// untrusted-repo guard, push errors with a local bare remote / no upstream /
// a refusing HTTP remote (auth) / a dead port (network).
// Run: node --test tests/git.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GitError, classifyPushError, cleanRelPath, countPatch, dangerousKey, gitCommit, gitDiff, gitPush, gitStatus,
  openRepo, parseNumstat, parseStatus, sanitize, DIFF_LINES,
} from "../lib/git.js";

const TMP = mkdtempSync(path.join(os.tmpdir(), "teleharness-git-unit-"));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const sh = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=Seed", "-c", "user.email=seed@x", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let n = 0;
function makeRepo() {
  const dir = path.join(TMP, `r${++n}`);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(path.join(dir, "b.txt"), "bee\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}
const AUTHOR = { name: "Анна Тест", email: "anna@teleharness.local" };

test("pure parsers: porcelain v2, numstat, patch counts", () => {
  const st = parseStatus(
    ["# branch.oid abc", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 h1 h2 a b.txt", "1 A. N... 000000 100644 100644 h0 h2 new file.txt",
      "2 R. N... 100644 100644 100644 h1 h1 R100 new.txt", "old.txt", "u UU N... 1 2 3 4 h1 h2 h3 c.txt", "? untracked/x.md", "? nested-repo/", ""].join("\0"),
  );
  assert.deepEqual(st.branch, { oid: "abc", head: "main", upstream: "origin/main", ahead: 2, behind: 1 });
  assert.deepEqual(st.files.map((f) => [f.path, f.status, f.staged, f.oldPath]), [
    ["a b.txt", "M", false, undefined],
    ["new file.txt", "A", true, undefined],
    ["new.txt", "R", true, "old.txt"],
    ["c.txt", "U", false, undefined],
    ["untracked/x.md", "?", false, undefined],
  ]);
  const ns = parseNumstat(["3\t1\ta.txt", "-\t-\timg.png", "2\t0\t", "old.txt", "new.txt", ""].join("\0"));
  assert.deepEqual(ns.get("a.txt"), { additions: 3, deletions: 1, binary: false });
  assert.deepEqual(ns.get("img.png"), { additions: 0, deletions: 0, binary: true });
  assert.deepEqual(ns.get("new.txt"), { additions: 2, deletions: 0, binary: false });
  assert.deepEqual(countPatch("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-a\n+b\n+c\n"), { additions: 2, deletions: 1 });
});

test("cleanRelPath: relative, normalized, inside the root; escapes → 400", () => {
  const root = process.platform === "win32" ? "C:\\repo" : "/repo";
  assert.equal(cleanRelPath(root, "src\\a.js"), "src/a.js");
  assert.equal(cleanRelPath(root, "src/./x/../a.js"), "src/a.js");
  // pathspec magic is never magic (GIT_LITERAL_PATHSPECS); on Windows ":" is not a file-name character at all
  if (process.platform === "win32") assert.throws(() => cleanRelPath(root, ":(top)a"), (e) => e.status === 400);
  else assert.equal(cleanRelPath(root, ":(top)a"), ":(top)a");
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:\\x", "c:/x", "\\\\srv\\share\\x", "", ".", "a\0b", "a\nb", ".git/config", "x/.GIT/hooks"]) {
    assert.throws(() => cleanRelPath(root, bad), (e) => e instanceof GitError && e.status === 400, JSON.stringify(bad));
  }
  assert.throws(() => cleanRelPath(root, 42), (e) => e.status === 400);
});

test("status: branch, files with +/−, untracked counted, last commit", async () => {
  const dir = makeRepo();
  writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(path.join(dir, "new.md"), "x\ny\nz");
  mkdirSync(path.join(dir, "Папка"));
  writeFileSync(path.join(dir, "Папка", "файл.txt"), "привет\n");
  writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0]));
  const repo = await openRepo(path.join(dir, "Папка"));
  // macOS: the temp dir /var is a link to /private/var — compare real paths
  assert.equal(realpathSync(repo.root).toLowerCase(), realpathSync(dir).toLowerCase(), "root found from a subfolder");
  const st = await gitStatus(repo);
  assert.equal(st.repo, true);
  assert.equal(st.branch, "main");
  assert.equal(st.detached, false);
  assert.equal(st.upstream, null);
  assert.equal(st.lastCommit.subject, "init");
  assert.match(st.lastCommit.hash, /^[0-9a-f]{40}$/);
  assert.ok(st.lastCommit.at > 1e12, "ms epoch");
  const by = Object.fromEntries(st.files.map((f) => [f.path, f]));
  assert.deepEqual([by["a.txt"].status, by["a.txt"].additions, by["a.txt"].deletions], ["M", 2, 1]);
  assert.deepEqual([by["new.md"].status, by["new.md"].additions], ["?", 3]);
  assert.ok(by["Папка/файл.txt"], "non-ASCII path as UTF-8 (core.quotepath=off)");
  assert.equal(by["bin.dat"].binary, true);
});

test("status: not a repository → null; a missing folder → null", async () => {
  const plain = path.join(TMP, "plain");
  mkdirSync(plain);
  assert.equal(await openRepo(plain), null);
  assert.equal(await openRepo(path.join(TMP, "nope")), null);
});

test("diff: tracked vs HEAD, untracked whole, binary, truncated / full, escape → 400", async () => {
  const dir = makeRepo();
  writeFileSync(path.join(dir, "a.txt"), "one\r\nTWO\r\n");
  writeFileSync(path.join(dir, "fresh.txt"), "l1\nl2\n");
  writeFileSync(path.join(dir, "img.bin"), Buffer.from([0, 255, 0, 1]));
  writeFileSync(path.join(dir, "big.txt"), Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const repo = await openRepo(dir);
  const d = await gitDiff(repo, "a.txt");
  assert.equal(d.file, "a.txt");
  assert.match(d.patch, /^-two$/m);
  assert.match(d.patch, /^\+TWO$/m, "CRLF normalized");
  assert.equal(d.patch.includes("\r"), false);
  assert.equal(d.binary, false);
  assert.equal(d.truncated, false);
  const u = await gitDiff(repo, "fresh.txt");
  assert.deepEqual([u.additions, u.deletions], [2, 0]);
  assert.match(u.patch, /^\+l1$/m);
  const b = await gitDiff(repo, "img.bin");
  assert.equal(b.binary, true);
  const big = await gitDiff(repo, "big.txt");
  assert.equal(big.truncated, true);
  assert.equal(big.patch.trimEnd().split("\n").length, DIFF_LINES);
  assert.equal(big.additions, 1000, "counts cover the whole file");
  const full = await gitDiff(repo, "big.txt", { full: true });
  assert.equal(full.truncated, false);
  await assert.rejects(gitDiff(repo, "../outside.txt"), (e) => e.status === 400);
  await assert.rejects(gitDiff(repo, path.join(dir, "a.txt")), (e) => e.status === 400);
});

test("commit: exactly the selected files (untracked included), author from settings, the rest untouched", async () => {
  const dir = makeRepo();
  writeFileSync(path.join(dir, "a.txt"), "changed a\n");
  writeFileSync(path.join(dir, "b.txt"), "changed b\n");
  writeFileSync(path.join(dir, "c.txt"), "new c\n");
  writeFileSync(path.join(dir, "staged.txt"), "staged only\n");
  sh(dir, "add", "staged.txt");
  const repo = await openRepo(dir);
  const out = await gitCommit(repo, { files: ["a.txt", "c.txt"], message: "  feat: two files\n\nbody  ", author: AUTHOR });
  assert.match(out.hash, /^[0-9a-f]{40}$/);
  assert.equal(out.subject, "feat: two files");
  assert.deepEqual(out.files, ["a.txt", "c.txt"]);
  assert.equal(sh(dir, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort().join(","), "a.txt,c.txt");
  assert.equal(sh(dir, "log", "-1", "--format=%an <%ae>|%cn <%ce>").trim(), "Анна Тест <anna@teleharness.local>|Анна Тест <anna@teleharness.local>");
  const st = await gitStatus(repo);
  const by = Object.fromEntries(st.files.map((f) => [f.path, f]));
  assert.equal(by["b.txt"].status, "M", "unselected change stays");
  assert.equal(by["staged.txt"].status, "A", "foreign staged file stays staged");
  assert.equal(by["staged.txt"].staged, true);
  assert.equal(by["a.txt"], undefined);
  await assert.rejects(gitCommit(repo, { files: ["b.txt"], message: "   ", author: AUTHOR }), (e) => e.status === 400);
  await assert.rejects(gitCommit(repo, { files: ["../x"], message: "m", author: AUTHOR }), (e) => e.status === 400);
  await assert.rejects(gitCommit(repo, { files: ["a.txt"], message: "m", author: AUTHOR }), (e) => e.status === 400, "unchanged file");
  await assert.rejects(gitCommit(repo, { files: [], message: "m", author: AUTHOR }), (e) => e.status === 400);
});

test("commit: the first commit of an empty repository; a deleted file", async () => {
  const dir = path.join(TMP, "empty");
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "x.txt"), "x\n");
  writeFileSync(path.join(dir, "y.txt"), "y\n");
  const repo = await openRepo(dir);
  const st0 = await gitStatus(repo);
  assert.equal(st0.lastCommit, null);
  const c = await gitCommit(repo, { files: ["x.txt"], message: "first", author: AUTHOR });
  assert.equal(c.subject, "first");
  const d2 = makeRepo();
  rmSync(path.join(d2, "b.txt"));
  const r2 = await openRepo(d2);
  assert.equal((await gitStatus(r2)).files[0].status, "D");
  await gitCommit(r2, { files: ["b.txt"], message: "rm b", author: AUTHOR });
  assert.equal((await gitStatus(r2)).files.length, 0);
});

test("untrusted repository: a config key that runs a program → 409; plain config passes", async () => {
  const dir = makeRepo();
  assert.ok(await openRepo(dir, { untrusted: true }));
  sh(dir, "config", "core.fsmonitor", "evil.exe");
  await assert.rejects(openRepo(dir, { untrusted: true }), (e) => e.status === 409);
  assert.ok(await openRepo(dir), "trusted (admin) opens it");
  for (const k of ["filter.x.clean", "diff.x.textconv", "core.hooksPath", "include.path", "includeIf.gitdir:/x.path", "credential.helper", "core.sshCommand"]) assert.equal(dangerousKey(k), true, k);
  for (const k of ["user.name", "branch.main.remote", "core.autocrlf", "remote.origin.url"]) assert.equal(dangerousKey(k), false, k);
});

test("push: ok to a bare remote; rejected (non-fast-forward); no upstream", async () => {
  const bare = path.join(TMP, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const dir = makeRepo();
  sh(dir, "remote", "add", "origin", bare);
  sh(dir, "push", "-q", "-u", "origin", "main");
  writeFileSync(path.join(dir, "a.txt"), "next\n");
  const repo = await openRepo(dir);
  await gitCommit(repo, { files: ["a.txt"], message: "next", author: AUTHOR });
  const st = await gitStatus(repo);
  assert.equal(st.upstream, "origin/main");
  assert.equal(st.ahead, 1);
  assert.deepEqual(await gitPush(repo), { ok: true, pushed: 1 });
  assert.equal((await gitStatus(repo)).ahead, 0);
  // a second clone moves the remote ahead → our next push is rejected
  const other = path.join(TMP, "other");
  execFileSync("git", ["clone", "-q", bare, other]);
  writeFileSync(path.join(other, "z.txt"), "z\n");
  sh(other, "add", ".");
  sh(other, "commit", "-q", "-m", "other");
  sh(other, "push", "-q");
  writeFileSync(path.join(dir, "b.txt"), "mine\n");
  await gitCommit(repo, { files: ["b.txt"], message: "mine", author: AUTHOR });
  await assert.rejects(gitPush(repo), (e) => e.status === 409 && e.extra.kind === "rejected" && !e.message.includes(TMP));
  const lone = makeRepo();
  await assert.rejects(gitPush(await openRepo(lone)), (e) => e.status === 409 && e.extra.kind === "no-upstream");
});

test("push: an HTTP remote asking for credentials → auth; a dead port → network", async () => {
  const srv = http.createServer((req, res) => {
    req.resume();
    res.writeHead(401, { "www-authenticate": 'Basic realm="x"' });
    res.end("no");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const dir = makeRepo();
    sh(dir, "remote", "add", "origin", `http://127.0.0.1:${srv.address().port}/r.git`);
    sh(dir, "config", "branch.main.remote", "origin");
    sh(dir, "config", "branch.main.merge", "refs/heads/main");
    sh(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    const repo = await openRepo(dir);
    await assert.rejects(gitPush(repo), (e) => e.status === 502 && e.extra.kind === "auth");
    // a port nobody listens on
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, "127.0.0.1", r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    sh(dir, "remote", "set-url", "origin", `http://127.0.0.1:${port}/r.git`);
    await assert.rejects(gitPush(repo), (e) => e.status === 502 && e.extra.kind === "network");
  } finally {
    srv.close();
  }
});

test("classifyPushError / sanitize: kinds and no server paths", () => {
  assert.equal(classifyPushError("fatal: could not read Username for 'https://github.com': terminal prompts disabled").kind, "auth");
  assert.equal(classifyPushError("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.").kind, "auth");
  assert.equal(classifyPushError(" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs").kind, "rejected");
  assert.equal(classifyPushError("fatal: unable to access 'https://x/': Could not resolve host: x").kind, "network");
  assert.equal(classifyPushError("", { timedOut: true }).kind, "network");
  const u = classifyPushError("fatal: weird thing at C:\\Users\\USER\\repo and /home/u/repo");
  assert.equal(u.kind, "unknown");
  assert.equal(/Users|home\/u/.test(u.error), false, u.error);
  assert.equal(sanitize("https://user:secret@github.com/a/b.git"), "https://github.com");
});
