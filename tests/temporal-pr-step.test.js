// FEAT-20.3 (1.12/1.13): шаг «Открыть PR» — git-флоу в рабочей копии запуска
// и PR с фейковым GitHub (temp git repo, локальный bare origin).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { gitEnv, withGitVars } from "../lib/git.js";
import { prStepRunner } from "../lib/temporal/pr-step.js";
import { GhError } from "../lib/github/client.js";
import { validateDefinition } from "../shared/temporal-definition.js";
import { projectPlan } from "../lib/temporal/prepare-bridge.js";

const git = (args, cwd) => execFileSync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });

// origin.git (bare) + seed (главный) + work (копия агента на ветке teleharness/run-test)
function mkRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-step-"));
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const work = path.join(dir, "work");
  git(["init", "--bare", "-b", "main", origin]);
  git(["clone", origin, seed]);
  writeFileSync(path.join(seed, "README.md"), "seed\n");
  git(["add", "."], seed);
  git(["-c", "user.name=seed", "-c", "user.email=s@x", "commit", "-m", "seed"], seed);
  git(["push", "origin", "main"], seed);
  git(["clone", origin, work]);
  git(["checkout", "-b", "teleharness/run-test"], work);
  return { dir, origin, seed, work };
}

function fakeGithub({ pulls = [], failOn = null } = {}) {
  const calls = [];
  const comments = [];
  let created = null;
  const api = async (userId, method, pathname, body) => {
    calls.push({ method, pathname, body });
    const p = pathname.split("?")[0];
    if (failOn?.test(`${method} ${p}`)) throw new GhError(403, "forbidden", "GitHub 403: merged by rule");
    if (p === "/repos/octo/hello") return { status: 200, data: { default_branch: "main" } };
    if (p === "/repos/octo/hello/pulls" && method === "GET") return { status: 200, data: pulls };
    if (p === "/repos/octo/hello/pulls" && method === "POST") { created = { ...body, number: 9 }; return { status: 201, data: { number: 9, html_url: "https://github.com/octo/hello/pull/9" } }; }
    if (/\/issues\/\d+\/comments$/.test(p)) { comments.push(body); return { status: 201, data: {} }; }
    throw new GhError(404, "not_found", "GitHub 404: not found");
  };
  return { calls, comments, get created() { return created; }, api };
}

function runner({ origin, work, github }) {
  return prStepRunner({
    prepareWorktree: async () => ({ path: work, branch: "teleharness/run-test", base: "main", untrusted: false }),
    gitAuthor: () => ({ name: "Владелец", email: "owner@teleharness.local" }),
    githubApi: github.api,
    githubToken: () => "test-token",
  });
}

const call = (run, over = {}) => run({
  user: { id: "u1" }, workflowId: "11430397-c55f-447e-a6d8-39b914a278ad",
  project: "/proj", workspace: "/proj/pipelines/zadacha", pipeName: "Задача", pipeSlug: "zadacha",
  inputs: { repo: "octo/hello", number: 7 }, description: "Описание изменений",
  branch: "teleharness/fix-{{input.number}}-{{slug}}", title: "Фикс {{input.number}}", mode: "new",
  sourceEngine: "claude", ...over,
});

test("FEAT-20.3 1.12: новый PR — коммит автором из настроек с Co-Authored-By, push, draft-PR с описанием", { skip: process.platform === "win32" && "git fixture" }, async () => {
  const { dir, origin, work } = mkRepo();
  const github = fakeGithub();
  const run = runner({ origin, work, github });
  try {
    writeFileSync(path.join(work, "fix.txt"), "правка\n");
    const out = await call(run);
    // FEAT-20.3 (2.5): итог шага — словами для экрана запуска (T-14): PR создан, ветка, база, коммит
    assert.deepEqual(out, { state: "done", url: "https://github.com/octo/hello/pull/9", outcome: "created", branch: "teleharness/fix-7-zadacha", base: "main", sha: out.sha });
    assert.match(out.sha, /^[0-9a-f]{7}$/, "короткий sha коммита агента");
    // ветка по шаблону с {{input.number}} и {{slug}}
    const branches = git(["ls-remote", "--heads", origin]).toString();
    assert.ok(branches.includes("teleharness/fix-7-zadacha"), "ветка из шаблона запушена");
    git(["fetch", "origin", "teleharness/fix-7-zadacha"], work);
    const log = git(["log", "--format=%an <%ae>%n%b", "FETCH_HEAD"], work).toString();
    assert.ok(log.includes("Владелец <owner@teleharness.local>"), "автор из Настройки → Git");
    assert.ok(log.includes("Co-Authored-By: claude"), "трейлер движка");
    assert.ok(log.includes("Описание изменений"), "описание PR в теле коммита");
    assert.equal(github.created.title, "Фикс 7");
    assert.equal(github.created.base, "main");
    assert.equal(github.created.draft, true);
    assert.ok(!JSON.stringify(github.calls).includes("test-token"), "токен не в запросах GitHub");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.12: отбор файлов — .env, *.key, id_* и >5 МБ не коммитятся", { skip: process.platform === "win32" && "git fixture" }, async () => {
  const { dir, origin, work } = mkRepo();
  const github = fakeGithub();
  const run = runner({ origin, work, github });
  try {
    writeFileSync(path.join(work, ".env"), "SECRET=1\n");
    writeFileSync(path.join(work, "server.key"), "-----\n");
    writeFileSync(path.join(work, "id_rsa"), "-----\n");
    writeFileSync(path.join(work, "cert.pem"), "-----\n");
    writeFileSync(path.join(work, "normal.txt"), "ок\n");
    writeFileSync(path.join(work, "big.bin"), Buffer.alloc(5 * 1024 * 1024 + 1, 7));
    await call(run);
    const tree = git(["ls-tree", "--name-only", "-r", "origin/teleharness/fix-7-zadacha"], work).toString();
    assert.ok(tree.includes("normal.txt"));
    for (const gone of [".env", "server.key", "id_rsa", "cert.pem", "big.bin"]) assert.ok(!tree.includes(gone), `${gone} не попал в коммит`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.12: .github/workflows — needs_approval ci_files; approved → идёт дальше", { skip: process.platform === "win32" && "git fixture" }, async () => {
  const { dir, origin, work } = mkRepo();
  const github = fakeGithub();
  const run = runner({ origin, work, github });
  try {
    mkdirSync(path.join(work, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(work, ".github", "workflows", "ci.yml"), "on: push\n");
    writeFileSync(path.join(work, "a.txt"), "1\n");
    const first = await call(run);
    assert.deepEqual(first, { state: "needs_approval", reason: "ci_files" });
    assert.equal(github.calls.length, 0, "до решения человека GitHub не вызывается");
    const second = await call(run, { approved: true });
    assert.equal(second.state, "done");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.12: существующий открытый PR — комментарий с маркером петли, второй PR не создаётся", { skip: process.platform === "win32" && "git fixture" }, async () => {
  const { dir, origin, work } = mkRepo();
  const github = fakeGithub({ pulls: [{ number: 5, html_url: "https://github.com/octo/hello/pull/5" }] });
  const run = runner({ origin, work, github });
  try {
    writeFileSync(path.join(work, "b.txt"), "2\n");
    const out = await call(run);
    assert.deepEqual(out, { state: "done", url: "https://github.com/octo/hello/pull/5", outcome: "updated", branch: "teleharness/fix-7-zadacha", sha: out.sha }, "обновлён, а не создан (T-16)");
    assert.equal(github.comments.length, 1);
    assert.ok(github.comments[0].body.includes("<!-- teleharness:agent -->"), "комментарий с маркером не зажигает петлю");
    assert.equal(github.created, null, "новый PR не создан");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.12: нет изменений и ветка не впереди — no_changes", { skip: process.platform === "win32" && "git fixture" }, async () => {
  const { dir, origin, work } = mkRepo();
  const github = fakeGithub();
  const run = runner({ origin, work, github });
  try {
    const out = await call(run);
    assert.deepEqual(out, { state: "no_changes" });
    assert.equal(github.calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.12: 401/сеть/лимит запросов → github_wait; 403 правило → неповторяемая ошибка с текстом", { skip: process.platform === "win32" && "git fixture" }, async () => {
  const { dir, origin, work } = mkRepo();
  let mode = "auth";
  const github = fakeGithub();
  const api = async (...args) => {
    if (mode === "auth") throw new GhError(401, "auth", "GitHub 401: Bad credentials");
    // client.classify: 403 без остатка лимита — «rate_limited» (не «rate»); 429 — «other»
    if (mode === "rate") throw new GhError(403, "rate_limited", "GitHub 403: API rate limit exceeded");
    if (mode === "429") throw new GhError(429, "other", "GitHub 429: Too many requests");
    return github.api(...args);
  };
  const run = prStepRunner({
    prepareWorktree: async () => ({ path: work, branch: "teleharness/run-test", base: "main", untrusted: false }),
    gitAuthor: () => ({ name: "v", email: "v@x" }), githubApi: api, githubToken: () => "t",
  });
  try {
    writeFileSync(path.join(work, "c.txt"), "3\n");
    const out = await call(run);
    assert.deepEqual(out, { state: "github_wait", reason: "github_auth" });
    // FEAT-20.3 2.5 (N-32): лимит запросов — ожидание, а не падение запуска; коммит уже сделан, повтор его не дублирует
    mode = "rate";
    assert.deepEqual(await call(run), { state: "github_wait", reason: "github_rate_limited" }, "403 без остатка лимита — ждём");
    mode = "429";
    assert.deepEqual(await call(run), { state: "github_wait", reason: "github_rate_limited" }, "429 — тот же лимит");
    mode = "403";
    const failing = fakeGithub({ failOn: /GET \/repos\/octo\/hello$/ });
    const run2 = prStepRunner({
      prepareWorktree: async () => ({ path: work, branch: "teleharness/run-test", base: "main", untrusted: false }),
      gitAuthor: () => ({ name: "v", email: "v@x" }), githubApi: failing.api, githubToken: () => "t",
    });
    await assert.rejects(call(run2), (e) => e.status === 403 && e.message.includes("merged by rule") && e.code === "github_rejected");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 2.5 (T-16): правило репозитория отклонило push — неповторяемый отказ с текстом правила и sha; ветка обновлена человеком — branch_moved", { skip: process.platform === "win32" && "git fixture" }, async () => {
  const { dir, origin, seed, work } = mkRepo();
  const github = fakeGithub();
  const run = runner({ origin, work, github });
  try {
    // GitHub отвечает текстом правила строками «remote: …» и отклоняет refs
    writeFileSync(path.join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho 'error: GH006: Protected branch update failed for refs/heads/teleharness/fix-7-zadacha.' >&2\necho 'remote: - Commits must have verified signatures' >&2\nexit 1\n", { mode: 0o755 });
    writeFileSync(path.join(work, "rule.txt"), "правка\n");
    await assert.rejects(call(run), (e) => e.status === 409 && e.code === "push_rejected" && e.sha?.length === 7
      && e.message.includes("GitHub отклонил отправку") && e.message.includes("Commits must have verified signatures") && e.message.includes(`Коммит ${e.sha} остался в рабочей копии`),
      "текст правила и коммит, оставшийся в копии, — в отказе");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 2.5 (D-4): same-branch с открытым PR — outcome pushed: коммит в ветку PR, ссылка на PR", { skip: process.platform === "win32" && "git fixture" }, async () => {
  const { dir, origin, work } = mkRepo();
  const github = fakeGithub({ pulls: [{ number: 320, html_url: "https://github.com/octo/hello/pull/320" }] });
  const run = runner({ origin, work, github });
  try {
    writeFileSync(path.join(work, "fix.txt"), "исправление\n");
    const out = await call(run, { mode: "same-branch", inputs: { repo: "octo/hello", branch: "feature/upload" } });
    assert.equal(out.state, "done");
    assert.equal(out.outcome, "pushed", "коммит ушёл в ветку PR — не новый и не «обновлён» PR");
    assert.equal(out.url, "https://github.com/octo/hello/pull/320");
    assert.equal(out.branch, "feature/upload");
    assert.match(out.sha, /^[0-9a-f]{7}$/);
    assert.ok(git(["ls-remote", "--heads", origin]).toString().includes("feature/upload"), "коммит в ветке события");
    assert.equal(github.created, null, "второй PR не создан");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.12: same-branch — push в ветку события; отказ (ветка ушла вперёд) — «Ветка обновлена человеком»", { skip: process.platform === "win32" && "git fixture" }, async () => {
  const { dir, origin, seed, work } = mkRepo();
  const github = fakeGithub();
  const run = runner({ origin, work, github });
  try {
    writeFileSync(path.join(work, "d.txt"), "4\n");
    const ok = await call(run, { mode: "same-branch", inputs: { repo: "octo/hello", branch: "feature-x" } });
    assert.equal(ok.state, "done");
    assert.ok(git(["ls-remote", "--heads", origin]).toString().includes("feature-x"), "ветка события на удалённом");
    assert.equal(github.created?.head, "octo:feature-x");
    // конфликт: человек ушёл вперёд на main
    writeFileSync(path.join(seed, "human.txt"), "человек\n");
    git(["add", "."], seed);
    git(["-c", "user.name=h", "-c", "user.email=h@x", "commit", "-m", "human"], seed);
    git(["push", "origin", "main"], seed);
    writeFileSync(path.join(work, "e.txt"), "5\n");
    await assert.rejects(
      call(run, { mode: "same-branch", branch: null, base: "main", inputs: { repo: "octo/hello" } }),
      (e) => e.status === 409 && e.message.includes("Ветка обновлена человеком") && e.code === "branch_moved" && /^[0-9a-f]{7}$/.test(e.sha ?? ""),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.12: нет repo во входах → 422; ветка не задаётся — используется ветка копии", { skip: process.platform === "win32" && "git fixture" }, async () => {
  const { dir, origin, work } = mkRepo();
  const github = fakeGithub();
  const run = runner({ origin, work, github });
  try {
    await assert.rejects(call(run, { inputs: {} }), (e) => e.status === 422);
    writeFileSync(path.join(work, "f.txt"), "6\n");
    const out = await call(run, { branch: null, title: null });
    assert.equal(out.state, "done");
    assert.ok(git(["ls-remote", "--heads", origin]).toString().includes("teleharness/run-test"), "фолбэк на ветку копии запуска");
    assert.equal(github.created?.title, "Изменения агента");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.18: тенанту same-branch запрещён — push только в ветки teleharness/…", { skip: process.platform === "win32" && "git fixture" }, async () => {
  const { dir, origin, work } = mkRepo();
  const github = fakeGithub();
  const run = prStepRunner({
    prepareWorktree: async () => ({ path: work, branch: "teleharness/run-test", base: "main", untrusted: false, tenant: true }),
    gitAuthor: () => ({ name: "t", email: "t@x" }), githubApi: github.api, githubToken: () => "t",
  });
  try {
    writeFileSync(path.join(work, "g.txt"), "7\n");
    await assert.rejects(
      call(run, { mode: "same-branch", inputs: { repo: "octo/hello", branch: "feature-x" } }),
      (e) => e.status === 403 && e.message.includes("teleharness/"),
      "same-branch (чужая ветка) тенанту запрещён",
    );
    const ok = await call(run, { mode: "new", inputs: { repo: "octo/hello", number: 7 } });
    assert.equal(ok.state, "done", "новая ветка teleharness/… — работает");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.12: валидация определения — source раньше и модельный, шаблоны только со входами; план проходит", () => {
  const base = { name: "P", directory: "/p", inputs: [{ name: "number", type: "number", required: true }] };
  const ok = validateDefinition({ ...base, steps: [
    { id: "m", name: "Модель", type: "model", engine: "claude", model: "m", instruction: "делай", dependsOn: [], timeoutSeconds: 60, maxAttempts: 1 },
    { id: "pr", name: "Открыть PR", type: "pull_request", source: "m", branch: "teleharness/fix-{{input.number}}-{{slug}}", title: "Фикс {{input.number}}", mode: "new", dependsOn: ["m"] },
  ] });
  assert.deepEqual(ok, { valid: true, errors: [] });
  const bad = validateDefinition({ ...base, steps: [
    { id: "pr", name: "PR", type: "pull_request", source: "ghost", branch: "{{steps.m}}", mode: "weird", dependsOn: [] },
  ] });
  assert.ok(!bad.valid && bad.errors.some((e) => e.field === "pr"));
  const plan = projectPlan({ ...base, steps: [
    { id: "m", name: "Модель", type: "model", engine: "claude", model: "m", instruction: "x", dependsOn: [], timeoutSeconds: 60, maxAttempts: 1 },
    { id: "pr", name: "Открыть PR", type: "pull_request", source: "m", dependsOn: ["m"] },
  ] });
  assert.deepEqual(plan.steps[1], { id: "pr", type: "pull_request", dependsOn: ["m"] }, "в воркер уходят только безопасные поля");
});

test("FEAT-20.3: GIT_ASKPASS передаётся в git через gitVars при HTTPS push (регресс стенда)", async () => {
  assert.equal(gitEnv({ GIT_ASKPASS: "/evil" }).GIT_ASKPASS, "echo");
  assert.equal(withGitVars(gitEnv({ GIT_ASKPASS: "/evil" }), { GIT_ASKPASS: "/tmp/ok.sh" }).GIT_ASKPASS, "/tmp/ok.sh");

  const { dir, work } = mkRepo();
  const seenAuth = [];
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization) seenAuth.push(req.headers.authorization);
    res.writeHead(401, { "www-authenticate": 'Basic realm="git"' });
    res.end("auth required");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  try {
    execFileSync("git", ["remote", "set-url", "origin", `http://127.0.0.1:${port}/octo/hello.git`], { cwd: work, stdio: "ignore" });
    writeFileSync(path.join(work, "askpass.txt"), "ok\n");
    const run = prStepRunner({
      prepareWorktree: async () => ({ path: work, branch: "teleharness/run-askpass", base: "main", state: "active", untrusted: false }),
      gitAuthor: () => ({ name: "T", email: "t@e" }),
      githubApi: async () => ({ status: 200, data: { default_branch: "main" } }),
      githubToken: () => "ghp_" + "stage_askpass_test_token_1234",
    });
    const res = await call(run, { mode: "new", inputs: { repo: "octo/hello", number: 1 } });
    assert.equal(res.state, "github_wait");
    const expected = "Basic " + Buffer.from("x-access-token:" + "ghp_" + "stage_askpass_test_token_1234").toString("base64");
    assert.ok(seenAuth.includes(expected), `git обязан отправить x-access-token через GIT_ASKPASS, получено: ${JSON.stringify(seenAuth)}`);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
