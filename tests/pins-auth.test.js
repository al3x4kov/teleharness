// FEAT-01.69: lib/auth.js pins — shape rules (cleanPins), per-user storage,
// persistence, clean-up when a chat or an account is deleted. Isolated
// ZAI_DATA_DIR (set before the module loads its config).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "zai-pins-auth-"));
let auth;
before(async () => {
  process.env.ZAI_DATA_DIR = path.join(TMP, "data");
  process.env.ZAI_TENANT_HOME = path.join(TMP, "tenants");
  process.env.ZAI_TENANT_VAULT = path.join(TMP, "vault");
  process.env.ZAI_ADMIN_TOKEN = "u".repeat(24) + "-pins-unit-" + "1".repeat(24);
  auth = await import("../lib/auth.js");
  auth.initAuth();
});
after(() => rmSync(TMP, { recursive: true, force: true }));

test("cleanPins: strings of the id alphabet only, duplicates collapsed, order kept, limit 200; non-array → 400", () => {
  assert.deepEqual(auth.cleanPins(["ses_b", "ses_a", "ses_b", 7, null, "", "a/b", "x y", "ok-1_Z"]), ["ses_b", "ses_a", "ok-1_Z"]);
  const many = Array.from({ length: 250 }, (_, i) => `ses_${i}`);
  const out = auth.cleanPins(many);
  assert.equal(out.length, auth.PINS_MAX);
  assert.equal(out[0], "ses_0");
  assert.throws(() => auth.cleanPins("ses_a"), (e) => e.status === 400);
  assert.throws(() => auth.cleanPins(undefined), (e) => e.status === 400);
  assert.deepEqual(auth.cleanPins(["s".repeat(129)]), [], "an over-long id is junk");
});

test("getPins/setPins: per user, persisted in users.json, never in publicUser; empty list removes the field", () => {
  const a = auth.createUser({ name: "pa" }).user;
  const b = auth.createUser({ name: "pb" }).user;
  assert.deepEqual(auth.getPins(a.id), []);
  assert.deepEqual(auth.setPins(a.id, ["ses_1", "ses_2", "ses_1"]), ["ses_1", "ses_2"]);
  assert.deepEqual(auth.getPins(b.id), [], "isolated");
  const file = JSON.parse(readFileSync(path.join(process.env.ZAI_DATA_DIR, "users.json"), "utf8"));
  assert.deepEqual(file.users.find((u) => u.id === a.id).pins, ["ses_1", "ses_2"]);
  assert.equal("pins" in auth.publicUser(file.users.find((u) => u.id === a.id)), false);
  assert.equal(JSON.stringify(auth.listUsers()).includes("ses_1"), false);
  auth.setPins(a.id, []);
  assert.equal("pins" in JSON.parse(readFileSync(path.join(process.env.ZAI_DATA_DIR, "users.json"), "utf8")).users.find((u) => u.id === a.id), false);
  assert.throws(() => auth.setPins("nobody", ["ses_1"]), (e) => e.status === 404);
});

test("dropPinEverywhere: a deleted chat leaves every user's list; deleteUser takes the user's pins", () => {
  const c = auth.createUser({ name: "pc" }).user;
  const d = auth.createUser({ name: "pd" }).user;
  auth.setPins(c.id, ["ses_x", "ses_y"]);
  auth.setPins(d.id, ["ses_x"]);
  assert.equal(auth.dropPinEverywhere("ses_x"), 2);
  assert.deepEqual(auth.getPins(c.id), ["ses_y"]);
  assert.deepEqual(auth.getPins(d.id), []);
  assert.equal(auth.dropPinEverywhere("ses_x"), 0, "nothing left to drop");
  auth.deleteUser(c.id, { rm: () => {} });
  assert.deepEqual(auth.getPins(c.id), []);
  assert.equal(JSON.stringify(JSON.parse(readFileSync(path.join(process.env.ZAI_DATA_DIR, "users.json"), "utf8"))).includes("ses_y"), false);
});
