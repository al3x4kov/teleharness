// TASK-17.1 (EPIC-17, ADR-011): POSIX-ветка политики путей. Windows-поведение
// не меняется (tests/paths.test.js, g1-units — без правок); здесь — Linux.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirProblem, driveProblem, isAbsoluteDir, isUnderAny, pathKey } from "../lib/paths.js";
import { normDir, normDirFor } from "../lib/auth.js";

const L = { platform: "linux" };

test("TASK-17.1: isAbsoluteDir на Linux — только абсолютные POSIX-пути без «..»", () => {
  assert.equal(isAbsoluteDir("/home/julia/chats", L), true);
  assert.equal(isAbsoluteDir("home/julia", L), false);
  assert.equal(isAbsoluteDir("/home/../etc", L), false);
  assert.equal(isAbsoluteDir("C:\\Users\\x", L), false, "Windows-путь на Linux — не абсолютный");
  assert.equal(isAbsoluteDir("", L), false);
});

test("TASK-17.1: dirProblem на Linux — корень ФС и системные каталоги запрещены", () => {
  assert.equal(dirProblem("/", L), "drive-root");
  for (const d of ["/etc", "/etc/ssh", "/usr/bin", "/proc/1", "/sys", "/dev", "/boot", "/root", "/var/lib/docker", "/run/docker.sock", "/bin", "/sbin", "/lib", "/lib64"]) {
    assert.equal(dirProblem(d, L), "system", d);
  }
  assert.equal(dirProblem("/home/julia/work", L), null);
  assert.equal(dirProblem("/srv/zai/tenants/julia", L), null);
  assert.equal(dirProblem("relative/dir", L), "not-absolute");
  assert.equal(dirProblem("/home/a\u0001b", L), "alias", "управляющие символы");
  assert.equal(dirProblem("", L), "empty");
});

test("TASK-17.1: dirProblem на Linux — зоны владельца для тенанта, регистр значим", () => {
  const o = { ...L, tenant: true, portalRoot: "/opt/zai", dataDir: "/var/zai-data", profileRoot: "/home/owner" };
  assert.equal(dirProblem("/opt/zai/server.js", o), "portal");
  assert.equal(dirProblem("/home/owner", o), "profile-root");
  assert.equal(dirProblem("/home/owner/.zai-tenants/julia", o), null, "подпапки профиля — можно");
  assert.equal(dirProblem("/opt/ZAI", o), null, "на Linux /opt/ZAI — другая папка, не портал");
});

test("TASK-17.1: driveProblem на Linux не применяется", () => {
  assert.equal(driveProblem("/home/x", { ...L, exists: () => false }), null);
});

test("TASK-17.1: isUnderAny на Linux — граница сегмента и регистр", () => {
  assert.equal(isUnderAny("/tmp/zai-smoke/a", ["/tmp"], L), true);
  assert.equal(isUnderAny("/tmpfoo/a", ["/tmp"], L), false);
  assert.equal(isUnderAny("/TMP/a", ["/tmp"], L), false);
});

test("TASK-17.1: pathKey — Windows регистро- и слэш-нечувствителен, Linux — нет", () => {
  assert.equal(pathKey("C:/Users/USER/", "win32"), pathKey("c:\\users\\user", "win32"));
  assert.notEqual(pathKey("/home/A", "linux"), pathKey("/home/a", "linux"));
  assert.equal(pathKey("/home/a/", "linux"), "/home/a");
  assert.equal(pathKey("/home//a/./b", "linux"), "/home/a/b");
});

test("TASK-17.1: normDir не схлопывает регистр на Linux", () => {
  if (process.platform === "win32") {
    assert.equal(normDir("C:\\Users\\USER"), normDir("c:\\users\\user"));
  } else {
    assert.notEqual(normDir("/home/A"), normDir("/home/a"));
  }
  assert.equal(normDirFor("/x/y", "linux"), "/x/y");
  assert.notEqual(normDirFor("/x/Y", "linux"), normDirFor("/x/y", "linux"));
});
