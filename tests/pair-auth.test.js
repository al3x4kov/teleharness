// FEAT-18.2: unit — one-time phone sign-in codes of lib/auth.js with an
// injected clock: 32 random bytes in base64url, only sha256(code) kept, TTL
// 10 minutes, one use, ≤5 live codes per user, codes die with the user's
// sessions (token rotation / disable / delete), the claim throttle per address
// and globally. Isolated TELEHARNESS_DATA_DIR (set before the module loads config).
// Run: node --test tests/pair-auth.test.js
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "teleharness-pair-auth-"));
const DATA = path.join(TMP, "data");
const ADMIN_TOKEN = "p".repeat(24) + "-pair-auth-unit-" + "7".repeat(24);
const T0 = Date.now();
const MIN = 60_000;

let auth;
let tenant;

before(async () => {
  process.env.TELEHARNESS_DATA_DIR = DATA;
  process.env.TELEHARNESS_TENANT_HOME = path.join(TMP, "tenants");
  process.env.TELEHARNESS_TENANT_VAULT = path.join(TMP, "vault");
  process.env.TELEHARNESS_ADMIN_TOKEN = ADMIN_TOKEN;
  auth = await import("../lib/auth.js");
  auth.initAuth();
  tenant = auth.createUser({ name: "pairtenant" }).user;
});

after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

beforeEach(() => auth.resetClaimThrottle());

const status = (fn) => {
  try {
    fn();
    return 0;
  } catch (err) {
    return err.status ?? -1;
  }
};

test("выпуск: 32 байта base64url, срок 10 минут; сервер нигде не хранит сам код", () => {
  const { code, expiresAt } = auth.createPairCode("admin", T0);
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(code, "base64url").length, 32);
  assert.equal(expiresAt, T0 + 10 * MIN);
  assert.equal(auth.PAIR_TTL_MS, 10 * MIN);
  // nothing on disk carries the plaintext (users.json / sessions.json)
  for (const f of readdirSync(DATA)) {
    const p = path.join(DATA, f);
    try {
      assert.ok(!readFileSync(p, "utf8").includes(code), `${f} must not contain the code`);
    } catch (err) {
      if (err.code !== "EISDIR") throw err;
    }
  }
  assert.equal(auth.claimPairCode(code, T0 + 1000).id, "admin");
});

test("одно использование: второй claim → 410", () => {
  const { code } = auth.createPairCode(tenant.id, T0);
  assert.equal(auth.claimPairCode(code, T0 + 5).id, tenant.id);
  assert.equal(status(() => auth.claimPairCode(code, T0 + 10)), 410);
});

test("истечение: за миг до 10 минут — вход, ровно в 10 минут и позже → 410", () => {
  const a = auth.createPairCode(tenant.id, T0);
  const b = auth.createPairCode(tenant.id, T0);
  assert.equal(auth.claimPairCode(a.code, T0 + 10 * MIN - 1).id, tenant.id);
  assert.equal(status(() => auth.claimPairCode(b.code, T0 + 10 * MIN)), 410);
});

test("неизвестный и битый код → 401", () => {
  assert.equal(status(() => auth.claimPairCode("A".repeat(43), T0)), 401);
  assert.equal(status(() => auth.claimPairCode("short", T0)), 401);
  assert.equal(status(() => auth.claimPairCode(undefined, T0)), 401);
  assert.equal(status(() => auth.claimPairCode({ code: "x" }, T0)), 401);
});

test("код входит под тем, кто его выпустил: admin-код → admin, код тенанта → тенант", () => {
  const ca = auth.createPairCode("admin", T0).code;
  const ct = auth.createPairCode(tenant.id, T0).code;
  assert.equal(auth.claimPairCode(ct, T0 + 1).id, tenant.id);
  assert.equal(auth.claimPairCode(ca, T0 + 1).id, "admin");
});

test("не больше 5 активных кодов на пользователя; использованные и истёкшие не считаются; другой пользователь не затронут", () => {
  const u = auth.createUser({ name: "pairlimit" }).user;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push(auth.createPairCode(u.id, T0).code);
  assert.equal(status(() => auth.createPairCode(u.id, T0)), 429);
  assert.equal(status(() => auth.createPairCode("admin", T0)), 0, "another user is not limited by this one");
  auth.claimPairCode(codes[0], T0 + 1); // used → frees a slot
  assert.equal(status(() => auth.createPairCode(u.id, T0 + 2)), 0);
  assert.equal(status(() => auth.createPairCode(u.id, T0 + 3)), 429);
  assert.equal(status(() => auth.createPairCode(u.id, T0 + 10 * MIN + 5)), 0, "after the TTL the old codes are gone");
});

test("коды умирают со сменой токена, отключением и удалением пользователя", () => {
  const u = auth.createUser({ name: "pairrevoke" }).user;
  const c1 = auth.createPairCode(u.id, T0).code;
  auth.regenerateToken(u.id);
  assert.equal(status(() => auth.claimPairCode(c1, T0 + 1)), 401, "token regenerated → pending code dropped");
  const c2 = auth.createPairCode(u.id, T0).code;
  auth.updateUser(u.id, { disabled: true });
  assert.equal(status(() => auth.claimPairCode(c2, T0 + 1)), 401, "disabled → code dropped");
  assert.equal(status(() => auth.createPairCode(u.id, T0)), 404, "a disabled user cannot mint");
  auth.updateUser(u.id, { disabled: false });
  const c3 = auth.createPairCode(u.id, T0).code;
  auth.deleteUser(u.id, { rm: () => {} });
  assert.equal(status(() => auth.claimPairCode(c3, T0 + 1)), 401, "deleted → code dropped");
  assert.equal(status(() => auth.createPairCode("nobody", T0)), 404);
});

test("ограничение попыток claim: 10 неудач с адреса за минуту → throttled, другой адрес свободен, окно истекает", () => {
  for (let i = 0; i < 9; i++) auth.claimFailure("10.0.0.1", T0);
  assert.equal(auth.claimThrottled("10.0.0.1", T0), false);
  auth.claimFailure("10.0.0.1", T0);
  assert.equal(auth.claimThrottled("10.0.0.1", T0 + 1), true);
  assert.equal(auth.claimThrottled("10.0.0.2", T0 + 1), false);
  assert.equal(auth.claimThrottled("10.0.0.1", T0 + MIN), false, "the window expires");
});

test("глобальное ограничение claim: 100 неудач с разных адресов за минуту → throttled для всех", () => {
  for (let i = 0; i < 100; i++) auth.claimFailure(`10.1.${i >> 8}.${i & 255}`, T0);
  assert.equal(auth.claimThrottled("10.9.9.9", T0 + 1), true);
  assert.equal(auth.claimThrottled("10.9.9.9", T0 + MIN), false);
});
