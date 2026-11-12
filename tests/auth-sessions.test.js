// TASK-04.15 (wave2): unit — sessions of lib/auth.js: lastSeenAt touched on
// successful sid auth and saved to disk at most once per hour per session;
// sweepSessions removes records older than the cookie life and leaves live
// ones working; the 90-day inactivity counter; the legacy raw-token cookie
// deadline ZAI_LEGACY_COOKIE_UNTIL with injected "now". Isolated ZAI_DATA_DIR
// (set before the module loads its config).
// Run: node --test tests/auth-sessions.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "zai-auth-sessions-"));
const DATA = path.join(TMP, "data");
const ADMIN_TOKEN = "a".repeat(24) + "-auth-sess-unit-" + "5".repeat(24);
const sidHash = (sid) => createHash("sha256").update(sid).digest("hex");
const sessionsFile = () => path.join(DATA, "sessions.json");
const DAY = 86_400_000;
const T0 = Date.now(); // база «сейчас»: все времена теста — смещения от неё

let auth;

before(async () => {
  process.env.ZAI_DATA_DIR = DATA;
  process.env.ZAI_TENANT_HOME = path.join(TMP, "tenants");
  process.env.ZAI_TENANT_VAULT = path.join(TMP, "vault");
  process.env.ZAI_ADMIN_TOKEN = ADMIN_TOKEN;
  auth = await import("../lib/auth.js");
  auth.initAuth();
});

after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

// sessions.json: хеш → запись. Загрузка в память идёт только через initAuth().
function seedSessions(records) {
  writeFileSync(sessionsFile(), JSON.stringify({ sessions: records }), "utf8");
  auth.initAuth(); // reload
}

test("sweepSessions: запись старше срока жизни куки удалена, живая авторизует; файл переписан только при удалениях", () => {
  const live = "L".repeat(40);
  seedSessions({
    [sidHash("x".repeat(40))]: { userId: "admin", createdAt: T0 - 360 * DAY }, // при загрузке 360 дней (< года), к свипу T0+10d — 370: просрочена
    [sidHash(live)]: { userId: "admin", createdAt: T0 }, // живая
  });
  statSync(sessionsFile()); // файл существует до чистки
  assert.equal(auth.sweepSessions(T0 + 10 * DAY), 1, "expired record removed");
  const raw = JSON.parse(readFileSync(sessionsFile(), "utf8"));
  assert.deepEqual(Object.keys(raw.sessions), [sidHash(live)], "only the live record remains on disk");
  // то, что файл переписан, доказывает его содержимое (строкой выше); сравнение mtime «строго больше» было нестабильным — запись успевала в тот же отсчёт времени
  assert.equal(auth.authFromReq({ headers: { cookie: `zai_t=${live}` } }, T0 + 10 * DAY)?.user?.id, "admin", "the live session still authorizes");
  const mtimeAfterSweep = statSync(sessionsFile()).mtimeMs;
  assert.equal(auth.sweepSessions(T0 + 10 * DAY), 0, "nothing left to remove");
  assert.equal(statSync(sessionsFile()).mtimeMs, mtimeAfterSweep, "no removal, no rewrite");
});

test("lastSeenAt: обновляется при успешной авторизации по sid, на диск пишется не чаще раза в час", () => {
  const sid = auth.createSession({ id: "admin" });
  const req = { headers: { cookie: `zai_t=${sid}` } };
  // первая авторизация через 2 часа после создания: час прошёл, запись на диск
  const t = T0 + 2 * 3_600_000;
  assert.equal(auth.authFromReq(req, t)?.kind, "sid");
  let raw = JSON.parse(readFileSync(sessionsFile(), "utf8"));
  assert.equal(raw.sessions[sidHash(sid)].lastSeenAt, t, "persisted after an hour since creation");
  // вторая и третья авторизации в тот же час: lastSeenAt свежеет в памяти,
  // файл НЕ переписывается
  const mtimeBefore = statSync(sessionsFile()).mtimeMs;
  assert.equal(auth.authFromReq(req, t + 60_000)?.kind, "sid");
  assert.equal(auth.authFromReq(req, t + 120_000)?.kind, "sid");
  raw = JSON.parse(readFileSync(sessionsFile(), "utf8"));
  assert.equal(raw.sessions[sidHash(sid)].lastSeenAt, t, "file keeps the hourly value");
  assert.equal(statSync(sessionsFile()).mtimeMs, mtimeBefore, "no rewrite within the hour");
  // счётчик 90 дней видит свежий lastSeenAt именно из памяти
  assert.equal(auth.authSessionsStale90d(t + 2 * DAY), 0, "freshly seen sessions are not stale");
});

test("authSessionsStale90d: по lastSeenAt, без него — по createdAt; ничего не удаляется", () => {
  seedSessions({
    [sidHash("a".repeat(40))]: { userId: "admin", createdAt: T0 - 100 * DAY, lastSeenAt: T0 - 100 * DAY }, // stale
    [sidHash("b".repeat(40))]: { userId: "admin", createdAt: T0 - 95 * DAY }, // stale по createdAt (нет lastSeenAt)
    [sidHash("c".repeat(40))]: { userId: "admin", createdAt: T0 - 95 * DAY, lastSeenAt: T0 - 10 * DAY }, // живая
  });
  assert.equal(auth.authSessionsStale90d(T0), 2);
  assert.equal(auth.sessionCount(), 3, "the counter deletes nothing");
});

test("legacy-кука: принимается до ZAI_LEGACY_COOKIE_UNTIL включительно, после — как отсутствие куки", () => {
  auth.initAuth();
  const cookie = { headers: { cookie: `zai_t=${ADMIN_TOKEN}` } }; // сырой токен, не sid
  const sid = auth.createSession({ id: "admin" });
  const sidCookie = { headers: { cookie: `zai_t=${sid}` } };
  assert.equal(auth.authFromReq(cookie, Date.parse("2026-12-01T12:00:00Z"))?.kind, "legacy", "before the deadline");
  assert.equal(auth.authFromReq(cookie, Date.parse("2026-12-02T23:59:59Z"))?.kind, "legacy", "on the deadline day it still works");
  assert.equal(auth.authFromReq(cookie, Date.parse("2026-12-03T00:00:00Z")), null, "after the deadline: as if no cookie");
  assert.equal(auth.authFromReq(sidCookie, Date.parse("2026-12-03T00:00:00Z"))?.kind, "sid", "sid sessions are unaffected");
  assert.equal(auth.userFromReq(sidCookie)?.id, "admin", "userFromReq keeps working");
});

test("loginThrottled/loginFailure/loginSuccess: окно 60 с, порог 10, сброс успехом, окно истекает", () => {
  const T = Date.parse("2026-11-11T12:00:00Z");
  for (let i = 0; i < 10; i++) {
    assert.equal(auth.loginThrottled("9.9.9.9", T + i * 1000), false, `attempt ${i + 1} passes`);
    auth.loginFailure("9.9.9.9", T + i * 1000);
  }
  assert.equal(auth.loginThrottled("9.9.9.9", T + 11_000), true, "the 11th attempt is throttled");
  assert.equal(auth.loginThrottled("8.8.8.8", T + 12_000), false, "another address is unaffected");
  auth.loginSuccess("9.9.9.9");
  assert.equal(auth.loginThrottled("9.9.9.9", T + 13_000), false, "a success resets the address");
  // окно истекает: после 60 с лимит снят
  auth.loginFailure("7.7.7.7", T);
  auth.loginFailure("7.7.7.7", T + 1000);
  assert.equal(auth.loginThrottled("7.7.7.7", T + 61_000), false, "the window has slid away");
});
