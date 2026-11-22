// @suite: server
// FEAT-20.7: lib/worktrees.js на настоящих временных репозиториях — имя ветки,
// создание копии (ссылки, .env, перенос незакоммиченного, лимиты, место),
// пересечения и пробное слияние, слияние с тестами до сдвига базы (успех,
// конфликт, тесты упали, тайм-аут, основная копия грязная, база сдвинулась,
// идемпотентность), отмена слияния, удаление без потери работы, восстановление
// после перезапуска, уборка, тенант (папка чата), опасный конфиг.
// Run: node --test tests/worktrees.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Worktrees, WorktreeStore, detectTestCmd, freePortBlock, intersect, parseMergeTree, recoverDecision, tailOf, tenantTestCommand, testSummary,
} from "../lib/worktrees.js";
import { branchName, branchSlug, freeBranchName, isPortalBranch, resolveConflictText, translit, worktreeRule } from "../shared/worktree.js";

const TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), "teleharness-wt-unit-")));
after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {}
});
const sh = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Seed", "-c", "user.email=seed@x", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let n = 0;
function makeRepo({ test = "node -e \"process.exit(require('fs').existsSync('FAIL')?1:0)\"" } = {}) {
  const base = path.join(TMP, `p${++n}`);
  const dir = path.join(base, "proj");
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(path.join(dir, "b.txt"), "bee\n");
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test } }));
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}
function makeSvc(opts = {}) {
  const dataDir = path.join(TMP, `data${++n}`);
  const events = [];
  const busy = new Set();
  const svc = new Worktrees({
    store: new WorktreeStore({ dir: dataDir, log: () => {} }), dataDir, log: () => {}, emit: (it, what) => events.push([it.id, what]),
    busy: (sid) => busy.has(sid), author: () => ({ name: "Тест", email: "t@x" }), statfs: () => ({ bavail: 1e9, bsize: 4096 }), ...opts,
  });
  return { svc, events, busy, dataDir };
}
const waitOp = async (svc, op) => {
  for (let i = 0; i < 400; i++) {
    const o = svc.op(op.opId);
    if (["done", "failed", "interrupted"].includes(o.phase)) return o;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("op timeout");
};
const mk = (svc, dir, sid, text = "Добавь индекс по customer_id", extra = {}) => svc.create({ sid, kind: "chat", owner: "admin", tenant: false, dir, untrusted: false, text, ...extra });
const commitIn = (dir, file, body, msg = "edit") => {
  writeFileSync(path.join(dir, file), body);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", msg);
};
const head = (dir, ref = "HEAD") => sh(dir, "rev-parse", ref).trim();

test("pure: translit, slug, branch names, suffix, portal branch check", () => {
  assert.equal(translit("Добавь индекс"), "dobav indeks");
  assert.equal(branchSlug("Добавь индекс по customer_id"), "dobav-indeks-po-customer-id");
  assert.equal(branchName("Добавь индекс по customer_id, пожалуйста, и тесты", "E4DB"), "teleharness/dobav-indeks-po-customer-id-e4db");
  assert.ok(branchName("x".repeat(80), "abcd").length <= "teleharness/".length + 32 + 5);
  assert.equal(branchName("", "abcd"), "teleharness/task-abcd");
  assert.equal(branchName("ignored", "abcd", { custom: "Fix Orders" }), "teleharness/fix-orders");
  assert.equal(freeBranchName("teleharness/fix-orders", ["teleharness/fix-orders", "teleharness/fix-orders-2"]), "teleharness/fix-orders-3");
  assert.ok(isPortalBranch("teleharness/fix-orders-2"));
  for (const bad of ["main", "teleharness/..", "teleharness/x.lock", "teleharness/Upper", "teleharness/a//b", "teleharness/"]) assert.equal(isPortalBranch(bad), false, bad);
  assert.match(worktreeRule({ branch: "teleharness/x", base: "main", port: 43120 }), /43120–43129/);
  assert.match(resolveConflictText({ branch: "teleharness/x", files: ["a.ts"] }), /git merge main/);
});

test("pure: test command detection, tenant npm translation, merge-tree parse, recover decision, ports, summary", () => {
  const files = { "package.json": JSON.stringify({ scripts: { test: "node --test" } }) };
  const fs = { exists: (f) => path.basename(f) in files, read: (f) => files[path.basename(f)] };
  assert.deepEqual(detectTestCmd("/r", fs), { cmd: "npm test", source: "package.json" });
  files["package.json"] = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
  assert.equal(detectTestCmd("/r", fs), null);
  files["Cargo.toml"] = "";
  assert.equal(detectTestCmd("/r", fs).cmd, "cargo test");
  assert.equal(tenantTestCommand("npm test", JSON.stringify({ scripts: { test: "node --test t/" } })), 'PATH="$PWD/node_modules/.bin:$PATH"; node --test t/');
  assert.equal(tenantTestCommand("pytest -q", "{}"), "pytest -q");
  assert.deepEqual(parseMergeTree(0, "abc\n"), { conflict: false, files: [] });
  assert.deepEqual(parseMergeTree(1, "abc\nsrc/a.ts\nsrc/b.ts\n\n"), { conflict: true, files: ["src/a.ts", "src/b.ts"] });
  assert.equal(parseMergeTree(128, ""), null);
  assert.deepEqual(recoverDecision({ phase: "advance", newSha: "n", mainOld: "o" }, "n"), { phase: "done", outcome: "completed" });
  assert.deepEqual(recoverDecision({ phase: "advance", newSha: "n", mainOld: "o" }, "o"), { phase: "interrupted", outcome: "main-unchanged" });
  assert.equal(recoverDecision({ phase: "advance", newSha: "n", mainOld: "o" }, "z").phase, "failed");
  assert.equal(recoverDecision({ phase: "test" }, "o").phase, "interrupted");
  assert.equal(recoverDecision({ phase: "done" }, "o"), null);
  assert.equal(freePortBlock([43000, 43010]), 43020);
  assert.equal(tailOf("a\nb\nc\n", 2), "b\nc");
  assert.deepEqual(intersect(new Set(["a", "b"]), new Set(["b", "c"])), ["b"]);
  assert.deepEqual(testSummary("# tests 215\n# pass 212\n# fail 3\n"), { pass: 212, fail: 3 });
  assert.deepEqual(testSummary("✔ total\nℹ tests 2\nℹ pass 2\nℹ fail 0\n"), { pass: 2, fail: 0 }, "spec-репортёр Node 24 (dogfood)");
});

test("plan: not git, no commits, dirty files, branches, test command", async () => {
  const { svc } = makeSvc();
  const plain = path.join(TMP, "plain");
  mkdirSync(plain, { recursive: true });
  assert.deepEqual(await svc.plan({ dir: plain, untrusted: false, tenant: false, owner: "admin" }), { repo: false, reason: "not-git" });
  const empty = path.join(TMP, "emptyrepo");
  mkdirSync(empty, { recursive: true });
  sh(empty, "init", "-q", "-b", "main");
  assert.equal((await svc.plan({ dir: empty, untrusted: false, tenant: false, owner: "admin" })).reason, "no-commits");
  const dir = makeRepo();
  writeFileSync(path.join(dir, "a.txt"), "changed\n");
  const p = await svc.plan({ dir, untrusted: false, tenant: false, owner: "admin" });
  assert.equal(p.repo, true);
  assert.equal(p.base, "main");
  assert.deepEqual(p.dirty, ["a.txt"]);
  assert.equal(p.testCmd, "npm test");
  assert.ok(p.estimateBytes > 0);
});

test("create: branch from first message, path next to project, link node_modules, copy ignored .env, carry dirty, lock, port", async () => {
  const { svc } = makeSvc();
  const dir = makeRepo();
  mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
  writeFileSync(path.join(dir, "a.txt"), "dirty\n");
  writeFileSync(path.join(dir, "new.txt"), "untracked\n");
  const it = await mk(svc, dir, "ses_a", "Добавь индекс", { carryDirty: true });
  assert.match(it.branch, /^teleharness\/dobav-indeks-[a-z0-9]{4}$/);
  assert.equal(it.path, path.join(path.dirname(dir), ".teleharness-worktrees", "proj", it.branch.slice("teleharness/".length)));
  assert.ok(lstatSync(path.join(it.path, "node_modules")).isSymbolicLink());
  assert.equal(readFileSync(path.join(it.path, ".env"), "utf8"), "SECRET=1\n");
  assert.equal(readFileSync(path.join(it.path, "a.txt"), "utf8"), "dirty\n");
  assert.equal(readFileSync(path.join(it.path, "new.txt"), "utf8"), "untracked\n");
  assert.equal(readFileSync(path.join(dir, "a.txt"), "utf8"), "dirty\n", "основная копия не изменена");
  assert.match(sh(dir, "worktree", "list", "--porcelain"), /locked teleharness chat ses_a/);
  assert.equal(it.port, 43000);
  assert.equal(svc.workDirOf("ses_a"), it.path);
  // ссылка и .env не видны как изменения копии
  const st = await svc.status(it, { admin: true, titleOf: (sid) => (sid === "ses_a" ? "Индекс заказов" : null) });
  assert.deepEqual(st.files.map((f) => f.path).sort(), ["a.txt", "new.txt"]);
  assert.equal(st.title, "Индекс заказов", "название чата в состоянии копии (dogfood)");
  // занятое имя → суффикс
  const it2 = await svc.create({ sid: "ses_b", owner: "admin", dir, untrusted: false, branch: it.branch });
  assert.equal(it2.branch, `${it.branch}-2`);
});

// BUG-274 (BUG-20.12): незакоммиченные правки в листе копии были «+0 −0»
test("BUG-274: status — незакоммиченная правка +4 −0, удаление строки −1, неотслеживаемый файл — число строк; итог включает их", async () => {
  const { svc } = makeSvc();
  const dir = makeRepo();
  const it = await mk(svc, dir, "ses_274", "Числа незакоммиченного");
  commitIn(it.path, "b.txt", "bee\nbuzz\n", "commit b"); // закоммичено: b.txt +1
  writeFileSync(path.join(it.path, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n"); // +4 без коммита
  writeFileSync(path.join(it.path, "b.txt"), "bee\nbuzz\nbzz\n"); // закоммичено +1 и ещё +1 без коммита
  writeFileSync(path.join(it.path, "new.txt"), "x\ny\nz"); // неотслеживаемый, 3 строки без \n в конце
  writeFileSync(path.join(it.path, "bin.dat"), Buffer.from([0, 1, 2, 0, 10])); // двоичный — без чисел
  const st = await svc.status(it);
  const by = Object.fromEntries(st.files.map((f) => [f.path, f]));
  assert.deepEqual([by["a.txt"].additions, by["a.txt"].deletions, by["a.txt"].uncommitted], [4, 0, true]);
  assert.deepEqual([by["b.txt"].additions, by["b.txt"].deletions], [2, 0], "закоммиченное + незакоммиченное от merge-base");
  assert.deepEqual([by["new.txt"].additions, by["new.txt"].deletions], [3, 0]);
  assert.equal(by["bin.dat"].additions, 0);
  assert.equal(st.additions, 9);
  assert.equal(st.deletions, 0);
  writeFileSync(path.join(it.path, "a.txt"), "one\nthree\n"); // −1 без коммита
  const st2 = await svc.status(it);
  const a2 = st2.files.find((f) => f.path === "a.txt");
  assert.deepEqual([a2.additions, a2.deletions], [0, 1]);
});

test("create: empty chat does not create; pending → first turn creates once (concurrent)", async () => {
  const { svc } = makeSvc();
  const dir = makeRepo();
  svc.request("ses_p", { owner: "admin", tenant: false, dir, untrusted: false });
  assert.equal(svc.forChat("ses_p"), null);
  assert.equal(sh(dir, "branch", "--list", "teleharness/*").trim(), "");
  const [a, b] = await Promise.all([svc.ensureForTurn({ sid: "ses_p", text: "Первый" }), svc.ensureForTurn({ sid: "ses_p", text: "Первый" })]);
  assert.equal(a.id, b.id);
  assert.equal(svc.pendingOf("ses_p"), null);
  assert.equal(sh(dir, "branch", "--list", "teleharness/*").trim().split("\n").length, 1);
});

test("create: limits, space, detached head, failure cleans partial copy and branch", async () => {
  const dir = makeRepo();
  const { svc } = makeSvc({ limits: { maxPerRepo: 1 } });
  await mk(svc, dir, "ses_1");
  await assert.rejects(mk(svc, dir, "ses_2"), (e) => e.extra.kind === "limit");
  const { svc: s2 } = makeSvc({ statfs: () => ({ bavail: 1, bsize: 1 }) });
  await assert.rejects(mk(s2, dir, "ses_3"), (e) => e.extra.kind === "space" && e.extra.freeBytes === 1);
  const d2 = makeRepo();
  sh(d2, "checkout", "-q", "--detach");
  const { svc: s3 } = makeSvc();
  await assert.rejects(mk(s3, d2, "ses_4"), (e) => e.extra.kind === "detached");
  const it = await mk(s3, d2, "ses_4", "x", { base: "main" });
  assert.equal(it.base, "main");
  // сбой git: путь занят файлом → копия не создана, ветки нет, записи нет
  const d3 = makeRepo();
  const wtMeta = path.join(d3, ".git", "worktrees");
  writeFileSync(wtMeta, "occupied"); // .git/worktrees занят файлом — git worktree add падает на всех ОС (Linux/macOS/Windows)
  const { svc: s4 } = makeSvc();
  await assert.rejects(s4.create({ sid: "ses_f", owner: "admin", dir: d3, untrusted: false, branch: "boom-abcd" }), (e) => e.extra.kind === "create-failed");
  try { unlinkSync(wtMeta); } catch {}
  assert.equal(sh(d3, "branch", "--list", "teleharness/*").trim(), "");
  assert.equal(s4.store.live().length, 0);
});

test("overlap: two copies edit one file (clean / conflict), main copy and base after fork; dismiss", async () => {
  const { svc } = makeSvc();
  const dir = makeRepo();
  const a = await mk(svc, dir, "ses_a", "Индекс заказов");
  const b = await mk(svc, dir, "ses_b", "Платежи");
  commitIn(a.path, "a.txt", "ONE\ntwo\nthree\n");
  commitIn(b.path, "a.txt", "one\ntwo\nTHREE\n");
  let ov = await svc.overlapsFor(a, { force: true, titleOf: (sid) => (sid === "ses_b" ? "Платежи" : null) });
  assert.equal(ov.length, 1);
  assert.equal(ov[0].kind, "chat");
  assert.equal(ov[0].title, "Платежи");
  assert.deepEqual(ov[0].files, [{ path: "a.txt", conflict: false }]);
  // конфликт: та же строка
  commitIn(b.path, "a.txt", "one\nTWO-B\nTHREE\n");
  commitIn(a.path, "a.txt", "ONE\nTWO-A\nthree\n");
  ov = await svc.overlapsFor(b, { force: true });
  assert.equal(ov[0].conflict, true);
  // незакоммиченное тоже считается пересечением
  writeFileSync(path.join(b.path, "b.txt"), "bee b\n");
  writeFileSync(path.join(dir, "b.txt"), "bee main\n");
  ov = await svc.overlapsFor(b, { force: true });
  assert.ok(ov.some((o) => o.kind === "main" && o.files[0].path === "b.txt"));
  // база ушла вперёд и тронула файл копии
  sh(dir, "checkout", "-q", "--", "b.txt");
  commitIn(dir, "a.txt", "one\nTWO-MAIN\nthree\n", "main edit");
  ov = await svc.overlapsFor(a, { force: true });
  const base = ov.find((o) => o.kind === "base");
  assert.equal(base.conflict, true);
  // скрыть — полоса пропадает, новая общая правка возвращает
  svc.dismiss(a, "base", ["a.txt"]);
  ov = await svc.overlapsFor(a, { force: true });
  assert.equal(ov.some((o) => o.kind === "base"), false);
});

test("merge: squash with green tests advances main by CAS (main checked out), copy follows; idempotent key", async () => {
  const { svc, events } = makeSvc();
  const dir = makeRepo();
  const it = await mk(svc, dir, "ses_m");
  commitIn(it.path, "c.txt", "new\n", "agent 1");
  commitIn(it.path, "a.txt", "one\ntwo\nthree\nfour\n", "agent 2");
  const before = head(dir, "main");
  const op = await svc.merge(it, { idemKey: "key-123456", message: "Индекс по customer_id" });
  const again = await svc.merge(it, { idemKey: "key-123456" });
  assert.equal(again.opId, op.opId);
  const done = await waitOp(svc, op);
  assert.equal(done.phase, "done", JSON.stringify(done));
  assert.equal(done.method, "squash");
  assert.equal(done.files, 2);
  const after = head(dir, "main");
  assert.notEqual(after, before);
  assert.equal(sh(dir, "rev-parse", "main^").trim(), before, "один коммит поверх прежней main");
  assert.equal(sh(dir, "log", "-1", "--format=%s", "main").trim(), "Индекс по customer_id");
  assert.equal(readFileSync(path.join(dir, "c.txt"), "utf8"), "new\n", "основная копия на main обновлена");
  assert.equal(head(it.path), after, "ветка копии = новая main");
  assert.equal(svc.store.byId(it.id).state, "merged");
  assert.ok(events.some(([, w]) => w === "merged"));
  // отмена слияния
  const st = await svc.status(it);
  assert.equal(st.canUndoMerge, true);
  await svc.undoMerge(it);
  assert.equal(head(dir, "main"), before);
  assert.equal(existsSync(path.join(dir, "c.txt")), false);
});

test("merge: main not checked out → update-ref CAS; merge commit method; ff method", async () => {
  const { svc } = makeSvc();
  const dir = makeRepo();
  sh(dir, "checkout", "-q", "-b", "dev");
  const it = await mk(svc, dir, "ses_r", "x", { base: "main" });
  commitIn(it.path, "c.txt", "c\n");
  const before = head(dir, "main");
  const done = await waitOp(svc, await svc.merge(it, { method: "merge" }));
  assert.equal(done.phase, "done");
  assert.equal(sh(dir, "rev-list", "--parents", "-n1", "main").trim().split(" ").length, 3, "коммит слияния — 2 родителя");
  assert.equal(head(dir, "dev"), before, "основная копия на dev не тронута");
  const it2 = await mk(svc, dir, "ses_r2", "y", { base: "main" });
  commitIn(it2.path, "d.txt", "d\n");
  const h2 = head(it2.path);
  const d2 = await waitOp(svc, await svc.merge(it2, { method: "ff" }));
  assert.equal(d2.phase, "done");
  assert.equal(head(dir, "main"), h2);
});

test("merge: conflict aborts, main unchanged, files listed; tests failed / timeout keep main; reset branch", async () => {
  const { svc } = makeSvc();
  const dir = makeRepo();
  const it = await mk(svc, dir, "ses_c");
  commitIn(it.path, "a.txt", "one\nTWO-A\nthree\n");
  commitIn(dir, "a.txt", "one\nTWO-MAIN\nthree\n", "main");
  const before = head(dir, "main");
  const c = await waitOp(svc, await svc.merge(it, {}));
  assert.equal(c.kind, "conflict");
  assert.deepEqual(c.files, ["a.txt"]);
  assert.equal(head(dir, "main"), before);
  assert.equal(existsSync(path.join(it.path, ".git")) && sh(it.path, "status", "--porcelain").trim(), "", "merge --abort: копия чистая");
  // тесты упали
  const it2 = await mk(svc, dir, "ses_t");
  commitIn(it2.path, "FAIL", "x\n");
  const f = await waitOp(svc, await svc.merge(it2, {}));
  assert.equal(f.kind, "tests-failed");
  assert.equal(head(dir, "main"), before);
  assert.equal(f.test.passed, false);
  // вернуть ветку как до слияния (после подтягивания база в ветке)
  await svc.resetBranch(it2, f.opId);
  assert.equal(head(it2.path), f.branchBefore);
  // тайм-аут
  const { svc: s2 } = makeSvc({ runTests: async () => ({ code: -1, output: "...", timedOut: true }) });
  const d2 = makeRepo();
  const it3 = await mk(s2, d2, "ses_to");
  commitIn(it3.path, "z.txt", "z\n");
  const t = await waitOp(s2, await s2.merge(it3, {}));
  assert.equal(t.kind, "tests-timeout");
});

test("merge: dirty copy asks to commit; turn running refuses; no test command; skip tests needs reason", async () => {
  const { svc, busy } = makeSvc();
  const dir = makeRepo({ test: 'echo "Error: no test specified" && exit 1' });
  const it = await mk(svc, dir, "ses_d");
  writeFileSync(path.join(it.path, "a.txt"), "dirty\n");
  await assert.rejects(svc.merge(it, {}), (e) => e.extra.kind === "dirty" && e.extra.count === 1);
  busy.add("ses_d");
  await assert.rejects(svc.merge(it, { commitDirty: true }), (e) => e.extra.kind === "turn-running");
  busy.delete("ses_d");
  await assert.rejects(svc.merge(it, { commitDirty: true }), (e) => e.extra.kind === "no-tests");
  await assert.rejects(svc.merge(it, { commitDirty: true, skipTests: true }), (e) => e.status === 400);
  const op = await waitOp(svc, await svc.merge(it, { commitDirty: true, skipTests: true, reason: "тестов нет", message: "Правка a" }));
  assert.equal(op.phase, "done");
  assert.equal(op.steps.test, "skip");
  assert.equal(sh(dir, "log", "-1", "--format=%s", "main").trim(), "Правка a");
});

test("merge: main copy dirty in merged files → main-dirty, ref untouched; base moved during tests → retry once", async () => {
  const { svc } = makeSvc();
  const dir = makeRepo();
  const it = await mk(svc, dir, "ses_md");
  commitIn(it.path, "b.txt", "bee 2\n");
  writeFileSync(path.join(dir, "b.txt"), "local edit\n");
  const before = head(dir, "main");
  const op = await waitOp(svc, await svc.merge(it, {}));
  assert.equal(op.kind, "main-dirty");
  assert.deepEqual(op.files, ["b.txt"]);
  assert.equal(head(dir, "main"), before);
  assert.equal(readFileSync(path.join(dir, "b.txt"), "utf8"), "local edit\n");
  sh(dir, "checkout", "-q", "--", "b.txt");
  // база сдвинулась во время тестов: первый прогон двигает main, второй — нет
  let calls = 0;
  const { svc: s2 } = makeSvc({
    runTests: async () => {
      if (calls++ === 0) commitIn(dir, "other.txt", "x\n", "parallel merge");
      return { code: 0, output: "# pass 1" };
    },
  });
  const it2 = await mk(s2, dir, "ses_mv");
  commitIn(it2.path, "e.txt", "e\n");
  const d = await waitOp(s2, await s2.merge(it2, {}));
  assert.equal(d.phase, "done");
  assert.equal(d.retries, 1);
  assert.equal(calls, 2);
  assert.ok(existsSync(path.join(dir, "other.txt")) && existsSync(path.join(dir, "e.txt")));
});

test("queue: two merges of one repo run one after another", async () => {
  const { svc } = makeSvc({ runTests: async () => (await new Promise((r) => setTimeout(r, 150)), { code: 0, output: "ok" }) });
  const dir = makeRepo();
  const a = await mk(svc, dir, "ses_qa");
  const b = await mk(svc, dir, "ses_qb");
  commitIn(a.path, "qa.txt", "a\n");
  commitIn(b.path, "qb.txt", "b\n");
  const o1 = await svc.merge(a, {});
  const o2 = await svc.merge(b, {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(svc.op(o2.opId).phase, "queued");
  assert.equal(svc.waitingFor(a.repoKey).wtId, a.id);
  assert.equal((await waitOp(svc, o1)).phase, "done");
  assert.equal((await waitOp(svc, o2)).phase, "done");
  assert.ok(existsSync(path.join(dir, "qa.txt")) && existsSync(path.join(dir, "qb.txt")));
});

test("remove: clean merged silently; unsaved → 409 with counts; keep-branch WIP commit; all needs confirm", async () => {
  const { svc } = makeSvc();
  const dir = makeRepo();
  const it = await mk(svc, dir, "ses_x");
  commitIn(it.path, "x.txt", "x\n");
  await waitOp(svc, await svc.merge(it, {}));
  const r = await svc.remove(svc.store.byId(it.id), { mode: "auto" });
  assert.equal(r.branchKept, false);
  assert.equal(existsSync(it.path), false);
  assert.equal(sh(dir, "branch", "--list", it.branch).trim(), "");
  const it2 = await mk(svc, dir, "ses_y");
  commitIn(it2.path, "y.txt", "y\n");
  writeFileSync(path.join(it2.path, "wip.txt"), "unsaved\n");
  await assert.rejects(svc.remove(it2, { mode: "auto" }), (e) => e.extra.kind === "unsaved" && e.extra.uncommitted === 1 && e.extra.commits === 1
    && e.message === `В копии 1 незакоммиченный файл и 1 коммит не в ${it2.base}`); // BUG-273: формы числа
  const k = await svc.remove(it2, { mode: "keep-branch" });
  assert.equal(k.branchKept, true);
  assert.equal(sh(dir, "log", "-1", "--format=%s", it2.branch).trim(), "WIP: сохранено при удалении чата");
  assert.match(sh(dir, "show", `${it2.branch}:wip.txt`), /unsaved/);
  assert.deepEqual((await svc.orphanBranches({ repoRoot: dir, untrusted: false })).map((b) => b.name), [it2.branch]);
  const it3 = await mk(svc, dir, "ses_z");
  commitIn(it3.path, "z.txt", "z\n");
  await assert.rejects(svc.remove(it3, { mode: "all" }), (e) => e.extra.kind === "confirm");
  await svc.remove(it3, { mode: "all", confirm: true });
  assert.equal(sh(dir, "branch", "--list", it3.branch).trim(), "");
  await assert.rejects(svc.deleteBranch({ repoRoot: dir, untrusted: false, name: "main" }), (e) => e.status === 400);
  await svc.deleteBranch({ repoRoot: dir, untrusted: false, name: it2.branch });
});

test("recover after restart: interrupted update aborts, advance checked by ref value", async () => {
  const { svc, dataDir } = makeSvc();
  const dir = makeRepo();
  const it = await mk(svc, dir, "ses_rc");
  commitIn(it.path, "a.txt", "one\nTWO-A\nthree\n");
  commitIn(dir, "a.txt", "one\nTWO-M\nthree\n", "m");
  // имитация: сервер упал посреди подтягивания (конфликт оставил MERGE_HEAD)
  try {
    sh(it.path, "merge", "main");
  } catch {}
  const opsDir = path.join(dataDir, "ops");
  const op1 = { opId: "op_aaaaaaaaaaaa", wtId: it.id, phase: "update", steps: { precheck: "ok", update: "run", test: "wait", advance: "wait" }, test: {}, createdAt: 1 };
  writeFileSync(path.join(opsDir, `${op1.opId}.json`), JSON.stringify(op1));
  const main = head(dir, "main");
  const op2 = { opId: "op_bbbbbbbbbbbb", wtId: it.id, phase: "advance", newSha: main, mainOld: "0".repeat(40), steps: { advance: "run" }, test: {}, createdAt: 2 };
  writeFileSync(path.join(opsDir, `${op2.opId}.json`), JSON.stringify(op2));
  const fresh = new Worktrees({ store: new WorktreeStore({ dir: dataDir, log: () => {} }), dataDir, log: () => {} });
  const out = await fresh.recover();
  assert.equal(out.length, 2);
  const r1 = fresh.op(op1.opId);
  assert.equal(r1.phase, "interrupted");
  assert.match(r1.error, /прервано перезапуском сервера — main не изменена/);
  assert.equal(sh(it.path, "status", "--porcelain").trim(), "", "merge --abort выполнен");
  assert.equal(fresh.op(op2.opId).phase, "done");
});

test("gc: chat gone → WIP saved, copy removed, branch kept; folder deleted by hand → prune; run copy older than 14 days", async () => {
  let now = Date.now();
  const { svc } = makeSvc({ now: () => now });
  const dir = makeRepo();
  const it = await mk(svc, dir, "ses_gone");
  writeFileSync(path.join(it.path, "w.txt"), "work\n");
  const it2 = await mk(svc, dir, "ses_hand");
  rmSync(it2.path, { recursive: true, force: true });
  const run = await svc.create({ runId: "wf-1", kind: "run", owner: "admin", dir, untrusted: false, title: "Ночное обновление" });
  assert.match(run.branch, /^teleharness\/run-nochnoe-obnovlenie-[a-z0-9]{4}$/);
  writeFileSync(path.join(run.path, "r.txt"), "r\n");
  now += 15 * 24 * 3600_000;
  const out = await svc.gc({ isLive: (x) => x.sid !== "ses_gone" && x.sid !== "ses_hand" });
  assert.ok(out.saved.includes(it.id) && out.saved.includes(run.id));
  assert.ok(out.pruned.includes(it2.id));
  assert.match(sh(dir, "show", `${it.branch}:w.txt`), /work/);
  assert.match(sh(dir, "log", "-1", "--format=%s", run.branch), /14 дней/);
  assert.equal(existsSync(it.path), false);
  assert.equal(svc.store.byRun("wf-1").state, "orphaned");
});

test("tenant: copy in the chat folder (inside tenant home), .teleharness-uploads link kept and excluded; untrusted dangerous config refused", async () => {
  const { svc } = makeSvc();
  const home = path.join(TMP, "tenants", "ivan");
  const dir = path.join(home, "shop");
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  const chat = path.join(dir, "chats", "abc");
  mkdirSync(chat, { recursive: true });
  mkdirSync(path.join(dir, ".teleharness-uploads"), { recursive: true });
  symlinkSync(path.join(dir, ".teleharness-uploads"), path.join(chat, ".teleharness-uploads"), "dir");
  const it = await svc.create({ sid: "ses_abc", owner: "ivan", tenant: true, dir, untrusted: true, text: "Правка", chatFolder: chat });
  assert.equal(it.path, chat);
  assert.ok(lstatSync(path.join(chat, ".teleharness-uploads")).isSymbolicLink());
  assert.equal(sh(chat, "status", "--porcelain").trim(), "", "ссылка вложений не видна git");
  assert.equal(sh(dir, "status", "--porcelain").trim(), "", "копия внутри основной не видна в основной");
  // квота числа копий тенанта
  const { svc: s2 } = makeSvc({ limits: { tenantMax: 0 } });
  await assert.rejects(s2.create({ sid: "ses_q", owner: "ivan", tenant: true, dir, untrusted: true, chatFolder: path.join(dir, "chats", "q") }), (e) => e.extra.kind === "limit");
  // опасный конфиг
  sh(dir, "config", "filter.x.smudge", "touch /tmp/pwned");
  await assert.rejects(s2.create({ sid: "ses_d", owner: "ivan", tenant: true, dir, untrusted: true, chatFolder: path.join(dir, "chats", "d") }), (e) => e.extra.kind === "dirty-config");
  // удаление копии тенанта: папка чата остаётся
  sh(dir, "config", "--unset", "filter.x.smudge");
  await svc.remove(it, { mode: "all", confirm: true });
  assert.ok(existsSync(chat));
});

// BUG-276 (BUG-20.14): копия, чья папка и репозиторий исчезли (аккаунт тенанта удалён),
// удалялась с 503 «git не установлен» (ENOENT папки = «нет git»), запись оставалась.
test("BUG-276: копия с исчезнувшим репозиторием удаляется штатно (200), без git-ошибки и без воссоздания папки; dropOwner снимает копии аккаунта", async () => {
  const { runGit } = await import("../lib/git.js");
  await assert.rejects(runGit(["status"], { cwd: path.join(TMP, "нет-такой-папки") }), (e) => e.status !== 503 && !/не установлен/.test(e.message), "нет папки — не «git не установлен»");
  const { svc } = makeSvc();
  const home = path.join(TMP, "tenants276", "df-e20-t1");
  const dir = path.join(home, "shop");
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  const it = await svc.create({ sid: "ses_276", owner: "df-e20-t1", tenant: true, dir, untrusted: true, text: "Правка", chatFolder: path.join(dir, "chats", "x") });
  rmSync(home, { recursive: true, force: true }); // аккаунт удалён — папок больше нет
  const r = await svc.remove(svc.store.byId(it.id), { mode: "all", confirm: true });
  assert.equal(r.ok, true);
  assert.equal(svc.store.byId(it.id), null, "запись снята");
  assert.equal(existsSync(home), false, "папка удалённого тенанта не создана заново");
  // dropOwner: копии аккаунта (живой и с пропавшей папкой) снимаются, чужие — остаются
  const dir2 = makeRepo();
  const a1 = await svc.create({ sid: "ses_o1", owner: "t9", dir: dir2, untrusted: false, text: "раз" });
  const a2 = await svc.create({ sid: "ses_o2", owner: "t9", dir: dir2, untrusted: false, text: "два" });
  const keep = await svc.create({ sid: "ses_o3", owner: "admin", dir: dir2, untrusted: false, text: "три" });
  rmSync(a2.path, { recursive: true, force: true });
  const dropped = await svc.dropOwner("t9");
  assert.deepEqual(dropped.sort(), [a1.id, a2.id].sort());
  assert.equal(svc.store.byId(a1.id), null);
  assert.equal(svc.store.byId(a2.id), null);
  assert.ok(svc.store.byId(keep.id));
  assert.equal(existsSync(a1.path), false, "папка живой копии убрана");
  assert.doesNotMatch(sh(dir2, "worktree", "list"), new RegExp(path.basename(a1.path)));
});

test("tenant tests: unavailable without a jail; tenant runs through jail line", async () => {
  const { svc } = makeSvc({ platform: "darwin" });
  const home = path.join(TMP, "tenants2", "ivan");
  const dir = path.join(home, "shop");
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }));
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  const it = await svc.create({ sid: "ses_tt", owner: "ivan", tenant: true, dir, untrusted: true, chatFolder: path.join(dir, "chats", "tt") });
  commitIn(it.path, "x.txt", "x\n");
  const op = await waitOp(svc, await svc.merge(it, {}));
  assert.equal(op.kind, "tests-unavailable");
  let seen = null;
  const { svc: s2 } = makeSvc({ platform: "linux", tenantJail: () => ({ name: "teleharness-t-ivan", home }), jailLine: () => ({ command: "true" }), runTests: async (o) => ((seen = o), { code: 0, output: "" }) });
  const it2 = await s2.create({ sid: "ses_tj", owner: "ivan", tenant: true, dir, untrusted: true, chatFolder: path.join(dir, "chats", "tj") });
  commitIn(it2.path, "y.txt", "y\n");
  const d = await waitOp(s2, await s2.merge(it2, {}));
  assert.equal(d.phase, "done");
  assert.equal(seen.jail.name, "teleharness-t-ivan");
  assert.equal(seen.cmd, 'PATH="$PWD/node_modules/.bin:$PATH"; node -e 0');
});

test("sync: pull base into branch; conflict aborted with files; branch switched refuses merge", async () => {
  const { svc } = makeSvc();
  const dir = makeRepo();
  const it = await mk(svc, dir, "ses_s");
  commitIn(dir, "m.txt", "m\n", "main 1");
  const r = await svc.sync(it);
  assert.equal(r.ok, true);
  assert.ok(existsSync(path.join(it.path, "m.txt")));
  commitIn(it.path, "a.txt", "one\nA\nthree\n");
  commitIn(dir, "a.txt", "one\nM\nthree\n", "main 2");
  await assert.rejects(svc.sync(it), (e) => e.extra.kind === "conflict" && e.extra.files[0] === "a.txt");
  assert.equal(sh(it.path, "status", "--porcelain").trim(), "");
  sh(it.path, "checkout", "-q", "-b", "other");
  await assert.rejects(svc.merge(it, {}), (e) => e.extra.kind === "branch-switched");
  await svc.checkoutBranch(it);
  const st = await svc.status(it);
  assert.equal(st.branchOk, true);
  // папка пропала
  rmSync(it.path, { recursive: true, force: true });
  assert.equal((await svc.status(it)).gone, true);
  await assert.rejects(svc.ensureForTurn({ sid: "ses_s", text: "" }), (e) => e.extra.kind === "gone");
  await svc.restore(it);
  assert.ok(existsSync(path.join(it.path, "a.txt")));
});

test("settings: defaults (squash, 10 min, link, .env on), validation, project memory", () => {
  const { svc } = makeSvc();
  assert.deepEqual(svc.settingsOf("u"), { mergeMethod: "squash", testTimeoutMin: 10, deps: "link", copyEnv: true, defaultByProject: {} });
  assert.throws(() => svc.setSettings("u", { testTimeoutMin: 0 }), (e) => e.status === 400);
  assert.throws(() => svc.setSettings("u", { deps: "install" }), (e) => e.status === 400, "тенант не ставит зависимости заново");
  const s = svc.setSettings("u", { mergeMethod: "merge", project: { dir: "/p", on: true } });
  assert.equal(s.mergeMethod, "merge");
  assert.equal(s.defaultByProject["/p"], true);
});
