// FEAT-20.3 (1.5/1.8): события GitHub — нормализация, ключи, подпись, фильтры.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { normalizeEvent, eventKey, subjectKey, verifySignature, passesFilters, KINDS, COMMAND_RE, AGENT_MARKER } from "../lib/github/events.js";

const headers = (event, delivery = "d1") => ({ event, delivery });

test("FEAT-20.3: issues opened/labeled → issue_opened/issue_labeled с автором и метками", () => {
  const body = {
    action: "opened", repository: { full_name: "octo/hello" }, sender: { login: "octo" },
    issue: { number: 7, title: "Сломалось", body: "Описание", html_url: "https://github.com/octo/hello/issues/7", user: { login: "alice" }, labels: [{ name: "bug" }] },
  };
  const ev = normalizeEvent(headers("issues"), body);
  assert.equal(ev.kind, "issue_opened");
  assert.equal(ev.repo, "octo/hello");
  assert.equal(ev.number, 7);
  assert.equal(ev.author, "alice");
  assert.equal(ev.actor, "octo");
  assert.deepEqual(ev.labels, ["bug"]);

  const labeled = normalizeEvent(headers("issues"), { ...body, action: "labeled", label: { name: "agent" } });
  assert.equal(labeled.kind, "issue_labeled");
  assert.equal(labeled.label, "agent");

  assert.equal(normalizeEvent(headers("issues"), { ...body, action: "closed" }), null);
});

test("FEAT-20.3: issue_comment.created с командой → comment_command; без команды — null", () => {
  const body = {
    action: "created", repository: { full_name: "octo/hello" }, sender: { login: "octo" },
    issue: { number: 7, title: "T", html_url: "u", labels: [{ name: "agent" }] },
    comment: { id: 5001, body: "/agent почини, пожалуйста", user: { login: "alice" }, html_url: "cu" },
  };
  const ev = normalizeEvent(headers("issue_comment"), body);
  assert.equal(ev.kind, "comment_command");
  assert.equal(ev.command, "agent");
  assert.equal(ev.commentId, 5001);
  assert.equal(ev.author, "alice");
  assert.match(ev.body, /почини/);
  assert.equal(normalizeEvent(headers("issue_comment"), { ...body, comment: { ...body.comment, body: "просто текст" } }), null);
  assert.ok(COMMAND_RE.exec("/fix-ci делать"));
});

test("FEAT-20.3: pull_request opened → pr_opened с веткой и sha", () => {
  const ev = normalizeEvent(headers("pull_request"), {
    action: "opened", repository: { full_name: "octo/hello" }, sender: { login: "octo" },
    pull_request: { number: 12, title: "PR", body: "что сделал", html_url: "u", user: { login: "bob" }, head: { ref: "teleharness/7-fix", sha: "abc123" } },
  });
  assert.equal(ev.kind, "pr_opened");
  assert.equal(ev.branch, "teleharness/7-fix");
  assert.equal(ev.sha, "abc123");
});

test("FEAT-20.3: workflow_run failure → ci_failed; не-failure → ci_not_failed; форк помечен", () => {
  const wr = {
    action: "completed", repository: { full_name: "octo/hello" }, sender: { login: "octo" },
    workflow_run: { name: "CI", conclusion: "failure", id: 99, head_sha: "deadbeef", head_branch: "feature-x", actor: { login: "carol" }, html_url: "u", head_repository: { fork: false } },
  };
  const ev = normalizeEvent(headers("workflow_run"), wr);
  assert.equal(ev.kind, "ci_failed");
  assert.equal(ev.workflow, "CI");
  assert.equal(ev.branch, "feature-x");
  assert.equal(ev.fork, false);
  const forked = normalizeEvent(headers("workflow_run"), { ...wr, workflow_run: { ...wr.workflow_run, head_repository: { fork: true } } });
  assert.equal(forked.fork, true);
  const green = normalizeEvent(headers("workflow_run"), { ...wr, workflow_run: { ...wr.workflow_run, conclusion: "success" } });
  assert.equal(green.kind, "ci_not_failed");
  // FEAT-20.3 2.5 (кр. 19): PR ветки — отдельным полем; number пуст, ключ события не меняется
  assert.equal(ev.prNumber, null, "без pull_requests PR неизвестен");
  const inPr = normalizeEvent(headers("workflow_run"), { ...wr, workflow_run: { ...wr.workflow_run, html_url: "https://github.com/octo/hello/actions/runs/99",
    pull_requests: [{ number: 301, head: { ref: "other" } }, { number: 320, head: { ref: "feature-x" } }] } });
  assert.equal(inPr.prNumber, 320, "PR той же ветки");
  assert.equal(inPr.number, undefined);
  assert.equal(eventKey("t", inPr), eventKey("t", ev), "идемпотентность CI-события по-прежнему на sha+workflow");
});

test("FEAT-20.3: push — ветка, агентность; чужие события — null", () => {
  const body = (ref) => ({ repository: { full_name: "o/r" }, ref, after: "sha1", pusher: { name: "octo" }, sender: { login: "octo" }, head_commit: { author: { username: "octo" } } });
  const ev = normalizeEvent(headers("push"), body("refs/heads/main"));
  assert.equal(ev.kind, "push");
  assert.equal(ev.branch, "main");
  assert.equal(ev.agentPush, false);
  assert.equal(normalizeEvent(headers("push"), body("refs/heads/teleharness/7-fix")).agentPush, true);
  assert.equal(normalizeEvent(headers("push"), { ...body("refs/heads/main"), deleted: true }), null);
  assert.equal(normalizeEvent(headers("fork"), {}), null);
});

test("FEAT-20.3: event_key одинаков для webhook и опроса; subject_key по предмету", () => {
  const a = { kind: "issue_labeled", repo: "o/r", number: 7, action: "labeled", label: "agent" };
  const b = { kind: "issue_labeled", repo: "o/r", number: 7, action: "labeled", label: "agent", actor: "другой" };
  assert.equal(eventKey("t1", a), eventKey("t1", b), "инициатор не входит в ключ события");
  assert.notEqual(eventKey("t1", a), eventKey("t2", a));
  assert.notEqual(eventKey("t1", a), eventKey("t1", { ...a, kind: "issue_opened" }));
  assert.match(eventKey("t1", a), /^t1:issue_labeled:o\/r:n7:labeled$/);
  assert.equal(subjectKey("t1", { ...a }), "t1:o/r:issue#7");
  assert.equal(subjectKey("t1", { kind: "pr_opened", repo: "o/r", number: 3 }), "t1:o/r:pr#3");
  assert.equal(subjectKey("t1", { kind: "ci_failed", repo: "o/r", branch: "main" }), "t1:o/r:branch:main");
});

test("FEAT-20.3: подпись HMAC — верная принимается, неверная/отсутствующая нет", () => {
  const secret = "s3cret";
  const body = JSON.stringify({ zen: "hello" });
  const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifySignature(secret, body, good), true);
  assert.equal(verifySignature(secret, body + " ", good), false);
  assert.equal(verifySignature(secret, body, "sha256=" + "0".repeat(64)), false);
  assert.equal(verifySignature(secret, body, ""), false);
  assert.equal(verifySignature(secret, body, undefined), false);
});

test("FEAT-20.3: фильтры — метка, ветка, команда, виды, форк", () => {
  const trigger = { kinds: ["issue_labeled", "ci_failed", "comment_command"], filters: { label: "agent", branch: "main", command: "agent" } };
  assert.equal(passesFilters({ kind: "issue_labeled", labels: ["agent"] }, trigger).ok, true);
  assert.equal(passesFilters({ kind: "issue_labeled", labels: ["bug"] }, trigger).reason, "filtered_label");
  assert.equal(passesFilters({ kind: "issue_opened", labels: ["agent"] }, trigger).reason, "filtered_kind");
  assert.equal(passesFilters({ kind: "ci_failed", branch: "dev", fork: false, labels: ["agent"] }, trigger).reason, "filtered_branch");
  assert.equal(passesFilters({ kind: "comment_command", command: "fix", labels: ["agent"] }, trigger).reason, "filtered_command");
  assert.equal(passesFilters({ kind: "ci_failed", branch: "main", fork: true, labels: ["agent"] }, trigger).reason, "fork_pr");
  assert.equal(passesFilters({ kind: "ci_failed", branch: "main", fork: false, labels: ["agent"] }, trigger).ok, true);
  assert.deepEqual(KINDS.sort(), ["ci_failed", "comment_command", "issue_labeled", "issue_opened", "pr_opened"]);
});

test("FEAT-20.3: comment_command и ci_failed не отсеиваются фильтром label (регресс стенда)", () => {
  const trigger = { kinds: ["issue_labeled", "comment_command", "ci_failed"], filters: { label: "agent", command: "agent" } };
  assert.equal(passesFilters({ kind: "comment_command", command: "agent", labels: [] }, trigger).ok, true);
  assert.equal(passesFilters({ kind: "ci_failed", branch: "main", fork: false, labels: [] }, trigger).ok, true);
  assert.equal(passesFilters({ kind: "issue_labeled", labels: [] }, trigger).reason, "filtered_label");
});

test("FEAT-20.3: маркер портала в комментарии — распознаётся", () => {
  assert.ok(AGENT_MARKER.test("Готово\n<!-- teleharness:agent -->"));
  assert.ok(!AGENT_MARKER.test("обычный текст"));
});

test("BUG-313 + BUG-316 + BUG-320: форк по head_repository.full_name, agentPush по Co-Authored-By, фильтр repo → filtered_repo", () => {
  // BUG-313: head_repository.full_name ≠ repository.full_name → fork: true даже если flag fork не выставлен
  const wfFork = normalizeEvent(
    headers("workflow_run", "d-wf-fork"),
    {
      action: "completed",
      repository: { full_name: "octo/hello" },
      sender: { login: "stranger" },
      workflow_run: {
        id: 55, name: "CI", conclusion: "failure", head_branch: "fix", head_sha: "abc",
        head_repository: { full_name: "stranger/hello", fork: false },
        pull_requests: [], html_url: "u",
      },
    },
  );
  assert.equal(wfFork.kind, "ci_failed");
  assert.equal(wfFork.fork, true);

  // BUG-316: push в чужую ветку (same-branch) с трейлером Co-Authored-By <agents@teleharness.local> → agentPush: true
  const agentSameBranch = normalizeEvent(
    headers("push", "d-push-agent"),
    {
      ref: "refs/heads/feature/fix-1",
      after: "1".repeat(40),
      repository: { full_name: "octo/hello" },
      pusher: { name: "owner" },
      head_commit: { id: "1".repeat(40), message: "Починил CI\n\nCo-Authored-By: Claude <agents@teleharness.local>" },
      commits: [{ id: "1".repeat(40), message: "Починил CI\n\nCo-Authored-By: Claude <agents@teleharness.local>" }],
    },
  );
  assert.equal(agentSameBranch.kind, "push");
  assert.equal(agentSameBranch.agentPush, true);

  // BUG-320: чужой репозиторий отсеивается как filtered_repo (без учёта регистра)
  const trigger = { repo: "octo/hello", kinds: ["issue_labeled"], filters: { label: "agent" } };
  assert.equal(passesFilters({ kind: "issue_labeled", repo: "other/repo", labels: ["agent"] }, trigger).reason, "filtered_repo");
  assert.equal(passesFilters({ kind: "issue_labeled", repo: "Octo/Hello", labels: ["agent"] }, trigger).ok, true);
});

