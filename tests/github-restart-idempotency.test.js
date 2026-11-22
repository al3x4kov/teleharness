// FEAT-20.3 (3.4, кр. 22, N-31): рестарт процесса после inbox и посреди шага PR —
// один запуск и один PR, без дублей.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { triggerService } from "../lib/github/triggers.js";
import { createDispatcher } from "../lib/github/dispatch.js";
import { prStepRunner } from "../lib/temporal/pr-step.js";
import { GhError } from "../lib/github/client.js";

const git = (args, cwd) => execFileSync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
const secrets = { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") };

test("FEAT-20.3 3.4: рестарт после записи в inbox — resume() запускает ровно один workflow, повторная доставка не плодит второй", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-restart-inbox-"));
  const dbPath = path.join(dir, "db.sqlite");
  let store1, store2;
  try {
    // 1. Первый процесс принял webhook в inbox и «упал» до запуска диспетчера.
    store1 = triggerService(dbPath, { secrets, now: () => 1_700_000_000_000 });
    const trigger = store1.create("u1", {
      definitionId: "00000000-0000-4000-8000-000000000001",
      repo: "octo/hello", kinds: [], filters: {},
    });
    const body = JSON.stringify({
      action: "labeled", repository: { full_name: "octo/hello" }, sender: { login: "octo" },
      issue: { number: 42, title: "Fix crash", body: "Details", html_url: "https://github.com/octo/hello/issues/42", user: { login: "octo" }, labels: [{ name: "agent" }] },
      label: { name: "agent" },
    });
    assert.equal(store1.insertDelivery("deliv-restart-1", trigger.id, "issues", body), true);
    assert.equal(store1.pendingDeliveries().length, 1);
    

    // 2. Второй процесс открывает ту же SQLite-БД после рестарта.
    // Идемпотентный запуск по requestId (как starts UNIQUE(owner, request_id) в runtime.js).
    const startedByReq = new Map();
    let launchCalls = 0;
    const launch = async (_t, _ev, requestId) => {
      launchCalls += 1;
      if (!startedByReq.has(requestId)) startedByReq.set(requestId, { workflowId: `wf-${startedByReq.size + 1}` });
      return startedByReq.get(requestId);
    };
    store2 = triggerService(dbPath, { secrets, now: () => 1_700_000_005_000 });
    const connections = { get: (owner) => ({ owner, login: "octo", status: "ok" }) };
    const d2 = createDispatcher({ store: store2, connections, launch, log: () => {} });

    const resumed = await d2.resume();
    assert.equal(resumed, 1, "необработанная доставка доиграна после рестарта");
    assert.equal(store2.pendingDeliveries().length, 0);
    assert.equal(launchCalls, 1);
    assert.equal(startedByReq.size, 1);

    // Повторный resume() и повторная доставка того же события не создают второй запуск.
    assert.equal(await d2.resume(), 0);
    assert.equal(store2.insertDelivery("deliv-restart-1", trigger.id, "issues", body), false, "тот же deliveryId отвергнут inbox");
    const dupVerdict = await d2.processDelivery({ deliveryId: "deliv-restart-2", triggerId: trigger.id, event: "issues", body, via: "webhook" });
    assert.equal(dupVerdict, "duplicate");
    assert.equal(launchCalls, 1);
    assert.equal(startedByReq.size, 1);
    
  } finally {
    store2?.close?.(); store1?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FEAT-20.3 3.4: обрыв посреди шага PR (после коммита/push и после создания PR) — повтор даёт один PR", { skip: process.platform === "win32" && "git fixture" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-restart-pr-"));
  try {
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
    git(["checkout", "-b", "teleharness/run-restart"], work);
    writeFileSync(path.join(work, "fix.txt"), "agent patch\n");

    // Фейковый GitHub: первый POST /pulls обрывается сетью ПОСЛЕ того, как PR реально создался
    // (имитация рестарта/обрыва ответа посреди шага PR).
    const openPrs = [];
    const comments = [];
    let postPullsCalls = 0;
    let crashOnceAfterCreate = true;
    const githubApi = async (_uid, method, pathname, body) => {
      const p = pathname.split("?")[0];
      if (p === "/repos/octo/hello") return { status: 200, data: { default_branch: "main" } };
      if (p === "/repos/octo/hello/pulls" && method === "GET") return { status: 200, data: openPrs };
      if (p === "/repos/octo/hello/pulls" && method === "POST") {
        postPullsCalls += 1;
        openPrs.push({ number: 17, html_url: "https://github.com/octo/hello/pull/17", ...body });
        if (crashOnceAfterCreate) {
          crashOnceAfterCreate = false;
          throw new GhError(0, "network", "Соединение разорвано после создания PR");
        }
        return { status: 201, data: openPrs[0] };
      }
      if (p === "/repos/octo/hello/issues/17/comments" && method === "POST") {
        comments.push(body);
        return { status: 201, data: {} };
      }
      throw new GhError(404, "not_found", "404");
    };

    const runStep = () => prStepRunner({
      prepareWorktree: async () => ({ path: work, branch: "teleharness/run-restart", base: "main", untrusted: false }),
      gitAuthor: () => ({ name: "Владелец", email: "owner@teleharness.local" }),
      githubApi,
      githubToken: () => "github_pat_" + "restart_test_token",
    })({
      user: { id: "u1" }, workflowId: "11430397-c55f-447e-a6d8-39b914a278ad",
      project: "/proj", workspace: "/proj/pipelines/zadacha", pipeName: "Задача", pipeSlug: "zadacha",
      inputs: { repo: "octo/hello", number: 42 }, description: "Правка после рестарта",
      branch: "teleharness/fix-{{input.number}}-{{slug}}", title: "Фикс {{input.number}}", mode: "new",
      sourceEngine: "claude",
    });

    // Попытка 1: коммит сделан, ветка запушена, POST /pulls создал PR #17, но ответ оборвался → github_wait.
    const r1 = await runStep();
    assert.equal(r1.state, "github_wait");
    assert.equal(openPrs.length, 1);

    // Попытка 2 (новый экземпляр runner после рестарта): повторный запуск находит уже открытый PR #17
    // и не создаёт дубликат PR (postPullsCalls остаётся 1, коммитов в ветке ровно 1 поверх main).
    const r2 = await runStep();
    assert.equal(r2.state, "done");
    assert.equal(r2.url, "https://github.com/octo/hello/pull/17");
    assert.equal(r2.outcome, "updated");
    assert.equal(openPrs.length, 1, "ровно один PR");
    assert.equal(postPullsCalls, 1, "второй POST /pulls не вызывался");
    assert.equal(comments.length, 1);
    const commitsAhead = Number(git(["rev-list", "--count", "main..HEAD"], work).toString().trim());
    assert.equal(commitsAhead, 1, "повтор после рестарта не создал лишний коммит");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
