// FEAT-20.3 (1.7): опросщик — режимы, курсоры/ETag, бюджет, псевдо-webhook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { triggerService } from "../lib/github/triggers.js";
import { createDispatcher } from "../lib/github/dispatch.js";
import { createGithubPoller } from "../lib/github/poller.js";

const NOW = 1_700_000_000_000; // фиксированное «сейчас»
const iso = (t) => new Date(t).toISOString();
const TMP = () => mkdtempSync(path.join(tmpdir(), "gh-poll-"));

function jsonResponse(status, data = null, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => data, text: async () => JSON.stringify(data) };
}
function fakeFetch(table) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", etag: init.headers?.["if-none-match"] ?? null });
    const parsed = { ...init, body: init.body ? JSON.parse(init.body) : null };
    for (const [method, re, reply] of table) {
      if ((init.method ?? "GET") !== method) continue;
      const m = re.exec(url);
      if (m) return typeof reply === "function" ? reply({ url, init: parsed, calls: calls.length }) : reply;
    }
    return jsonResponse(404, { message: "Not Found" });
  };
  return Object.assign(impl, { calls });
}

function rig({ fetchImpl, delivery = "poll", pollSeconds = 120 } = {}) {
  const dir = TMP();
  const store = triggerService(path.join(dir, "db.sqlite"), { secrets: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") }, now: () => NOW });
  const launches = [];
  const dispatcher = createDispatcher({
    store,
    connections: { get: () => ({ login: "octo", status: "ok" }) },
    launch: async (t, ev, requestId) => { launches.push({ ev, requestId }); return { workflowId: `wf-${launches.length}` }; },
    log: () => {},
  });
  const trigger = store.create("u1", { definitionId: "00000000-0000-4000-8000-000000000001", repo: "o/r", kinds: [], filters: {}, delivery, pollSeconds });
  const logs = [];
  const poller = createGithubPoller({
    store, dispatcher,
    connectionToken: () => "tok",
    apiBase: "http://gh.local",
    fetchImpl,
    log: (m) => logs.push(m),
    now: () => NOW,
  });
  return { store, dispatcher, poller, trigger, launches, logs, dir };
}
const cleanup = (store, dir) => { store?.close?.(); rmSync(dir, { recursive: true, force: true }); };

// Стандартные ответы GitHub: одна задача с меткой agent, команда, красный CI.
const issue = {
  number: 5, title: "Сломалось", body: "почини", html_url: "u",
  user: { login: "octo" }, labels: [{ name: "agent" }],
  created_at: iso(NOW - 60_000), updated_at: iso(NOW - 60_000),
};
const comment = {
  id: 77, body: "/agent сделай ещё тест", html_url: "cu",
  user: { login: "octo" }, issue_url: "https://api.github.com/repos/o/r/issues/5",
  created_at: iso(NOW - 30_000),
};
const standardTable = () => [
  ["GET", /\/repos\/o\/r\/issues\?/, jsonResponse(200, [issue], { etag: 'W/"i1"' })],
  ["GET", /\/repos\/o\/r\/issues\/comments/, jsonResponse(200, [comment], { etag: 'W/"c1"' })],
  ["GET", /\/repos\/o\/r\/actions\/runs/, jsonResponse(200, { total_count: 1, workflow_runs: [{ id: 9, name: "CI", conclusion: "failure", head_sha: "s9", head_branch: "main", html_url: "ru", actor: { login: "octo" }, created_at: iso(NOW - 10_000) }] }, { etag: 'W/"r1"' })],
];

test("FEAT-20.3: режимы опроса — poll/auto-без-хука/auto-с-хуком/webhook/выключен", () => {
  const mk = (over) => ({ pollSeconds: 120, enabled: true, hookId: null, delivery: "poll", ...over });
  const { store, poller, dir } = rig();
  try {
    assert.equal(poller.modeOf(mk({})), 120_000);
    assert.equal(poller.modeOf(mk({ delivery: "auto" })), 120_000, "auto без хука опрашивает как poll");
    assert.equal(poller.modeOf(mk({ delivery: "auto", hookId: 5 })), 900_000, "auto с хуком — сверка раз в 15 мин");
    assert.equal(poller.modeOf(mk({ delivery: "webhook" })), null);
    assert.equal(poller.modeOf(mk({ enabled: false })), null);
  } finally { cleanup(store, dir); }
});

test("FEAT-20.3: цикл опроса — запуск по задаче и CI, псевдо-webhook с via=poll, курсоры сдвинуты", async () => {
  const f = fakeFetch(standardTable());
  const { store, poller, trigger, launches, dir } = rig({ fetchImpl: f });
  try {
    const processed = await poller.pollTrigger(trigger);
    assert.equal(processed, 2, "started: задача + красный CI; метка/команда — тот же subject → already_running");
    assert.equal(launches.length, 2);
    assert.equal(launches[0].ev.kind, "issue_opened");
    assert.equal(launches[1].ev.kind, "ci_failed");
    assert.equal(launches[1].ev.workflow, "CI");
    const entries = store.journal("u1", trigger.id, { limit: 100 });
    assert.ok(entries.every((e) => e.via === "poll"), "все решения помечены via=poll");
    assert.ok(entries.some((e) => e.decision === "already_running"), "повторные события того же subject — already_running");
    const cur = store.cursorGet(trigger.id, "issues");
    assert.equal(cur.etag, 'W/"i1"');
    assert.equal(cur.since, issue.updated_at);
    assert.ok(store.cursorGet(trigger.id, "runs").since, "курсор CI записан");
  } finally { cleanup(store, dir); }
});

test("FEAT-20.3: второй цикл — 304 не приносит событий, повтор комментария — duplicate", async () => {
  const f = fakeFetch(standardTable());
  const { store, poller, trigger, launches, dir } = rig({ fetchImpl: f });
  try {
    await poller.pollTrigger(trigger);
    const startedBefore = store.journal("u1", trigger.id, { filter: "started", limit: 100 }).length;
    const processed = await poller.pollTrigger(trigger);
    assert.equal(processed, 0);
    assert.equal(launches.length, 2, "запусков не добавилось");
    assert.ok(store.journal("u1", trigger.id, { limit: 100 }).some((e) => e.decision === "duplicate"), "повторная эмиссия того же события — duplicate");
    assert.equal(store.journal("u1", trigger.id, { filter: "started", limit: 100 }).length, startedBefore);
    const issueCalls = f.calls.filter((c) => c.url.includes("/issues?"));
    assert.equal(issueCalls.at(-1).etag, 'W/"i1"', "второй запрос идёт с If-None-Match");
  } finally { cleanup(store, dir); }
});

test("FEAT-20.3: rate_limited — пауза; бюджет 1000/ч — опрос не ходит в сеть", async () => {
  const limited = fakeFetch([["GET", /\/repos\/o\/r\/issues\?/, jsonResponse(403, { message: "API rate limit exceeded" }, { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" })]]);
  const { store, poller, trigger, dir } = rig({ fetchImpl: limited });
  try {
    assert.equal(await poller.pollTrigger(trigger), 0);
    assert.equal(poller.budgetOk("u1"), false, "после rate_limited триггер на паузе");
  } finally { cleanup(store, dir); }

  const f = fakeFetch(standardTable());
  const { store: s2, poller: p2, trigger: t2, dir: d2 } = rig({ fetchImpl: f });
  try {
    for (let i = 0; i < 1000; i++) p2.spend("u1");
    assert.equal(p2.budgetOk("u1"), false, "бюджет исчерпан");
    assert.equal(await p2.pollTrigger(t2), 0);
    assert.equal(f.calls.length, 0, "в сеть не ходим");
  } finally { cleanup(s2, d2); }
});

test("FEAT-20.3: нет подключения — тихий пропуск, в сеть не ходим", async () => {
  const f = fakeFetch(standardTable());
  const dir = TMP();
  const store = triggerService(path.join(dir, "db.sqlite"), { secrets: { encrypt: (s) => s, decrypt: (s) => s }, now: () => NOW });
  const poller = createGithubPoller({
    store,
    dispatcher: { processDelivery: async () => "started" },
    connectionToken: () => null,
    apiBase: "http://gh.local",
    fetchImpl: f,
    log: () => {},
    now: () => NOW,
  });
  const trigger = store.create("u1", { definitionId: "00000000-0000-4000-8000-000000000001", repo: "o/r", kinds: [], filters: {}, delivery: "poll", pollSeconds: 120 });
  try {
    assert.equal(await poller.pollTrigger(trigger), 0);
    assert.equal(f.calls.length, 0);
  } finally { cleanup(store, dir); }
});

test("FEAT-20.3: команда /agent при poll обогащается задачей и проходит с фильтром label (регресс стенда)", async () => {
  const soloComment = {
    id: 88, body: "/agent почини", html_url: "https://github.com/o/r/issues/9#issuecomment-88",
    user: { login: "octo" }, issue_url: "https://api.github.com/repos/o/r/issues/9",
    created_at: iso(NOW - 10_000),
  };
  const fetchedIssue = {
    number: 9, title: "Кнопка не жмётся", body: "Шаги воспроизведения",
    html_url: "https://github.com/o/r/issues/9", user: { login: "octo" },
    labels: [{ name: "agent" }], created_at: iso(NOW - 300_000), updated_at: iso(NOW - 300_000),
  };
  const f = fakeFetch([
    ["GET", /\/repos\/o\/r\/issues\?/, jsonResponse(200, [], { etag: 'W/"i0"' })],
    ["GET", /\/repos\/o\/r\/issues\/comments/, jsonResponse(200, [soloComment], { etag: 'W/"c9"' })],
    ["GET", /\/repos\/o\/r\/issues\/9$/, jsonResponse(200, fetchedIssue)],
    ["GET", /\/repos\/o\/r\/actions\/runs/, jsonResponse(200, { total_count: 0, workflow_runs: [] })],
  ]);
  const dir = TMP();
  const store = triggerService(path.join(dir, "db.sqlite"), { secrets: { encrypt: (s) => s, decrypt: (s) => s }, now: () => NOW });
  const launches = [];
  const dispatcher = createDispatcher({
    store,
    connections: { get: () => ({ login: "octo", status: "ok" }) },
    launch: async (t, ev, requestId) => { launches.push({ ev, requestId }); return { workflowId: "wf-cmd-1" }; },
    log: () => {},
  });
  const trigger = store.create("u1", {
    definitionId: "00000000-0000-4000-8000-000000000001",
    repo: "o/r",
    kinds: ["issue_labeled", "comment_command"],
    filters: { label: "agent", command: "agent" },
    delivery: "poll",
    pollSeconds: 120,
  });
  const poller = createGithubPoller({ store, dispatcher, connectionToken: () => "tok", apiBase: "http://gh.local", fetchImpl: f, log: () => {}, now: () => NOW });
  try {
    const processed = await poller.pollTrigger(trigger);
    assert.equal(processed, 1);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].ev.kind, "comment_command");
    assert.equal(launches[0].ev.title, "Кнопка не жмётся");
    assert.equal(launches[0].ev.url, "https://github.com/o/r/issues/9#issuecomment-88");
  } finally { cleanup(store, dir); }
});

test("BUG-321: modeOf при delivery=webhook с hookId даёт сверку 15 мин (900_000), без hookId — null", () => {
  const mk = (over) => ({ pollSeconds: 120, enabled: true, hookId: null, delivery: "webhook", ...over });
  const { store, poller, dir } = rig();
  try {
    assert.equal(poller.modeOf(mk({ hookId: 77 })), 900_000, "webhook с настроенным хуком сверяется раз в 15 мин");
    assert.equal(poller.modeOf(mk({ hookId: null })), null, "webhook без хука не опрашивается");
  } finally { cleanup(store, dir); }
});

test("BUG-313: опрос workflow_run из форка передаёт head_repository → fork_pr без запуска", async () => {
  const f = fakeFetch([
    ["GET", /\/repos\/o\/r\/issues\?/, jsonResponse(200, [], { etag: 'W/"i0"' })],
    ["GET", /\/repos\/o\/r\/issues\/comments/, jsonResponse(200, [], { etag: 'W/"c0"' })],
    ["GET", /\/repos\/o\/r\/actions\/runs/, jsonResponse(200, {
      total_count: 1,
      workflow_runs: [{
        id: 19, name: "CI", conclusion: "failure", head_sha: "s19", head_branch: "patch-1",
        head_repository: { full_name: "stranger/r", fork: true },
        pull_requests: [], html_url: "ru", actor: { login: "octo" }, created_at: iso(NOW - 5_000),
      }],
    })],
  ]);
  const { store, poller, trigger, launches, dir } = rig({ fetchImpl: f });
  try {
    const processed = await poller.pollTrigger(trigger);
    assert.equal(processed, 0);
    assert.equal(launches.length, 0, "CI из форка не должен запускать агента");
    assert.ok(store.journal("u1", trigger.id, { limit: 50 }).some((e) => e.decision === "fork_pr"));
  } finally { cleanup(store, dir); }
});

