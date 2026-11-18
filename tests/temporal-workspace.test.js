// BUG-251 / FEAT-19.16: pipe and run folders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, uniqueSlug, workspaceOf, runFolderName, isPipelineFolder } from "../lib/temporal/workspace.js";

test("slug: кириллица сохраняется, опасные символы и зарезервированные имена заменены", () => {
  assert.equal(slugify("Ревью изменений портала"), "ревью-изменений-портала");
  assert.equal(slugify("a/../b:c*?"), "a-..-b-c");
  assert.equal(slugify("  ../  "), "pipe");
  assert.equal(slugify("CON"), "pipe");
  assert.equal(slugify("x".repeat(100)).length, 60);
});
test("slug уникален в проекте", () => {
  assert.equal(uniqueSlug("Отчёт", new Set(["отчёт", "отчёт-2"])), "отчёт-3");
});
test("папка пайпа — внутри проекта; неабсолютный проект или чужой slug отклоняются", { skip: process.platform === "win32" && "Linux/macOS-only feature (POSIX paths, Unix socket, uid)" }, () => {
  assert.equal(workspaceOf("/srv/p", "отчёт"), "/srv/p/pipelines/отчёт");
  assert.throws(() => workspaceOf("p", "x"));
  assert.throws(() => workspaceOf("/srv/p", "../etc"));
});
test("папка запуска: дата и короткий ID", () => {
  assert.equal(runFolderName("6e0c2540-d88a-46b4-b2e5-370693a493d4", new Date(2026, 10, 18, 9, 5)), "20261118-0905-93a493d4");
  assert.ok(isPipelineFolder("/srv/p/pipelines/x")); assert.ok(!isPipelineFolder("/srv/p"));
});

import { projectCandidate } from "../lib/temporal/workspace.js";
test("BUG-253: в проекты admin не попадают папки тенантов, временные, системные, пайпов и несуществующие", () => {
  const opt = { tenantHome: "/home/u/.teleharness-tenants", problem: () => null, exists: (d) => d !== "/gone" };
  assert.equal(projectCandidate("/home/u", opt), true);
  assert.equal(projectCandidate("/srv/proj", opt), true);
  for (const d of ["/home/u/.teleharness-tenants/alice", "/home/u/AppData/Local/Temp/oc_test", "/tmp/x", "/srv/restore/C/Windows/System32", "/etc", "/srv/proj/pipelines/a", "/gone", "rel"])
    assert.equal(projectCandidate(d, opt), false, d);
});
