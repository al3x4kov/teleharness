// FEAT-20.3 (1.3): хранилище подключений — revision, сброс предупреждений, ротация.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectionService } from "../lib/github/connections.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "gh-conn-"));
const rec = (tokenEnc = "box-1") => ({
  login: "octocat",
  tokenEnc,
  tokenLast4: "6789",
  expiresAt: 1_800_000_000_000,
  permissions: { repos: [{ fullName: "octocat/hello", private: false, permissions: { pull: true, push: true, admin: false } }] },
  status: "ok",
  checkedAt: 1_700_000_000_000,
});

test("FEAT-20.3: save/get — лицо по кругу, ревизия растёт, предупреждения сбрасываются", () => {
  const db = path.join(tmp(), "github-triggers.sqlite");
  const store = connectionService(db, { now: () => 1_710_000_000_000 });
  assert.equal(store.get("u1"), null);
  const row = store.save("u1", rec());
  assert.equal(row.login, "octocat");
  assert.equal(row.tokenEnc, "box-1");
  assert.equal(row.revision, 1);
  assert.deepEqual(row.permissions.repos[0].fullName, "octocat/hello");

  store.update("u1", { warnedAt: 111, expiredNotifiedAt: 222 });
  const reSaved = store.save("u1", rec("box-2"));
  assert.equal(reSaved.revision, 2);
  assert.equal(reSaved.tokenEnc, "box-2");
  assert.equal(reSaved.warnedAt, null, "новый токен — предупреждение заново");
  assert.equal(reSaved.expiredNotifiedAt, null);

  const updated = store.update("u1", { status: "expired", checkedAt: 1_710_000_060_000 });
  assert.equal(updated.status, "expired");
  assert.equal(updated.checkedAt, 1_710_000_060_000);
  assert.equal(store.update("u1", {}).revision, 2, "пустой update ничего не меняет");
  assert.equal(store.update("u1", { hacker: 1 }).status, "expired", "чужие колонки отбрасываются");
});

test("FEAT-20.3: list без tokenEnc, count, remove, rotateSecrets", () => {
  const db = path.join(tmp(), "github-triggers.sqlite");
  const store = connectionService(db);
  store.save("u1", rec("enc-1"));
  store.save("u2", rec("enc-2"));
  assert.equal(store.count(), 2);
  const rows = store.list();
  assert.deepEqual(rows.map((r) => r.owner), ["u1", "u2"]);
  assert.ok(rows.every((r) => !("tokenEnc" in r)), "list не отдаёт шифротокены");

  const moved = [];
  assert.equal(store.rotateSecrets((enc) => { moved.push(enc); return `rot:${enc}`; }), 2);
  assert.deepEqual(moved.sort(), ["enc-1", "enc-2"]);
  assert.equal(store.get("u1").tokenEnc, "rot:enc-1");

  assert.equal(store.remove("u1"), true);
  assert.equal(store.remove("u1"), false);
  assert.equal(store.get("u1"), null);
  assert.equal(store.count(), 1);
});
