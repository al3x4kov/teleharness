// BUG-189 (BUG-16.5): перенос истории opencode 1.x → отдельная база 2.x.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareSnapshot, mergeSessions, countSessions } from "../lib/oc2-migrate.js";

const V2_SCHEMA = `
CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, vcs text, name text,
  time_created integer NOT NULL, time_updated integer NOT NULL, time_active integer DEFAULT 0 NOT NULL, sandboxes text NOT NULL);
CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
  directory text NOT NULL, path text, title text, version text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL,
  CONSTRAINT fk_p FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
  CONSTRAINT fk_s FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
CREATE TABLE session_part (message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL, type text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL, PRIMARY KEY (message_id, ordinal),
  CONSTRAINT fk_m FOREIGN KEY (message_id) REFERENCES session_message(id) ON DELETE CASCADE);
CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text);
CREATE TABLE kv (key text PRIMARY KEY, value text);
`;
const V1_EXTRA = `
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, directory text NOT NULL, title text NOT NULL, time_updated integer NOT NULL);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
`;

function tmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "oc2-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeDb(file, sql, fill) {
  const db = new DatabaseSync(file);
  db.exec(sql);
  fill?.(db);
  db.close();
  return file;
}

const P = (db, id, wt) => db.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, 1, 1, '[]')").run(id, wt);
const S = (db, id, pid, dir, title, t = 10) =>
  db.prepare("INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, time_created, time_updated) VALUES (?, ?, 's', ?, '', ?, '1.19.5', 1, ?)").run(id, pid, dir, title, t);
const M = (db, id, sid, seq, type = "user") =>
  db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, 1, 1, ?)").run(id, sid, type, seq, JSON.stringify({ text: id }));

// Сконвертированный снимок: admin (2 сообщения), Alice, Carol; водяной знак только у admin.
function converted(dir) {
  return makeDb(path.join(dir, "conv.db"), V2_SCHEMA, (db) => {
    P(db, "pa", "C:/Users/USER");
    P(db, "pj", "C:/Users/USER/.zai-tenants/Alice");
    P(db, "pn", "C:/Users/USER/.zai-tenants/Carol");
    S(db, "ses_admin", "pa", "C:/Users/USER", "Старый чат admin", 30);
    S(db, "ses_alice", "pj", "C:/Users/USER/.zai-tenants/Alice", "Утюг", 20);
    S(db, "ses_nat", "pn", "C:/Users/USER/.zai-tenants/Carol", "Презентация", 10);
    M(db, "m1", "ses_admin", 0);
    M(db, "m2", "ses_admin", 1, "assistant");
    M(db, "m3", "ses_alice", 0);
    db.prepare("INSERT INTO session_part (message_id, session_id, ordinal, type, time_created, time_updated, data) VALUES ('m2', 'ses_admin', 0, 'text', 1, 1, '{}')").run();
    db.prepare("INSERT INTO event_sequence VALUES ('ses_admin', 1, NULL)").run();
  });
}

// Рабочая база v2 прода: один чат, созданный после переключения.
function target(dir) {
  return makeDb(path.join(dir, "target.db"), V2_SCHEMA, (db) => {
    P(db, "pa", "C:/Users/USER");
    S(db, "ses_new", "pa", "C:/Users/USER", "Новый чат на v2", 99);
    M(db, "mn", "ses_new", 0);
    db.prepare("INSERT INTO event_sequence VALUES ('ses_new', 0, NULL)").run();
  });
}

const all = (file, sql) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
};

test("BUG-189: вливание переносит сессии admin и тенантов с папками, названиями и сообщениями", (t) => {
  const dir = tmp(t);
  const st = mergeSessions(converted(dir), target(dir));
  assert.deepEqual(st, { projects: 2, sessions: 3, skipped: 0, messages: 3, parts: 1, sequences: 3 });
  const rows = all(path.join(dir, "target.db"), "SELECT id, directory, title, time_updated FROM session_v2 ORDER BY time_updated DESC");
  assert.deepEqual(rows.map((r) => [r.id, r.directory, r.title, r.time_updated]), [
    ["ses_new", "C:/Users/USER", "Новый чат на v2", 99],
    ["ses_admin", "C:/Users/USER", "Старый чат admin", 30],
    ["ses_alice", "C:/Users/USER/.zai-tenants/Alice", "Утюг", 20],
    ["ses_nat", "C:/Users/USER/.zai-tenants/Carol", "Презентация", 10],
  ]);
  const msgs = all(path.join(dir, "target.db"), "SELECT id, session_id, seq FROM session_message ORDER BY id");
  assert.deepEqual(msgs.map((m) => m.id), ["m1", "m2", "m3", "mn"]);
});

test("BUG-189: водяной знак — из источника, иначе последний seq, у пустой сессии -1", (t) => {
  const dir = tmp(t);
  mergeSessions(converted(dir), target(dir));
  const seq = Object.fromEntries(all(path.join(dir, "target.db"), "SELECT aggregate_id, seq FROM event_sequence").map((r) => [r.aggregate_id, r.seq]));
  assert.deepEqual(seq, { ses_new: 0, ses_admin: 1, ses_alice: 0, ses_nat: -1 });
});

test("BUG-189: повторный запуск ничего не дублирует и не трогает существующие чаты (критерий 5)", (t) => {
  const dir = tmp(t);
  const conv = converted(dir);
  const tgt = target(dir);
  mergeSessions(conv, tgt);
  // после первой миграции пользователь переименовал старый чат и написал в него
  const db = new DatabaseSync(tgt);
  db.prepare("UPDATE session_v2 SET title = 'Переименован', time_updated = 500 WHERE id = 'ses_admin'").run();
  M(db, "m4", "ses_admin", 2);
  db.prepare("UPDATE event_sequence SET seq = 2 WHERE aggregate_id = 'ses_admin'").run();
  db.close();
  const st = mergeSessions(conv, tgt);
  assert.deepEqual(st, { projects: 0, sessions: 0, skipped: 3, messages: 0, parts: 0, sequences: 0 });
  const [s] = all(tgt, "SELECT title, time_updated FROM session_v2 WHERE id = 'ses_admin'");
  assert.deepEqual([s.title, s.time_updated], ["Переименован", 500]);
  assert.equal(all(tgt, "SELECT seq FROM event_sequence WHERE aggregate_id = 'ses_admin'")[0].seq, 2);
  assert.equal(countSessions(tgt).messages, 5);
});

test("BUG-189: dryRun считает, но не пишет; исходник вливания не меняется", (t) => {
  const dir = tmp(t);
  const conv = converted(dir);
  const tgt = target(dir);
  const before = statSync(conv).mtimeMs;
  const st = mergeSessions(conv, tgt, { dryRun: true });
  assert.equal(st.sessions, 3);
  assert.deepEqual(countSessions(tgt), { sessions: 1, messages: 1 });
  mergeSessions(conv, tgt);
  assert.equal(statSync(conv).mtimeMs, before);
  assert.deepEqual(countSessions(conv), { sessions: 3, messages: 3 });
});

test("BUG-189: лишние колонки цели и источника не мешают (схема 2.x дополняется ALTER)", (t) => {
  const dir = tmp(t);
  const conv = converted(dir);
  const tgt = target(dir);
  const a = new DatabaseSync(conv);
  a.exec("ALTER TABLE session_v2 ADD only_src text");
  a.close();
  const b = new DatabaseSync(tgt);
  b.exec("ALTER TABLE session_v2 ADD time_busy integer");
  b.close();
  assert.equal(mergeSessions(conv, tgt).sessions, 3);
});

test("BUG-189: цель без таблиц v2 — ошибка, ничего не записано", (t) => {
  const dir = tmp(t);
  const bad = makeDb(path.join(dir, "bad.db"), "CREATE TABLE x (a int);");
  assert.throws(() => mergeSessions(converted(dir), bad), /not an opencode 2\.x db/);
});

test("BUG-189: снимок 1.x — сброс следа прошлого пробного запуска, исходник не меняется (критерий 6)", (t) => {
  const dir = tmp(t);
  const src = makeDb(path.join(dir, "v1.db"), V2_SCHEMA + V1_EXTRA, (db) => {
    P(db, "pa", "C:/Users/USER");
    db.prepare("INSERT INTO session VALUES ('ses_a', 'pa', 'C:/Users/USER', 'A', 1), ('ses_b', 'pa', 'C:/Users/USER', 'B', 2)").run();
    db.prepare("INSERT INTO message VALUES ('m1', 'ses_a', 1, 1, '{}')").run();
    S(db, "ses_a", "pa", "C:/Users/USER", "A (устаревшая копия)");
    M(db, "old1", "ses_a", 0);
    db.prepare("INSERT INTO event_sequence VALUES ('ses_a', 0, NULL), ('other', 3, NULL)").run();
    db.prepare("INSERT INTO kv VALUES ('migration.v1-v2', '{\"phase\":\"completed\"}'), ('keep', '1')").run();
  });
  const before = statSync(src);
  const snap = path.join(dir, "snap.db");
  const r = prepareSnapshot(src, snap);
  assert.deepEqual(r, { sessions: 2, cleared: { session_v2: 1 } });
  assert.deepEqual(all(snap, "SELECT key FROM kv").map((x) => x.key), ["keep"]);
  assert.equal(all(snap, "SELECT COUNT(*) c FROM session_message")[0].c, 0);
  assert.deepEqual(all(snap, "SELECT aggregate_id FROM event_sequence").map((x) => x.aggregate_id), ["other"]);
  assert.equal(all(snap, "SELECT COUNT(*) c FROM message")[0].c, 1);
  // источник не тронут
  const after = statSync(src);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
  assert.equal(all(src, "SELECT COUNT(*) c FROM session_v2")[0].c, 1);
  assert.deepEqual(countSessions(src, "session"), { sessions: 2, messages: 1 });
});

test("BUG-189: снимок не из 1.x — ошибка", (t) => {
  const dir = tmp(t);
  const v2only = makeDb(path.join(dir, "v2.db"), V2_SCHEMA);
  assert.throws(() => prepareSnapshot(v2only, path.join(dir, "s.db")), /not an opencode 1\.x db/);
});
