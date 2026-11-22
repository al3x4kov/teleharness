// FEAT-20.3 (1.5/1.8/1.10): диспетчер — решение события, журнал, запуск, петли.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { triggerService } from "../lib/github/triggers.js";
import { createDispatcher, EVENT_NAMESPACE, uuidv5, cleanInputs, eventFace } from "../lib/github/dispatch.js";
import { eventKey, subjectKey } from "../lib/github/events.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "gh-dsp-"));

function rig({ connectionLogin = "octo", launchImpl, connectionStatus = "ok" } = {}) {
  const dir = tmp();
  const store = triggerService(path.join(dir, "db.sqlite"), { secrets: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") }, now: () => 1_700_000_000_000 });
  const connections = { get: (owner) => ({ owner, login: connectionLogin, status: connectionStatus }) };
  const launches = [];
  const launch = launchImpl ?? (async (trigger, ev, requestId) => {
    launches.push({ trigger, ev, requestId });
    return { workflowId: `wf-${launches.length}` };
  });
  const dispatcher = createDispatcher({ store, connections, launch, log: () => {} });
  const trigger = store.create("u1", { definitionId: "00000000-0000-4000-8000-000000000001", repo: "octo/hello", kinds: [], filters: { trustedAuthors: ["carol"] } });
  const body = (over = {}) => JSON.stringify({
    action: "labeled", repository: { full_name: "octo/hello" }, sender: { login: "octo" },
    issue: { number: 7, title: "T", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] },
    label: { name: "agent" }, ...over,
  });
  const deliver = async (over = {}, deliveryId = `d${Math.random()}`) =>
    dispatcher.processDelivery({ deliveryId, triggerId: trigger.id, event: "issues", body: body(over) });
  return { store, dispatcher, trigger, launches, deliver, dir };
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

test("FEAT-20.3: доверенное событие — запуск с requestId=uuidv5(event_key), subject активен", async () => {
  const { store, trigger, launches, deliver, dir } = rig();
  try {
    const verdict = await deliver();
    assert.equal(verdict, "started");
    assert.equal(launches.length, 1);
    const eKey = eventKey(trigger.id, { kind: "issue_labeled", repo: "octo/hello", number: 7, action: "labeled" });
    assert.equal(launches[0].requestId, uuidv5(EVENT_NAMESPACE, eKey), "повтор события даст тот же workflow");
    assert.equal(launches[0].trigger.owner, "u1");
    assert.equal(launches[0].ev.repo, "octo/hello");
    const entry = store.journal("u1", trigger.id)[0];
    assert.equal(entry.decision, "started");
    assert.equal(entry.workflowId, "wf-1");
    assert.equal(store.subjectOf(trigger.id, subjectKey(trigger.id, { kind: "issue_labeled", repo: "octo/hello", number: 7 })).activeWorkflowId, "wf-1");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: повтор доставки — duplicate со ссылкой на первый запуск, второй запуск не стартует", async () => {
  const { store, launches, deliver, trigger, dir } = rig();
  try {
    await deliver({ sender: { login: "octo" } }, "d-1");
    const verdict = await deliver({ sender: { login: "octo" } }, "d-2");
    assert.equal(verdict, "duplicate");
    assert.equal(launches.length, 1);
    const dup = store.journal("u1", trigger.id).find((r) => r.decision === "duplicate");
    assert.ok(dup, "дубликат в журнале");
    assert.equal(dup.workflowId, "wf-1", "ссылка на первый запуск");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: посторонний автор — untrusted_author, текст не уходит агенту", async () => {
  const { store, launches, deliver, dir } = rig({ connectionLogin: "octo" });
  try {
    const verdict = await deliver({ issue: { number: 8, title: "T", body: "B", html_url: "u", user: { login: "mallory" }, labels: [{ name: "agent" }] }, label: { name: "agent" }, sender: { login: "mallory" } });
    assert.equal(verdict, "untrusted_author");
    assert.equal(launches.length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: явный доверенный список и владелец токена доверены", async () => {
  const { store, launches, deliver, dir } = rig({ connectionLogin: "octo" });
  try {
    // carol — в trustedAuthors триггера
    const v1 = await deliver({ issue: { number: 9, title: "T", body: "B", html_url: "u", user: { login: "carol" }, labels: [{ name: "agent" }] }, label: { name: "agent" }, sender: { login: "octo" } });
    assert.equal(v1, "started");
    // инициатор (кто поставил метку) тоже должен быть доверен
    const v2 = await deliver({ issue: { number: 10, title: "T", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] }, label: { name: "agent" }, sender: { login: "mallory" } });
    assert.equal(v2, "untrusted_author");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: adminStopped / выключен / нет подключения — пропуск без запуска", async () => {
  const { store, launches, deliver, trigger, dir } = rig();
  try {
    store.setSetting("adminStopped", true);
    assert.equal(await deliver({}, "d-a"), "admin_stopped");
    store.setSetting("adminStopped", false);
    store.update("u1", trigger.id, { enabled: false });
    assert.equal(await deliver({}, "d-b"), "trigger_disabled");
    store.update("u1", trigger.id, { enabled: true });
    const noConn = createDispatcher({ store, connections: { get: () => ({ login: "octo", status: "expired" }) }, launch: launches.push.bind(launches), log: () => {} });
    const verdict = await noConn.processDelivery({ deliveryId: "d-c", triggerId: trigger.id, event: "issues", body: JSON.stringify({ action: "labeled", repository: { full_name: "octo/hello" }, sender: { login: "octo" }, issue: { number: 11, title: "T", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] }, label: { name: "agent" } }) });
    assert.equal(verdict, "no_connection");
    assert.equal(launches.length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: уже идёт запуск — уже идёт запуск; команда с текстом — в очередь (одна)", async () => {
  const { store, dispatcher, launches, deliver, trigger, dir } = rig();
  try {
    await deliver({}, "d-1"); // wf-1 идёт по issue#7
    const v2 = await deliver({}, "d-2");
    assert.equal(v2, "duplicate"); // тот же event_key
    // другое событие того же предмета: команда с текстом → очередь
    const cmdBody = JSON.stringify({
      action: "created", repository: { full_name: "octo/hello" }, sender: { login: "octo" },
      issue: { number: 7, title: "T", html_url: "u", labels: [{ name: "agent" }] },
      comment: { id: 5001, body: "/agent поправь ещё тесты", user: { login: "octo" }, html_url: "cu" },
    });
    const v3 = await dispatcher.processDelivery({ deliveryId: "d-3", triggerId: trigger.id, event: "issue_comment", body: cmdBody });
    assert.equal(v3, "queued");
    assert.equal(store.subjectOf(trigger.id, subjectKey(trigger.id, { kind: "issue_labeled", repo: "octo/hello", number: 7 })).queuedEventKey, eventKey(trigger.id, { kind: "comment_command", repo: "octo/hello", number: 7, action: "created", command: "agent", commentId: 5001 }));
    assert.equal(launches.length, 1, "очередь не запускает сразу");
    // вторая команда — слот занят (другой комментарий, другой event_key)
    const v4 = await dispatcher.processDelivery({ deliveryId: "d-4", triggerId: trigger.id, event: "issue_comment", body: cmdBody.replace("поправь ещё тесты", "другой текст").replace("5001", "5002") });
    assert.equal(v4, "already_running");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: человеческий push сбрасывает попытки CI; push агента — нет", async () => {
  const { store, dispatcher, launches, trigger, dir } = rig();
  try {
    store.bumpCi(trigger.id, subjectKey(trigger.id, { kind: "ci_failed", repo: "octo/hello", branch: "main" }));
    store.bumpCi(trigger.id, subjectKey(trigger.id, { kind: "ci_failed", repo: "octo/hello", branch: "main" }));
    const pushBody = JSON.stringify({ repository: { full_name: "octo/hello" }, ref: "refs/heads/main", after: "abc", pusher: { name: "octo" }, sender: { login: "octo" }, head_commit: { author: { username: "octo" } } });
    const verdict = await dispatcher.processDelivery({ deliveryId: "p-1", triggerId: trigger.id, event: "push", body: pushBody });
    assert.equal(verdict, "push_reset");
    assert.equal(store.subjectOf(trigger.id, subjectKey(trigger.id, { kind: "ci_failed", repo: "octo/hello", branch: "main" })).ciAttempts, 0);
    assert.equal(launches.length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: петля портала — комментарий с маркером не запускает работу и не пишется в журнал", async () => {
  const { store, dispatcher, launches, trigger, dir } = rig();
  try {
    const loopBody = JSON.stringify({
      action: "created", repository: { full_name: "octo/hello" }, sender: { login: "octo" },
      issue: { number: 13, title: "T", html_url: "u", labels: [{ name: "agent" }] },
      comment: { body: "/agent готово\n<!-- teleharness:agent -->", user: { login: "octo" }, html_url: "cu" },
    });
    const verdict = await dispatcher.processDelivery({ deliveryId: "d-loop", triggerId: trigger.id, event: "issue_comment", body: loopBody });
    assert.equal(verdict, "agent_loop");
    assert.equal(launches.length, 0);
    assert.equal(store.journal("u1", trigger.id).length, 0, "петля не засоряет журнал");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: permissionCheck — человек вне списка доверен через API, иначе нет", async () => {
  const checks = [];
  const dir2 = tmp();
  const store2 = triggerService(path.join(dir2, "db.sqlite"), { secrets: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") } });
  const dispatcher2 = createDispatcher({
    store: store2,
    connections: { get: () => ({ login: "octo", status: "ok" }) },
    launch: async () => ({ workflowId: "wf-x" }),
    permissionCheck: async (login, repo) => { checks.push(`${login}@${repo}`); return login === "maintainer"; },
  });
  const t2 = store2.create("u1", { definitionId: "00000000-0000-4000-8000-000000000001", repo: "octo/hello", kinds: [], filters: {} });
  try {
    const body = (user, n) => JSON.stringify({ action: "labeled", repository: { full_name: "octo/hello" }, sender: { login: user }, issue: { number: n, title: "T", body: "B", html_url: "u", user: { login: user }, labels: [{ name: "agent" }] }, label: { name: "agent" } });
    assert.equal(await dispatcher2.processDelivery({ deliveryId: "p-1", triggerId: t2.id, event: "issues", body: body("maintainer", 21) }), "started", "write+ через API — доверен");
    assert.equal(await dispatcher2.processDelivery({ deliveryId: "p-2", triggerId: t2.id, event: "issues", body: body("mallory", 22) }), "untrusted_author", "без права — не доверен");
    assert.deepEqual(checks, ["maintainer@octo/hello", "mallory@octo/hello"], "локально доверенные не ходят в API");
  } finally { store2.close(); rmSync(dir2, { recursive: true, force: true }); }
});

test("FEAT-20.3: ci_failed из форка — fork_pr; шторм >20 событий даёт флаг; resume доигрывает", async () => {
  const { store, trigger, deliver, dir, dispatcher } = rig();
  try {
    const wr = (id, branch, fork) => JSON.stringify({
      action: "completed", repository: { full_name: "octo/hello" }, sender: { login: "octo" },
      workflow_run: { name: "CI", conclusion: "failure", id, head_sha: `s${id}`, head_branch: branch, actor: { login: "octo" }, html_url: "u", head_repository: { fork } },
    });
    assert.equal(await dispatcher.processDelivery({ deliveryId: "f-1", triggerId: trigger.id, event: "workflow_run", body: wr(5, "main", true) }), "fork_pr");
    assert.equal(await dispatcher.processDelivery({ deliveryId: "f-2", triggerId: trigger.id, event: "workflow_run", body: wr(6, "main", false) }), "started");
    // шторм: >20 событий за 10 минут (журнал уже имеет 2)
    for (let i = 0; i < 21; i++) await deliver({ issue: { number: 100 + i, title: "T", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] }, label: { name: "agent" } }, `s-${i}`);
    assert.ok(store.setting(`storm:${trigger.id}`), "флаг шторма установлен");
    // resume: необработанная доставка доигрывается после рестарта
    store.insertDelivery("r-1", trigger.id, "issues", JSON.stringify({ action: "labeled", repository: { full_name: "octo/hello" }, sender: { login: "octo" }, issue: { number: 999, title: "T", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] }, label: { name: "agent" } }));
    const n = await dispatcher.resume();
    assert.equal(n, 1);
    assert.equal(store.pendingDeliveries().length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.11: завершение запуска освобождает subject, событие из очереди стартует с requestId и записью «Из очереди»", async () => {
  let status = "RUNNING";
  const dir = tmp();
  const store = triggerService(path.join(dir, "db.sqlite"), { secrets: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") } });
  const connections = { get: () => ({ login: "octo", status: "ok" }) };
  const launches = [];
  const dispatcher = createDispatcher({
    store, connections, log: () => {},
    describeRun: async () => ({ status }), // подменяем Temporal
    launch: async (trigger, ev, requestId) => { launches.push({ trigger, ev, requestId }); return { workflowId: `wf-${launches.length}` }; },
  });
  const trigger = store.create("u1", { definitionId: "00000000-0000-4000-8000-000000000001", repo: "octo/hello", kinds: [], filters: { trustedAuthors: ["carol"] } });
  const sKey = subjectKey(trigger.id, { kind: "issue_labeled", repo: "octo/hello", number: 7 });
  try {
    await dispatcher.processDelivery({ deliveryId: "d-1", triggerId: trigger.id, event: "issues", body: JSON.stringify({ action: "labeled", repository: { full_name: "octo/hello" }, sender: { login: "octo" }, issue: { number: 7, title: "T", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] }, label: { name: "agent" } }) });
    const cmdBody = JSON.stringify({ action: "created", repository: { full_name: "octo/hello" }, sender: { login: "octo" }, issue: { number: 7, title: "T", html_url: "u", labels: [{ name: "agent" }] }, comment: { id: 5001, body: "/agent поправь ещё тесты", user: { login: "octo" }, html_url: "cu" } });
    assert.equal(await dispatcher.processDelivery({ deliveryId: "d-2", triggerId: trigger.id, event: "issue_comment", body: cmdBody }), "queued");
    const qKey = eventKey(trigger.id, { kind: "comment_command", repo: "octo/hello", number: 7, action: "created", command: "agent", commentId: 5001 });
    assert.ok(store.firstByEventKey(qKey).eventJson, "queued-событие хранится для выпуска из очереди");

    await dispatcher.sweep(); // RUNNING — ничего не происходит
    assert.equal(launches.length, 1);
    assert.equal(store.subjectOf(trigger.id, sKey).queuedEventKey, qKey);

    status = "COMPLETED";
    await dispatcher.sweep(); // выпуск из очереди
    assert.equal(launches.length, 2, "отложенное событие запущено");
    assert.equal(launches[1].requestId, uuidv5(EVENT_NAMESPACE, qKey), "тот же requestId, что дал бы повтор события");
    assert.equal(launches[1].ev.command, "agent", "команда восстанавливается из журнала");
    assert.equal(launches[1].ev.body, "/agent поправь ещё тесты", "текст команды из журнала");
    const subject = store.subjectOf(trigger.id, sKey);
    assert.equal(subject.activeWorkflowId, "wf-2");
    assert.equal(subject.queuedEventKey, null);
    const fromQueue = store.journal("u1", trigger.id).find((r) => r.reason === "Из очереди");
    assert.ok(fromQueue, "запись «Из очереди» в журнале");
    assert.equal(fromQueue.decision, "started");
    assert.equal(fromQueue.workflowId, "wf-2");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.11: ошибка describeRun — subject не трогается; падение запуска освобождает очередь с записью error", async () => {
  let failDescribe = false;
  let status = "RUNNING";
  let failLaunch = false;
  const dir = tmp();
  const store = triggerService(path.join(dir, "db.sqlite"), { secrets: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") } });
  const connections = { get: () => ({ login: "octo", status: "ok" }) };
  const launches = [];
  const dispatcher = createDispatcher({
    store, connections, log: () => {},
    describeRun: async () => { if (failDescribe) throw new Error("temporal down"); return { status }; },
    launch: async () => { if (failLaunch) throw new Error("пайп удалён"); launches.push(1); return { workflowId: `wf-${launches.length}` }; },
  });
  const trigger = store.create("u1", { definitionId: "00000000-0000-4000-8000-000000000001", repo: "octo/hello", kinds: [], filters: { trustedAuthors: ["carol"] } });
  const sKey = subjectKey(trigger.id, { kind: "issue_labeled", repo: "octo/hello", number: 7 });
  try {
    await dispatcher.processDelivery({ deliveryId: "d-1", triggerId: trigger.id, event: "issues", body: JSON.stringify({ action: "labeled", repository: { full_name: "octo/hello" }, sender: { login: "octo" }, issue: { number: 7, title: "T", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] }, label: { name: "agent" } }) });
    const cmdBody = JSON.stringify({ action: "created", repository: { full_name: "octo/hello" }, sender: { login: "octo" }, issue: { number: 7, title: "T", html_url: "u", labels: [{ name: "agent" }] }, comment: { id: 6001, body: "/agent ещё раз", user: { login: "octo" }, html_url: "cu" } });
    await dispatcher.processDelivery({ deliveryId: "d-2", triggerId: trigger.id, event: "issue_comment", body: cmdBody });

    failDescribe = true;
    await dispatcher.sweep(); // Temporal недоступен — ничего не меняется
    const stuck = store.subjectOf(trigger.id, sKey);
    assert.ok(stuck.activeWorkflowId && stuck.queuedEventKey, "subject и очередь живы");

    failDescribe = false; status = "COMPLETED"; failLaunch = true;
    await dispatcher.sweep(); // активный освобождён, выпуск падает → error, очередь пуста
    const after = store.subjectOf(trigger.id, sKey);
    assert.equal(after.queuedEventKey, null, "очередь освобождена после неудачного выпуска");
    assert.equal(after.activeWorkflowId, null);
    const errEntry = store.journal("u1", trigger.id).find((r) => r.decision === "error");
    assert.ok(errEntry?.reason?.includes("Из очереди"), "причина ошибки — выпуск из очереди");

    failLaunch = false;
    await dispatcher.sweep(); // повтор: освобождать больше нечего
    assert.equal(launches.length, 1, "событие после неудачного выпуска не переигрывается (только исходный запуск)");
    assert.equal(store.activeSubjects().length, 0, "subject без активного и очереди не обходится");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.11: cleanInputs — в запуск попадают только входы, объявленные версией", () => {
  const ev = { kind: "issue_labeled", repo: "octo/hello", number: 7, title: "T", body: "B", branch: "main", sha: "abc", url: "u", actor: "octo", label: "agent", command: "", comment: "c" };
  const only = cleanInputs(ev, [{ name: "repo", type: "string" }, { name: "number", type: "number" }, { name: "title", type: "string" }]);
  assert.deepEqual(only, { repo: "octo/hello", number: 7, title: "T" });
  assert.deepEqual(cleanInputs(ev, []), {}, "версия без входов не получает ничего");
});

test("FEAT-20.3 1.10/1.18: серверный лимит Claude в фоне — claude_limit после предела, admin настраивает", async () => {
  const dir = tmp();
  const store = triggerService(path.join(dir, "db.sqlite"), { secrets: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") } });
  const connections = { get: () => ({ login: "octo", status: "ok" }) };
  const dispatcher = createDispatcher({
    store, connections, log: () => {},
    launch: async () => ({ workflowId: "wf-1" }),
  });
  const trigger = store.create("u1", { definitionId: "00000000-0000-4000-8000-000000000001", repo: "octo/hello", kinds: [], filters: { trustedAuthors: ["octo"] } });
  const deliver = (id, n) => dispatcher.processDelivery({ deliveryId: id, triggerId: trigger.id, event: "issues", body: JSON.stringify({ action: "labeled", repository: { full_name: "octo/hello" }, sender: { login: "octo" }, issue: { number: n, title: "T", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] }, label: { name: "agent" } }) });
  try {
    store.setSetting("claude_background_per_day", 2); // admin lowered the server limit
    assert.equal(await deliver("d-1", 1), "started");
    assert.equal(await deliver("d-2", 2), "started");
    assert.equal(await deliver("d-3", 3), "claude_limit");
    const entry = store.journal("u1", trigger.id)[0];
    assert.equal(entry.decision, "claude_limit");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 1.14: Починить CI — логи во вход ci_log, попытки ≤2 с исчерпанием, человеческий push сбрасывает", async () => {
  const dir = tmp();
  const store = triggerService(path.join(dir, "db.sqlite"), { secrets: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") } });
  const connections = { get: () => ({ login: "octo", status: "ok" }) };
  const launches = [];
  const logs = ["/repos/octo/hello/actions/runs/55/jobs?per_page=100", "/repos/octo/hello/actions/jobs/900/logs"];
  const dispatcher = createDispatcher({
    store, connections, log: () => {},
    ciLogFetch: async (owner, repo, runId) => `## job CI\nError: test failed\ntoken ${"ghp_"}abcdef0123456789abcdef01`,
    launch: async (trigger, ev, requestId, extra) => { launches.push(ev); attempts.push(extra?.attempt ?? null); return { workflowId: `wf-${launches.length}` }; },
  });
  const attempts = [];
  const trigger = store.create("u1", { definitionId: "00000000-0000-4000-8000-000000000001", repo: "octo/hello", kinds: ["ci_failed"], filters: { trustedAuthors: ["octo"] } });
  const wr = (id, sha) => JSON.stringify({ action: "completed", repository: { full_name: "octo/hello" }, sender: { login: "octo" }, workflow_run: { name: "CI", conclusion: "failure", id, head_sha: sha, head_branch: "main", actor: { login: "octo" }, html_url: "u" } });
  const sKey = subjectKey(trigger.id, { kind: "ci_failed", repo: "octo/hello", branch: "main" });
  try {
    assert.equal(await dispatcher.processDelivery({ deliveryId: "ci-1", triggerId: trigger.id, event: "workflow_run", body: wr(55, "s1") }), "started");
    assert.ok(launches[0].ciLog.includes("test failed"), "лог упавшего job во входе");
    assert.equal(store.subjectOf(trigger.id, sKey).ciAttempts, 1, "коммит агента = попытка 1");
    await dispatcher.sweep(); // первый запуск завершился (без describeRun — тестовый фолбэк)
    assert.equal(await dispatcher.processDelivery({ deliveryId: "ci-2", triggerId: trigger.id, event: "workflow_run", body: wr(56, "s2") }), "started");
    assert.equal(store.subjectOf(trigger.id, sKey).ciAttempts, 2, "попытка 2");
    await dispatcher.sweep();
    assert.equal(await dispatcher.processDelivery({ deliveryId: "ci-3", triggerId: trigger.id, event: "workflow_run", body: wr(57, "s3") }), "ci_attempts_exhausted");
    assert.equal(launches.length, 2, "третий раз агент не запускается");
    // FEAT-20.3 2.5: номер попытки уходит в запуск («попытка N из 2», D-4), лист события
    // «Нужен человек» хранит хвост лога с замаскированными секретами (T-17)
    assert.deepEqual(attempts, [1, 2]);
    const exhausted = store.journal("u1", trigger.id).find((r) => r.decision === "ci_attempts_exhausted");
    assert.equal(exhausted.reason, "Нужен человек: 2 из 2 попыток");
    const saved = typeof exhausted.eventJson === "string" ? JSON.parse(exhausted.eventJson) : exhausted.eventJson;
    assert.ok(saved.ciLog.includes("test failed"), "хвост лога — в записи журнала");
    assert.ok(!saved.ciLog.includes("ghp_"), "секреты в журнале маскированы");
    assert.equal(saved.kind, "ci_failed");
    // человеческий push — сброс попыток
    await dispatcher.processDelivery({ deliveryId: "push-h", triggerId: trigger.id, event: "push", body: JSON.stringify({ repository: { full_name: "octo/hello" }, ref: "refs/heads/main", after: "xyz", pusher: { name: "octo" }, sender: { login: "octo" }, head_commit: { author: { username: "octo" } } }) });
    assert.equal(store.subjectOf(trigger.id, sKey).ciAttempts, 0, "человеческий push сбросил счётчик");
    await dispatcher.sweep();
    assert.equal(await dispatcher.processDelivery({ deliveryId: "ci-4", triggerId: trigger.id, event: "workflow_run", body: wr(58, "s4") }), "started", "после сброса агент снова работает");
    // логи недоступны — запуск не состоялся
    await dispatcher.sweep();
    const failing = createDispatcher({
      store, connections, log: () => {},
      ciLogFetch: async () => { throw new Error("GitHub 404: not found"); },
      launch: async () => { launches.push("nope"); return { workflowId: "wf-x" }; },
    });
    assert.equal(await failing.processDelivery({ deliveryId: "ci-5", triggerId: trigger.id, event: "workflow_run", body: wr(59, "s5") }), "ci_logs_unavailable");
    assert.ok(!launches.includes("nope"), "без логов CI агент не запускается");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3 2.5: eventFace — источник запуска словами и ссылка на событие (кр. 19)", () => {
  assert.deepEqual(eventFace({ kind: "issue_labeled", repo: "octo/teleharness", number: 142, label: "agent", url: "https://github.com/octo/teleharness/issues/142" }),
    { ref: "octo/teleharness#142 · метка agent", url: "https://github.com/octo/teleharness/issues/142" });
  assert.equal(eventFace({ kind: "comment_command", repo: "octo/teleharness", number: 139, command: "agent", url: "u" }).ref, "octo/teleharness#139 · /agent");
  assert.equal(eventFace({ kind: "pr_opened", repo: "o/r", number: 7, url: "u" }).ref, "o/r#7 · новый PR");
  assert.equal(eventFace({ kind: "issue_opened", repo: "o/r", number: 7, url: "u" }).ref, "o/r#7 · новая задача");
  // красный CI в ветке PR: ссылка — на PR, источник называет ветку и workflow (T-17, D-4)
  assert.deepEqual(eventFace({ kind: "ci_failed", repo: "o/r", branch: "feature/upload", workflow: "test", prNumber: 320, url: "https://github.com/o/r/actions/runs/5" }),
    { ref: "o/r · PR #320 · feature/upload · CI «test»", url: "https://github.com/o/r/pull/320" });
  // без PR в событии — ссылка на запуск Actions
  assert.deepEqual(eventFace({ kind: "ci_failed", repo: "o/r", branch: "main", workflow: "build", prNumber: null, url: "https://github.com/o/r/actions/runs/6" }),
    { ref: "o/r · main · CI «build»", url: "https://github.com/o/r/actions/runs/6" });
  // не github.com — ссылку на PR не собираем
  assert.equal(eventFace({ kind: "ci_failed", repo: "o/r", branch: "b", workflow: "w", prNumber: 3, url: "https://ghe.local/o/r/actions/runs/1" }).url, "https://ghe.local/o/r/actions/runs/1");
  assert.deepEqual(eventFace(null), { ref: "событие", url: null });
});

test("FEAT-20.3: uuidv5(namespace, name) различает разные события одного триггера и соответствует RFC 4122 (регресс стенда)", () => {
  const tid = "9380b50a-81cf-429e-802b-ab9cef7a65bf";
  const a = uuidv5(EVENT_NAMESPACE, `${tid}:issue_labeled:o/r:n1:labeled`);
  const b = uuidv5(EVENT_NAMESPACE, `${tid}:comment_command:o/r:c123:created`);
  assert.notEqual(a, b, "разные события одного триггера обязаны давать разные requestId");
  assert.equal(uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
});
