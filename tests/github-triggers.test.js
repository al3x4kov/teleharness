// FEAT-20.3 (1.4/1.8/1.10): хранилище триггеров — CRUD, ревизии, журнал, subjects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { triggerService, decideEvent, DEFAULT_LIMITS, TriggerError } from "../lib/github/triggers.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "gh-trg-"));
const box = { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") };
const spec = { definitionId: "00000000-0000-4000-8000-000000000001", repo: "octo/hello", kinds: ["issue_labeled"], filters: { label: "agent" } };

function open() {
  const store = triggerService(path.join(tmp(), "db.sqlite"), { secrets: box, now: () => 1_700_000_000_000 });
  const created = store.create("u1", spec);
  return { store, created };
}

test("FEAT-20.3: create/get/byKeyHash — ключ хэшируется, секрет шифруется и читается", () => {
  const { store, created } = open();
  assert.match(created.key, /^[A-Za-z0-9_-]{43}$/, "ключ 32 байта base64url");
  const row = store.get("u1", created.id);
  assert.equal(row.repo, "octo/hello");
  assert.equal(row.enabled, true);
  assert.equal(row.revision, 1);
  assert.equal(row.createdAt, 1_700_000_000_000, "createdAt доходит из SELECT (регрессия алиасов)");
  assert.equal(row.hookId, null);
  assert.deepEqual(row.limits, DEFAULT_LIMITS);
  assert.equal(store.get("u2", created.id), undefined, "чужой не читает");
  const byHash = store.byKeyHash(createHash("sha256").update(created.key).digest("hex"));
  assert.equal(byHash.id, created.id);
  assert.equal(store.secretFor(byHash), created.secret, "секрет читается расшифровкой");
  const face = JSON.stringify(row);
  assert.ok(!face.includes(created.key), "ключ не лежит в строке триггера");
});

test("FEAT-20.3: update с ревизией — 409 на устаревшую; remove; rotateSecret", () => {
  const { store, created } = open();
  const updated = store.update("u1", created.id, { enabled: false, filters: { label: "todo" } }, 1);
  assert.equal(updated.enabled, false);
  assert.equal(updated.revision, 2);
  assert.equal(updated.filters.label, "todo");
  assert.throws(() => store.update("u1", created.id, { enabled: true }, 1), (e) => e instanceof TriggerError && e.status === 409);
  const rotated = store.rotateSecret("u1", created.id);
  assert.notEqual(rotated.secret, created.secret);
  assert.equal(store.secretFor(store.get("u1", created.id)), rotated.secret);
  store.remove("u1", created.id, 3);
  assert.equal(store.get("u1", created.id), undefined);
});

test("FEAT-20.3: журнал — event_key UNIQUE, дубликаты ссылаются на первый запуск, счётчики", () => {
  const { store, created } = open();
  const key = "t1:issue_labeled:o/r:n7:labeled";
  assert.equal(store.record({ triggerId: created.id, eventKey: key, kind: "issue_labeled", repo: "o/r", number: 7, actor: "alice", decision: "started", workflowId: "wf-1" }), true);
  assert.equal(store.record({ triggerId: created.id, eventKey: key, kind: "issue_labeled", repo: "o/r", number: 7, decision: "started", workflowId: "wf-2" }), false, "тот же event_key не пишется");
  assert.equal(store.firstByEventKey(key)?.workflowId, "wf-1");
  // дубликат пишется с event_key=null и ссылкой
  assert.equal(store.record({ triggerId: created.id, eventKey: null, kind: "issue_labeled", repo: "o/r", decision: "duplicate", reason: "Дубликат события", workflowId: "wf-1" }), true);

  store.record({ triggerId: created.id, eventKey: "t1:x", kind: "issue_opened", repo: "o/r", decision: "started", workflowId: "wf-3" });
  assert.equal(store.startedPerHour(created.id), 2, "оба запуска в час");
  assert.equal(store.startedPerDayForOwner("u1"), 2);
  assert.equal(store.startedPerDayForOwner("u2"), 0);

  const all = store.journal("u1", created.id);
  assert.equal(all.length, 3);
  const startedOnly = store.journal("u1", created.id, { filter: "started" });
  assert.deepEqual(startedOnly.map((r) => r.decision), ["started", "started"]);
  const skipped = store.journal("u1", created.id, { filter: "skipped" });
  assert.equal(skipped.length, 1);
  assert.throws(() => store.journal("u2", created.id), (e) => e instanceof TriggerError && e.status === 404, "чужому владельцу журнал не отдаётся");
});

test("FEAT-20.3: журнал отдаёт тело события у повторяемых решений (лист события, «Запустить снова»)", () => {
  const { store, created } = open();
  store.record({ triggerId: created.id, eventKey: null, kind: "issue_labeled", repo: "o/r", number: 9, decision: "rate_limited", reason: "Лимит частоты", eventJson: JSON.stringify({ kind: "issue_labeled", number: 9, title: "Т", url: "u9", author: "alice" }) });
  store.record({ triggerId: created.id, eventKey: null, kind: "issue_labeled", repo: "o/r", number: 9, decision: "duplicate", reason: "Дубликат события" });
  const rows = store.journal("u1", created.id, { filter: "skipped" });
  const withBody = rows.find((r) => r.decision === "rate_limited");
  assert.equal(withBody.eventJson.title, "Т", "eventJson разобран в объект");
  assert.equal(withBody.eventJson.url, "u9");
  assert.equal(rows.find((r) => r.decision === "duplicate").eventJson, null, "без тела — null");
});

test("FEAT-20.3: subjects — активный запуск, очередь, попытки CI, сброс человеческим коммитом", () => {
  const { store, created } = open();
  const subj = "t1:o/r:issue#7";
  assert.equal(store.subjectOf(created.id, subj), null);
  store.setActive(created.id, subj, "wf-1");
  assert.equal(store.subjectOf(created.id, subj).activeWorkflowId, "wf-1");
  store.setQueued(created.id, subj, "ev-9");
  assert.equal(store.queuedCount(created.id), 1);
  assert.equal(store.listWithSubjects(created.id).length, 1);
  store.releaseQueued(created.id, subj);
  assert.equal(store.queuedCount(created.id), 0);
  store.clearActive(created.id, subj);
  assert.equal(store.subjectOf(created.id, subj).activeWorkflowId, null);

  assert.equal(store.bumpCi(created.id, "b1"), 1);
  assert.equal(store.bumpCi(created.id, "b1"), 2);
  store.humanCommit(created.id, "b1", "sha9");
  const s = store.subjectOf(created.id, "b1");
  assert.equal(s.ciAttempts, 0, "человеческий коммит сбрасывает попытки");
  assert.equal(s.lastHumanSha, "sha9");
});

test("FEAT-20.3: настройки admin и GC — inbox 24 ч, журнал ≤ 1000 на триггер", () => {
  const { store, created } = open();
  store.setSetting("adminStopped", true);
  assert.equal(store.setting("adminStopped", false), true);
  store.setSetting("storm:t9", { at: 123 });
  assert.deepEqual(store.setting("storm:t9"), { at: 123 });

  store.insertDelivery("d-old", created.id, "issues", "{}");
  store.markProcessed("d-old");
  store.gc(); // обработанная доставка удаляется сразу
  assert.equal(store.pendingDeliveries().length, 0);

  for (let i = 0; i < 1005; i++) store.record({ triggerId: created.id, eventKey: `k${i}`, kind: "issue_opened", repo: "o/r", decision: "filtered_kind", reason: "x", at: 1_699_000_000_000 + i });
  store.gc(); // свежие записи остаются, но не больше 1000 на триггер
  assert.equal(store.journal("u1", created.id, { limit: 5000 }).length, 1000, "журнал обрезан до 1000 строк");
});

test("FEAT-20.3: decideEvent — порядок решений по design §4/§6", () => {
  const ev = { kind: "issue_labeled", repo: "o/r", number: 7, author: "alice", actor: "alice", labels: ["agent"] };
  const trigger = { enabled: true, limits: DEFAULT_LIMITS };
  const base = { ev, trigger, duplicate: false, activeWorkflowId: null, queuedEventKey: null, queueable: false, queueLen: 0, perHour: 0, userPerDay: 0, adminStopped: false, connectionOk: true, trusted: true };
  assert.equal(decideEvent(base).decision, "started");
  assert.equal(decideEvent({ ...base, adminStopped: true }).decision, "admin_stopped");
  assert.equal(decideEvent({ ...base, trigger: { ...trigger, enabled: false } }).decision, "trigger_disabled");
  assert.equal(decideEvent({ ...base, connectionOk: false }).decision, "no_connection");
  assert.equal(decideEvent({ ...base, duplicate: true }).decision, "duplicate");
  assert.equal(decideEvent({ ...base, duplicate: true, connectionOk: false }).decision, "duplicate", "повтор уже решённого события — дубликат даже без подключения");
  assert.equal(decideEvent({ ...base, connectionOk: false }).decision, "no_connection");
  assert.equal(decideEvent({ ...base, trusted: false }).decision, "untrusted_author");
  assert.equal(decideEvent({ ...base, perHour: 6 }).decision, "rate_limited");
  assert.equal(decideEvent({ ...base, userPerDay: 30 }).decision, "rate_limited");
  assert.equal(decideEvent({ ...base, activeWorkflowId: "wf-1" }).decision, "already_running");
  assert.equal(decideEvent({ ...base, activeWorkflowId: "wf-1", queueable: true }).decision, "queued");
  assert.equal(decideEvent({ ...base, activeWorkflowId: "wf-1", queueable: true, queueLen: 20 }).decision, "queue_full");
  assert.equal(decideEvent({ ...base, activeWorkflowId: "wf-1", queueable: true, queuedEventKey: "e" }).decision, "already_running");
});

test("BUG-316 + BUG-319 + BUG-323 п.2: DEFAULT_LIMITS без maxActive, clearQueue без остановки активных, last_agent_sha, verifyKey", () => {
  const { store, created } = open();
  // BUG-319: мёртвого maxActive нет ни в DEFAULT_LIMITS, ни в созданном триггере
  assert.equal("maxActive" in DEFAULT_LIMITS, false);
  assert.equal("maxActive" in created.limits, false);
  // BUG-323 п.2: timingSafeEqual verifyKey
  assert.equal(store.verifyKey("u1", created.id, created.key), true);
  assert.equal(store.verifyKey("u1", created.id, "x".repeat(43)), false);
  assert.equal(store.verifyKey("u1", created.id, ""), false);
  // BUG-319: clearQueue удаляет только queued, не трогая activeWorkflowId, и сбрасывает шторм
  store.setActive(created.id, "s1", "wf-live");
  store.setQueued(created.id, "s1", "ek1");
  store.setQueued(created.id, "s2", "ek2");
  store.setSetting(`storm:${created.id}`, { at: 1_700_000_000_000, count: 25 });
  assert.equal(store.queuedCount(created.id), 2);
  assert.equal(store.summaries("u1").get(created.id).queuedCount, 2);
  const cleared = store.clearQueue(created.id);
  assert.equal(cleared, 2);
  assert.equal(store.queuedCount(created.id), 0);
  assert.equal(store.subjectOf(created.id, "s1").activeWorkflowId, "wf-live", "активный запуск не тронут");
  assert.equal(store.setting(`storm:${created.id}`, null), null, "флаг шторма снят после очистки очереди");
  // BUG-316: recordAgentBranchPush сохраняет last_agent_sha по repo+branch
  const sha40 = "a".repeat(40);
  store.recordAgentBranchPush("octo/hello", "feature/fix", sha40);
  const sKey = `${created.id}:octo/hello:branch:feature/fix`;
  assert.equal(store.subjectOf(created.id, sKey).lastAgentSha, sha40);
});

