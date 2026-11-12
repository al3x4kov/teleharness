// BUG-17.14 (BUG-220): разрешение на зону базы знаний тенанта сравнивается по платформе.
// Run: node --test tests/policy-vault-root-platform.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setTenantVaultRoots, tenantVaultRoots, underVaultRoot } from "../lib/policy.js";

const before = tenantVaultRoots();
after(() => setTenantVaultRoots(before));

test("BUG-17.14: underVaultRoot на win32 — без учёта регистра и вида слэшей (поведение прода)", () => {
  setTenantVaultRoots(["D:\\Obsidian\\tenants"]);
  assert.equal(underVaultRoot("D:\\Obsidian\\tenants\\alice\\*", "win32"), true);
  assert.equal(underVaultRoot("d:/obsidian/TENANTS/alice/*", "win32"), true);
  assert.equal(underVaultRoot("D:\\Obsidian\\tenants\\*", "win32"), true, "сам корень");
  assert.equal(underVaultRoot("D:\\Obsidian\\tenants2\\alice\\*", "win32"), false, "общий префикс имени — не вложенность");
  assert.equal(underVaultRoot("D:\\Obsidian\\tenants\\alice", "win32"), false, "без \\* — не шаблон зоны");
  assert.equal(underVaultRoot("D:\\Obsidian\\tenants\\..\\agents\\*", "win32"), false);
});

test("BUG-17.14: underVaultRoot на linux — «/», регистр значим", () => {
  setTenantVaultRoots(["/vault/tenants"]);
  assert.equal(underVaultRoot("/vault/tenants/alice/*", "linux"), true);
  assert.equal(underVaultRoot("/vault/tenants/*", "linux"), true);
  assert.equal(underVaultRoot("/vault/Tenants/alice/*", "linux"), false, "другой регистр — другой каталог");
  assert.equal(underVaultRoot("/vault/tenants2/alice/*", "linux"), false);
  assert.equal(underVaultRoot("/vault/tenants/../agents/*", "linux"), false);
  assert.equal(underVaultRoot("/*", "linux"), false);
});
