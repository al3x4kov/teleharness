// TASK-14.9: bootstrap admin — первый запуск без data/users.json (в tmp).
// auth.test покрывает только сид с заданным ZAI_ADMIN_TOKEN; здесь — путь
// «чистая установка»: токена в env нет, сервер сам выпускает случайный,
// пишет его в admin-token.txt и журнал ОДИН раз, в users.json — только хэш.
// Повторный старт с готовым users.json не пересоздаёт админа (иначе тенанты
// терялись бы), а битый users.json останавливает сервер с понятной причиной и
// копией файла (BUG-12.13), не перезаписывая его.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { makeTmpRoot } from "./helpers/env.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const up = await startFakeOpencode();
const tmp = makeTmpRoot("zai-bootstrap-");
// Данные должны пережить рестарт: stop() не чистит tmp, чистим сами в конце.
const keepTmp = { ...tmp, cleanup() {} };
after(async () => {
  await up.close();
  tmp.cleanup();
});

const USERS = path.join(tmp.data, "users.json");
const TOKEN_FILE = path.join(tmp.data, "admin-token.txt");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

async function login(base, token) {
  const res = await fetch(`${base}/zai/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { res, cookie };
}
async function meOf(base, cookie) {
  const res = await fetch(`${base}/zai/api/auth/me`, { headers: { cookie } });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

let firstToken = null;
let firstUsers = null;

test("первый запуск без users.json и без ZAI_ADMIN_TOKEN: один admin, случайный токен в admin-token.txt и в журнале, в users.json только хэш", async () => {
  assert.equal(existsSync(USERS), false, "чистая установка");
  const srv = await spawnPortal({ upstream: up.url, tmp: keepTmp });
  try {
    assert.ok(existsSync(USERS), "users.json создан");
    assert.ok(existsSync(TOKEN_FILE), "admin-token.txt создан");
    firstToken = readFileSync(TOKEN_FILE, "utf8").trim();
    assert.match(firstToken, /^[0-9a-f]{64}$/, "случайный 256-битный токен");
    const raw = readFileSync(USERS, "utf8");
    firstUsers = JSON.parse(raw);
    assert.equal(firstUsers.users.length, 1);
    const admin = firstUsers.users[0];
    assert.equal(admin.role, "admin");
    assert.equal(admin.disabled, false);
    assert.deepEqual(admin.directories, [], "админ без ограничений по папкам");
    assert.equal(admin.tokenHash, sha256(firstToken));
    assert.equal(raw.includes(firstToken), false, "открытый токен в users.json не хранится");
    assert.equal(srv.log.split(firstToken).length - 1, 1, "токен в журнале ровно один раз");
    assert.match(srv.log, /\[zai-auth\] admin token \(bootstrap/);

    const { res, cookie } = await login(srv.base, firstToken);
    assert.equal(res.status, 200, "вход выпущенным токеном");
    const me = await meOf(srv.base, cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.role, "admin");
    assert.equal(me.body.user.id, admin.id);
    const bad = await login(srv.base, "0".repeat(64));
    assert.equal(bad.res.status, 401, "чужой токен не подходит");
  } finally {
    await srv.stop();
  }
});

test("повторный старт с готовым users.json: админ не пересоздаётся, прежний токен работает, новый не выпускается", async () => {
  assert.ok(firstToken, "нужен первый тест");
  // ZAI_ADMIN_TOKEN при уже существующем хранилище игнорируется.
  const srv = await spawnPortal({ upstream: up.url, tmp: keepTmp, env: { ZAI_ADMIN_TOKEN: "x".repeat(48) } });
  try {
    assert.equal(/admin token \(bootstrap/.test(srv.log), false, "бутстрап не повторился");
    assert.deepEqual(JSON.parse(readFileSync(USERS, "utf8")).users, firstUsers.users, "users.json не тронут");
    assert.equal(readFileSync(TOKEN_FILE, "utf8").trim(), firstToken);
    assert.equal((await login(srv.base, firstToken)).res.status, 200);
    assert.equal((await login(srv.base, "x".repeat(48))).res.status, 401, "env-токен не стал вторым админом");
  } finally {
    await srv.stop();
  }
});

test("битый users.json: сервер не стартует, причина по-русски, файл не перезаписан, рядом копия .corrupt-*", async () => {
  writeFileSync(USERS, '{"users": [ {"id": "admin", ', "utf8");
  await assert.rejects(spawnPortal({ upstream: up.url, tmp: keepTmp }), (err) => {
    assert.match(err.message, /завершился до старта \(code 1\)/);
    assert.match(err.message, /users\.json повреждён/);
    return true;
  });
  assert.equal(readFileSync(USERS, "utf8"), '{"users": [ {"id": "admin", ', "файл не перезаписан пустым админом");
  assert.ok(readdirSync(tmp.data).some((n) => n.startsWith("users.json.corrupt-")), "копия сохранена");
});
