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

test("BUG-303: sweep() проверяет adminStopped, enabled, connectionOk и лимиты перед запуском из очереди", async () => {
  const mkCase = async (mutate) => {
    let status = "RUNNING";
    const dir = tmp();
    const store = triggerService(path.join(dir, "db.sqlite"), { secrets: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") } });
    let connStatus = "ok";
    const connections = { get: () => ({ login: "octo", status: connStatus }) };
    const launches = [];
    const dispatcher = createDispatcher({
      store, connections, log: () => {},
      describeRun: async () => ({ status }),
      launch: async () => { launches.push(1); return { workflowId: `wf-${launches.length}` }; },
    });
    const trigger = store.create("u1", { definitionId: "00000000-0000-4000-8000-000000000001", repo: "octo/hello", kinds: [], filters: { trustedAuthors: ["octo"] }, limits: { perHour: 6, queue: 20 } });
    try {
      await dispatcher.processDelivery({ deliveryId: "d-1", triggerId: trigger.id, event: "issues", body: JSON.stringify({ action: "labeled", repository: { full_name: "octo/hello" }, sender: { login: "octo" }, issue: { number: 7, title: "T", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] }, label: { name: "agent" } }) });
      await dispatcher.processDelivery({ deliveryId: "d-2", triggerId: trigger.id, event: "issue_comment", body: JSON.stringify({ action: "created", repository: { full_name: "octo/hello" }, sender: { login: "octo" }, issue: { number: 7, title: "T", html_url: "u", labels: [{ name: "agent" }] }, comment: { id: 9001, body: "/agent ещё задача", user: { login: "octo" }, html_url: "cu" } }) });
      assert.equal(launches.length, 1);
      status = "COMPLETED";
      mutate({ store, trigger, setConn: (s) => { connStatus = s; } });
      await dispatcher.sweep();
      return { launches: launches.length, journal: store.journal("u1", trigger.id) };
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  };

  const cAdmin = await mkCase(({ store }) => store.setSetting("adminStopped", true));
  assert.equal(cAdmin.launches, 1, "adminStopped блокирует выпуск из очереди");
  assert.equal(cAdmin.journal[0].decision, "admin_stopped");

  const cDisabled = await mkCase(({ store, trigger }) => store.update("u1", trigger.id, { enabled: false }));
  assert.equal(cDisabled.launches, 1, "выключенный триггер блокирует выпуск из очереди");
  assert.equal(cDisabled.journal[0].decision, "trigger_disabled");

  const cConn = await mkCase(({ setConn }) => setConn("expired"));
  assert.equal(cConn.launches, 1, "протухшее подключение блокирует выпуск из очереди");
  assert.equal(cConn.journal[0].decision, "no_connection");

  const cRate = await mkCase(({ store, trigger }) => store.update("u1", trigger.id, { limits: { perHour: 1, queue: 20 } }));
  assert.equal(cRate.launches, 1, "исчерпанный лимит perHour блокирует выпуск из очереди");
  assert.equal(cRate.journal[0].decision, "rate_limited");

  const cClaude = await mkCase(({ store }) => store.setSetting("claude_background_per_day", 1));
  assert.equal(cClaude.launches, 1, "исчерпанный claudePerDay блокирует выпуск из очереди");
  assert.equal(cClaude.journal[0].decision, "claude_limit");
});

test("BUG-303: claude_background_per_day считает только пайпы с движком claude (не-Claude пайпы не расходуют и не блокируются)", async () => {
  const dir = tmp();
  const store = triggerService(path.join(dir, "db.sqlite"), { secrets: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") } });
  const connections = { get: () => ({ login: "octo", status: "ok" }) };
  const CLAUDE_DEF = "00000000-0000-4000-8000-000000000001";
  const GLM_DEF = "00000000-0000-4000-8000-000000000002";
  const dispatcher = createDispatcher({
    store, connections, log: () => {},
    usesClaude: (tr) => tr.definitionId === CLAUDE_DEF,
    launch: async (_tr, ev) => ({ workflowId: `wf-${ev.number}` }),
  });
  const trGlm = store.create("u1", { definitionId: GLM_DEF, repo: "octo/hello", kinds: [], filters: { trustedAuthors: ["octo"] } });
  const trClaude = store.create("u1", { definitionId: CLAUDE_DEF, repo: "octo/hello", kinds: [], filters: { trustedAuthors: ["octo"] } });
  const deliver = (tr, id, n) => dispatcher.processDelivery({
    deliveryId: id, triggerId: tr.id, event: "issues",
    body: JSON.stringify({ action: "labeled", repository: { full_name: "octo/hello" }, sender: { login: "octo" }, issue: { number: n, title: "T", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] }, label: { name: "agent" } }),
  });
  try {
    store.setSetting("claude_background_per_day", 1);
    // 2 запуска не-Claude (GLM) не расходуют квоту Claude
    assert.equal(await deliver(trGlm, "g-1", 10), "started");
    assert.equal(await deliver(trGlm, "g-2", 11), "started");
    // 1 запуск Claude проходит, 2-й получает claude_limit
    assert.equal(await deliver(trClaude, "c-1", 20), "started");
    assert.equal(await deliver(trClaude, "c-2", 21), "claude_limit");
    // После исчерпания лимита Claude не-Claude пайп по-прежнему запускается
    assert.equal(await deliver(trGlm, "g-3", 12), "started");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("BUG-303: routes/temporal-triggers — GhError → 4xx/502, PATCH null/[] → 400, replay guards и claudeUsedToday", async () => {
  const { triggerRoutes } = await import("../routes/temporal-triggers.js");
  const { GhError } = await import("../lib/github/client.js");
  const dir = tmp();
  const store = triggerService(path.join(dir, "db.sqlite"), { secrets: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") } });
  const CLAUDE_DEF = "00000000-0000-4000-8000-000000000001";
  const GLM_DEF = "00000000-0000-4000-8000-000000000002";
  let conn = { owner: "u1", login: "octo", status: "ok", tokenLast4: "1234" };
  let permOk = false;
  let ghErr = null;
  let launched = 0;
  const routes = triggerRoutes({
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
    readJsonBody: async (req) => req.body,
    store,
    connections: { get: () => conn, list: () => (conn ? [conn] : []) },
    pipelinesEnabled: () => true,
    pipeOf: async () => ({ version: 1 }),
    usesClaude: (tr) => tr.definitionId === CLAUDE_DEF,
    permissionCheck: async (login) => login === "collab" && permOk,
    launch: async () => {
      if (ghErr) throw ghErr;
      launched += 1;
      return { workflowId: `wf-r-${launched}` };
    },
  });
  const call = async (method, urlPath, body, user = { id: "u1", role: "admin" }) => {
    const u = new URL("http://127.0.0.1" + urlPath);
    const r = routes.find((x) => x.method === method && (typeof x.path === "string" ? x.path === u.pathname : x.path.test(u.pathname)));
    assert.ok(r, `route ${method} ${urlPath}`);
    const match = typeof r.path === "string" ? null : u.pathname.match(r.path);
    const res = { status: 0, body: null };
    await r.handler({ req: { body }, res, user, match, url: u });
    return res;
  };
  try {
    const trClaude = store.create("u1", { definitionId: CLAUDE_DEF, repo: "octo/hello", kinds: ["issue_labeled"] });
    const trGlm = store.create("u1", { definitionId: GLM_DEF, repo: "octo/hello", kinds: ["issue_labeled"] });

    // 1. PATCH с null / [] / примитивом → 400 (не 500)
    assert.equal((await call("PATCH", `/teleharness/api/temporal/triggers/${trClaude.id}`, null)).status, 400);
    assert.equal((await call("PATCH", `/teleharness/api/temporal/triggers/${trClaude.id}`, [])).status, 400);
    assert.equal((await call("PATCH", `/teleharness/api/temporal/triggers/${trClaude.id}`, "str")).status, 400);

    // 2. admin/background claudeUsedToday считает только Claude-триггеры
    store.record({ triggerId: trGlm.id, eventKey: "k-g1", kind: "issue_labeled", repo: "octo/hello", decision: "started", workflowId: "wf-g1" });
    store.record({ triggerId: trClaude.id, eventKey: "k-c1", kind: "issue_labeled", repo: "octo/hello", decision: "started", workflowId: "wf-c1" });
    const bg = await call("GET", "/teleharness/api/admin/background");
    assert.equal(bg.status, 200);
    assert.equal(bg.body.claudeUsedToday, 1, "не-Claude запуск не засчитывается в claudeUsedToday");

    // Подготавливаем replayable запись журнала для collaborator 'collab'
    const ev = { kind: "issue_labeled", repo: "octo/hello", number: 5, action: "labeled", label: "agent", author: "collab", actor: "collab" };
    store.record({ triggerId: trClaude.id, eventKey: "k-rep", kind: "issue_labeled", repo: "octo/hello", number: 5, actor: "collab", decision: "rate_limited", eventJson: JSON.stringify(ev) });
    const eid = store.journal("u1", trClaude.id).find((r) => r.decision === "rate_limited").id;

    // 3. replay при adminStopped → 409
    store.setSetting("adminStopped", true);
    assert.equal((await call("POST", `/teleharness/api/temporal/triggers/${trClaude.id}/journal/${eid}/replay`, {})).status, 409);
    store.setSetting("adminStopped", false);

    // 4. replay при невалидном подключении → 422
    conn = { owner: "u1", login: "octo", status: "expired", tokenLast4: "1234" };
    assert.equal((await call("POST", `/teleharness/api/temporal/triggers/${trClaude.id}/journal/${eid}/replay`, {})).status, 422);
    conn = { owner: "u1", login: "octo", status: "ok", tokenLast4: "1234" };

    // 5. replay проверяет permissionCheck (без права → 422, с правом → идёт дальше)
    permOk = false;
    assert.equal((await call("POST", `/teleharness/api/temporal/triggers/${trClaude.id}/journal/${eid}/replay`, {})).status, 422);
    permOk = true;

    // 6. replay проверяет суточный лимит Claude → 429
    store.setSetting("claude_background_per_day", 1); // уже есть 1 Claude запуск (k-c1)
    assert.equal((await call("POST", `/teleharness/api/temporal/triggers/${trClaude.id}/journal/${eid}/replay`, {})).status, 429);
    store.setSetting("claude_background_per_day", 5);

    // 7. GhError в маршруте маппится в 4xx/502, а не вылетает наружу как 500
    ghErr = new GhError(503, "server", "GitHub unavailable");
    assert.equal((await call("POST", `/teleharness/api/temporal/triggers/${trClaude.id}/journal/${eid}/replay`, {})).status, 502);
    ghErr = new GhError(401, "auth", "Bad credentials");
    assert.equal((await call("POST", `/teleharness/api/temporal/triggers/${trClaude.id}/journal/${eid}/replay`, {})).status, 401);
    ghErr = null;

    // 8. При всех пройденных проверках replay успешен (200)
    const ok = await call("POST", `/teleharness/api/temporal/triggers/${trClaude.id}/journal/${eid}/replay`, {});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("BUG-316: 3 подряд ci_failed с промежуточными same-branch push агента (трейлер и lastAgentSha) → agent_loop + ci_attempts_exhausted; push человека → push_reset", async () => {
  const { store, dispatcher, trigger, launches, dir } = rig();
  try {
    const ci = (id, shaVal) => JSON.stringify({
      action: "completed", repository: { full_name: "octo/hello" }, sender: { login: "octo" },
      workflow_run: { id, name: "CI", conclusion: "failure", head_branch: "feature/fix", head_sha: shaVal, html_url: "u", pull_requests: [] },
    });
    const push = (after, message) => JSON.stringify({
      ref: "refs/heads/feature/fix", after, repository: { full_name: "octo/hello" },
      pusher: { name: "octo" }, head_commit: { id: after, message }, commits: [{ id: after, message }],
    });
    const sKey = subjectKey(trigger.id, { kind: "ci_failed", repo: "octo/hello", branch: "feature/fix" });

    // Попытка 1
    assert.equal(await dispatcher.processDelivery({ deliveryId: "ci-1", triggerId: trigger.id, event: "workflow_run", body: ci(1, "s1") }), "started");
    store.clearActive(trigger.id, sKey);
    // Агентский push по трейлеру Co-Authored-By <agents@teleharness.local> — НЕ сбрасывает счётчик
    assert.equal(await dispatcher.processDelivery({ deliveryId: "p-ag-1", triggerId: trigger.id, event: "push", body: push("1".repeat(40), "fix\n\nCo-Authored-By: Claude <agents@teleharness.local>") }), "agent_loop");
    assert.equal(store.subjectOf(trigger.id, sKey).ciAttempts, 1);

    // Попытка 2
    assert.equal(await dispatcher.processDelivery({ deliveryId: "ci-2", triggerId: trigger.id, event: "workflow_run", body: ci(2, "s2") }), "started");
    store.clearActive(trigger.id, sKey);
    // Агентский push распознаётся и по lastAgentSha без трейлера
    const sha2 = "2".repeat(40);
    store.recordAgentBranchPush("octo/hello", "feature/fix", sha2);
    assert.equal(await dispatcher.processDelivery({ deliveryId: "p-ag-2", triggerId: trigger.id, event: "push", body: push(sha2, "no trailer commit") }), "agent_loop");
    assert.equal(store.subjectOf(trigger.id, sKey).ciAttempts, 2);

    // Попытка 3 → ci_attempts_exhausted
    assert.equal(await dispatcher.processDelivery({ deliveryId: "ci-3", triggerId: trigger.id, event: "workflow_run", body: ci(3, "s3") }), "ci_attempts_exhausted");
    assert.equal(launches.length, 2);

    // Человеческий push сбрасывает счётчик → push_reset, следующий ci_failed снова запускается
    assert.equal(await dispatcher.processDelivery({ deliveryId: "p-hum", triggerId: trigger.id, event: "push", body: push("3".repeat(40), "real human fix") }), "push_reset");
    assert.equal(store.subjectOf(trigger.id, sKey).ciAttempts, 0);
    assert.equal(await dispatcher.processDelivery({ deliveryId: "ci-4", triggerId: trigger.id, event: "workflow_run", body: ci(4, "s4") }), "started");
    assert.equal(launches.length, 3);

    const j = store.journal("u1", trigger.id, { limit: 50 });
    assert.ok(j.some((r) => r.decision === "agent_loop"), "agent_loop записан в журнал");
    assert.ok(j.some((r) => r.decision === "push_reset"), "push_reset записан в журнал");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("BUG-319 + BUG-320: default_user_per_day из настроек ограничивает запуски; событие и push чужого репозитория → filtered_repo", async () => {
  const { store, dispatcher, trigger, launches, deliver, dir } = rig();
  try {
    // BUG-320: событие чужого репозитория → filtered_repo (без запуска)
    const foreignIssue = await deliver({ repository: { full_name: "evil/other" } }, "d-foreign-1");
    assert.equal(foreignIssue, "filtered_repo");
    const foreignPush = await dispatcher.processDelivery({
      deliveryId: "d-foreign-push", triggerId: trigger.id, event: "push",
      body: JSON.stringify({ ref: "refs/heads/main", after: "9".repeat(40), repository: { full_name: "evil/other" }, pusher: { name: "octo" }, head_commit: { id: "9".repeat(40), message: "hi" } }),
    });
    assert.equal(foreignPush, "filtered_repo");
    assert.equal(launches.length, 0);

    // BUG-319: настройка default_user_per_day = 1 ограничивает второй запуск за сутки
    store.setSetting("default_user_per_day", 1);
    assert.equal(await deliver({ issue: { number: 10, title: "A", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] } }, "d-lim-1"), "started");
    assert.equal(await deliver({ issue: { number: 11, title: "B", body: "B", html_url: "u", user: { login: "octo" }, labels: [{ name: "agent" }] } }, "d-lim-2"), "rate_limited");
    assert.equal(launches.length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});


